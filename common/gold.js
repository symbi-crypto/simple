/* gold.js — 黄金看板渲染器（v0.59 / v0.83 取数改造）
   取数走 common/dash-source.js（远端优先 + 包内副本兜底），缺数显示「—」，绝不写示意值。
   本版按用户要求不含「相对强弱 / 20 日动量」区块。 */
(function () {
  'use strict';
  var wrap = document.getElementById('goldWrap');
  if (!wrap) return;
  var loadJSON = (window.WufuDash && WufuDash.load) ? WufuDash.load
    : function (u, ok, ko) {
        fetch(u, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(ok).catch(ko);
      };
  var badgeOf = (window.WufuDash && WufuDash.badge) ? WufuDash.badge : function () { return ''; };
  var NS = 'http://www.w3.org/2000/svg';
  var D = null, years = 5, mode = 'price';
  var gsel = [0, 1], rngG = null, quickG = null;
  function SL(a) { return window.WufuRange ? WufuRange.slice(a, gsel) : a; }

  function $(id) { return document.getElementById(id); }
  function E(tag, a) { var n = document.createElementNS(NS, tag); for (var k in a) n.setAttribute(k, a[k]); return n; }
  function TX(x, y, s, size, color, anchor) {
    var t = E('text', { x: x, y: y, 'font-size': size, fill: color || WufuTheme.sub('§WFT0002§'), 'font-family': 'sans-serif' });
    if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t;
  }
  function T(v) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '—' : String(v); }
  function num(v, dp) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmt(v, dp) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return v >= 10000 ? num(v, 0) : (v >= 100 ? num(v, dp === undefined ? 2 : dp) : num(v, dp === undefined ? 3 : dp));
  }
  function chgHtml(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '<span class="d">—</span>';
    return '<span class="' + (v > 0 ? 'u' : 'd') + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  window.tg = function (id) { var c = $(id); if (c) c.classList.toggle('open'); };

  /* ---------- 常显 ---------- */
  function renderSum(d) {
    var k = {}; (d.kpi || []).forEach(function (x) { k[x.label] = x; });
    function v(label) { return k[label] ? fmt(k[label].value, label === 'COMEX铜' ? 4 : 2) : '—'; }
    function c(label) { return k[label] ? chgHtml(k[label].chg) : '—'; }
    var r = d.ratios || {}, sh = d.shGold || {};
    $('gSum').innerHTML =
      '国际金 <b>' + v('国际金') + '</b> ' + c('国际金') + '<i>·</i>国际银 <b>' + v('国际银') + '</b> ' + c('国际银') + '<br>' +
      'WTI <b>' + v('WTI原油') + '</b><i>·</i>铜 <b>' + v('COMEX铜') + '</b><i>·</i>BTC <b>' + v('比特币') + '</b><br>' +
      '<span class="sm">金银比 <b>' + (r['金银比'] == null ? '—' : r['金银比']) + '</b><i>·</i>金油比 <b>' + (r['金油比'] == null ? '—' : r['金油比']) +
      '</b><i>·</i>金铜比 <b>' + (r['金铜比'] == null ? '—' : r['金铜比']) + '</b><i>·</i>GVZ <b>' + v('黄金波动 GVZ') + '</b></span><br>' +
      '<span class="sm">' + (sh.value == null
        ? '上海金 暂无数据 · 不参与比价</span>'
        : '上海金 <b>' + fmt(sh.value, 2) + '</b> 元/克 ' + chgHtml(sh.chg) + ' · 人民币对照</span>');
    var hd = document.querySelector('#g1 .hd span');
    if (hd) hd.textContent = '最新交易日 ' + T(d.dataAsOf) + badgeOf(d);
  }

  /* ---------- 六卡 ---------- */
  function renderKpi(d) {
    var box = $('gKpi'); if (!box) return; box.innerHTML = '';
    (d.kpi || []).forEach(function (k) {
      var p = years === 5 ? k.p5 : k.p10;
      var e = document.createElement('div'); e.className = 'kc';
      e.innerHTML = '<div class="kt">' + esc(k.label) + '</div>' +
        '<div class="kv gkv">' + (k.ok ? fmt(k.value, k.label === 'COMEX铜' ? 4 : 2) : '—') +
        ' <small>' + esc(k.unit || '') + '</small> <small style="font-weight:600;color:var(' + (k.chg > 0 ? '--up' : '--down') + ')">' +
        (k.chg == null ? '—' : (k.chg > 0 ? '+' : '') + k.chg.toFixed(2) + '%') + '</small></div>' +
        '<div class="ks">' + years + '年分位 ' + (p == null ? '—' : p + '%') + '</div>';
      box.appendChild(e);
    });
  }

  /* ---------- 多线共用画布 ---------- */
  function drawMulti(id, specs, labels) {
    var svg = $(id); if (!svg) return []; svg.innerHTML = '';
    var arr = [], n = 0, rets = [];
    specs.forEach(function (s) {
      var rb = window.WufuRange ? WufuRange.rebase(s.data || [], gsel) : { data: SL(s.data || []), ret: null };
      rets.push({ name: s.name || '', ret: rb.ret });
      s.__full = rb.data;                       /* v0.65：与 labels 同长，供点击探针取值 */
      var a = rb.data.filter(function (x) { return typeof x === 'number' && isFinite(x); });
      arr.push(a); if (a.length > n) n = a.length;
    });
    var LB = SL(labels || []);
    if (!n) { svg.appendChild(TX(180, 80, '暂无快照', 12, WufuTheme.sub('§WFT0002§'), 'middle')); return rets; }
    var all = []; arr.forEach(function (a) { all = all.concat(a); });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (!isFinite(lo) || !isFinite(hi) || hi === lo) { lo = 90; hi = 110; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var X = function (i, len) { return 34 + i * (310 / Math.max(1, len - 1)); };
    var Y = function (v) { return 12 + (hi - v) / (hi - lo) * 120; };
    [0.25, 0.5, 0.75].forEach(function (q) {
      var gv = lo + (hi - lo) * q;
      svg.appendChild(E('line', { x1: 34, y1: Y(gv), x2: 344, y2: Y(gv), stroke: WufuTheme.sub('§WFT0048§'), 'stroke-width': '1' }));
      svg.appendChild(TX(31, Y(gv) + 3, Math.round(gv), 9, WufuTheme.sub('§WFT0002§'), 'end'));
    });
    if (lo <= 100 && hi >= 100) {
      svg.appendChild(E('line', { x1: 34, y1: Y(100), x2: 344, y2: Y(100), stroke: WufuTheme.sub('§WFT0006§'), 'stroke-width': '1', 'stroke-dasharray': '4 3', opacity: '.45' }));
    }
    specs.forEach(function (s, j) {
      var full = s.__full || arr[j], pts = [];
      for (var i = 0; i < full.length; i++) {
        if (typeof full[i] !== 'number' || !isFinite(full[i])) continue;
        pts.push(X(i, full.length).toFixed(1) + ',' + Y(full[i]).toFixed(1));
      }
      if (pts.length > 1) svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    });
    /* 每年只显示一个年份，避免 61/121 个月标签叠在一起 */
    var ticks = window.WufuRange ? WufuRange.yearTicks(LB) : [];
    ticks.forEach(function (k) {
      var x = 34 + k.i * (310 / Math.max(1, LB.length - 1));
      var anchor = k.i === 0 ? 'start' : (k.i >= LB.length - 2 ? 'end' : 'middle');
      svg.appendChild(TX(x, 148, k.text, 9, WufuTheme.sub('§WFT0002§'), anchor));
    });
    /* v0.65：点曲线 → 当日日期 + 各资产归一值 */
    if (window.WufuRange) WufuRange.probe(svg, {
      labels: LB, vbW: 360, y0: 8, y1: 140,
      xAt: function (i) { return 34 + i * (310 / Math.max(1, LB.length - 1)); },
      yAt: Y,
      series: specs.map(function (s) { return { name: s.name || '', color: s.color, data: s.__full || [],
        fmt: function (v) { return v.toFixed(1); } }; }),
      note: '起点=100 · 归一值'
    });
    return rets;
  }

  function writeRangeInfo(rets) {
    var ri = $('gRangeInfo');
    if (!ri || !window.WufuRange) return;
    var t = (D && (D.trend || {})[String(years)]) || {};
    var inf = WufuRange.info(t.labels || [], gsel);
    if (WufuRange.isFull(gsel)) {
      ri.textContent = '拖动下方时间条，以所选区间开头为起点重算收益 · 各线各自归一 100 · 周频';
      return;
    }
    var bits = rets.filter(function (x) { return x.ret !== null; }).map(function (x) {
      return x.name + ' ' + (x.ret >= 0 ? '+' : '') + x.ret.toFixed(1) + '%';
    });
    ri.innerHTML = '<b>' + inf.from + ' → ' + inf.to + '</b> · 起点=100 · ' + bits.join(' / ') +
      '<br>GVZ 是指数点位，只裁区间、不重定基；分位仍是全历史口径。';
  }

  function renderMain(d) {
    var t = (d.trend || {})[String(years)] || {};
    var lg = '';
    if (mode === 'price') {
      var order = ['GC=F', 'SI=F', 'CL=F', 'HG=F', 'BTC-USD'];
      var names = { 'GC=F': '国际金', 'SI=F': '国际银', 'CL=F': 'WTI原油', 'HG=F': 'COMEX铜', 'BTC-USD': '比特币' };
      var specs = [];
      order.forEach(function (s) {
        var k = (d.kpi || []).filter(function (x) { return x.label === names[s]; })[0];
        specs.push({ data: (t.price || {})[s] || [], color: k ? k.color : WufuTheme.sub('§WFT0003§'), name: names[s] });
        lg += '<span><i style="background:' + (k ? k.color : WufuTheme.sub('§WFT0003§')) + '"></i>' + names[s] + '</span>';
      });
      var rets = drawMulti('gMain', specs, t.labels || []);
      $('gTitle').textContent = '五资产价格';
      writeRangeInfo(rets);
    } else {
      var rk = ['金银比', '金油比', '金铜比'], cs = d.ratioColors || {}, sp = [];
      rk.forEach(function (r) { sp.push({ data: (t.ratio || {})[r] || [], color: cs[r] || WufuTheme.sub('§WFT0006§'), name: r }); lg += '<span><i style="background:' + (cs[r] || WufuTheme.sub('§WFT0006§')) + '"></i>' + r + '</span>'; });
      var rets = drawMulti('gMain', sp, t.labels || []);
      $('gTitle').textContent = '三项比价';
      writeRangeInfo(rets);
    }
    $('gLegend').innerHTML = lg;
    $('gSample').textContent = (mode === 'price' ? '五资产起点归一 100' : '三项比价起点归一 100') + ' · ' + years + '年 · ' + (d.sampleNote || '');
    if (rngG) rngG.setLabels(t.labels || []);
  }

  function renderGvz(d) {
    var svg = $('gGvz'); if (!svg) return; svg.innerHTML = '';
    var a = SL(((d.trend || {})[String(years)] || {}).gvz || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (a.length < 2) { svg.appendChild(TX(180, 50, '暂无快照', 12, WufuTheme.sub('§WFT0002§'), 'middle')); return; }
    var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a), pad = (hi - lo) * 0.12 || 1;
    lo -= pad; hi += pad;
    var X = function (i) { return 34 + i * (310 / (a.length - 1)); };
    var Y = function (v) { return 8 + (hi - v) / (hi - lo) * 68; };
    var pts = [], area = 'M 34,76';
    for (var i = 0; i < a.length; i++) { var px = X(i).toFixed(1), py = Y(a[i]).toFixed(1); pts.push(px + ',' + py); area += ' L ' + px + ',' + py; }
    area += ' L 344,76 Z';
    var defs = E('defs', {});
    var lg = E('linearGradient', { id: 'gvzgrad', x1: '0', y1: '0', x2: '0', y2: '1' });
    lg.appendChild(E('stop', { offset: '0%', 'stop-color': WufuTheme.sub('§WFT0011§'), 'stop-opacity': '.45' }));
    lg.appendChild(E('stop', { offset: '100%', 'stop-color': WufuTheme.sub('§WFT0011§'), 'stop-opacity': '0' }));
    defs.appendChild(lg); svg.appendChild(defs);
    svg.appendChild(E('path', { d: area, fill: 'url(#gvzgrad)' }));
    svg.appendChild(E('polyline', { points: pts.join(' '), fill: 'none', stroke: WufuTheme.sub('§WFT0011§'), 'stroke-width': '1.6' }));
    var avg = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
    svg.appendChild(E('line', { x1: 34, y1: Y(avg), x2: 344, y2: Y(avg), stroke: WufuTheme.sub('§WFT0003§'), 'stroke-width': '1', 'stroke-dasharray': '4 3' }));
    svg.appendChild(TX(31, Y(hi) + 6, Math.round(hi), 9, WufuTheme.sub('§WFT0002§'), 'end'));
    svg.appendChild(TX(31, Y(lo) + 2, Math.round(lo), 9, WufuTheme.sub('§WFT0002§'), 'end'));
    svg.appendChild(TX(344, 90, '均值虚线', 8.5, WufuTheme.sub('§WFT0002§'), 'end'));
    /* v0.65：点 GVZ 曲线 → 当日日期 + 点位 */
    var gL = SL(((d.trend || {})[String(years)] || {}).labels || []);
    var gV = SL(((d.trend || {})[String(years)] || {}).gvz || []);
    if (window.WufuRange) WufuRange.probe(svg, {
      labels: gL, vbW: 360, y0: 6, y1: 80, boxW: 132, boxY: 4,
      xAt: function (i) { return 34 + i * (310 / Math.max(1, gL.length - 1)); },
      yAt: Y,
      series: [{ name: 'GVZ', color: WufuTheme.sub('§WFT0011§'), data: gV, fmt: function (v) { return v.toFixed(2); } }],
      note: '指数点位 · 不重定基'
    });
  }

  function renderPos(d) {
    var box = $('gPos'); if (!box) return; box.innerHTML = '';
    (d.pos || []).forEach(function (p) {
      var v = years === 5 ? p.p5 : p.p10;
      var e = document.createElement('div'); e.className = 'row';
      e.innerHTML = '<div class="lb"><span>' + esc(p.name) + '</span><em>' + (v == null ? '—' : v + '% 分位') + '</em></div>' +
        '<div class="track"><div class="fill" style="width:' + (v == null ? 0 : v) + '%"></div><div class="dot" style="left:' + (v == null ? 0 : v) + '%"></div></div>';
      box.appendChild(e);
    });
    $('gPosNote').textContent = '近 ' + years + ' 年';
  }

  function renderAll() {
    if (!D) return;
    renderSum(D); renderKpi(D); renderMain(D); renderGvz(D); renderPos(D);
    if (window.WufuRange && !rngG) {
      rngG = WufuRange.mount('gRange', { onChange: function (x) { gsel = x; if (quickG) quickG.mark(x); if (D) { renderMain(D); renderGvz(D); } } });
      rngG.setLabels((((D.trend || {})[String(years)] || {}).labels) || []);
      /* v0.69b：同款「展示区间」控件 */
      /* v0.69d：旧缓存 range.js 没有 quick，先判存在，避免 TypeError 或 null.paint() */
      if (!quickG && window.WufuRange && typeof WufuRange.quick === 'function')
        quickG = WufuRange.quick({ anchorId: 'gRangeInfo',
          labels: function () { return (((D.trend || {})[String(years)] || {}).labels) || []; },
          get: function () { return gsel; },
          set: function (x) { gsel = x; if (rngG) rngG.set(x, true); renderMain(D); renderGvz(D); } });
      else if (quickG) quickG.paint();
    }
  }
  function fail() {
    $('gSum').innerHTML = '暂无快照 · 周五同步后自动出现';
    ['gKpi', 'gPos'].forEach(function (id) { var e = $(id); if (e) e.innerHTML = '<div class="gempty">暂无快照</div>'; });
    ['gMain', 'gGvz'].forEach(function (id) { var s = $(id); if (s) { s.innerHTML = ''; s.appendChild(TX(180, 80, '暂无快照', 12, WufuTheme.sub('§WFT0002§'), 'middle')); } });
    $('gSample').textContent = '—';
  }

  document.querySelectorAll('[data-gseg] span[data-y]').forEach(function (s) {
    s.onclick = function () {
      years = +s.getAttribute('data-y'); gsel = [0, 1]; if (rngG) rngG.reset(); if (quickG) quickG.mark([0, 1]);
      document.querySelectorAll('[data-gseg] span[data-y]').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-y') === years); });
      renderAll();
    };
  });
  document.querySelectorAll('[data-mseg] span[data-m]').forEach(function (s) {
    s.onclick = function () {
      mode = s.getAttribute('data-m'); gsel = [0, 1]; if (rngG) rngG.reset(); if (quickG) quickG.mark([0, 1]);
      document.querySelectorAll('[data-mseg] span[data-m]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-m') === mode); });
      if (D) renderMain(D);
    };
  });

  loadJSON(wrap.getAttribute('data-json') || '../gold-daily.json',
    function (d) { D = d; renderAll(); }, fail);

  /* v0.89 / P3：回前台重取一次（renderAll 幂等；失败沿用上次真值） */
  if (window.WufuDash && window.WufuDash.onRefresh) {
    var gurl = wrap.getAttribute('data-json') || '../gold-daily.json';
    window.WufuDash.onRefresh(gurl, function () {
      loadJSON(gurl, function (d) { D = d; renderAll(); }, function () { });
    });
  }
})();
