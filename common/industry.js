/* industry.js — A股行业宽度全景（v0.59）
   数据只读 ../industry-daily.json，且仅在指数看板展开后才拉，不进首屏。
   口径由数据文件自带：东财行业板块（细分板块），不是申万 31 个一级行业。 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var D = null, years = 5, active = 0, hmode = 'chg', loaded = false;
  var isel = [0, 1], rngI = null;
  function SL(a) { return window.WufuRange ? WufuRange.slice(a, isel) : a; }
  function $(id) { return document.getElementById(id); }
  function E(tag, a) { var n = document.createElementNS(NS, tag); for (var k in a) n.setAttribute(k, a[k]); return n; }
  function TX(x, y, s, size, color, anchor) {
    var t = E('text', { x: x, y: y, 'font-size': size, fill: color || '#7C8DA1', 'font-family': 'sans-serif' });
    if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t;
  }
  function T(v) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '—' : String(v); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function clear(id) { var e = $(id); if (e) e.innerHTML = ''; return e; }
  function heatColor(v, maxAbs) {
    if (v === null || v === undefined || !isFinite(v)) return '#2A3B50';
    var a = Math.min(.88, .12 + Math.abs(v) / Math.max(0.8, maxAbs) * .78);
    return v >= 0 ? 'rgba(248,113,113,' + a.toFixed(2) + ')' : 'rgba(52,211,153,' + a.toFixed(2) + ')';
  }
  function tempColor(v) {
    if (v === null || v === undefined || !isFinite(v)) return '#2A3B50';
    if (v <= 20) return '#1D4E7A';
    if (v >= 80) return '#A33A36';
    var t = (v - 20) / 60;
    return 'rgb(' + Math.round(29 + t * 134) + ',' + Math.round(78 - t * 20) + ',' + Math.round(122 - t * 68) + ')';
  }

  /* ---------- 说明 / 口径 ---------- */
  function renderMeta(d) {
    var s = $('indSource');
    if (s) s.textContent = d.source + ' · ' + d.boardCount + '/' + d.boardTotal + ' 个板块 · ' + d.sampleNote;
    var n = $('indSample');
    if (n) n.textContent = '最新交易日 ' + T(d.dataAsOf);
  }

  /* ---------- 七边形雷达 ---------- */
  function renderRadar(d) {
    var svg = clear('indRadar'); if (!svg) return;
    var keys = d.keys || [], cx = 180, cy = 104, R = 70, n = keys.length;
    if (!n) { svg.appendChild(TX(180, 100, '暂无快照', 12, '#7C8DA1', 'middle')); return; }
    var ang = function (i) { return -Math.PI / 2 + i * 2 * Math.PI / n; };
    var pt = function (i, r) { return [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r]; };
    [0.25, 0.5, 0.75, 1].forEach(function (q) {
      var p = [];
      for (var i = 0; i < n; i++) { var a = pt(i, R * q); p.push(a[0].toFixed(1) + ',' + a[1].toFixed(1)); }
      svg.appendChild(E('polygon', { points: p.join(' '), fill: 'none', stroke: '#2C3B4E', 'stroke-width': '1' }));
    });
    for (var i = 0; i < n; i++) {
      var a = pt(i, R);
      svg.appendChild(E('line', { x1: cx, y1: cy, x2: a[0], y2: a[1], stroke: '#2C3B4E', 'stroke-width': '1' }));
      var lp = pt(i, R + 17);
      svg.appendChild(TX(lp[0], lp[1] + 3, keys[i].slice(0, 6), 8.5, '#9FB0C3',
        Math.abs(lp[0] - cx) < 8 ? 'middle' : (lp[0] > cx ? 'start' : 'end')));
    }
    function poly(vals, stroke, fill) {
      var p = [];
      for (var j = 0; j < n; j++) {
        var v = vals && typeof vals[j] === 'number' && isFinite(vals[j]) ? Math.max(0, Math.min(100, vals[j])) : 0;
        var q = pt(j, R * v / 100); p.push(q[0].toFixed(1) + ',' + q[1].toFixed(1));
      }
      svg.appendChild(E('polygon', { points: p.join(' '), fill: fill, stroke: stroke, 'stroke-width': '1.7', 'stroke-linejoin': 'round' }));
    }
    poly((d.radar || {}).lastWeek, '#FBBF24', 'rgba(251,191,36,.06)');
    poly((d.radar || {}).today, '#4FC3F7', 'rgba(79,195,247,.18)');
  }

  /* ---------- 七张指标卡（点卡片切主图） ---------- */
  function renderCards(d) {
    var box = clear('indCards'); if (!box) return;
    (d.indicators || []).forEach(function (it, i) {
      var e = document.createElement('div');
      e.className = 'mcard' + (i === active ? ' on' : '');
      e.innerHTML = '<div class="mn">' + esc(it.name) + '</div><div class="mv">' + (it.value == null ? '—' : Math.round(it.value) + '<span style="font-size:10px;color:#9FB0C3">%</span>') + '</div>';
      e.onclick = function () { active = i; isel = [0, 1]; if (rngI) rngI.reset(); renderCards(d); renderArea(d); };
      box.appendChild(e);
    });
  }

  /* ---------- 0-100 面积图 ---------- */
  function renderArea(d) {
    var svg = clear('indArea'); if (!svg) return;
    var rawA = (((d.area || {})[String(years)] || {}).series || {})[(d.keys || [])[active]] || [];
    var rawL = ((d.area || {})[String(years)] || {}).labels || [];
    var a = SL(rawA), labels = SL(rawL);
    var vals = a.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (!vals.length) { svg.appendChild(TX(180, 78, '暂无快照', 12, '#7C8DA1', 'middle')); return; }
    var X = function (i) { return 34 + i * (310 / Math.max(1, a.length - 1)); };
    var Y = function (v) { return 12 + (100 - Math.max(0, Math.min(100, v))) * 1.1; };
    [20, 50, 80].forEach(function (g) {
      svg.appendChild(E('line', { x1: 34, y1: Y(g), x2: 344, y2: Y(g), stroke: g === 50 ? '#2C3B4E' : '#3E4E63',
        'stroke-width': '1', 'stroke-dasharray': g === 50 ? '' : '4 3' }));
      svg.appendChild(TX(31, Y(g) + 3, g, 9, g === 20 ? '#4FC3F7' : (g === 80 ? '#F87171' : '#7C8DA1'), 'end'));
    });
    var pts = [], area = 'M 34,122';
    for (var i = 0; i < a.length; i++) {
      if (typeof a[i] !== 'number' || !isFinite(a[i])) continue;
      var px = X(i).toFixed(1), py = Y(a[i]).toFixed(1);
      pts.push(px + ',' + py); area += ' L ' + px + ',' + py;
    }
    area += ' L 344,122 Z';
    var defs = E('defs', {});
    var lg = E('linearGradient', { id: 'indag', x1: '0', y1: '0', x2: '0', y2: '1' });
    lg.appendChild(E('stop', { offset: '0%', 'stop-color': '#4FC3F7', 'stop-opacity': '.38' }));
    lg.appendChild(E('stop', { offset: '100%', 'stop-color': '#4FC3F7', 'stop-opacity': '0' }));
    defs.appendChild(lg); svg.appendChild(defs);
    svg.appendChild(E('path', { d: area, fill: 'url(#indag)' }));
    svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: '#4FC3F7', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    var ticks = window.WufuRange ? WufuRange.yearTicks(labels) : [];
    ticks.forEach(function (k) {
      var x = 34 + k.i * (310 / Math.max(1, labels.length - 1));
      var anchor = k.i === 0 ? 'start' : (k.i >= labels.length - 2 ? 'end' : 'middle');
      svg.appendChild(TX(x, 142, k.text, 9, '#7C8DA1', anchor));
    });
    if (rngI) rngI.setLabels(rawL);
    var ri = $('indRangeInfo');
    if (ri && window.WufuRange) {
      var inf = WufuRange.info(rawL, isel);
      var vals = vals.filter(function (x) { return typeof x === 'number' && isFinite(x); });
      var mv = vals.length ? (vals.reduce(function (x, y) { return x + y; }, 0) / vals.length).toFixed(1) : '—';
      ri.innerHTML = WufuRange.isFull(isel)
        ? '拖动下方时间条查看区间 · 占比类曲线保持 0–100 原值，不重定基 · 周频'
        : '<b>' + inf.from + ' → ' + inf.to + '</b> · 区间均值 ' + mv + '% · 占比类曲线保持原值，不重定基';
    }
    var t = $('indAreaTitle'); if (t) t.textContent = (d.keys || [])[active] || '行业宽度';
    /* v0.65：点曲线 → 当日日期 + 宽度值 */
    if (window.WufuRange) WufuRange.probe(svg, {
      labels: labels, vbW: 360, y0: 8, y1: 124,
      xAt: X, yAt: Y,
      series: [{ name: (d.keys || [])[active] || '行业宽度', color: '#4FC3F7', data: a,
        fmt: function (v) { return v.toFixed(1) + '%'; } }],
      note: '0–100 占比 · 不重定基'
    });
  }

  /* ---------- 七指标温度条 ---------- */
  function renderHeatbar(d) {
    var box = clear('indHeatbar'); if (!box) return;
    var hb = d.heatbar || {}, names = hb.names || [], cells = hb.cells || [];
    var cols = (hb.weeks || []).length;
    box.style.gridTemplateColumns = '58px repeat(' + Math.max(1, cols) + ',1fr)';
    names.forEach(function (nm, i) {
      var l = document.createElement('div'); l.className = 'hl'; l.textContent = nm.slice(0, 6); box.appendChild(l);
      for (var w = 0; w < cols; w++) {
        var c = document.createElement('div'); c.className = 'hc';
        c.style.background = tempColor((cells[i] || [])[w]);
        c.title = nm + ' ' + (hb.weeks || [])[w] + '：' + T((cells[i] || [])[w]);
        box.appendChild(c);
      }
    });
  }

  /* ---------- 全行业热力图 ---------- */
  function renderHeat(d) {
    var tbl = clear('indTable'); if (!tbl) return;
    var h = d.heat || {}, names = h.names || [], dates = h.dates || [];
    var M = (hmode === 'chg' ? h.chg : h.bias) || [];
    var flat = []; M.forEach(function (r) { (r || []).forEach(function (v) { if (typeof v === 'number' && isFinite(v)) flat.push(Math.abs(v)); }); });
    var maxAbs = flat.length ? Math.max.apply(null, flat) : 2;
    var html = '<tr><th class="hdcell">行业</th>';
    dates.forEach(function (x) { html += '<th class="dt">' + esc(String(x).slice(5)) + '</th>'; });
    html += '</tr>';
    names.forEach(function (nm, i) {
      html += '<tr><td class="iname">' + esc(nm) + '</td>';
      dates.forEach(function (_, j) {
        var v = (M[i] || [])[j];
        var txt = (v === null || v === undefined || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1);
        html += '<td class="cell" style="background:' + heatColor(v, maxAbs) + ';color:' + (Math.abs(v || 0) > maxAbs * .55 ? '#fff' : '#F1F5F9') + '">' + txt + '</td>';
      });
      html += '</tr>';
    });
    tbl.innerHTML = html;
    var note = $('indHeatNote');
    if (note) note.textContent = names.length + ' 个东财行业板块全铺 · 列 = 最近 ' + dates.length + " 个交易日 · 格子填" +
      (hmode === 'chg' ? '当日涨跌幅 %' : '距 MA20 乖离率 %') + '；红深领涨、绿深领跌，缺数标「—」。';
  }

  function renderAll() {
    if (!D) return;
    renderMeta(D); renderRadar(D); renderCards(D); renderArea(D); renderHeatbar(D); renderHeat(D);
    if (window.WufuRange && !rngI) {
      rngI = WufuRange.mount('indRange', { onChange: function (x) { isel = x; if (D) renderArea(D); } });
      rngI.setLabels((((D.area || {})[String(years)] || {}).labels) || []);
    }
  }
  function fail() {
    ['indRadar', 'indArea'].forEach(function (id) { var s = $(id); if (s) { s.innerHTML = ''; s.appendChild(TX(180, 80, '暂无快照', 12, '#7C8DA1', 'middle')); } });
    var s = $('indSource'); if (s) s.textContent = '暂无快照 · 周五同步后自动出现';
    var c = clear('indCards'); if (c) c.innerHTML = '<div class="gempty">暂无快照</div>';
    var t = clear('indTable'); if (t) t.innerHTML = '';
    var hb = clear('indHeatbar'); if (hb) hb.innerHTML = '';
  }
  function load() {
    if (loaded) return; loaded = true;
    fetch('../industry-daily.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { D = d; renderAll(); })
      .catch(fail);
  }

  /* 展开才拉；切 5/10 年、切热力图模式 */
  var c2 = $('c2');
  if (c2) {
    var mo = new MutationObserver(function () { if (c2.classList.contains('open')) load(); });
    mo.observe(c2, { attributes: true, attributeFilter: ['class'] });
    if (c2.classList.contains('open')) load();
  }
  document.querySelectorAll('[data-seg] span[data-y]').forEach(function (s) {
    s.addEventListener('click', function () { years = +s.getAttribute('data-y'); isel = [0, 1]; if (rngI) rngI.reset(); if (D) renderArea(D); });
  });
  document.querySelectorAll('#indMode span[data-m]').forEach(function (s) {
    s.onclick = function () {
      hmode = s.getAttribute('data-m');
      document.querySelectorAll('#indMode span[data-m]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-m') === hmode); });
      if (D) renderHeat(D);
    };
  });
})();
