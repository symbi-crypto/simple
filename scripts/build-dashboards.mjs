/* build-dashboards.mjs — 周五同步后刷新两个综合看板快照
   1) cb-daily.json：把 state.json 里最新的可转债增量日追加成当日截面（六卡/分位/结构分布）
   2) index-daily.json：由内嵌 index.gz 的真实日线重算 15 条指数分位与双线，不引外部数据源。
   原始 .gz 不进页面，只写算好的小 JSON。 */
import fs from 'node:fs';

const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const save = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
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
const IXP = 'common/index.gz';
if (fs.existsSync(IXP)) {
  const gd = JSON.parse(zlib.gunzipSync(fs.readFileSync(IXP)).toString('utf8'));
  const cal = gd.calendar || [], idxm = gd.index || {};
  const GROUPS = {
    A: [['000001.SH','上证指数'],['000300.SH','沪深300'],['000510.SH','中证A500'],['000906.SH','中证800'],['000905.SH','中证500'],['399006.SZ','创业板指'],['000680.SH','科创综指'],['000852.SH','中证1000'],['399303.SZ','国证2000']],
    H: [['HSI.HI','恒生指数'],['HSTECH.HI','恒生科技'],['930915.CSI','港股通高股息']],
    U: [['SPX.GI','标普500'],['NDX.GI','纳斯达克100'],['DJI.GI','道琼斯工业']]
  };
  const gp = c => { const a = idxm[c] || []; const o = []; for (let i=0;i<a.length;i++) if (typeof a[i]==='number' && a[i]>0) o.push([i,a[i]]); return o; };
  const pctl = (g, years) => { if (!g.length) return null; const i=g[g.length-1][0], v=g[g.length-1][1]; const cut=new Date(Date.parse(cal[i])-365*years*86400000); const w=g.filter(([j])=>Date.parse(cal[j])>=cut.getTime()).map(x=>x[1]); return w.length?Math.round(100*w.filter(x=>x<=v).length/w.length):null; };
  const line = (c, years, n) => { const g=gp(c); if(g.length<2) return [[],[]]; const end=g[g.length-1][0]; const cut=Date.parse(cal[end])-365*years*86400000; const w=g.filter(([j])=>Date.parse(cal[j])>=cut); if(w.length<2) return [[],[]]; const step=(w.length-1)/(n-1), pick=[]; for(let k=0;k<n;k++) pick.push(w[Math.min(w.length-1,Math.round(k*step))]); const b=pick[0][1]; return [pick.map(x=>+(100*x[1]/b).toFixed(2)), pick.map(x=>cal[x[0]].slice(0,7))]; };
  const out = { format:'wufu-dash-idx-v2', dataAsOf: cal[cal.length-1] || null,
    sampleNote:'指数基线 '+(cal[0]||'—')+' 起，共 '+cal.length+' 交易日；分位与曲线由本地真实日线计算',
    idx:{}, idxTrend:{}, trendNote:{}, note:'15 条指数与 5/10 年分位、沪深300/国证2000 双线均由内嵌真实日线计算；不含外部抓取与占位值。' };
  for (const [g,lst] of Object.entries(GROUPS)) {
    out.idx[g] = lst.map(([c,n])=>{ const q=gp(c); if(q.length<2) return [n,null,null,null]; const v=q[q.length-1][1], p=q[q.length-2][1]; return [n,+((v/p-1)*100).toFixed(2),pctl(q,5),pctl(q,10)]; });
  }
  for (const [y,n] of [[5,61],[10,121]]) { const [hs,labels]=line('000300.SH',y,n); const [gz]=line('399303.SZ',y,n); out.idxTrend[String(y)]={labels,hs300:hs,gz2000:gz}; }
  const gzg = gp('399303.SZ');
  const gnote = gzg.length ? '国证2000 样本 '+gzg.length+' 交易日（约 '+(gzg.length/250).toFixed(1)+' 年），末有效日 '+cal[gzg[gzg.length-1][0]] : '国证2000 无有效序列';
  out.trendNote['5']='样本 5 年 · '+gnote; out.trendNote['10']='样本 10 年（沪深300）· '+gnote;
  save('index-daily.json', out);
  console.log('index-daily.json 已由本地真实日线重算');
} else console.log('未找到 common/index.gz，index-daily.json 保持原值');
