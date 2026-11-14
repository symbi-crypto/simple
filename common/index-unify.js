/* ============================================================
   index-unify.js — 两套系统共用：统一指数表读取 + 按本地日历重采样
   权威源 /common/index.gz（5542 日主日历）；ETF 日历与之相同可直读，
   CB 只有 2383 日，必须按日期对齐重采样，不能按数组下标截取。
   ============================================================ */
window.WufuCommon = (function () {
  "use strict";
  function commonUrl(file) {
    try { return new URL("../common/" + file, location.href).href; }
    catch (err) { return "../common/" + file; }
  }
  function gunzip(ab) {
    if (typeof DecompressionStream !== "undefined") {
      var body = new Blob([ab]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(body).text();
    }
    if (window.__gunzipText) return Promise.resolve(window.__gunzipText(new Uint8Array(ab)));
    return Promise.reject(new Error("no gunzip"));
  }
  function loadIndex(localCal, done) {
    fetch(commonUrl("index.gz"))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then(gunzip)
      .then(function (t) {
        var src = JSON.parse(t);
        var cal = (localCal && localCal.length) ? localCal : src.calendar;
        var pos = {};
        src.calendar.forEach(function (d, i) { pos[d] = i; });
        var idx = {};
        Object.keys(src.index).forEach(function (code) {
          var a = src.index[code];
          idx[code] = cal.map(function (d) {
            var i = pos[d];
            return (i === undefined) ? -1 : a[i];
          });
        });
        done({ __slim: true, calendar: cal, pool: src.pool, series: {}, index: idx });
      })
      .catch(function () { done(null); });
  }
  return { loadIndex: loadIndex, commonUrl: commonUrl };
})();
