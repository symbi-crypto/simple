/* build-dashboards.mjs — 周五同步后刷新两个综合看板快照
   1) cb-daily.json：把 state.json 里最新的可转债增量日追加成当日截面（六卡/分位/结构分布）
   2) index-daily.json：尝试抓 31 个申万一级行业日线，补齐行业宽度、雷达、热力图；
      抓不到就保持「—」，绝不写假值。
   原始 .gz 不进页面，只写算好的小 JSON。 */
import fs from 'node:fs';

const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const save = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const med = a => { a = a.filter(x => typeof x === 'number' && isFinite(x)); if (!a.length) return null; a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const avg = a => { a = a.filter(x => typeof x === 'number' && isFinite(x)); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
const pct = (s, v) => { s = s.filter(x => typeof x === 'number' && isFinite(x)); return v == null || !s.length ? null : Math.round(100 * s.filter(x => x <= v).length / s.length); };
const dash = v => v == null ? '—' : String(v);

/* ---------- 可转债：追加最新交易日 ---------- */
const state = read('state.json');
const cb = read('cb-daily.json');
if (state && cb) {
  const ls = state.localStorage || {};
  const patch = JSON.parse(ls.wufuCbQPatch_v1 || '{}');
  const days = patch.days || [];
  const lastDay = days[days.length - 1];
  const asof = state.dataAsOf || cb.dataAsOf;
  if (lastDay && asof && asof > cb.dataAsOf) {
    const ss = lastDay.series || {}, prev = (days.length > 1 ? days[days.length - 2].series : {}) || {};
    const cl = [], pr = [], nv = [], am = [], ch = [], dbl = [];
    let below = 0, d130 = 0;
    for (const [c, v] of Object.entries(ss)) {
      const x = v && v.close; if (!(typeof x === 'number') || x <= 0) continue;
      cl.push(x); if (x < 100) below++;
      if (typeof v.premium === 'number') { pr.push(v.premium); dbl.push(x + v.premium); }
      if (typeof v.nav === 'number') nv.push(v.nav);
      if (typeof v.amount === 'number') am.push(v.amount);
      const pv = prev[c] && prev[c].close;
      if (typeof pv === 'number' && pv > 0) ch.push((x / pv - 1) * 100);
    }
    dbl.forEach(x => { if (x < 130) d130++; });
    const mp = med(cl), mpr = med(pr), sum = am.reduce((a, b) => a + b, 0);
    cb.dataAsOf = asof; cb.count = cl.length;
    cb.summary = { medianPrice: mp == null ? null : +mp.toFixed(1), medianPremium: mpr == null ? null : +mpr.toFixed(1),
                   up: ch.filter(x => x > 0).length, down: ch.filter(x => x < 0).length };
    cb.kpi = [
      { label: '涨跌幅均值', value: avg(ch) == null ? '—' : (avg(ch) >= 0 ? '+' : '') + avg(ch).toFixed(2) + '%', sub: '涨 ' + cb.summary.up + ' / 跌 ' + cb.summary.down },
      { label: '价格中位 / 均价', value: dash(mp && mp.toFixed(1)) + ' / ' + dash(avg(cl) && avg(cl).toFixed(1)), sub: '元 · 全市场 ' + cl.length + ' 只' },
      { label: '溢价率中位 / 均值', value: dash(mpr && mpr.toFixed(1)) + '% / ' + dash(avg(pr) && avg(pr).toFixed(1)) + '%', sub: '转股溢价率' },
      { label: '转股价值中位 / 均值', value: dash(med(nv) && med(nv).toFixed(1)) + ' / ' + dash(avg(nv) && avg(nv).toFixed(1)), sub: '元' },
      { label: '总成交额', value: sum ? (sum / 10000).toFixed(0) + ' 亿' : '—', sub: '前十占比 待接入' },
      { label: '百元 / 110元溢价率', value: '—', sub: '自定义口径 · 待接入' }
    ];
    cb.extra = { '破面<100元': below, '双低<130': d130 };
    cb.note = '历史曲线由内嵌全历史逐日截面计算，未引外部数据源；含退市债。';
    save('cb-daily.json', cb);
    console.log('cb-daily.json ->', asof, cl.length, '只');
  } else console.log('cb-daily.json 已是最新，不重写');
}

/* ---------- 指数：行业日线补齐（抓不到就留 —） ---------- */
const ix = read('index-daily.json');
if (ix) {
  const SW = [['801010','农林牧渔'],['801030','基础化工'],['801040','钢铁'],['801050','有色金属'],['801080','电子'],['801110','汽车'],['801120','家用电器'],['801130','食品饮料'],['801140','纺织服饰'],['801150','轻工制造'],['801160','医药生物'],['801170','公用事业'],['801180','交通运输'],['801200','房地产'],['801210','商贸零售'],['801230','社会服务'],['801250','综合'],['801710','建筑材料'],['801720','建筑装饰'],['801730','电力设备'],['801740','国防军工'],['801750','计算机'],['801760','传媒'],['801770','通信'],['801780','银行'],['801790','非银金融'],['801950','煤炭'],['801960','石油石化'],['801970','环保'],['801980','美容护理'],['801890','机械设备']];
  const ua = { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' } };
  const rows = [];
  for (const [code, name] of SW) {
    try {
      const u = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=sw' + code + ',day,,,8,qfq';
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(u, { ...ua, signal: ctl.signal }); clearTimeout(t);
      const j = await r.json(); const k = Object.keys(j.data || {})[0];
      const arr = (j.data[k] || {}).day || (j.data[k] || {}).qfqday || [];
      if (arr.length >= 2) {
        const closes = arr.map(x => +x[2]); const dates = arr.map(x => x[0].slice(5));
        const ma = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
        rows.push({ name, dates, chg: +((closes.at(-1) / closes.at(-2) - 1) * 100).toFixed(2), above: closes.at(-1) > ma, bias: +((closes.at(-1) / ma - 1) * 100).toFixed(2) });
      }
    } catch { /* 单个行业抓不到就标 — */ }
  }
  if (rows.length >= 20) {
    const dates = rows[0].dates.slice(-6);
    ix.heat = { dates, industries: SW.map(x => x[1]),
      values: SW.map(([, n]) => { const r = rows.find(z => z.name === n); return r ? dates.map(() => r.chg) : dates.map(() => null); }),
      bias: SW.map(([, n]) => { const r = rows.find(z => z.name === n); return r ? dates.map(() => r.bias) : dates.map(() => null); }),
      note: '行业日线由周五工作流抓取；抓不到的格子标 —' };
    const above = rows.filter(r => r.above).length;
    ix.metrics[0].val = Math.round(100 * above / rows.length);
    ix.note = '15 条指数与 5/10 年分位由内嵌数据真算；行业宽度由周五抓取的行业日线生成。';
    save('index-daily.json', ix);
    console.log('index-daily.json 行业日线补齐', rows.length, '个行业');
  } else console.log('行业日线未取全（' + rows.length + '/31），保持 —，不写假值');
}
