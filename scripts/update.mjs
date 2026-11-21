/* ============================================================
   GitHub Actions · 每周行情同步（v0.53）

   思路：不重写取数逻辑。用 actions/checkout 拿到的仓库文件在 Actions 本机
   起一个静态站点（127.0.0.1），无头浏览器打开它，点两套系统原有的
   「一键更新行情」，等「数据止」真正到达最近交易日，再读出补丁生成 state.json。
   不走公网：花生壳 / 部分主机按来源 IP 放行，云机房会被 403 挡在门外。

   v0.53 新增「本机覆盖层」：仓库根目录 local-overrides.json（修复点 + ETF 新增标的，
   由系统里「导出修复补丁」生成）每次运行都合并，放在生成 state.json 之后当最后一层
   覆盖；没有新行情的那一周也照样合并，不再搭「有新行情」那班车。内容没变化就不写
   state.json、不提交、不触发构建。旧 etf-extra.json 仍兼容；空模板 enabled=false 不动数据。

   v51 修掉三件真毛病：
   1) 旧判据是「补丁末日 > 更新前末日」。周六重跑时本机已被 state.json 补到
      最近交易日，永远等不到「更晚」，白白空等 20 分钟（CB/ETF 都中招）。
      改成「补丁末日 >= goal（最近交易日）」；已达标直接跳过，不算失败。
   2) 补丁可能只存在大仓库（IndexedDB）的内存镜像里，旧代码只认原生
      localStorage。现在同时读 WufuStore.get，并在写盘 flush 之后取值。
   3) 页面明确写完却没到目标日期时快速收尾并写清原因，不再干等超时。
      sync-status.json 额外记录 goal / CB 新上市标的数 / 回传名单数。

   三条硬规矩不变：
     · 没到达目标交易日就不写、不提交 —— 绝不假装成功
     · 新日期不比仓库里已有的晚，就保留旧值 —— 绝不倒退
     · 一侧失败，另一侧照常写，失败那侧原样保留，并在日志里说清楚
   ============================================================ */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state.json');
const STATUS = path.join(ROOT, 'sync-status.json');
const CHAIN_R_STATUS = path.join(ROOT, 'chain-R-status.json');
const EXTRA = path.join(ROOT, 'etf-extra.json');
const OVERRIDES = path.join(ROOT, 'local-overrides.json');
const FIX_ETF = ['corrections','ohlcFix','navFix','resupply','swaps','refactors','exempt','fyFix','fyCheck'];
const FIX_CB = ['corrections','ohlcFix','resupply','exempt','swaps','refactors'];
const EMPTY = { corrections: [], ohlcFix: {}, navFix: {}, resupply: {}, swaps: [],
                refactors: [], exempt: [], fyFix: {}, fyCheck: null };
const HOLIDAY = path.join(ROOT, 'common/holiday-cn.json');
const SITE = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_SITE = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 20 * 60 * 1000);

/* 只搬这两个键。它们各自内部已含 days / scale / st / ann / corrections / newSeries
   / custom 等全部增量；其它本机键（策略、组合、扶摇 Key 等）一律不进仓库。 */
const TARGETS = [
  { name: '可转债', url: '/cb/tool.html?view=health#/health', key: 'wufuCbQPatch_v1', button: 'qckUpdate' },
  { name: 'ETF', url: '/etf/tool.html?view=health#/health', key: 'wufuQPatch_v1', button: 'wufuUpdRun' }
];

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

/* v0.69 链 R 契约校验：不认 HTTP 200，只认数据本身。
   行数下限 / 关键字段非空 / 末日格式，任一不满足就保留旧值并明确标红。 */
