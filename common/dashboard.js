/* dashboard.js — 综合看板渲染器（v0.59 / v0.83 取数改造 / v0.84 指数日更）
   v0.83：取数统一走 common/dash-source.js（远端优先 + 包内副本兜底）。
   v0.84：index-daily.json 由基线 + 日更增量生成，标签统一「最新交易日」；
   指数曲线与成交额柱截止日不一致时不叠柱并明确说明，同步对齐后自动恢复。
   缺数一律显示「—」，不写示意值。 */
(function () {
  'use strict';
  var wrap = document.getElementById('dashWrap');
  if (!wrap) return;
  var kind = wrap.getAttribute('data-kind') || 'cb';
  var url = wrap.getAttribute('data-json') || '../cb-daily.json';
  /* dash-source.js 未加载时退化为原来的同源 fetch，看板不会整块变白 */
  var loadJSON = (window.WufuDash && WufuDash.load) ? WufuDash.load
    : function (u, ok, ko) {
        fetch(u, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(ok).catch(ko);
      };
  var badgeOf = (window.WufuDash && WufuDash.badge) ? WufuDash.badge : function () { return ''; };
  var D = null, years = 5, distKey = '价格';
  var selCB = [0, 1], selIDX = [0, 1], AMT = null, rngCB = null, rngIDX = null, quickCB = null, quickIDX = null;
  function SL(a, sel) { return window.WufuRange ? WufuRange.slice(a, sel) : a; }
  var NS = 'http://www.w3.org/2000/svg';
  function $(id) { return document.getElementById(id); }
  function T(v) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '—' : String(v); }
  function E(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function TX(x, y, s, size, color, anchor) {
    var t = E('text', { x: x, y: y, 'font-size': size, fill: color || WufuTheme.sub('§WFT0002§'), 'font-family': 'sans-serif' });
    if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t;
  }
  function CLR(id) { var e = $(id); if (e) e.innerHTML = ''; return e; }
  function sign(v) { return (typeof v === 'number' && v > 0) ? '+' + v : T(v); }
  function cls(v) { return (typeof v === 'number' && v > 0) ? 'u' : 'd'; }
  function grid(svg, vals, yfn, x0, x1) {
    var g = E('g', { stroke: WufuTheme.sub('§WFT0048§'), 'stroke-width': '1' });
    vals.forEach(function (v) { g.appendChild(E('line', { x1: x0, y1: yfn(v), x2: x1, y2: yfn(v) })); });
    svg.appendChild(g);
  }
  /* 多条序列共用画布：每条自身归一，只比形状。
     v0.69c：Y 轴按可见数据自适应（分位 1%~99% 且强制含 100），不再固定 40~260 后 clamp。
     旧写法在中位溢价率涨到 225+ 或 10 年成交额倍数破万时，会把超出部分 clamp 到画布外，
     看起来就是「曲线超出表格」。现在所有线都落在 12~112 的绘图区内，极值贴边但不出框。 */
  function multi(svg, specs, labels) {
    if (!svg) return; svg.innerHTML = '';
    var n = 0; specs.forEach(function (s) { if (s && s.data && s.data.length > n) n = s.data.length; });
    if (!n) { svg.appendChild(TX(180, 80, '暂无快照', 12, WufuTheme.sub('§WFT0002§'), 'middle')); return; }
    var all = [];
    specs.forEach(function (s) {
      var a = [], mn = null, mx = null;
      (s.data || []).forEach(function (v) {
        if (typeof v === 'number' && isFinite(v)) {
          a.push(v); if (mn === null || v < mn) mn = v; if (mx === null || v > mx) mx = v;
        }
      });
      if (!a.length) return;
      /* 10 年成交额倍数会因早期基数极小放大到 10 万倍，若混进定轴会把刻度拉成负数、
         把其余三条压成平线。倍率 >20 倍的线不参与定轴，仍绘制并贴边，文案另作说明。 */
      if (mn > 0 && mx / mn > 20) { s.clipped = true; return; }
      s.clipped = false;
      a.forEach(function (v) { all.push(v); });
    });
    if (!all.length) all = [100];
    all.sort(function (a, b) { return a - b; });
    var q = function (p) { return all[Math.max(0, Math.min(all.length - 1, Math.floor(p * (all.length - 1))))]; };
    var lo = Math.min(q(0.01), 100), hi = Math.max(q(0.99), 100);
    if (!(hi > lo)) hi = lo + 10;
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var yTop = 12, yBot = 112;
    var Y = function (v) {
      var x = Math.max(lo, Math.min(hi, v));
      return yTop + (hi - x) / (hi - lo) * (yBot - yTop);
    };
    var yticks = [];
    for (var ti = 0; ti <= 4; ti++) yticks.push(lo + (hi - lo) * ti / 4);
    grid(svg, yticks, Y, 34, 344);
    yticks.forEach(function (v) { svg.appendChild(TX(2, Y(v) + 3, v.toFixed(0), 9)); });
    specs.forEach(function (s) {
      if (!s || !s.data || !s.data.length) return;
      var pts = [], nn = s.data.length;
      for (var i = 0; i < nn; i++) {
        var v = s.data[i];
        if (v === null || v === undefined || !isFinite(v)) continue;
        pts.push((34 + i * (310 / (nn - 1))) + ',' + Y(v));
      }
      if (pts.length > 1) svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.8, 'stroke-linejoin': 'round' }));
    });
    /* v0.65：X 轴每年只留一个年份 */
    var ticks = window.WufuRange ? WufuRange.yearTicks(labels) : [];
    ticks.forEach(function (k) {
      var x = 34 + k.i * (310 / Math.max(1, (labels || []).length - 1));
      svg.appendChild(TX(x, 146, k.text, 9, WufuTheme.sub('§WFT0002§'), k.i === 0 ? 'start' : (k.i >= (labels || []).length - 2 ? 'end' : 'middle')));
    });
    /* v0.69c：浮层显示与上方六卡同源的真实值；曲线本身仍是起点=100 的归一形状 */
    if (window.WufuRange) WufuRange.probe(svg, {
      labels: labels || [], vbW: 360, y0: 8, y1: 140,
      xAt: function (i) { return 34 + i * (310 / Math.max(1, (labels || []).length - 1)); },
      yAt: Y,
      series: specs.map(function (s) {
        /* v0.69d：range.js 旧版的 probe 只把 (v) 传给 fmt、不传索引，导致 s.real[i] 恒为
           undefined、浮层全退回「（归一）」。改用 data 函数捕获索引：probe 取数时会先调
           data(i)，把 i 存进 _i，随后 fmt(v) 即可用 _i 取真实值。与 range.js 版本无关。 */
        var _i = 0;
        return { name: s.name || '', color: s.color,
          data: function (i) { _i = i; return (s.data || [])[i]; },
          fmt: function (v) {
            var r = s.real && s.real[_i];
            if (typeof r === 'number' && isFinite(r)) return r.toFixed(1) + (s.unit || '');
            return (typeof v === 'number' && isFinite(v)) ? v.toFixed(1) + '（归一）' : '—';
          } };
      }),
      note: '浮层=真实值 · 曲线=归一形状'
    });
  }
  function emptyChart(id, msg) {
    var svg = $(id); if (!svg) return; svg.innerHTML = '';
    svg.appendChild(TX(180, 78, msg || '暂无快照', 12, WufuTheme.sub('§WFT0002§'), 'middle'));
  }
  function tg(id) { var c = $(id); if (c) c.classList.toggle('open'); }
  window.tg = tg;

  /* ===================== 可转债看板 ===================== */
  function renderCB() {
    var d = D || {}, s = d.summary || {};
    var hd = document.querySelector('#c1 .hd span'); if (hd) hd.textContent = '最新交易日 ' + T(d.dataAsOf) + badgeOf(d);
    var strip = document.querySelector('#c1 .strip');
    if (strip) strip.innerHTML = '在市 <b>' + T(d.count) + '</b> · 中位价 <b>' + T(s.medianPrice) + '</b> · 溢价率 <b>' + T(s.medianPremium) + '%</b> · 涨 <span class="u">' + T(s.up) + '</span>/跌 <span class="d">' + T(s.down) + '</span>';
    /* 六卡 */
    var kpi = CLR('kpi');
    (d.kpi || []).forEach(function (k) {
      var e = document.createElement('div'); e.className = 'kc';
      e.innerHTML = '<div class="kt">' + T(k.label) + '</div><div class="kv">' + T(k.value) + '</div><div class="ks">' + T(k.sub) + '</div>';
      kpi.appendChild(e);
    });
    /* 分位行 */
    var rows = document.querySelectorAll('#cbBottom .row[data-a]');
    (d.quantiles || []).forEach(function (q, i) {
      var r = rows[i]; if (!r) return;
      var p5 = q.pct5, p10 = q.pct10;
      r.setAttribute('data-a', p5 === null ? '' : p5); r.setAttribute('data-b', p10 === null ? '' : p10);
      var b = r.querySelector('.lb span b'); if (b) b.textContent = (q.value === null || q.value === undefined ? '—' : String(q.value)) + (q.unit || '');
      var nm = r.querySelector('.lb span'); if (nm) nm.firstChild && (nm.firstChild.nodeValue = q.name + ' ');
    });
    /* 两个计数 */
    var chips = document.querySelectorAll('#cbBottom .chip b');
    var ex = d.extra || {}; var eks = Object.keys(ex);
    for (var ci = 0; ci < chips.length && ci < eks.length; ci++) chips[ci].textContent = T(ex[eks[ci]]);
    /* 结构分布标签 */
    var tabs = CLR('distTabs'); var keys = Object.keys(d.dist || {});
    keys.forEach(function (k) {
      var e = document.createElement('div'); e.className = 'dt2' + (k === distKey ? ' on' : ''); e.textContent = k;
      e.onclick = function () { distKey = k; renderCB(); };
      tabs.appendChild(e);
    });
    drawDist(d);
    drawCbTrend(d);
  }
  function drawDist(d) {
    var svg = $('distChart'); if (!svg) return; svg.innerHTML = '';
    var bins = ((d.dist || {})[distKey] || []), max = 1;
    bins.forEach(function (b) { if (b.count > max) max = b.count; });
    max *= 1.18;
    var W = 44, x0 = 34, H = 108;
    grid(svg, [0, 0.25, 0.5, 0.75, 1], function (v) { return 18 + (1 - v) * H; }, 34, 344);
    bins.forEach(function (b, i) {
      var w = W - 8, x = x0 + 9 + i * ((310 - 9) / Math.max(1, bins.length)), h = (b.count / max) * H;
      svg.appendChild(E('rect', { x: x, y: 18 + H - h, width: w, height: Math.max(1, h), rx: 3, fill: WufuTheme.sub('§WFT0140§') }));
      svg.appendChild(TX(x + w / 2, 18 + H - h - 4, String(b.count), 9, WufuTheme.sub('§WFT0003§'), 'middle'));
      svg.appendChild(TX(x + w / 2, 142, b.label, 8.5, WufuTheme.sub('§WFT0002§'), 'middle'));
    });
    svg.appendChild(TX(180, 158, '柱高 = 区间只数', 9, WufuTheme.sub('§WFT0002§'), 'middle'));
    var note = $('distNote'); if (note) note.textContent = (d.dist && d.dist[distKey] && d.dist[distKey].note) || ('按 ' + distKey + ' 分档统计在市债只数；平均涨跌幅待接入。');
  }
  function drawCbTrend(d) {
    var t = (d.trend || {})[String(years)] || {};
    var LB = SL(t.labels || [], selCB);
    /* v0.69c：当日真实值取自上方六卡同源字段，把「起点=100」的归一曲线按末日锚回真实量纲。
       归一严格等于 真实值/区间起点值*100，故 真实值(i) = norm(i)/norm(last) * 当日真实值。 */
    var sum = d.summary || {}, kp = {};
    (d.kpi || []).forEach(function (k) { kp[k.label] = k.value; });
    var num = function (x) { var m = String(x == null ? '' : x).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : null; };
    var REAL = { eq: null, price: num(sum.medianPrice), prem: num(sum.medianPremium), amount: num(kp['总成交额']) };
    var specs = [
      { key: 'eq', color: WufuTheme.sub('§WFT0010§'), name: '转债等权', unit: '' },
      { key: 'price', color: WufuTheme.sub('§WFT0006§'), name: '中位价', unit: ' 元' },
      { key: 'prem', color: WufuTheme.sub('§WFT0020§'), name: '中位溢价率', unit: '%' },
      { key: 'amount', color: WufuTheme.sub('§WFT0003§'), name: '总成交额', unit: ' 亿' }
    ];
    var txt = [];
    specs.forEach(function (s) {
      var raw = t[s.key] || [];
      var rb = window.WufuRange ? WufuRange.rebase(raw, selCB) : { data: SL(raw, selCB), ret: null };
      s.data = rb.data;
      if (rb.ret !== null) txt.push(s.name + ' ' + (rb.ret >= 0 ? '+' : '') + rb.ret.toFixed(1) + '%');
      var lv = null;
      for (var i = raw.length - 1; i >= 0; i--) {
        if (typeof raw[i] === 'number' && isFinite(raw[i]) && raw[i] > 0) { lv = raw[i]; break; }
      }
      var rl = REAL[s.key];
      s.real = (rl != null && lv != null) ? SL(raw.map(function (v) {
        return (typeof v === 'number' && isFinite(v) && v > 0) ? v / lv * rl : null;
      }), selCB) : null;
    });
    multi($('cbTrend'), specs, LB);
    var ri = $('cbRangeInfo');
    if (ri && window.WufuRange) {
      var inf = WufuRange.info(t.labels || [], selCB);
      ri.innerHTML = WufuRange.isFull(selCB)
        ? '拖动下方时间条，以所选区间开头为起点重算收益 · 各线各自归一 100 · 周频<br>点曲线浮层为<b>真实值</b>（元 / % / 亿），与上方六卡一致；等权指数无绝对量纲，显示归一值。'
        : '<b>' + inf.from + ' → ' + inf.to + '</b> · 起点=100 · ' + txt.join(' / ') +
          '<br>浮层为真实值；成交额线是「相对首日倍数」，不是收益率；分位刻度仍是全历史口径。';
    }
    var clipped = specs.filter(function (s) { return s.clipped; });
    if (clipped.length && ri) ri.insertAdjacentHTML('beforeend',
      WufuTheme.sub('<br><span style="color:§WFT0011§">') + clipped.map(function (s) { return s.name; }).join('、') +
      ' 倍率过大已贴边显示（早期基数极小），浮层仍为真实值。</span>');
    if (rngCB) rngCB.setLabels(t.labels || []);
    var sn = $('cbSampleNote');
    if (sn) sn.textContent = years === 5 ? '样本 5 年 · 周频' : ((d.sampleNote || '样本 —') + ' · 周频');
  }

  /* ===================== 指数看板 ===================== */
  function renderIDX() {
    var d = D || {};
    var hd = document.querySelector('#c2 .hd span');
    if (hd) hd.textContent = '最新交易日 ' + T(d.dataAsOf) + badgeOf(d);
    function findChg(name) {
      var A = (d.idx || {}).A || [];
      for (var i = 0; i < A.length; i++) if (A[i][0] === name) return A[i][1];
      return null;
    }
    function ch(v) { return typeof v === 'number' ? '<span class="' + cls(v) + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>' : '—'; }
    var sl = $('idxSum');
    var gapSum = (((d.coverage || {}).gaps) || []).map(function (g) {
      return g.name + ' 止于 ' + T(g.lastValidDate);
    }).join(' · ');
    var holeTxt = ((((d.coverage || {}).csiHoles) || {}).text) || '';
    if (sl) sl.innerHTML = '沪深300 ' + ch(findChg('沪深300')) + '<i>·</i>国证2000 ' + ch(findChg('国证2000'))
      + (gapSum ? '<i>·</i><span class="gapmk">' + gapSum + '（无日更增量，未编造）</span>' : '')
      + (holeTxt ? '<i>·</i><span class="gapmk">' + holeTxt + '</span>' : '');
    renderIdxRows(d);
    drawIdxChart(d);
    if (!AMT && !window.__amtTried) {
      window.__amtTried = true;
      loadJSON('../market-amount.json',
        function (j) { AMT = j; if (D) drawIdxChart(D); },
        function () { AMT = null; if (D) drawIdxChart(D); });
    }
    var sn = $('idxSampleNote');
    if (sn) {
      var gapTxt = (((d.coverage || {}).gaps) || []).map(function (g) {
        return g.name + ' 止于 ' + T(g.lastValidDate);
      }).join(' · ');
      sn.textContent = (((d.trendNote || {})[String(years)]) || d.sampleNote || '样本 —')
        + (gapTxt ? ' · ' + gapTxt + '（无日更增量，未编造）' : '');
    }
  }
  function renderIdxRows(d) {
    var groups = [['A', 'idxA'], ['H', 'idxH'], ['U', 'idxU']];
    groups.forEach(function (g) {
      var box = $(g[1]); if (!box) return; box.innerHTML = '';
      ((d.idx || {})[g[0]] || []).forEach(function (r) {
        var name = r[0], chg = r[1], p5 = r[2], p10 = r[3], v = years === 5 ? p5 : p10;
        var e = document.createElement('div'); e.className = 'ir';
        var up = (typeof chg === 'number' && chg > 0);
        e.innerHTML = '<div class="nm">' + T(name) + '</div>' +
          '<div class="pc ' + (up ? 'u' : 'd') + '">' + (typeof chg === 'number' ? (up ? '+' : '') + chg.toFixed(2) + '%' : '—') + '</div>' +
          '<div class="mini"><i style="width:' + (v === null ? 0 : v) + '%"></i></div>' +
          '<div class="pos">' + (v === null ? '—' : v + '%') + '</div>';
        box.appendChild(e);
      });
    });
    var gh = document.querySelectorAll('#c2 .ghead .gname');
    var na = ((d.idx || {}).A || []).length, nh = ((d.idx || {}).H || []).length, nu = ((d.idx || {}).U || []).length;
    if (gh[0]) gh[0].textContent = (na + nh + nu) + ' 条';
    if (gh[1]) gh[1].textContent = na + ' 条 · 最新交易日 ' + T(d.dataAsOf);
    if (gh[2]) gh[2].textContent = nh + ' 条 · 最新交易日 ' + T(d.dataAsOf);
    if (gh[3]) gh[3].textContent = nu + ' 条 · 最新交易日 ' + T(d.dataAsOf);
  }
  function drawIdxChart(d) {
    var idxAsOf = d.dataAsOf || null;
    var amtAsOf = (AMT && AMT.dataAsOf) ? AMT.dataAsOf : null;
    /* v0.84：截止日不一致就不叠柱，避免两条不同时间口径的数据同图混读 */
    var amtMismatch = !!(idxAsOf && amtAsOf && idxAsOf !== amtAsOf);
    var t = ((d.idxTrend || {})[String(years)] || {});
    var svg = $('idxChart'); if (!svg) return; svg.innerHTML = '';
    var rb1 = window.WufuRange ? WufuRange.rebase(t.hs300 || [], selIDX) : { data: SL(t.hs300 || [], selIDX), ret: null };
    var rb2 = window.WufuRange ? WufuRange.rebase(t.gz2000 || [], selIDX) : { data: SL(t.gz2000 || [], selIDX), ret: null };
    var s1 = rb1.data, s2 = rb2.data, LB = SL(t.labels || [], selIDX);
    var n = Math.max(s1.length, s2.length);
    if (!n) { emptyChart('idxChart', '暂无指数曲线'); return; }
    var all = s1.concat(s2).filter(function (x) { return isFinite(x); });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (!isFinite(lo) || !isFinite(hi) || hi === lo) { lo = 60; hi = 140; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var Y = function (v) { return 12 + (hi - v) / (hi - lo) * 100; };
    grid(svg, [lo + (hi - lo) * 0.25, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.75], Y, 34, 344);
    /* 两市成交额柱：独立量纲，画在下方 124~158，不与指数点位混算 */
    var am = (AMT && AMT[String(years)] && !amtMismatch)
      ? SL(AMT[String(years)].amount || [], selIDX) : [];
    var amax = 1;
    am.forEach(function (v) { if (typeof v === 'number' && isFinite(v) && v > amax) amax = v; });
    if (am.length > 1) {
      var bw = Math.max(1.5, 310 / am.length * 0.55);
      for (var ai = 0; ai < am.length; ai++) {
        var v = am[ai]; if (typeof v !== 'number' || !isFinite(v)) continue;
        var x = 34 + ai * (310 / Math.max(1, am.length - 1));
        var h = Math.max(1, (v / amax) * 32);
        svg.appendChild(E('rect', { x: (x - bw / 2).toFixed(1), y: (156 - h).toFixed(1),
          width: bw.toFixed(1), height: h.toFixed(1), fill: WufuTheme.sub('§WFT0137§'),
          stroke: WufuTheme.sub('§WFT0139§'), 'stroke-width': '.5' }));
      }
      svg.appendChild(E('line', { x1: 34, y1: 156, x2: 344, y2: 156, stroke: WufuTheme.sub('§WFT0001§'), 'stroke-width': '1' }));
      svg.appendChild(TX(344, 122, '成交额峰值 ' + Math.round(amax) + ' 亿', 8.5, WufuTheme.sub('§WFT0002§'), 'end'));
    }
    [[s1, WufuTheme.sub('§WFT0006§')], [s2, WufuTheme.sub('§WFT0010§')]].forEach(function (p) {
      var pts = [];
      p[0].forEach(function (v, i) { if (isFinite(v)) pts.push((34 + i * (310 / Math.max(1, p[0].length - 1))) + ',' + Y(v)); });
      if (pts.length > 1) svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: p[1], 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    });
    /* X 轴：每年只显示一个年份，避免日期叠在一起 */
    var ticks = window.WufuRange ? WufuRange.yearTicks(LB) : [];
    ticks.forEach(function (k) {
      var x = 34 + k.i * (310 / Math.max(1, LB.length - 1));
      var anchor = k.i === 0 ? 'start' : (k.i >= LB.length - 2 ? 'end' : 'middle');
      svg.appendChild(TX(x, 170, k.text, 9, WufuTheme.sub('§WFT0002§'), anchor));
    });
    if (rngIDX) rngIDX.setLabels(t.labels || []);
    var ri = $('idxRangeInfo');
    if (ri && window.WufuRange) {
      var inf = WufuRange.info(t.labels || [], selIDX);
      ri.innerHTML = WufuRange.isFull(selIDX)
        ? '拖动下方时间条，以所选区间开头为起点重算收益 · 双线各自归一 100 · 周频'
        : '<b>' + inf.from + ' → ' + inf.to + '</b> · 起点=100 · 沪深300 ' +
          (rb1.ret === null ? '—' : (rb1.ret >= 0 ? '+' : '') + rb1.ret.toFixed(1) + '%') +
          ' / 国证2000 ' + (rb2.ret === null ? '—' : (rb2.ret >= 0 ? '+' : '') + rb2.ret.toFixed(1) + '%') +
          '<br>成交额柱是绝对金额，只裁区间、不重定基。';
    }
    var note = $('idxAmtNote');
    if (note) note.textContent = amtMismatch
      ? '两市成交额柱截至 ' + T(amtAsOf) + '，与指数曲线 ' + T(idxAsOf)
        + ' 不同日，为避免混读本次不叠柱；同步对齐后自动恢复。'
      : (am.length > 1
        ? '两市成交额 = 上证指数 + 深证成指 K 线成交额之和（亿元，近似口径），柱形单独归一，不与指数点位混读。'
        : '两市成交额暂无快照，图上不摆空柱。');
    /* v0.65：点曲线 → 当日日期 + 沪深300/国证2000 数值（成交额柱是绝对金额，不混进浮层） */
    if (window.WufuRange) WufuRange.probe(svg, {
      labels: LB, vbW: 360, y0: 8, y1: 158,
      xAt: function (i) { return 34 + i * (310 / Math.max(1, LB.length - 1)); },
      yAt: Y,
      series: [
        { name: '沪深300', color: WufuTheme.sub('§WFT0006§'), data: s1, fmt: function (v) { return v.toFixed(1); } },
        { name: '国证2000', color: WufuTheme.sub('§WFT0010§'), data: s2, fmt: function (v) { return v.toFixed(1); } }
      ],
      note: '起点=100 · 成交额柱只裁区间'
    });
  }

  /* ===================== 交互 ===================== */
  function applyYears() {
    selCB = [0, 1]; selIDX = [0, 1];
    if (rngCB) rngCB.reset(); if (rngIDX) rngIDX.reset();
    if (quickCB) quickCB.mark([0, 1]); if (quickIDX) quickIDX.mark([0, 1]);
    document.querySelectorAll('[data-seg] span[data-y]').forEach(function (s) { s.classList.toggle('on', +s.getAttribute('data-y') === years); });
    document.querySelectorAll('#cbBottom .row[data-a]').forEach(function (r) {
      var p = years === 5 ? r.getAttribute('data-a') : r.getAttribute('data-b');
      var pct = r.querySelector('.pct'), fill = r.querySelector('.fill'), dot = r.querySelector('.dot');
      if (pct) pct.textContent = (p === '' || p === null ? '—' : p + '% 分位');
      if (fill) fill.style.width = (p === '' || p === null ? 0 : p) + '%';
      if (dot) dot.style.left = (p === '' || p === null ? 0 : p) + '%';
    });
    if (D) { if (kind === 'cb') drawCbTrend(D); else { renderIdxRows(D); drawIdxChart(D); var sn = $('idxSampleNote'); if (sn) sn.textContent = ((D.trendNote || {})[String(years)]) || D.sampleNote || '样本 —'; } }
  }
  document.querySelectorAll('[data-seg] span[data-y]').forEach(function (s) {
    s.onclick = function () { years = +s.getAttribute('data-y'); applyYears(); };
  });
  function boot() {
    if (D) { if (kind === 'cb') renderCB(); else renderIDX(); }
    applyYears();
    if (window.WufuRange && !rngCB && !rngIDX) {
      rngCB = WufuRange.mount('cbRange', { onChange: function (x) { selCB = x; if (quickCB) quickCB.mark(x); if (D && kind === 'cb') drawCbTrend(D); } });
      rngIDX = WufuRange.mount('idxRange', { onChange: function (x) { selIDX = x; if (quickIDX) quickIDX.mark(x); if (D && kind !== 'cb') drawIdxChart(D); } });
      /* v0.69b：看板曲线加同款「展示区间」控件 */
      /* v0.69d：旧缓存 range.js 没有 quick，先判存在，避免 TypeError 中断整段 init */
      var _Q = (window.WufuRange && typeof WufuRange.quick === 'function') ? WufuRange.quick : null;
      quickCB = _Q ? _Q({ anchorId: 'cbRangeInfo',
        labels: function () { return (((D.trend || {})[String(years)] || {}).labels) || []; },
        get: function () { return selCB; },
        set: function (x) { selCB = x; if (rngCB) rngCB.set(x, true); if (D && kind === 'cb') drawCbTrend(D); } }) : null;
      quickIDX = _Q ? _Q({ anchorId: 'idxRangeInfo',
        labels: function () { return (((D.idxTrend || {})[String(years)] || {}).labels) || []; },
        get: function () { return selIDX; },
        set: function (x) { selIDX = x; if (rngIDX) rngIDX.set(x, true); if (D && kind !== 'cb') drawIdxChart(D); } }) : null;
      /* v0.65：首次渲染时条还没 mount，mount 后补一次日期标签 */
      if (D) {
        var tl = kind === 'cb' ? (((D.trend || {})[String(years)] || {}).labels || [])
                               : (((D.idxTrend || {})[String(years)] || {}).labels || []);
        if (kind === 'cb' && rngCB) rngCB.setLabels(tl);
        if (kind !== 'cb' && rngIDX) rngIDX.setLabels(tl);
      }
    }
  }
  function fail() {
    var strip = document.querySelector('#c1 .strip') || $('idxSum');
    if (strip) strip.innerHTML = '暂无快照 · 数据文件尚未生成（周五同步后自动出现）';
    boot();
  }
  loadJSON(url, function (d) { D = d; boot(); }, fail);

  /* v0.89 / P3：回前台重取一次。失败时保留现有 D，绝不调 fail 把真值抹成「暂无快照」。 */
  if (window.WufuDash && window.WufuDash.onRefresh) {
    window.WufuDash.onRefresh(url, function () {
      loadJSON(url, function (d) {
        D = d;
        window.__amtTried = false;   // 让 renderIDX 同步重取成交额柱，不留下旧截止日
        boot();                      // boot 内 mount 均有 !rng* 守卫，重复调用幂等
      }, function () { /* §3.6 沿用上次真值，页面保持原样 */ });
    });
  }
})();