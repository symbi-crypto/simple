/* dashboard.js — 综合看板渲染器（v0.54）
   数据只来自同目录的 cb-daily.json / index-daily.json，缺数一律显示「—」，不写示意值。 */
(function () {
  'use strict';
  var wrap = document.getElementById('dashWrap');
  if (!wrap) return;
  var kind = wrap.getAttribute('data-kind') || 'cb';
  var url = wrap.getAttribute('data-json') || '../cb-daily.json';
  var D = null, years = 5, metric = 0, hmode = 'chg', distKey = '价格';
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
    multi($('cbTrend'), [
      { data: t.eq, color: '#F87171' }, { data: t.price, color: '#4FC3F7' },
      { data: t.prem, color: '#A78BFA' }, { data: t.amount, color: '#9FB0C3' }
    ], t.labels || []);
    var sn = $('cbSampleNote');
    if (sn) sn.textContent = years === 5 ? '样本 5 年' : (d.sampleNote || '样本 —');
  }

  /* ===================== 指数看板 ===================== */
  function renderIDX() {
    var d = D || {};
    var hd = document.querySelector('#c2 .hd span'); if (hd) hd.textContent = '指数基线 ' + T(d.dataAsOf);
    var sl = document.querySelector('#c2 .sumline');
    var tv = (d.turnover || {}).value;
    function findChg(name) {
      var A = (d.idx || {}).A || [];
      for (var i = 0; i < A.length; i++) if (A[i][0] === name) return A[i][1];
      return null;
    }
    var c3 = findChg('沪深300'), c2 = findChg('国证2000');
    function ch(v) { return typeof v === 'number' ? '<span class="' + cls(v) + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>' : '—'; }
    if (sl) sl.innerHTML = '两市成交额 <b>' + T(tv) + '</b><i>·</i>' + T((d.turnover || {}).note || '') +
      '<div class="sumsub">沪深300 ' + ch(c3) + ' · 国证2000 ' + ch(c2) + '（起点归一曲线见下方 A股行业宽度全景）</div>';
    renderIdxRows(d);
    renderCards(d);
    drawRadar(d); drawArea(d); drawIdxChart(d); drawHeatbar(d); drawTable(d);
    var sn = $('sampleNote'); if (sn) sn.textContent = d.sampleNote || '样本 —';
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
  function renderCards(d) {
    var g = CLR('mgrid');
    (d.metrics || []).forEach(function (m, i) {
      var e = document.createElement('div'); e.className = 'mcard' + (i === metric ? ' on' : '');
      e.innerHTML = '<div class="mn">' + T(m.name) + '</div><div class="mv">' + (m.val === null ? '—' : m.val) + '</div>';
      e.onclick = function () { metric = i; renderCards(d); drawArea(d); };
      g.appendChild(e);
    });
    var ph = document.createElement('div'); ph.className = 'mcard ph'; ph.textContent = '点卡片切换上方折线'; g.appendChild(ph);
  }
  function drawRadar(d) {
    var svg = $('radar'); if (!svg) return; svg.innerHTML = '';
    var cx = 180, cy = 104, R = 68, N = 7;
    var pt = function (i, f) { var a = -Math.PI / 2 + i * 2 * Math.PI / N; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f]; };
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var p = []; for (var i = 0; i < N; i++) p.push(pt(i, f).join(','));
      svg.appendChild(E('polygon', { points: p.join(' '), fill: 'none', stroke: '#2C3B4E', 'stroke-width': '1' }));
    });
    for (var i = 0; i < N; i++) svg.appendChild(E('line', { x1: cx, y1: cy, x2: pt(i, 1)[0], y2: pt(i, 1)[1], stroke: '#2C3B4E' }));
    var ms = d.metrics || [];
    ms.forEach(function (m, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / N;
      svg.appendChild(TX(cx + Math.cos(a) * (R + 14), cy + Math.sin(a) * (R + 14) + 3, m.short || '', 9, '#7C8DA1', 'middle'));
    });
    svg.appendChild(TX(180, 198, ms.length && ms[0].val === null ? '行业日线暂缺 · 七项显示 —' : '', 10, '#7C8DA1', 'middle'));
  }
  function drawArea(d) {
    var m = (d.metrics || [])[metric] || {};
    var at = $('areaTitle'); if (at) at.textContent = T(m.name) + (m.val === null ? ' · —' : ' · 当前 ' + m.val);
    var a = ((d.area || {})[String(years)] || {})[m.short || ''] || null;
    if (!a) { emptyChart('areaChart', '暂无行业日线快照'); return; }
    multi($('areaChart'), [{ data: a, color: '#4FC3F7' }], null);
  }
  function drawIdxChart(d) {
    var t = ((d.idxTrend || {})[String(years)] || {});
    var svg = $('idxChart'); if (!svg) return; svg.innerHTML = '';
    var s1 = t.hs300 || [], s2 = t.gz2000 || [], n = Math.max(s1.length, s2.length);
    if (!n) { emptyChart('idxChart', '暂无指数曲线'); return; }
    var Y = function (v) { return 12 + (150 - Math.max(55, Math.min(148, v))) / 90 * 124; };
    grid(svg, [60, 100, 140], Y, 34, 344);
    [60, 100, 140].forEach(function (v) { svg.appendChild(TX(2, Y(v) + 3, String(v), 9)); });
    [[s1, '#4FC3F7'], [s2, '#F87171']].forEach(function (p) {
      var pts = [];
      p[0].forEach(function (v, i) { if (v !== null && isFinite(v)) pts.push((34 + i * (310 / Math.max(1, p[0].length - 1))) + ',' + Y(v)); });
      if (pts.length > 1) svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: p[1], 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    });
    (t.labels || []).forEach(function (L, i) {
      var x = 34 + i * (310 / Math.max(1, t.labels.length - 1));
      svg.appendChild(TX(x, 146, L, 9, '#7C8DA1', i === 0 ? 'start' : (i === t.labels.length - 1 ? 'end' : 'middle')));
    });
    svg.appendChild(TX(344, 20, '两市成交额柱暂缺', 8.5, '#7C8DA1', 'end'));
  }
  function drawHeatbar(d) {
    var hb = CLR('heatbar'); if (!hb) return;
    var ms = d.metrics || [];
    ms.forEach(function (m) {
      var lab = document.createElement('div'); lab.className = 'hl'; lab.textContent = m.short || ''; hb.appendChild(lab);
      for (var i = 0; i < 24; i++) {
        var c = document.createElement('div'); c.className = 'hc';
        c.style.background = 'rgba(124,141,161,.18)'; c.title = '暂无快照';
        hb.appendChild(c);
      }
    });
  }
  function drawTable(d) {
    var t = $('indTable'); if (!t) return; t.innerHTML = '';
    var h = d.heat || {}, dates = h.dates || [], names = h.industries || [];
    if (!names.length) names = ['农林牧渔','基础化工','钢铁','有色金属','电子','汽车','家用电器','食品饮料','纺织服饰','轻工制造','医药生物','公用事业','交通运输','房地产','商贸零售','社会服务','综合','建筑材料','建筑装饰','电力设备','国防军工','计算机','传媒','通信','银行','非银金融','煤炭','石油石化','环保','美容护理','机械设备'];
    if (!dates.length) dates = ['—','—','—','—','—','—'];
    var thead = document.createElement('thead'), tr = document.createElement('tr');
    var h0 = document.createElement('th'); h0.className = 'hdcell'; h0.textContent = '行业/日期'; tr.appendChild(h0);
    dates.forEach(function (x) { var th = document.createElement('th'); th.className = 'dt'; th.textContent = x; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = document.createElement('tbody');
    names.forEach(function (nm) {
      var r = document.createElement('tr'), td0 = document.createElement('td');
      td0.className = 'iname'; td0.textContent = nm; r.appendChild(td0);
      dates.forEach(function () { var td = document.createElement('td'); td.className = 'cell'; td.textContent = '—'; r.appendChild(td); });
      tb.appendChild(r);
    });
    t.appendChild(tb);
  }

  /* ===================== 交互 ===================== */
  function applyYears() {
    document.querySelectorAll('[data-seg] span[data-y]').forEach(function (s) { s.classList.toggle('on', +s.getAttribute('data-y') === years); });
    document.querySelectorAll('#cbBottom .row[data-a]').forEach(function (r) {
      var p = years === 5 ? r.getAttribute('data-a') : r.getAttribute('data-b');
      var pct = r.querySelector('.pct'), fill = r.querySelector('.fill'), dot = r.querySelector('.dot');
      if (pct) pct.textContent = (p === '' || p === null ? '—' : p + '% 分位');
      if (fill) fill.style.width = (p === '' || p === null ? 0 : p) + '%';
      if (dot) dot.style.left = (p === '' || p === null ? 0 : p) + '%';
    });
    if (D) { if (kind === 'cb') drawCbTrend(D); else { renderIdxRows(D); drawArea(D); drawIdxChart(D); } }
  }
  document.querySelectorAll('[data-seg] span[data-y]').forEach(function (s) {
    s.onclick = function () { years = +s.getAttribute('data-y'); applyYears(); };
  });
  document.querySelectorAll('#hseg span[data-m]').forEach(function (s) {
    s.onclick = function () {
      hmode = s.getAttribute('data-m');
      document.querySelectorAll('#hseg span[data-m]').forEach(function (z) { z.classList.toggle('on', z === s); });
      if (D) drawTable(D);
    };
  });
  function boot() {
    if (D) { if (kind === 'cb') renderCB(); else renderIDX(); }
    applyYears();
  }
  function fail() {
    var strip = document.querySelector('#c1 .strip') || document.querySelector('#c2 .sumline');
    if (strip) strip.innerHTML = '暂无快照 · 数据文件尚未生成（周五同步后自动出现）';
    boot();
  }
  fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { D = d; boot(); })
    .catch(fail);
})();