function validatePatch(name, value) {
  let p;
  try { p = JSON.parse(value); } catch (e) { return { ok: false, why: '补丁不是合法 JSON' }; }
  const days = (p && Array.isArray(p.days)) ? p.days : [];
  if (!days.length) return { ok: false, why: 'days 为空' };
  const last = String((days[days.length - 1] || {}).date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return { ok: false, why: '末日格式异常：' + last };
  let valid = 0;
  for (const d of days.slice(-5)) {
    const s = (d && d.series) || {};
    for (const c of Object.keys(s)) {
      const row = s[c] || {};
      const v = (row.close != null ? row.close : row.raw_close);
      if (typeof v === 'number' && isFinite(v) && v > 0) valid++;
    }
  }
  const need = name === '可转债' ? 50 : 30;
  if (valid < need) return { ok: false, why: `近5日有效收盘 ${valid} 个 < 下限 ${need}`, rows: valid, last, days: days.length };
  return { ok: true, rows: valid, last, days: days.length };
}
/* v0.53 本地自测：只跑覆盖层合并，不启动浏览器、不写仓库文件 */
if (process.env.WUFU_OVERRIDE_SELFTEST === '1') {
  const mk = () => ({
    'wufuQPatch_v1': JSON.stringify({ v:7, days:[{date:'2026-11-13'}], custom:[{code:'OLD'}], corrections:[{c:'X',date:'2026-11-10'}] }),
    'wufuCbQPatch_v1': JSON.stringify({ v:1, days:[{date:'2026-11-13'}], corrections:[] })
  });
  const ov = normalizeOverrides({ format:'wufu-local-overrides-v1', enabled:true,
    fixes:{ etf:{ corrections:[{c:'A',date:'2026-11-11'}], ohlcFix:{B:1} }, cb:{ corrections:[{c:'C',date:'2026-11-12'}] } },
    etfExtra:{ format:'wufu-etf-extra-v1', count:1, items:[{code:'NEW',bars:[]}] } });
  const ls = mk(), r = mergeOverrides(ls, ov);
  const pe = JSON.parse(ls['wufuQPatch_v1']), pc = JSON.parse(ls['wufuCbQPatch_v1']);
  const ok1 = pe.corrections.length === 1 && pe.corrections[0].c === 'A' && pe.ohlcFix.B === 1
    && pe.custom.length === 1 && pe.custom[0].code === 'NEW' && pe.days[0].date === '2026-11-13'
    && pc.corrections[0].c === 'C' && r.fixPoints === 3 && r.custom === 1;
  const r2 = mergeOverrides(ls, ov);
  const ok2 = r2.fixPoints === r.fixPoints && ls['wufuQPatch_v1'] === JSON.stringify(pe);
  const empty = normalizeOverrides({ format:'wufu-local-overrides-v1', enabled:true, fixes:{etf:{},cb:{}}, etfExtra:{items:[]} });
  const ls2 = mk(); mergeOverrides(ls2, empty);
  const pe2 = JSON.parse(ls2['wufuQPatch_v1']);
  const ok3 = pe2.corrections.length === 0 && Object.keys(pe2.ohlcFix).length === 0
    && pe2.custom.length === 0 && pe2.days.length === 1;
  console.log(JSON.stringify({ ok: ok1 && ok2 && ok3, ok1, ok2, ok3, r, r2, daysKept: pe.days.length }));
  if (!(ok1 && ok2 && ok3)) process.exit(1);
  process.exit(0);
}
/* 本地自测：WUFU_SELFTEST=1 只算目标交易日与回传名单数，不启动浏览器 */
if (process.env.WUFU_SELFTEST === '1') {
  console.log(JSON.stringify({ goal: recentTradingDay(), extra: readExtra().length }));
  process.exit(0);
}
/* v0.53 自测：内容没变化不写文件、不触发构建 */
if (process.env.WUFU_NOCHANGE_SELFTEST === '1') {
  const tmp = path.join(ROOT, '.selftest-status.json');
  try { fs.unlinkSync(tmp); } catch (e) { }
  const obj = { goal: '2026-11-13', dataAsOf: '2026-11-13', targets: ['x'] };
  const w1 = writeIfChanged(tmp, obj);
  const w2 = writeIfChanged(tmp, obj);
  const a = { localStorage: { k: 'v' }, dataAsOf: '2026-11-13', note: 'n', origin: 'o' };
  const b = Object.assign({}, a, { exportedAt: 'changed' });
  const eq = stateCore(a) === stateCore(b);
  try { fs.unlinkSync(tmp); } catch (e) { }
  const ok = w1 === true && w2 === false && eq;
  console.log(JSON.stringify({ ok, firstWrite: w1, secondWrite: w2, coreIgnoresExportedAt: eq }));
  if (!ok) process.exit(1);
  process.exit(0);
}
if (!SITE) die('未设置 SITE_URL：workflow 里应指向 http://127.0.0.1:8787 的本地静态站点。');
if (!/^https?:\/\//.test(SITE)) die('SITE_URL 必须是完整 http(s) 地址，当前为：' + SITE);

/* 与 hub-core.js / export.js 同一口径：days 末日 与 scale.asof 取较大者 */
function lastDate(txt) {
  if (!txt) return '';
  try {
    const o = JSON.parse(txt), days = (o && o.days) || [];
    let last = '';
    if (Array.isArray(days)) {
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i] && days[i].date) { last = String(days[i].date).slice(0, 10); break; }
      }
    }
    if (o && o.scale && o.scale.asof) {
      const q = String(o.scale.asof).slice(0, 10);
      if (q > last) last = q;
    }
    return last;
  } catch (e) { return ''; }
}

