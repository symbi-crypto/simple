/* ============================================================
   GitHub Actions · 每周行情同步（v51）

   思路：不重写取数逻辑。用 actions/checkout 拿到的仓库文件在 Actions 本机
   起一个静态站点（127.0.0.1），无头浏览器打开它，点两套系统原有的
   「一键更新行情」，等「数据止」真正到达最近交易日，再读出补丁生成 state.json。
   不走公网：花生壳 / 部分主机按来源 IP 放行，云机房会被 403 挡在门外。

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
const EXTRA = path.join(ROOT, 'etf-extra.json');
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
/* 本地自测：WUFU_SELFTEST=1 只算目标交易日与回传名单数，不启动浏览器 */
if (process.env.WUFU_SELFTEST === '1') {
  const saved = fs.existsSync(EXTRA) ? fs.readFileSync(EXTRA, 'utf8') : null;
  fs.writeFileSync(EXTRA, JSON.stringify({ format: 'wufu-etf-extra-v1', items: [{ code: 'TEST.SZ', name: '自测', bars: [] }] }));
  const st = { localStorage: { wufuQPatch_v1: JSON.stringify({ days: [], custom: [] }) } };
  const m = mergeExtra(st);
  const custom = JSON.parse(st.localStorage.wufuQPatch_v1).custom;
  console.log(JSON.stringify({ goal: recentTradingDay(), extra: 1, merged: m, custom: custom.length }));
  if (saved != null) fs.writeFileSync(EXTRA, saved); else fs.unlinkSync(EXTRA);
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

/* 把「导出新增标的名单」回传的 etf-extra.json 合并进 state.json 的 ETF 补丁。
   custom 里含完整 bars/rawBars，页面补回本机后全站立刻能看到新标的，
   之后每周增量继续给它补日期。只在补丁已存在时合并，绝不凭空造一个空补丁。 */
function mergeExtra(state) {
  const items = readExtra();
  if (!items.length) return 0;
  const key = 'wufuQPatch_v1';
  if (typeof state.localStorage[key] !== 'string') {
    console.log('· 收到回传名单，但本次没有 ETF 补丁，暂不合并（下次同步自动带上）。');
    return 0;
  }
  let p;
  try { p = JSON.parse(state.localStorage[key]); } catch (e) { return 0; }
  const cur = Array.isArray(p.custom) ? p.custom.slice() : [];
  const have = new Set(cur.map(x => x && x.code).filter(Boolean));
  let n = 0;
  items.forEach(it => {
    const c = typeof it === 'string' ? it : (it && it.code);
    if (c && !have.has(c)) { cur.push(typeof it === 'string' ? { code: c } : it); have.add(c); n++; }
  });
  if (!n) return 0;
  p.custom = cur;
  state.localStorage[key] = JSON.stringify(p);
  return n;
}

function countNewSeries(raw) {
  try { const p = JSON.parse(raw || '{}'); return Object.keys(p.newSeries || {}).length; }
  catch (e) { return 0; }
}

(async () => {
  const goal = recentTradingDay();
  const extraCount = readExtra().length;
  console.log(`本次目标交易日：${goal}；回传名单：${extraCount} 项`);
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

  try {
    for (const t of TARGETS) {
      const oldVal = typeof oldLS[t.key] === 'string' ? oldLS[t.key] : null;
      try {
        const r = await syncOne(ctx, t, goal);
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

  if (!changed) {
    /* 没有新行情，也可能刚回传了新增标的名单：照样合并，
       否则名单要等到下一个有行情的周五才生效。 */
    const baseState = old || {
      format: 'wufu-offline-state-v2', exportedAt: new Date().toISOString(),
      origin: PUBLIC_SITE || SITE, dataAsOf: '', note: '', localStorage: {}
    };
    const st = Object.assign({}, baseState, { localStorage: Object.assign({}, baseState.localStorage, out) });
    const m = mergeExtra(st);
    if (m) {
      st.note = 'GitHub Actions 自动生成；页面打开时由 hub-core.js 自动补回本机并重放。' + notes.join('；') + `；ETF 回传名单合并 ${m} 只新标的`;
      fs.writeFileSync(STATE, JSON.stringify(st) + '\n', 'utf8');
      fs.writeFileSync(STATUS, JSON.stringify({ goal, dataAsOf: st.dataAsOf || '', targets: notes, cbNewSeries: cbNew, etfExtraMerged: m, etfExtra: extraCount, site: SITE }, null, 2) + '\n', 'utf8');
      console.log(`\n✓ 无新行情，但合并了 ${m} 只回传新标的，state.json 已更新。`);
      notes.forEach(n => console.log('  · ' + n));
      return;
    }
    console.log('\n本次没有任何一侧取到更晚的行情，state.json 保持原样，不提交行情。');
    notes.forEach(n => console.log('  · ' + n));
    fs.writeFileSync(STATUS, JSON.stringify({ goal, dataAsOf: '', targets: notes, cbNewSeries: cbNew, etfExtra: extraCount, site: SITE }, null, 2) + '\n', 'utf8');
    return;
  }
  if (dataAsOf && oldAsOf && dataAsOf < oldAsOf) {
    die('合并后数据止 ' + dataAsOf + ' 早于仓库原有 ' + oldAsOf + '，拒绝写入（防倒退）。');
  }

  const state = {
    format: 'wufu-offline-state-v2',
    exportedAt: new Date().toISOString(),
    origin: PUBLIC_SITE || SITE,
    dataAsOf,
    note: 'GitHub Actions 自动生成；页面打开时由 hub-core.js 自动补回本机并重放。' + notes.join('；'),
    localStorage: out
  };
  const merged = mergeExtra(state);
  if (merged) notes.push(`ETF 回传名单合并 ${merged} 只新标的`);
  state.note = 'GitHub Actions 自动生成；页面打开时由 hub-core.js 自动补回本机并重放。' + notes.join('；');
  fs.writeFileSync(STATE, JSON.stringify(state) + '\n', 'utf8');
  fs.writeFileSync(STATUS, JSON.stringify({ goal, dataAsOf, targets: notes, cbNewSeries: cbNew, etfExtraMerged: merged, etfExtra: extraCount, site: SITE }, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已写 state.json：数据止 ${dataAsOf || '基线'}，${keys.length} 个补丁键，${(fs.statSync(STATE).size / 1024).toFixed(1)} KB`);
  console.log(`  CB 新上市标的 newSeries：${cbNew} 只；回传名单合并：${merged} 只`);
  notes.forEach(n => console.log('  · ' + n));
})().catch(e => die(String(e && e.stack || e)));
