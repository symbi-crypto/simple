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
    '.wr-host svg{cursor:crosshair}',
    /* v0.69b：看板曲线同款「展示区间」控件 */
    '.wr-quick{margin:2px 2px 10px;display:flex;flex-direction:column;gap:8px}',
    '.wr-quick-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.wr-quick-lab{font-size:11px;color:#9FB0C3;white-space:nowrap}',
    '.wr-quick-sep{font-size:11px;color:#7C8DA1}',
    '.wr-quick input[type=date]{background:#202E3F;color:#D8E6F2;border:1px solid #33465C;border-radius:6px;font-size:11px;padding:3px 6px;min-width:0;flex:1 1 108px;color-scheme:dark}',
    '.wr-quick-btns{display:flex;flex-wrap:wrap;gap:6px}',
    '.wr-quick-btns button{cursor:pointer;font-size:11px;padding:4px 10px;border-radius:6px;background:#202E3F;color:#9FB0C3;border:1px solid #33465C;white-space:nowrap}',
    '.wr-quick-btns button.on{background:rgba(79,195,247,.16);color:#4FC3F7;border:1px solid #4FC3F7}',
  /* v0.71：锁定控件高度，按按钮时说明文字/日期框/卡片数变化不再推动整页 */
  '.wr-quick{min-height:76px;box-sizing:border-box}',
  '.wr-info{min-height:36px;line-height:1.45;box-sizing:border-box}',
  '.wr-quick-btns button{outline:none;-webkit-tap-highlight-color:transparent;font-size:11px;padding:4px 10px}',
  '.wr-quick-btns button.on{outline:none;-webkit-tap-highlight-color:transparent;font-size:11px;padding:4px 10px}'
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
      /* v0.69d2：0.3% 下限（约 8 个交易日），不再把「1个月」(≈0.8%) 还原成全段 */
      if (b - a < 0.003) { a = 0; b = 1; }
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
        /* v0.69d2：原 0.02 会让 1 个月快捷区间被吞；只在几乎重合时还原 */
        if (!(b - a >= 0.003)) { a = 0; b = 1; }
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

  /* v0.72：快捷档窗口的唯一算法。默认 1 年、点按钮、由 sel 反推高亮，三处共用，
     不再各写一份日期计算。labels 是 'YYYY-MM-DD' 字符串数组。 */
  R.presetValue = function (labels, key) {
    var n = (labels || []).length;
    if (n < 2 || !key || key === 'ALL') return [0, 1];
    var months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }[key];
    if (!months) return [0, 1];
    var last = String(labels[n - 1] || '').slice(0, 10);
    var d = new Date(last + 'T00:00:00+08:00');
    if (isNaN(d.getTime())) return [0, 1];
    d.setMonth(d.getMonth() - months);
    var p2 = function (x) { return ('0' + x).slice(-2); };
    var cut = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    var i0 = 0;
    for (var z = 0; z < n; z++)
      if (String(labels[z] || '').slice(0, 10) >= cut) { i0 = z; break; }
    return [i0 / (n - 1), 1];
  };

  /* 年份刻度：labels 形如 YYYY-MM / YYYY-MM-DD，每年只保留第一次出现的那个。
     v0.73：再加「最小像素间距」过滤。数据常从 11 月起，首年与下一年第一次出现
     只隔几个点（5 年约 11px、10 年约 5px），而 4 位年份在 360 viewBox 里约 20px，
     必然叠字。按可见点数把 28px 换算成索引间距，太近就整年跳过；
     每个年份只在第一次出现处判断一次，避免同年中段又冒出一个标签。
     opts: { minPx: 28, width: 310 } —— 调用方都是 34..344 的 310px 绘图区。 */
  R.yearTicks = function (labels, opts) {
    opts = opts || {};
    var L = labels || [], n = L.length;
    var width = opts.width || 310, minPx = opts.minPx || 28;
    var stepPx = n > 1 ? width / (n - 1) : width;
    var minGap = Math.max(1, Math.ceil(minPx / Math.max(stepPx, 0.0001)));
    var out = [], lastI = -1e9, seen = {};
    L.forEach(function (v, i) {
      var y = String(v).slice(0, 4);
      if (!y || seen[y]) return;
      seen[y] = true;
      if (i - lastI < minGap) return;
      out.push({ i: i, text: y });
      lastI = i;
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
          var txt = !ok ? '—' : (s.fmt ? s.fmt(v, i) : (typeof v === 'number' ? v.toFixed(2) : String(v)));
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


  /* ---------------- 通用「展示区间」控件（v0.69b） ----------------
     两个日期框 + 1/3/6 个月、1/2 年、全部；不碰数据，只回报归一化区间 [a,b]。
     opts = { anchorId, labels():[] , get():[a,b], set([a,b]) , id? } */
  R.quick = function (opts) {
    if (typeof document === 'undefined') return null;
    ensureStyle();
    var anchor = document.getElementById(opts.anchorId);
    if (!anchor || !anchor.parentNode) return null;
    var q = document.createElement('div');
    q.id = opts.id || ('__wrQuick_' + opts.anchorId);
    q.className = 'wr-quick';
    var names = { '1M': '1个月', '3M': '3个月', '6M': '6个月', '1Y': '1年', '2Y': '2年', 'ALL': '全部' };
    var keys = ['1M', '3M', '6M', '1Y', '2Y', 'ALL'];
    q.innerHTML = '<div class="wr-quick-row"><span class="wr-quick-lab">展示区间</span>' +
      '<input type="date" data-q="from" aria-label="起始日期" /><span class="wr-quick-sep">-</span>' +
      '<input type="date" data-q="to" aria-label="结束日期" /></div>' +
      '<div class="wr-quick-btns">' + keys.map(function (k) {
        return '<button type="button" data-v="' + k + '">' + names[k] + '</button>';
      }).join('') + '</div>';
    anchor.parentNode.insertBefore(q, anchor.nextSibling);

    var key = 'ALL', tid = null;
    function labels() { try { return opts.labels() || []; } catch (e) { return []; } }
    function day(i, L) { return String(L[i] || '').slice(0, 10); }
    function findGE(v) { var L = labels(), n = L.length, i; for (i = 0; i < n; i++) if (day(i, L) >= v) return i; return n - 1; }
    function findLE(v) { var L = labels(), n = L.length, i; for (i = n - 1; i >= 0; i--) if (day(i, L) <= v) return i; return 0; }
    function hi() { var bs = q.getElementsByTagName('button'), j;
      for (j = 0; j < bs.length; j++) bs[j].className = (bs[j].getAttribute('data-v') === key) ? 'on' : '';
      var lab = q.querySelector('.wr-quick-lab');
      if (lab) lab.textContent = key === 'CUSTOM' ? '展示区间 · 自定义' : '展示区间'; }
    function paintInputs() {
      var L = labels(); if (!L.length) return;
      var inf = R.info(L, opts.get ? opts.get() : [0, 1]);
      var fi = q.querySelector('[data-q="from"]'), ti = q.querySelector('[data-q="to"]');
      if (fi && document.activeElement !== fi) fi.value = String(inf.from || '').slice(0, 10);
      if (ti && document.activeElement !== ti) ti.value = String(inf.to || '').slice(0, 10);
      hi();
    }
    function setSel(x, k) { key = k; if (opts.set) opts.set(x); paintInputs(); }
    /* 白条手动拖动 / 双击还原 / 5-10 年切换后，按实际选区重定高亮 */
    function mark(sel) { key = R.isFull(sel) ? 'ALL' : 'CUSTOM'; paintInputs(); }

    q.addEventListener('click', function (ev) {
      var b = ev.target;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-v')) return;
      var k = b.getAttribute('data-v'), L = labels(), n = L.length;
      if (n < 2) return;
      if (k === 'ALL') { setSel([0, 1], 'ALL'); return; }
      var months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }[k];
      if (!months) return;
      var d = new Date(day(n - 1, L) + 'T00:00:00+08:00');
      d.setMonth(d.getMonth() - months);
      var p2 = function (x) { return ('0' + x).slice(-2); };
      var cut = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      var i0 = findGE(cut);
      setSel([Math.max(0, i0 / (n - 1)), 1], k);
    });
    q.addEventListener('change', function (ev) {
      if (!ev.target || !ev.target.getAttribute || !ev.target.getAttribute('data-q')) return;
      if (tid) clearTimeout(tid);
      tid = setTimeout(function () {
        tid = null;
        var fi = q.querySelector('[data-q="from"]'), ti = q.querySelector('[data-q="to"]');
        var f = fi && fi.value, t = ti && ti.value, L = labels(), n = L.length;
        if (!f || !t || f > t || n < 2) return;
        var i0 = findGE(f), i1 = findLE(t);
        /* 区间完全落在数据范围外：不改曲线，但别让「全部」继续高亮误导 */
        if (i1 <= i0) { key = 'CUSTOM'; hi(); return; }
        setSel([i0 / (n - 1), Math.min(1, i1 / (n - 1))], 'CUSTOM');
      }, 140);
    });
    paintInputs();
    /* 看板作为主文档内嵌视图时，新增这一行会让 iframe 变高；主动通知父页重算高度，
       否则「展示区间」控件可能被裁在可视区外。 */
    try {
      if (window.parent && window.parent !== window) {
        var h = Math.max(document.documentElement.scrollHeight,
                         document.body ? document.body.scrollHeight : 0);
        window.parent.postMessage({ wufuDashHeight: h }, '*');
      }
    } catch (e) { }
    return { mark: mark, paint: paintInputs, el: q };
  };


  /* ---------------- 统一曲线控制器（v0.70） ----------------
     一个图表 id 对应唯一一个控制器：唯一 DOM、唯一 sel 状态、唯一一组监听。
     kind 相同（净值/回撤内部重绘）只 update 回调，不重建、不重置 window；
     kind 变化（净值 ⇄ 定投）才 destroy → 重建，即「注销 → 设 mode → 重绘」。
     这样切页不会再留下两条白条、两行快捷按钮或绑在旧闭包上的监听。         */
  var CURVES = {};
  var QK = ['1M', '3M', '6M', '1Y', '2Y', 'ALL'];
  var QN = { '1M': '1个月', '3M': '3个月', '6M': '6个月', '1Y': '1年', '2Y': '2年', 'ALL': '全部' };
  R.curve = function (id, cfg) {
    cfg = cfg || {};
    var kind = cfg.kind || 'nav';
    var old = CURVES[id];
    if (old && old.kind === kind) { old.update(cfg); return old; }
    if (old) old.destroy();
    var el = document.getElementById(id);
    if (!el || !el.parentNode) return null;
    ensureStyle();
    var parent = el.parentNode, modeEl, root, host, quick, info, tipEl, rng = null;
    var timer = null, dead = false;
    var state = {
      sel: (cfg.value && cfg.value.length === 2) ? [cfg.value[0], cfg.value[1]] : [0, 1],
      mode: cfg.mode || ((cfg.modes && cfg.modes[0] && cfg.modes[0].key) || 'nav'),
      align: !!(cfg['switch'] && cfg['switch'].on),
      labels: cfg.labels || [],
      /* v0.72：key 不再独立存真值，由 sel 通过 keyOf() 反推；此处仅占位，
         paintQuick() 会立即覆盖。避免 update() 把高亮写死成某一档。 */
      key: 'ALL'
    };

    modeEl = document.createElement('div');
    modeEl.id = '__navMode_' + id;
    modeEl.className = 'wr-modebar';
    modeEl.setAttribute('style', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px');
    parent.insertBefore(modeEl, el);

    root = document.createElement('div');
    root.id = '__wrCurve_' + id;
    root.className = 'wr-curve';
    parent.insertBefore(root, el.nextSibling);
    tipEl = document.createElement('div'); tipEl.className = 'wr-tip'; root.appendChild(tipEl);
    host = document.createElement('div'); host.id = '__wr_' + id; root.appendChild(host);
    quick = document.createElement('div'); quick.id = '__navQuick_' + id; quick.className = 'wr-quick'; root.appendChild(quick);
    info = document.createElement('div'); info.id = '__navRangeInfo_' + id; info.className = 'wr-info'; root.appendChild(info);
    quick.innerHTML = '<div class="wr-quick-row"><span class="wr-quick-lab">展示区间</span>' +
      '<input type="date" data-q="from" aria-label="起始日期" /><span class="wr-quick-sep">-</span>' +
      '<input type="date" data-q="to" aria-label="结束日期" /></div>' +
      '<div class="wr-quick-btns">' + QK.map(function (k) {
        return '<button type="button" data-v="' + k + '">' + QN[k] + '</button>';
      }).join('') + '</div>';

    function btnStyle(on) {
      return 'cursor:pointer;font-size:12px;padding:4px 12px;border-radius:6px;' +
        (on ? 'background:rgba(79,195,247,.16);color:#4FC3F7;border:1px solid #4FC3F7;'
            : 'background:#202E3F;color:#9FB0C3;border:1px solid #33465C;');
    }
    function paintMode() {
      var html = '';
      (cfg.modes || []).forEach(function (m) {
        html += '<button type="button" data-mode="' + m.key + '" style="' + btnStyle(m.key === state.mode) + '">' + m.label + '</button>';
      });
      if (cfg['switch'])
        html += '<span class="wr-quick-sep" style="margin-left:8px"></span>' +
          '<button type="button" data-switch="1" style="' + btnStyle(state.align) + '">' + cfg['switch'].label + '</button>';
      if ((cfg.modes || []).length)
        html += '<span id="__navModeHint_' + id + '" style="font-size:11px;color:#7C8DA1"></span>';
      modeEl.innerHTML = html;
      var hint = document.getElementById('__navModeHint_' + id);
      if (hint && typeof cfg.hint === 'function') { try { hint.textContent = cfg.hint(state) || ''; } catch (e) { } }
    }
    /* v0.72：由当前窗口反推该高亮哪个按钮。拖条后的任意窗口 -> CUSTOM，
       全段 -> ALL，与某个快捷档窗口重合(±2 个索引) -> 对应档。 */
    function keyOf(sel, labels) {
      var n = (labels || []).length;
      if (n < 2 || R.isFull(sel)) return 'ALL';
      var ks = ['1M', '3M', '6M', '1Y', '2Y'], i, v;
      for (i = 0; i < ks.length; i++) {
        v = R.presetValue(labels, ks[i]);
        if (Math.abs(v[0] - sel[0]) * (n - 1) <= 2 && Math.abs(v[1] - sel[1]) <= 0.0001)
          return ks[i];
      }
      return 'CUSTOM';
    }
    function day(i) { return String(state.labels[i] || '').slice(0, 10); }
    function infoOf(sel) {
      var L = state.labels, n = L.length;
      if (!n) return { from: '', to: '', i0: 0, i1: 0 };
      var i0 = Math.round(sel[0] * (n - 1)), i1 = Math.round(sel[1] * (n - 1));
      if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
      return { from: day(i0), to: day(i1), i0: i0, i1: i1 };
    }
    function paintQuick() {
      var k = keyOf(state.sel, state.labels);
      state.key = k;
      var bs = quick.getElementsByTagName('button'), j;
      for (j = 0; j < bs.length; j++)
        bs[j].className = (bs[j].getAttribute('data-v') === k) ? 'on' : '';
      var inf = infoOf(state.sel);
      var fi = quick.querySelector('[data-q="from"]'), ti = quick.querySelector('[data-q="to"]');
      if (fi && document.activeElement !== fi) fi.value = inf.from;
      if (ti && document.activeElement !== ti) ti.value = inf.to;
      var lab = quick.querySelector('.wr-quick-lab');
      if (lab) lab.textContent = state.key === 'CUSTOM' ? '展示区间 · 自定义' : '展示区间';
    }
    function paintInfo() {
      if (typeof cfg.info === 'function') {
        try { info.innerHTML = cfg.info(state) || ''; } catch (e) { }
      }
    }
    function paintAll() {
      tipEl.textContent = cfg.tip || '';
      paintMode(); paintQuick(); paintInfo();
    }
    function fireChange() {
      if (cfg.zoom !== false && window.echarts && echarts.getInstanceByDom) {
        var ch = echarts.getInstanceByDom(el);
        if (ch && ch.dispatchAction)
          ch.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: state.sel[0] * 100, end: state.sel[1] * 100 });
      }
      paintQuick(); paintInfo();
      if (typeof cfg.onChange === 'function') cfg.onChange(state.sel.slice(), state);
    }
    rng = R.mount(host.id, {
      value: state.sel,
      onChange: function (x) {
        state.sel = [x[0], x[1]];
        fireChange();
      }
    });
    if (rng) rng.setLabels(state.labels);

    function set(x, k) {
      state.sel = [x[0], x[1]];
      if (rng) rng.set(state.sel, true);
      fireChange();
    }
    quick.addEventListener('click', function (ev) {
      var b = ev.target;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-v')) return;
      try { b.blur(); } catch (e) { }
      try { ev.preventDefault(); } catch (e) { }
      var k = b.getAttribute('data-v'), n = state.labels.length;
      if (n < 2) return;
      set(R.presetValue(state.labels, k), k);
    });
    quick.addEventListener('change', function (ev) {
      if (!ev.target || !ev.target.getAttribute || !ev.target.getAttribute('data-q')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        var fi = quick.querySelector('[data-q="from"]'), ti = quick.querySelector('[data-q="to"]');
        var f = fi && fi.value, t = ti && ti.value, n = state.labels.length;
        if (!f || !t || f > t || n < 2) return;
        var i0 = 0, i1 = n - 1, z;
        for (z = 0; z < n; z++) if (day(z) >= f) { i0 = z; break; }
        for (z = n - 1; z >= 0; z--) if (day(z) <= t) { i1 = z; break; }
        if (i1 <= i0) { state.key = 'CUSTOM'; paintQuick(); return; }
        set([i0 / (n - 1), Math.min(1, i1 / (n - 1))], 'CUSTOM');
      }, 140);
    });
    modeEl.addEventListener('click', function (ev) {
      var b = ev.target;
      if (!b || b.tagName !== 'BUTTON') return;
      if (b.getAttribute('data-switch')) {
        state.align = !state.align; paintMode(); paintInfo();
        if (typeof cfg.onSwitch === 'function') cfg.onSwitch(state.align, state);
        return;
      }
      var m = b.getAttribute('data-mode');
      if (!m) return;
      state.mode = m; paintMode();
      if (typeof cfg.onMode === 'function') cfg.onMode(m, state);
    });

    paintAll();
    var api = {
      kind: kind, state: state, rng: rng,
      get: function () { return state.sel.slice(); },
      set: set,
      setLabels: function (ls) { state.labels = ls || []; if (rng) rng.setLabels(state.labels); paintQuick(); },
      setMode: function (m) { state.mode = m; paintMode(); },
      setSwitch: function (on) { state.align = !!on; paintMode(); paintInfo(); },
      setInfo: function (html) { info.innerHTML = html || ''; },
      paint: paintAll,
      update: function (c2) {
        cfg = c2 || {};
        if (cfg.labels) state.labels = cfg.labels;
        if (cfg.mode) state.mode = cfg.mode;
        /* v0.72：刻意不读 cfg.key。高亮一律由 sel 派生，
           否则任何一次重绘都会把按钮写回初始档，与曲线窗口脱钩。 */
        if (cfg.value && cfg.value.length === 2) {
          state.sel = [cfg.value[0], cfg.value[1]];
          if (rng) rng.set(state.sel, true);
        }
        if (rng) rng.setLabels(state.labels);
        paintAll();
      },
      destroy: function () {
        if (dead) return; dead = true;
        if (timer) clearTimeout(timer);
        if (modeEl && modeEl.parentNode) modeEl.parentNode.removeChild(modeEl);
        if (root && root.parentNode) root.parentNode.removeChild(root);
        delete CURVES[id];
      }
    };
    CURVES[id] = api;
    return api;
  };
  R.curveOf = function (id) { return CURVES[id] || null; };
  R.curveDestroy = function (id) { if (CURVES[id]) CURVES[id].destroy(); };

  window.WufuRange = R;
})();