/* goal = 北京时间「今天（含）往前」的最近一个交易日。
   周末不算；holiday-cn.json 里的区间整天跳过（A 股调休周末也不开市）。 */
function recentTradingDay() {
  const hol = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(HOLIDAY, 'utf8'));
    for (const arr of Object.values(j.Years || {})) {
      for (const h of arr || []) {
        let d = new Date(String(h.StartDate) + 'T00:00:00Z');
        const end = new Date(String(h.EndDate) + 'T00:00:00Z');
        while (d <= end) { hol.add(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
      }
    }
  } catch (e) { }
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  let d = new Date(bj.toISOString().slice(0, 10) + 'T00:00:00Z');
  for (let i = 0; i < 20; i++) {
    const s = d.toISOString().slice(0, 10), w = d.getUTCDay();
    if (w !== 0 && w !== 6 && !hol.has(s)) return s;
    d = new Date(d.getTime() - 86400000);
  }
  return bj.toISOString().slice(0, 10);
}

function readOld() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return (j && j.localStorage && typeof j.localStorage === 'object') ? j : null;
  } catch (e) { return null; }
}

function readExtra() {
  try {
    const j = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
    const items = Array.isArray(j) ? j : (j.items || []);
    return Array.isArray(items) ? items : [];
  } catch (e) { return []; }
}

/* 页面上下文里读补丁：shim 的 localStorage 优先，其次大仓库同步镜像 */
const READ_PATCH = k => {
  let v = null;
  try { v = window.localStorage.getItem(k); } catch (e) { }
  if (!v) { try { v = window.WufuStore && window.WufuStore.get(k); } catch (e) { } }
  return v;
};

async function waitReady(page, t) {
  await page.waitForFunction(() => {
    let d = null;
    try { if (window.WufuUI && window.WufuUI.getData) d = window.WufuUI.getData(); } catch (e) { }
    d = d || window.__WUFU_D || window.D || null;
    return !!(d && d.calendar && d.calendar.length && d.series);
  }, null, { timeout: 180000 });
  await page.waitForFunction(id => !!document.getElementById(id), t.button, { timeout: 60000 });
}

