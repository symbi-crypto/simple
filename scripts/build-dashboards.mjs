/* build-dashboards.mjs — 周五同步后刷新两个综合看板快照
   1) cb-daily.json：把 state.json 里最新的可转债增量日追加成当日截面（六卡/分位/结构分布）
   2) index-daily.json 已移交 scripts/build-index-daily.py（基线 + 日更增量），本文件不再处理。
   原始 .gz 不进页面，只写算好的小 JSON。 */
import fs from 'node:fs';

const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/* 三条链统一落库契约：L=本地 gz / A=东财+申万 / G=Yahoo+CBOE。
   上游源不合并，合并的是快照契约（chain / contract / source / dataAsOf / warnings）。 */
const CHAIN_OF = { 'cb-daily.json': 'L', 'index-daily.json': 'L' };
/* v0.87 / P1：契约字段单一收口。旧链标识升级为对象；source/warnings/basis/sourceRole 补齐。
   业务数值一个不动，note / sampleNote / trendNote 一律保留。 */
const BASIS_CB = { unit: '元 / %', adjust: '不复权收盘价、转股价值与溢价率',
  universe: '沪深可转债全市场，含退市债', sample: '趋势按自然周取点',
  normalized: '趋势序列起点归一 = 100' };
const SOURCE_CB = '本地 cb/data/cb-data.gz + state.json 可转债日更增量（链 L，零抓取，含退市债）';
const stamp = (p, o) => {
  if (CHAIN_OF[p] && o && typeof o === 'object') {
    o.availableAt = new Date().toISOString();   // §2.5：从接入日起记录真实可得时刻
    const ch = o.chain || CHAIN_OF[p];
    o.chain = ch;
    o.contract = { chain: ch, formatVersion: 2, minClient: 'v0.87' };
    if (!o.source) o.source = SOURCE_CB;
    if (!Array.isArray(o.warnings)) o.warnings = [];
    if (!o.basis) o.basis = BASIS_CB;
    if (!o.sourceRole) o.sourceRole = 'primary';
  }
  return o;
};
/* §4.2 枚举分类：与 build-external.py 的 classify_warning 同规则 */
const ENUM_KEYS = {
  source_unpublished: ['未发布','源方未','no data','无 FRED','暂无该字段'],
  session_incomplete: ['未收盘','未完成','盘中','未定稿'],
  cross_source_divergent: ['divergent','价差','口径偏差','冲突','重叠校验'],
  stale_fallback: ['沿用','离线副本','兜底','较旧真值','自动兜底'],
  known_gap: ['缺口','缺 ','missingDates','未编造','留空','无免费'],
  fetch_failed: ['失败','RemoteDisconnected','超时','0 根','不足','拿不到','不可用','HTTP','script error','限流','空壳'],
};
const classifyW = w => {
  const s = String(w || '');
  for (const [e, ks] of Object.entries(ENUM_KEYS)) if (ks.some(k => s.includes(k))) return e;
  return 'unclassified';
};
const save = (p, o) => {
  if (o && typeof o === 'object' && CHAIN_OF[p]) {
    if (!Array.isArray(o.warnings)) o.warnings = [];
    o.warningClasses = o.warnings.map(classifyW);
    o.degradeLevel = o.warnings.length ? 'partial' : 'none';
  }
  fs.writeFileSync(p, JSON.stringify(stamp(p, o)));
};
const med = a => { a = a.filter(x => typeof x === 'number' && isFinite(x)); if (!a.length) return null; a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const avg = a => { a = a.filter(x => typeof x === 'number' && isFinite(x)); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
const pct = (s, v) => { s = s.filter(x => typeof x === 'number' && isFinite(x)); return v == null || !s.length ? null : Math.round(100 * s.filter(x => x <= v).length / s.length); };
const dash = v => v == null ? '—' : String(v);

/* ---------- 可转债：追加最新交易日（无新交易日也重算六卡，补齐指标） ---------- */
const state = read('state.json');
const cb = read('cb-daily.json');
if (state && cb) {
  const ls = state.localStorage || {};
  const patch = JSON.parse(ls.wufuCbQPatch_v1 || '{}');
  const days = patch.days || [];
  const lastDay = days[days.length - 1];
  const asof = state.dataAsOf || cb.dataAsOf;
  if (lastDay) {
    const ss = lastDay.series || {}, prev = (days.length > 1 ? days[days.length - 2].series : {}) || {};
    const cl = [], pr = [], nv = [], am = [], ch = [], dbl = [], navPrem = [];
    let below = 0, d130 = 0;
    for (const [c, v] of Object.entries(ss)) {
      const x = v && v.close; if (!(typeof x === 'number') || x <= 0) continue;
      cl.push(x); if (x < 100) below++;
      if (typeof v.premium === 'number') { pr.push(v.premium); dbl.push(x + v.premium); }
      if (typeof v.nav === 'number') nv.push(v.nav);
      if (typeof v.amount === 'number') am.push(v.amount);
      if (typeof v.nav === 'number' && typeof v.premium === 'number') navPrem.push([v.nav, v.premium]);
      const pv = prev[c] && prev[c].close;
      if (typeof pv === 'number' && pv > 0) ch.push((x / pv - 1) * 100);
    }
    dbl.forEach(x => { if (x < 130) d130++; });
    const mp = med(cl), mpr = med(pr), sum = am.reduce((a, b) => a + b, 0);
    const top10 = am.slice().sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0);
    const topRatio = sum ? (100 * top10 / sum).toFixed(1) + '%' : '—';
    const bandAvg = (lo, hi) => { const q = navPrem.filter(p => p[0] >= lo && p[0] < hi).map(p => p[1]); return q.length ? +(q.reduce((a, b) => a + b, 0) / q.length).toFixed(1) : null; };
    const p100 = bandAvg(95, 105), p110 = bandAvg(105, 115);
    const fresh = !!(asof && asof > cb.dataAsOf);
    if (fresh) cb.dataAsOf = asof;
    cb.count = cl.length;
    cb.summary = { medianPrice: mp == null ? null : +mp.toFixed(1), medianPremium: mpr == null ? null : +mpr.toFixed(1),
                   up: ch.filter(x => x > 0).length, down: ch.filter(x => x < 0).length };
    cb.kpi = [
      { label: '涨跌幅均值', value: avg(ch) == null ? '—' : (avg(ch) >= 0 ? '+' : '') + avg(ch).toFixed(2) + '%', sub: '涨 ' + cb.summary.up + ' / 跌 ' + cb.summary.down },
      { label: '价格中位 / 均价', value: dash(mp && mp.toFixed(1)) + ' / ' + dash(avg(cl) && avg(cl).toFixed(1)), sub: '元 · 全市场 ' + cl.length + ' 只' },
      { label: '溢价率中位 / 均值', value: dash(mpr && mpr.toFixed(1)) + '% / ' + dash(avg(pr) && avg(pr).toFixed(1)) + '%', sub: '转股溢价率' },
      { label: '转股价值中位 / 均值', value: dash(med(nv) && med(nv).toFixed(1)) + ' / ' + dash(avg(nv) && avg(nv).toFixed(1)), sub: '元' },
      { label: '总成交额', value: sum ? (sum / 10000).toFixed(0) + ' 亿' : '—', sub: '前十占比 ' + topRatio },
      { label: '百元 / 110元溢价率', value: (p100 == null ? '—' : p100 + '%') + ' / ' + (p110 == null ? '—' : p110 + '%'), sub: '平价 95–105 / 105–115 溢价率均值 · 自定义口径' }
    ];
    cb.extra = { '破面<100元': below, '双低<130': d130 };
    cb.note = '历史曲线由内嵌全历史逐日截面计算，未引外部数据源；含退市债。';
    save('cb-daily.json', cb);
    console.log('cb-daily.json ->', cb.dataAsOf, cl.length, '只', fresh ? '(新交易日)' : '(仅补齐六卡指标)');
  } else console.log('无可用增量日，cb-daily.json 保持原值');
}

/* ---------- 指数：从本地 index.gz 真算，不做任何外部抓取 ---------- */
import zlib from 'node:zlib';

/* ---------- 可转债全历史趋势：按自然周取点（含 state 增量日） ---------- */
const CBD = 'cb/data/cb-data.gz', CBV = 'cb/data/cb-vol.gz';
if (fs.existsSync(CBD) && fs.existsSync(CBV) && cb) {
  const cd = JSON.parse(zlib.gunzipSync(fs.readFileSync(CBD)).toString('utf8'));
  const vd = JSON.parse(zlib.gunzipSync(fs.readFileSync(CBV)).toString('utf8'));
  const calC = cd.calendar || [], S = cd.series || {}, V = vd.series || {}, EQ = (cd.index || {}).index_CBALL || [];
  const codes = Object.keys(S), rows = [];
  for (let i = 0; i < calC.length; i++) {
    const cl = [], pr = []; let am = 0;
    for (const c of codes) {
      const v = (S[c].close || [])[i];
      if (typeof v !== 'number' || !(v > 0)) continue;
      cl.push(v);
      const p = (S[c].premium || [])[i]; if (typeof p === 'number' && isFinite(p)) pr.push(p);
      const a = ((V[c] || {}).amount || [])[i]; if (typeof a === 'number' && isFinite(a)) am += a;
    }
    rows.push({ date: calC[i], eq: (typeof EQ[i] === 'number' ? EQ[i] : null),
                price: med(cl), prem: med(pr), amount: am || null });
  }
  /* 增量交易日：state.json 的 wufuCbQPatch_v1 */
  const patchM = JSON.parse(((state && state.localStorage) || {}).wufuCbQPatch_v1 || '{}');
  const pdays = patchM.days || [];
  let prevEq = rows.length ? (rows[rows.length - 1].eq || 1000) : 1000;
  const basePrev = {};
  const bi = calC.length - 1;
  for (const c of codes) { const v = (S[c].close || [])[bi]; if (typeof v === 'number' && v > 0) basePrev[c] = v; }
  pdays.forEach((day, di) => {
    const ss = day.series || {}, pm = di > 0 ? (pdays[di - 1].series || {}) : basePrev;
    const cl = [], pr = [], ch = []; let am = 0;
    for (const [c, v] of Object.entries(ss)) {
      if (!v || typeof v.close !== 'number' || !(v.close > 0)) continue;
      cl.push(v.close);
      if (typeof v.premium === 'number' && isFinite(v.premium)) pr.push(v.premium);
      if (typeof v.amount === 'number' && isFinite(v.amount)) am += v.amount;
      const pv0 = pm[c], pv = (pv0 && typeof pv0 === 'object') ? pv0.close : pv0;
      if (typeof pv === 'number' && pv > 0) ch.push((v.close / pv - 1) * 100);
    }
    const r = avg(ch); prevEq = prevEq * (1 + (r || 0) / 100);
    rows.push({ date: day.date, eq: +prevEq.toFixed(2), price: med(cl), prem: med(pr), amount: am || null });
  });
  const wk = d => { const t = Date.parse(d + 'T00:00:00Z'); const day = new Date(t).getUTCDay() || 7; return new Date(t - (day - 1) * 86400000).toISOString().slice(0, 10); };
  const weeklyCb = []; let lastW = null;
  rows.forEach(x => { const w = wk(x.date); if (w !== lastW) { weeklyCb.push(x); lastW = w; } else weeklyCb[weeklyCb.length - 1] = x; });
  const tail = weeklyCb.length ? Date.parse(weeklyCb[weeklyCb.length - 1].date + 'T00:00:00Z') : 0;
  cb.trend = cb.trend || {};
  for (const y of [5, 10]) {
    const w = weeklyCb.filter(x => Date.parse(x.date + 'T00:00:00Z') >= tail - 365.25 * y * 86400000);
    const o = { labels: w.map(x => x.date), sample: +(w.length / 52).toFixed(1), points: w.length };
    for (const k of ['eq', 'price', 'prem', 'amount']) {
      const vals = w.map(x => x[k]).filter(v => typeof v === 'number' && isFinite(v) && v > 0);
      const b = vals[0] || null;
      o[k] = b ? w.map(x => (typeof x[k] === 'number' && x[k] > 0) ? +(100 * x[k] / b).toFixed(2) : null) : [];
    }
    cb.trend[String(y)] = o;
  }
  cb.trendNote = '曲线按自然周取点（每周最后一个交易日），含退市债；由内嵌全历史逐日截面真算，未引外部数据源。';
  save('cb-daily.json', cb);
  console.log('cb-daily.json 趋势已改周频', cb.trend['5'].points, '/', cb.trend['10'].points, '点');
}


/* v0.84 / 方案 B：指数看板改由 scripts/build-index-daily.py 生成
   （基线 index.gz + state.json 日更增量，缺口如实标注）。
   本文件只负责可转债快照，不再写 index-daily.json，避免双写覆盖。 */
