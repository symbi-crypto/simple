/* range.js — 统一「白色透明时间段选择条」+ 曲线点击探针（v0.65）
   v0.65：① 样式自注入，主文档（tool.html）无需引 dashboard.css 也能用同款条；
          ② 手柄日期标签固定两端，不再叠在一起；③ 支持初始选区 / set / tip；
          ④ 新增 WufuRange.probe()：点曲线显示当日日期与各线数值（十字线 + 圆点 + 浮层）；
          ⑤ 新增 WufuRange.bindZoom()：把条绑到 ECharts 的 dataZoom，替换各图自带的 slider。
   纯原生实现，只回报归一化区间 [a,b]，不碰数据。 */
(function () {
  'use strict';
  var R = {};

  var CSS = [
    '.wr-host{margin:6px 2px 4px}',
    '.wr{position:relative;height:46px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer}',
    '.wr-track{position:absolute;left:0;right:0;top:8px;height:16px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12)}',
    '.wr-sel{position:absolute;top:8px;height:16px;border-radius:6px;background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.55);box-shadow:inset 0 0 8px rgba(255,255,255,.12)}',
    '.wr-h{position:absolute;top:4px;width:12px;height:24px;border-radius:4px;background:rgba(255,255,255,.88);border:1px solid #E6F4FF;box-shadow:0 0 0 2px rgba(14,116,144,.45);z-index:2}',
    '.wr-h::after{content:\'\';position:absolute;left:4px;top:7px;width:2px;height:10px;background:#0E7490;border-radius:1px}',
    '.wr-lab{position:absolute;top:30px;font-size:9px;color:#9FB0C3;white-space:nowrap}',
    '.wr-lab-l{left:0;transform:none}',
    '.wr-lab-r{right:0;left:auto;transform:none;text-align:right}',
    '.wr-tip{font-size:9.5px;color:#7C8DA1;margin:2px 2px 0;text-align:right}',
    '.wr-info{font-size:9.5px;color:#9FB0C3;line-height:1.6;margin:2px 2px 6px;word-break:break-all}',
    '.wr-info b{color:#4FC3F7;font-weight:600}',
    '.wr-host svg{cursor:crosshair}'
  ].join('\n');

  function ensureStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('__wrStyle')) return;
    var st = document.createElement('style');
    st.id = '__wrStyle'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  R.ensureStyle = ensureStyle;

  /* ---------------- 时间段选择条 ---------------- */
  R.mount = function (hostId, opts) {
    var host = document.getElementById(hostId);
    if (!host) return null;
    opts = opts || {};
    ensureStyle();
    if ((' ' + host.className + ' ').indexOf(' wr-host ') < 0) host.className = (host.className || '') + ' wr-host';
    host.innerHTML =
      (opts.tip ? '<div class="wr-tip">' + opts.tip + '</div>' : '') +
      '<div class="wr" data-wr>' +
      '  <div class="wr-track"></div>' +
      '  <div class="wr-sel"></div>' +
      '  <div class="wr-h wr-l" data-h="l"></div>' +
      '  <div class="wr-h wr-r" data-h="r"></div>' +
      '  <div class="wr-lab wr-lab-l"></div>' +
      '  <div class="wr-lab wr-lab-r"></div>' +
      '</div>';
    var box = host.querySelector('[data-wr]'),
        selEl = box.querySelector('.wr-sel'),
        hl = box.querySelector('.wr-l'),
        hr = box.querySelector('.wr-r'),
        labL = box.querySelector('.wr-lab-l'),
        labR = box.querySelector('.wr-lab-r');
    var a = 0, b = 1, labels = null, drag = null, tid = null;
    if (opts.value && opts.value.length === 2) {
      a = clamp(+opts.value[0]); b = clamp(+opts.value[1]);
      if (b - a < 0.02) { a = 0; b = 1; }
    }

    function clamp(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
    function pct(x) { return (x * 100).toFixed(2) + '%'; }
    function labAt(x) {
      if (!labels || !labels.length) return '';
      return String(labels[Math.round(x * (labels.length - 1))] || '');
    }
    function paint() {
      selEl.style.left = pct(a);
      selEl.style.width = pct(b - a);
      hl.style.left = 'calc(' + pct(a) + ' - 6px)';
      hr.style.left = 'calc(' + pct(b) + ' - 6px)';
      /* v0.65：日期固定在条的两端，手柄挨得再近也不会叠字 */
      labL.textContent = labAt(a);
      labR.textContent = labAt(b);
      if (labL.textContent === labR.textContent) labR.textContent = '';
    }
    function fire() {
      if (tid) return;
      tid = requestAnimationFrame(function () {
        tid = null;
        if (typeof opts.onChange === 'function') opts.onChange([a, b]);
      });
    }
    function pos(ev) {
      var r = box.getBoundingClientRect();
      return clamp((ev.clientX - r.left) / Math.max(1, r.width));
    }
    function down(ev) {
      var h = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-h');
      if (h === 'l') drag = 'l';
      else if (h === 'r') drag = 'r';
      else {
        var x = pos(ev);
        if (b - a >= 0.98) {
          /* v0.63 · 全段时按下点即区间起点，拖到哪算到哪 */
          a = Math.max(0, Math.min(x, 0.96)); b = Math.min(1, a + 0.02); drag = 'r';
          paint(); fire();
        } else if (ev.target === selEl) drag = 'move';
        else {
          drag = (Math.abs(x - a) < Math.abs(x - b)) ? 'l' : 'r';
          if (drag === 'l') a = Math.min(x, b - 0.02); else b = Math.max(x, a + 0.02);
          paint(); fire();
        }
      }
      try { box.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    }
    function move(ev) {
      if (!drag) return;
      var x = pos(ev);
      if (drag === 'l') a = Math.min(x, b - 0.02);
      else if (drag === 'r') b = Math.max(x, a + 0.02);
      else {
        var w = b - a, na = clamp(x - w / 2);
        if (na + w > 1) na = 1 - w;
        a = na; b = na + w;
      }
      a = clamp(a); b = clamp(b);
      if (b - a < 0.02) { if (drag === 'l') a = b - 0.02; else b = a + 0.02; }
      paint(); fire();
      ev.preventDefault();
    }
    function up(ev) {
      drag = null;
      try { box.releasePointerCapture(ev.pointerId); } catch (e) {}
    }
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    /* 双击整条 = 还原全区间 */
    box.addEventListener('dblclick', function () { a = 0; b = 1; paint(); fire(); });
    paint();

    return {
      setLabels: function (ls) { labels = ls || null; paint(); },
      set: function (x, noFire) {
        if (!x || x.length !== 2) return;
        a = clamp(+x[0]); b = clamp(+x[1]);
        if (b - a < 0.02) { a = 0; b = 1; }
        paint(); if (!noFire) fire();
      },
      reset: function () { a = 0; b = 1; paint(); },
      get: function () { return [a, b]; },
      fire: fire
    };
  };

  /* 按区间切一段序列（保留首末）；labels 与序列同长时用同一区间 */
  R.slice = function (arr, sel) {
    if (!arr || !arr.length) return arr || [];
    if (!sel) return arr;
    var n = arr.length, i0 = Math.round(sel[0] * (n - 1)), i1 = Math.round(sel[1] * (n - 1));
    if (i1 - i0 < 1) { i0 = 0; i1 = n - 1; }
    return arr.slice(i0, i1 + 1);
  };

  /* v0.63 · 区间重定基：以选中段第一个有效值为 100，各条线各归各的。
     数据本身已是周频（每周一个点），slice 的 round 就是吸附到周点。 */
  R.rebase = function (arr, sel) {
    var s = R.slice(arr, sel), base = null, last = null;
    for (var i = 0; i < s.length; i++) {
      if (typeof s[i] === 'number' && isFinite(s[i]) && s[i] > 0) {
        if (base === null) base = s[i];
        last = s[i];
      }
    }
    if (base === null) return { data: s, base: null, ret: null };
    var data = s.map(function (v) {
      return (typeof v === 'number' && isFinite(v) && v > 0) ? +(100 * v / base).toFixed(2) : null;
    });
    return { data: data, base: base, ret: last == null ? null : +((last / base - 1) * 100).toFixed(2) };
  };
  /* 选中区间的起止日期（与 slice 用同一取法） */
  R.info = function (labels, sel) {
    if (!labels || !labels.length) return { from: '', to: '', i0: 0, i1: 0 };
    var n = labels.length, a = sel ? sel[0] : 0, b = sel ? sel[1] : 1;
    var i0 = Math.round(a * (n - 1)), i1 = Math.round(b * (n - 1));
    if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
    return { from: String(labels[i0] || ''), to: String(labels[i1] || ''), i0: i0, i1: i1 };
  };
  R.isFull = function (sel) { return !sel || (sel[0] <= 0.0001 && sel[1] >= 0.9999); };

  /* 年份刻度：labels 形如 YYYY-MM / YYYY-MM-DD，每年只保留第一次出现的那个 */
  R.yearTicks = function (labels) {
    var out = [], last = null;
    (labels || []).forEach(function (L, i) {
      var y = String(L).slice(0, 4);
      if (y && y !== last) { out.push({ i: i, text: y }); last = y; }
    });
    return out;
  };

  /* ---------------- 曲线点击探针（v0.65） ----------------
     点/按一下曲线：竖十字线 + 各线圆点 + 浮层（当日日期 + 当日各线数值）。
     cfg = { labels:[], xAt(i), yAt(v), series:[{name,color,data,fmt}], y0,y1,boxW,boxY,note } */
  var NS = 'http://www.w3.org/2000/svg';
  function E(tag, a) { var n = document.createElementNS(NS, tag); for (var k in a) n.setAttribute(k, a[k]); return n; }
  function TXT(x, y, s, size, color, weight) {
    var t = E('text', { x: x, y: y, 'font-size': size, fill: color || '#D8E2EF',
      'font-family': 'sans-serif', 'pointer-events': 'none' });
    if (weight) t.setAttribute('font-weight', weight);
    t.textContent = s; return t;
  }
  var activeProbe = null;
  function hide(st) {
    if (st && st.g && st.g.parentNode) st.g.parentNode.removeChild(st.g);
    if (st) st.g = null;
  }
  R.probe = function (svg, cfg) {
    if (!svg || !cfg) return null;
    ensureStyle();
    if (!svg.__wrProbe) {
      var st = { svg: svg, cfg: null, g: null, hide: function () { hide(st); } };
      svg.__wrProbe = st;
      svg.addEventListener('pointerdown', function (ev) {
        var c = st.cfg;
        if (!c || !c.labels || !c.labels.length) return;
        var vb = svg.viewBox && svg.viewBox.baseVal;
        var W = (vb && vb.width) || c.vbW || 360;
        var rect = svg.getBoundingClientRect();
        var vx = (ev.clientX - rect.left) / Math.max(1, rect.width) * W;
        var n = c.labels.length;
        var i = Math.round((vx - 34) / 310 * (n - 1));
        if (!isFinite(i)) i = 0;
        if (i < 0) i = 0; if (i > n - 1) i = n - 1;
        var x = c.xAt ? c.xAt(i) : (34 + i * (310 / Math.max(1, n - 1)));
        var y0 = c.y0 == null ? 8 : c.y0, y1 = c.y1 == null ? 150 : c.y1;
        hide(st);
        var g = E('g', { 'data-probe': '1', 'pointer-events': 'none' });
        st.g = g; svg.appendChild(g);
        g.appendChild(E('line', { x1: x, y1: y0, x2: x, y2: y1,
          stroke: '#4FC3F7', 'stroke-width': '1', 'stroke-dasharray': '4 3', opacity: '.85' }));
        var rows = [];
        (c.series || []).forEach(function (s) {
          var v = (typeof s.data === 'function') ? s.data(i) : (s.data || [])[i];
          var ok = (typeof v === 'number' && isFinite(v));
          if (ok && c.yAt) {
            g.appendChild(E('circle', { cx: x, cy: c.yAt(v), r: 2.8,
              fill: s.color || '#4FC3F7', stroke: '#0E7490', 'stroke-width': '1' }));
          }
          var txt = !ok ? '—' : (s.fmt ? s.fmt(v) : (typeof v === 'number' ? v.toFixed(2) : String(v)));
          rows.push({ name: s.name || '', color: s.color || '#9FB0C3', text: txt });
        });
        var lines = 1 + rows.length + (c.note ? 1 : 0);
        var bw = c.boxW || 152, bh = 9 + lines * 13 + 5;
        var bx = (x > W - bw - 44) ? (x - bw - 8) : (x + 8);
        if (bx < 2) bx = 2; if (bx + bw > W - 2) bx = W - bw - 2;
        var by = c.boxY == null ? 5 : c.boxY;
        g.appendChild(E('rect', { x: bx, y: by, width: bw, height: bh, rx: 6,
          fill: 'rgba(16,24,36,.95)', stroke: '#3E4E63', 'stroke-width': '1' }));
        g.appendChild(TXT(bx + 8, by + 15, String(c.labels[i] || ''), 10, '#F1F5F9', '600'));
        rows.forEach(function (r, j) {
          var yy = by + 15 + 13 * (j + 1);
          g.appendChild(E('circle', { cx: bx + 11, cy: yy - 3, r: 2.4, fill: r.color }));
          g.appendChild(TXT(bx + 18, yy, r.name + ' ' + r.text, 9, '#D8E2EF'));
        });
        if (c.note) g.appendChild(TXT(bx + 8, by + 15 + 13 * (rows.length + 1), c.note, 8, '#7C8DA1'));
        activeProbe = st;
      });
    }
    /* 曲线重绘时 innerHTML 被清空，旧的 g 随之消失；只更新配置即可 */
    svg.__wrProbe.cfg = cfg;
    svg.__wrProbe.g = null;
    return svg.__wrProbe;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', function (ev) {
      if (activeProbe && activeProbe.svg && !activeProbe.svg.contains(ev.target)) {
        hide(activeProbe); activeProbe = null;
      }
    }, true);
  }

  /* ECharts 通用浮层：当日日期 + 当日各条曲线的数值（v0.65） */
  R.tipFormatter = function (ps, fmt) {
    ps = (ps && typeof ps.length === 'number') ? [].concat(ps) : [ps];
    if (!ps.length || !ps[0]) return '';
    var ax = ps[0].axisValue != null ? ps[0].axisValue : (ps[0].name || '');
    var head;
    if (typeof ax === 'number' && ax > 1e12) {
      var d = new Date(ax), p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
      head = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    } else head = String(ax);
    var html = '<div style="font-weight:600;margin-bottom:3px">' + head + '</div>';
    ps.forEach(function (x) {
      if (!x) return;
      var v = x.value;
      if (Object.prototype.toString.call(v) === '[object Array]') v = v[1];
      var txt;
      if (fmt) txt = fmt(v, x);
      else if (typeof v === 'number' && isFinite(v)) {
        txt = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US')
            : (Math.abs(v) < 1 && v !== 0 ? v.toFixed(4) : v.toFixed(2));
      } else txt = (v == null ? '—' : String(v));
      if (x.seriesName) html += '<div>' + (x.marker || '') + x.seriesName + ' <b>' + txt + '</b></div>';
    });
    return html;
  };

  /* ---------------- 绑定 ECharts（v0.65） ----------------
     用同款白条替换各 ECharts 图自带的 slider；onChange 驱动 dataZoom。 */
  R.bindZoom = function (hostId, chartId, opts) {
    opts = opts || {};
    var el = document.getElementById(chartId);
    if (!el || !window.echarts || !echarts.getInstanceByDom) return null;
    var ch = echarts.getInstanceByDom(el);
    if (!ch) return null;
    var rng = R.mount(hostId, {
      value: opts.value || [0, 1], tip: opts.tip,
      onChange: function (x) {
        ch.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: x[0] * 100, end: x[1] * 100 });
        if (opts.onChange) opts.onChange(x);
      }
    });
    if (!rng) return null;
    if (opts.labels) rng.setLabels(opts.labels);
    if (opts.value) ch.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: opts.value[0] * 100, end: opts.value[1] * 100 });
    return rng;
  };

  window.WufuRange = R;
})();