async function syncOne(ctx, t, goal) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errs = [], netFail = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e)));
  page.on('requestfailed', r => { if (netFail.length < 8) netFail.push(String(r.url()).slice(0, 90)); });
  try {
    console.log(`\n[${t.name}] 打开 ${SITE}${t.url}（目标交易日 ${goal}）`);
    await page.goto(SITE + t.url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await waitReady(page, t);

    const before = await page.evaluate(READ_PATCH, t.key);
    const d0 = lastDate(before);
    console.log(`[${t.name}] 更新前数据止：${d0 || '基线'}`);
    if (d0 && d0 >= goal) {
      console.log(`[${t.name}] 已到达目标交易日，跳过本次点击（不空等、不算失败）`);
      return { value: before, date: d0, skipped: true };
    }

    await page.evaluate(id => {
      const b = document.getElementById(id);
      if (!b) throw new Error('找不到一键更新按钮 ' + id);
      b.disabled = false; b.click();
    }, t.button);

    /* 唯一成功判据：补丁里真的到达最近交易日。
       页面明确收尾却没到达、或明确报错，立即收尾写原因，不干等 20 分钟。 */
    const handle = await page.waitForFunction(({ key, goal }) => {
      let v = null;
      try { v = window.localStorage.getItem(key); } catch (e) { }
      if (!v) { try { v = window.WufuStore && window.WufuStore.get(key); } catch (e) { } }
      let d = '';
      if (v) {
        try {
          const o = JSON.parse(v), a = o.days || [];
          for (let i = a.length - 1; i >= 0; i--) { if (a[i] && a[i].date) { d = String(a[i].date).slice(0, 10); break; } }
          if (o.scale && o.scale.asof) { const q = String(o.scale.asof).slice(0, 10); if (q > d) d = q; }
        } catch (e) { }
      }
      if (d && d >= goal) return { ok: true, date: d };
      const ids = ['qckMsg', 'wufuUpdMsg', 'wufuUpdState', 'qckUpdateLine'];
      let txt = '';
      ids.forEach(id => { const e = document.getElementById(id); if (e) txt += ' ' + (e.textContent || ''); });
      if (/存储写入失败|本机存储写入失败|网络异常|请求失败|更新失败/.test(txt))
        return { ok: false, reason: '页面报错：' + txt.trim().slice(0, 150) };
      if (/已存入本机|即时生效|更新完成|已即时生效/.test(txt) && !/正在|抓取|请求中|载入/.test(txt))
        return { ok: false, reason: '取数已结束但数据止仍为 ' + (d || '基线') + '，未到达 ' + goal };
      return false;
    }, { key: t.key, goal }, { timeout: STEP_TIMEOUT_MS, polling: 3000 });

    const r = await handle.jsonValue();
    if (!r.ok) throw new Error(r.reason);

    /* 等大仓库真正写完（v46：写盘是异步的，不 flush 可能读到半截） */
    await page.evaluate(async () => {
      try { if (window.WufuStore && window.WufuStore.flush) await window.WufuStore.flush(); } catch (e) { }
    });
    const after = await page.evaluate(READ_PATCH, t.key);
    const d1 = lastDate(after);
    if (!d1 || d1 < goal) throw new Error('补丁日期没有到达目标（' + (d0 || '基线') + ' → ' + d1 + '，目标 ' + goal + '）');
    console.log(`[${t.name}] ✓ 数据止 ${d0 || '基线'} → ${d1}`);
    return { value: after, date: d1, skipped: false };
  } finally {
    if (errs.length) console.log(`[${t.name}] 页面报错 ${errs.length} 条（不影响判定）：${errs.slice(0, 3).join(' | ')}`);
    if (netFail.length) console.log(`[${t.name}] 失败请求 ${netFail.length} 条：${netFail.join(' | ')}`);
    await page.close().catch(() => { });
  }
}

/* ---------- v0.53 · 本机覆盖层 ----------
   local-overrides.json（修复点 + ETF 新增标的全量名单）每次同步都作为最后一层覆盖。
   enabled=false 的空模板 → 返回 null，一个字节都不动本机。
   fixes.etf / fixes.cb 为 null 表示「不动修复」；字段齐全但全空表示「清空修复」（撤销）。
   旧 etf-extra.json 仍兼容：只在没有启用新文件时转成「只带名单」的覆盖层。 */
