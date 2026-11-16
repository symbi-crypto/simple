/* range.js — 看板历史曲线下方的「白色透明时间段选择条」（v0.59）
   纯原生实现：两个手柄 + 可拖动选区；只回报归一化区间 [a,b]，不碰数据。 */
(function () {
  'use strict';
  var R = {};

  R.mount = function (hostId, opts) {
    var host = document.getElementById(hostId);
    if (!host) return null;
    opts = opts || {};
    host.className = (host.className || '') + ' wr-host';
    host.innerHTML =
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
      labL.style.left = pct(a);
      labR.style.left = pct(b);
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
      reset: function () { a = 0; b = 1; paint(); },
      get: function () { return [a, b]; }
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

  window.WufuRange = R;
})();
