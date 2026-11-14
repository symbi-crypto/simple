/* ============================================================
   health-config.js — ETF / 可转债「数据体检」共用的一份参数（v42）
   两个体检页、体检中心、hub-core 都读这里。业务上必须不同的
   数值只放在 overrides 里（ETF 主板 10%、可转债 20%），其余一律共用。
   改这一处，两个体检页同时生效，不再各写各的默认值。
   加载顺序：必须在 hub-core.js 之前。
   ============================================================ */
window.WufuHealthCfg = (function () {
  "use strict";
  var C = {
    /* 日期：两套系统共用同一套参数（v39 起） */
    date: { tick: 3000, endFollow: { etf: false, cb: true } },
    /* 体检扫描设置：两页共用；jump 按系统覆盖 */
    scan: {
      scope: 250, flat: 5, dev: 10,
      jump: { etf: 11, cb: 20 },
      scopeOptions: [60, 250, 0]
    },
    /* 体检判定共用口径 */
    detect: {
      sentinel: [0, -1],          /* 0 / -1 假价格 */
      flatMin: 4,                 /* 连着不动算可疑的下限 */
      endedQuietDays: 5,          /* 连着 N 个交易日无行情视为已结束 */
      endedGraceDays: 4           /* 落后 1~4 天不算问题 */
    },
    ui: { pageSize: 50, showConfirmedDefault: false },
    labels: {
      undo: "撤销上次修复", detail: "查看完整明细",
      fix: "一键修复数据", update: "一键更新行情",
      endedNote: "已结束标的自动跳过，不再报「没跟上最新日期」"
    }
  };
  C.forSys = function (sys) {
    var s = sys === "cb" ? "cb" : "etf";
    return {
      tick: C.date.tick, endFollow: !!C.date.endFollow[s],
      scope: C.scan.scope, flat: C.scan.flat, dev: C.scan.dev,
      jump: C.scan.jump[s], detect: C.detect, ui: C.ui, labels: C.labels
    };
  };
  /* 把共用参数落进两个体检页的扫描输入框；HTML 里的 value 只作兜底 */
  C.applyScanInputs = function (sys) {
    var v = C.forSys(sys), map = { hlScope: "scope", hlFlat: "flat", hlDev: "dev", hlJump: "jump" };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && v[map[id]] != null) el.value = v[map[id]];
    });
  };
  return C;
})();

/* ============================================================
   v48 · 全站共用：可选云端取数地址（Netlify Functions）
   ------------------------------------------------------------
   base 留空 = 完全不启用，所有行情请求照旧直连，与 v47 一模一样。
   启用只改下面这一行，填 Netlify 站点的固定地址即可，例如：
       base: "https://your-site.netlify.app"
   末尾不要带斜杠，也不要带 /.netlify/functions/... 路径。
   hosts 留空时只把「浏览器直连必被拒」的域名交给云端，
   东财 / 腾讯 / 新浪仍直连，调用次数最省。
   ============================================================ */
window.WufuUpstream = (function () {
  "use strict";
  var CFG = {
    base: "",            /* ← 只改这一行 */
    hosts: [],           /* 例：["datacenter-web.eastmoney.com"]；["*"] = 全部走云端，慎用 */
    timeoutMs: 15000,
    probe: true
  };
  var BLOCKED = ["query.sse.com.cn", "www.sse.com.cn", "www.szse.cn",
                 "legulegu.com", "www.legulegu.com"];
  var on = false;
  function base() { return String(CFG.base || "").trim().replace(/\/+$/, ""); }
  function functionUrl(mode, extra) {
    var b = base(); if (!b) return "";
    return b + "/.netlify/functions/quotes?mode=" + encodeURIComponent(mode || "ping") + (extra || "");
  }
  function hostOf(url) {
    try { return new URL(url, location.href).hostname.toLowerCase(); } catch (e) { return ""; }
  }
  function hit(h, list) {
    for (var i = 0; i < list.length; i++) {
      var x = String(list[i]).toLowerCase();
      if (x === "*" || h === x || h.slice(-(x.length + 1)) === "." + x) return true;
    }
    return false;
  }
  /* 把原始行情地址改写成云端函数地址；不命中就原样返回 */
  function route(url) {
    try {
      var b = base();
      if (!on || !b) return url;
      if (url.indexOf(b) === 0 || url.indexOf("/.netlify/functions/") >= 0) return url; // 防套娃
      var list = (CFG.hosts && CFG.hosts.length) ? CFG.hosts : BLOCKED;
      if (!hit(hostOf(url), list)) return url;
      return b + "/.netlify/functions/quotes?url=" + encodeURIComponent(url);
    } catch (e) { return url; }
  }
  /* 静默自检：函数不通就关掉云端回退直连，不弹窗、不改文件、不假装成功 */
  function ping() {
    var b = base();
    if (!CFG.probe || !b) return;
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (e) { } } }, 6000);
    var opt = { cache: "no-store" }; if (ctl) opt.signal = ctl.signal;
    fetch(functionUrl("ping"), opt)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) { if (!o || !o.ok) on = false; })
      .catch(function () { on = false; })
      .then(function () { clearTimeout(t); });
  }
  on = !!base();
  if (on) {
    if (typeof document !== "undefined" && document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", ping);
    else ping();
  }
  return {
    cfg: CFG, route: route, functionUrl: functionUrl,
    isOn: function () { return on; },
    disable: function () { on = false; }
  };
})();
window.WUFU_ROUTE = window.WufuUpstream.route;