function emptyVal(f) {
  const v = EMPTY[f];
  return Array.isArray(v) ? [] : (v && typeof v === 'object' ? {} : null);
}
function normalizeOverrides(j) {
  const fx = (src, fields) => {
    if (!src || typeof src !== 'object') return null;
    const o = {};
    fields.forEach(f => { const v = src[f]; o[f] = (v === undefined || v === null) ? emptyVal(f) : v; });
    return o;
  };
  const items = (j.etfExtra && Array.isArray(j.etfExtra.items)) ? j.etfExtra.items : null;
  return {
    format: 'wufu-local-overrides-v1', enabled: true,
    fixes: { etf: fx(j.fixes && j.fixes.etf, FIX_ETF), cb: fx(j.fixes && j.fixes.cb, FIX_CB) },
    etfExtra: { format: 'wufu-etf-extra-v1', count: items ? items.length : 0, items: items },
    legacy: !!j.legacy
  };
}
function readOverrides() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')); } catch (e) { }
  if (j && j.format === 'wufu-local-overrides-v1' && j.enabled !== false) return normalizeOverrides(j);
  const items = readExtra();
  if (items.length) return normalizeOverrides({ format:'wufu-local-overrides-v1', enabled:true,
    fixes:{}, etfExtra:{ format:'wufu-etf-extra-v1', count:items.length, items }, legacy:true });
  return null;
}
function countFixOne(fix, fields) {
  let n = 0;
  fields.forEach(f => {
    const v = fix[f];
    if (Array.isArray(v)) n += v.length;
    else if (v && typeof v === 'object') n += Object.keys(v).length;
  });
  return n;
}
function countFixAll(ov) {
  return (ov.fixes && ov.fixes.etf ? countFixOne(ov.fixes.etf, FIX_ETF) : 0)
       + (ov.fixes && ov.fixes.cb ? countFixOne(ov.fixes.cb, FIX_CB) : 0);
}
/* 合并进补丁本身：state.json 自包含，离线包 / 旧版页面也能吃到修复与新增标的 */
function mergeOverrides(ls, ov) {
  let fixPoints = 0, custom = 0;
  const jobs = [
    ['wufuQPatch_v1', FIX_ETF, ov.fixes && ov.fixes.etf, ov.etfExtra && ov.etfExtra.items],
    ['wufuCbQPatch_v1', FIX_CB, ov.fixes && ov.fixes.cb, null]
  ];
  jobs.forEach(([k, fields, fix, items]) => {
    if (!fix && !items) return;
    if (typeof ls[k] !== 'string') { console.log(`· 覆盖层：仓库里暂无 ${k} 补丁，该侧跳过（下次同步自动带上）。`); return; }
    let p; try { p = JSON.parse(ls[k]); } catch (e) { return; }
    if (!p || typeof p !== 'object') return;
    if (fix) { fields.forEach(f => { const v = fix[f]; p[f] = (v !== undefined && v !== null) ? v : emptyVal(f); }); fixPoints += countFixOne(fix, fields); }
    if (items) { p.custom = items; custom = items.length; }
    ls[k] = JSON.stringify(p);
  });
  return { fixPoints, custom };
}
/* 内容比较：exportedAt 不参与，避免「没变化也换时间戳 → 每周白提交」 */
function stateCore(o) {
  return JSON.stringify([o.localStorage, o.overrides || null, o.dataAsOf, o.note, o.origin]);
}
function writeIfChanged(file, obj) {
  const txt = JSON.stringify(obj, null, 2) + '\n';
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { }
  if (cur === txt) return false;
  fs.writeFileSync(file, txt, 'utf8');
  return true;
}

function countNewSeries(raw) {
  try { const p = JSON.parse(raw || '{}'); return Object.keys(p.newSeries || {}).length; }
  catch (e) { return 0; }
}

