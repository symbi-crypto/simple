
/* ==========================================================================
   可转债 v2 · 数据体检全套（与 ETF 系统同形态，CB 口径适配）
   · 修复包（patch）存本机：人工纠正 / 就地修复 / 已确认 / 联网增量日 / 新纳入标的 / 互换
   · 一键更新行情 = 联网增量 + 标的池动态更新（新上市普通转债自动纳入；可交换债/定向转债排除）
   · 一键修复数据 = 体检 → 本地高置信度插值 → 复扫 → 两行汇报，可一次撤销
   ========================================================================== */
(function () {
  "use strict";
  var KP = "wufuCbQPatch_v1", KU = "wufuCbQUndo_v1", KS = "wufuCb_qck_snap_v1",
      KF = "wufuCb_qck_fix_v1", KL = "wufuCb_fc_log_v1", KQ = "wufuCb_fc_queue_v1";
  var FIELDS = ["open", "high", "low", "close", "raw_close", "nav", "premium", "amount", "turnover", "volume"];
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ls(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) {
    var str;
    try { str = JSON.stringify(v); } catch (e) { return false; }
    try {
      if (window.WufuStore && WufuStore.put) {
        var r = WufuStore.put(k, str);
        if (!r.ok) { window.__WUFU_SAVE_FAIL = true; return false; }
        return true;
      }
    } catch (e) { }
    try { localStorage.setItem(k, str); return true; } catch (e) { window.__WUFU_SAVE_FAIL = true; return false; }
  }
  function ts() { return new Date().toLocaleString("zh-CN", { hour12: false }); }
  function today() { var d = new Date(); return d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0"); }
  function empty() { return { v: 1, ts: "", days: [], corrections: [], ohlcFix: {}, resupply: {}, exempt: [], swaps: [], refactors: [], report: null, st: null, ann: null, scale: null }; }
  function P() { var p = ls(KP, null) || empty();
    ["days","corrections","exempt","swaps","refactors"].forEach(function (k) { if (!Array.isArray(p[k])) p[k] = []; });
    ["ohlcFix","resupply"].forEach(function (k) { if (!p[k] || typeof p[k] !== "object") p[k] = {}; });
    if (!p.st || !Array.isArray(p.st.segments)) p.st = null;
    return p; }
  function W(p) { p.ts = ts(); var ok = save(KP, p); if (!ok) window.__WUFU_SAVE_FAIL = true; return ok; }
  function gD() { try { if (window.WufuUI && window.WufuUI.getData) { var d = window.WufuUI.getData(); if (d) return d; } } catch (e) { } return window.__WUFU_D || window.D || null; }
  function note(t, bad) {
    var e = $("wufuUpdMsg"); if (!e) return;
    e.style.display = ""; e.textContent = t; e.style.color = bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0049§");
    e.style.background = bad ? WufuTheme.sub("§WFT0063§") : WufuTheme.sub("§WFT0050§");
    e.style.border = "1px solid " + (bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0016§"));
  }
  function qnote(t, bad) {
    var e = $("qckMsg"); if (!e) return;
    e.style.display = ""; e.textContent = t; e.style.color = bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0049§");
    e.style.background = bad ? WufuTheme.sub("§WFT0063§") : WufuTheme.sub("§WFT0050§");
    e.style.border = "1px solid " + (bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0016§"));
  }
  function fcMsg(t, bad) {
    var e = $("fcMsg"); if (!e) return;
    e.style.display = ""; e.textContent = t; e.style.color = bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0049§");
    e.style.background = bad ? WufuTheme.sub("§WFT0063§") : WufuTheme.sub("§WFT0050§");
    e.style.border = "1px solid " + (bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0016§"));
  }
  function dl(name, txt) {
    var b = new Blob([txt], { type: "application/json;charset=utf-8" }), u = URL.createObjectURL(b);
    var a = document.createElement("a"); a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
  }
  function log(act, c, st, m) {
    var a = ls(KL, []); if (!Array.isArray(a)) a = [];
    a.push({ ts: ts(), act: act, c: c || "", st: st || "info", m: String(m || "").slice(0, 260) });
    if (a.length > 240) a = a.slice(-240);
    save(KL, a);
    try { if (window.FixCenter && window.FixCenter.render) window.FixCenter.render(); } catch (e) { }
  }

  /* ---------- patch → 数据（按 D 对象引用判断：行情块二次解析重建时自动重放） ---------- */
  var applied = false, lastAppliedD = null;
  function applyPatch() {
    var D = gD(); if (!D || !D.series || !D.calendar) return false;
    // 内嵌成交量块尚未合并时先等：否则新增交易日 push 后，后挂上的 amount/turnover/volume 会短一截
    if (!window.__volMergedOK && document.getElementById("wufuVolGz")) return false;
    // 同一个 D 只回放一次；若数据块被二次解析换成新对象，则在新对象上重新回放
    // （修复与增量都作用于新对象的原始值，swaps 不会二次翻回）
    if (D === lastAppliedD) return false;
    var p = P(), idx = {}; D.calendar.forEach(function (x, i) { idx[x] = i; });
    function setV(c, dt, f, v) {
      var sv = D.series[c]; if (!sv || !Array.isArray(sv[f])) return;
      var i = idx[dt]; if (i == null) return; sv[f][i] = v;
    }
    (p.corrections || []).forEach(function (x) {
      ["open","high","low","close","amount"].forEach(function (f) { if (x[f] != null && x[f] !== "") setV(x.c, x.date, f, +x[f]); });
    });
    ["ohlcFix","resupply"].forEach(function (k) {
      var m = p[k] || {}; Object.keys(m).forEach(function (c) {
        Object.keys(m[c] || {}).forEach(function (dt) {
          var v = m[c][dt] || {}; Object.keys(v).forEach(function (f) { if (FIELDS.indexOf(f) >= 0) setV(c, dt, f, v[f]); });
        });
      });
    });
    (p.swaps || []).forEach(function (x) {
      var a = D.series[x.a], b = D.series[x.b]; if (!a || !b) return;
      FIELDS.forEach(function (f) { if (Array.isArray(a[f]) && Array.isArray(b[f])) { var t = a[f]; a[f] = b[f]; b[f] = t; } });
    });
    // 动态扩池：先安装新债序列（长度=当前日历），后续 p.days 会自动 push 补齐新增交易日
    try { _installNewSeries(D, p.newSeries); } catch (e) { }
    (p.days || []).forEach(function (e) {
      if (!e.date) return; var i = idx[e.date];
      if (i == null) {
        D.calendar.push(e.date); i = D.calendar.length - 1; idx[e.date] = i;
        Object.keys(D.series).forEach(function (c) {
          FIELDS.forEach(function (f) { if (Array.isArray(D.series[c][f])) D.series[c][f].push(null); });
        });
        // 联网增量：基准序列与日历等长；未取到当日指数时沿用上一交易日值，避免 undefined
        Object.keys(D.index || {}).forEach(function (k) {
          var a = D.index[k]; if (!Array.isArray(a)) return;
          var v = (e.index && e.index[k] != null) ? e.index[k] : (a.length ? a[a.length - 1] : null);
          a.push(v);
        });
      }
      if (e.index && D.index) Object.keys(e.index).forEach(function (k) {
        if (Array.isArray(D.index[k]) && e.index[k] != null && i != null) D.index[k][i] = e.index[k];
      });
      Object.keys(e.series || {}).forEach(function (c) {
        var v = e.series[c]; Object.keys(v).forEach(function (f) { if (FIELDS.indexOf(f) >= 0) setV(c, e.date, f, v[f]); });
      });
    });
    lastAppliedD = D; applied = true;
    try { mergeExtras(p); } catch (e) { }
    try {
      var lc = D.calendar[D.calendar.length - 1];
      if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.paint("cb", lc);
      else { var bd = document.getElementById("dbDate"); if (bd) bd.textContent = "数据 " + D.calendar[0] + " → " + lc; }
    } catch (e) { }
    return true;
  }

  /* ---------- 本地修复：只动「确定错了」的点，缺失 null 不动 ---------- */
  function valid(v) { return v != null && isFinite(v) && v > 0; }
  function interp(a, i) {
    var p = null, q = null, j;
    for (j = i - 1; j >= 0; j--) if (valid(a[j])) { p = a[j]; break; }
    for (j = i + 1; j < a.length; j++) if (valid(a[j])) { q = a[j]; break; }
    return (p != null && q != null) ? (p + q) / 2 : (p != null ? p : (q != null ? q : null));
  }
  // 严格插值：前后都必须有有效正数值才补，绝不外推（专用于 0 / -1 这类确定坏值）
  function interpStrict(a, i) {
    var p = null, q = null, j, hasP = false, hasQ = false;
    for (j = i - 1; j >= 0; j--) if (valid(a[j])) { p = a[j]; hasP = true; break; }
    for (j = i + 1; j < a.length; j++) if (valid(a[j])) { q = a[j]; hasQ = true; break; }
    return (hasP && hasQ) ? (p + q) / 2 : null;
  }
  function repair(codes, mode) {
    var D = gD(), out = [], p = P();
    if (!D || !D.series || !D.calendar) throw new Error("行情数据尚未加载完成");
    codes = (codes || []).filter(function (c) { return D.series[c]; });
    codes.forEach(function (c) {
      var sv = D.series[c], changes = {}, n = 0;
      var cl = sv.close || [], op = sv.open || [], hi = sv.high || [], lo = sv.low || [], nv = sv.nav || [];
      for (var i = 1; i < cl.length - 1; i++) {
        var date = D.calendar[i];
        if (!date) continue;
        // ① 四价矛盾（仅当四价都有值时）
        if (valid(cl[i]) && valid(hi[i]) && valid(lo[i]) &&
            (hi[i] < lo[i] - 1e-9 || cl[i] > hi[i] + 1e-9 || cl[i] < lo[i] - 1e-9)) {
          var v = interp(cl, i); if (v != null) { changes[date] = changes[date] || {}; changes[date].close = v;
            ["open","high","low"].forEach(function (f) { var q = interp(sv[f] || [], i); if (q != null) changes[date][f] = q; }); n++; }
        }
        // ② 孤立跳变：单日暴涨暴跌且次日回归（妖债连续拉升不修）
        if (mode !== "ohlc" && valid(cl[i-1]) && valid(cl[i]) && valid(cl[i+1])) {
          var d1 = Math.abs(cl[i] / cl[i-1] - 1), d2 = Math.abs(cl[i+1] / cl[i] - 1), dd = Math.abs(cl[i+1] / cl[i-1] - 1);
          if (d1 > 0.5 && d2 > 0.5 && dd < 0.12) {
            var q2 = interp(cl, i); if (q2 != null) { changes[date] = changes[date] || {}; changes[date].close = q2; n++; }
          }
        }
        // ③ 债底孤立坏值（>200 或 <=0），只修单点、不碰信用重估的整段断点
        if (mode !== "ohlc" && nv[i] != null && (nv[i] > 200 || nv[i] <= 0) &&
            valid(nv[i-1]) && valid(nv[i+1]) && Math.abs(nv[i+1] / nv[i-1] - 1) < 0.12) {
          var q3 = interp(nv, i); if (q3 != null) { changes[date] = changes[date] || {}; changes[date].nav = q3; n++; }
        }
      }
      // ④ 价格 / 未复权价里的 0 或 -1 哨兵：前后都有有效正数值就用两日均值补上。
      //    null 是「未上市 / 停牌 / 摘牌后」的正常占位，按库口径不回退不外推，保持不动；
      //    成交量 / 成交额的 -1 是停牌标记，也不动。严格插值，绝不外推。
      ["close", "raw_close"].forEach(function (f) {
        var a = sv[f]; if (!Array.isArray(a)) return;
        for (var j = 0; j < a.length; j++) {
          var v = a[j];
          if (v == null || !isFinite(v) || v > 0) continue;
          var dt2 = D.calendar[j]; if (!dt2) continue;
          var q4 = interpStrict(a, j); if (q4 == null) continue;
          changes[dt2] = changes[dt2] || {}; changes[dt2][f] = q4; n++;
        }
      });
      Object.keys(changes).forEach(function (dt) {
        var v = changes[dt], ix = D.calendar.indexOf(dt); if (ix < 0) return;
        Object.keys(v).forEach(function (f) { if (Array.isArray(sv[f])) sv[f][ix] = v[f]; });
      });
      if (n) {
        var key = mode === "ohlc" ? "ohlcFix" : "resupply";
        p[key][c] = Object.assign(p[key][c] || {}, changes);
        log(mode === "ohlc" ? "OHLC 本地修复" : "本地插值修复", c, "ok", n + " 天");
      }
      out.push({ c: c, n: n, msg: n ? "已插值 " + n + " 天" : "无需修复" });
    });
    W(p); renderState();
    return out;
  }

  /* ---------- 人工纠正单日 ---------- */
  function corrSave() {
    var c = ($("wufuCorrCode") || {}).value, dt = ($("wufuCorrDate") || {}).value;
    var D = gD(); if (!c || !dt || !D || D.calendar.indexOf(dt) < 0) { note("请先选标的和有效日期", true); return; }
    var o = { c: c, date: dt }, any = false;
    [["open","wufuCorrO"],["high","wufuCorrH"],["low","wufuCorrL"],["close","wufuCorrC"],["amount","wufuCorrA"]].forEach(function (q) {
      var e = $(q[1]), v = e ? parseFloat(e.value) : NaN;
      if (isFinite(v)) { o[q[0]] = v; any = true; }
    });
    if (!any) { note("至少填一个价格字段", true); return; }
    var p = P(); p.corrections = (p.corrections || []).filter(function (x) { return !(x.c === c && x.date === dt); });
    p.corrections.push(o); W(p);
    var sv = D.series[c], ix = D.calendar.indexOf(dt);
    if (sv && ix >= 0) Object.keys(o).forEach(function (f) { if (FIELDS.indexOf(f) >= 0 && Array.isArray(sv[f])) sv[f][ix] = o[f]; });
    note("已保存 " + c + " / " + dt + " 的人工纠正（随本机修复记录带走，可清除）");
    log("人工纠正", c, "ok", dt + " 覆盖 " + Object.keys(o).filter(function (k) { return FIELDS.indexOf(k) >= 0; }).join("/"));
    renderState(); try { window.HealthView && window.HealthView.run(); } catch (e) { }
  }
  function corrClear() {
    var c = ($("wufuCorrCode") || {}).value, dt = ($("wufuCorrDate") || {}).value, p = P();
    var n = (p.corrections || []).length;
    p.corrections = (p.corrections || []).filter(function (x) { return !((!c || x.c === c) && (!dt || x.date === dt)); });
    W(p); note("已清除 " + (n - p.corrections.length) + " 条人工纠正，刷新后恢复原始值。刷新中…");
    log("清除人工纠正", c, "act", dt || "全部");
    setTimeout(function () { location.reload(); }, 800);
  }

  /* ---------- 已确认 / 纠正记录 ---------- */
  function exemptList() {
    var p = P(), out = {};
    (p.exempt || []).forEach(function (x) { (out[x.id] = out[x.id] || []).push(x.c); });
    return out;
  }
  function exempt(id, codes) {
    var p = P(), seen = {};
    (p.exempt || []).forEach(function (x) { seen[x.id + "|" + x.c] = 1; });
    (codes || []).forEach(function (c) { if (!seen[id + "|" + c]) { p.exempt.push({ id: id, c: c, ts: ts() }); seen[id + "|" + c] = 1; } });
    W(p); log("标记为已确认", (codes || []).slice(0,3).join(" "), "ok", id + " · " + (codes || []).length + " 只"); renderState();
  }
  function clearExempt() { var p = P(); p.exempt = []; W(p); log("清除全部已确认", "", "act", ""); renderState(); try { window.HealthView.run(); } catch (e) { } }
  function clearAllFix() {
    if (!confirm("撤销全部体检纠正（人工纠正 / 就地修复 / 已确认 / 序列互换）？页面将自动刷新。")) return;
    var p = P(); p.corrections = []; p.ohlcFix = {}; p.resupply = {}; p.exempt = []; p.swaps = []; p.refactors = [];
    W(p); log("撤销全部体检纠正", "", "act", "");
    setTimeout(function () { location.reload(); }, 500);
  }
  function undoOhlc() {
    var p = P(); p.ohlcFix = {}; W(p); log("撤销 OHLC 修复", "", "act", "");
    note("已撤销 OHLC 修复，刷新后恢复。刷新中…"); setTimeout(function () { location.reload(); }, 800);
  }
  function renderList() {
    var e = $("wufuFixList"); if (!e) return;
    var p = P(), h = [], n = 0;
    function row(label, txt, act, val) {
      n++; h.push(WufuTheme.sub('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:5px 0;border-bottom:1px solid §WFT0009§;font-size:11px;color:§WFT0003§">') +
        WufuTheme.sub('<span style="color:§WFT0006§;min-width:96px">') + esc(label) + '</span><span style="flex:1;min-width:150px">' + esc(txt) + '</span>' +
        (act ? '<button type="button" class="corr-mini" data-cb-un="' + esc(act) + '" data-cb-v="' + esc(val) + '">撤销</button>' : '') + '</div>');
    }
    (p.corrections || []).slice(-12).forEach(function (x) { row("人工纠正", x.c + " · " + x.date, "corr", x.c + "|" + x.date); });
    Object.keys(p.ohlcFix || {}).forEach(function (c) { row("OHLC 修复", c + " · " + Object.keys(p.ohlcFix[c]).length + " 天", "ohlc", c); });
    Object.keys(p.resupply || {}).forEach(function (c) { row("插值修复", c + " · " + Object.keys(p.resupply[c]).length + " 天", "resup", c); });
    (p.swaps || []).slice(-6).forEach(function (x) { row("序列互换", x.a + " ↔ " + x.b, "", ""); });
    (p.exempt || []).slice(-12).forEach(function (x) { row("已确认", x.id + " · " + x.c, "exempt", x.id + "|" + x.c); });
    (p.days || []).slice(-6).forEach(function (x) { row("增量交易日", x.date + " · " + Object.keys(x.series || {}).length + " 只", "", ""); });
    e.innerHTML = n ? h.join("") : WufuTheme.sub('<div style="font-size:11px;color:§WFT0002§;padding:6px 0">暂无修复记录。</div>');
    Array.prototype.forEach.call(e.querySelectorAll("[data-cb-un]"), function (b) {
      b.addEventListener("click", function () {
        var a = b.getAttribute("data-cb-un"), v = b.getAttribute("data-cb-v"), p = P();
        if (a === "corr") { var q = v.split("|"); p.corrections = p.corrections.filter(function (x) { return !(x.c === q[0] && x.date === q[1]); }); }
        if (a === "ohlc") delete p.ohlcFix[v];
        if (a === "resup") delete p.resupply[v];
        if (a === "exempt") { var z = v.split("|"); p.exempt = p.exempt.filter(function (x) { return !(x.id === z[0] && x.c === z[1]); }); }
        W(p); log("撤销单条", v, "act", a); note("已撤销，刷新后生效。刷新中…");
        setTimeout(function () { location.reload(); }, 700);
      });
    });
  }
  function fillCorrCodes() {
    var sel = $("wufuCorrCode"); if (!sel) return;
    var D = gD(), codes = D && D.series ? Object.keys(D.series) : [];
    var pool = window.WUFU_POOL || [], names = {};
    pool.forEach(function (x) { names[x.code] = x.name; });
    sel.innerHTML = codes.sort().map(function (c) { return '<option value="' + esc(c) + '">' + esc(names[c] || c) + " · " + esc(c) + "</option>"; }).join("");
    var dt = $("wufuCorrDate"), cal = D && D.calendar;
    if (dt && cal && cal.length && !dt.value) dt.value = cal[cal.length - 1];
  }
  function renderCorrList() {
    var e = $("wufuCorrList"); if (!e) return;
    var p = P(), a = (p.corrections || []).slice(-20).reverse();
    e.style.display = a.length ? "" : "none";
    e.innerHTML = a.length ? WufuTheme.sub('<div style="font-size:10.5px;color:§WFT0002§;margin:6px 0">最近人工纠正（') + a.length + ' 条）</div>' +
      a.map(function (x) { return WufuTheme.sub('<div style="font-size:11px;color:§WFT0003§;padding:3px 0;border-bottom:1px solid §WFT0009§">') + esc(x.c) + " · " + esc(x.date) + " · 收 " + esc(x.close == null ? "—" : x.close) + "</div>"; }).join("") : "";
  }
  function renderState() {
    var p = P(), st = $("wufuUpdState"), os = $("wufuOhlcState"), rp = $("wufuUpdReport");
    var nCorr = (p.corrections || []).length, nOh = Object.keys(p.ohlcFix || {}).length,
        nRe = Object.keys(p.resupply || {}).length, nEx = (p.exempt || []).length, nDay = (p.days || []).length;
    if (st) st.textContent = "本机修复包：增量 " + nDay + " 天 · 人工纠正 " + nCorr + " · 就地修复 " + (nOh + nRe) + " 只 · 已确认 " + nEx;
    var stA = (window.WUFU_ST_ACTIVE ? window.WUFU_ST_ACTIVE() : null);
    var stLine = $("qckStLine");
    if (stLine) stLine.textContent = stA && stA.asof
      ? "ST 公告：截至 " + stA.asof + " · " + (stA.segments || []).length + " 段排除区间 · 随一键更新联网同步"
      : "ST 公告：暂无数据";
    var annLine = $("qckAnnLine");
    if (annLine) annLine.textContent = p.ann
      ? "公告期：截至 " + p.ann.end + " · 新增 " + p.ann.events + " 条公告 · 随一键更新同步；YTM 按当日收盘价实时折现、自动延伸"
      : "公告期：内嵌表（截至 2026-10-29），一键更新行情后自动延长；YTM 按当日收盘价实时折现、自动延伸";
    var scLine = $("qckScaleLine");
    if (scLine) scLine.textContent = p.scale
      ? "剩余规模：已更新至 " + p.scale.asof + "（" + p.scale.source + "）· 交易所日频"
      : "剩余规模：内嵌日频序列（截至 2026-10-29）· 点「更新剩余规模（日频）」";
    if (os) os.textContent = nOh ? "OHLC 修复 " + nOh + " 只（可撤销）" : "暂无 OHLC 修复记录";
    if (rp) { rp.style.display = ""; rp.innerHTML = WufuTheme.sub('<div style="font-size:11px;color:§WFT0003§;line-height:1.8;padding:8px 10px;background:§WFT0018§;border:1px solid §WFT0016§;border-radius:6px">') +
      "本机增量摘要（" + esc(p.ts || "尚无") + "）：增量交易日 " + nDay + " · 人工纠正 " + nCorr + " 条 · OHLC 修复 " + nOh + " 只 · 插值修复 " + nRe + " 只 · 序列互换 " + (p.swaps || []).length + " 组 · 已确认 " + nEx + " 条 · ST 公告 " + esc((stA && stA.asof) || "无") + WufuTheme.sub("。<br><span style='color:§WFT0025§'>联网增量写在本机；清除本机更新会回到内嵌原始数据。</span></div>"); }
    renderList(); renderCorrList();
    var cu = $("wufuCorrState"); if (cu) cu.textContent = nCorr ? "本机存有 " + nCorr + " 条人工纠正" : "暂无人工纠正";
  }

  /* ---------- 更新包导入/导出已移除：一键更新行情改为联网增量 ---------- */
  function clearPatch() {
    if (!confirm("清除本机全部更新与修复（回到内嵌原始数据）？")) return;
    [KP, KU, KS, KF, KL, KQ].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { } });
    /* 清掉体检中心顶栏日期，让它回到内嵌基线（避免「只升不降」保护把旧日期留着） */
    try { localStorage.removeItem("wufuHub_asof_cb_v1"); } catch (e) { }
    note("已清除，刷新中…"); setTimeout(function () { location.reload(); }, 600);
  }
  function undoLast() {
    var u = ls(KU, null);
    if (!u) { note("没有可撤销的上次更新。", true); return; }
    if (!confirm("撤销 " + u.ts + " 那次写入？页面将自动刷新。")) return;
    save(KP, u.p || empty()); try { localStorage.removeItem(KU); } catch (e) { }
    note("已撤销，刷新中…"); setTimeout(function () { location.reload(); }, 600);
  }
  /* ======================================================================
     一键更新行情 · 联网增量（替代原「导入更新包」）
     数据源（v0.69 方案甲 · 主源统一东财，腾讯只做失败兜底）：
       ① 东财 RPTA_WEB_KZZ_LS  逐日 FCLOSE / PUREBONDVALUE / SWAPOR（JSONP，按日期批量）
       ② 东财 push2his          开高低收 / 量额 / 换手率（f51–f61，K 线主源，逐只）
       ③ 腾讯 newfqkline        仅当 ② 失败时兜底（CORS *，逐只）
       ④ 东财公告              ST 实施 / 叠加 / 撤销公告（CORS *，按正股 50 只/批）
       ⑤ 三个基准股指（东财 push2his 主源，腾讯兜底）+ 自建等权指数
     结果写入本机 patch（p.days / p.st / p.report），刷新后由 applyPatch 回放。
     口径：公告日生效、完全撤销公告当日恢复；价格单位与内嵌数据一致（元 / 万元 / 手 / %）。
     东财 f56「手」/ f57「元」→ 万元 与腾讯 day[5]/day[8] 同口径；f61 即换手率 %。
     ====================================================================== */
  var NET_EM = "https://datacenter-web.eastmoney.com/api/data/v1/get";
  var NET_QQ = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get";
  var NET_ANN = "https://np-anotice-stock.eastmoney.com/api/security/ann";
  var EM_HOSTS_CB = ["push2his.eastmoney.com", "1.push2his.eastmoney.com",
    "7.push2his.eastmoney.com", "23.push2his.eastmoney.com", "48.push2his.eastmoney.com"];
  var EM_UT_CB = "fa5fd1943c7b386f172d6893dbfba10b";
  var netBusy = false;

  /* ======================================================================
     wufu-all-v26：公告期三项 / YTM / 剩余规模纳入本机增量
     · 公告期三项（提示强赎 / 到期赎回）随「一键更新行情」抓东财公告增量
     · YTM 条款静态，但按「当日收盘价」实时折现 → 新增交易日自动延伸
     · 剩余规模已升级为交易所日频：基线在 cb-extra.gz（深交所逐交易日 + 上交所事件日）
     · 「更新剩余规模（日频）」读同域 cb-scale-daily.json（整包重传时刷新）/ 导入本地快照
     上交所 commonQuery.do 与深交所 ShowReport 均校验 Referer，浏览器跨域直连会被拒，故抓取放在离线侧。
     ====================================================================== */
  var CB_ANN_OLD_END = "2026-10-29", lastCbAnnEvents = [], scaleBusy = false;
  function _snote(t, bad) { note(t, bad); qnote(t, bad); }
  function _cbAnnRaw() {
    if (!window.__WUFU_CB_ANN_BASE && window.WUFU_CB_ANN) {
      try { window.__WUFU_CB_ANN_BASE = JSON.parse(JSON.stringify(window.WUFU_CB_ANN)); } catch (e) { }
    }
    return window.__WUFU_CB_ANN_BASE || null;
  }
  function cbAnnClassify(t) {
    t = String(t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    var CBW = ["转债", "可转换公司债券", "可转换债券", "可转债"], ok = false, i;
    for (i = 0; i < CBW.length; i++) if (t.indexOf(CBW[i]) >= 0) ok = true;
    if (!ok) return "";
    var NOISE = ["核查意见", "法律意见", "独立财务", "受托管理", "评级公告", "募集资金", "理财产品",
                 "定期存款", "优先股", "现金管理", "结构性存款", "闲置", "券商", "会计师", "专项说明", "问询函", "监管"];
    for (i = 0; i < NOISE.length; i++) if (t.indexOf(NOISE[i]) >= 0) return "";
    var waive = ["不提前赎回", "不行使", "暂不", "放弃赎回", "不赎回", "暂不行使", "不行使提前赎回权利"];
    for (i = 0; i < waive.length; i++) if (t.indexOf(waive[i]) >= 0) return "waive";
    var expire = ["到期赎回", "到期兑付", "到期兑息", "期满", "兑付暨摘牌", "到期还本", "到期赎回结果", "兑付结果"];
    for (i = 0; i < expire.length; i++) if (t.indexOf(expire[i]) >= 0) return "expire";
    if (/赎回.{0,6}(实施|暨摘牌|结果|摘牌)|实施.{0,10}赎回|提前赎回|强制赎回|赎回及摘牌|赎回\(暨摘牌\)/.test(t)) return "force";
    var hint = ["可能满足", "预计满足", "满足赎回条件", "触发赎回条件", "有望满足", "或将满足"];
    for (i = 0; i < hint.length; i++) if (t.indexOf(hint[i]) >= 0) return "hint";
    return "";
  }
  function _prevISO(d) {
    var p = d.split("-"), x = new Date(+p[0], +p[1] - 1, +p[2]); x.setDate(x.getDate() - 1);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  /* 由「新增公告事件」生成 patch：未闭合段统一延长 + 仅存受新事件影响的代码 */
  function buildCbAnnPatch(evs, lastCal) {
    if (!_cbAnnRaw()) return null;
    var base = _cbAnnRaw(), changed = {}, touched = {};
    (evs || []).forEach(function (e) { (e.cbs || []).forEach(function (c) { touched[c] = 1; }); });
    Object.keys(touched).forEach(function (c) {
      var arr = (base[c] || []).map(function (g) { return [g[0], g[1], g[2]]; });
      var openHint = null, hasFE = false, q;
      for (q = 0; q < arr.length; q++) {
        if (arr[q][1] === CB_ANN_OLD_END) arr[q][1] = lastCal;   // 未闭合段续到新末日
        if (arr[q][2] === "hint" && arr[q][1] >= lastCal) openHint = q;
        if (arr[q][2] === "force" || arr[q][2] === "expire") hasFE = true;
      }
      var mine = (evs || []).filter(function (e) { return (e.cbs || []).indexOf(c) >= 0; })
        .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : (a.kind === "waive" ? -1 : 1)); });
      mine.forEach(function (e) {
        var d = e.date, k = e.kind;
        if (k === "hint") {
          if (openHint == null && !hasFE) { arr.push([d, lastCal, "hint"]); openHint = arr.length - 1; }
        } else if (k === "waive") {
          if (openHint != null) { arr[openHint][1] = d; openHint = null; }
        } else if (k === "expire" || k === "force") {
          if (openHint != null) { arr[openHint][1] = _prevISO(d); openHint = null; }
          if (!hasFE) { arr.push([d, lastCal, k]); hasFE = true; }
        }
      });
      changed[c] = arr;
    });
    return { asof: _todayISO(), oldEnd: CB_ANN_OLD_END, end: lastCal, extendAll: true, map: changed,
             events: (evs || []).length };
  }
  /* 把 p.ann / p.scale 合并进运行时对象；幂等，可在 cb-extra 加载后重复调用 */
  function mergeExtras(p) {
    var D = gD();
    try {
      var base = _cbAnnRaw();
      if (base) {
        var out = {};
        Object.keys(base).forEach(function (c) {
          out[c] = base[c].map(function (g) {
            var a = [g[0], g[1], g[2]];
            if (p.ann && p.ann.extendAll && a[1] === p.ann.oldEnd) a[1] = p.ann.end;
            return a;
          });
        });
        if (p.ann && p.ann.map) Object.keys(p.ann.map).forEach(function (c) {
          out[c] = p.ann.map[c].map(function (g) { return g.slice(); });
        });
        window.WUFU_CB_ANN = out;
      }
    } catch (e) { }
    try {
      var E = window.__CB_EXTRA;
      if (E && E.scale && p.scale && p.scale.points && D && D.calendar) {
        var cal = D.calendar, pos = {};
        cal.forEach(function (d, i) { pos[d] = i; });
        Object.keys(p.scale.points).forEach(function (c) {
          var a = E.scale[c] || (E.scale[c] = []);
          p.scale.points[c].forEach(function (pt) {
            var dt = String(pt[0]), i = pos[dt], j;
            // 日历尚未延伸到该月（还没点一键更新行情）时，绝不回填到过去的交易日 —— 避免前视
            if (i == null || !(pt[1] > 0)) return;
            var hit = false;
            for (j = 0; j < a.length; j++) if (a[j][0] === i) { a[j][1] = pt[1]; hit = true; break; }
            if (!hit) a.push([i, pt[1]]);
          });
          a.sort(function (x, y) { return x[0] - y[0]; });
        });
        E.calLast = p.scale.asof || E.calLast;
      }
    } catch (e) { }
    window.__WUFU_MERGE_DONE = true;
  }
  window.__WUFU_MERGE_EXTRA = function () { try { mergeExtras(P()); } catch (e) { } };
  /* 只读自检钩子：供自动化验证公告分型 / 区间状态机，不参与回测 */
  window.__WUFU_ANN_TEST = { classify: cbAnnClassify, build: buildCbAnnPatch, raw: _cbAnnRaw,
                             prev: _prevISO, oldEnd: CB_ANN_OLD_END };
  window.__WUFU_YTM_ASOF = function () {
    var D = gD(); return D && D.calendar && D.calendar.length ? D.calendar[D.calendar.length - 1] : "";
  };

  /* ---------- 更新剩余规模（日频）----------
     同域 cb/data/cb-scale-daily.json（整包重传时刷新）；无新数据时可导入本地快照。
     只存余额变化点：深市逐交易日、沪市有转股发生的交易日；无新记录的交易日 forward-fill。 */
  function _writeScale(obj, source) {
    var pts = obj && obj.points;
    if (!pts || !Object.keys(pts).length) { _snote("日频快照里没有可用的新交易日点，现有数据保持不变。", true); return false; }
    var p = P();
    var undoSnap = { ts: ts(), p: JSON.parse(JSON.stringify(p)) };
    p.scale = { asof: obj.asof || _todayISO(), source: source || "同域快照", points: pts };
    if (!W(p)) {
      _snote("⚠️ 本机存储写入失败：剩余规模没存进手机，刷新会回到旧数据。请先点「清除本机更新」释放空间，或导出整站离线包后重试。", true);
      return false;
    }
    if (!save(KU, undoSnap)) { try { localStorage.removeItem(KU); } catch (e) { } }
    mergeExtras(p);
    var n = 0; Object.keys(pts).forEach(function (c) { n += pts[c].length; });
    log("更新剩余规模", "", "ok", (obj.asof || "") + " · " + Object.keys(pts).length + " 只 / " + n + " 个日频变化点 · " + (source || ""));
    _snote("剩余规模已更新至 " + (obj.asof || "最新") + "：" + Object.keys(pts).length + " 只 / " + n + " 个日频变化点（已存入本机）。已即时生效。");
    renderState();
    return true;
  }
  async function scaleUpdate() {
    if (scaleBusy) return; scaleBusy = true;
    var btn = $("scaleUpd"); if (btn) btn.disabled = true;
    try {
      _snote("正在读取日频剩余规模快照…");
      var done = false, txt = "";
      /* v48：云端函数返回有效快照时优先用云端；没有或不通则静默回退包内快照 */
      if (window.WufuUpstream && window.WufuUpstream.isOn()) {
        try {
          var cu = window.WufuUpstream.functionUrl("scale");
          var cr = await fetch(cu, { cache: "no-store" });
          if (cr.ok) {
            var co = await cr.json();
            if (co && co.ok && co.asof && co.points && Object.keys(co.points).length)
              done = _writeScale(co, "云端快照");
          }
        } catch (e) { }
      }
      try {
        var u = new URL("data/cb-scale-daily.json", location.href).href;
        var r = await fetch(u, { cache: "no-store" });
        if (r.ok) txt = await r.text();
      } catch (e) { }
      if (!done && txt) {
        var o = null; try { o = JSON.parse(txt); } catch (e) { }
        if (o && o.asof) {
          var cur = (window.__CB_EXTRA && window.__CB_EXTRA.calLast) || CB_ANN_OLD_END;
          if (o.asof > cur) done = _writeScale(o, "同域日频快照");
          else _snote("日频快照（" + o.asof + "）不比当前数据（" + cur + "）新，无需更新。可点「导入本地快照」选更新的文件。");
        }
      }
      if (!done) {
        // 兜底：允许导入本地快照（同域文件缺失或过期时）
        var inp = document.createElement("input");
        inp.type = "file"; inp.accept = ".json,application/json";
        inp.style.display = "none"; document.body.appendChild(inp);
        inp.onchange = function () {
          var f = inp.files && inp.files[0]; if (!f) { document.body.removeChild(inp); return; }
          var rd = new FileReader();
          rd.onload = function () {
            try { var q = JSON.parse(String(rd.result)); _writeScale(q, "本地导入"); }
            catch (e) { _snote("快照解析失败：" + ((e && e.message) || e), true); }
            document.body.removeChild(inp);
          };
          rd.readAsText(f, "utf-8");
        };
        if (!txt || (txt && !done)) {
          // 直接弹出选择框；若同域快照已提示「无需更新」，也允许手动导入
          inp.click();
        }
      }
    } catch (e) { _snote("更新剩余规模失败：" + ((e && e.message) || e), true); }
    finally { scaleBusy = false; if (btn) btn.disabled = false; }
  }

  /* 即时回放：只把新增交易日写进当前 D，不整页刷新（大文件 reload 易 OOM），
     也不重跑 swaps/corrections（避免序列被二次互换）。刷新后仍由 applyPatch 从 patch 完整回放。 */
  function _appendDays(days) {
    var D = gD(); if (!D || !D.calendar || !D.series) return;
    var idx = {}; D.calendar.forEach(function (x, i) { idx[x] = i; });
    function setV(c, dt, f, v) { var sv = D.series[c]; if (!sv || !Array.isArray(sv[f])) return; var i = idx[dt]; if (i == null) return; sv[f][i] = v; }
    days.forEach(function (e) {
      if (!e.date) return; var i = idx[e.date];
      if (i == null) {
        D.calendar.push(e.date); i = D.calendar.length - 1; idx[e.date] = i;
        Object.keys(D.series).forEach(function (c) { FIELDS.forEach(function (f) { if (Array.isArray(D.series[c][f])) D.series[c][f].push(null); }); });
        Object.keys(D.index || {}).forEach(function (k) { var a = D.index[k]; if (Array.isArray(a)) { var v = (e.index && e.index[k] != null) ? e.index[k] : (a.length ? a[a.length - 1] : null); a.push(v); } });
      }
      if (e.index && D.index) Object.keys(e.index).forEach(function (k) { if (Array.isArray(D.index[k]) && e.index[k] != null) D.index[k][i] = e.index[k]; });
      Object.keys(e.series || {}).forEach(function (c) { var v = e.series[c]; Object.keys(v).forEach(function (f) { if (FIELDS.indexOf(f) >= 0) setV(c, e.date, f, v[f]); }); });
    });
    try { mergeExtras(P()); } catch (e) { }   // 日历延长后，让待生效的月度剩余规模点落地
  }
  function _num(x) { if (x == null || x === "") return null; var v = +x; return isFinite(v) ? v : null; }
  function _fmtLocal(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function _todayISO() { return _fmtLocal(new Date()); }
  function _nextDay(ds) { var p = ds.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + 1); return _fmtLocal(d); }
  function _q(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&"); }
  function _jsonp(url, ms) {
    var r = (window.WUFU_ROUTE ? window.WUFU_ROUTE(url) : url);
    /* 云端已把 JSONP 外壳剥掉，返回的就是纯 JSON，不必再注入 script */
    if (r !== url) return _getRaw(r, ms);
    return new Promise(function (res, rej) {
      var cb = "__wufuNet_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      var sc = document.createElement("script"), done = false, t = null;
      function clean() { done = true; if (t) clearTimeout(t); try { delete window[cb]; } catch (e) { window[cb] = null; } if (sc.parentNode) sc.parentNode.removeChild(sc); }
      window[cb] = function (o) { if (done) return; clean(); res(o); };
      t = setTimeout(function () { if (!done) { clean(); rej(new Error("请求超时")); } }, ms || 20000);
      sc.onerror = function () { if (!done) { clean(); rej(new Error("网络请求失败")); } };
      sc.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "callback=" + cb;
      document.head.appendChild(sc);
    });
  }
  function _getRaw(url, ms) {
    return new Promise(function (res, rej) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; rej(new Error("请求超时")); } }, ms || 15000);
      fetch(url, { credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (o) { if (done) return; done = true; clearTimeout(t); res(o); })
        .catch(function (e) { if (done) return; done = true; clearTimeout(t); rej(e); });
    });
  }
  /* v48：命中云端域名先走函数；函数不通就关掉云端并回退直连一次 */
  function _get(url, ms) {
    var r = (window.WUFU_ROUTE ? window.WUFU_ROUTE(url) : url);
    if (r === url) return _getRaw(url, ms);
    return _getRaw(r, ms).catch(function () {
      if (window.WufuUpstream) window.WufuUpstream.disable();
      return _getRaw(url, ms);
    });
  }
  async function _pool(items, limit, fn, onTick) {
    var i = 0, out = new Array(items.length);
    async function worker() {
      while (i < items.length) { var k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } if (onTick) onTick(k + 1, items.length); }
    }
    var ws = [], j; for (j = 0; j < Math.min(limit, items.length); j++) ws.push(worker());
    await Promise.all(ws); return out;
  }
  function _qqSym(code) { var n = String(code).split(".")[0]; return (String(code).slice(-2) === "SH" ? "sh" : "sz") + n; }
  async function _qqRows(sym, n) {
    var u = NET_QQ + "?param=" + encodeURIComponent(sym + ",day,,," + n + ",");
    var o = await _get(u, 15000), d = o && o.data && o.data[sym];
    return (d && (d.day || d.qfqday)) || [];
  }
  /* v0.69：东财 push2his 日 K 主源。返回格式与 _qqRows 完全一致：
     [日期, 开, 收, 高, 低, 成交量(手), , 换手率(%), 成交额(万元)] */
  function _emSecid(code) {
    var m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(String(code));
    if (!m) return null;
    return (m[2] === "SH" ? "1." : "0.") + m[1];
  }
  function _emKlineRaw(url, cbName, ms) {
    var r = (window.WUFU_ROUTE ? window.WUFU_ROUTE(url) : url);
    if (r !== url) return _getRaw(r, ms).then(function (j) { return (j && j.data && j.data.klines) || []; });
    return new Promise(function (res, rej) {
      var sc = document.createElement("script"), done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error("东财K线超时")); } }, ms || 12000);
      window[cbName] = function (j) {
        if (done) return; done = true; clearTimeout(t);
        try { delete window[cbName]; } catch (e) { window[cbName] = null; }
        res((j && j.data && j.data.klines) || []);
      };
      sc.onerror = function () { if (!done) { done = true; clearTimeout(t); rej(new Error("东财K线网络失败")); } };
      sc.src = url;
      document.head.appendChild(sc);
    });
  }
  async function _emKlineRows(code, n) {
    var secid = _emSecid(code);
    if (!secid) throw new Error("无东财 secid 映射");
    var lastErr = "";
    for (var i = 0; i < EM_HOSTS_CB.length; i++) {
      var cb = "__wufuEMK_" + Date.now().toString(36) + "_" + i;
      var q = "secid=" + encodeURIComponent(secid) + "&ut=" + EM_UT_CB +
        "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
        "&klt=101&fqt=0&end=20500101&lmt=" + n + "&cb=" + cb + "&_=" + Date.now();
      try {
        var kl = await _emKlineRaw("https://" + EM_HOSTS_CB[i] + "/api/qt/stock/kline/get?" + q, cb, 9000);
        if (kl.length) return kl.map(function (s) {
          var p = String(s).split(","), a = _num(p[6]);
          return [p[0], _num(p[1]), _num(p[2]), _num(p[3]), _num(p[4]), _num(p[5]),
                  null, _num(p[10]), (a != null ? a / 1e4 : null)];
        });
        lastErr = "空结果";
      } catch (e) { lastErr = (e && e.message) || "不可用"; }
    }
    throw new Error(lastErr || "东财K线全部子域不可用");
  }
  async function _emRows(since, prog) {
    var out = [], page = 1, pages = 1;
    do {
      var q = { reportName: "RPTA_WEB_KZZ_LS", columns: "ALL", filter: "(DATE>='" + since + "')",
                pageNumber: String(page), pageSize: "500", sortColumns: "DATE", sortTypes: "1", source: "WEB", client: "WEB" };
      var o = await _jsonp(NET_EM + "?" + _q(q), 20000), r = o && o.result;
      if (!r || !r.data) break;
      pages = r.pages || 1; out = out.concat(r.data);
      prog("价值分析 " + page + "/" + pages + " 页 · " + out.length + " 行");
      page++;
    } while (page <= pages && page <= 60);
    return out;
  }
  function _stClassify(t) {
    if (!t) return "";
    var noise = ["监管函", "关注函", "问询函", "评级机构", "关于关注", "专项说明", "预审计", "异常波动", "可能被", "预计", "风险提示公告", "进展"];
    for (var i = 0; i < noise.length; i++) if (t.indexOf(noise[i]) >= 0) return "";
    if (/第[一二三四五六七八九十\d]+次.*提示/.test(t)) return "";
    if (t.indexOf("撤销") >= 0) return "撤销";
    if (t.indexOf("叠加") >= 0 && /实施|实行/.test(t)) return "叠加实施";
    if (/(实施|实行|触发)/.test(t) && /(风险警示|特别处理)/.test(t)) return "实施(变ST)";
    return "";
  }
  function _stFullRemove(t) {
    if (t.indexOf("申请撤销") >= 0) return false;
    return /(撤销)/.test(t) && !/(继续|部分|并实施|并被实行|叠加|及继续|进展|申请)/.test(t);
  }
  async function _annEvents(since, today, prog) {
    var mp = (window.WUFU_ST_NET || {}).map || {}, stocks = Object.keys(mp), batches = [], k;
    for (k = 0; k < stocks.length; k += 50) batches.push(stocks.slice(k, k + 50));
    var rs = await _pool(batches, 6, async function (b, bi) {
      var page = 1, pages = 1, rows = [];
      do {
        var u = NET_ANN + "?sr=-1&page_size=100&page_index=" + page + "&ann_type=A&client_source=web&stock_list=" +
                encodeURIComponent(b.join(",")) + "&begin_time=" + since + "&end_time=" + today;
        var o = await _get(u, 15000), d = o && o.data; if (!d) break;
        pages = Math.max(1, Math.ceil((d.total_hits || 0) / 100));
        rows = rows.concat(d.list || []); page++;
      } while (page <= pages && page <= 10);
      prog("ST 公告 " + (bi + 1) + "/" + batches.length + " 批");
      return rows;
    });
    var evs = [], cbEvs = [], seen = {}, stMap = (window.WUFU_ST_NET || {}).map || {};
    (rs || []).forEach(function (list) { (list || []).forEach(function (x) {
      var title = String(x.title || "").trim(), date = String(x.notice_date || "").slice(0, 10), art = String(x.art_code || "");
      var key = date + "|" + art; if (!date || !art || seen[key]) return; seen[key] = 1;
      // 公告期三项（提示强赎 / 不赎回恢复 / 到期赎回 / 实施强赎）：与 ST 共用同一批公告行
      var ckind = cbAnnClassify(title);
      if (ckind) {
        var cbs = [];
        (x.codes || []).forEach(function (cc) {
          var st = String(cc.stock_code || "").trim();
          (stMap[st] || []).forEach(function (b) { if (cbs.indexOf(b) < 0) cbs.push(b); });
        });
        if (cbs.length) cbEvs.push({ date: date, kind: ckind, title: title, cbs: cbs, aid: "EM:" + art });
      }
      var kind = _stClassify(title); if (!kind) return;
      (x.codes || []).forEach(function (cc) {
        var st = String(cc.stock_code || "").trim(); if (st) evs.push({ stock: st, date: date, kind: kind, title: title, aid: "EM:" + art });
      });
    }); });
    evs.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    lastCbAnnEvents = cbEvs;
    return evs;
  }
  function _stApply(base, evs, cal, lastCal, D, byDate, dates) {
    var st = JSON.parse(JSON.stringify(base || { segments: [], asof: "", events_total: 0 }));
    var idx = {}; cal.forEach(function (d, i) { idx[d] = i; });
    function nextTd(d) { for (var i = 0; i < cal.length; i++) if (cal[i] >= d) return cal[i]; return null; }
    function prevTd(d) { for (var i = cal.length - 1; i >= 0; i--) if (cal[i] < d) return cal[i]; return null; }
    var mp = (window.WUFU_ST_NET || {}).map || {}, names = (window.WUFU_ST_NET || {}).names || {};
    var segs = (st.segments || []).filter(function (g) { return g && g.c && g.s; }).map(function (g) { var o = Object.assign({}, g); delete o._drop; return o; });
    segs.forEach(function (g) { if (g.still === "是") { g.e = lastCal; g.days = (idx[g.e] - idx[g.s] + 1) || g.days; } });
    function cbLast(c) {
      var last = null, a = D.series[c] && D.series[c].close;
      if (a) { for (var i = Math.min(a.length, D.calendar.length) - 1; i >= 0; i--) if (a[i] != null && a[i] > 0) { last = D.calendar[i]; break; } }
      dates.forEach(function (dt) { var o = byDate[dt] && byDate[dt][c]; if (o && o.close != null && o.close > 0) last = dt; });
      return last;
    }
    evs.forEach(function (e) {
      var cbs = mp[e.stock] || []; if (!cbs.length) return;
      cbs.forEach(function (cb) {
        var last = cbLast(cb); if (last && e.date > last) return;               // 退市后的公告不生效
        if (e.kind === "实施(变ST)" || e.kind === "叠加实施") {
          var open = segs.some(function (g) { return g.c === cb && g.still === "是" && g.s <= e.date; });
          if (open) return;
          var s = nextTd(e.date); if (!s || idx[s] == null) return;
          segs.push({ c: cb, s: s, e: lastCal, name: names[cb] || cb, stock: e.stock, seg: 1,
                      sa: e.date, ra: "", aid: e.aid, still: "是", days: idx[lastCal] - idx[s] + 1 });
        } else if (e.kind === "撤销" && _stFullRemove(e.title)) {
          segs.forEach(function (g) {
            if (g.c === cb && g.still === "是" && g.s <= e.date) {
              var pe = prevTd(e.date);
              if (pe && idx[pe] != null && idx[pe] >= idx[g.s]) { g.e = pe; g.days = idx[pe] - idx[g.s] + 1; g.still = "否"; g.ra = e.date; }
              else g._drop = 1;
            }
          });
        }
      });
    });
    st.segments = segs.filter(function (g) { return !g._drop; });
    st.asof = _todayISO(); st.calendar_end = lastCal; st.rule = "事件配对(摘帽恢复)";
    st.events_total = (st.events_total || 0) + evs.length; st.segment_count = st.segments.length;
    st["说明"] = "实施/叠加公告当日起排除，完全撤销公告当日起恢复；公告日之前不排除，无前视；随一键更新行情联网增量同步";
    return st;
  }


  /* ---------- 标的池动态更新：品种识别 / 名录 / 单债全历史 / 安装 ----------
     · 普通可转债代码段 110/111/113/118/123/125/126/127/128/129，后缀仅 SH/SZ
     · 名称含 EB / KEB / 定转 / 定N / 退债 一律排除（可交换债、定向转债、退市后转让）
     · 新上市普通转债逐只拉东财价值分析全历史 + 腾讯 K 线全历史，写 p.newSeries
     · 结果随 patch 持久化，刷新由 applyPatch 回放，清除本机更新即回退到内嵌池
     ====================================================================== */
  var CB_PLAIN_PFX = ["110","111","113","118","123","125","126","127","128","129"];
  function _isPlainCB(secucode, name) {
    var m = /^(\d{6})\.(SH|SZ)$/.exec(String(secucode || ""));
    if (!m) return false;
    if (CB_PLAIN_PFX.indexOf(m[1].slice(0, 3)) < 0) return false;
    var nm = String(name || "");
    if (/EB|KEB|定转|定\d|退债|退$/.test(nm)) return false;
    return true;
  }
  async function _cbList(prog) {
    var out = {}, page = 1, pages = 1;
    var cols = "SECURITY_CODE,SECUCODE,SECURITY_NAME_ABBR,LISTING_DATE,RATING,ACTUAL_ISSUE_SCALE,CONVERT_STOCK_CODE,EXPIRE_DATE,DELIST_DATE,TRADE_MARKET";
    do {
      var q = { reportName: "RPT_BOND_CB_LIST", columns: cols, pageNumber: String(page), pageSize: "500",
                sortColumns: "SECURITY_CODE", sortTypes: "1", source: "WEB", client: "WEB" };
      var o = await _get(NET_EM + "?" + _q(q), 20000), r = o && o.result;
      if (!r || !r.data) break;
      pages = r.pages || 1;
      r.data.forEach(function (x) { var c = String(x.SECUCODE || ""); if (c) out[c] = x; });
      if (prog) prog("转债名录 " + page + "/" + pages + " 页");
      page++;
    } while (page <= pages && page <= 10);
    return out;
  }
  async function _oneHist(c) {
    var out = {}, page = 1, pages = 1;
    do {
      var q = { reportName: "RPTA_WEB_KZZ_LS", columns: "ALL", filter: '(SECUCODE="' + c + '")',
                pageNumber: String(page), pageSize: "500", sortColumns: "DATE", sortTypes: "1",
                source: "WEB", client: "WEB" };
      var o = await _jsonp(NET_EM + "?" + _q(q), 20000), r = o && o.result;
      if (!r || !r.data) break;
      pages = r.pages || 1;
      r.data.forEach(function (x) {
        var dt = String(x.DATE || "").slice(0, 10); if (!dt) return;
        var o2 = {}, v;
        v = _num(x.FCLOSE); if (v != null) o2.close = v;
        v = _num(x.PUREBONDVALUE); if (v != null) o2.nav = v;
        v = _num(x.SWAPOR); if (v != null) o2.premium = v;
        out[dt] = o2;
      });
      page++;
    } while (page <= pages && page <= 8);
    return out;
  }
  /* rows 紧凑格式：[日期, close, nav, premium, open, high, low, volume, amount, turnover] */
  function _installNewSeries(D, ns) {
    if (!D || !D.series || !D.calendar || !ns) return;
    var keys = Object.keys(ns); if (!keys.length) return;
    var idx = {}; D.calendar.forEach(function (x, i) { idx[x] = i; });
    var baseLen = D.calendar.length;
    function firstIdx(ds) { if (!ds) return -1; for (var i = 0; i < D.calendar.length; i++) if (D.calendar[i] >= ds) return i; return -1; }
    window.WUFU_NEWCODES = window.WUFU_NEWCODES || {};
    keys.forEach(function (c) {
      var e = ns[c]; if (!e) return;
      if (!D.series[c]) {
        var o = {}; FIELDS.forEach(function (f) { o[f] = new Array(baseLen).fill(null); });
        D.series[c] = o;
      }
      var sv = D.series[c];
      (e.rows || []).forEach(function (r) {
        var i = idx[r[0]]; if (i == null || !sv) return;
        var pairs = [[1,"close"],[2,"nav"],[3,"premium"],[4,"open"],[5,"high"],[6,"low"],[7,"volume"],[8,"amount"],[9,"turnover"]];
        for (var k = 0; k < pairs.length; k++) if (r[pairs[k][0]] != null && Array.isArray(sv[pairs[k][1]])) sv[pairs[k][1]][i] = r[pairs[k][0]];
      });
      window.WUFU_NEWCODES[c] = true;
      var item = { code: c, name: e.name || c, group: "新纳入" };
      if (D.pool && !D.pool.some(function (p) { return p.code === c; })) D.pool.push(item);
      if (window.WUFU_POOL && window.WUFU_POOL !== D.pool && !window.WUFU_POOL.some(function (p) { return p.code === c; })) window.WUFU_POOL.push(item);
      var m = e.m || {};
      try { if (window.WUFU_CBMETA) window.WUFU_CBMETA[c] = { l: m.l || "", i: m.i != null ? m.i : null }; } catch (er) { }
      try {
        if (window.WUFU_CBM) {
          var ri = -1;
          if (window.WUFU_CBN && window.WUFU_CBN.rat) ri = window.WUFU_CBN.rat.indexOf(m.rat);
          window.WUFU_CBM[c] = [-1, -1, ri, 0, -1, firstIdx(m.l)];
        }
      } catch (er) { }
      try {
        var ei = firstIdx(m.exp);
        if (ei < 0 && m.exp) {
          var last = D.calendar[D.calendar.length - 1];
          var dd = (Date.parse(m.exp) - Date.parse(last)) / 86400000;
          if (isFinite(dd) && dd > 0) ei = D.calendar.length + Math.round(dd / 365 * 243);
        }
        if (window.WUFU_CBEXPI && ei >= 0) window.WUFU_CBEXPI[c] = ei;
      } catch (er) { }
      try { if (window.WUFU_FIRSTDATE && e.rows && e.rows.length) window.WUFU_FIRSTDATE[c] = e.rows[0][0]; } catch (er) { }
      try {
        if (m.stk && window.WUFU_ST_NET && window.WUFU_ST_NET.map) {
          var mp = window.WUFU_ST_NET.map; var a = mp[m.stk] || (mp[m.stk] = []);
          if (a.indexOf(c) < 0) a.push(c);
          if (window.WUFU_ST_NET.names) window.WUFU_ST_NET.names[c] = e.name || c;
        }
      } catch (er) { }
      if (window.WUFU_CBN && window.WUFU_CBN.names) { }
    });
  }

  async function netUpdate() {
    if (netBusy) return;
    var D = gD();
    if (!D || !D.calendar || !D.series) { qnote("行情数据尚未加载完成，请稍候再点「一键更新行情」。", true); note("行情数据尚未加载完成，请稍候再点。", true); return; }
    netBusy = true;
    var btns = [$("qckUpdate"), $("wufuUpdRun")]; btns.forEach(function (b) { if (b) b.disabled = true; });
    var state = $("wufuUpdState"), bar = $("wufuUpdBar"), fill = $("wufuUpdFill");
    function prog(t, bad) { if (state) state.textContent = t; qnote(t, bad); note(t, bad); }
    function pbar(v) { if (bar) bar.style.display = ""; if (fill) fill.style.width = Math.round(v * 100) + "%"; }
    try {
      var oldCal = D.calendar.slice(), last0 = oldCal[oldCal.length - 1], since = _nextDay(last0), today = _todayISO();
      if (since > today) { prog("已是最新：数据止于 " + last0 + "，今天 " + today + " 尚无新交易日。"); return; }
      prog("正在联网更新行情（" + since + " → " + today + "）…"); pbar(0.04);
      // ① 东财逐日价值分析：收盘价 / 债底 / 转股溢价率
      var rows = await _emRows(since, function (t) { prog(t); });
      var byDate = {}, dates = [], newCodes = {}, newNames = {};
      rows.forEach(function (r) {
        var dt = String(r.DATE || "").slice(0, 10), c = String(r.SECUCODE || "");
        if (!dt || dt < since || dt > today) return;
        if (!D.series[c]) { newCodes[c] = 1; newNames[c] = String(r.BOND_NAME_ABBR || ""); return; }
        if (!byDate[dt]) { byDate[dt] = {}; dates.push(dt); }
        var o = {}, v;
        v = _num(r.FCLOSE); if (v != null) o.close = v;
        v = _num(r.PUREBONDVALUE); if (v != null) o.nav = v;
        v = _num(r.SWAPOR); if (v != null) o.premium = v;
        byDate[dt][c] = o;
      });
      // ①b 标的池动态更新：池外代码按品种分流，普通可转债拉全历史后纳入
      var allNew = Object.keys(newCodes), addCodes = [], excluded = [];
      allNew.forEach(function (c) { (_isPlainCB(c, newNames[c]) ? addCodes : excluded).push(c); });
      var cbList = {};
      try { cbList = await _cbList(function (t) { prog(t); }); } catch (e) { }
      var newHist = {};
      if (addCodes.length) {
        var hs = await _pool(addCodes, 6, async function (c) {
          return { c: c, em: await _oneHist(c), qq: await _qqRows(_qqSym(c), 1000) };
        }, function (d, tot) { if (d % 20 === 0 || d === tot) prog("新债全历史 " + d + "/" + tot + " 只…"); });
        (hs || []).forEach(function (x) {
          if (!x) return;
          var c = x.c, rm = {};
          Object.keys(x.em || {}).forEach(function (dt) {
            var v = x.em[dt]; rm[dt] = [dt, v.close != null ? v.close : null, v.nav != null ? v.nav : null,
                                       v.premium != null ? v.premium : null, null, null, null, null, null, null];
          });
          (x.qq || []).forEach(function (row) {
            var dt = String(row[0] || ""); if (!dt) return;
            var r = rm[dt] || (rm[dt] = [dt, null, null, null, null, null, null, null, null, null]);
            r[4] = _num(row[1]); if (r[1] == null) r[1] = _num(row[2]);
            r[5] = _num(row[3]); r[6] = _num(row[4]); r[7] = _num(row[5]);
            r[8] = _num(row[8]); r[9] = _num(row[7]);
          });
          var mm = cbList[c] || {};
          var meta = { name: String(mm.SECURITY_NAME_ABBR || newNames[c] || c), l: String(mm.LISTING_DATE || "").slice(0, 10),
                       i: _num(mm.ACTUAL_ISSUE_SCALE), rat: String(mm.RATING || ""),
                       stk: String(mm.CONVERT_STOCK_CODE || ""), exp: String(mm.EXPIRE_DATE || "").slice(0, 10) };
          var keys = Object.keys(rm).sort();
          newHist[c] = { name: meta.name, m: meta, rows: keys.map(function (k) { return rm[k]; }) };
          // 增量日数据并入 byDate，供 p.days / 即时回放使用
          keys.forEach(function (dt) {
            if (dt < since || dt > today) return;
            if (!byDate[dt]) { byDate[dt] = {}; if (dates.indexOf(dt) < 0) dates.push(dt); }
            var r = rm[dt], o = {};
            var pairs = [[1,"close"],[2,"nav"],[3,"premium"],[4,"open"],[5,"high"],[6,"low"],[7,"volume"],[8,"amount"],[9,"turnover"]];
            for (var k = 0; k < pairs.length; k++) if (r[pairs[k][0]] != null) o[pairs[k][1]] = r[pairs[k][0]];
            byDate[dt][c] = o;
          });
        });
      }
      dates.sort();
      if (!dates.length) { prog("已是最新：数据源还没有 " + since + " 之后的交易日。"); return; }
      pbar(0.18);
      // ② K 线：东财 push2his 主源（f51–f61），腾讯 newfqkline 仅失败兜底
      var codes = {};
      dates.forEach(function (dt) { Object.keys(byDate[dt]).forEach(function (c) { if (addCodes.indexOf(c) < 0) codes[c] = 1; }); });
      ["518880.SH", "511010.SH", "511990.SH"].forEach(function (c) { if (D.series[c]) codes[c] = 1; });
      var list = Object.keys(codes), n = Math.min(30, Math.max(10, dates.length + 3)), qqFail = 0;
      var emOk = 0, qqFallback = 0;
      var kres = await _pool(list, 8, async function (c) {
        try { return { c: c, arr: await _emKlineRows(c, n), src: "EM" }; }
        catch (e) { return { c: c, arr: await _qqRows(_qqSym(c), n), src: "QQ" }; }
      },
        function (d, tot) { if (d % 40 === 0 || d === tot) prog("行情 K 线 " + d + "/" + tot + " 只…"); pbar(0.18 + 0.42 * d / tot); });
      kres.forEach(function (x) {
        if (!x || !x.arr || !x.arr.length) { qqFail++; return; }
        if (x.src === "EM") emOk++; else qqFallback++;
        x.arr.forEach(function (row) {
          var dt = String(row[0] || ""); if (dt < since || dt > today) return;
          if (!byDate[dt]) { byDate[dt] = {}; if (dates.indexOf(dt) < 0) dates.push(dt); }
          var o = byDate[dt][x.c] || (byDate[dt][x.c] = {}), v;
          v = _num(row[1]); if (v != null) o.open = v;
          v = _num(row[2]); if (v != null && o.close == null) o.close = v;
          v = _num(row[3]); if (v != null) o.high = v;
          v = _num(row[4]); if (v != null) o.low = v;
          v = _num(row[5]); if (v != null) o.volume = v;
          v = _num(row[7]); if (v != null) o.turnover = v;
          v = _num(row[8]); if (v != null) o.amount = v;
        });
      });
      dates.sort(); pbar(0.64);
      // ③ 基准：三个股指（腾讯）+ 可转债等权（按日等权收益续接）
      var idxSym = { "000300.SH": "sh000300", "000852.SH": "sh000852", "399303.SZ": "sz399303" };
      var ires = await _pool(Object.keys(idxSym), 3, async function (k) {
        try { return { k: k, arr: await _emKlineRows(k, n) }; }
        catch (e) { return { k: k, arr: await _qqRows(idxSym[k], n) }; }
      });
      var idxRows = {};
      ires.forEach(function (x) { if (x) (x.arr || []).forEach(function (r) { if (!idxRows[r[0]]) idxRows[r[0]] = {}; var v = _num(r[2]); if (v != null) idxRows[r[0]][x.k] = v; }); });
      var eqPrev = (D.index && D.index["index_CBALL"] && D.index["index_CBALL"].length) ? D.index["index_CBALL"][D.index["index_CBALL"].length - 1] : null;
      var prevClose = {};
      Object.keys(D.series).forEach(function (c) { var a = D.series[c].close; if (a) { for (var i = Math.min(a.length, oldCal.length) - 1; i >= 0; i--) if (a[i] != null && a[i] > 0) { prevClose[c] = a[i]; break; } } });
      var idxNew = {};
      dates.forEach(function (dt) {
        var o = {};
        Object.keys(idxSym).forEach(function (k) { if (idxRows[dt] && idxRows[dt][k] != null) o[k] = idxRows[dt][k]; });
        var rets = [];
        Object.keys(byDate[dt] || {}).forEach(function (c) { var v = byDate[dt][c].close; if (v != null && v > 0 && prevClose[c] != null && prevClose[c] > 0) rets.push(v / prevClose[c] - 1); });
        if (rets.length && eqPrev != null) { var avg = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length; eqPrev = eqPrev * (1 + avg); o["index_CBALL"] = eqPrev; }
        Object.keys(byDate[dt] || {}).forEach(function (c) { var v = byDate[dt][c].close; if (v != null && v > 0) prevClose[c] = v; });
        idxNew[dt] = o;
      });
      pbar(0.78);
      // ④ ST 公告增量（失败不阻断行情）
      var stErr = "", stNew = null, evs = [];
      try {
        var stBase = (window.WUFU_ST_ACTIVE ? window.WUFU_ST_ACTIVE() : null) || window.WUFU_ST_BASE || null;
        var stSince = (stBase && stBase.asof && stBase.asof < today) ? stBase.asof : since;
        evs = await _annEvents(stSince, today, function (t) { prog(t); });
        var newCal = oldCal.concat(dates).sort(), lastCal = newCal[newCal.length - 1];
        stNew = _stApply(stBase, evs, newCal, lastCal, D, byDate, dates);
      } catch (e) { stErr = (e && e.message) || String(e); }
      // ④b 公告期三项增量：未闭合段续到新末日 + 新公告按状态机开闭区间
      var annNew = null, annErr = "", annCnt = (lastCbAnnEvents || []).length;
      try {
        var newCalA = oldCal.concat(dates).sort(), lastCalA = newCalA[newCalA.length - 1];
        annNew = buildCbAnnPatch(lastCbAnnEvents, lastCalA);
      } catch (e) { annErr = (e && e.message) || String(e); }
      pbar(0.92);
      // ⑤ 写本机 patch（与离线修复包同一结构，刷新后自动回放）
      var days = dates.map(function (dt) { return { date: dt, base: "EM_RPTA_WEB_KZZ_LS+QQ", series: byDate[dt] || {}, index: idxNew[dt] || {} }; });
      var p = P();
      var undoSnap = { ts: ts(), p: JSON.parse(JSON.stringify(p)) };  /* 旧版先在内存留一份 */
      var dayMap = {};
      (p.days || []).concat(days).forEach(function (e) { dayMap[e.date + "|" + (e.base || "")] = e; });
      p.days = Object.keys(dayMap).map(function (k) { return dayMap[k]; }).sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; }).slice(-240);
      if (stNew) p.st = stNew;
      if (annNew) p.ann = annNew;
      p.newSeries = p.newSeries || {};
      Object.keys(newHist).forEach(function (c) { p.newSeries[c] = newHist[c]; });
      p.excludedCodes = excluded;
      p.report = { ts: ts(), dates: dates, ok: list.length - qqFail, skip: qqFail, fail: 0,
                   net: { em_rows: rows.length, kline_em: emOk, kline_qq_fallback: qqFallback,
                          kline_qq_fail: qqFail, new_codes: Object.keys(newCodes),
                          added_codes: Object.keys(newHist), excluded_codes: excluded,
                          st_events: evs.length, st_err: stErr,
                          ann_events: annCnt, ann_err: annErr } };
      var wrote = W(p);
      /* v46：大仓库写入是异步的，必须等它真落盘才报成功，绝不假装已保存 */
      if (wrote && window.WufuStore && WufuStore.flush) {
        try {
          var _fr = await WufuStore.flush();
          if (!_fr.ok) { wrote = false; window.__WUFU_SAVE_FAIL = true; }
        } catch (e) { wrote = false; window.__WUFU_SAVE_FAIL = true; }
      }
      if (!wrote) {
        prog("⚠️ 本次更新没能存进手机（浏览器存储写入失败）：刷新后会回到旧数据。请确认没开无痕/隐私模式，或先「导出整站离线包」保存，再重试。本机数据未改动。", true);
        note("本机存储写入失败，本次更新未保存。", true);
        log("联网更新行情", "", "err", "本机存储写入失败（容量不足），数据未落盘");
        return;
      }
      /* 撤销快照放主写入之后，写不下就丢弃，不抢占主数据的空间 */
      if (!save(KU, undoSnap)) {
        try { localStorage.removeItem(KU); } catch (e) { }
        log("联网更新行情", "", "warn", "撤销快照未存下（不影响本次更新）");
      }
      try { mergeExtras(p); } catch (e) { }
      log("联网更新行情", "", "ok", "新增 " + dates.length + " 天 · 价值分析 " + rows.length + " 行 · K线 " + list.length + " 只 · ST 事件 " + evs.length + " 条 · 公告期 " + annCnt + " 条 · YTM 延伸至 " + dates[dates.length - 1]);
      var msg = "联网更新完成：新增 " + dates.length + " 个交易日（" + dates[0] + " → " + dates[dates.length - 1] + "）· K 线 " +
                (list.length - qqFail) + "/" + list.length + " 只（东财 " + emOk + " / 腾讯兜底 " + qqFallback + "）· ST 公告 " + evs.length + " 条" +
                (stErr ? "（公告源异常：" + stErr + "，行情已更新）" : "") +
                (Object.keys(newHist).length ? " · 新纳入 " + Object.keys(newHist).length + " 只普通转债" : "") +
                (excluded.length ? " · 排除 " + excluded.length + " 只（可交换债 / 定向转债 / 非沪深）" : "") +
                " · 公告期 " + annCnt + " 条" + (annErr ? "（公告增量异常：" + annErr + "）" : "") +
                " · YTM 按当日收盘价自动延伸至 " + dates[dates.length - 1] +
                "。已存入本机大仓库，即时生效，无需刷新。";
      try { _installNewSeries(D, p.newSeries); } catch (e) { log("动态扩池", "", "warn", "即时安装失败：" + ((e && e.message) || e)); }
      try { _appendDays(days); } catch (e) { log("联网更新行情", "", "warn", "即时回放失败：" + ((e && e.message) || e)); }
      try {
        var lc = D.calendar[D.calendar.length - 1];
        if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.paint("cb", lc);
        else { var bd = $("dbDate"); if (bd) bd.textContent = "数据 " + D.calendar[0] + " → " + lc; }
      } catch (e) { }
      updateLine(); renderState(); fillCorrCodes();
      prog(msg); pbar(1);
    } catch (e) {
      var m = (e && e.message) || String(e);
      prog("联网更新失败：" + m + "。本机数据未改动，可重试。", true);
      log("联网更新行情", "", "err", m);
    } finally {
      // [交易日历] 行情补到新交易日后，顺带静默刷新一次日历（已发生段以 K 线为准）
      try { if (window.odRefreshCal) await window.odRefreshCal(true); } catch (e) { }
      netBusy = false; btns.forEach(function (b) { if (b) b.disabled = false; });
    }
  }

  /* ---------- 傻瓜入口：一键修复 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function collect() {
    var out = [], seen = {};
    Array.prototype.forEach.call(document.querySelectorAll("#hlCards .hlfixbtn"), function (b) {
      var act = b.getAttribute("data-act") || "resupply", id = b.getAttribute("data-id") || "";
      if (act === "exempt" || act === "manual" || act === "fyfactor") return;
      var codes = String(b.getAttribute("data-codes") || "").split(",").filter(Boolean);
      var ab = String(b.getAttribute("data-ab") || "").split("|").filter(Boolean);
      var k = id + "|" + act + "|" + codes.join(","); if (seen[k]) return; seen[k] = 1;
      out.push({ id: id, act: act, codes: codes, ab: ab });
    });
    return out;
  }
  var fixing = false;
  async function doFix() {
    if (fixing) return; fixing = true;
    var btn = $("qckFix"); if (btn) btn.disabled = true;
    var fixed = 0, skipped = [], pts = 0;
    try {
      save(KS, { ts: ts(), p: P() }); undoLine();
      if (!window.HealthView) throw new Error("体检模块未加载，请刷新页面");
      var ok = window.HealthView.run();
      if (ok === false) { await sleep(2500); window.HealthView.run(); }
      await sleep(350);
      var tasks = collect();
      qnote("体检完成，共 " + tasks.length + " 项待处理，正在本地修复…");
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (!t.codes.length && t.act !== "swap") { skipped.push(t.id + "（无可修标的）"); continue; }
        try {
          var res;
          if (t.act === "fixohlc") res = await F.fix(t.codes);
          else if (t.act === "swap") { if (t.ab.length < 2) throw new Error("缺少互串 pair"); F.swap(t.ab[0], t.ab[1], false); res = [{ n: 1 }]; }
          else if (t.act === "refactor") { F.refactor(t.codes); res = []; }
          else res = await F.resupply(t.codes, t.id);
          var got = (res || []).reduce(function (s, x) { return s + (x && x.n ? x.n : 0); }, 0);
          pts += got; if (got > 0) fixed++;
          qnote("正在修复 " + (i + 1) + "/" + tasks.length + " · " + t.id + "（实际改 " + pts + " 个点）…");
        } catch (e) { skipped.push(t.id + "（" + ((e && e.message) || e) + "）"); }
      }
      try { window.HealthView.run(); } catch (e) { }
      await sleep(400);
      var rest = collect().length;
      var rec = { ts: ts(), fixed: pts, tasks: fixed, remain: rest + skipped.length, nav: "", official: "", skipped: skipped };
      save(KF, rec); fixLine(); undoLine(); renderState();
      qnote(pts > 0
        ? "修复完成：实际改好 " + pts + " 个数据点（" + fixed + " 项有改动）· 还有 " + rec.remain + " 项需人工确认。需确认项只列清单、不自动改写，点「查看完整明细」看报告。"
        : "修复完成：这次没有可自动修的数据点 · 还有 " + rec.remain + " 项需人工确认。点「查看完整明细」看报告。");
      log("一键修复数据", "", "ok", "实际改 " + pts + " 个数据点 / " + rec.remain + " 项需确认");
      if (window.__WUFU_SAVE_FAIL) qnote("⚠️ 本机存储写入失败：以上修复刷新后会丢失。请先点「清除本机更新」释放空间，再重试。", true);
    } catch (e) { qnote("修复中断：" + ((e && e.message) || e) + "。已改部分可用「撤销上次修复」回退。", true); }
    finally { if (btn) btn.disabled = false; fixing = false; }
  }
  function updateLine() {
    var e = $("qckUpdateLine"); if (!e) return;
    var last = (function(){ try { return (window.WufuHub && window.WufuHub.DateSync && window.WufuHub.DateSync.current("cb")) || "—"; } catch (e) { return "—"; } })();
    var p = P(), r = p.report;
    e.textContent = r ? "上次更新：" + (r.ts || "—") + " · 新增 " + ((r.dates || []).length) + " 天 · 当前数据止 " + last
                      : "上次更新：暂无记录 · 当前数据止 " + last;
  }
  function fixLine() {
    var e = $("qckFixLine"); if (!e) return;
    var f = ls(KF, null);
    if (!f) { e.textContent = "上次修复：暂无记录"; return; }
    e.innerHTML = "上次修复：" + f.ts + WufuTheme.sub(" · <b style='color:§WFT0012§'>实际改好 ") + f.fixed + " 个数据点</b> · " +
      (f.remain ? WufuTheme.sub("<b style='color:§WFT0014§'>") + f.remain + " 处需确认</b>" : WufuTheme.sub("<b style='color:§WFT0012§'>0 处需确认</b>"));
  }
  function undoLine() {
    var b = $("qckUndo"), s = $("qckUndoNote"), snap = ls(KS, null);
    if (b) b.disabled = !snap;
    if (s) s.textContent = snap ? "可撤销 " + snap.ts + " 那次一键修复" : "尚无修复记录";
  }

  /* ---------- 修复中心（队列 / 时间线 / KPI） ---------- */
  var FC = {
    render: function () {
      var k = $("fcKpis"), q = $("fcQueue"), l = $("fcLog"); if (!k || !q) return;
      var p = P(), todo = [], done = [], exempt = [], seen = {};
      Array.prototype.forEach.call(document.querySelectorAll("#hlCards .hlfixbtn"), function (b) {
        var id = b.getAttribute("data-id") || "", act = b.getAttribute("data-act") || "resupply";
        var codes = String(b.getAttribute("data-codes") || "").split(",").filter(Boolean);
        if (act === "exempt" || act === "manual" || act === "fyfactor") return;
        var key = id + "|" + codes.join(",") + "|" + act; if (seen[key]) return; seen[key] = 1;
        todo.push({ id: id, act: act, codes: codes, name: "检查项 " + id + " · " + codes.length + " 只" });
      });
      [["corrections","人工纠正"],["ohlcFix","OHLC 修复"],["resupply","插值修复"],["swaps","序列互换"],["days","增量交易日"]].forEach(function (x) {
        var v = p[x[0]], n = Array.isArray(v) ? v.length : Object.keys(v || {}).length; if (n) done.push([x[1], n]);
      });
      (p.exempt || []).slice(-40).forEach(function (x) { exempt.push(x.id + " · " + x.c); });
      var items = [["待处理", todo.length, WufuTheme.sub("§WFT0014§")], ["已处理", done.reduce(function (a,x) { return a + x[1]; },0), WufuTheme.sub("§WFT0006§")], ["已确认", exempt.length, WufuTheme.sub("§WFT0012§")]];
      k.innerHTML = items.map(function (x) { return WufuTheme.sub('<div style="background:§WFT0007§;border:1px solid §WFT0016§;border-radius:6px;padding:8px 10px"><div style="font-size:10.5px;color:§WFT0002§">') + x[0] + '</div><div style="font-size:18px;color:' + x[2] + '">' + x[1] + '</div></div>'; }).join("");
      var h = '<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:460px"><thead><tr><th style="width:70px">来源</th><th>条目</th><th style="width:82px">状态</th><th style="width:90px">操作</th></tr></thead><tbody>';
      if (!todo.length) h += WufuTheme.sub('<tr><td colspan="4" style="color:§WFT0002§;padding:9px">暂无待处理项。先点「开始体检」或「一键修复数据」。</td></tr>');
      todo.forEach(function (x, i) {
        h += '<tr><td>体检</td><td>' + esc(x.name) + WufuTheme.sub('</td><td style="color:§WFT0014§">待处理</td><td><button type="button" class="corr-mini" data-fc-run="') + i + '">执行</button></td></tr>';
      });
      h += '</tbody></table></div><p class="swipehint">表格较宽，可左右滑动查看 →</p>';
      if (done.length) h += WufuTheme.sub('<div style="font-size:10.5px;color:§WFT0002§;line-height:1.8;margin-top:6px"><b style="color:§WFT0006§">已处理</b>：') + done.map(function (x) { return esc(x[0]) + " " + x[1]; }).join(" · ") + '</div>';
      q.innerHTML = h;
      Array.prototype.forEach.call(q.querySelectorAll("[data-fc-run]"), function (b) {
        b.addEventListener("click", async function () {
          var x = todo[+b.getAttribute("data-fc-run")]; if (!x) return;
          fcMsg("正在执行：" + x.name + " …");
          try {
            if (x.act === "fixohlc") await F.fix(x.codes);
            else if (x.act === "swap") { if (x.codes.length < 2) throw new Error("缺少互串 pair"); F.swap(x.codes[0], x.codes[1], false); }
            else await F.resupply(x.codes, x.id);
            log("队列执行", x.codes.slice(0,3).join(" "), "ok", x.name);
            fcMsg("已执行：" + x.name);
            setTimeout(function () { try { window.HealthView && window.HealthView.run(); } catch (e) { } }, 700);
          } catch (e) { log("队列执行", "", "err", (e && e.message) || e); fcMsg("执行失败：" + ((e && e.message) || e), true); }
          FC.render();
        });
      });
      var a = (ls(KL, []) || []).slice(-50).reverse();
      var col = { ok: WufuTheme.sub("§WFT0012§"), warn: WufuTheme.sub("§WFT0014§"), err: WufuTheme.sub("§WFT0010§"), act: WufuTheme.sub("§WFT0003§"), info: WufuTheme.sub("§WFT0002§") };
      var hh = WufuTheme.sub('<div style="font-size:11px;color:§WFT0006§;margin:10px 0 5px"><b>审计时间线</b> · 最近 ') + a.length + ' 条（存本机，可导出）</div>';
      if (!a.length) hh += WufuTheme.sub('<div style="font-size:10.5px;color:§WFT0002§">暂无记录。点任一修复按钮后这里会自动出现。</div>');
      else { hh += WufuTheme.sub('<div style="max-height:230px;overflow:auto;border:1px solid §WFT0016§;border-radius:6px;background:§WFT0018§">');
        a.forEach(function (x) { hh += WufuTheme.sub('<div style="padding:5px 9px;border-bottom:1px solid §WFT0009§;font-size:10.5px;line-height:1.6;color:§WFT0003§"><span style="color:§WFT0025§">') + esc(x.ts) + '</span> · <b style="color:' + (col[x.st] || WufuTheme.sub("§WFT0003§")) + '">' + esc(x.act) + '</b>' + (x.c ? ' · ' + esc(x.c) : '') + ' · ' + esc(x.m) + '</div>'; });
        hh += '</div>'; }
      if (l) l.innerHTML = hh;
    },
    log: log
  };
  window.FixCenter = FC;

  /* ---------- 对外 API（与 ETF 系统同名，供体检明细 / 修复中心调用） ---------- */
  var F = {
    fix: function (codes) { return repair(codes, "ohlc"); },
    resupply: function (codes, kind) { return repair(codes, "all"); },
    swap: function (a, b) {
      var D = gD(), x = D && D.series[a], y = D && D.series[b];
      if (!x || !y) throw new Error("找不到这两只标的");
      FIELDS.forEach(function (f) { if (Array.isArray(x[f]) && Array.isArray(y[f])) { var t = x[f]; x[f] = y[f]; y[f] = t; } });
      var p = P(); p.swaps.push({ a: a, b: b, ts: ts() }); W(p);
      log("序列互换", a + " ↔ " + b, "ok", "已互换全部价格 / 债底 / 溢价率序列");
      renderState(); return [{ c: a + "↔" + b, n: 1, msg: "已互换" }];
    },
    refactor: function () { log("复权重算", "", "info", "可转债无复权口径，跳过"); return []; },
    exempt: exempt, exemptList: exemptList, unexempt: function () { },
    clearExempt: clearExempt, clearAll: clearAllFix, renderList: renderList,
    count: function () { return Object.keys(P().ohlcFix || {}).length; },
    undo: undoOhlc, apply: applyPatch
  };

  /* ---------- 绑定 ---------- */
  function flat() {
    var root = $("advSettings"); if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll("details"), function (d) {
      if (d !== root && !d.dataset.flatOnce) { d.open = true; d.dataset.flatOnce = "1"; }
    });
  }
  function bind() {
    if (!$("qckCard")) return;
    flat();
    if (window.MutationObserver) { var root = $("advSettings"); if (root) new MutationObserver(flat).observe(root, { childList: true, subtree: true }); }
    function on(id, fn) { var b = $(id); if (b) b.addEventListener("click", function () { Promise.resolve().then(fn).catch(function (e) { note(id + " 失败：" + ((e && e.message) || e), true); }); }); }
    on("qckUpdate", netUpdate); on("wufuUpdRun", netUpdate);
    on("scaleUpd", scaleUpdate);
    on("qckFix", doFix);
    on("qckUndo", function () {
      var snap = ls(KS, null); if (!snap) { qnote("没有可撤销的修复记录。", true); return; }
      if (!confirm("撤销 " + snap.ts + " 那次「一键修复数据」的全部改动？页面将自动刷新。")) return;
      save(KP, snap.p || empty()); try { localStorage.removeItem(KS); } catch (e) { }
      qnote("已撤销，刷新中…"); setTimeout(function () { location.reload(); }, 600);
    });
    on("qckShowDetail", function () { var e = $("qckDetailPane"); if (e) { e.style.display = ""; e.scrollIntoView({ block: "start", behavior: "smooth" }); } var h = $("cbHealthFold"); if (h) h.style.display = ""; });
    on("qckHideDetail", function () { var e = $("qckDetailPane"); if (e) e.style.display = "none"; var h = $("cbHealthFold"); if (h) h.style.display = "none"; });
    on("wufuUpdHtml", function () {
      var o = { v: 1, ts: ts(), patch: P(), log: ls(KL, []) || [] };
      dl("可转债修复记录_" + today() + ".json", JSON.stringify(o));
      note("修复记录已导出（含本机修复包与时间线）。"); log("导出修复记录", "", "ok", "JSON");
    });
    on("wufuUpdClear", clearPatch); on("wufuUpdUndo", undoLast);
    on("wufuCorrSave", corrSave); on("wufuCorrUndo", corrClear);
    on("wufuCorrRefetch", function () { note("最新交易日请点「一键更新行情」联网重拉；历史单日可在这里人工纠正。"); });
    on("wufuOhlcUndo", undoOhlc);
    on("wufuFixClearAll", clearAllFix); on("wufuFixClearExempt", clearExempt);
    on("fcRefresh", function () { FC.render(); fcMsg("队列已刷新。"); });
    on("fcUndoFix", clearAllFix);
    on("fcExport", function () {
      dl("可转债修复时间线_" + today() + ".json", JSON.stringify({ v: 1, ts: ts(), log: ls(KL, []) || [], patch: P() }));
      log("导出修复记录", "", "ok", "JSON"); fcMsg("修复记录已导出。");
    });
    on("fcClearLog", function () { save(KL, []); FC.render(); fcMsg("审计时间线已清空（数据修复本身不受影响）。"); });
    document.addEventListener("click", function (e) {
      var t = e.target, b = t && t.closest ? t.closest("[data-fc-add]") : null;
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var sp = (b.getAttribute("data-fc-add") || "||").split("|");
      log("加入修复队列", (sp[2] || "").split(",").slice(0,3).join(" "), "act", "检查项 " + (sp[0] || ""));
      var c = $("fcCenter"); if (c) c.open = true;
      FC.render(); fcMsg("已加入修复队列，可在「完整明细 → 修复队列与记录」查看。");
    }, true);
    ["wufuUpdMsg", "hlMsg", "hlExtNote", "wufuCorrState"].forEach(function (id) {
      var e = $(id); if (!e || !window.MutationObserver) return; var last = "";
      new MutationObserver(function () {
        var t = (e.textContent || "").trim();
        if (!t || t.length < 6 || t === last) return; last = t;
        var bad = /失败|错误|无法|异常|超时/.test(t);
        log("结论", "", bad ? "warn" : "ok", id + "：" + t.slice(0, 180));
      }).observe(e, { childList: true, characterData: true, subtree: true });
    });
    var fc = $("fcCenter"); if (fc) fc.addEventListener("toggle", function () { if (this.open) FC.render(); });
    updateLine(); fixLine(); undoLine(); renderState(); fillCorrCodes(); FC.render();
    setTimeout(function () { updateLine(); fillCorrCodes(); renderState(); }, 2500);
    /* 统一日期：注册刷新钩子 + 启动统一 3 秒节奏（幂等，页面上另一入口调用也不会重复起定时器） */
    try { (window.__wufuDateHooks = window.__wufuDateHooks || {}).cb = updateLine; } catch (e) { }
    try { if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.start("cb"); } catch (e) { }
    // 数据就绪后回放修复包，并重跑一次体检让已确认/纠正立即反映
    function boot() {
      if (applyPatch()) {
        try {
          var D2 = gD(), lc = D2 && D2.calendar && D2.calendar[D2.calendar.length - 1];
          if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.paint("cb", lc || "");
          else if (lc) { var bd = $("dbDate"); if (bd) bd.textContent = "数据 " + D2.calendar[0] + " → " + lc; }
        } catch (e) { }
        renderState(); updateLine(); fillCorrCodes(); FC.render();
        // 只有当前正停在体检页时才复扫，避免加载即全库扫描拖慢启动
        var vh = $("viewHealth");
        if (vh && vh.style.display !== "none") { try { window.HealthView && window.HealthView.run(); } catch (e) { } }
      }
    }
    try { if (window.WufuUI && window.WufuUI.ensureData) window.WufuUI.ensureData(boot); } catch (e) { }
    var t = 0, iv = setInterval(function () { t++; boot(); if (t > 120) clearInterval(iv); }, 120);
  }
  /* v47：随包状态注入完成后，强制在已有 D 上重放一次补丁（含新增交易日）。
     若数据块尚未就绪，lastAppliedD 保持 null，boot() 的轮询会在就绪后自动回放。 */
  window.addEventListener("wufu:bundled-ready", function () {
    try {
      lastAppliedD = null; applied = false;
      if (applyPatch()) {
        var D2 = gD(), lc = D2 && D2.calendar && D2.calendar[D2.calendar.length - 1];
        try { if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.paint("cb", lc || ""); }
        catch (e) { }
      }
    } catch (e) { }
  });
  window.WufuFix = F;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
