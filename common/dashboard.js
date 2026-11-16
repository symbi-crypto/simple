/* dashboard.js — 综合看板渲染器（v0.59）
   数据只来自同目录的 cb-daily.json / index-daily.json，指数侧全部由本地真实日线计算，缺数一律显示「—」，不写示意值。 */
(function () {
  'use strict';
  var wrap = document.getElementById('dashWrap');
  if (!wrap) return;
  var kind = wrap.getAttribute('data-kind') || 'cb';
  var url = wrap.getAttribute('data-json') || '../cb-daily.json';
  var D = null, years = 5, distKey = '价格';
  var selCB = [0, 1], selIDX = [0, 1], AMT = null, rngCB = null, rngIDX = null;
  function SL(a, sel) { return window.WufuRange ? WufuRange.slice(a, sel) : a; }
  var NS = 'http://www.w3.org/2000/svg';
  function $(id) { return document.getElementById(id); }
  function T(v) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '—' : String(v); }
  function E(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function TX(x, y, s, size, color, anchor) {
    var t = E('text', { x: x, y: y, 'font-size': size, fill: color || '#7C8DA1', 'font-family': 'sans-serif' });
    if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t;
  }
  function CLR(id) { var e = $(id); if (e) e.innerHTML = ''; return e; }
  function sign(v) { return (typeof v === 'number' && v > 0) ? '+' + v : T(v); }
  function cls(v) { return (typeof v === 'number' && v > 0) ? 'u' : 'd'; }
  function grid(svg, vals, yfn, x0, x1) {
    var g = E('g', { stroke: '#2C3B4E', 'stroke-width': '1' });
    vals.forEach(function (v) { g.appendChild(E('line', { x1: x0, y1: yfn(v), x2: x1, y2: yfn(v) })); });
    svg.appendChild(g);
  }
  /* 多条序列共用画布：每条自身归一，只比形状 */
  function multi(svg, specs, labels) {
    if (!svg) return; svg.innerHTML = '';
    var n = 0; specs.forEach(function (s) { if (s && s.data && s.data.length > n) n = s.data.length; });
    if (!n) { svg.appendChild(TX(180, 80, '暂无快照', 12, '#7C8DA1', 'middle')); return; }
    var X = function (i) { return 34 + i * (310 / (n - 1)); };
    var Y = function (v) { return 12 + (200 - Math.max(40, Math.min(260, v))) * 0.62; };
    grid(svg, [60, 100, 140, 200], Y, 34, 344);
    [60, 100, 140, 200].forEach(function (v) { svg.appendChild(TX(2, Y(v) + 3, String(v), 9)); });
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
    (labels || []).forEach(function (L, i) {
      var x = 34 + i * (310 / Math.max(1, (labels.length - 1)));
      svg.appendChild(TX(x, 146, L, 9, '#7C8DA1', i === 0 ? 'start' : (i === labels.length - 1 ? 'end' : 'middle')));
    });
  }
  function emptyChart(id, msg) {
    var svg = $(id); if (!svg) return; svg.innerHTML = '';
    svg.appendChild(TX(180, 78, msg || '暂无快照', 12, '#7C8DA1', 'middle'));
  }
  function tg(id) { var c = $(id); if (c) c.classList.toggle('open'); }
  window.tg = tg;

  /* ===================== 可转债看板 ===================== */
  function renderCB() {
    var d = D || {}, s = d.summary || {};
    var hd = document.querySelector('#c1 .hd span'); if (hd) hd.textContent = '最新交易日 ' + T(d.dataAsOf);
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
      svg.appendChild(E('rect', { x: x, y: 18 + H - h, width: w, height: Math.max(1, h), rx: 3, fill: 'rgba(79,195,247,.55)' }));
      svg.appendChild(TX(x + w / 2, 18 + H - h - 4, String(b.count), 9, '#9FB0C3', 'middle'));
      svg.appendChild(TX(x + w / 2, 142, b.label, 8.5, '#7C8DA1', 'middle'));
    });
    svg.appendChild(TX(180, 158, '柱高 = 区间只数', 9, '#7C8DA1', 'middle'));
    var note = $('distNote'); if (note) note.textContent = (d.dist && d.dist[distKey] && d.dist[distKey].note) || ('按 ' + distKey + ' 分档统计在市债只数；平均涨跌幅待接入。');
  }
  function drawCbTrend(d) {
    var t = (d.trend || {})[String(years)] || {};
    var LB = SL(t.labels || [], selCB);
    multi($('cbTrend'), [
      { data: SL(t.eq, selCB), color: '#F87171' }, { data: SL(t.price, selCB), color: '#4FC3F7' },
      { data: SL(t.prem, selCB), color: '#A78BFA' }, { data: SL(t.amount, selCB), color: '#9FB0C3' }
    ], LB);
    if (rngCB) rngCB.setLabels(t.labels || []);
    var sn = $('cbSampleNote');
    if (sn) sn.textContent = years === 5 ? '样本 5 年' : (d.sampleNote || '样本 —');
  }

  /* ===================== 指数看板 ===================== */
  function renderIDX() {
    var d = D || {};
    var hd = document.querySelector('#c2 .hd span');
    if (hd) hd.textContent = '指数基线 ' + T(d.dataAsOf);
    function findChg(name) {
      var A = (d.idx || {}).A || [];
      for (var i = 0; i < A.length; i++) if (A[i][0] === name) return A[i][1];
      return null;
    }
    function ch(v) { return typeof v === 'number' ? '<span class="' + cls(v) + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>' : '—'; }
    var sl = $('idxSum');
    if (sl) sl.innerHTML = '沪深300 ' + ch(findChg('沪深300')) + '<i>·</i>国证2000 ' + ch(findChg('国证2000'));
    renderIdxRows(d);
    drawIdxChart(d);
    if (!AMT && !window.__amtTried) {
      window.__amtTried = true;
      fetch('../market-amount.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { AMT = j; if (D) drawIdxChart(D); })
        .catch(function () { AMT = null; if (D) drawIdxChart(D); });
    }
    var sn = $('idxSampleNote');
    if (sn) sn.textContent = ((d.trendNote || {})[String(years)]) || d.sampleNote || '样本 —';
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
    if (gh[1]) gh[1].textContent = na + ' 条 · 指数基线 ' + T(d.dataAsOf);
    if (gh[2]) gh[2].textContent = nh + ' 条 · 指数基线 ' + T(d.dataAsOf);
    if (gh[3]) gh[3].textContent = nu + ' 条 · 指数基线 ' + T(d.dataAsOf);
  }
  function drawIdxChart(d) {
    var t = ((d.idxTrend || {})[String(years)] || {});
    var svg = $('idxChart'); if (!svg) return; svg.innerHTML = '';
    var s1 = SL(t.hs300 || [], selIDX), s2 = SL(t.gz2000 || [], selIDX), LB = SL(t.labels || [], selIDX);
    var n = Math.max(s1.length, s2.length);
    if (!n) { emptyChart('idxChart', '暂无指数曲线'); return; }
    var all = s1.concat(s2).filter(function (x) { return isFinite(x); });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (!isFinite(lo) || !isFinite(hi) || hi === lo) { lo = 60; hi = 140; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var Y = function (v) { return 12 + (hi - v) / (hi - lo) * 100; };
    grid(svg, [lo + (hi - lo) * 0.25, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.75], Y, 34, 344);
    /* 两市成交额柱：独立量纲，画在下方 124~158，不与指数点位混算 */
    var am = (AMT && AMT[String(years)]) ? SL(AMT[String(years)].amount || [], selIDX) : [];
    var amax = 1;
    am.forEach(function (v) { if (typeof v === 'number' && isFinite(v) && v > amax) amax = v; });
    if (am.length > 1) {
      var bw = Math.max(1.5, 310 / am.length * 0.55);
      for (var ai = 0; ai < am.length; ai++) {
        var v = am[ai]; if (typeof v !== 'number' || !isFinite(v)) continue;
        var x = 34 + ai * (310 / Math.max(1, am.length - 1));
        var h = Math.max(1, (v / amax) * 32);
        svg.appendChild(E('rect', { x: (x - bw / 2).toFixed(1), y: (156 - h).toFixed(1),
          width: bw.toFixed(1), height: h.toFixed(1), fill: 'rgba(79,195,247,.28)',
          stroke: 'rgba(79,195,247,.45)', 'stroke-width': '.5' }));
      }
      svg.appendChild(E('line', { x1: 34, y1: 156, x2: 344, y2: 156, stroke: '#3E4E63', 'stroke-width': '1' }));
      svg.appendChild(TX(344, 122, '成交额峰值 ' + Math.round(amax) + ' 亿', 8.5, '#7C8DA1', 'end'));
    }
    [[s1, '#4FC3F7'], [s2, '#F87171']].forEach(function (p) {
      var pts = [];
      p[0].forEach(function (v, i) { if (isFinite(v)) pts.push((34 + i * (310 / Math.max(1, p[0].length - 1))) + ',' + Y(v)); });
      if (pts.length > 1) svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: p[1], 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    });
    /* X 轴：每年只显示一个年份，避免日期叠在一起 */
    var ticks = window.WufuRange ? WufuRange.yearTicks(LB) : [];
    ticks.forEach(function (k) {
      var x = 34 + k.i * (310 / Math.max(1, LB.length - 1));
      var anchor = k.i === 0 ? 'start' : (k.i >= LB.length - 2 ? 'end' : 'middle');
      svg.appendChild(TX(x, 170, k.text, 9, '#7C8DA1', anchor));
    });
    if (rngIDX) rngIDX.setLabels(t.labels || []);
    var note = $('idxAmtNote');
    if (note) note.textContent = am.length > 1
      ? '两市成交额 = 上证指数 + 深证成指 K 线成交额之和（亿元，近似口径），柱形单独归一，不与指数点位混读。'
      : '两市成交额暂无快照，图上不摆空柱。';
  }

  /* ===================== 交互 ===================== */
  function applyYears() {
    selCB = [0, 1]; selIDX = [0, 1];
    if (rngCB) rngCB.reset(); if (rngIDX) rngIDX.reset();
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
      rngCB = WufuRange.mount('cbRange', { onChange: function (x) { selCB = x; if (D && kind === 'cb') drawCbTrend(D); } });
      rngIDX = WufuRange.mount('idxRange', { onChange: function (x) { selIDX = x; if (D && kind !== 'cb') drawIdxChart(D); } });
    }
  }
  function fail() {
    var strip = document.querySelector('#c1 .strip') || $('idxSum');
    if (strip) strip.innerHTML = '暂无快照 · 数据文件尚未生成（周五同步后自动出现）';
    boot();
  }
  fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { D = d; boot(); })
    .catch(fail);
})();