/* ============================================================
   GitHub Actions · 每周行情同步（v50）

   思路：不重写取数逻辑。用 actions/checkout 拿到的仓库文件在 Actions 本机
   起一个静态站点（127.0.0.1），无头浏览器打开它，点两套系统原有的
   「一键更新行情」，等新交易日真正写进本机，再读出补丁生成 state.json。
   不走公网：花生壳 / 部分主机按来源 IP 放行，云机房会被 403 挡在门外。

   每周一次为什么够：两套系统的 netUpdate 都是「从当前末日的下一天，
   一直抓到今天」，一次点击会把整周（甚至漏跑几周）的交易日一次补齐，
   不是只补最后一天。所以周五跑一次 = 本周 5 个交易日全在。

   这样做的好处：
     · 完全复用页面里已经验证过的取数 / 回放代码，不会造出格式不对的补丁
     · state.json 与「导出整站离线包」产出的格式完全一致，
       主站 v47 的随包状态自动生效逻辑直接能吃，主系统一行都不用改
     · 浏览器里能带 Referer（上交所那道墙），也能跑 JS / IndexedDB
     · 云端更新为主；数据体检中心的手动「一键更新」退为备用手段，
       两边数据合并时以「更晚的日期」为准，不会互相覆盖或倒退

   三条硬规矩：
     · 没取到「更晚的行情日期」就不写、不提交 —— 绝不假装成功
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
const SITE = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_SITE = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
/* 每周一次要拉 5 个交易日，请求量约是每日版的 5 倍，默认给到 20 分钟/侧。
   仓库变量 STEP_TIMEOUT_MS 可覆盖（毫秒）；workflow 的 job 上限同步放到 60 分钟。 */
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 20 * 60 * 1000);

/* 只搬这两个键。它们各自内部已含 days / scale / st / ann / corrections 等全部增量，
   一个键就够；其它本机键（策略、组合、扶摇 Key 等）一律不进仓库。 */
/* 一键更新按钮在「数据体检」视图里（index.html 是回测首页，没有这个按钮），
   路径与 health/index.html 里的 iframe src 保持一致。 */
const TARGETS = [
  { name: '可转债', url: '/cb/tool.html?view=health#/health',  key: 'wufuCbQPatch_v1' },
  { name: 'ETF',    url: '/etf/tool.html?view=health#/health', key: 'wufuQPatch_v1' }
];

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
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

function readOld() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return (j && j.localStorage && typeof j.localStorage === 'object') ? j : null;
  } catch (e) { return null; }
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    let d = null;
    try { if (window.WufuUI && window.WufuUI.getData) d = window.WufuUI.getData(); } catch (e) { }
    d = d || window.__WUFU_D || window.D || null;
    return !!(d && d.calendar && d.calendar.length && d.series);
  }, null, { timeout: 180000 });
  await page.waitForSelector('#wufuUpdRun', { state: 'attached', timeout: 60000 });
}

/* 打开一个系统页 → 点更新 → 等补丁里出现更晚的日期。失败抛错，由调用方记下并保留旧值。 */
async function syncOne(ctx, t) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e)));
  try {
    console.log(`\n[${t.name}] 打开 ${SITE}${t.url}`);
    await page.goto(SITE + t.url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await waitReady(page);

    const before = await page.evaluate(k => {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    }, t.key);
    const d0 = lastDate(before);
    console.log(`[${t.name}] 更新前数据止：${d0 || '基线'}`);

    await page.evaluate(() => {
      const b = document.getElementById('wufuUpdRun');
      if (!b) throw new Error('找不到一键更新按钮');
      b.click();
    });

    /* 唯一成功判据：补丁里真的出现了更晚的行情日期。
       提示文字、HTTP 200、进度条走完都不算数。 */
    await page.waitForFunction(({ key, from }) => {
      let v = null;
      try { v = window.localStorage.getItem(key); } catch (e) { return false; }
      if (!v) return false;
      try {
        const o = JSON.parse(v), a = o.days || [];
        for (let i = a.length - 1; i >= 0; i--) {
          if (a[i] && a[i].date) return String(a[i].date).slice(0, 10) > from;
        }
        if (o.scale && o.scale.asof) return String(o.scale.asof).slice(0, 10) > from;
      } catch (e) { }
      return false;
    }, { key: t.key, from: d0 }, { timeout: STEP_TIMEOUT_MS, polling: 3000 });

    /* 等大仓库真正写完（v46：写盘是异步的，不 flush 可能读到半截） */
    await page.evaluate(async () => {
      try { if (window.WufuStore && window.WufuStore.flush) await window.WufuStore.flush(); } catch (e) { }
    });
    const after = await page.evaluate(k => {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    }, t.key);
    const d1 = lastDate(after);
    if (!d1 || d1 <= d0) throw new Error('补丁日期没有推进（' + d0 + ' → ' + d1 + '）');
    console.log(`[${t.name}] ✓ 数据止 ${d0 || '基线'} → ${d1}`);
    return { value: after, date: d1 };
  } finally {
    if (errs.length) console.log(`[${t.name}] 页面报错 ${errs.length} 条（不影响判定）：${errs.slice(0, 3).join(' | ')}`);
    await page.close().catch(() => { });
  }
}

(async () => {
  /* Actions 里由 npx playwright install chromium 装好；本地验证可指定系统 Chrome */
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

  /* 只给上交所域名补 Referer —— 自检里 3944 行真数据就是靠它拿到的。
     其它源保持原样，避免全局 Referer 把东财/腾讯惹毛。 */
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
  let changed = 0;

  try {
    for (const t of TARGETS) {
      const oldVal = typeof oldLS[t.key] === 'string' ? oldLS[t.key] : null;
      try {
        const r = await syncOne(ctx, t);
        const od = lastDate(oldVal), nd = lastDate(r.value);
        /* 新值不比仓库旧值新，就保留旧值：绝不倒退 */
        if (od && nd <= od) { out[t.key] = oldVal; notes.push(`${t.name}：取到 ${nd}，不比仓库 ${od} 新，保留原值`); }
        else { out[t.key] = r.value; changed++; notes.push(`${t.name}：更新到 ${nd}`); }
      } catch (e) {
        out[t.key] = oldVal;   /* 可能原本就没有该键 */
        notes.push(`${t.name}：本次未取到更晚行情（${String(e && e.message || e).slice(0, 160)}），保留原值`);
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
    console.log('\n本次没有任何一侧取到更晚的行情，state.json 保持原样，不提交行情。');
    notes.forEach(n => console.log('  · ' + n));
    fs.writeFileSync(STATUS, JSON.stringify({ dataAsOf: '', targets: notes, site: SITE }, null, 2) + '\n', 'utf8');
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
  fs.writeFileSync(STATE, JSON.stringify(state) + '\n', 'utf8');
  fs.writeFileSync(STATUS, JSON.stringify({ dataAsOf, targets: notes, site: SITE }, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已写 state.json：数据止 ${dataAsOf || '基线'}，${keys.length} 个补丁键，${(fs.statSync(STATE).size / 1024).toFixed(1)} KB`);
  notes.forEach(n => console.log('  · ' + n));
})().catch(e => die(String(e && e.stack || e)));