(async () => {
  const goal = recentTradingDay();
  const ov = readOverrides();
  const ovFixN = ov ? countFixAll(ov) : 0;
  const ovExtraN = ov ? ((ov.etfExtra && ov.etfExtra.items) || []).length : 0;
  console.log(`本次目标交易日：${goal}；本机覆盖层：${ov ? (ovFixN + ' 个修复点 / ' + ovExtraN + ' 只新增标的') : '未启用（空模板）'}`);
  const CHROME_PATH = String(process.env.CHROME_PATH || '').trim();
  const browser = await chromium.launch(Object.assign(
    { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    CHROME_PATH ? { executablePath: CHROME_PATH } : {}
  ));
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block'
  });

  /* 只给上交所域名补 Referer —— 自检里 3944 行真数据就是靠它拿到的。 */
  await ctx.route('**/*', async route => {
    try {
      const u = new URL(route.request().url());
      if (/(^|\.)sse\.com\.cn$/i.test(u.hostname)) {
        const h = Object.assign({}, route.request().headers(), { referer: 'https://www.sse.com.cn/' });
        return await route.continue({ headers: h });
      }
    } catch (e) { }
    return route.continue();
  });

  const old = readOld();
  const oldLS = (old && old.localStorage) || {};
  const out = {}, notes = [];
  let changed = 0, cbNew = 0;
  const chainR = { results: {}, warnings: [] };

  try {
    for (const t of TARGETS) {
      const oldVal = typeof oldLS[t.key] === 'string' ? oldLS[t.key] : null;
      try {
        const r = await syncOne(ctx, t, goal);
        const vd = validatePatch(t.name, r.value);
        chainR.results[t.key] = Object.assign({ name: t.name, goal }, vd);
        if (!vd.ok && !r.skipped) {
          out[t.key] = oldVal;
          chainR.warnings.push(`${t.name}：链 R 校验未通过（${vd.why}），保留原值`);
          notes.push(`${t.name}：链 R 校验未通过（${vd.why}），保留原值`);
          continue;
        }
        const od = lastDate(oldVal), nd = lastDate(r.value);
        if (r.skipped) { out[t.key] = oldVal || r.value; notes.push(`${t.name}：已是 ${nd}，无需更新`); continue; }
        /* 新值不比仓库旧值新，就保留旧值：绝不倒退 */
        if (od && nd <= od) { out[t.key] = oldVal; notes.push(`${t.name}：取到 ${nd}，不比仓库 ${od} 新，保留原值`); }
        else { out[t.key] = r.value; changed++; notes.push(`${t.name}：更新到 ${nd}`); if (t.name === '可转债') cbNew = countNewSeries(r.value); }
      } catch (e) {
        out[t.key] = oldVal;
        notes.push(`${t.name}：本次未到达 ${goal}（${String(e && e.message || e).slice(0, 180)}），保留原值`);
      }
      if (out[t.key] == null) delete out[t.key];
    }
  } finally {
    await ctx.close().catch(() => { });
    await browser.close().catch(() => { });
  }

  const keys = Object.keys(out);
  const dataAsOf = keys.reduce((m, k) => { const d = lastDate(out[k]); return d > m ? d : m; }, '');
  const oldAsOf = keys.reduce((m, k) => { const d = lastDate(oldLS[k]); return d > m ? d : m; }, '');
  if (!changed) console.log('\n本次没有取到更晚行情：保留原值；覆盖层照样每次合并。');
  if (dataAsOf && oldAsOf && dataAsOf < oldAsOf) {
    die('合并后数据止 ' + dataAsOf + ' 早于仓库原有 ' + oldAsOf + '，拒绝写入（防倒退）。');
  }

  /* 以仓库旧状态为底，叠加本次取到的新补丁（没有新行情时就是原值） */
  const ls = Object.assign({}, oldLS);
  keys.forEach(k => { if (out[k] != null) ls[k] = out[k]; });
  const applied = ov ? mergeOverrides(ls, ov) : { fixPoints: 0, custom: 0 };
  if (ov) notes.push(`覆盖层每次合并：修复点 ${applied.fixPoints} 处 / ETF 新增标的 ${applied.custom} 只`);
  else notes.push('覆盖层未启用（空模板），不改动本机修复');

  const finalAsOf = keys.reduce((m, k) => { const d = lastDate(ls[k]); return d > m ? d : m; }, '') || (old && old.dataAsOf) || '';
  const state = {
    format: 'wufu-offline-state-v2',
    contract: { chain: 'R', formatVersion: 2, minClient: 'v0.87' },
    availableAt: new Date().toISOString(),
    warningClasses: [],
    degradeLevel: 'none',
    exportedAt: (old && old.exportedAt) || new Date().toISOString(),
    origin: PUBLIC_SITE || SITE,
    dataAsOf: finalAsOf,
    note: 'GitHub Actions 自动生成；页面打开时由 hub-core.js 自动补回本机并重放。' + notes.join('；'),
    localStorage: ls
  };
  if (ov) state.overrides = ov;

  /* 内容没变就不写、不提交、不触发构建（exportedAt 不参与比较） */
  if (old && stateCore(old) === stateCore(state)) {
    console.log('· state.json 内容未变化，沿用原文件（不提交、不触发构建）。');
  } else {
    state.exportedAt = new Date().toISOString();
    fs.writeFileSync(STATE, JSON.stringify(state) + '\n', 'utf8');
    console.log(`\n✓ 已写 state.json：数据止 ${finalAsOf || '基线'}，${keys.length} 个补丁键，${(fs.statSync(STATE).size / 1024).toFixed(1)} KB`);
  }
  const statusObj = { goal, dataAsOf: finalAsOf, targets: notes, cbNewSeries: cbNew,
    overrideFixPoints: applied.fixPoints, etfExtra: ovExtraN, site: SITE };
  const stChanged = writeIfChanged(STATUS, statusObj);
  const chainRObj = {
    chain: 'R', contract: 'wufu-patch-v1', dataAsOf: finalAsOf, goal,
    source: '浏览器代点「一键更新行情」→ 东财 push2his 主源(f51-f61) / 腾讯 newfqkline 失败兜底 / 新浪美股(待探针)',
    validatedAt: new Date().toISOString(),
    targets: chainR.results, warnings: chainR.warnings
  };
  writeIfChanged(CHAIN_R_STATUS, chainRObj);
  console.log(`  CB 新上市标的 newSeries：${cbNew} 只；覆盖层修复点：${applied.fixPoints}；新增标的：${applied.custom} 只；status 变更：${stChanged ? '是' : '否'}`);
  notes.forEach(n => console.log('  · ' + n));
})().catch(e => die(String(e && e.stack || e)));
