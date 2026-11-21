
/* ==========================================================================
   一键更新行情 v1  (2026-11-02)
   · v0.69 方案甲：A股/跨境 ETF 主源统一东财 push2his（f51–f61），腾讯 newfqkline 仅失败兜底
   · 美股 3 只（QQQ/SPY/TIP）暂留 新浪美股日K → 腾讯us* 链：东财 suggest 未验通，不切
   · 扶摇（需 Key，默认停用）仍可选启用；CSI 4 只指数沿用东财首选 + 腾讯实时兜底
   · 原子更新：每只标的独立判定，失败保留旧值并列清单，绝不推算、不静默前值填充
   · 增量写入 localStorage，页面加载自动回放
   · 新增交易日自动追加（全部序列同步延长，缺失一律 -1）
   ========================================================================== */
(function () {
  "use strict";

  var KEY = "wufuQPatch_v1";
  var UNDO_KEY = "wufuQUndo_v1";
  var $ = function (id) { return document.getElementById(id); };
  var gD = function () { return window.D || null; };
  var gR = function () { return window.RDIDX || null; };

  var TX = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=";
  var QT = "https://qt.gtimg.cn/q=";
  var SINA = "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/";
  var EM_HOSTS = ["push2his.eastmoney.com", "1.push2his.eastmoney.com",
    "7.push2his.eastmoney.com", "23.push2his.eastmoney.com", "48.push2his.eastmoney.com"];
  var EM_UT = "fa5fd1943c7b386f172d6893dbfba10b";

  var CSI = { "932000.CSI": "932000", "931643.CSI": "931643", "930915.CSI": "930915", "h30533.CSI": "H30533" };
  var USIDX = { "NDX.GI": "usNDX", "SPX.GI": "usINX", "IXIC.GI": "usIXIC", "DJI.GI": "usDJI" };
  var HK = { "HSI.HI": "hkHSI", "HSTECH.HI": "hkHSTECH" };
  var USETF = { "QQQ.P": "QQQ", "SPY.P": "SPY", "TIP.P": "TIP" };
  var SPECIAL = { "000922.CSI": "sh000922", "000832.SH": "sh000832" };
  var SKIP = { "8841431.WI": 1 };          // 唯一无免费源：万得微盘（Wind 专有）

  /* ---- 扶摇（同花顺）官方源 ----
     FY_KEY 只在页面运行时由用户输入，仅存于本闭包内存：
     不写 localStorage、不写更新包、不写导出 HTML、不进日志与报告。 */
  var FY_BASE = "https://fuyao.aicubes.cn";
  var FY_FUND = "/api/fund/market/historical";          // ETF / 基金
  var FY_IDX = "/api/a-share-index/prices/historical";  // 指数
  var FY_CAL = "/api/a-share/calendar/trading-days";
  var FY_NAV = "/api/fund/performance/nav";   // 单位净值真值（range=fyear&nav_type=unit,adj）
  var FY_MICRO_CODE = "883418.TI";
  var FY_MICRO_NAME = "微盘股";
  var FY_KEY = "", FY_NEXT = 0, FY_FAIL = 0, FY_DEAD = false;

  /* ---------------- 小工具 ---------------- */
  function num(x) { var v = parseFloat(x); return isFinite(v) ? v : null; }
  function rnd(v, n) { var p = Math.pow(10, n || 6); return Math.round(v * p) / p; }
  function lastVal(a) {
    if (!a || !a.length) return null;
    for (var i = a.length - 1; i >= 0; i--) {
      var v = a[i];
      if (v !== null && v !== undefined && v !== -1 && isFinite(v)) return v;
    }
    return null;
  }
  function todayBJ() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function bjHour() { var d = new Date(Date.now() + 8 * 3600000); return d.getUTCHours() + d.getUTCMinutes() / 60; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function isMiss(v) { return v === null || v === undefined || v === -1 || !isFinite(v); }
  function pushUniq(arr, key, obj, seen) { if (!seen[key]) { seen[key] = 1; arr.push(obj); } }

  function txCode(c) {
    if (SPECIAL[c]) return SPECIAL[c];
    if (USIDX[c]) return USIDX[c];
    if (HK[c]) return HK[c];
    var m = /^(.+?)\.(SH|SZ|BJ)$/.exec(c);
    return m ? (m[2].toLowerCase() + m[1]) : null;
  }

  /* ---------------- 网络层 ---------------- */
  function fetchBuf(url, ms) {
    return new Promise(function (res, rej) {
      var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var done = false;
      var t = setTimeout(function () { if (done) return; done = true; if (ctl) ctl.abort(); rej(new Error("timeout")); }, ms || 12000);
      var o = {}; if (ctl) o.signal = ctl.signal;
      fetch(url, o).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
        .then(function (ab) { if (done) return; done = true; clearTimeout(t); res(ab); })
        .catch(function (e) { if (done) return; done = true; clearTimeout(t); rej(e); });
    });
  }
  function fetchJson(url, ms) {
    return fetchBuf(url, ms).then(function (ab) { return JSON.parse(new TextDecoder("utf-8").decode(ab)); });
  }
  function fetchGBK(url, ms) {
    return fetchBuf(url, ms).then(function (ab) {
      try { return new TextDecoder("gbk").decode(ab); } catch (e) { return new TextDecoder("utf-8").decode(ab); }
    });
  }
  function jsonpCb(url, cb, ms) {
    return new Promise(function (res, rej) {
      var done = false, sc = document.createElement("script");
      var t = setTimeout(function () { fin(null, "timeout"); }, ms || 9000);
      function fin(v, e) {
        if (done) return; done = true; clearTimeout(t);
        try { if (sc.parentNode) sc.parentNode.removeChild(sc); } catch (x) { }
        try { delete window[cb]; } catch (x) { try { window[cb] = null; } catch (y) { } }
        if (e) rej(new Error(e)); else res(v);
      }
      window[cb] = function (v) { fin(v, null); };
      sc.charset = "utf-8";
      sc.onerror = function () { fin(null, "script error"); };
      sc.src = url;
      document.head.appendChild(sc);
    });
  }
  function jsonpVar(url, varName, ms) {
    return new Promise(function (res, rej) {
      var done = false, sc = document.createElement("script");
      var t = setTimeout(function () { fin(null, "timeout"); }, ms || 15000);
      function fin(v, e) {
        if (done) return; done = true; clearTimeout(t);
        try { if (sc.parentNode) sc.parentNode.removeChild(sc); } catch (x) { }
        try { delete window[varName]; } catch (x) { try { window[varName] = null; } catch (y) { } }
        if (e) rej(new Error(e)); else res(v);
      }
      try { window[varName] = undefined; } catch (x) { }
      sc.charset = "gbk";
      sc.onload = function () { var v = window[varName]; if (v && v.length) fin(v, null); else fin(null, "empty"); };
      sc.onerror = function () { fin(null, "script error"); };
      sc.src = url;
      document.head.appendChild(sc);
    });
  }
  function pool(tasks, n) {
    return new Promise(function (res) {
      var i = 0, left = tasks.length, out = new Array(tasks.length);
      if (!left) { res(out); return; }
      function next() {
        if (i >= tasks.length) return;
        var k = i++;
        Promise.resolve().then(tasks[k]).then(function (v) { out[k] = v; }, function (e) { out[k] = { __err: e }; })
          .then(function () { left--; if (left === 0) res(out); else next(); });
      }
      for (var q = 0; q < Math.min(n, tasks.length); q++) next();
    });
  }

  async function txFetch(code, n) {
    var j = await fetchJson(TX + encodeURIComponent(code) + ",day,,," + n + ",", 12000);
    var d = j && j.data && j.data[code];
    return d ? (d.day || d.qfqday || d.hfqday || []) : [];
  }
  function parseTx(rows, usAmount) {
    var o = {};
    (rows || []).forEach(function (r) {
      var d = r[0], op = num(r[1]), cl = num(r[2]), hi = num(r[3]), lo = num(r[4]);
      if (!d || cl === null || cl <= 0) return;
      var v = num(r[5]), a = num(r[8]), to = num(r[7]);
      if (usAmount && a !== null) a = a / 1e4;       // 美股日K 第9列是美元 → 万美元
      o[d] = { o: op, c: cl, h: hi, l: lo, v: (v !== null ? v / 100 : null), a: a, to: to };
      // 腾讯 day[5] 单位「手」(100股) → /100 得「万股」；day[8] A股为「万元」
    });
    return o;
  }
  function parseSina(arr) {
    var o = {};
    (arr || []).forEach(function (x) {
      var d = x.d, c = num(x.c);
      if (!d || c === null || c <= 0) return;
      var v = num(x.v), a = num(x.a);
      o[d] = { o: num(x.o), c: c, h: num(x.h), l: num(x.l),
        v: (v !== null ? v / 1e4 : null), a: (a !== null && a > 0 ? a / 1e4 : null), to: null };
      // 新浪 v「股」→ /1e4 万股；a「美元」→ /1e4 万美元
    });
    return o;
  }
  function parseEM(kl) {
    var o = {};
    (kl || []).forEach(function (s) {
      var p = String(s).split(",");
      if (!p[0]) return;
      var v = num(p[5]), a = num(p[6]), to = num(p[10]);
      o[p[0]] = { o: num(p[1]), c: num(p[2]), h: num(p[3]), l: num(p[4]),
        v: (v !== null ? v / 100 : null),          /* f56「手」→ 万股，与腾讯 parseTx 同口径 */
        a: (a !== null ? a / 1e4 : null),          /* f57「元」→ 万元 */
        to: (to !== null && to > 0 ? to : null) };  /* f61 换手率 %；美股为 0.00 时不冒充真值 */
    });
    return o;
  }
  async function emFetch(sec, mkt) {
    var secid = (mkt || "2") + "." + sec;
    var lastErr = "";
    for (var i = 0; i < EM_HOSTS.length; i++) {
      var cb = "__wufuEM_" + sec + "_" + i + "_" + Date.now();
      var q = "secid=" + encodeURIComponent(secid) + "&ut=" + EM_UT +
        "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
        "&klt=101&fqt=0&end=20500101&lmt=60&cb=" + cb + "&_=" + Date.now();
      try {
        var j = await jsonpCb("https://" + EM_HOSTS[i] + "/api/qt/stock/kline/get?" + q, cb, 9000);
        var kl = (j && j.data && j.data.klines) || [];
        if (kl.length) return parseEM(kl);
        lastErr = "空结果";
      } catch (e) { lastErr = (e && e.message) || "不可用"; }
    }
    throw new Error(lastErr || "东财全部子域不可用");
  }
  async function qtFetch(keys) {
    var txt = await fetchGBK(QT + keys.join(","), 10000);
    var o = {};
    txt.split("\n").forEach(function (line) {
      var m = /v_([^=]+)="([^"]*)"/.exec(line); if (!m) return;
      var f = m[2].split("~"), t = f[30] || "";
      if (t.length < 8) return;
      var date = t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8);
      o[m[1]] = { o: num(f[5]), c: num(f[3]), h: num(f[33]), l: num(f[34]), prev: num(f[4]),
        v: null, a: null, to: null, date: date };
    });
    return o;
  }

  /* ---------------- 扶摇官方源 ---------------- */
  function fySleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function msToBJ(ms) {
    var n = Number(ms); if (!isFinite(n)) return "";
    if (n < 1e11) n *= 1000;
    try { return new Date(n + 8 * 3600000).toISOString().slice(0, 10); } catch (e) { return ""; }
  }
  function fyDate(o) {
    if (!o) return "";
    var raw = o.date !== undefined ? o.date : (o.trade_date !== undefined ? o.trade_date : o.tradeDate);
    if (raw !== undefined && raw !== null) {
      var q = String(raw).replace(/[-\/]/g, "");
      if (/^\d{8}$/.test(q)) return q.slice(0, 4) + "-" + q.slice(4, 6) + "-" + q.slice(6, 8);
      if (/^\d{4}-\d{2}-\d{2}/.test(String(raw))) return String(raw).slice(0, 10);
    }
    return msToBJ(o.date_ms !== undefined ? o.date_ms : o.timestamp);
  }
  // 全局错峰：并发任务也按 >=170ms 间隔发出，避免 4001 限频
  async function fyGet(path, qs, soft, gap) {
    if (!FY_KEY) throw new Error("未填 Key");
    var now = Date.now(), wait = Math.max(0, FY_NEXT - now);
    FY_NEXT = Math.max(now, FY_NEXT) + (gap || 170);
    if (wait) await fySleep(wait);
    var r, txt;
    try {
      var fyUrl = FY_BASE + path + (qs || "");
      r = await fetch(window.WUFU_ROUTE ? window.WUFU_ROUTE(fyUrl) : fyUrl, {
        method: "GET", mode: "cors", cache: "no-store",
        headers: { "Accept": "application/json", "X-api-key": FY_KEY }
      });
      txt = await r.text();
    } catch (e) { if (!soft) { FY_FAIL++; if (FY_FAIL >= 6) FY_DEAD = true; } throw e; }
    var j = null; try { j = JSON.parse(txt); } catch (e) { }
    if (!r.ok || !j || String(j.code) !== "0") {
      if (!soft) { FY_FAIL++; if (FY_FAIL >= 6) FY_DEAD = true; }
      var er = new Error("扶摇 " + (j ? "code=" + j.code + " " + (j.message || "") : "HTTP " + r.status));
      er.fyCode = j ? String(j.code) : "HTTP" + r.status;
      throw er;
    }
    FY_FAIL = 0;
    var d = j.data, a = Array.isArray(d) ? d : (d && (d.item || d.items || d.list || d.records)) || [];
    if (!a.length) {
      if (!soft) { FY_FAIL++; if (FY_FAIL >= 6) FY_DEAD = true; throw new Error("扶摇返回空数据"); }
      return [];                      // 净值端点：code=0 但无数据属于「不覆盖」，不是网络失败
    }
    return a;
  }
  // 扶摇日K → 内部 bar。turnover 是成交额（元），volume 是股数；单位由重叠日自检把关
  function fyBars(arr) {
    var o = {};
    (arr || []).forEach(function (x) {
      var dt = fyDate(x), cl = num(x.close_price);
      if (!dt || cl === null || !(cl > 0)) return;
      var v = num(x.volume), a = num(x.turnover);
      o[dt] = { o: num(x.open_price), c: cl, h: num(x.high_price), l: num(x.low_price),
        v: (v !== null && v > 0 ? v / 1e4 : null),   // 股 → 万股
        a: (a !== null && a > 0 ? a / 1e4 : null),   // 元 → 万元
        to: null };
    });
    return o;
  }
  /* 实测：扶摇 /api/fund/market/historical 默认返回【前复权】价。
     与腾讯未复权逐日比对 1001 个重叠日，811 日偏差 >0.5%（2022-09 约 8.2%，越早差越大，
     典型分红向下调整）。写进系统 raw_close 会破坏除权日价格，且会被重叠日校验整只拦下。
     故价格一律走腾讯未复权；扶摇只用于交易日历、单位净值、微盘观察标尺。 */
  function fyPath(c) { return null; }

  /* ---------------- C1 复权因子校验（扶摇官方公司行动事件流） ----------------
     端点 /api/a-share/corporate-actions/adjustment-factors
     字段 ex_date_ms / dividend_per_share / per_share_bonus。
     理论除权参考价 Pex = (P - D) / (1 + B)，后复权因子抬升 k = P / Pex；
     系统实际抬升 ratio = f(事件日后) / f(事件日前)，f = close / raw_close。
     ⚠️ 该端点只在个股 600519.SH 探测过（11 行）。ETF / 指数是否覆盖必须以实跑报告为准：
     返回 1002 或空数据一律列进「官方未覆盖」，绝不假装校验过。 */
  var FY_CORP = "/api/a-share/corporate-actions/adjustment-factors";
  function fyIdx(cal, dt) {
    var lo = 0, hi = cal.length - 1;
    while (lo < hi) { var m = (lo + hi) >> 1; if (cal[m] < dt) lo = m + 1; else hi = m; }
    return (cal.length && cal[lo] >= dt) ? lo : -1;
  }
  async function fyCorp(c, from) {
    if (!FY_KEY) throw new Error("未填 Key");
    var now = Date.now(), wait = Math.max(0, FY_NEXT - now);
    FY_NEXT = Math.max(now, FY_NEXT) + 170;             // 与扶摇其它请求共用全局错峰
    if (wait) await fySleep(wait);
    var u = FY_BASE + FY_CORP + "?thscode=" + encodeURIComponent(c) +
      "&from=" + (from || "2015-01-01") + "&to=" + todayBJ();
    var r = await fetch(u, { method: "GET", mode: "cors", cache: "no-store",
      headers: { "Accept": "application/json", "X-api-key": FY_KEY } });
    var t = await r.text(), j = null;
    try { j = JSON.parse(t); } catch (e) { }
    if (!r.ok) return { covered: false, msg: "HTTP " + r.status };
    if (!j) return { covered: false, msg: "响应非 JSON" };
    if (String(j.code) !== "0") return { covered: false, msg: "code=" + j.code + " " + (j.message || "") };
    var dd = j.data, a = Array.isArray(dd) ? dd : (dd && (dd.item || dd.items || dd.list || dd.records)) || [];
    var ev = [];
    a.forEach(function (x) {
      var dt = msToBJ(x.ex_date_ms) || fyDate(x);
      var D = num(x.dividend_per_share), B = num(x.per_share_bonus);
      if (!dt) return;
      ev.push({ d: dt, D: (D !== null ? D : 0), B: (B !== null ? B : 0) });
    });
    ev.sort(function (p, q) { return p.d < q.d ? -1 : 1; });
    return { covered: true, events: ev };
  }
  function fyFactors(sv) {
    var out = [], a = sv.close || [], b = sv.raw_close || [], L = Math.min(a.length, b.length);
    for (var i = 0; i < L; i++) out.push((a[i] > 0 && b[i] > 0) ? a[i] / b[i] : null);
    return out;
  }
  async function checkFactors(codes) {
    if (!FY_KEY) throw new Error("请先在顶部填入扶摇 API Key（仅本次会话内存，不保存）");
    var d = gD();
    if (!d || !d.calendar || !d.series) throw new Error("行情尚未加载完成");
    var cal = d.calendar, ser = d.series;
    if (!codes || !codes.length) codes = Object.keys(ser).filter(function (c) {
      return /^\d{6}\.(SH|SZ)$/.test(c) && ser[c] && Array.isArray(ser[c].close) && Array.isArray(ser[c].raw_close);
    });
    var rows = [], uncovered = [], covered = 0;
    var tasks = codes.map(function (c) { return async function () {
      var sv = ser[c]; if (!sv) return;
      var cr;
      try { cr = await fyCorp(c); }
      catch (e) { cr = { covered: false, msg: (e && e.message) || "网络失败" }; }
      if (!cr.covered) { uncovered.push({ c: c, m: cr.msg || "未返回事件" }); return; }
      covered++;
      var fac = fyFactors(sv), raw = sv.raw_close || [], evIdx = [];
      (cr.events || []).forEach(function (ev) {
        var i0 = fyIdx(cal, ev.d);
        if (i0 < 0 || i0 >= cal.length) { rows.push({ c: c, d: ev.d, D: ev.D, B: ev.B, verdict: "outdate" }); return; }
        evIdx.push(i0);
        var ip = -1, ia = -1;
        for (var j = i0 - 1; j >= 0 && j > i0 - 12; j--) if (fac[j] > 0) { ip = j; break; }
        for (var k = i0; k < Math.min(cal.length, i0 + 6); k++) if (fac[k] > 0) { ia = k; break; }
        var P = ip >= 0 ? raw[ip] : null;
        if (ip < 0 || ia < 0 || !(P > 0)) { rows.push({ c: c, d: ev.d, D: ev.D, B: ev.B, verdict: "nodata" }); return; }
        var Pex = (P - (ev.D || 0)) / (1 + (ev.B || 0));
        if (!(Pex > 0)) { rows.push({ c: c, d: ev.d, D: ev.D, B: ev.B, verdict: "badevent" }); return; }
        var kTheo = P / Pex;
        if (!(kTheo > 0) || kTheo > 3) { rows.push({ c: c, d: ev.d, D: ev.D, B: ev.B, verdict: "badevent" }); return; }
        var ratio = fac[ia] / fac[ip], dev = ratio / kTheo - 1;
        var v = (kTheo > 1.003 && Math.abs(ratio - 1) < 0.003) ? "miss"
          : (Math.abs(dev) <= 0.015 ? "same" : (Math.abs(dev) <= 0.05 ? "minor" : "bad"));
        rows.push({ c: c, d: ev.d, D: ev.D, B: ev.B, P: rnd(P, 4), k: rnd(kTheo, 6),
          ratio: rnd(ratio, 6), dev: rnd(dev, 6), verdict: v,
          fac0: rnd(fac[ip], 8), fac1: rnd(fac[ia], 8) });
      });
      // 反向核对：官方有事件数据，但系统在非事件日出现因子抬升（排除份额折算）
      var no = 0;
      for (var i = 1; i < fac.length && no < 5; i++) {
        if (!(fac[i] > 0 && fac[i - 1] > 0)) continue;
        var rr = fac[i] / fac[i - 1]; if (rr <= 1.005) continue;
        var praw = raw[i - 1], craw = raw[i];
        if (praw > 0 && craw > 0 && Math.abs(craw / praw - 1) >= 0.30) continue;
        var near = evIdx.some(function (x) { return Math.abs(i - x) <= 3; });
        if (near) continue;
        rows.push({ c: c, d: cal[i], D: null, B: null, ratio: rnd(rr, 6), dev: null, verdict: "orphan" });
        no++;
      }
    }; });
    await pool(tasks, 4);
    var ord = { bad: 0, miss: 1, minor: 2, orphan: 3, nodata: 4, badevent: 5, outdate: 6, same: 7 };
    rows.sort(function (a, b) { return (ord[a.verdict] - ord[b.verdict]) || (a.d < b.d ? -1 : 1); });
    var cnt = { same: 0, minor: 0, bad: 0, miss: 0, orphan: 0, nodata: 0, badevent: 0, outdate: 0 };
    rows.forEach(function (x) { cnt[x.verdict]++; });
    var summary = "官方覆盖 " + covered + " 只 / 未覆盖 " + uncovered.length + " 只 · 事件 " +
      (cnt.same + cnt.minor + cnt.bad + cnt.miss) + " 个（一致 " + cnt.same + " / 轻微偏差 " + cnt.minor +
      " / 明显偏差 " + cnt.bad + " / 疑似漏分红 " + cnt.miss + "）· 系统孤立抬升 " + cnt.orphan + " 条";
    var p = readPatch() || newPatch();
    p.fyCheck = { ts: new Date().toLocaleString("zh-CN", { hour12: false }),
      rows: rows, uncovered: uncovered, covered: covered, summary: summary };
    p.ts = p.fyCheck.ts;
    writePatch(p); renderState(); renderFyFactorReport();
    return { summary: summary, rows: rows, covered: covered, uncovered: uncovered.length };
  }
  /* 按官方事件重算：目标因子是绝对值 f1 = 事件日前因子 × 理论 k，
     回放时用 targetF × raw_close / 当前 close 求缩放比，天然幂等（重复回放 scale=1）。 */
  function fixFactors(rows) {
    var p = readPatch() || newPatch();
    if (!rows) rows = ((p.fyCheck || {}).rows || []).filter(function (x) {
      return x.verdict === "bad" || x.verdict === "minor" || x.verdict === "miss";
    });
    var keep = rows.filter(function (x) {
      return x && x.c && x.d && x.k > 0 && x.fac0 > 0 &&
        (x.verdict === "bad" || x.verdict === "minor" || x.verdict === "miss");
    });
    if (!keep.length) return { n: 0, codes: 0 };
    var fx = {};
    keep.forEach(function (x) {
      (fx[x.c] = fx[x.c] || []).push({ d: x.d, k: x.k, f0: x.fac0, f1: rnd(x.fac0 * x.k, 8) });
    });
    Object.keys(fx).forEach(function (c) {
      var seen = {};
      fx[c] = fx[c].filter(function (e) { if (seen[e.d]) return false; seen[e.d] = 1; return true; })
        .sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    });
    pushUndo(p);
    p.fyFix = fx;
    afterWrite(p);
    renderFyFactorReport();
    return { n: keep.length, codes: Object.keys(fx).length };
  }
  function applyFyRefactor(p) {
    var fx = p && p.fyFix;
    if (!fx || !Object.keys(fx).length) return;
    var d = gD(), r = gR();
    if (!d || !d.calendar || !d.series) return;
    var cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    Object.keys(fx).forEach(function (c) {
      var sv = d.series[c];
      if (!sv || !Array.isArray(sv.close) || !Array.isArray(sv.raw_close)) return;
      var evs = fx[c] || [], carry = null;
      for (var j = 0; j < evs.length; j++) {
        // 多事件连续：后一个事件的理论抬升 k 要乘在前一段已重算的目标因子上，
        // 不能各自以「原始因子」为基准，否则事件之间会出现人为断点。
        var target = (j === 0 ? evs[j].f1 : (carry > 0 ? carry * evs[j].k : evs[j].f1));
        var st = cidx[evs[j].d];
        if (st === undefined || !(target > 0)) continue;
        carry = target;
        var en = (j + 1 < evs.length && cidx[evs[j + 1].d] !== undefined) ? cidx[evs[j + 1].d] : sv.close.length;
        for (var i = st; i < en && i < sv.close.length; i++) {
          var rc = sv.raw_close[i], cur = sv.close[i];
          if (!(rc > 0) || !(cur > 0)) continue;
          var scale = (target * rc) / cur;
          if (!isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-12) continue;
          ["close", "open", "high", "low"].forEach(function (f) {
            if (Array.isArray(sv[f]) && sv[f][i] > 0) sv[f][i] = rnd(sv[f][i] * scale, 6);
          });
          if (r && r.series && Array.isArray(r.series[c]) && r.series[c][i] > 0) r.series[c][i] = rnd(r.series[c][i] * scale, 6);
          if (r && r.index && Array.isArray(r.index[c]) && r.index[c][i] > 0) r.index[c][i] = rnd(r.index[c][i] * scale, 6);
        }
      }
    });
    window.__fyRefactorOK = Object.keys(fx).length;
  }
  function renderFyFactorReport() {
    var box = $("wufuFyFactorReport"); if (!box) return;
    var p = readPatch() || newPatch(), ck = p.fyCheck;
    if (!ck || !ck.rows || !ck.rows.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    var vl = { same: ["一致", WufuTheme.sub("§WFT0012§")], minor: ["轻微偏差", WufuTheme.sub("§WFT0014§")], bad: ["明显偏差", WufuTheme.sub("§WFT0010§")],
      miss: ["疑似漏分红", WufuTheme.sub("§WFT0010§")], orphan: ["系统抬升·官方无事件", WufuTheme.sub("§WFT0014§")],
      outdate: ["不在日历范围", WufuTheme.sub("§WFT0002§")], nodata: ["系统无有效因子", WufuTheme.sub("§WFT0002§")],
      badevent: ["事件值异常", WufuTheme.sub("§WFT0002§")] };
    var h = [];
    h.push(WufuTheme.sub('<div style="margin-top:12px;padding:10px;border:1px solid §WFT0016§;border-radius:6px;background:§WFT0134§">'));
    h.push(WufuTheme.sub('<div style="font-size:12px;color:§WFT0006§;margin-bottom:6px"><b>扶摇复权因子校验 · 官方分红事件对拍</b> <span style="font-size:10px;color:§WFT0002§">') + esc(ck.ts || "") + '</span></div>');
    h.push(WufuTheme.sub('<div style="font-size:11px;color:§WFT0003§;line-height:1.7;margin-bottom:8px">') + esc(ck.summary || "") +
      '<br>理论抬升 k = P×(1+送转) ÷ (P−每股分红)，P 取除权日前一有效未复权收盘；实际抬升 = 事件日后因子 ÷ 事件日前因子，因子 = 复权价 ÷ 未复权价。' +
      WufuTheme.sub('<b style="color:§WFT0014§">「未覆盖」= 该端点无此代码或返回空，未做校验，不代表数据正确</b>；') +
      '该端点只在个股 600519.SH 探测过（11 行），ETF / 指数是否覆盖以本表为准。</div>');
    var nFix = ck.rows.filter(function (x) { return x.verdict === "bad" || x.verdict === "minor" || x.verdict === "miss"; }).length;
    if (nFix) h.push('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button type="button" class="corr-mini" id="wufuFyFixAll">按官方事件重算全部 ' + nFix + ' 个异常事件</button>' +
      WufuTheme.sub('<span style="font-size:10px;color:§WFT0025§;align-self:center">重算只改复权价（含开高低）与 RDIDX 对应值，未复权价不动；可撤销</span></div>'));
    h.push('<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:780px"><thead><tr>' +
      '<th>标的</th><th style="width:86px">除权日</th><th style="width:72px">每股分红</th><th style="width:56px">送转</th>' +
      '<th style="width:76px">理论 k</th><th style="width:76px">实际抬升</th><th style="width:76px">偏差</th>' +
      '<th style="width:128px">判定</th><th style="width:112px">操作</th></tr></thead><tbody>');
    ck.rows.slice(0, 200).forEach(function (x, ix) {
      var L = vl[x.verdict] || ["—", WufuTheme.sub("§WFT0002§")];
      var act = (x.verdict === "bad" || x.verdict === "minor" || x.verdict === "miss")
        ? '<button type="button" class="corr-mini" data-fyfix="' + ix + '">重算该事件</button>'
        : (x.verdict === "orphan" ? '<button type="button" class="corr-mini" data-fyex="' + esc(x.c) + '">标记已确认</button>' : "—");
      h.push('<tr><td>' + esc(x.c) + '</td><td>' + esc(x.d) + '</td><td>' +
        (x.D === null || x.D === undefined ? "—" : String(x.D)) + '</td><td>' +
        (x.B === null || x.B === undefined ? "—" : String(x.B)) + '</td><td>' +
        (x.k ? x.k.toFixed(5) : "—") + '</td><td>' + (x.ratio ? x.ratio.toFixed(5) : "—") + '</td><td>' +
        (x.dev === null || x.dev === undefined ? "—" : (x.dev * 100).toFixed(2) + "%") + '</td><td>' +
        '<b style="color:' + L[1] + '">' + L[0] + '</b></td><td>' + act + '</td></tr>');
    });
    h.push('</tbody></table></div><p class="swipehint">表格较宽，可左右滑动查看 →</p>');
    var un = ck.uncovered || [];
    if (un.length) {
      h.push(WufuTheme.sub('<details style="margin-top:6px"><summary style="font-size:11px;color:§WFT0002§;cursor:pointer">官方未覆盖 ') + un.length + ' 只（点击展开前 30 条）</summary>' +
        WufuTheme.sub('<div style="font-size:10px;color:§WFT0002§;line-height:1.8;margin-top:5px">') +
        un.slice(0, 30).map(function (x) { return esc(x.c) + " · " + esc(x.m); }).join("<br>") + '</div></details>');
    }
    h.push(WufuTheme.sub('<p style="font-size:10px;color:§WFT0025§;margin:6px 0 0;line-height:1.6">偏差阈值：≤1.5% 一致，1.5~5% 轻微，&gt;5% 明显；官方有分红而系统因子未抬升判「疑似漏分红」。') +
      '份额折算（未复权价单日跳 ≥30%）不参与反向核对。重算结果刷新仍生效，可在「数据纠正 → 体检纠正记录」里撤销。</p>');
    h.push('</div>');
    box.innerHTML = h.join(""); box.style.display = "";
    Array.prototype.forEach.call(box.querySelectorAll("[data-fyfix]"), function (b) {
      b.addEventListener("click", function () {
        var res = fixFactors([ck.rows[+b.getAttribute("data-fyfix")]]);
        note("已按官方事件重算 " + res.n + " 个除权事件（" + res.codes + " 只标的），复权价已更新。", "");
      });
    });
    var all = $("wufuFyFixAll");
    if (all) all.addEventListener("click", function () {
      var res = fixFactors(null);
      note("已按官方事件重算 " + res.n + " 个除权事件（" + res.codes + " 只标的），复权价已更新。", "");
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-fyex]"), function (b) {
      b.addEventListener("click", function () {
        exemptRun("factor", [b.getAttribute("data-fyex")]);
        note("已标记该标的的孤立抬升为已确认。", "");
      });
    });
  }
  // 扶摇量额单位未预先对拍：拿最近一个重叠日比成交额，偏差 >2% 就把该标的量额留空（价格照常更新）
  function fyAmountCheck(d, c, m, cal) {
    var sv = d.series[c];
    if (!sv || !Array.isArray(sv.amount)) return;
    var hit = null;
    for (var i = cal.length - 1; i >= Math.max(0, cal.length - 14); i--) {
      var b = m[cal[i]];
      if (b && b.a !== null && b.a > 0 && sv.amount[i] > 0) { hit = i; break; }
    }
    var ok = false;
    if (hit !== null) ok = Math.abs(m[cal[hit]].a / sv.amount[hit] - 1) < 0.02;
    if (!ok) Object.keys(m).forEach(function (dt) { m[dt].a = null; m[dt].v = null; m[dt].to = null; });
    else window.__fyAmtOK = (window.__fyAmtOK || 0) + 1;
  }

  /* ---- 扶摇单位净值真值 ----
     探测 A2：/api/fund/performance/nav?range=fyear&nav_type=unit,adj → 1217 行
     （2021-11-02 → 2026-11-02），字段 nav_date / unit_nav / adj_nav。
     只写 nav 与 premium，绝不碰任何价格序列。 */
  async function fyNav(c) {
    var last = null;
    for (var t = 0; t < 3; t++) {
      try {
        // 探测页实测 420ms 间隔全通；170ms 连续 125 只会触发 4001 限频
        var a = await fyGet(FY_NAV, "?thscode=" + encodeURIComponent(c) + "&range=fyear&nav_type=unit,adj", true, 420);
        var o = {};
        (a || []).forEach(function (x) {
          var dt = msToBJ(x.nav_date) || fyDate(x), nv = num(x.unit_nav);
          if (dt && nv !== null && nv > 0) o[dt] = nv;
        });
        return o;                      // code=0 但空数据：立即返回空，不重试
      } catch (e) {
        last = e;
        var q = String((e && e.message) || e), fc = e && e.fyCode ? String(e.fyCode) : "";
        var retry = /4001|限频|429|Failed to fetch|Load failed|timeout|HTTP 5|HTTP 403|policy/i.test(q) || fc === "4001";
        if (!retry || t === 2) break;
        await fySleep((fc === "4001" ? 2600 : 900) * (t + 1));
        FY_FAIL = 0; FY_DEAD = false;
      }
    }
    throw last || new Error("未知错误");
  }
  /* 口径守卫：系统已有 nav 与扶摇 unit_nav 在重叠日中位偏差 >2% → 整只跳过，不写入。
     新标的尚未建序列时无口径可校，直接放行。 */
  function navAcceptable(d, c, m, cal, fromDt) {
    var sv = d && d.series && d.series[c];
    if (!sv) return true;
    if (!Array.isArray(sv.nav)) return false;
    var idx = {}; cal.forEach(function (x, i) { idx[x] = i; });
    var ds = [];
    Object.keys(m).forEach(function (dt) {
      if (fromDt && dt < fromDt) return;
      var i = idx[dt]; if (i === undefined) return;
      var cur = sv.nav[i];
      if (cur > 0) ds.push(Math.abs(cur / m[dt] - 1));
    });
    if (ds.length < 3) return true;
    ds.sort(function (a, b) { return a - b; });
    return ds[Math.floor(ds.length / 2)] <= 0.02;
  }
  /* 把补丁里的净值真值应用到 D.series：nav 取单位净值，premium 按未复权收盘反算。
     放在序列重建之后调用，保证新加入的标的也能拿到净值。 */
  function applyNavFix(p) {
    var nf = p && p.navFix, d = gD();
    if (!nf || !Object.keys(nf).length) return;
    if (!d || !d.calendar || !d.series) return;
    window.__navFixApplied = (window.__navFixApplied || 0) + 1;
    var idx = {}; d.calendar.forEach(function (x, i) { idx[x] = i; });
    Object.keys(nf).forEach(function (c) {
      var sv = d.series[c]; if (!sv || !Array.isArray(sv.nav)) return;
      var m = nf[c];
      Object.keys(m).forEach(function (dt) {
        var i = idx[dt]; if (i === undefined) return;
        var nv = m[dt]; if (!(nv > 0)) return;
        sv.nav[i] = rnd(nv, 6);
        if (Array.isArray(sv.premium)) {
          var rc = (sv.raw_close && sv.raw_close[i] > 0) ? sv.raw_close[i] : (sv.close ? sv.close[i] : -1);
          sv.premium[i] = (rc > 0) ? rnd(rc / nv - 1, 8) : -1;
        }
      });
    });
  }

  /* ---------------- 补丁存取 ---------------- */
  function readPatch() {
    try { var x = localStorage.getItem(KEY); return x ? JSON.parse(x) : null; } catch (e) { return null; }
  }
  function writePatch(p) {
    var str;
    try { str = JSON.stringify(p); } catch (e) { return false; }
    try {
      if (window.WufuStore && WufuStore.put) return WufuStore.put(KEY, str).ok;
    } catch (e) { }
    try { localStorage.setItem(KEY, str); return true; }
    catch (e) { return false; }
  }
  function newPatch() { return { v: 7, days: [], report: null, ts: "", scale: null, corrections: [], ohlcFix: {},
    navFix: {}, resupply: {}, swaps: [], refactors: [], exempt: [], custom: [], hidden: [], fyCheck: null, fyFix: {}, groupCfg: null }; }
  function hasHealthFix(p) {
    if (!p) return false;
    return (p.resupply && Object.keys(p.resupply).length) || (p.swaps && p.swaps.length) ||
      (p.refactors && p.refactors.length) || (p.exempt && p.exempt.length) ||
      (p.fyFix && Object.keys(p.fyFix).length);
  }

  /* ---------------- 兜底：成交量块合并 ----------------
     原系统 ensureData 依赖 document.getElementById("wufuVolGz") 在回调时已存在；
     脚本块位于 UI 之后，快速加载时偶尔会静默跳过合并，导致 D.series 缺 volume/amount/turnover。
     这里在 D 就绪后补做一次（只补缺失字段，不覆盖已有数组）。 */
  var _volPromise = null;
  function mergeVol(vo) {
    var d = gD();
    if (!d || !d.series || !vo || !vo.series) return;
    var n = 0;
    Object.keys(vo.series).forEach(function (c) {
      var src = vo.series[c], dst = d.series[c];
      if (!src || !dst) return;
      Object.keys(src).forEach(function (f) {
        if (Array.isArray(dst[f])) return;                 // 已有数组不覆盖
        var a = Array.isArray(src[f]) ? src[f].slice() : null;
        if (!a) return;
        while (a.length < d.calendar.length) a.push(-1);  // 迟到的合并要补齐到当前日历长度
        dst[f] = a;
      });
      n++;
    });
    if (n) window.__volMergedOK = n;
  }
  // allowNet=true 时，部署版（内联块为空）按需拉 data/etf-data-vol.gz；首屏不加载，保持 slim
  function ensureVolMerged(allowNet) {
    var d = gD();
    if (!d || !d.series || window.__volMergedOK) return Promise.resolve();
    if (_volPromise) return _volPromise;
    var el = $("wufuVolGz");
    var b64 = el ? (el.textContent || "").replace(/\s+/g, "") : "";
    if (b64 && typeof window.__gunzipText === "function") {
      try {
        var bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
        mergeVol(JSON.parse(window.__gunzipText(bin)));
      } catch (e) { }
      return Promise.resolve();
    }
    if (!allowNet || (location.protocol !== "http:" && location.protocol !== "https:")) return Promise.resolve();
    if (typeof DecompressionStream === "undefined") return Promise.resolve();
    _volPromise = fetch(new URL("data/etf-data-vol.gz", location.href).href)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then(function (ab) {
        var body = new Blob([ab]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(body).text();
      })
      .then(function (t) { mergeVol(JSON.parse(t)); })
      .catch(function () { _volPromise = null; });
    return _volPromise;
  }

  /* ---------------- 回放（页面加载时，幂等） ---------------- */
  function applyPatch() {
    var p = readPatch();
    if (!p) return;
    var days = p.days || [];
    // 只有人工纠正 / 只有微盘标尺、没有增量日时也必须回放（此前这里会直接 return）
    if (!days.length && !(p.corrections && p.corrections.length) && !(p.scale && p.scale.bars)
        && !(p.ohlcFix && Object.keys(p.ohlcFix).length) && !hasHealthFix(p)
        && !(p.custom && p.custom.length) && !(p.hidden && p.hidden.length)
        && !(p.navFix && Object.keys(p.navFix).length)
        && !(p.fyFix && Object.keys(p.fyFix).length)
        && !(p.groupCfg && p.groupCfg.groups && p.groupCfg.seq)) return;
    var d = gD(), r = gR();
    if (d && d.calendar && d.series) {
      days.forEach(function (e) {
        if (e.fixOnly) return;
        if (d.calendar[d.calendar.length - 1] !== e.base) return;   // 基准不匹配 → 已应用过或文件已更新
        Object.keys(d.series).forEach(function (c) {
          var sv = d.series[c], add = (e.series && e.series[c]) || null;
          Object.keys(sv).forEach(function (f) {
            if (!Array.isArray(sv[f])) return;
            sv[f].push(add && add[f] !== undefined ? add[f] : -1);
          });
        });
        if (d.index) Object.keys(d.index).forEach(function (k) {
          if (Array.isArray(d.index[k])) d.index[k].push(e.index && e.index[k] !== undefined ? e.index[k] : -1);
        });
        d.calendar.push(e.date);
        if (e.last && window.WUFU_LAST) Object.keys(e.last).forEach(function (k) { window.WUFU_LAST[k] = e.last[k]; });
      });
    }
    if (r && r.calendar) {
      days.forEach(function (e) {
        if (e.fixOnly) return;
        if (r.calendar[r.calendar.length - 1] !== e.base) return;
        r.calendar.push(e.date);
        ["series", "index"].forEach(function (sec) {
          if (!r[sec]) return;
          Object.keys(r[sec]).forEach(function (k) {
            if (!Array.isArray(r[sec][k])) return;
            r[sec][k].push(e.rd && e.rd[sec] && e.rd[sec][k] !== undefined ? e.rd[sec][k] : -1);
          });
        });
      });
    }
    // 回填：已存在日期里的 -1，用后来抓到的真值补齐
    if (d && d.calendar) {
      var cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
      days.forEach(function (e) {
        if (!e.fix) return;
        Object.keys(e.fix).forEach(function (dt) {
          var i = cidx[dt]; if (i === undefined) return;
          Object.keys(e.fix[dt]).forEach(function (c) {
            var sv = d.series[c]; if (!sv) return;
            var v = e.fix[dt][c];
            Object.keys(v).forEach(function (f) {
              if (Array.isArray(sv[f]) && isMiss(sv[f][i])) sv[f][i] = v[f];
            });
            if (r && r.series && Array.isArray(r.series[c]) && isMiss(r.series[c][i]) && v.close !== undefined) r.series[c][i] = v.close;
            if (r && r.index && Array.isArray(r.index[c]) && isMiss(r.index[c][i]) && v.close !== undefined) r.index[c][i] = v.close;
          });
        });
      });
    }
    applyScale(p);
    applyOhlcFix(p);      // 体检纠错①：补齐 OHL 缺失/矛盾日
    applyResupply(p);     // 体检纠错②：8 项共用的从数据源重供
    applySwaps(p);        // 体检纠错③：序列互串整段换回
    applyRefactors(p);    // 体检纠错④：复权价按未复权价重算（内部单调性）
    applyFyRefactor(p);   // 体检纠错⑤：扶摇官方分红事件重算（优先于内部重算）
    applyCorrections(p);  // 单日人工纠正（价格/成交额）优先级最高
    applyPoolPatch(p);    // 标的增减（含自定义序列与元信息），幂等
    applyGroupCfg(p);      // 分组与顺序（含改名 / 跨组 / 排序），幂等
    applyNavFix(p);       // 扶摇单位净值真值：序列重建后再覆盖，新标的同样生效
    try {
      var lc2 = d && d.calendar && d.calendar.length ? String(d.calendar[d.calendar.length - 1]) : "";
      if (window.WufuHub && window.WufuHub.DateSync) window.WufuHub.DateSync.paint("etf", lc2);
      else { var el = $("dbDate"); if (el && lc2) el.textContent = "数据 " + d.calendar[0] + " → " + lc2; }
    } catch (x) { }
    // [FIX 策略随行情更新] 增量/纠正落地后让已保存策略按新行情重算，不必手动刷新
    try { if (window.WufuUI && WufuUI.onDataUpdated) WufuUI.onDataUpdated(); } catch (x2) { }
  }
  /* 微盘观察标尺：作为独立序列注入，不进策略池、不改动 8841431.WI 的任何历史值。
     按最终日历长度重建数组，历史段一律 -1，只有扶摇真值日有数。 */
  function applyScale(p) {
    var sc = p && p.scale, d = gD(), r = gR();
    if (!sc || !sc.bars || !d || !d.calendar) return;
    var code = sc.code, L = d.calendar.length, cidx = {};
    d.calendar.forEach(function (x, i) { cidx[x] = i; });
    var sv = d.series[code];
    if (!sv) { sv = {}; d.series[code] = sv; }
    ["open", "close", "high", "low", "raw_open", "raw_close",
      "volume", "amount", "turnover", "nav", "premium"].forEach(function (f) {
      var a = new Array(L); for (var i = 0; i < L; i++) a[i] = -1; sv[f] = a;
    });
    Object.keys(sc.bars).forEach(function (dt) {
      var i = cidx[dt]; if (i === undefined) return;
      var b = sc.bars[dt]; if (!b || b.c === null || !(b.c > 0)) return;
      sv.raw_open[i] = b.o; sv.raw_close[i] = b.c;
      sv.open[i] = b.o; sv.close[i] = b.c; sv.high[i] = b.h; sv.low[i] = b.l;
      if (b.v !== null && b.v > 0) sv.volume[i] = b.v;
      if (b.a !== null && b.a > 0) sv.amount[i] = b.a;
    });
    if (d.indexNames && !d.indexNames.some(function (x) { return x.code === code; }))
      d.indexNames.push({ code: code, name: sc.name });
    if (r) {
      if (r.pool && !r.pool.some(function (x) { return x.code === code; }))
        r.pool.push({ code: code, name: sc.name, group: "A股指数" });
      var ra = new Array(L); for (var j = 0; j < L; j++) ra[j] = -1;
      Object.keys(sc.bars).forEach(function (dt) {
        var i2 = cidx[dt]; if (i2 !== undefined && sc.bars[dt].c > 0) ra[i2] = sc.bars[dt].c;
      });
      if (r.series) r.series[code] = ra;
      if (r.index) r.index[code] = ra.slice();
    }
    window.__fyScaleOK = Object.keys(sc.bars).length;
  }
  /* ---------------- 纠正机制 ----------------
     1) 每次写入前留快照 → 一键撤销（最多 8 次，页面重载后从基线重建，绝对可靠）
     2) 人工纠正：单标的单日覆盖，优先级高于自动增量，刷新／再次更新都不会被冲掉
     3) 异常扫描：长度 / 非有限 / 四价矛盾 / 单日跳变 / 量纲，结果可一键预填纠正表单 */
  function readUndo() {
    try { var x = localStorage.getItem(UNDO_KEY); var a = x ? JSON.parse(x) : []; return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function pushUndo(p) {
    try {
      var st = readUndo();
      st.push({ ts: new Date().toLocaleString("zh-CN", { hour12: false }), p: JSON.parse(JSON.stringify(p || newPatch())) });
      if (st.length > 8) st = st.slice(-8);
      localStorage.setItem(UNDO_KEY, JSON.stringify(st));
      return true;
    } catch (e) { return false; }   // 存储配额不足时静默跳过，不阻断更新
  }
  function undoLast() {
    var st = readUndo();
    if (!st.length) { note("没有可撤销的更新记录。", "warn"); return; }
    var prev = st[st.length - 1];
    if (!confirm("撤销上一次写入，回到 " + (prev.ts || "上一版") + " 的状态？页面将自动刷新。")) return;
    try { localStorage.setItem(UNDO_KEY, JSON.stringify(st.slice(0, -1))); } catch (e) { }
    writePatch(prev.p || newPatch());
    location.reload();
  }
  /* ---------------- 体检纠错：从数据源重供 OHLC ----------------
     触发：数据体检 → OHLC 内部一致性 → 「从数据源重供 OHLC」。
     只覆盖 open/high/low/raw_open 的缺失(-1)或矛盾日；收盘价不动。
     重叠日收盘与源差异 >0.5% 时跳过该日，避免把另一套口径的三价串进来。 */
  function applyOhlcFix(p) {
    var fx = p && p.ohlcFix; if (!fx) return;
    var d = gD(); if (!d || !d.calendar || !d.series) return;
    var cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    var n = 0;
    Object.keys(fx).forEach(function (c) {
      var sv = d.series[c]; if (!sv) return;
      Object.keys(fx[c] || {}).forEach(function (dt) {
        var i = cidx[dt], b = fx[c][dt];
        if (i === undefined || !b) return;
        var cl = sv.close && sv.close[i], rc = sv.raw_close && sv.raw_close[i];
        var fac = (cl > 0 && rc > 0) ? cl / rc : 1;
        var O = b.o * fac;
        if (b.o > 0) {
          if (Array.isArray(sv.raw_open)) sv.raw_open[i] = rnd(b.o, 6);
          if (Array.isArray(sv.open)) sv.open[i] = rnd(O, 6);
        }
        if (b.h > 0 && Array.isArray(sv.high)) sv.high[i] = rnd(Math.max(b.h * fac, O, cl), 6);
        if (b.l > 0 && Array.isArray(sv.low)) sv.low[i] = rnd(Math.min(b.l * fac, O, cl), 6);
        n++;
      });
    });
    window.__ohlcFixOK = n;
  }
  /* 腾讯公开日K：按 end 日期往前取 n 行，分 4 段可覆盖 2004 年起全历史。
     CORS 全开，file:// 亦可用；单段失败不影响其它段。 */
  async function txFetchEnd(code, end, n) {
    var u = TX + encodeURIComponent(code) + ",day,2000-01-01," + end + "," + n + ",";
    var j = await fetchJson(u, 15000);
    var d = j && j.data && j.data[code];
    return d ? (d.day || d.qfqday || d.hfqday || []) : [];
  }
  async function fetchFullOhlc(c) {
    var tc = txCode(c); if (!tc) throw new Error("无行情代码映射");
    var ends = ["2012-12-31", "2018-12-31", "2022-12-31", todayBJ()];
    var map = {}, okN = 0;
    for (var k = 0; k < ends.length; k++) {
      try {
        var p = parseTx(await txFetchEnd(tc, ends[k], 2000));
        Object.keys(p).forEach(function (dt) { map[dt] = p[dt]; });
        okN++;
      } catch (e) { /* 单段失败继续，其余段仍可用 */ }
    }
    if (!okN) throw new Error("行情源不可用（可留空扶摇 Key 重试）");
    return map;
  }
  async function ohlcFixRun(codes) {
    var d = gD(); if (!d || !d.calendar || !d.series) throw new Error("行情尚未加载");
    var p = readPatch() || newPatch();
    pushUndo(p);
    p.ohlcFix = p.ohlcFix || {};
    var res = [], cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    for (var k = 0; k < codes.length; k++) {
      var c = codes[k], sv = d.series[c];
      if (!sv) { res.push({ c: c, n: 0, msg: "标的不存在" }); continue; }
      var bars;
      try { bars = await fetchFullOhlc(c); }
      catch (e) { res.push({ c: c, n: 0, msg: (e && e.message) || "拉不到源数据" }); continue; }
      var fix = p.ohlcFix[c] = p.ohlcFix[c] || {}, n = 0, skip = 0;
      Object.keys(bars).forEach(function (dt) {
        var i = cidx[dt]; if (i === undefined) return;
        var cl = sv.close && sv.close[i], b = bars[dt];
        if (!(cl > 0) || !(b.o > 0 && b.c > 0 && b.h > 0 && b.l > 0)) return;
        if (Math.abs(b.c / cl - 1) > 0.005) { skip++; return; }   // 口径不同，不串源
        var hi = sv.high && sv.high[i], lo = sv.low && sv.low[i], op = sv.open && sv.open[i];
        var isBad = !(hi > 0 && lo > 0 && op > 0) ||
          hi < lo - 1e-9 || cl > hi + 1e-9 || cl < lo - 1e-9 || op > hi + 1e-9 || op < lo - 1e-9;
        if (!isBad) return;
        fix[dt] = { o: b.o, h: Math.max(b.h, b.o, b.c), l: Math.min(b.l, b.o, b.c) };
        n++;
      });
      if (!n) delete p.ohlcFix[c];
      res.push({ c: c, n: n, skip: skip, msg: n ? "已补齐" : (skip ? "源口径不一致，未改动" : "无需修复") });
    }
    p.ts = new Date().toLocaleString("zh-CN", { hour12: false });
    writePatch(p);
    applyPatch();
    renderState();
    try { if (window.HealthView && window.HealthView.run) window.HealthView.run(); } catch (e) { }
    return res;
  }
  function ohlcFixUndo() {
    var p = readPatch() || newPatch();
    var n = p.ohlcFix ? Object.keys(p.ohlcFix).length : 0;
    if (!n) { note("当前没有 OHLC 修复记录。", "warn"); return; }
    if (!confirm("撤销全部 " + n + " 只标的的 OHLC 修复？页面将刷新回到原始值。")) return;
    pushUndo(p); p.ohlcFix = {}; writePatch(p); location.reload();
  }
  /* ---------------- 体检通用纠正：8 项检查共用 ----------------
     重供 / 互换 / 重算复权 / 标记已确认，全部写进 patch：刷新自动回放、可撤销、
     随更新包与完整 HTML 带走。只覆盖确有问题或源值更可信的日子，绝不推算。 */
  function factorAt(sv, i) {
    for (var j = i; j >= 0 && j > i - 60; j--) {
      var cl = sv.close && sv.close[j], rc = sv.raw_close && sv.raw_close[j];
      if (cl > 0 && rc > 0) return cl / rc;
    }
    return 1;
  }
  function afterWrite(p) {
    p.ts = new Date().toLocaleString("zh-CN", { hour12: false });
    writePatch(p); applyPatch(); renderState(); renderFixList();
  }
  function applyResupply(p) {
    var rs = p && p.resupply; if (!rs) return;
    var d = gD(), r = gR(); if (!d || !d.calendar || !d.series) return;
    var cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    var n = 0;
    Object.keys(rs).forEach(function (c) {
      var sv = d.series[c]; if (!sv) return;
      Object.keys(rs[c] || {}).forEach(function (dt) {
        var i = cidx[dt], b = rs[c][dt];
        if (i === undefined || !b) return;
        var f = (b.f > 0) ? b.f : factorAt(sv, i), adj = b.c * f;
        if (b.c > 0) {
          if (Array.isArray(sv.raw_close)) sv.raw_close[i] = rnd(b.c, 6);
          if (Array.isArray(sv.close)) sv.close[i] = rnd(adj, 6);
          if (r && r.series && Array.isArray(r.series[c])) r.series[c][i] = rnd(adj, 6);
          if (r && r.index && Array.isArray(r.index[c])) r.index[c][i] = rnd(adj, 6);
          if (window.WUFU_LAST && dt === d.calendar[d.calendar.length - 1]) window.WUFU_LAST[c] = dt;
        }
        if (b.o > 0) {
          if (Array.isArray(sv.raw_open)) sv.raw_open[i] = rnd(b.o, 6);
          if (Array.isArray(sv.open)) sv.open[i] = rnd(b.o * f, 6);
        }
        var mx = Math.max((b.h > 0 ? b.h : b.c) * f, (b.o > 0 ? b.o : b.c) * f, adj);
        var mn = Math.min((b.l > 0 ? b.l : b.c) * f, (b.o > 0 ? b.o : b.c) * f, adj);
        if (b.h > 0 && Array.isArray(sv.high)) sv.high[i] = rnd(mx, 6);
        if (b.l > 0 && Array.isArray(sv.low)) sv.low[i] = rnd(mn, 6);
        if (b.v > 0 && Array.isArray(sv.volume)) sv.volume[i] = rnd(b.v, 4);
        if (b.a > 0 && Array.isArray(sv.amount)) sv.amount[i] = rnd(b.a, 4);
        n++;
      });
    });
    window.__resupplyOK = n;
  }
  function applySwaps(p) {
    var arr = p && p.swaps; if (!arr || !arr.length) return;
    var d = gD(), r = gR(); if (!d || !d.series) return;
    arr.forEach(function (sw) {
      var A = d.series[sw.a], B = d.series[sw.b];
      if (!A || !B) return;
      // 回放可能被调用多次：用不可枚举标记保证幂等，避免换回去
      if (A.__wufuSw === sw.id || B.__wufuSw === sw.id) return;
      (sw.fields || ["close"]).forEach(function (f) {
        if (Array.isArray(A[f]) && Array.isArray(B[f])) { var t = A[f].slice(); A[f] = B[f].slice(); B[f] = t; }
      });
      if (r && (sw.fields || []).indexOf("close") >= 0) ["series", "index"].forEach(function (sec) {
        if (r[sec] && Array.isArray(r[sec][sw.a]) && Array.isArray(r[sec][sw.b])) {
          var t2 = r[sec][sw.a].slice(); r[sec][sw.a] = r[sec][sw.b].slice(); r[sec][sw.b] = t2;
        }
      });
      try {
        Object.defineProperty(A, "__wufuSw", { value: sw.id, enumerable: false, configurable: true });
        Object.defineProperty(B, "__wufuSw", { value: sw.id, enumerable: false, configurable: true });
      } catch (e) { }
    });
    window.__swapOK = arr.length;
  }
  function applyRefactors(p) {
    var arr = p && p.refactors; if (!arr || !arr.length) return;
    var d = gD(), r = gR(); if (!d || !d.series) return;
    arr.forEach(function (q) {
      var sv = d.series[q.c];
      if (!sv || !Array.isArray(sv.raw_close) || !Array.isArray(sv.close)) return;
      var prev = null, n = 0;
      for (var i = 0; i < sv.close.length; i++) {
        var cl = sv.close[i], rc = sv.raw_close[i], prc = i > 0 ? sv.raw_close[i - 1] : null;
        if (!(cl > 0) || !(rc > 0)) continue;
        // 份额折算：未复权价单日跳 ≥30% 而复权价连续，属真实事件，跳过不修
        if (prc > 0 && Math.abs(rc / prc - 1) >= 0.30) { prev = cl / rc; continue; }
        var f = cl / rc;
        if (prev !== null && prev > 0 && Math.abs(f / prev - 1) > 0.08) {
          var nv = rnd(rc * prev, 6);
          sv.close[i] = nv;
          if (r && r.series && Array.isArray(r.series[q.c])) r.series[q.c][i] = nv;
          if (r && r.index && Array.isArray(r.index[q.c])) r.index[q.c][i] = nv;
          n++;
        } else prev = f;
      }
      window.__refactorFixN = (window.__refactorFixN || 0) + n;
    });
    window.__refactorOK = arr.length;
  }
  function exemptList() {
    var p = readPatch(), o = {};
    ((p && p.exempt) || []).forEach(function (x) { (o[x.id] = o[x.id] || []).push(x.c); });
    return o;
  }
  function exemptRun(id, codes) {
    var p = readPatch() || newPatch(); pushUndo(p);
    p.exempt = p.exempt || [];
    codes.forEach(function (c) {
      if (!p.exempt.some(function (x) { return x.id === id && x.c === c; }))
        p.exempt.push({ id: id, c: c, ts: new Date().toLocaleString("zh-CN", { hour12: false }) });
    });
    afterWrite(p); return codes.length;
  }
  function unexemptRun(id, c) {
    var p = readPatch() || newPatch(); pushUndo(p);
    p.exempt = (p.exempt || []).filter(function (x) { return !(x.id === id && (!c || x.c === c)); });
    afterWrite(p); return true;
  }
  function clearExemptRun() {
    var p = readPatch() || newPatch();
    if (!p.exempt || !p.exempt.length) { note("当前没有已确认记录。", "warn"); return false; }
    if (!confirm("清除全部 " + p.exempt.length + " 条「已确认」？这些项会重新出现在体检里。")) return false;
    pushUndo(p); p.exempt = []; afterWrite(p); return true;
  }
  function swapRun(a, b, withRaw) {
    var d = gD(); if (!d || !d.series[a] || !d.series[b]) throw new Error("标的不存在");
    var p = readPatch() || newPatch(); pushUndo(p);
    p.swaps = p.swaps || [];
    p.swaps.push({ id: "sw" + Date.now() + "_" + p.swaps.length, a: a, b: b,
      fields: withRaw ? ["close", "raw_close", "open", "high", "low", "raw_open"] : ["close"],
      ts: new Date().toLocaleString("zh-CN", { hour12: false }) });
    if (p.swaps.length > 20) p.swaps = p.swaps.slice(-20);
    afterWrite(p); return { a: a, b: b };
  }
  function refactorRun(codes) {
    var d = gD(); if (!d || !d.series) throw new Error("行情尚未加载");
    var p = readPatch() || newPatch(); pushUndo(p);
    p.refactors = p.refactors || [];
    var out = [];
    codes.forEach(function (c) {
      var sv = d.series[c]; if (!sv || !Array.isArray(sv.raw_close)) return;
      if (!p.refactors.some(function (x) { return x.c === c; }))
        p.refactors.push({ c: c, ts: new Date().toLocaleString("zh-CN", { hour12: false }) });
      out.push(c);
    });
    afterWrite(p); return out;
  }
  function clearAllFix() {
    var p = readPatch() || newPatch();
    var n = (p.resupply ? Object.keys(p.resupply).length : 0) + (p.swaps || []).length +
      (p.refactors || []).length + (p.exempt || []).length + (p.ohlcFix ? Object.keys(p.ohlcFix).length : 0) +
      (p.fyFix ? Object.keys(p.fyFix).length : 0);
    if (!n) { note("当前没有体检纠正记录。", "warn"); return; }
    if (!confirm("撤销全部 " + n + " 条体检纠正（重供 / 互换 / 重算复权 / 已确认 / OHLC 修复）？页面将刷新回到原始值。")) return;
    pushUndo(p);
    p.resupply = {}; p.swaps = []; p.refactors = []; p.exempt = []; p.ohlcFix = {}; p.fyFix = {};
    writePatch(p); location.reload();
  }
  async function fetchAllBars(c) {
    if (SKIP[c]) throw new Error("该标的无免费行情源（Wind 专有）");
    var map = {}, okN = 0;
    try { var m1 = await corrBars(c); Object.keys(m1).forEach(function (d) { map[d] = m1[d]; }); okN++; } catch (e) { }
    try {
      var m2 = await fetchFullOhlc(c);
      Object.keys(m2).forEach(function (d) { if (!map[d]) map[d] = m2[d]; });
      okN++;
    } catch (e) { }
    if (!okN || !Object.keys(map).length) throw new Error("拉不到源数据");
    return map;
  }
  async function resupplyRun(codes, id) {
    if (!codes || !codes.length) return [];
    if (id === "ohlc") return ohlcFixRun(codes);
    var d = gD(); if (!d || !d.calendar || !d.series) throw new Error("行情尚未加载");
    var p = readPatch() || newPatch(); pushUndo(p);
    p.resupply = p.resupply || {};
    var res = [], cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    for (var k = 0; k < codes.length; k++) {
      var c = codes[k], sv = d.series[c];
      if (!sv) { res.push({ c: c, n: 0, msg: "标的不存在" }); continue; }
      var bars;
      try { bars = await fetchAllBars(c); }
      catch (e) { res.push({ c: c, n: 0, msg: (e && e.message) || "拉不到源数据" }); continue; }
      // 口径自检：重叠日里源与系统未复权价一致的比例，防止错误的源映射整段覆盖
      var same = 0, diff = 0;
      Object.keys(bars).forEach(function (dt) {
        var i = cidx[dt]; if (i === undefined) return;
        var rc = sv.raw_close && sv.raw_close[i], b = bars[dt];
        if (!(rc > 0) || !(b.c > 0)) return;
        if (Math.abs(b.c / rc - 1) <= 0.005) same++; else diff++;
      });
      if (same + diff >= 20 && diff / (same + diff) > 0.5) {
        res.push({ c: c, n: 0, msg: "源口径不一致（" + Math.round(diff / (same + diff) * 100) + "% 重叠日对不上），已跳过" }); continue;
      }
      var fix = p.resupply[c] = p.resupply[c] || {}, n = 0;
      Object.keys(bars).forEach(function (dt) {
        var i = cidx[dt], b = bars[dt];
        if (i === undefined || !b || !(b.c > 0)) return;
        var rc = sv.raw_close && sv.raw_close[i], cl = sv.close && sv.close[i];
        var hi = sv.high && sv.high[i], lo = sv.low && sv.low[i], op = sv.open && sv.open[i];
        var hasOHL = Array.isArray(sv.high) && Array.isArray(sv.low) && Array.isArray(sv.open);
        var need = !(rc > 0) || !(cl > 0) || (rc > 0 && Math.abs(b.c / rc - 1) > 0.005) ||
          (hasOHL && (!(hi > 0) || !(lo > 0) || !(op > 0) ||
            (hi > 0 && lo > 0 && (hi < lo - 1e-9 || cl > hi + 1e-9 || cl < lo - 1e-9))));
        if (!need) return;
        fix[dt] = { c: b.c, o: (b.o > 0 ? b.o : null), h: (b.h > 0 ? b.h : null),
          l: (b.l > 0 ? b.l : null), v: (b.v > 0 ? b.v : null), a: (b.a > 0 ? b.a : null),
          f: factorAt(sv, i) };
        n++;
      });
      if (!n) delete p.resupply[c];
      res.push({ c: c, n: n, msg: n ? "已重供" : (diff ? "仅口径差异，无需改动" : "无需修复") });
    }
    afterWrite(p);
    return res;
  }
  function renderFixList() {
    var box = $("wufuFixList"); if (!box) return;
    var p = readPatch() || newPatch();
    var nr = p.resupply ? Object.keys(p.resupply).length : 0, nd = 0;
    Object.keys(p.resupply || {}).forEach(function (c) { nd += Object.keys(p.resupply[c]).length; });
    var ns = (p.swaps || []).length, nf = (p.refactors || []).length, ne = (p.exempt || []).length;
    var no = p.ohlcFix ? Object.keys(p.ohlcFix).length : 0;
    var ny = p.fyFix ? Object.keys(p.fyFix).length : 0;
    if (!nr && !ns && !nf && !ne && !no && !ny) { box.innerHTML = WufuTheme.sub("<p style='font-size:11px;color:§WFT0002§;margin:4px 0'>暂无体检纠正记录。</p>"); return; }
    var h = "<div class='tblwrap'><table class='trades hltbl' style='width:100%;min-width:420px'><thead><tr><th>类型</th><th>数量</th><th></th></tr></thead><tbody>";
    function row(t, v, act) { h += "<tr><td>" + t + "</td><td>" + v + "</td><td>" + (act ? "<button class='corr-mini' data-clr='" + act + "'>撤销</button>" : "—") + "</td></tr>"; }
    if (no) row("OHLC 重供", no + " 只", "ohlc");
    if (nr) row("从数据源重供", nr + " 只 / " + nd + " 天", "resupply");
    if (ns) row("序列互换", ns + " 组", "swaps");
    if (nf) row("重算复权", nf + " 只", "refactors");
    if (ny) row("官方分红事件重算", ny + " 只", "fyFix");
    if (ne) row("已确认（不再提示）", ne + " 条", "exempt");
    h += "</tbody></table></div>";
    if (ne) {
      h += WufuTheme.sub("<div style='font-size:10px;color:§WFT0002§;margin:8px 0 4px'>已确认明细（点「×」恢复提示）：</div><div style='display:flex;gap:6px;flex-wrap:wrap'>");
      (p.exempt || []).slice(-40).forEach(function (x) {
        h += "<button type='button' class='corr-mini' data-unex='" + esc(x.id + "|" + x.c) + "'>" + esc(x.id + " · " + x.c) + " ×</button>";
      });
      h += "</div>";
    }
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll("[data-clr]"), function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-clr"), pp = readPatch() || newPatch(); pushUndo(pp);
        if (k === "ohlc") pp.ohlcFix = {};
        else if (k === "resupply") pp.resupply = {};
        else if (k === "exempt") pp.exempt = [];
        else pp[k] = [];
        writePatch(pp); location.reload();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-unex]"), function (b) {
      b.addEventListener("click", function () {
        var q = b.getAttribute("data-unex").split("|");
        var pp = readPatch() || newPatch(); pushUndo(pp);
        pp.exempt = (pp.exempt || []).filter(function (x) { return !(x.id === q[0] && x.c === q[1]); });
        writePatch(pp); location.reload();
      });
    });
  }
  /* v47：随包状态注入完成后立即重放补丁并刷新状态行（applyPatch 自身幂等） */
  window.addEventListener("wufu:bundled-ready", function () {
    try { ensureVolMerged(false); applyPatch(); renderState(); }
    catch (e) { }
  });
  window.WufuFy = { checkFactors: checkFactors, fixFactors: fixFactors, render: renderFyFactorReport };
  window.WufuFix = {
    fix: ohlcFixRun,
    undo: ohlcFixUndo,
    count: function () { var p = readPatch(); return p && p.ohlcFix ? Object.keys(p.ohlcFix).length : 0; },
    resupply: resupplyRun,
    swap: swapRun,
    refactor: refactorRun,
    exempt: exemptRun,
    unexempt: unexemptRun,
    clearExempt: clearExemptRun,
    exemptList: exemptList,
    clearAll: clearAllFix,
    renderList: renderFixList
  };

  function applyCorrections(p) {
    var list = p && p.corrections; if (!list || !list.length) return;
    var d = gD(), r = gR();
    if (!d || !d.calendar || !d.series) return;
    var cidx = {}; d.calendar.forEach(function (x, i) { cidx[x] = i; });
    list.forEach(function (x) {
      var i = cidx[x.date], sv = d.series[x.c];
      if (i === undefined || !sv) return;
      var v = x.values || {};
      Object.keys(v).forEach(function (f) { if (Array.isArray(sv[f])) sv[f][i] = v[f]; });
      if (r && v.close !== undefined) ["series", "index"].forEach(function (sec) {
        if (r[sec] && Array.isArray(r[sec][x.c])) r[sec][x.c][i] = v.close;
      });
      if (window.WUFU_LAST && v.close !== undefined && x.date === d.calendar[d.calendar.length - 1])
        window.WUFU_LAST[x.c] = x.date;
    });
    window.__corrOK = list.length;
  }
  function corrValues(c, o, cl, hi, lo, amt) {
    var d = gD(), sv = d && d.series[c]; if (!sv) return null;
    if ([o, cl, hi, lo].some(function (x) { return x === null || !isFinite(x) || x <= 0; })) return null;
    if (hi < Math.max(o, cl) - 1e-6 || lo > Math.min(o, cl) + 1e-6) return null;
    var rc = lastVal(sv.raw_close), cc = lastVal(sv.close);
    var fac = (rc > 0 && cc > 0) ? cc / rc : 1;
    var v = { raw_open: o, raw_close: cl, open: rnd(o * fac, 6), close: rnd(cl * fac, 6),
      high: rnd(hi * fac, 6), low: rnd(lo * fac, 6) };
    if (amt !== null && amt > 0 && Array.isArray(sv.amount)) v.amount = rnd(amt, 4);
    return v;
  }
  async function corrBars(c) {
    if (SKIP[c]) throw new Error("万得微盘无免费源");
    if (CSI[c]) {
      try { return await emFetch(CSI[c]); }
      catch (e) {
        var q = await qtFetch(["cs" + CSI[c]]), rec = q["cs" + CSI[c]];
        if (!rec) throw e;
        var m = {}; m[rec.date] = rec; return m;
      }
    }
    if (USETF[c]) {
      var sym = USETF[c], vn = "_wufuCorr_" + sym;
      try {
        return parseSina(await jsonpVar(SINA + "var%20" + vn + "=/US_MinKService.getDailyK?symbol=" + sym +
          "&___qn=3&_=" + Date.now(), vn, 15000));
      } catch (e) { return parseTx(await txFetch("us" + sym, 90), true); }
    }
    var fyp = (FY_KEY && !FY_DEAD) ? fyPath(c) : null;
    if (fyp) {
      try {
        var st = Date.now() - 420 * 86400000;
        return fyBars(await fyGet(fyp, "?thscode=" + encodeURIComponent(c) +
          "&interval=1d&start=" + st + "&end=" + Date.now()));
      } catch (e) { /* 落到腾讯 */ }
    }
    var tc = txCode(c); if (!tc) throw new Error("无代码映射");
    return parseTx(await txFetch(tc, 90));
  }
  function scanIssues() {
    var d = gD(), out = [];
    if (!d || !d.calendar || !d.series) return out;
    var cal = d.calendar, L = cal.length;
    Object.keys(d.series).forEach(function (c) {
      var sv = d.series[c];
      Object.keys(sv).forEach(function (f) {
        if (Array.isArray(sv[f]) && sv[f].length !== L)
          out.push({ c: c, d: "—", f: f, v: sv[f].length, m: "序列长度 " + sv[f].length + " ≠ 日历 " + L });
      });
      var from = Math.max(1, L - 90);
      for (var i = from; i < L; i++) {
        var o = sv.open && sv.open[i], cl = sv.close && sv.close[i];
        var hi = sv.high && sv.high[i], lo = sv.low && sv.low[i];
        if (isMiss(o) || isMiss(cl)) continue;
        if (!isFinite(o) || !isFinite(cl) || o <= 0 || cl <= 0) {
          out.push({ c: c, d: cal[i], f: "open/close", v: o + "/" + cl, m: "非有限或非正值" }); continue;
        }
        if (!isMiss(hi) && !isMiss(lo) && hi > 0 && lo > 0 &&
            (hi < Math.max(o, cl) - 1e-6 || lo > Math.min(o, cl) + 1e-6))
          out.push({ c: c, d: cal[i], f: "OHLC", v: [o, cl, hi, lo].join("/"), m: "四价矛盾" });
        var pv = sv.close[i - 1];
        if (!isMiss(pv) && pv > 0 && Math.abs(cl / pv - 1) > 0.25)
          out.push({ c: c, d: cal[i], f: "close", v: cl, m: "单日跳变 " + ((cl / pv - 1) * 100).toFixed(1) + "%" });
        var am = sv.amount && sv.amount[i], vo = sv.volume && sv.volume[i], rc = sv.raw_close && sv.raw_close[i];
        var isEtf = /^\d{6}\.(SH|SZ|BJ)$/.test(c);   // 指数点位与量额不同量纲，跳过
        if (isEtf && am > 0 && vo > 0 && rc > 0) {
          var px = am / vo, q = px / rc;
          if (q > 8 || q < 0.125) out.push({ c: c, d: cal[i], f: "amount/volume", v: px.toFixed(3),
            m: "量纲异常（均价 " + px.toFixed(2) + " vs 收盘 " + rc + "）" });
        }
      }
    });
    return out;
  }

  /* ---------------- 纠正面板 ---------------- */
  function fillCorrCodes() {
    var sel = $("wufuCorrCode"), d = gD();
    if (!sel || !d || !d.series || sel.options.length) return;
    var cs = Object.keys(d.series).sort();
    sel.innerHTML = cs.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("");
    var dt = $("wufuCorrDate");
    if (dt && !dt.value && d.calendar && d.calendar.length) dt.value = d.calendar[d.calendar.length - 1];
  }
  function renderCorr() {
    var box = $("wufuCorrList"); if (!box) return;
    var p = readPatch(), list = (p && p.corrections) || [];
    var st = $("wufuCorrState");
    if (st) st.textContent = "人工纠正 " + list.length + " 处 · 可撤销 " + readUndo().length + " 次";
    if (!list.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    var h = ['<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:440px"><thead><tr><th>标的</th><th>日期</th><th>收盘(未复权)</th><th>时间</th><th></th></tr></thead><tbody>'];
    list.slice().reverse().forEach(function (x) {
      h.push('<tr><td>' + esc(x.c) + '</td><td>' + esc(x.date) + '</td><td>' +
        esc(x.values && x.values.raw_close) + '</td><td style="font-size:10px">' + esc(x.ts || "") +
        '</td><td><button class="corr-mini" data-delcorr="' + esc(x.c + "|" + x.date) + '">撤销该条</button></td></tr>');
    });
    h.push('</tbody></table></div>');
    box.innerHTML = h.join(""); box.style.display = "";
    Array.prototype.forEach.call(box.querySelectorAll("[data-delcorr]"), function (b) {
      b.addEventListener("click", function () {
        var q = b.getAttribute("data-delcorr").split("|");
        var pp = readPatch() || newPatch();
        pushUndo(pp);
        pp.corrections = (pp.corrections || []).filter(function (x) { return !(x.c === q[0] && x.date === q[1]); });
        writePatch(pp); location.reload();
      });
    });
  }
  function renderScan(list) {
    var box = $("wufuCorrList"); if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = WufuTheme.sub('<p style="font-size:11px;color:§WFT0006§;margin:6px 0">扫描完成：未发现异常。</p>');
      box.style.display = ""; return;
    }
    var h = [WufuTheme.sub('<p style="font-size:11px;color:§WFT0014§;margin:6px 0">发现 ') + list.length +
      ' 条疑似异常（最近 90 日 + 全库序列长度），点「填入」预填纠正表单：</p>',
      '<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:560px"><thead><tr><th>标的</th><th>日期</th><th>问题</th><th>当前值</th><th></th></tr></thead><tbody>'];
    list.slice(0, 60).forEach(function (x) {
      h.push('<tr><td>' + esc(x.c) + '</td><td>' + esc(x.d) + '</td><td>' + esc(x.m) + '</td><td>' + esc(x.v) +
        '</td><td><button class="corr-mini" data-fill="' + esc(x.c + "|" + x.d) + '">填入</button></td></tr>');
    });
    h.push('</tbody></table></div><p class="swipehint">表格较宽，可左右滑动查看 →</p>');
    box.innerHTML = h.join(""); box.style.display = "";
    Array.prototype.forEach.call(box.querySelectorAll("[data-fill]"), function (b) {
      b.addEventListener("click", function () {
        var q = b.getAttribute("data-fill").split("|");
        var sel = $("wufuCorrCode"), dt = $("wufuCorrDate");
        if (sel) sel.value = q[0]; if (dt) dt.value = q[1];
        var w = $("wufuCorrWrap"); if (w) w.open = true;
        note("已把 " + q[0] + " / " + q[1] + " 填入纠正表单，请核对四价后保存。", "");
      });
    });
  }
  function corrRead() {
    var g = function (id) { var e = $(id); return e ? num(e.value) : null; };
    return { c: ($("wufuCorrCode") || {}).value || "", d: ($("wufuCorrDate") || {}).value || "",
      o: g("wufuCorrO"), cl: g("wufuCorrC"), h: g("wufuCorrH"), l: g("wufuCorrL"), a: g("wufuCorrA") };
  }
  function corrPrecheck(x) {
    var d = gD();
    if (!x.c || !x.d) { note("请先选标的和日期。", "err"); return false; }
    if (!d || !d.calendar || d.calendar.indexOf(x.d) < 0) { note("日期不在行情日历内，只能纠正已有交易日。", "err"); return false; }
    return true;
  }
  function corrSave() {
    var x = corrRead(); if (!corrPrecheck(x)) return;
    if ([x.o, x.cl, x.h, x.l].some(function (v) { return v === null || !isFinite(v); })) { note("四个价格都要填数字。", "err"); return; }
    var v = corrValues(x.c, x.o, x.cl, x.h, x.l, x.a);
    if (!v) { note("四价矛盾或数值非法（高≥max(开,收)，低≤min(开,收)，均>0），未保存。", "err"); return; }
    var p = readPatch() || newPatch();
    pushUndo(p);
    p.corrections = (p.corrections || []).filter(function (y) { return !(y.c === x.c && y.date === x.d); });
    p.corrections.push({ c: x.c, date: x.d, values: v, ts: new Date().toLocaleString("zh-CN", { hour12: false }) });
    writePatch(p); applyPatch(); renderState(); renderCorr();
    note("已保存人工纠正：" + x.c + " / " + x.d + "。该值优先于自动更新，刷新与再次更新都不会被冲掉。", "");
  }
  async function corrRefetch() {
    var x = corrRead(); if (!corrPrecheck(x)) return;
    note("正在从数据源重拉 " + x.c + " / " + x.d + " …", "");
    try {
      var m = await corrBars(x.c), b = pickBar(m, x.c, x.d);
      if (!b || b.c === null) throw new Error("该日在数据源里没有行情");
      var ids = ["wufuCorrO", "wufuCorrC", "wufuCorrH", "wufuCorrL", "wufuCorrA"];
      var vals = [b.o, b.c, b.h, b.l, b.a];
      ids.forEach(function (id, k) { var e = $(id); if (e) e.value = (vals[k] === null || vals[k] === undefined) ? "" : vals[k]; });
      note("已取到 " + x.c + " / " + x.d + " 的源数据并填入表单，请核对后点「保存人工纠正」。", "");
    } catch (e) { note("重拉失败：" + ((e && e.message) || e) + "。可留空 Key 重试，或手动填入数值。", "err"); }
  }
  function corrClear() {
    var p = readPatch() || newPatch();
    if (!p.corrections || !p.corrections.length) { note("当前没有人工纠正。", "warn"); return; }
    if (!confirm("清除全部 " + p.corrections.length + " 处人工纠正？页面将刷新，回到自动更新的原始值。")) return;
    pushUndo(p); p.corrections = []; writePatch(p); location.reload();
  }

  function bootApply() {
    var tries = 0, ready = 0;
    var iv = setInterval(function () {
      tries++;
      ensureVolMerged(false);
      applyPatch();
      if (gD() && gR()) ready++;
      if (ready >= 3 || tries > 600) { clearInterval(iv); applyPatch(); renderState(); }
    }, 300);
    /* 行情块是懒加载的：D 可能在上面最后一轮之后才被 ensureData 整体替换。
       延迟再回放几次，保证净值 / OHLC / 自定义标的等补丁落在最终 D 上（全程幂等）。 */
    [1200, 3000, 6000].forEach(function (ms) {
      setTimeout(function () {
        try { ensureVolMerged(false); applyPatch(); renderState(); } catch (e) { }
      }, ms);
    });
  }

  /* ---------------- 计算新值 ---------------- */
  function sharesBasis(sv) {
    var vol = sv.volume, to = sv.turnover;
    if (!vol || !to) return null;
    // 份额基准会随 ETF 申赎变化，只取最近 8 个有效日（30 日中位数会把旧份额混进来）
    var rr = [], n = Math.min(vol.length, to.length);
    for (var i = n - 1; i >= Math.max(0, n - 60) && rr.length < 8; i--) {
      var v = vol[i], t = to[i];
      if (v > 0 && t > 0) rr.push(v / (t / 100));
    }
    if (rr.length < 3) return null;
    rr.sort(function (a, b) { return a - b; });
    return rr[Math.floor(rr.length / 2)];
  }
  function buildValues(d, c, bar) {
    var sv = d.series[c];
    if (!sv || !bar) return null;
    var o = bar.o, cl = bar.c, hi = bar.h, lo = bar.l;
    if ([o, cl, hi, lo].some(function (x) { return x === null || !isFinite(x) || x <= 0; })) return null;
    if (hi < Math.max(o, cl) - 1e-6 || lo > Math.min(o, cl) + 1e-6) return null;   // 四价矛盾
    var rc = lastVal(sv.raw_close), cc = lastVal(sv.close);
    if (rc === null || rc <= 0 || cc === null) return null;
    if (Math.abs(cl / rc - 1) > 0.25) return null;                                 // 单日跳变 >25% → 量纲错误
    var fac = cc / rc, out = {};
    out.raw_open = o; out.raw_close = cl;
    out.open = rnd(o * fac, 6); out.close = rnd(cl * fac, 6);
    out.high = rnd(hi * fac, 6); out.low = rnd(lo * fac, 6);
    var nn = sv.nav ? lastVal(sv.nav) : null;
    if (sv.nav) {
      if (nn === null || nn === -1) out.nav = -1;
      else if (Math.abs(nn - cc) < 1e-6) out.nav = out.close;
      else out.nav = rnd(nn * (cl / rc), 6);
    }
    if (sv.premium && Array.isArray(sv.premium)) {
      var nv = out.nav;
      out.premium = (nv && nv > 0) ? rnd((cl - nv) / nv, 8) : -1;
    }
    if (sv.volume) {
      var vPrev = lastVal(sv.volume), aPrev = lastVal(sv.amount);
      var isIdxStyle = (vPrev === 0 || aPrev === 0);
      var isBlank = (vPrev === -1 || vPrev === null);
      if (isIdxStyle) { out.volume = 0; out.amount = 0; if (sv.turnover) out.turnover = 0; }
      else if (isBlank || CSI[c]) {
        out.volume = -1; out.amount = -1; if (sv.turnover) out.turnover = -1;
      } else {
        out.volume = (bar.v !== null && bar.v > 0) ? rnd(bar.v, 4) : -1;
        out.amount = (bar.a !== null && bar.a > 0) ? rnd(bar.a, 4) : -1;
        if (sv.turnover) {
          out.turnover = (bar.to !== null && bar.to !== undefined && bar.to > 0) ? rnd(bar.to, 4) : -1;
        }
      }
    }
    return out;
  }
  function pickBar(bars, c, date) {
    var m = bars[c]; if (!m) return null;
    if (USIDX[c]) {                                    // 美股指数：A股日历 d 装「d 之前最近一个美股交易日」
      var ks = Object.keys(m).filter(function (x) { return x < date; }).sort();
      return ks.length ? m[ks[ks.length - 1]] : null;
    }
    return m[date] || null;
  }

  /* ---------------- UI ---------------- */
  function note(msg, color) {
    var e = $("wufuUpdMsg"); if (!e) return;
    e.style.display = ""; e.textContent = msg;
    e.style.background = color === "err" ? WufuTheme.sub("§WFT0054§") : (color === "warn" ? WufuTheme.sub("§WFT0038§") : WufuTheme.sub("§WFT0100§"));
    e.style.border = "1px solid " + (color === "err" ? WufuTheme.sub("§WFT0010§") : color === "warn" ? WufuTheme.sub("§WFT0011§") : WufuTheme.sub("§WFT0006§"));
    e.style.color = color === "err" ? WufuTheme.sub("§WFT0010§") : color === "warn" ? WufuTheme.sub("§WFT0014§") : WufuTheme.sub("§WFT0049§");
  }
  /* 净值补齐专用反馈：同时写「一键更新」卡片与当前所在的净值清单，避免提示在屏幕外 */
  function navNote(msg, color) {
    note(msg, color);
    var e = $("pmNavMsg"); if (!e) return;
    e.style.display = ""; e.style.whiteSpace = "pre-line"; e.textContent = msg;
    e.style.background = color === "err" ? WufuTheme.sub("§WFT0054§") : (color === "warn" ? WufuTheme.sub("§WFT0038§") : WufuTheme.sub("§WFT0100§"));
    e.style.border = "1px solid " + (color === "err" ? WufuTheme.sub("§WFT0010§") : color === "warn" ? WufuTheme.sub("§WFT0011§") : WufuTheme.sub("§WFT0006§"));
    e.style.color = color === "err" ? WufuTheme.sub("§WFT0010§") : color === "warn" ? WufuTheme.sub("§WFT0014§") : WufuTheme.sub("§WFT0049§");
    try { e.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (x) { }
  }
  function syncNavKeyUI() {
    var a = $("wufuFyKey"), b = $("pmNavKey"), st = $("pmNavKeyState");
    // 双向同步：输入框里已有值而内存为空时，把值提升为 Key，绝不反向清空。
    // 修复：扫描/展开清单会调用本函数，旧逻辑用空 FY_KEY 覆盖了用户刚填的 Key。
    var av = a ? String(a.value || "").trim() : "", bv = b ? String(b.value || "").trim() : "";
    if (!FY_KEY && (av || bv)) FY_KEY = av || bv;       // 输入框里已有值 → 提升为 Key
    if (FY_KEY && !av && !bv) FY_KEY = "";               // 两个框都被清空 → 主动停用扶摇
    if (a && a.value !== FY_KEY) a.value = FY_KEY;
    if (b && b.value !== FY_KEY) b.value = FY_KEY;
    if (st) { st.textContent = FY_KEY ? "已启用 · 仅本次会话" : "未启用"; st.style.color = FY_KEY ? WufuTheme.sub("§WFT0006§") : WufuTheme.sub("§WFT0014§"); }
    var s2 = $("wufuFyState"); if (s2) { s2.textContent = FY_KEY ? "已启用（仅本次会话，不保存）" : "未启用 · 全部走免费源"; s2.style.color = FY_KEY ? WufuTheme.sub("§WFT0006§") : WufuTheme.sub("§WFT0002§"); }
  }
  function busy(on) {
    ["wufuUpdRun", "wufuUpdHtml", "wufuUpdPkg", "wufuUpdClear", "wufuUpdUndo",
     "wufuCorrScan", "wufuCorrSave", "wufuCorrRefetch", "wufuCorrUndo"].forEach(function (id) { var e = $(id); if (e) e.disabled = !!on; });
    var b = $("wufuUpdBar"); if (b) b.style.display = on ? "" : "none";
    var f = $("wufuUpdFill"); if (f && !on) f.style.width = "0%";
  }
  function prog(p) { var f = $("wufuUpdFill"); if (f) f.style.width = Math.round(p * 100) + "%"; }
  function renderState() {
    var e = $("wufuUpdState"); if (!e) return;
    var p = readPatch(), d = gD();
    var n = p && p.days ? p.days.filter(function (x) { return !x.fixOnly; }).length : 0;
    var last = d && d.calendar ? d.calendar[d.calendar.length - 1] : "—";
    var nf = (p && p.ohlcFix) ? Object.keys(p.ohlcFix).length : 0;
    var fx = p || {};
    var nz = (fx.resupply ? Object.keys(fx.resupply).length : 0) + (fx.swaps || []).length +
      (fx.refactors || []).length + (fx.exempt || []).length;
    var nnav = fx.navFix ? Object.keys(fx.navFix).length : 0;
    e.textContent = "本机增量 " + n + " 天 · 人工纠正 " + ((p && p.corrections) || []).length +
      " 处 · 体检纠正 " + (nf + nz) + " 条 · 扶摇净值 " + nnav + " 只 · 可撤销 " + readUndo().length + " 次 · 当前末日 " + last;
    var os = $("wufuOhlcState");
    if (os) os.textContent = nf ? "已修复 " + nf + " 只标的的 OHL 缺失/矛盾（刷新仍生效）" : "暂无 OHLC 修复记录";
    if (p && p.report) renderReport(p.report);
    try { fillCorrCodes(); renderCorr(); renderFixList(); } catch (e) { }
  }
  function renderReport(rep) {
    var box = $("wufuUpdReport"); if (!box || !rep) return;
    var h = [];
    h.push('<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px">');
    [["新增交易日", rep.dates.length], ["成功更新", rep.ok.length], ["跳过", rep.skip.length],
      ["失败/留空", rep.fail.length], ["回填补齐", rep.fix.length],
      ["异常条目", rep.issues === undefined ? "—" : rep.issues],
      ["净值真值日", rep.navRows === undefined ? "—" : rep.navRows]].forEach(function (x) {
      h.push(WufuTheme.sub('<div style="background:§WFT0007§;border:1px solid §WFT0016§;border-radius:6px;padding:8px 10px">') +
        WufuTheme.sub('<div style="font-size:11px;color:§WFT0002§">') + x[0] + WufuTheme.sub('</div><div style="font-size:18px;color:§WFT0005§">') + x[1] + '</div></div>');
    });
    h.push('</div>');
    h.push(WufuTheme.sub('<p style="font-size:11px;color:§WFT0003§;margin:0 0 8px;line-height:1.7">新增日期：<b style="color:§WFT0005§">') +
      esc((rep.dates || []).join("、") || "无") + '</b>　·　数据源：' + esc(rep.sources || "") +
      '　·　更新时刻 ' + esc(rep.ts || "") + '</p>');
    if (rep.fail.length) {
      h.push('<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:520px"><thead><tr>' +
        '<th style="width:150px">标的</th><th style="width:110px">结果</th><th>说明</th></tr></thead><tbody>');
      rep.fail.slice(0, 200).forEach(function (x) {
        h.push('<tr><td>' + esc(x.c) + WufuTheme.sub('</td><td style="color:§WFT0010§">未更新</td><td>') + esc(x.m) + '</td></tr>');
      });
      h.push('</tbody></table></div><p class="swipehint">表格较宽，可左右滑动查看 →</p>');
    }
    if (rep.micro && rep.micro !== "未启用" && rep.micro !== "返回空" && rep.micro.indexOf("失败") !== 0)
      h.push(WufuTheme.sub('<p style="font-size:11px;color:§WFT0006§;margin:8px 0 0;line-height:1.7">微盘标尺 883418.TI 已更新（') +
        esc(rep.micro) + '），可在相关性页与基准下拉中查看；原有序列未作任何改动。</p>');
    h.push(WufuTheme.sub('<p style="font-size:11px;color:§WFT0002§;margin:8px 0 0;line-height:1.7">未更新的标的保持原序列不变，新增日期一律留 -1；') +
      WufuTheme.sub('<b style="color:§WFT0014§">不做涨幅外推、不做前值填充、不做量价估算</b>。换手率取行情源真实换手率（腾讯日K day[7]），源未提供时留 -1，不做推算。</p>'));
    h.push(WufuTheme.sub('<p style="font-size:11px;color:§WFT0006§;margin:6px 0 0;line-height:1.7">单位净值取扶摇官方 unit_nav 真值（约 2021-11 起，premium 按未复权收盘反算），') +
      '旧标的历史净值段与全部价格序列均未改动；重叠日口径偏差 >2% 的标的自动跳过，只写入近 500 天内缺失或外推不一致的日期。</p>');
    box.innerHTML = h.join(""); box.style.display = "";
  }
  function dl(name, text, mime) {
    var b = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var u = URL.createObjectURL(b), a = document.createElement("a");
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(u); } catch (e) { } }, 800);
  }

  /* ---------------- 主流程 ---------------- */
  async function runUpdate() {
    var d = gD();
    if (!d || !d.calendar || !d.series) { note("行情数据尚未加载完成，请先点一次「下一步」或切到本页稍候。", "err"); return; }
    await ensureVolMerged(true);
    busy(true); prog(0.02);
    note("正在探测新增交易日…", "");
    var rep = { dates: [], ok: [], skip: [], fail: [], fix: [], sources: "", ts: "" };
    var failSeen = {}, fixSeen = {};
    try {
      var cal = d.calendar, last = cal[cal.length - 1];
      var srcStat = { tx: 0, sina: "未用", em: "未用", qt: "未用",
        emMain: 0, txFallback: 0, emFail: 0, usPending: "东财 suggest 未验通，美股3只暂留新浪→腾讯链",
        fy: 0, fyFail: 0, cal: "", micro: "未启用" };
      var fyUsed = {}, patchMicro = null;
      FY_FAIL = 0; FY_DEAD = false;
      var cand = [];
      if (FY_KEY && !FY_DEAD) {
        try {
          var fcal = await fyGet(FY_CAL, "");
          var seen = {};
          fcal.forEach(function (o) {
            var dt = fyDate(o);
            if (dt && dt > last && dt <= todayBJ() && !seen[dt]) { seen[dt] = 1; cand.push(dt); }
          });
          cand.sort();
          if (!cand.length) throw new Error("日历无新增日");
          srcStat.cal = "扶摇官方交易日历";
        } catch (e) { cand = []; srcStat.cal = "扶摇日历失败→腾讯"; }
      }
      if (!cand.length) {
        try {
          var baseMap = parseTx(await txFetch("sh000001", 60));
          cand = Object.keys(baseMap).filter(function (x) { return x > last && x <= todayBJ(); }).sort();
          srcStat.cal = "腾讯 sh000001" + (srcStat.cal ? "（" + srcStat.cal + "）" : "");
        } catch (e) {
          // 关键：日历探测只是前置尝试，失败不得整批中断（此前它一失败就全量回滚）
          cand = [];
          srcStat.cal = (srcStat.cal ? srcStat.cal + "；" : "") +
            "腾讯日历探测失败(" + ((e && e.message) || "网络") + ")";
          rep.fail.push({ c: "交易日历", m: "无法探测新增交易日（" +
            ((e && e.message) || "网络失败") + "）；不中断，继续做回填与校验" });
        }
      }
      var newdays = cand.filter(function (dt) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || dt > todayBJ()) return false;
        if (dt === todayBJ() && bjHour() < 15.2) return false;   // 未收盘不收
        return true;
      });
      if (!newdays.length) note("没有新的交易日可追加（当前末日 " + last + "）；仍会尝试回填已有缺口。", "warn");
      rep.dates = newdays.slice();

      var codes = Object.keys(d.series);
      var bars = {}, prevClose = {};
      var total = codes.length, done = 0;

      var tasks = codes.map(function (c) { return async function () {
        try {
          if (SKIP[c]) { pushUniq(rep.skip, c, { c: c, m: "万得微盘 · Wind 专有，无免费源（数据止 2026-10-23）" }, failSeen); return; }
          if (CSI[c]) {
            try {
              bars[c] = await emFetch(CSI[c]); srcStat.em = "可用";
            } catch (e) {
              srcStat.em = "失败(" + ((e && e.message) || "限流") + ")";
              var q = await qtFetch(["cs" + CSI[c]]);
              var rec = q["cs" + CSI[c]];
              if (!rec) throw new Error("东财与腾讯实时均不可用");
              bars[c] = {}; bars[c][rec.date] = rec;
              prevClose[c] = rec.prev; srcStat.qt = "已兜底(当日+昨收)";
            }
          } else if (USETF[c]) {
            /* 暂不切东财：suggest 接口实测 403，105.SPY / 105.TIP 返回 0 行，QuoteID 未验通 */
            var sym = USETF[c], vn = "_wufuUS_" + sym;
            try {
              var arr = await jsonpVar(SINA + "var%20" + vn + "=/US_MinKService.getDailyK?symbol=" + sym +
                "&___qn=3&_=" + Date.now(), vn, 15000);
              bars[c] = parseSina(arr); srcStat.sina = "可用";
            } catch (e) {
              bars[c] = parseTx(await txFetch("us" + sym, 12), true);
              srcStat.sina = "失败→腾讯us*兜底(仅当日)";
            }
          } else {
            var fyp = (FY_KEY && !FY_DEAD) ? fyPath(c) : null;
            if (fyp) {
              try {
                var st = Date.now() - 420 * 86400000;
                var fa = await fyGet(fyp, "?thscode=" + encodeURIComponent(c) +
                  "&interval=1d&start=" + st + "&end=" + Date.now());
                bars[c] = fyBars(fa); fyUsed[c] = 1; srcStat.fy++;
                // 扶摇日K不含换手率字段：新增日 turnover 固定取腾讯真值，避免回落推算
                try { var _tc = txCode(c); if (_tc) { var _tx = parseTx(await txFetch(_tc, 60));
                  Object.keys(bars[c]).forEach(function (_dt) { if (_tx[_dt] && _tx[_dt].to > 0) bars[c][_dt].to = _tx[_dt].to; }); } } catch (e) { }
              } catch (e) {
                var tc2 = txCode(c);
                if (!tc2) throw new Error("无代码映射");
                bars[c] = parseTx(await txFetch(tc2, 60)); srcStat.tx++; srcStat.fyFail++;
              }
            } else {
              /* v0.69 方案甲：6 位 A股/跨境 ETF 主源统一东财 push2his，腾讯仅失败兜底 */
              var m6 = /^(\d{6})\.(SH|SZ|BJ)$/.exec(c);
              if (m6) {
                try {
                  bars[c] = await emFetch(m6[1], m6[2] === "SH" ? "1" : "0");
                  srcStat.emMain++;
                } catch (e) {
                  var tc = txCode(c);
                  if (!tc) throw new Error("无代码映射");
                  bars[c] = parseTx(await txFetch(tc, 60));
                  srcStat.txFallback++; srcStat.emFail++;
                }
              } else {
                /* 美股指数 / 港股 / 特色指数：无 6 位 A股代码，保持原腾讯映射 */
                var tc = txCode(c);
                if (!tc) throw new Error("无代码映射");
                bars[c] = parseTx(await txFetch(tc, 60)); srcStat.tx++;
              }
            }
          }
        } catch (e) {
          pushUniq(rep.fail, "src|" + c, { c: c, m: "数据源不可用：" + ((e && e.message) || "未知") }, failSeen);
        } finally { done++; prog(0.05 + 0.75 * done / total); }
      }; });
      await pool(tasks, 6);

      // 扶摇单位净值真值（只补 nav / premium；价格一律不碰）
      var navStat = { ok: 0, rows: 0, skip: 0 }, navFix = {};
      if (FY_KEY && !FY_DEAD) {
        var navCalIdx = {}; cal.concat(newdays).forEach(function (x, i) { navCalIdx[x] = i; });
        var navCut = new Date(Date.now() - 500 * 86400000).toISOString().slice(0, 10);
        var navCodes = codes.filter(function (c) {
          return /^\d{6}\.(SH|SZ)$/.test(c) && d.series[c] && Array.isArray(d.series[c].nav);
        });
        var nts = navCodes.map(function (c) { return async function () {
          try {
            var m = await fyNav(c);
            if (!Object.keys(m).length) { navStat.skip++; return; }
            if (!navAcceptable(d, c, m, cal)) { navStat.skip++; return; }
            // 系统历史 nav 本就是真值，只写"近 500 天内缺失/外推不一致"的日子 + 新增交易日
            var keep = {};
            Object.keys(m).forEach(function (dt) {
              if (dt < navCut) return;
              var i = navCalIdx[dt]; if (i === undefined) return;
              var cur = (i < cal.length) ? d.series[c].nav[i] : null;
              if (!(cur > 0) || Math.abs(cur - m[dt]) > 1e-4) keep[dt] = m[dt];
            });
            if (!Object.keys(keep).length) { navStat.skip++; return; }
            navFix[c] = keep; navStat.ok++; navStat.rows += Object.keys(keep).length;
          } catch (e) { navStat.skip++; }
        }; });
        await pool(nts, 4);
      }

      // 微盘观察标尺（独立标的，不覆盖任何既有序列）
      if (FY_KEY && !FY_DEAD) {
        try {
          var mst = Date.now() - 430 * 86400000;
          var mArr = await fyGet(FY_IDX, "?thscode=" + encodeURIComponent(FY_MICRO_CODE) +
            "&interval=1d&start=" + mst + "&end=" + Date.now());
          var mBars = fyBars(mArr);
          if (Object.keys(mBars).length) {
            patchMicro = { code: FY_MICRO_CODE, name: FY_MICRO_NAME, bars: mBars };
            srcStat.micro = Object.keys(mBars).length + " 个真值日";
          } else srcStat.micro = "返回空";
        } catch (e) { srcStat.micro = "失败(" + ((e && e.message) || "") + ")"; }
      }

      // 重叠日逐值校验（不通过 → 该标的整条不更新）
      var bad = {};
      codes.forEach(function (c) {
        if (SKIP[c] || !bars[c]) return;
        var sv = d.series[c], arr = sv.raw_close || sv.close;
        if (!arr) { bad[c] = "系统无价格序列"; return; }
        var idxs = [];
        for (var i = Math.max(0, cal.length - 12); i < cal.length; i++) if (arr[i] > 0) idxs.push(i);
        var tested = 0, mx = 0;
        for (var q = idxs.length - 1; q >= 0 && tested < 4; q--) {
          var ii = idxs[q], b = pickBar(bars, c, cal[ii]);
          if (!b || b.c === null) continue;
          var df = Math.abs(b.c / arr[ii] - 1);
          if (df > mx) mx = df; tested++;
        }
        if (!tested && prevClose[c] !== undefined) {
          var lv = lastVal(arr);
          if (lv) { mx = Math.abs(prevClose[c] / lv - 1); tested = 1; }
        }
        if (!tested) { bad[c] = "源无重叠日，无法校验口径"; return; }
        if (mx > 0.002) bad[c] = "重叠日口径偏差 " + (mx * 100).toFixed(3) + "%（>0.2%）";
        if (fyUsed[c] && !bad[c]) fyAmountCheck(d, c, bars[c], cal);
      });
      Object.keys(bad).forEach(function (c) {
        pushUniq(rep.fail, "bad|" + c, { c: c, m: bad[c] }, failSeen);
      });

      var patch = readPatch() || newPatch();
      if (patchMicro) patch.scale = patchMicro;
      if (navStat.ok) { patch.navFix = patch.navFix || {}; Object.keys(navFix).forEach(function (c) {
        patch.navFix[c] = Object.assign(patch.navFix[c] || {}, navFix[c]); }); }
      var backDates = cal.slice(-5).concat(newdays);

      for (var di = 0; di < newdays.length; di++) {
        var date = newdays[di];
        var base = di === 0 ? last : newdays[di - 1];
        var e = { base: base, date: date, series: {}, rd: { series: {}, index: {} }, index: {}, last: {}, fix: {} };
        codes.forEach(function (c) {
          if (SKIP[c] || bad[c] || !bars[c]) return;
          var b = pickBar(bars, c, date);
          if (!b) { pushUniq(rep.fail, "nodata|" + c, { c: c, m: date + " 无当日行情（留 -1）" }, failSeen); return; }
          var v = buildValues(d, c, b);
          if (!v) { pushUniq(rep.fail, "val|" + c, { c: c, m: date + " 四价矛盾 / 单日跳变>25% / 量纲异常" }, failSeen); return; }
          e.series[c] = v; e.last[c] = date;
          if (rep.ok.indexOf(c) < 0) rep.ok.push(c);
        });
        var r = gR();
        if (r) ["series", "index"].forEach(function (sec) {
          if (!r[sec]) return;
          Object.keys(r[sec]).forEach(function (k) {
            e.rd[sec][k] = (e.series[k] && e.series[k].close !== undefined) ? e.series[k].close : -1;
          });
        });
        if (d.index) Object.keys(d.index).forEach(function (k) {
          var kc = k.replace(/^index_/, "");
          e.index[k] = (e.series[kc] && e.series[kc].close !== undefined) ? e.series[kc].close : -1;
        });
        patch.days.push(e);
        prog(0.8 + 0.18 * (di + 1) / newdays.length);
      }

      // 回填：已有日期里的 -1，若现在抓到真值就补（美股 ETF 隔夜数据常见）
      var fixEntry = { fixOnly: true, base: null, date: null, fix: {} };
      var fullCal = cal.concat(newdays);
      var cidx = {}; fullCal.forEach(function (x, i) { cidx[x] = i; });
      backDates.forEach(function (bdt) {
        var ix = cidx[bdt]; if (ix === undefined) return;
        codes.forEach(function (c) {
          if (SKIP[c] || bad[c] || !bars[c] || !d.series[c]) return;
          var sv = d.series[c], arr = sv.raw_close || sv.close;
          if (!arr || ix >= cal.length) return;                  // 只回填文件里已存在的日期
          if (!isMiss(arr[ix])) return;
          var bb = pickBar(bars, c, bdt);
          if (!bb) return;
          var vv = buildValues(d, c, bb);
          if (!vv) return;
          fixEntry.fix[bdt] = fixEntry.fix[bdt] || {}; fixEntry.fix[bdt][c] = vv;
          pushUniq(rep.fix, c + "@" + bdt, c + "@" + bdt, fixSeen);
        });
      });
      if (Object.keys(fixEntry.fix).length) patch.days.push(fixEntry);

      // 写入前一致性自检：原有序列长度必须全部等于日历长度
      var badLen = [];
      Object.keys(d.series).forEach(function (c) {
        Object.keys(d.series[c]).forEach(function (f) {
          if (Array.isArray(d.series[c][f]) && d.series[c][f].length !== cal.length) badLen.push(c + "." + f);
        });
      });
      if (badLen.length) throw new Error("序列长度不一致：" + badLen.slice(0, 5).join("、"));

      rep.navCodes = navStat.ok; rep.navRows = navStat.rows;
      rep.sources = "扶摇净值 " + navStat.ok + " 只 / " + navStat.rows + " 个真值日" +
        (navStat.skip ? "（跳过 " + navStat.skip + "）" : "") +
        " · 价格主源东财 push2his 未复权(fqt=0)，腾讯 newfqkline 仅失败兜底" +
        " · 东财主源 " + srcStat.emMain + " 只 / 腾讯兜底 " + srcStat.txFallback + " 只 / 东财失败 " + srcStat.emFail + " 只" +
        " · 交易日历 " + srcStat.cal + " · 微盘标尺 " + srcStat.micro +
        " · 其它腾讯映射 " + srcStat.tx + " 只 · 新浪美股 " + srcStat.sina + "（" + srcStat.usPending + "）" +
        " · CSI东财 " + srcStat.em + " · 腾讯实时 " + srcStat.qt;
      rep.micro = srcStat.micro;
      rep.ts = new Date().toLocaleString("zh-CN", { hour12: false });
      try { rep.issues = scanIssues().length; } catch (e) { rep.issues = 0; }
      patch.report = rep; patch.ts = rep.ts;
      if (patch.days.length > 240) patch.days = patch.days.slice(-240);
      pushUndo(readPatch() || newPatch());   // 写入前留快照，供「撤销上次更新」回滚
      var wrote = writePatch(patch);
      /* v46：大仓库写入是异步的，必须等它真落盘才报成功 */
      if (wrote && window.WufuStore && WufuStore.flush) {
        try {
          var _fr = await WufuStore.flush();
          if (!_fr.ok) wrote = false;
        } catch (e) { wrote = false; }
      }
      applyPatch(); renderState(); prog(1);
      note("完成：新增 " + newdays.length + " 个交易日，成功 " + rep.ok.length + " 只 · 跳过 " + rep.skip.length +
        " 只 · 失败/留空 " + rep.fail.length + " 项 · 回填 " + rep.fix.length + " 项" +
        " · 扶摇净值 " + navStat.ok + " 只/" + navStat.rows + " 日。" +
        (wrote ? "已写入本机大仓库，刷新后自动生效。" : "⚠️ 本机存储写入失败（请确认没开无痕/隐私模式），请导出更新包保存。"),
        rep.fail.length ? "warn" : "");
    } catch (err) {
      var em = (err && err.message) || String(err);
      var hint = /Load failed|Failed to fetch|NetworkError|timeout|HTTP 4|HTTP 5|CORS|policy/i.test(em)
        ? "　多为网络层拒绝：本地 file:// 打开时带自定义头的扶摇请求可能被 CORS 预检挡住（Origin=null），"
          + "可先留空 Key 重试；也可能是断网、代理或公司网关拦截。"
        : "";
      note("本次未写入任何数据（已有行情完全不变）：" + em + "。" + hint +
        " 可直接重试；或展开下方「数据纠正」做单日修正。", "err");
    } finally { busy(false); }
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function exportPkg() {
    var p = readPatch();
    var nd = p && p.days ? p.days.filter(function (x) { return !x.fixOnly; }).length : 0;
    var nf = p && p.ohlcFix ? Object.keys(p.ohlcFix).length : 0;
    var hasPool2 = p && ((p.custom && p.custom.length) || (p.hidden && p.hidden.length) || (p.scale && p.scale.bars) || (p.groupCfg && p.groupCfg.groups));
    var hasNav = p && p.navFix && Object.keys(p.navFix).length;
    if (!nd && !nf && !hasNav && !hasHealthFix(p) && !(p && p.corrections && p.corrections.length) && !hasPool2) { note("本机暂无更新包可导出。", "warn"); return; }
    dl("ETF行情更新包_" + todayBJ().replace(/-/g, "") + ".json", JSON.stringify(p), "application/json;charset=utf-8");
    note("更新包已导出（含 " + nd + " 个增量日 · " + nf + " 只 OHLC 修复 · 体检纠正 " + (hasHealthFix(p) ? "已包含" : "无") + "）。在另一台机器点「导入更新包」即可同步。", "");
  }
  function importPkg(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var o = JSON.parse(fr.result);
        if (!o || !(o.days || o.corrections || o.ohlcFix || o.navFix || o.resupply || o.swaps || o.refactors || o.exempt || o.custom || o.hidden || o.scale || o.fyFix || o.fyCheck || o.groupCfg)) throw new Error("文件格式不对");
        var cur = readPatch() || newPatch(), map = {};
        (cur.days || []).concat(o.days || []).forEach(function (e) {
          map[(e.date || "") + "|" + (e.base || "") + "|" + (e.fixOnly ? "f" : "d")] = e;
        });
        cur.days = Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(a.date || "") < String(b.date || "") ? -1 : 1; }).slice(-240);
        cur.corrections = (cur.corrections || []).concat(o.corrections || []);
        cur.resupply = cur.resupply || {};
        Object.keys(o.resupply || {}).forEach(function (c2) {
          cur.resupply[c2] = Object.assign(cur.resupply[c2] || {}, o.resupply[c2]);
        });
        ["swaps", "refactors", "exempt"].forEach(function (kk) { cur[kk] = (cur[kk] || []).concat(o[kk] || []); });
        var exm = {}, swm = {};
        cur.exempt = (cur.exempt || []).filter(function (x) {
          var kk = x.id + "|" + x.c; if (exm[kk]) return false; exm[kk] = 1; return true; });
        cur.swaps = (cur.swaps || []).filter(function (x) {
          var kk = x.id || (x.a + "|" + x.b); if (swm[kk]) return false; swm[kk] = 1; return true; });
        cur.ohlcFix = cur.ohlcFix || {};
        Object.keys(o.ohlcFix || {}).forEach(function (c2) {
          cur.ohlcFix[c2] = Object.assign(cur.ohlcFix[c2] || {}, o.ohlcFix[c2]);
        });
        cur.navFix = cur.navFix || {};
        Object.keys(o.navFix || {}).forEach(function (c3) {
          cur.navFix[c3] = Object.assign(cur.navFix[c3] || {}, o.navFix[c3]);
        });
        var cm = {}; cur.corrections = cur.corrections.filter(function (x) {
          var k = x.c + "|" + x.date; if (cm[k]) return false; cm[k] = 1; return true; });
        var cmap = {};
        (cur.custom || []).forEach(function (x) { cmap[x.code] = x; });
        (o.custom || []).forEach(function (x) { cmap[x.code] = x; });
        cur.custom = Object.keys(cmap).map(function (k2) { return cmap[k2]; });
        var hmap = {};
        (cur.hidden || []).concat(o.hidden || []).forEach(function (x) { hmap[x] = 1; });
        cur.hidden = Object.keys(hmap);
        if (o.scale && o.scale.bars) cur.scale = o.scale;
        if (o.fyFix && Object.keys(o.fyFix).length) cur.fyFix = o.fyFix;
        if (o.groupCfg && o.groupCfg.groups) cur.groupCfg = o.groupCfg;
        if (o.fyCheck) cur.fyCheck = o.fyCheck;
        cur.report = o.report || cur.report; cur.ts = o.ts || cur.ts;
        writePatch(cur);
        note("已导入 " + (o.days || []).length + " 条增量 · " + Object.keys(o.ohlcFix || {}).length + " 只 OHLC 修复 · 自定义标的 " +
          (o.custom || []).length + " 只 · 移出 " + (o.hidden || []).length + " 只 · 分组配置 " + (o.groupCfg ? "已包含" : "无") + " · 体检纠正 " +
          (Object.keys(o.resupply || {}).length + (o.swaps || []).length + (o.refactors || []).length + (o.exempt || []).length) + " 条。请刷新页面让数据生效。", "");
        renderState();
      } catch (e) { note("导入失败：" + (e.message || e), "err"); }
    };
    fr.readAsText(file);
  }
  function clearPatch() {
    if (!confirm("清除本机保存的全部行情增量、自定义标的与纠正？文件本身不会被改动，刷新后回到内置数据。")) return;
    try { localStorage.removeItem(KEY); } catch (e) { }
    note("已清除。请刷新页面。", "");
    renderState();
  }
  function gzB64(str) {
    if (typeof CompressionStream === "undefined") return Promise.reject(new Error("浏览器不支持 CompressionStream"));
    var cs = new CompressionStream("gzip"), w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(str)); w.close();
    return new Response(cs.readable).arrayBuffer().then(function (ab) {
      var u = new Uint8Array(ab), s = "";
      for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return btoa(s);
    });
  }
  function origVolCodes() {
    var el = $("wufuVolGz");
    if (el && typeof window.__gunzipText === "function") {
      try {
        var b64 = (el.textContent || "").replace(/\s+/g, "");
        if (b64) {
          var bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
          var o = JSON.parse(window.__gunzipText(bin));
          if (o && o.series && Object.keys(o.series).length) return Object.keys(o.series);
        }
      } catch (e) { }
    }
    // 部署版内联块为空：退而用运行时 D.series 中带 volume 数组的代码
    var d = gD();
    if (!d || !d.series) return [];
    return Object.keys(d.series).filter(function (c) { return Array.isArray(d.series[c].volume); });
  }
  function replaceBlock(html, id, b64) {
    var re = new RegExp('(<script[^>]*id="' + id + '"[^>]*>)[\\s\\S]*?(<\\/script>)');
    return html.replace(re, function (m, a, b) { return a + "\n" + b64 + "\n" + b; });
  }
  async function exportHtml() {
    var d = gD(), r = gR();
    if (!d || !d.calendar) { note("行情数据尚未加载，无法导出。", "err"); return; }
    var p = readPatch();
    var nf = p && p.ohlcFix ? Object.keys(p.ohlcFix).length : 0;
    var hasPool = p && ((p.custom && p.custom.length) || (p.hidden && p.hidden.length) || (p.scale && p.scale.bars) || (p.groupCfg && p.groupCfg.groups));
    var hasNav2 = p && p.navFix && Object.keys(p.navFix).length;
    if (!p || (!p.days || !p.days.length) && !nf && !hasNav2 && !hasHealthFix(p) && !(p.corrections && p.corrections.length) && !hasPool) {
      note("本机暂无增量或修复，无需导出新文件。", "warn"); return;
    }
    await ensureVolMerged(true);
    note("正在打包完整 HTML（约 14MB，请稍候）…", "");
    busy(true);
    try {
      var vc = origVolCodes() || [];
      var vol = { series: {} };
      vc.forEach(function (c) {
        var s = d.series[c]; if (!s) return;
        var e = {}; ["volume", "amount", "turnover"].forEach(function (f) { if (Array.isArray(s[f])) e[f] = s[f].slice(); });
        if (Object.keys(e).length) vol.series[c] = e;
      });
      var dOut = JSON.parse(JSON.stringify(d));
      // ensureData 运行时派生、加载时会重算的字段，不必烘进文件
      ["px_raw", "dividends", "splits"].forEach(function (k) { delete dOut[k]; });
      // 运行时 ensureData 把 VOL 块的量额字段并进了 D.series；导出时剔除，避免主块与 VOL 块重复存一份
      vc.forEach(function (c) {
        if (dOut.series[c]) ["volume", "amount", "turnover"].forEach(function (f) { delete dOut.series[c][f]; });
      });
      var rOut = r ? JSON.parse(JSON.stringify(r)) : { calendar: d.calendar.slice(), pool: [], series: {}, index: {} };
      var b = await Promise.all([gzB64(JSON.stringify(dOut)), gzB64(JSON.stringify(rOut)), gzB64(JSON.stringify(vol))]);
      var clone = document.documentElement.cloneNode(true);
      // 双保险：Key 是运行时 property，cloneNode 本就不会带；仍显式清空，杜绝任何导出泄漏
      Array.prototype.forEach.call(clone.querySelectorAll("input[data-secret]"), function (e) {
        e.removeAttribute("value"); try { e.value = ""; } catch (x) { }
      });
      Array.prototype.forEach.call(clone.querySelectorAll("canvas"), function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
      Array.prototype.forEach.call(clone.querySelectorAll('[id*="Chart"],[id*="chart"]'), function (e) { e.innerHTML = ""; });
      ["hlCards", "hlKpis", "hlTodo", "hlVerdict", "hlExtBody", "hlRegBody", "icRankBody", "icPool", "icFactors", "poolBox", "pmList", "pmMine", "pmPreviewBox", "pmNavList", "pmNavSum"].forEach(function (id) {
        var e2 = clone.querySelector("#" + id); if (e2) e2.innerHTML = "";
      });
      ["wufuUpdReport", "wufuUpdMsg", "wufuFyFactorReport", "pmMsg", "pmHint", "pmNavMsg"].forEach(function (id) {
        var e2 = clone.querySelector("#" + id); if (e2) { e2.style.display = "none"; e2.textContent = ""; }
      });
      var html = "<!DOCTYPE html>\n" + clone.outerHTML;
      html = replaceBlock(html, "wufuDataGz", b[0]);
      html = replaceBlock(html, "wufuIdxGz", b[1]);
      html = replaceBlock(html, "wufuVolGz", b[2]);
      ["WUFU_POOL", "WUFU_SINCE", "WUFU_FIRSTDATE", "WUFU_LAST"].forEach(function (k) {
        var v = window[k]; if (!v) return;
        var re = new RegExp("var " + k + " = \\[[^\\n]*\\];|var " + k + " = \\{[^\\n]*\\};");
        html = html.replace(re, "var " + k + " = " + JSON.stringify(v) + ";");
      });
      dl("ETF回测系统_全功能版_" + todayBJ().replace(/-/g, "") + ".html", html, "text/html;charset=utf-8");
      note("已导出完整 HTML（数据末日 " + d.calendar[d.calendar.length - 1] + "）。用新文件替换旧文件即可，不再依赖本机存储。", "");
    } catch (e) {
      note("导出失败：" + (e.message || e) + "。可改用「导出更新包」+ 导入。", "err");
    } finally { busy(false); }
  }

  /* ================= 标的管理：增减标的 =================
     搜索（本地池 / 扶摇 meta / 腾讯代码直查）→ 预览行情 → 指定类别 → 写入 patch。
     patch.custom: [{code,name,group,bars,rawBars,src,metaOnly}]
       bars    = [[日期,开,收,高,低,量(万股),额(万元)], ...]  （前复权/价格序列）
       rawBars = [[日期,开,收,高,低], ...]                    （未复权）
     patch.hidden: [code]
     回放严格幂等：每次先剔除这两类代码，再按 patch 重建，内嵌基线不受影响。 */
  /* 内嵌基线的分组名称/顺序快照：恢复默认时不依赖已被运行时改写的 window.WUFU_POOL */
  var GRP_BASE_POOL = null;
  try {
    GRP_BASE_POOL = (window.WUFU_POOL || []).map(function (x) {
      return { code: x.code, name: x.name, group: x.group };
    });
  } catch (e) { GRP_BASE_POOL = null; }
  function grpBaseline() {
    var list = (GRP_BASE_POOL || []).map(function (x) { return { code: x.code, name: x.name, group: x.group }; });
    try {
      grpPool().forEach(function (p) {
        if (!list.some(function (x) { return x.code === p.code; }))
          list.push({ code: p.code, name: p.name, group: "A股指数" });
      });
    } catch (e) { }
    return grpBaseCfg(list);
  }
  var PM_GROUPS = null;   // 运行时由 pmFillGroups() 依分组管理配置生成
  var PM_CACHE = {}, PM_LAST = [];

  function pmMsg(t, bad) {
    var e = $("pmMsg");
    if (e) { e.textContent = t || ""; e.style.color = bad ? WufuTheme.sub("§WFT0010§") : WufuTheme.sub("§WFT0002§"); }
  }
  function pmHint(t) { var e = $("pmHint"); if (e) e.textContent = t || ""; }
  function pmHintUpdate() { pmHint(FY_KEY ? "扶摇已启用 · 可按中文名反查代码" : "名称在线搜索需填扶摇 Key；纯 6 位代码可直接查腾讯"); }

  function pmLocalAll() {
    var out = [], seen = {};
    function add(p, src) {
      if (!p || !p.code || seen[p.code]) return;
      seen[p.code] = 1;
      out.push({ code: p.code, name: p.name || p.code, group: p.group || "", src: src });
    }
    (window.WUFU_POOL || []).forEach(function (p) { add(p, "池内"); });
    var d = gD(), r = gR();
    if (d && d.pool) d.pool.forEach(function (p) { add(p, "池内"); });
    if (r && r.pool) r.pool.forEach(function (p) { add(p, "指数池"); });
    if (d && d.indexNames) d.indexNames.forEach(function (p) { add(p, "指数池"); });
    return out;
  }

  /* 扶摇请求独立封装：不共用 fyGet 的失败计数，避免标的管理失败误伤一键更新 */
  async function pmFyFetch(url) {
    var r = await fetch(url, {
      method: "GET", mode: "cors", cache: "no-store",
      headers: { "Accept": "application/json", "X-api-key": FY_KEY }
    });
    var t = await r.text(), j = null;
    try { j = JSON.parse(t); } catch (e) { }
    if (!r.ok || !j || String(j.code) !== "0")
      throw new Error("扶摇 " + (j ? "code=" + j.code + " " + (j.message || "") : "HTTP " + r.status));
    var a = j.data;
    if (!Array.isArray(a)) a = (a && (a.item || a.items || a.list || a.records)) || [];
    return a;
  }
  async function pmFyMeta(q) {
    var a = await pmFyFetch(FY_BASE + "/api/meta/tickers/search?q=" + encodeURIComponent(q) + "&limit=12");
    return a.map(function (o) {
      return { code: (o.thscode || o.ths_code || o.code || ""), name: (o.name || o.sec_name || o.thscode || "") };
    }).filter(function (x) { return !!x.code; });
  }
  async function pmQtNames(keys) {
    var txt = await fetchGBK(QT + keys.join(","), 10000), o = {};
    txt.split("\n").forEach(function (line) {
      var m = /v_([^=]+)="([^"]*)"/.exec(line);
      if (!m) return;
      var f = m[2].split("~");
      if (f.length > 2 && f[1]) o[m[1]] = f[1];
    });
    return o;
  }
  function pmMs(dt) { return Date.parse(dt + "T00:00:00+08:00"); }

  /* 拉行情：优先腾讯 newfqkline（不复权 day + 前复权 qfqday，多段覆盖全历史）；
     腾讯不支持的代码（如 .TI 同花顺特色指数）且有 Key 时改走扶摇官方源。 */
  async function pmFetch(code, full) {
    var tc = txCode(code);
    if (tc) {
      var ends = full ? ["2012-12-31", "2018-12-31", "2022-12-31", todayBJ()] : [todayBJ()];
      var n = full ? 2000 : 60, raw = {}, fq = {}, okN = 0;
      for (var k = 0; k < ends.length; k++) {
        var base = TX + encodeURIComponent(tc) + ",day,2000-01-01," + ends[k] + "," + n;
        var pair = await Promise.all([
          fetchJson(base + ",", 15000).catch(function () { return null; }),
          fetchJson(base + ",qfq", 15000).catch(function () { return null; })
        ]);
        var d1 = pair[0] && pair[0].data && pair[0].data[tc];
        var d2 = pair[1] && pair[1].data && pair[1].data[tc];
        if (d1) {
          var rows = d1.day || d1.qfqday || d1.hfqday || [];
          var m1 = parseTx(rows);
          Object.keys(m1).forEach(function (dt) { raw[dt] = m1[dt]; });
          if (rows.length) okN++;
        }
        if (d2) {
          var rows2 = d2.qfqday || d2.day || [];
          var m2 = parseTx(rows2);
          Object.keys(m2).forEach(function (dt) { fq[dt] = m2[dt]; });
        }
      }
      if (!okN) throw new Error("腾讯日K未返回数据（代码可能不存在或已退市）");
      var bars = {};
      Object.keys(raw).forEach(function (dt) { bars[dt] = fq[dt] || raw[dt]; });
      return { bars: bars, raw: raw, src: "腾讯 newfqkline" };
    }
    if (FY_KEY) {
      var path = (/\.(TI|OF)$/.test(code) || /^(000|399)\d{3}\./.test(code)) ? FY_IDX : FY_FUND;
      var segs = full
        ? [["2004-01-02", "2013-12-31"], ["2014-01-01", "2023-12-31"], ["2024-01-01", todayBJ()]]
        : [[new Date(Date.now() - 45 * 86400000 + 8 * 3600000).toISOString().slice(0, 10), todayBJ()]];
      var all = {}, hit = 0;
      for (var si = 0; si < segs.length; si++) {
        var u = path + "?thscode=" + encodeURIComponent(code) + "&interval=1d&start=" +
          pmMs(segs[si][0]) + "&end=" + pmMs(segs[si][1]);
        try {
          var arr = await pmFyFetch(u), b = fyBars(arr);
          Object.keys(b).forEach(function (dt) { all[dt] = b[dt]; });
          if (Object.keys(b).length) hit++;
        } catch (e) { /* 单段失败继续 */ }
      }
      if (!hit) throw new Error("扶摇未返回该代码的行情");
      return { bars: all, raw: all, src: "扶摇官方源" };
    }
    throw new Error("该代码无可用行情源（可填扶摇 Key 后再试）");
  }
  /* 单位净值 CSV：每行「日期,单位净值」。[] = 未填，null = 格式错误 */
  function pmParseNav(t) {
    if (!t) return [];
    var out = [], lines = String(t).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i].trim();
      if (!L || /^[#/]/.test(L) || /^日期/.test(L)) continue;
      var p = L.split(/[,，\t;；\s]+/);
      if (p.length < 2) return null;
      var d = p[0].replace(/\//g, "-"), nv = parseFloat(p[1]);
      var q = d.split("-");
      if (q.length !== 3 || !/^\d{4}$/.test(q[0]) || !/^\d{1,2}$/.test(q[1]) || !/^\d{1,2}$/.test(q[2])) return null;
      d = q[0] + "-" + ("0" + q[1]).slice(-2) + "-" + ("0" + q[2]).slice(-2);
      if (!(nv > 0)) return null;
      out.push([d, nv]);
    }
    return out.length ? out : null;
  }
  function pmRows(m, withVA) {
    return Object.keys(m).sort().map(function (dt) {
      var b = m[dt];
      var row = [dt, rnd(b.o, 6), rnd(b.c, 6), rnd(b.h, 6), rnd(b.l, 6)];
      if (withVA) row.push(b.v > 0 ? rnd(b.v, 4) : null, b.a > 0 ? rnd(b.a, 4) : null,
        (b.to !== null && b.to !== undefined && b.to > 0) ? rnd(b.to, 4) : null);
      return row;
    });
  }
  function pmDescribe(res) {
    var ks = Object.keys(res.bars).sort();
    if (!ks.length) return "无有效行情";
    var last = res.bars[ks[ks.length - 1]];
    return "数据源 " + res.src + " · " + ks.length + " 个交易日 · " + ks[0] + " → " + ks[ks.length - 1] +
      " · 末收 " + last.c + " · 成交额" + (last.a > 0 ? "有" : "无") +
      " · 换手率" + (last.to > 0 ? "有（源真值）" : "无");
  }

  /* ---------------- 回放：把 custom / hidden 应用到运行时 ---------------- */
  function applyPoolPatch(p) {
    var cust = (p && p.custom) || [], hid = (p && p.hidden) || [];
    if (!cust.length && !hid.length) return;
    var d = gD(), r = gR();
    if (!d || !d.calendar || !d.series) return;
    var hidSet = {}, custMap = {};
    hid.forEach(function (c) { hidSet[c] = 1; });
    cust.forEach(function (x) { custMap[x.code] = x; });
    function sync(arr, mk) {
      if (!arr) return;
      var keep = arr.filter(function (x) { var c = x && x.code; return !hidSet[c] && !custMap[c]; });
      arr.length = 0;
      keep.forEach(function (x) { arr.push(x); });
      cust.forEach(function (x) { arr.push(mk(x)); });
    }
    var mkPool = function (x) { return { code: x.code, name: x.name, group: x.group }; };
    var dpool = d.pool || (d.pool = []);
    sync(dpool, mkPool);
    if (window.WUFU_POOL && window.WUFU_POOL !== dpool) sync(window.WUFU_POOL, mkPool);
    if (r && r.pool) sync(r.pool, mkPool);
    if (d.indexNames) sync(d.indexNames, function (x) { return { code: x.code, name: x.name }; });

    var L = d.calendar.length, cidx = {};
    d.calendar.forEach(function (x, i) { cidx[x] = i; });
    var FLDS = ["open", "close", "high", "low", "raw_open", "raw_close",
      "volume", "amount", "turnover", "nav", "premium"];
    cust.forEach(function (x) {
      if (x.metaOnly) return;                       // 仅改元信息，序列保持内嵌原值
      var sv = {};
      FLDS.forEach(function (f) { var a = new Array(L); for (var i = 0; i < L; i++) a[i] = -1; sv[f] = a; });
      (x.bars || []).forEach(function (row) {
        var i = cidx[row[0]]; if (i === undefined) return;
        var o = +row[1], c = +row[2], h = +row[3], l = +row[4];
        if (!(c > 0)) return;
        sv.open[i] = o; sv.close[i] = c; sv.high[i] = h > 0 ? h : c; sv.low[i] = l > 0 ? l : c;
        if (row[5] > 0) sv.volume[i] = row[5];
        if (row[6] > 0) sv.amount[i] = row[6];
        if (row[7] > 0) sv.turnover[i] = row[7];      // 腾讯 day[8] 换手率真值
      });
      (x.navCsv || []).forEach(function (row) {       // 单位净值 CSV → nav + premium
        var i2 = cidx[row[0]]; if (i2 === undefined) return;
        var nv = +row[1]; if (!(nv > 0)) return;
        sv.nav[i2] = nv;
        var rcv = sv.raw_close[i2] > 0 ? sv.raw_close[i2] : sv.close[i2];
        if (rcv > 0) sv.premium[i2] = Math.round((rcv - nv) / nv * 1e8) / 1e8;
      });
      (x.rawBars || []).forEach(function (row) {
        var i = cidx[row[0]]; if (i === undefined) return;
        if (+row[2] > 0) { sv.raw_close[i] = +row[2]; sv.raw_open[i] = +row[1]; }
      });
      for (var i = 0; i < L; i++)
        if (sv.close[i] > 0 && !(sv.raw_close[i] > 0)) { sv.raw_close[i] = sv.close[i]; sv.raw_open[i] = sv.open[i]; }
      d.series[x.code] = sv;
      if (d.px_raw) d.px_raw[x.code] = sv.raw_close;
      if (d.index) d.index[x.code] = sv.close.slice();
      if (r) {
        if (r.series) r.series[x.code] = sv.close.slice();
        if (r.index) r.index[x.code] = sv.close.slice();
      }
      var first = "", last = "";
      (x.bars || []).forEach(function (row) {
        if (!first || row[0] < first) first = row[0];
        if (!last || row[0] > last) last = row[0];
      });
      try { if (first && window.WUFU_SINCE) window.WUFU_SINCE[x.code] = first; } catch (e) { }
      try { if (first && window.WUFU_FIRSTDATE) window.WUFU_FIRSTDATE[x.code] = first; } catch (e) { }
      try { if (last && window.WUFU_LAST) window.WUFU_LAST[x.code] = last; } catch (e) { }
    });
    window.__pmCustomOK = cust.length;
  }


  /* ================= 分组管理 =================
     patch.groupCfg = { groups:[组名...], names:{code:组名}, seq:[code...] }
     完整快照、幂等回放。分组顺序与组内标的顺序都由 seq 决定：
     运行时各 pool 数组按 seq 重排并按 names 改组名，页面自然跟着变。 */
  var GRP_EXPAND = "", GRP_BOUND = false;   // 展开态只存内存：沙箱/内置浏览器常禁用 sessionStorage
  function grpPool() {
    var d = gD(), out = [], seen = {};
    function add(p) {
      if (!p || !p.code || seen[p.code]) return;
      seen[p.code] = 1;
      out.push({ code: p.code, name: p.name || p.code, group: p.group || "A股指数" });
    }
    var base = (d && d.pool && d.pool.length) ? d.pool : (window.WUFU_POOL || []);
    base.forEach(add);
    (window.WUFU_POOL || []).forEach(add);
    if (d && d.indexNames) d.indexNames.forEach(function (inm) {
      if (seen[inm.code]) return;
      var pg = (window.WUFU_POOL || []).filter(function (q) { return q.code === inm.code; })[0];
      add({ code: inm.code, name: inm.name, group: pg ? pg.group : "A股指数" });
    });
    return out;
  }
  function grpBaseCfg(list) {
    var groups = [], names = {}, seq = [];
    list.forEach(function (p) {
      if (groups.indexOf(p.group) < 0) groups.push(p.group);
      names[p.code] = p.group; seq.push(p.code);
    });
    return { groups: groups, names: names, seq: seq };
  }
  function grpNormalize(c) {
    var out = [], used = {}, seq = c.seq.slice();
    c.groups.forEach(function (g) {
      seq.forEach(function (x) {
        if (!used[x] && c.names[x] === g) { used[x] = 1; out.push(x); }
      });
    });
    seq.forEach(function (x) {
      if (used[x]) return;
      used[x] = 1;
      var g = c.names[x] || "未分组";
      if (c.groups.indexOf(g) < 0) c.groups.push(g);
      out.push(x);
    });
    c.seq = out;
    return c;
  }
  function grpCfg(list) {
    var p = readPatch(), c = p && p.groupCfg && p.groupCfg.groups ? p.groupCfg : null;
    var base = grpBaseCfg(list || grpPool());
    if (!c) return base;
    var out = { groups: c.groups.slice(), names: {}, seq: [] };
    Object.keys(c.names || {}).forEach(function (k) { out.names[k] = c.names[k]; });
    base.seq.forEach(function (code) { if (out.names[code] === undefined) out.names[code] = base.names[code]; });
    (c.seq || []).forEach(function (code) { if (out.seq.indexOf(code) < 0) out.seq.push(code); });
    base.seq.forEach(function (code) { if (out.seq.indexOf(code) < 0) out.seq.push(code); });
    return grpNormalize(out);
  }
  function applyGroupCfg(p) {
    var g = p && p.groupCfg;
    if (!g || !g.groups || !g.seq) return;
    var names = g.names || {}, rank = {};
    g.seq.forEach(function (c, i) { rank[c] = i; });
    function key(x) { var v = rank[x && x.code]; return v === undefined ? 1e6 : v; }
    function fix(arr) {
      if (!arr || !arr.length) return;
      arr.forEach(function (x) { if (x && x.code && names[x.code] !== undefined) x.group = names[x.code]; });
      arr.sort(function (a, b) { return key(a) - key(b); });
    }
    var d = gD(), r = gR();
    if (d && d.pool) fix(d.pool);
    if (window.WUFU_POOL && (!d || window.WUFU_POOL !== d.pool)) fix(window.WUFU_POOL);
    if (r && r.pool && (!d || r.pool !== d.pool)) fix(r.pool);
    try { if (typeof RDIDX !== "undefined" && RDIDX && RDIDX.pool) fix(RDIDX.pool); } catch (e) { }
    if (d && d.indexNames) fix(d.indexNames);
  }
  function grpMsg(t) { var e = $("grpMsg"); if (e) e.textContent = t; }
  /* 内嵌对话框：不依赖 prompt/confirm/alert，App 内置浏览器与沙箱 iframe 都能用 */
  function grpAsk(title, text, def, cb) {
    var old = $("grpAskBox"); if (old) old.remove();
    var box = document.createElement("div"); box.id = "grpAskBox";
    box.setAttribute("style", WufuTheme.sub("position:fixed;inset:0;z-index:99999;background:§WFT0132§;display:flex;align-items:center;justify-content:center;padding:16px"));
    var inner = document.createElement("div");
    inner.setAttribute("style", WufuTheme.sub("width:min(360px,92vw);background:§WFT0126§;border:1px solid §WFT0001§;border-radius:10px;padding:14px 15px;box-shadow:0 10px 40px §WFT0036§"));
    var h = WufuTheme.sub('<div style="font-size:13px;color:§WFT0004§;font-weight:bold;margin-bottom:7px">') + esc(title) + '</div>' +
      WufuTheme.sub('<div style="font-size:11.5px;color:§WFT0003§;line-height:1.7;margin-bottom:10px">') + esc(text) + '</div>';
    if (def !== null && def !== undefined) h += '<input id="grpAskInput" type="text" value="' + esc(def) +
      WufuTheme.sub('" style="width:100%;box-sizing:border-box;height:32px;padding:0 9px;background:§WFT0018§;border:1px solid §WFT0001§;border-radius:6px;color:§WFT0005§;font-size:12px;margin-bottom:11px">');
    h += '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" id="grpAskCancel" class="corr-mini">取消</button>' +
      '<button type="button" id="grpAskOk" class="btn" style="padding:6px 14px">确定</button></div>';
    inner.innerHTML = h; box.appendChild(inner); document.body.appendChild(box);
    var inp = $("grpAskInput"); if (inp) { try { inp.focus(); inp.select(); } catch (e) { } }
    function done(ok) {
      var v = (ok && inp) ? inp.value.trim() : null;
      box.remove();
      if (ok) cb(v);
    }
    inner.addEventListener("click", function (e) {
      if (e.target && e.target.id === "grpAskCancel") done(false);
      else if (e.target && e.target.id === "grpAskOk") done(true);
    });
    box.addEventListener("click", function (e) { if (e.target === box) done(false); });
    inner.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
  }
  /* 原地生效：写 patch → 回放分组 → 刷新各视图 → 重绘，绝不 location.reload() */
  function grpRefreshViews() {
    try { pmFillGroups(); } catch (e) { }
    try { window.WufuUI && window.WufuUI.refreshGroups && window.WufuUI.refreshGroups(); } catch (e) { }
    try { window.CorrView && window.CorrView.refresh && window.CorrView.refresh(); } catch (e) { }
  }
  function grpCommit(cfg, msg) {
    grpNormalize(cfg);
    var p = readPatch() || newPatch();
    p.groupCfg = cfg;
    if (!writePatch(p)) { grpMsg("本机存储写入失败，改动未保存"); return; }
    try { applyGroupCfg(p); } catch (e) { }
    grpRefreshViews();
    grpRender();
    grpMsg(msg);
  }
  function grpRender() {
    var box = $("grpBody"); if (!box) return;
    var list = grpPool(), cfg = grpCfg(list), by = {};
    list.forEach(function (p) { by[p.code] = p; });
    var expand = GRP_EXPAND;
    var inp = WufuTheme.sub('style="height:30px;width:150px;box-sizing:border-box;padding:0 8px;background:§WFT0018§;border:1px solid §WFT0001§;border-radius:6px;color:§WFT0005§;font-size:12px"');
    var sel = WufuTheme.sub('style="height:27px;background:§WFT0018§;border:1px solid §WFT0001§;border-radius:6px;color:§WFT0005§;font-size:11px"');
    var h = [];
    h.push('<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
      '<input id="grpNewName" type="text" placeholder="新分组名" ' + inp + '>' +
      '<button type="button" class="corr-mini" data-grp-act="add">＋ 新建分组</button>' +
      '<button type="button" class="corr-mini" data-grp-act="reset">恢复默认分组</button></div>');
    h.push('<div class="qckLine" id="grpMsg">共 ' + cfg.groups.length + ' 个分组 · ' + cfg.seq.length +
      ' 只标的。改动立即生效，随更新包导出；空分组在移入标的后才出现在选标的页。</div>');
    cfg.groups.forEach(function (g, gi) {
      var codes = cfg.seq.filter(function (c) { return cfg.names[c] === g; });
      h.push(WufuTheme.sub('<div style="margin-top:9px;border:1px solid §WFT0016§;border-radius:6px;padding:8px 10px">') +
        '<div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">' +
        WufuTheme.sub('<b style="color:§WFT0006§;font-size:12px">') + esc(g) + '</b>' +
        WufuTheme.sub('<span style="font-size:10px;color:§WFT0002§">') + codes.length + ' 只</span>' +
        '<button type="button" class="corr-mini" data-grp-act="gup" data-g="' + esc(g) + '">↑</button>' +
        '<button type="button" class="corr-mini" data-grp-act="gdown" data-g="' + esc(g) + '">↓</button>' +
        '<button type="button" class="corr-mini" data-grp-act="rename" data-g="' + esc(g) + '">改名</button>' +
        '<button type="button" class="corr-mini" data-grp-act="del" data-g="' + esc(g) + '">删除</button>' +
        '<button type="button" class="corr-mini" data-grp-act="' + (expand === g ? "collapse" : "expand") +
          '" data-g="' + esc(g) + '" style="margin-left:auto">' + (expand === g ? "收起标的" : "展开标的") + '</button>' +
        '</div>');
      if (expand === g) {
        if (!codes.length) h.push(WufuTheme.sub('<div style="font-size:11px;color:§WFT0025§;margin:7px 0 2px">该分组暂无标的，可从别的组移入。</div>'));
        codes.forEach(function (c) {
          var it = by[c] || { name: c, code: c };
          var opts = cfg.groups.map(function (x) {
            return '<option value="' + esc(x) + '"' + (x === g ? " selected" : "") + '>' + esc(x) + '</option>';
          }).join("");
          h.push(WufuTheme.sub('<div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:5px 0;border-top:1px solid §WFT0128§;font-size:11.5px">') +
            WufuTheme.sub('<span style="color:§WFT0005§;min-width:135px">') + esc(it.name) + '</span>' +
            WufuTheme.sub('<span style="color:§WFT0002§">') + esc(c) + '</span>' +
            '<button type="button" class="corr-mini" data-grp-act="iup" data-c="' + esc(c) + '">↑</button>' +
            '<button type="button" class="corr-mini" data-grp-act="idown" data-c="' + esc(c) + '">↓</button>' +
            '<select data-grp-move="' + esc(c) + '" ' + sel + '>' + opts + '</select></div>');
        });
      }
      h.push('</div>');
    });
    box.innerHTML = h.join("");
  }
  function grpAct(act, g, c) {
    try {
      var cfg = grpCfg(grpPool());
      if (act === "expand" || act === "collapse") {
        GRP_EXPAND = (act === "expand" ? g : ""); grpRender(); return;
      }
      if (act === "reset") {
        grpAsk("恢复默认分组", "清除全部自定义分组、改名与顺序调整。", null, function () {
          var base = grpBaseline();
          var pp = readPatch() || newPatch(); pp.groupCfg = null;
          if (!writePatch(pp)) { grpMsg("本机存储写入失败，改动未保存"); return; }
          GRP_EXPAND = "";
          try { applyGroupCfg({ groupCfg: base }); } catch (e) { }
          grpRefreshViews(); grpRender(); grpMsg("已恢复默认分组与顺序");
        });
        return;
      }
      if (act === "add") {
        var v = (($("grpNewName") && $("grpNewName").value) || "").trim();
        if (!v) { grpMsg("请输入分组名"); return; }
        if (cfg.groups.indexOf(v) >= 0) { grpMsg("分组名已存在"); return; }
        cfg.groups.push(v); GRP_EXPAND = v;
        grpCommit(cfg, "已新建分组「" + v + "」"); return;
      }
      if (act === "rename") {
        grpAsk("改分组名", "把分组「" + g + "」改成：", g, function (nv) {
          if (!nv || nv === g) return;
          var c2 = grpCfg(grpPool());
          if (c2.groups.indexOf(nv) >= 0) { grpMsg("已有同名分组"); return; }
          function doRename() {
            var k = c2.groups.indexOf(g); if (k < 0) return;
            c2.groups[k] = nv;
            Object.keys(c2.names).forEach(function (x) { if (c2.names[x] === g) c2.names[x] = nv; });
            GRP_EXPAND = nv;
            grpCommit(c2, "已改名为「" + nv + "」");
          }
          if (["A股指数", "港股中概指数", "海外指数"].indexOf(g) >= 0)
            grpAsk("确认改名", "「" + g + "」是系统标记「不可交易·研究用」的分组，改名后该标记会失效。", null, doRename);
          else doRename();
        });
        return;
      }
      if (act === "del") {
        var codes = cfg.seq.filter(function (x) { return cfg.names[x] === g; });
        grpAsk("删除分组", "「" + g + "」中的 " + codes.length + " 只标的将移到「未分组」。", null, function () {
          var c2 = grpCfg(grpPool());
          var cs = c2.seq.filter(function (x) { return c2.names[x] === g; });
          if (cs.length) {
            if (c2.groups.indexOf("未分组") < 0) c2.groups.push("未分组");
            cs.forEach(function (x) { c2.names[x] = "未分组"; });
          }
          c2.groups = c2.groups.filter(function (x) { return x !== g; });
          GRP_EXPAND = "";
          grpCommit(c2, "已删除分组「" + g + "」");
        });
        return;
      }
      if (act === "gup" || act === "gdown") {
        var i = cfg.groups.indexOf(g), j = i + (act === "gup" ? -1 : 1);
        if (i < 0 || j < 0 || j >= cfg.groups.length) { grpMsg("已经到头了"); return; }
        var t = cfg.groups[i]; cfg.groups[i] = cfg.groups[j]; cfg.groups[j] = t;
        grpCommit(cfg, "分组顺序已调整"); return;
      }
      if (act === "iup" || act === "idown") {
        var gg = cfg.names[c], cs2 = cfg.seq.filter(function (x) { return cfg.names[x] === gg; });
        var k2 = cs2.indexOf(c), other = cs2[k2 + (act === "iup" ? -1 : 1)];
        if (other === undefined) { grpMsg("已经到头了"); return; }
        var ia = cfg.seq.indexOf(c), ib = cfg.seq.indexOf(other);
        cfg.seq[ia] = other; cfg.seq[ib] = c;
        grpCommit(cfg, "组内顺序已调整"); return;
      }
      if (act === "move") {
        if (!g || !c) return;
        cfg.names[c] = g;
        grpCommit(cfg, "「" + c + "」已移到「" + g + "」"); return;
      }
    } catch (e) {
      grpMsg("操作失败：" + (e && e.message ? e.message : String(e)));
    }
  }
  function grpBind() {
    if (GRP_BOUND) return;
    GRP_BOUND = true;
    var wrap = $("grpWrap");
    if (wrap) wrap.addEventListener("toggle", function () { if (wrap.open) grpRender(); });
    document.addEventListener("click", function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var b = t.closest("#grpBody [data-grp-act]");
      if (!b) return;
      e.preventDefault();
      grpAct(b.getAttribute("data-grp-act"), b.getAttribute("data-g"), b.getAttribute("data-c"));
    }, false);
    document.addEventListener("change", function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var s = t.closest("#grpBody [data-grp-move]");
      if (!s) return;
      grpAct("move", s.value, s.getAttribute("data-grp-move"));
    }, false);
    grpRender();
  }
  function pmFillGroups() {
    var sel = $("pmGroup"); if (!sel) return;
    var cfg = grpCfg(grpPool()), cur = sel.value, h = [];
    cfg.groups.forEach(function (g) { h.push('<option value="' + esc(g) + '">' + esc(g) + '</option>'); });
    h.push('<option value="__custom__">＋ 新建分组…</option>');
    sel.innerHTML = h.join("");
    if (cur && cur !== "__custom__" && cfg.groups.indexOf(cur) >= 0) sel.value = cur;
    PM_GROUPS = cfg.groups.slice();
  }
  /* ---------------- 界面 ---------------- */
  async function pmSearchRun() {
    var q = ($("pmQ").value || "").trim();
    if (!q) { pmMsg("请输入名称或代码", true); return; }
    pmMsg("搜索中…");
    var out = [], seen = {}, ql = q.toLowerCase();
    function push(x) { if (!x || !x.code || seen[x.code]) return; seen[x.code] = 1; out.push(x); }
    try { pmLocalAll().forEach(function (p) { if ((p.name + " " + p.code).toLowerCase().indexOf(ql) >= 0) push(p); }); } catch (e) { }
    if (FY_KEY) {
      try { (await pmFyMeta(q)).forEach(function (x) { push({ code: x.code, name: x.name, group: "", src: "扶摇" }); }); }
      catch (e) { }
    }
    var cands = [];
    if (/^\d{6}$/.test(q)) ["sh", "sz", "bj"].forEach(function (m) { cands.push([m + q, q + "." + m.toUpperCase()]); });
    var mc = /^(sh|sz|bj)(\d{6})$/i.exec(q);
    if (mc) cands.push([q.toLowerCase(), mc[2] + "." + mc[1].toUpperCase()]);
    var ms = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(q);
    if (ms) cands.push([ms[2].toLowerCase() + ms[1], q.toUpperCase()]);
    if (cands.length) {
      var names = {};
      try { names = await pmQtNames(cands.map(function (x) { return x[0]; })); } catch (e) { }
      cands.forEach(function (c) {
        if (names[c[0]]) push({ code: c[1], name: names[c[0]], group: "", src: "腾讯" });
      });
    }
    var p = readPatch() || newPatch(), cm = {}, hm = {}, d = gD();
    (p.custom || []).forEach(function (x) { cm[x.code] = 1; });
    (p.hidden || []).forEach(function (x) { hm[x] = 1; });
    out.forEach(function (x) {
      var inBase = (d && d.series && d.series[x.code]) ||
        (window.WUFU_POOL || []).some(function (z) { return z.code === x.code; });
      x.state = hm[x.code] ? "已移出" : (cm[x.code] ? "自定义" : (inBase ? "已在池" : "可加入"));
    });
    PM_LAST = out;
    var box = $("pmList");
    if (!box) return;
    if (!out.length) {
      box.innerHTML = WufuTheme.sub('<div style="font-size:11px;color:§WFT0002§;padding:6px 0">没找到匹配的标的。可换名称、直接输 6 位代码，或填扶摇 Key 后按名称反查。</div>');
      pmMsg("", false); return;
    }
    var h = ['<div style="display:flex;flex-direction:column;gap:5px;max-height:250px;overflow:auto">'];
    out.slice(0, 20).forEach(function (x, i) {
      h.push(WufuTheme.sub('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:§WFT0135§;border:1px solid §WFT0016§;border-radius:6px;font-size:11.5px">') +
        WufuTheme.sub('<span style="color:§WFT0004§;min-width:130px">') + esc(x.name) + '</span>' +
        WufuTheme.sub('<span style="color:§WFT0002§">') + esc(x.code) + '</span>' +
        WufuTheme.sub('<span style="color:§WFT0025§;font-size:10px">') + esc(x.src) + '</span>' +
        '<span style="color:' + (x.state === "可加入" ? WufuTheme.sub("§WFT0006§") : WufuTheme.sub("§WFT0014§")) + ';font-size:10px">' + esc(x.state) + '</span>' +
        '<button type="button" class="corr-mini" data-pm-idx="' + i + '" style="margin-left:auto">选用</button>' +
        (x.state === "已移出"
          ? '<button type="button" class="corr-mini" data-pm-act="restore" data-pm-code="' + esc(x.code) + '">恢复</button>'
          : ((x.state === "已在池" || x.state === "自定义")
            ? '<button type="button" class="corr-mini" data-pm-act="del" data-pm-code="' + esc(x.code) +
              '" data-pm-cust="' + (x.state === "自定义" ? "1" : "0") + '">移出</button>' : '')) + '</div>');
    });
    h.push('</div>');
    box.innerHTML = h.join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-pm-act]"), function (b) {
      b.addEventListener("click", function () {
        var c = b.getAttribute("data-pm-code");
        if (b.getAttribute("data-pm-act") === "restore") pmRestore(c);
        else pmDel(c, b.getAttribute("data-pm-cust") === "1");
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-pm-idx]"), function (b) {
      b.addEventListener("click", function () {
        var x = PM_LAST[+b.getAttribute("data-pm-idx")];
        if (!x) return;
        $("pmCode").value = x.code; $("pmName").value = x.name;
        var gr = $("pmGroup"), has = false;
        Array.prototype.forEach.call(gr.options, function (o) { if (o.value === x.group || o.text === x.group) has = true; });
        if (x.group && has) { gr.value = x.group; $("pmGroupCustomWrap").style.display = "none"; }
        else if (x.group) { gr.value = "__custom__"; $("pmGroupCustomWrap").style.display = "flex"; $("pmGroupCustom").value = x.group; }
        pmPreviewRun();
      });
    });
    pmMsg("找到 " + out.length + " 个候选（池内可直接改类别）");
  }

  async function pmPreviewRun() {
    var code = ($("pmCode").value || "").trim();
    var box = $("pmPreviewBox");
    if (!code) { pmMsg("先填代码，或点候选项「选用」", true); return; }
    pmMsg("正在预览行情…");
    try {
      var res = await pmFetch(code, false);
      PM_CACHE[code] = res;
      if (box) box.innerHTML = WufuTheme.sub('<div style="padding:8px 10px;background:§WFT0040§;border:1px solid §WFT0016§;border-radius:6px">') + esc(pmDescribe(res)) + '</div>';
      pmMsg("预览完成 · 确认类别后点「加入标的池」");
    } catch (e) {
      if (box) box.innerHTML = "";
      pmMsg("预览失败：" + (e.message || e), true);
    }
  }

  function pmGroupVal() {
    var g = $("pmGroup");
    if (!g) return "";
    return g.value === "__custom__" ? (($("pmGroupCustom").value || "").trim()) : g.value;
  }
  async function pmAddRun() {
    var code = ($("pmCode").value || "").trim(), name = ($("pmName").value || "").trim(), group = pmGroupVal();
    if (!code || !name || !group) { pmMsg("代码 / 名称 / 类别都要填", true); return; }
    if (!gD() || !gD().calendar) {
      await new Promise(function (res) {
        if (window.WufuUI && WufuUI.ensureData) WufuUI.ensureData(res); else res();
      });
    }
    var d = gD();
    if (!d || !d.calendar) { pmMsg("行情数据尚未加载，请先点一次「开始体检」再试", true); return; }
    var p = readPatch() || newPatch(), force = $("pmForce") && $("pmForce").checked;
    var navTxt = ($("pmNavCsv") ? $("pmNavCsv").value : "").trim();
    var navRows = pmParseNav(navTxt);
    if (navRows === null) { pmMsg("净值 CSV 格式有误：每行应为「日期,单位净值」", true); return; }
    var isCust = (p.custom || []).some(function (x) { return x.code === code; });
    var inBase = !!d.series[code] || (window.WUFU_POOL || []).some(function (z) { return z.code === code; });
    var entry = { code: code, name: name, group: group, ts: new Date().toLocaleString("zh-CN", { hour12: false }) };
    if (inBase && !isCust && !force && !navRows.length) {
      entry.metaOnly = true; entry.src = "仅改元信息";
    } else {
      if (inBase && !isCust && !force && navRows.length)
        pmMsg("已导入净值，将按「重拉行情覆盖」处理（保留原有价格序列）", "");
      pmMsg("正在拉取全历史行情（约 8 个请求，请稍候）…");
      var res;
      try { res = await pmFetch(code, true); }
      catch (e) { pmMsg("拉取失败：" + (e.message || e), true); return; }
      entry.bars = pmRows(res.bars, true);
      entry.rawBars = pmRows(res.raw, false);
      entry.src = res.src;
      if (navRows.length) entry.navCsv = navRows;
      if (!entry.bars.length) { pmMsg("没有可用行情，未加入", true); return; }
    }
    pushUndo(p);
    p.custom = (p.custom || []).filter(function (x) { return x.code !== code; }).concat([entry]);
    p.hidden = (p.hidden || []).filter(function (x) { return x !== code; });
    if (!writePatch(p)) { pmMsg("本机存储写入失败（自定义标的数据过多，建议先导出完整 HTML 再清空本机更新）", true); return; }
    note("已保存 " + code + (navRows.length ? "（净值 " + navRows.length + " 条）" : "") + "，页面刷新后生效。", "");
    location.reload();
  }

  function pmDel(code, isCust) {
    var p = readPatch() || newPatch();
    pushUndo(p);
    if (isCust) p.custom = (p.custom || []).filter(function (x) { return x.code !== code; });
    else { p.hidden = p.hidden || []; if (p.hidden.indexOf(code) < 0) p.hidden.push(code); }
    if (!writePatch(p)) { note("本机存储写入失败。", "err"); return; }
    location.reload();
  }
  function pmRestore(code) {
    var p = readPatch() || newPatch();
    pushUndo(p);
    p.hidden = (p.hidden || []).filter(function (x) { return x !== code; });
    writePatch(p); location.reload();
  }
  function pmRenderMine() {
    var box = $("pmMine"); if (!box) return;
    var p = readPatch() || newPatch(), cust = p.custom || [], hid = p.hidden || [];
    if (!cust.length && !hid.length) { box.innerHTML = WufuTheme.sub('<div style="color:§WFT0002§">暂无自定义标的，也没有移出的标的。</div>'); return; }
    var h = [];
    if (cust.length) {
      h.push(WufuTheme.sub('<div style="color:§WFT0006§;margin-bottom:6px">自定义 / 已改类别 ') + cust.length + ' 只</div>');
      cust.forEach(function (x) {
        h.push(WufuTheme.sub('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:5px 0;border-bottom:1px solid §WFT0016§">') +
          WufuTheme.sub('<span style="color:§WFT0004§">') + esc(x.name) + WufuTheme.sub('</span><span style="color:§WFT0002§">') + esc(x.code) + '</span>' +
          WufuTheme.sub('<span style="color:§WFT0025§;font-size:10px">') + esc(x.group) + ' · ' + esc(x.src || "") + (x.metaOnly ? " · 仅元信息" : "") + '</span>' +
          '<button type="button" class="corr-mini" data-pm-del="' + esc(x.code) + '" data-cust="1" style="margin-left:auto">移出</button></div>');
      });
    }
    if (hid.length) {
      h.push(WufuTheme.sub('<div style="color:§WFT0014§;margin:9px 0 6px">已从标的池移出 ') + hid.length + ' 只（行情数据保留）</div>');
      hid.forEach(function (c) {
        h.push(WufuTheme.sub('<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid §WFT0016§">') +
          WufuTheme.sub('<span style="color:§WFT0003§">') + esc(c) + '</span>' +
          '<button type="button" class="corr-mini" data-pm-restore="' + esc(c) + '" style="margin-left:auto">恢复</button></div>');
      });
    }
    h.push(WufuTheme.sub('<div style="color:§WFT0025§;font-size:10px;margin-top:8px;line-height:1.6">自定义标的的全历史行情存在本机浏览器；标的多时建议「导出完整 HTML」把数据烘进文件，再「清除本机更新」。</div>'));
    box.innerHTML = h.join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-pm-del]"), function (b) {
      b.addEventListener("click", function () { pmDel(b.getAttribute("data-pm-del"), b.getAttribute("data-cust") === "1"); });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-pm-restore]"), function (b) {
      b.addEventListener("click", function () { pmRestore(b.getAttribute("data-pm-restore")); });
    });
  }
  /* ---------------- 净值 / 溢价率 待补清单 ----------------
     判据：nav 与未复权收盘同比例变动（|Δnav/nav − Δclose/close| < 1e-6）→ 外推；
     patch.navFix 已写入的日期 → 扶摇 unit_nav 真值；nav 全 -1 → 无净值概念。
     扶摇净值端点只覆盖 6 位 A 股基金/股票代码，指数与海外标一律不适用。 */
  var NAV_ROWS = [];
  function navScan() {
    var d = gD(), p = readPatch() || {}, out = [];
    if (!d || !d.calendar || !d.series) return out;
    var cal = d.calendar, cut = cal.length - 500, meta = {};
    pmLocalAll().forEach(function (x) { meta[x.code] = x; });
    Object.keys(d.series).forEach(function (c) {
      var sv = d.series[c], nav = Array.isArray(sv.nav) ? sv.nav : null;
      var rc = Array.isArray(sv.raw_close) ? sv.raw_close : (Array.isArray(sv.close) ? sv.close : null);
      var it = { c: c, name: (meta[c] && meta[c].name) || c, group: (meta[c] && meta[c].group) || "",
        valid: 0, miss: 0, der: 0, der500: 0,
        fy: (p.navFix && p.navFix[c]) ? Object.keys(p.navFix[c]).length : 0,
        supported: /^\d{6}\.(SH|SZ)$/.test(c) };
      if (nav && rc) {
        var pN = null, pC = null;
        for (var i = 0; i < nav.length; i++) {
          var nv = (typeof nav[i] === "number" && isFinite(nav[i])) ? nav[i] : -1;
          var cv = (i < rc.length && typeof rc[i] === "number" && isFinite(rc[i])) ? rc[i] : -1;
          if (nv > 0) {
            it.valid++;
            if (pN > 0 && pC > 0 && cv > 0) {
              var rr = cv / pC;
              if (Math.abs(rr - 1) > 1e-9 && Math.abs(nv / pN - rr) < 1e-6) {
                it.der++; if (i >= cut) it.der500++;
              }
            }
          } else it.miss++;
          pN = nv > 0 ? nv : null; pC = cv > 0 ? cv : null;
        }
      }
      if (!it.valid || !it.supported) it.state = "na";
      else if (it.fy > 0) it.state = "done";
      else if (it.der > 0) it.state = "todo";
      else it.state = "hist";
      it.naWhy = !it.valid ? "无净值序列（指数／海外）" : "扶摇净值端点不覆盖此类代码";
      out.push(it);
    });
    var ord = { todo: 0, done: 1, hist: 2, na: 3 };
    return out.sort(function (a, b) {
      if (ord[a.state] !== ord[b.state]) return ord[a.state] - ord[b.state];
      return b.der500 - a.der500;
    });
  }
  function renderNavList() {
    var box = $("pmNavList"); if (!box) return;
    try { syncNavKeyUI(); } catch (e) { }
    NAV_ROWS = navScan();
    var cnt = { todo: 0, done: 0, hist: 0, na: 0 };
    NAV_ROWS.forEach(function (x) { cnt[x.state]++; });
    var only = $("pmNavOnly") && $("pmNavOnly").checked;
    var show = only ? NAV_ROWS.filter(function (x) { return x.state === "todo" || x.state === "done"; }) : NAV_ROWS;
    var sum = $("pmNavSum");
    if (sum) sum.textContent = "共 " + NAV_ROWS.length + " 只 · 待补 " + cnt.todo + " · 已补 " + cnt.done +
      " · 无需补 " + cnt.hist + " · 不适用 " + cnt.na + " · 当前显示 " + show.length;
    var h = ['<div class="tblwrap"><table class="trades hltbl" style="width:100%;min-width:740px"><thead><tr>' +
      '<th style="width:108px">标的</th><th>名称</th><th style="width:88px">类别</th>' +
      '<th style="width:66px">有效日</th><th style="width:88px">外推(近500)</th>' +
      '<th style="width:88px">扶摇真值日</th><th style="width:100px">状态</th><th style="width:64px">操作</th>' +
      '</tr></thead><tbody>'];
    show.forEach(function (x) {
      var st = { todo: WufuTheme.sub('<span style="color:§WFT0014§">待补</span>'), done: WufuTheme.sub('<span style="color:§WFT0006§">已补</span>'),
        hist: WufuTheme.sub('<span style="color:§WFT0002§">历史真值</span>'), na: WufuTheme.sub('<span style="color:§WFT0025§">不适用</span>') }[x.state];
      var why = x.state === "na" ? WufuTheme.sub('<div style="font-size:10px;color:§WFT0025§">') + esc(x.naWhy) + '</div>' : "";
      var btn = (x.state === "todo" || x.state === "done")
        ? '<button type="button" class="corr-mini" data-nav-fill="' + esc(x.c) + '">' + (x.state === "done" ? "重补" : "补齐") + '</button>' : "—";
      h.push('<tr><td>' + esc(x.c) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.group) + '</td><td>' + x.valid +
        '</td><td>' + x.der500 + '</td><td>' + x.fy + '</td><td>' + st + why + '</td><td>' + btn + '</td></tr>');
    });
    h.push('</tbody></table></div><p class="swipehint">表格较宽，可左右滑动查看 →</p>');
    if (!show.length) h.push('<div style="margin-top:6px">当前筛选下没有标的；取消勾选「只看待补／已补」可查看全部。</div>');
    box.innerHTML = h.join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-nav-fill]"), function (b) {
      b.addEventListener("click", function () { navFill([b.getAttribute("data-nav-fill")]); });
    });
  }
  function navFillAll() {
    var todo = navScan().filter(function (x) { return x.state === "todo"; }).map(function (x) { return x.c; });
    if (!todo.length) { navNote("没有待补标的：净值已全部补齐，或本就不适用。", ""); renderNavList(); return; }
    navFill(todo);
  }
  async function navFill(list) {
    var btn = $("pmNavFillAll");
    // 移动浏览器 / 密码管理器粘贴常不触发 input 事件：点击时重读两个 Key 框
    var k1 = $("pmNavKey"), k2 = $("wufuFyKey");
    var fresh = ((k1 && k1.value) || (k2 && k2.value) || "").trim();
    if (fresh) FY_KEY = fresh;
    try { syncNavKeyUI(); } catch (e) { }
    if (!FY_KEY) {
      navNote("未补齐：还没读到扶摇 API Key。请在「扶摇 API Key」框填入，确认右侧小字变成「已启用 · 仅本次会话」；不确定先点「诊断连接（单只）」。", "err");
      if (k1) k1.focus();
      return;
    }
    var d = gD(); if (!d || !d.calendar || !d.series) { navNote("行情数据尚未加载完成，请先切到「数据体检」页并点一次「开始体检」。", "err"); return; }
    var cal = d.calendar, idx = {}; cal.forEach(function (x, i) { idx[x] = i; });
    var navCut = cal[Math.max(0, cal.length - 500)];
    var p = readPatch() || newPatch();
    p.navFix = p.navFix || {};
    var ok = 0, rows = 0;
    var why = { net: 0, nodata: 0, reject: 0, same: 0, noarr: 0 },
        eg = { net: [], nodata: [], reject: [], same: [], noarr: [] }, firstErr = "", done = 0;
    function mark(k, c) { why[k]++; if (eg[k].length < 6) eg[k].push(c); }
    if (btn) btn.disabled = true;
    var oldTxt = btn ? btn.textContent : "";
    navNote("正在用扶摇补齐 " + list.length + " 只标的的单位净值（错峰 420ms，限频/网络失败自动重试），约需 1 分钟，请勿关闭页面…", "");
    try {
      var tasks = list.map(function (c) { return async function () {
        try {
          var m = await fyNav(c);
          if (!Object.keys(m).length) { mark("nodata", c); return; }
          if (!navAcceptable(d, c, m, cal, navCut)) { mark("reject", c); return; }
          var keep = {}, sv = d.series[c];
          if (!sv || !Array.isArray(sv.nav)) { mark("noarr", c); return; }
          Object.keys(m).forEach(function (dt) {
            if (dt < navCut) return;
            var i = idx[dt]; if (i === undefined) return;
            var cur = sv.nav[i];
            if (!(cur > 0) || Math.abs(cur - m[dt]) > 1e-4) keep[dt] = m[dt];
          });
          if (!Object.keys(keep).length) { mark("same", c); return; }
          p.navFix[c] = Object.assign(p.navFix[c] || {}, keep);
          ok++; rows += Object.keys(keep).length;
        } catch (e) {
          mark("net", c);
          if (!firstErr) firstErr = (e && e.message) ? String(e.message) : String(e);
        } finally {
          done++;
          if (btn && done % 10 === 0) btn.textContent = "补齐中 " + done + "/" + list.length + "…";
        }
      }; });
      await pool(tasks, 3);
      var skipped = why.net + why.nodata + why.reject + why.same + why.noarr;
      if (!ok) {
        var parts = [];
        if (why.net) parts.push("请求失败 " + why.net + " 只 [" + eg.net.join(" ") + "]");
        if (why.nodata) parts.push("扶摇无净值数据 " + why.nodata + " 只 [" + eg.nodata.join(" ") + "]");
        if (why.reject) parts.push("口径偏差 >2% " + why.reject + " 只 [" + eg.reject.join(" ") + "]");
        if (why.same) parts.push("已是真值 " + why.same + " 只 [" + eg.same.join(" ") + "]");
        if (why.noarr) parts.push("无净值序列 " + why.noarr + " 只 [" + eg.noarr.join(" ") + "]");
        var tail = firstErr ? "\n首条错误：" + firstErr : "";
        var hint = "";
        if (why.net) hint = "\n先点「诊断连接（单只）」看 HTTP / code / message：Failed to fetch、Load failed、403 多为当前页面 Origin 不在扶摇跨域白名单（探测页能通、这里不通即属此类），4001 为限频，2003 为 Key 无效。这类情况请用「扶摇净值离线导出」页在能通的环境导出更新包再导入。";
        else if (why.reject) hint = "\n口径守卫把系统外推 nav 与扶摇 unit_nav 中位偏差 >2% 的标的整只拦下；可用离线导出通道直接导入真值（导入后可在「数据纠正」撤销）。";
        else if (why.nodata) hint = "\n该端点可能只覆盖部分基金；离线导出页会逐只显示行数，便于确认覆盖范围。";
        navNote("未补齐任何标的（共 " + skipped + " 只跳过）：" + parts.join(" · ") + tail + hint, "warn");
        return;
      }
      pushUndo(readPatch() || newPatch());
      if (!writePatch(p)) { navNote("本机存储写入失败，请导出更新包保存。", "err"); return; }
      applyNavFix(p);
      try { renderState(); } catch (e) { }
      var parts2 = [];
      if (why.net) parts2.push("请求失败 " + why.net + " 只" + (firstErr ? "（" + firstErr + "）" : ""));
      if (why.nodata) parts2.push("无净值数据 " + why.nodata + " 只");
      if (why.reject) parts2.push("口径偏差 >2% " + why.reject + " 只");
      if (why.same) parts2.push("已是真值 " + why.same + " 只");
      navNote("扶摇净值补齐完成：成功 " + ok + " 只 / " + rows + " 个真值日" +
        (parts2.length ? "；跳过 " + parts2.join(" · ") : "") +
        "。premium 已按未复权收盘反算，价格未改动。", parts2.length ? "warn" : "");
    } catch (e) {
      navNote("净值补齐未完成：" + ((e && e.message) || e), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldTxt || "一键补齐全部待补"; }
      renderNavList();
    }
  }

  /* 单只连接诊断：只发 1 个请求，把 HTTP / 业务码 / 行数 / 口径一次说清。
     用于区分「Key 没读到」「跨域预检被拒」「限频」「端点无数据」「口径被拒」。 */
  async function navDiag() {
    var k1 = $("pmNavKey"), k2 = $("wufuFyKey"), c = "510300.SH";
    var fresh = ((k1 && k1.value) || (k2 && k2.value) || "").trim();
    if (fresh) FY_KEY = fresh;
    try { syncNavKeyUI(); } catch (e) { }
    var L = [];
    L.push("页面 Origin：" + (location.origin === "null" ? "null（本地文件）" : location.origin));
    L.push("已读到的 Key：" + (FY_KEY ? "有（长度 " + FY_KEY.length + "）" : "无 ← 先填 Key 框"));
    if (!FY_KEY) { navNote("【单只诊断】\n" + L.join("\n"), "err"); return; }
    var u = FY_BASE + FY_NAV + "?thscode=" + encodeURIComponent(c) + "&range=fyear&nav_type=unit,adj";
    navNote("【单只诊断】正在请求 " + c + " …", "");
    try {
      var du = window.WUFU_ROUTE ? window.WUFU_ROUTE(u) : u;
      var r = await fetch(du, { method: "GET", mode: "cors", cache: "no-store",
        headers: { "Accept": "application/json", "X-api-key": FY_KEY } });
      var t = await r.text(), j = null;
      try { j = JSON.parse(t); } catch (e) { }
      var dd = j && j.data, a = Array.isArray(dd) ? dd : (dd && (dd.item || dd.items || dd.list || dd.records)) || [];
      L.push("HTTP " + r.status + " · code=" + (j ? j.code : "?") + " · message=" + ((j && j.message) || "—"));
      L.push("返回行数：" + a.length);
      if (a.length) {
        L.push("字段：" + Object.keys(a[0]).join(","));
        var f = msToBJ(a[0].nav_date) || fyDate(a[0]), l = msToBJ(a[a.length - 1].nav_date) || fyDate(a[a.length - 1]);
        L.push("首 " + f + " → 末 " + l + " · 首行 unit_nav=" + a[0].unit_nav);
        var d = gD(), sv = d && d.series && d.series[c], cal = d && d.calendar;
        if (sv && Array.isArray(sv.nav) && cal) {
          var i0 = cal.indexOf(f), i1 = cal.indexOf(l);
          L.push("系统同段 nav：" + (i0 >= 0 ? sv.nav[i0] : "无 " + f) + " → " + (i1 >= 0 ? sv.nav[i1] : "无 " + l));
        }
      } else if (!r.ok || !j) {
        L.push("响应前 160 字符：" + String(t).slice(0, 160));
      }
      if (!r.ok || !j) L.push("判定：网络层失败 —— 当前页面 Origin 多半不在扶摇跨域白名单（探测页能通、此页不通即属此类），或网关 403。");
      else if (String(j.code) !== "0") L.push("判定：" + (String(j.code) === "2003" ? "Key 无效/过期" : String(j.code) === "4001" ? "限频，稍后重试" : "业务码失败，见 message"));
      else if (!a.length) L.push("判定：code=0 但无数据 —— 该标的净值端点不覆盖。");
      else L.push("判定：接口通。若一键补齐仍为 0，多半是口径偏差 >2% 被守卫拦下，看补齐报告里的分类计数。");
      navNote("【单只诊断】\n" + L.join("\n"), (r.ok && j && String(j.code) === "0" && a.length) ? "" : "warn");
    } catch (e) {
      L.push("请求异常：" + String((e && e.message) || e));
      L.push("判定：Failed to fetch / Load failed —— 浏览器跨域预检被拒，或网络不通。请在能通的环境用「扶摇净值离线导出」页导出更新包再导入。");
      navNote("【单只诊断】\n" + L.join("\n"), "err");
    }
  }

  async function pmNavFyRun() {
    var st = $("pmNavFyState"), code = ($("pmCode").value || "").trim();
    if (!code) { if (st) st.textContent = "请先填代码"; return; }
    if (!FY_KEY) { if (st) st.textContent = "请先在本页填入扶摇 API Key"; navNote("未补齐：还没填扶摇 API Key，请在本页 Key 框填入后重试。", "err"); return; }
    var d0 = gD(), cal = d0 && d0.calendar ? d0.calendar : [];
    if (!cal.length) { if (st) st.textContent = "行情数据尚未加载，请先点一次「开始体检」"; return; }
    if (st) st.textContent = "正在拉取 " + code + " 的单位净值…";
    try {
      var m = await fyNav(code);
      if (!Object.keys(m).length) { if (st) st.textContent = "该代码无单位净值数据"; navNote(code + "：扶摇未返回单位净值数据。", "warn"); return; }
      if (!navAcceptable(d0, code, m, cal, cal[Math.max(0, cal.length - 500)])) { if (st) st.textContent = "与现有净值口径偏差 >2%，未写入"; return; }
      var p = readPatch() || newPatch();
      pushUndo(p);
      p.navFix = p.navFix || {};
      p.navFix[code] = Object.assign(p.navFix[code] || {}, m);
      if (!writePatch(p)) { if (st) st.textContent = "本机存储写入失败"; return; }
      applyNavFix(p);
      if (st) st.textContent = "已写入 " + Object.keys(m).length + " 个净值真值日，已即时生效";
      navNote("已从扶摇补齐 " + code + " 的单位净值（" + Object.keys(m).length + " 日），清单已刷新。", "");
      renderNavList();
    } catch (e) {
      var msg = (e && e.message) ? String(e.message) : String(e);
      if (st) st.textContent = "拉取失败：" + msg;
      navNote(code + " 净值拉取失败：" + msg, "err");
    }
  }

  function pmBind() {
    var g = $("pmGo"); if (g) g.addEventListener("click", function () { pmSearchRun().catch(function (e) { pmMsg("搜索失败：" + (e.message || e), true); }); });
    var q = $("pmQ"); if (q) q.addEventListener("keydown", function (e) { if (e.key === "Enter") pmSearchRun(); });
    var gr = $("pmGroup");
    if (gr) gr.addEventListener("change", function () {
      var w = $("pmGroupCustomWrap"); if (w) w.style.display = this.value === "__custom__" ? "flex" : "none";
    });
    var pv = $("pmPreview"); if (pv) pv.addEventListener("click", pmPreviewRun);
    var ad = $("pmAdd"); if (ad) ad.addEventListener("click", function () { pmAddRun().catch(function (e) { pmMsg("加入失败：" + (e.message || e), true); }); });
    var nf = $("pmNavFy"); if (nf) nf.addEventListener("click", function () { pmNavFyRun().catch(function (e) { pmMsg("净值拉取失败：" + (e.message || e), true); }); });
    var ns = $("pmNavScan"); if (ns) ns.addEventListener("click", renderNavList);
    var na = $("pmNavFillAll"); if (na) na.addEventListener("click", navFillAll);
    var nd = $("pmNavDiag"); if (nd) nd.addEventListener("click", navDiag);
    var no = $("pmNavOnly"); if (no) no.addEventListener("change", renderNavList);
    var nk = $("pmNavKey");
    if (nk) nk.addEventListener("input", function () {
      FY_KEY = nk.value.trim(); FY_FAIL = 0; FY_DEAD = false;
      var top = $("wufuFyKey"); if (top && top.value !== nk.value) top.value = nk.value;
      syncNavKeyUI(); pmHintUpdate();
    });
    var nw = $("pmNavWrap"); if (nw) nw.addEventListener("toggle", function () {
      if (nw.open && !NAV_ROWS.length) renderNavList();
      syncNavKeyUI();
    });
    pmFillGroups(); grpBind(); pmRenderMine(); pmHintUpdate(); syncNavKeyUI();
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var b = $("wufuUpdRun"); if (b) b.addEventListener("click", runUpdate);
    var h = $("wufuUpdHtml"); if (h) h.addEventListener("click", exportHtml);
    var p = $("wufuUpdPkg"); if (p) p.addEventListener("click", exportPkg);
    var c = $("wufuUpdClear"); if (c) c.addEventListener("click", clearPatch);
    var u = $("wufuUpdUndo"); if (u) u.addEventListener("click", undoLast);
    var sc = $("wufuCorrScan"); if (sc) sc.addEventListener("click", function () {
      var li = scanIssues(); renderScan(li);
      var cw = $("wufuCorrWrap"); if (cw) cw.open = true;
      note("体检扫描完成：" + li.length + " 条疑似异常。", ""); });
    var ff = $("wufuFyFactorRun");
    if (ff) ff.addEventListener("click", function () {
      note("正在用扶摇官方分红事件对拍复权因子…", "");
      checkFactors(null).then(function (res) { note("扶摇复权因子校验完成：" + res.summary, ""); })
        .catch(function (e) { note("扶摇复权校验失败：" + ((e && e.message) || e), "err"); });
    });
    var cs = $("wufuCorrSave"); if (cs) cs.addEventListener("click", corrSave);
    var cr = $("wufuCorrRefetch"); if (cr) cr.addEventListener("click", corrRefetch);
    var cu = $("wufuCorrUndo"); if (cu) cu.addEventListener("click", corrClear);
    var ou = $("wufuOhlcUndo"); if (ou) ou.addEventListener("click", ohlcFixUndo);
    var fa = $("wufuFixClearAll"); if (fa) fa.addEventListener("click", clearAllFix);
    var fe = $("wufuFixClearExempt"); if (fe) fe.addEventListener("click", clearExemptRun);
    var f = $("wufuUpdFile"); if (f) f.addEventListener("change", function () { if (f.files && f.files[0]) importPkg(f.files[0]); f.value = ""; });
    var fk = $("wufuFyKey");
    if (fk) fk.addEventListener("input", function () {
      FY_KEY = fk.value.trim();
      FY_FAIL = 0; FY_DEAD = false;
      var st = $("wufuFyState");
      if (st) {
        st.textContent = FY_KEY ? "已启用（仅本次会话，不保存）" : "未启用 · 全部走免费源";
        st.style.color = FY_KEY ? WufuTheme.sub("§WFT0006§") : WufuTheme.sub("§WFT0002§");
      }
      pmHintUpdate(); syncNavKeyUI();
    });
    pmBind(); bootApply(); renderState(); renderFyFactorReport();
    setTimeout(function () { try { fillCorrCodes(); renderCorr(); } catch (e) { } }, 1800);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();

