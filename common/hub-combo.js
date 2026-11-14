/* ============================================================
   hub-combo.js — 首页跨系统策略组合合成器（只读已保存曲线，不跑引擎）
   与系统内「多策略组合」功能对齐：固定权重 + 自定义比例 + 周期再平衡、
   净值动量轮动、KPI、日收益相关矩阵、基准超额。
   ============================================================ */
window.WufuHubCombo = (function () {
  "use strict";

  function normDate(v) {
    var t = String(v == null ? "" : v);
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    if (/^\d{8}$/.test(t)) return t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8);
    var m = t.match(/^(\d{4})[\/\.](\d{1,2})[\/\.](\d{1,2})/);
    if (m) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
    return t.slice(0, 10);
  }
  function ymdParts(d) { return [+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)]; }
  function weekKey(d) {
    var p = ymdParts(d), t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day);
    return t.toISOString().slice(0, 10);
  }
  function periodKey(d, mode, intv) {
    var p = ymdParts(d);
    if (mode === "daily") return d;
    if (mode === "weekly") { var w = weekKey(d); return intv > 1 ? w : w; }
    if (mode === "monthly") return p[0] + "-" + p[1] + "-" + Math.floor((p[2] - 1) / (7 * Math.max(1, intv)));
    if (mode === "quarterly") return p[0] + "-Q" + Math.ceil(p[1] / 3);
    if (mode === "yearly") return String(p[0]);
    return "none";
  }
  function isRebalDay(prev, cur, mode, intv, i) {
    if (mode === "none") return i === 0;
    if (mode === "daily") return true;
    if (mode === "weekly") {
      if (intv > 1) {
        var k = "wufu_hub_week_seq";
        return true; // 周频按每周首个交易日触发，下面用 key 去重
      }
      return prev === null || weekKey(prev) !== weekKey(cur);
    }
    return prev === null || periodKey(prev, mode, intv) !== periodKey(cur, mode, intv);
  }

  function align(dates, vals, cal) {
    var mp = {}, out = new Array(cal.length), last = 1;
    for (var i = 0; i < dates.length; i++) mp[normDate(dates[i])] = vals[i];
    for (var j = 0; j < cal.length; j++) {
      var v = mp[cal[j]];
      if (v !== undefined && v === v && v > 0) last = v;
      out[j] = last;
    }
    return out;
  }

  function stats(nav, rets, benchNav) {
    var n = nav.length, first = nav[0] || 1, last = nav[n - 1] || 1;
    var total = last / first - 1;
    var years = Math.max((n - 1) / 252, 1e-9);
    var cagr = Math.pow(Math.max(last / first, 1e-12), 1 / years) - 1;
    var mean = 0, sd = 0, i;
    for (i = 0; i < rets.length; i++) mean += rets[i];
    mean /= Math.max(1, rets.length);
    for (i = 0; i < rets.length; i++) sd += (rets[i] - mean) * (rets[i] - mean);
    sd = Math.sqrt(sd / Math.max(1, rets.length - 1));
    var sharpe = sd > 1e-12 ? (mean * 252 - 0.02) / (sd * Math.sqrt(252)) : 0;
    var peak = nav[0], mdd = 0;
    for (i = 0; i < n; i++) { if (nav[i] > peak) peak = nav[i]; var dd = nav[i] / peak - 1; if (dd < mdd) mdd = dd; }
    var calmar = mdd < -1e-9 ? cagr / Math.abs(mdd) : 0;
    var benchTotal = null, excess = null;
    if (benchNav && benchNav.length >= n) {
      var b0 = benchNav[0], b1 = benchNav[n - 1];
      if (b0 > 0 && b1 > 0) { benchTotal = b1 / b0 - 1; excess = total - benchTotal; }
    }
    return { total: total, cagr: cagr, sharpe: sharpe, mdd: mdd, calmar: calmar, benchTotal: benchTotal, excess: excess, n_days: n - 1 };
  }

  function corrMatrix(rets) {
    function corr(a, b) {
      var n = Math.min(a.length, b.length), i, ma = 0, mb = 0;
      for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      var sa = 0, sb = 0, sab = 0;
      for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y; }
      return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : 0;
    }
    return rets.map(function (a) { return rets.map(function (b) { return corr(a, b); }); });
  }

  /* opts: {start,end,weightMode:'custom'|'momentum',weights:{id:w},reb,rebInt,momN,topK,bench:{dates,nav}} */
  function build(members, opts) {
    opts = opts || {};
    var warn = [];
    if (!members || !members.length) return { err: "请至少勾选一个策略" };
    var i, j;
    var all = {}, minStart = null, maxEnd = null;
    members.forEach(function (m) {
      var c = m.curve || {}, ds = c.dates || [];
      if (!ds.length || !c.nav || !c.nav.length) { warn.push(m.name + "：无净值曲线"); return; }
      var d0 = normDate(ds[0]), d1 = normDate(ds[ds.length - 1]);
      if (minStart === null || d0 > minStart) minStart = d0;
      if (maxEnd === null || d1 < maxEnd) maxEnd = d1;
      ds.forEach(function (d) { all[normDate(d)] = 1; });
    });
    var cal = Object.keys(all).sort();
    if (opts.start && normDate(opts.start) > minStart) minStart = normDate(opts.start);
    if (opts.end && normDate(opts.end) < maxEnd) maxEnd = normDate(opts.end);
    cal = cal.filter(function (d) { return d >= minStart && d <= maxEnd; });
    if (cal.length < 3) return { err: "成员曲线共同区间不足 3 个交易日", warn: warn };
    if (warn.length) warn.push("已按日期对齐，缺失处沿用前值");

    var navs = [], rets = [], ids = [], names = [], syses = [];
    members.forEach(function (m) {
      var c = m.curve || {}, ds = c.dates || [];
      if (!ds.length || !c.nav || !c.nav.length) return;
      var a = align(ds, c.nav, cal), r = [0];
      for (var k = 1; k < a.length; k++) r.push(a[k] / (a[k - 1] || 1) - 1);
      navs.push(a); rets.push(r); ids.push(m.id); names.push(m.name); syses.push(m.sys);
    });
    if (!navs.length) return { err: "所选策略都没有可用曲线", warn: warn };

    var n = navs.length, T = cal.length;
    var mode = opts.weightMode === "momentum" ? "momentum" : "custom";
    var reb = opts.reb || "monthly", intv = Math.max(1, +opts.rebInt || 1);
    var momN = Math.max(2, +opts.momN || 20), topK = Math.max(1, +opts.topK || 2);
    var wMap = opts.weights || {}, target = new Array(n).fill(1 / n), wsum = 0;
    if (mode === "custom") {
      for (i = 0; i < n; i++) { var w = +wMap[ids[i]]; target[i] = (w > 0 && isFinite(w)) ? w : 1 / n; wsum += target[i]; }
      if (wsum <= 0) { target = new Array(n).fill(1 / n); wsum = 1; }
      for (i = 0; i < n; i++) target[i] /= wsum;
    }

    var combo = new Array(T), shares = new Array(n).fill(0), V = 1;
    var lastKey = null, weeks = {};
    for (var t = 0; t < T; t++) {
      var need = false;
      if (t === 0) need = true;
      else if (reb === "none") need = false;
      else if (reb === "daily") need = true;
      else if (reb === "weekly") {
        var wk = weekKey(cal[t]);
        if (intv > 1) {
          var keys = Object.keys(weeks).sort();
          if (!keys.length || (keys.length % intv === 0 && wk !== keys[keys.length - 1])) { weeks[wk] = 1; need = true; }
        } else need = weekKey(cal[t - 1]) !== wk;
      } else need = periodKey(cal[t - 1], reb, intv) !== periodKey(cal[t], reb, intv);

      if (need) {
        var w = target;
        if (mode === "momentum") {
          var score = [];
          for (i = 0; i < n; i++) {
            var lo = Math.max(0, t - momN);
            score.push({ i: i, v: navs[i][t] / (navs[i][lo] || 1) - 1 });
          }
          score.sort(function (a, b) { return b.v - a.v; });
          w = new Array(n).fill(0);
          for (i = 0; i < Math.min(topK, n); i++) w[score[i].i] = 1 / Math.min(topK, n);
        }
        for (i = 0; i < n; i++) shares[i] = w[i] ? (V * w[i]) / (navs[i][t] || 1) : 0;
      }
      V = 0;
      for (i = 0; i < n; i++) V += shares[i] * navs[i][t];
      combo[t] = V;
      lastKey = periodKey(cal[t], reb, intv);
    }
    var cret = [0];
    for (i = 1; i < T; i++) cret.push(combo[i] / (combo[i - 1] || 1) - 1);
    var benchNav = null;
    if (opts.bench && opts.bench.dates && opts.bench.nav) benchNav = align(opts.bench.dates, opts.bench.nav, cal);

    return {
      dates: cal, nav: combo, ret: cret,
      members: navs.map(function (a, k2) { return { id: ids[k2], name: names[k2], sys: syses[k2], nav: a }; }),
      corr: corrMatrix(rets), kpi: stats(combo, cret, benchNav),
      benchNav: benchNav, warn: warn,
      params: { weightMode: mode, reb: reb, rebInt: intv, momN: momN, topK: topK, start: cal[0], end: cal[T - 1] }
    };
  }

  /* 读 /common/index.gz（首页在根、体检页在子目录，两种相对路径都试） */
  function gunzip(ab) {
    var u8 = new Uint8Array(ab);
    if (u8.length > 1 && !(u8[0] === 0x1f && u8[1] === 0x8b)) return new Blob([ab]).text();
    if (typeof DecompressionStream !== "undefined") {
      var body = new Blob([ab]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(body).text();
    }
    if (window.__gunzipText) return Promise.resolve(window.__gunzipText(new Uint8Array(ab)));
    return Promise.reject(new Error("no gunzip"));
  }
  function loadBench(done) {
    // 首页在根、组合页在 /combos/：先按页面位置推导同域 common/，避免先撞一次 404
    var base = "";
    try { base = new URL("../", location.href).href; } catch (e) { base = "/"; }
    var urls = [base + "common/index.gz", "./common/index.gz", "../common/index.gz", "/common/index.gz"];
    function next(i) {
      if (i >= urls.length) return done(null);
      fetch(urls[i]).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(gunzip).then(function (t) { done(JSON.parse(t)); })
        .catch(function () { next(i + 1); });
    }
    next(0);
  }
  function benchSeries(idxData, code, start, end) {
    if (!idxData || !idxData.index || !idxData.index[code]) return null;
    var a = idxData.index[code], cal = idxData.calendar, dates = [], nav = [], last = 0;
    for (var i = 0; i < cal.length; i++) {
      var d = normDate(cal[i]);
      if (d < start || d > end) continue;
      var v = a[i];
      if (v === undefined || v === -1 || !(v > 0)) v = last || 0;
      if (v > 0) last = v;
      dates.push(d); nav.push(v > 0 ? v : 1);
    }
    return dates.length > 2 ? { dates: dates, nav: nav } : null;
  }

  return { build: build, loadBench: loadBench, benchSeries: benchSeries, normDate: normDate };
})();
