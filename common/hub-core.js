/* ============================================================
   v49 · 随包状态自动生效 + GitHub 仓库同步
   export.js / Actions 生成的 state.json 里装着策略、组合、行情增量…
   页面加载时按「数据止」挑最新的一份补回本机：
     · 先读站点自带的 state.json（离线包 / Netlify 自动重建，立刻生效）
     · 再读 GitHub 仓库里的 state.json（Actions 每周推，两个 CDN 通道互为备份）
       —— 花生壳这类不连仓库的静态托管，靠这一步把云端数据自动带回系统
     · 大键走 WufuStore → IndexedDB；本机已有的不覆盖，主行情补丁按日期比
     · 补完派发 wufu:bundled-ready，两套系统据此重放补丁、刷新日期
   任何一路失败都静默跳过，不弹窗、不阻塞、断网照常打开。
   ============================================================ */
(function () {
  "use strict";
  function siteRoot() {
    var s = document.currentScript, i, ss;
    if (!s || !s.src) {
      ss = document.getElementsByTagName("script");
      for (i = 0; i < ss.length; i++) {
        if (/hub-core\.js(\?|$)/.test(ss[i].src || "")) { s = ss[i]; break; }
      }
    }
    try {
      if (s && s.src) {
        var m = new URL(s.src, location.href).pathname.match(/^(.*)\/common\/hub-core\.js$/i);
        if (m) return new URL(m[1] + "/", location.href).href;
      }
    } catch (e) { }
    try { if (window.WufuHeader && window.WufuHeader.root) return window.WufuHeader.root; } catch (e) { }
    return new URL("./", location.href).href;
  }
  var BIG_RE = /(QPatch|QUndo|qck_snap|qck_fix|_fc_|Snap_v|Patch_v|qck_)/i;
  var PRIMARY = /^(wufuCbQPatch_v1|wufuQPatch_v1)$/;
  function lastDate(txt) {
    try {
      var o = JSON.parse(txt), d = (o && o.days) || [], last = "", i;
      if (Object.prototype.toString.call(d) === "[object Array]") {
        for (i = d.length - 1; i >= 0; i--) {
          if (d[i] && d[i].date) { last = String(d[i].date).slice(0, 10); break; }
        }
      }
      if (o && o.scale && o.scale.asof) {
        var q = String(o.scale.asof).slice(0, 10);
        if (q > last) last = q;
      }
      return last;
    } catch (e) { return ""; }
  }
  function fire(detail) {
    window.__WUFU_BUNDLED = detail;
    try { window.dispatchEvent(new CustomEvent("wufu:bundled-ready", { detail: detail })); }
    catch (e) { try { window.dispatchEvent(new Event("wufu:bundled-ready")); } catch (e2) { } }
  }
  /* GitHub 仓库里的 state.json：jsDelivr 为主、raw 为备，都是公开只读 */
  var GH_REMOTE = [
    "https://cdn.jsdelivr.net/gh/symbi-crypto/simple@main/state.json",
    "https://raw.githubusercontent.com/symbi-crypto/simple/main/state.json"
  ];
  function asof(j) {
    var a = String((j && j.dataAsOf) || "").slice(0, 10);
    return a || String((j && j.exportedAt) || "").slice(0, 10);
  }
  function getJSON(url, ms) {
    return new Promise(function (resolve) {
      var done = false, timer = null, ctl = null;
      function fin(v) {
        if (done) return;
        done = true;
        try { if (timer) clearTimeout(timer); } catch (e) { }
        resolve(v);
      }
      try {
        var opt = { cache: "no-store" };
        if (typeof AbortController !== "undefined") { ctl = new AbortController(); opt.signal = ctl.signal; }
        timer = setTimeout(function () {
          try { if (ctl) ctl.abort(); } catch (e) { }
          fin(null);
        }, ms || 3500);
        fetch(url, opt).then(function (r) { return (r && r.ok) ? r.json() : null; })
          .then(function (j) { fin(j || null); })
          .catch(function () { fin(null); });
      } catch (e) { fin(null); }
    });
  }
  function apply(j) {
    var ls = j && j.localStorage;
    if (!ls || typeof ls !== "object") return null;
    var S = window.WufuStore, small = 0, big = 0, skip = 0, pending = false;
    Object.keys(ls).forEach(function (k) {
      var v = ls[k];
      if (v == null || typeof v !== "string") return;
      var cur = null;
      try { cur = window.localStorage.getItem(k); } catch (e) { }
      if (cur != null && cur !== "") {
        if (!PRIMARY.test(k)) { skip++; return; }
        var a = lastDate(cur), b = lastDate(v);
        if (!b || (a && a >= b)) { skip++; return; }
      }
      try {
        if (S && S.put) {
          var r = S.put(k, v);
          if (!r.ok) return;
          if (r.pending) pending = true;
        } else {
          window.localStorage.setItem(k, v);
        }
        if (BIG_RE.test(k) || v.length > 48 * 1024) big++; else small++;
      } catch (e) { }
    });
    var done = function (ok) {
      fire({ exportedAt: j.exportedAt || "", dataAsOf: j.dataAsOf || "",
             small: small, big: big, skip: skip, stored: ok });
    };
    if (pending && S && S.flush) return S.flush().then(function (f) { done(!f || f.ok !== false); });
    done(true);
    return null;
  }
  function run() {
    var urls = [];
    try { urls.push(new URL("state.json?__swcache=1", siteRoot()).href); } catch (e) { }
    GH_REMOTE.forEach(function (u) { urls.push(u); });
    if (!urls.length) return;
    /* 包内 / 仓库几路一起问，按「数据止」挑最新的一份，只补一次、只重放一次 */
    Promise.all(urls.map(function (u) { return getJSON(u, 3500); }))
      .then(function (list) {
        var best = null;
        list.forEach(function (j) {
          if (!j || !j.localStorage || typeof j.localStorage !== "object") return;
          if (!best || asof(j) > asof(best)) best = j;
        });
        if (best) return apply(best);
        return null;
      }).catch(function () { });
  }
  try { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run(); }
  catch (e) { try { run(); } catch (e2) { } }
})();

/* ============================================================
   hub-core.js — 首页 / 体检独立页 / 两套系统页共用
   统一 localStorage 键位、策略曲线读取、数据截至、体检摘要、检查调度。
   只做「读账本 + 写状态」，不加载行情、不跑引擎。
   ============================================================ */
window.WufuHub = (function () {
  "use strict";

  var KEYS = {
    ST_ETF: "wufu_strategies_v1",
    ST_CB: "wufu_cb_strategies_v1",
    COMBO_ETF: "wufu_combos_v1",
    COMBO_CB: "wufuCb_combos_v1",
    ASOF_ETF: "wufuHub_asof_etf_v1",
    ASOF_CB: "wufuHub_asof_cb_v1",
    HEALTH_ETF: "wufu_health_last_v1",
    HEALTH_CB: "wufu_cb_health_last_v1",
    HUB_COMBOS: "wufuHub_combos_v1",
    CHECK_REQ: "wufuHub_check_request_v1"
  };

  function LS() { try { return window.localStorage; } catch (e) { return null; } }
  function get(k) { var l = LS(); try { return l ? l.getItem(k) : null; } catch (e) { return null; } }
  function set(k, v) { var l = LS(); try { if (l) l.setItem(k, v); } catch (e) { } }
  function getJ(k, dft) { try { var t = get(k); return t ? JSON.parse(t) : dft; } catch (e) { return dft; } }
  function setJ(k, v) { try { set(k, JSON.stringify(v)); } catch (e) { } }

  /* 内置策略清单：打包时从 cb/index.html 与 etf/index.html 的 #wufuPresetStrats 自动同步。
     任何引用本文件的页面加载时都会统一补齐两套系统的内置策略条目，
     不必「先打开过某套系统」；ETF 与 CB 走同一套逻辑，只补不覆盖，
     但同名记录若是空壳 / 缺字段则自动恢复为完整预设，绝不注入静态净值快照。
     曲线仍由各系统页打开后按最新行情回测写入账本（见 HUB_CURVE_V1.refresh）。 */
  var PRESETS = { etf: {"低波ATR轮动-11资产":{"codes":["518880.SH","513100.SH","512890.SH","159915.SZ","511010.SH","159985.SZ","159920.SZ","511810.SH","512400.SH","513500.SH","159928.SZ"],"only_rotation_codes":[],"cooldown_days":0,"factors":[{"kind":"atr","window":40,"window2":0,"window3":0,"weight":1,"direction":-1,"usage":"rank","enabled":true}],"top_n":0,"rank_n":1,"rank_m":3,"standardize":"robust","buy_add":[],"sell_conds":[{"type":"rank","op":"gte","value":4,"enabled":true}],"hold_conds":[],"mode":"rotation","reb_weights":{"518880.SH":0.090909,"513100.SH":0.090909,"512890.SH":0.090909,"159915.SZ":0.090909,"511010.SH":0.090909,"159985.SZ":0.090909,"159920.SZ":0.090909,"511810.SH":0.090909,"512400.SH":0.090909,"513500.SH":0.090909,"159928.SZ":0.090909},"reb_codes":["518880.SH","513100.SH","512890.SH","159915.SZ","511010.SH","159985.SZ","159920.SZ","511810.SH","512400.SH","513500.SH","159928.SZ"],"reb_weight_mode":"fixed","reb_lookback":20,"rebalance_mode":"weekly","rebalance_interval":1,"rebalance_anchor":"mon","annualize_factor":252,"score_floor":0,"r2_filter_mode":"normal_only","mm_on":false,"mm_bench":["000300.SH"],"mm_mode":"any","mm_window":20,"mm_enter_days":3,"mm_exit_days":3,"mm_action":"cut","mm_cut_pct":50,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0005,"tiered_slippage":false,"min_commission":5,"use_real_pool":false,"holding_weight":"equal","start_date":"2017-01-03","end_date":"2026-09-30","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"st_small_idx":"000852.SH","st_large_idx":"000300.SH","st_window":20,"st_small_codes":["512100.SH","563300.SH","8841431.WI"],"st_large_codes":["510050.SH","510300.SH","159901.SZ","512550.SH","563350.SH","512050.SH"],"benchmark":"000300.SH","_saved_at":"2026-10-22T00:00:00.000Z"},"全天候风险平价-6资产":{"codes":["510300.SH","518880.SH","513100.SH","511010.SH","512890.SH","159985.SZ"],"only_rotation_codes":[],"cooldown_days":0,"factors":[],"top_n":0,"rank_n":1,"rank_m":1,"standardize":"robust","buy_add":[],"sell_conds":[],"hold_conds":[],"mode":"rebalance","reb_weights":{"510300.SH":0.166667,"518880.SH":0.166667,"513100.SH":0.166667,"511010.SH":0.166667,"512890.SH":0.166667,"159985.SZ":0.166667},"reb_codes":["510300.SH","518880.SH","513100.SH","511010.SH","512890.SH","159985.SZ"],"reb_weight_mode":"risk_parity","reb_lookback":60,"rebalance_mode":"monthly","rebalance_interval":1,"rebalance_anchor":"first","annualize_factor":252,"score_floor":0,"r2_filter_mode":"normal_only","mm_on":false,"mm_bench":["000300.SH"],"mm_mode":"any","mm_window":20,"mm_enter_days":3,"mm_exit_days":3,"mm_action":"cut","mm_cut_pct":50,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0005,"tiered_slippage":false,"min_commission":5,"use_real_pool":false,"holding_weight":"equal","start_date":"2017-01-03","end_date":"2026-09-30","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"st_small_idx":"000852.SH","st_large_idx":"000300.SH","st_window":20,"st_small_codes":["512100.SH","563300.SH","8841431.WI"],"st_large_codes":["510050.SH","510300.SH","159901.SZ","512550.SH","563350.SH","512050.SH"],"benchmark":"000300.SH","_saved_at":"2026-10-22T00:00:00.000Z"},"动量反过热-6资产":{"codes":["510180.SH","159949.SZ","513100.SH","513520.SH","518880.SH","159985.SZ"],"only_rotation_codes":["510180.SH"],"cooldown_days":0,"factors":[{"kind":"slope_r2","window":25,"window2":0,"window3":0,"weight":1,"direction":1,"usage":"rank","enabled":true},{"kind":"expr","window":60,"window2":0,"window3":0,"weight":0,"direction":-1,"usage":"filter","enabled":true,"op":"lte","threshold":0.25,"expr":"(roc(59)+roc(60)+roc(61))/3","name":"近两月涨幅均值"}],"top_n":0,"rank_n":1,"rank_m":1,"standardize":"robust","buy_add":[],"sell_conds":[{"type":"expr","expr":"premium - ma(premium,250) > 0.025","enabled":true},{"type":"rank","op":"gte","value":2,"enabled":true}],"hold_conds":[],"mode":"rotation","reb_weights":{"510180.SH":0.166667,"159949.SZ":0.166667,"513100.SH":0.166667,"513520.SH":0.166667,"518880.SH":0.166667,"159985.SZ":0.166667},"reb_codes":["510180.SH","159949.SZ","513100.SH","513520.SH","518880.SH","159985.SZ"],"reb_weight_mode":"fixed","reb_lookback":20,"rebalance_mode":"weekly","rebalance_interval":1,"rebalance_anchor":"mon","annualize_factor":252,"score_floor":-1000000000.0,"r2_filter_mode":"normal_only","mm_on":false,"mm_bench":["000300.SH"],"mm_mode":"any","mm_window":250,"mm_enter_days":1,"mm_exit_days":1,"mm_action":"cut","mm_cut_pct":0,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0005,"tiered_slippage":false,"min_commission":5,"use_real_pool":true,"holding_weight":"equal","start_date":"2017-01-03","end_date":"2026-09-30","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"st_small_idx":"000852.SH","st_large_idx":"000300.SH","st_window":20,"st_small_codes":[],"st_large_codes":[],"benchmark":"000300.SH","_saved_at":"2026-10-24T00:00:00.000Z"},"TIP择时-纳指标普-留仓30":{"codes":["513100.SH","513500.SH"],"only_rotation_codes":[],"cooldown_days":0,"factors":[{"kind":"roc","window":250,"window2":0,"window3":0,"weight":1,"direction":1,"usage":"rank","enabled":true}],"top_n":0,"rank_n":1,"rank_m":2,"standardize":"robust","buy_add":[],"sell_conds":[{"type":"rank","op":"gte","value":3}],"hold_conds":[],"mode":"rotation","reb_weights":{"513100.SH":0.5,"513500.SH":0.5},"reb_codes":["513100.SH","513500.SH"],"reb_weight_mode":"fixed","reb_lookback":20,"rebalance_mode":"daily","rebalance_interval":1,"rebalance_anchor":"","annualize_factor":252,"score_floor":-1000000000,"r2_filter_mode":"normal_only","mm_on":true,"mm_bench":["TIP.P"],"mm_mode":"any","mm_window":250,"mm_enter_days":1,"mm_exit_days":1,"mm_action":"cut","mm_cut_pct":30,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0005,"tiered_slippage":false,"min_commission":5,"use_real_pool":false,"holding_weight":"equal","start_date":"2017-07-03","end_date":"2026-09-30","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"st_small_idx":"000852.SH","st_large_idx":"000300.SH","st_window":20,"st_small_codes":[],"st_large_codes":[],"benchmark":"000300.SH","_saved_at":"2026-10-22T00:00:00.000Z"},"低波策略-7资产":{"codes":["510300.SH","510180.SH","513500.SH","159920.SZ","518880.SH","159985.SZ","159981.SZ"],"only_rotation_codes":[],"cooldown_days":0,"factors":[{"kind":"vol","window":60,"window2":0,"window3":0,"weight":1,"direction":-1,"usage":"rank","enabled":true},{"kind":"vol","window":60,"window2":0,"window3":0,"weight":0,"direction":-1,"usage":"filter","op":"lte","threshold":0.25,"enabled":true}],"top_n":0,"rank_n":1,"rank_m":1,"standardize":"robust","buy_add":[],"sell_conds":[{"type":"rank","op":"gte","value":2,"enabled":true}],"hold_conds":[],"mode":"rotation","reb_weights":{"510300.SH":14.29,"510180.SH":14.29,"513500.SH":14.29,"159920.SZ":14.29,"518880.SH":14.29,"159985.SZ":14.29,"159981.SZ":14.29},"reb_codes":["510300.SH","510180.SH","513500.SH","159920.SZ","518880.SH","159985.SZ","159981.SZ"],"reb_weight_mode":"fixed","reb_lookback":20,"rebalance_mode":"weekly","rebalance_interval":1,"rebalance_anchor":"","annualize_factor":252,"score_floor":-1000000000,"r2_filter_mode":"normal_only","mm_on":false,"mm_bench":["000300.SH"],"mm_mode":"any","mm_window":20,"mm_enter_days":3,"mm_exit_days":3,"mm_action":"cut","mm_cut_pct":50,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0005,"tiered_slippage":false,"min_commission":5,"use_real_pool":false,"holding_weight":"equal","start_date":"2017-01-03","end_date":"2026-09-30","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"st_small_idx":"000852.SH","st_large_idx":"000300.SH","st_window":20,"st_small_codes":["512100.SH","563300.SH","8841431.WI"],"st_large_codes":["510050.SH","510300.SH","159901.SZ","512550.SH","563350.SH","512050.SH"],"benchmark":"000300.SH"}}, cb: {"三要素50":{"codes":["110031.SH","110033.SH","110034.SH","110038.SH","110041.SH","110043.SH","110044.SH","110045.SH","110047.SH","110048.SH","110051.SH","110052.SH","110053.SH","110055.SH","110056.SH","110057.SH","110058.SH","110059.SH","110060.SH","110061.SH","110062.SH","110063.SH","110064.SH","110065.SH","110066.SH","110067.SH","110068.SH","110069.SH","110070.SH","110071.SH","110072.SH","110073.SH","110074.SH","110075.SH","110076.SH","110077.SH","110079.SH","110080.SH","110081.SH","110082.SH","110083.SH","110084.SH","110085.SH","110086.SH","110087.SH","110088.SH","110089.SH","110090.SH","110091.SH","110092.SH","110093.SH","110094.SH","110095.SH","110096.SH","110097.SH","110098.SH","110099.SH","111000.SH","111001.SH","111002.SH","111003.SH","111004.SH","111005.SH","111006.SH","111007.SH","111008.SH","111009.SH","111010.SH","111011.SH","111012.SH","111013.SH","111014.SH","111015.SH","111016.SH","111017.SH","111018.SH","111019.SH","111020.SH","111021.SH","111022.SH","111023.SH","113008.SH","113009.SH","113011.SH","113012.SH","113013.SH","113014.SH","113016.SH","113017.SH","113021.SH","113024.SH","113025.SH","113026.SH","113027.SH","113029.SH","113030.SH","113032.SH","113033.SH","113034.SH","113035.SH","113036.SH","113037.SH","113038.SH","113039.SH","113040.SH","113041.SH","113042.SH","113043.SH","113044.SH","113045.SH","113046.SH","113047.SH","113048.SH","113049.SH","113050.SH","113051.SH","113052.SH","113053.SH","113054.SH","113055.SH","113056.SH","113057.SH","113058.SH","113059.SH","113060.SH","113061.SH","113062.SH","113063.SH","113064.SH","113065.SH","113066.SH","113067.SH","113068.SH","113069.SH","113070.SH","113502.SH","113504.SH","113505.SH","113508.SH","113509.SH","113516.SH","113519.SH","113520.SH","113524.SH","113525.SH","113526.SH","113527.SH","113528.SH","113530.SH","113532.SH","113534.SH","113535.SH","113536.SH","113537.SH","113541.SH","113542.SH","113543.SH","113545.SH","113546.SH","113548.SH","113549.SH","113550.SH","113556.SH","113557.SH","113559.SH","113561.SH","113563.SH","113564.SH","113565.SH","113566.SH","113567.SH","113568.SH","113569.SH","113570.SH","113572.SH","113573.SH","113574.SH","113575.SH","113576.SH","113577.SH","113578.SH","113579.SH","113580.SH","113582.SH","113583.SH","113584.SH","113585.SH","113586.SH","113587.SH","113588.SH","113589.SH","113590.SH","113591.SH","113592.SH","113593.SH","113594.SH","113595.SH","113596.SH","113597.SH","113598.SH","113599.SH","113600.SH","113601.SH","113602.SH","113603.SH","113604.SH","113605.SH","113606.SH","113607.SH","113608.SH","113609.SH","113610.SH","113611.SH","113612.SH","113614.SH","113615.SH","113616.SH","113618.SH","113619.SH","113620.SH","113621.SH","113622.SH","113623.SH","113624.SH","113625.SH","113626.SH","113627.SH","113628.SH","113629.SH","113630.SH","113631.SH","113632.SH","113633.SH","113634.SH","113635.SH","113636.SH","113637.SH","113638.SH","113639.SH","113640.SH","113641.SH","113642.SH","113643.SH","113644.SH","113646.SH","113647.SH","113648.SH","113649.SH","113650.SH","113651.SH","113652.SH","113653.SH","113654.SH","113655.SH","113656.SH","113657.SH","113658.SH","113659.SH","113660.SH","113661.SH","113662.SH","113663.SH","113664.SH","113665.SH","113666.SH","113667.SH","113668.SH","113669.SH","113670.SH","113671.SH","113672.SH","113673.SH","113674.SH","113675.SH","113676.SH","113677.SH","113678.SH","113679.SH","113680.SH","113681.SH","113682.SH","113683.SH","113684.SH","113685.SH","113686.SH","113687.SH","113688.SH","113689.SH","113690.SH","113691.SH","113692.SH","113693.SH","113694.SH","113695.SH","113696.SH","113697.SH","113698.SH","113699.SH","118000.SH","118001.SH","118002.SH","118003.SH","118004.SH","118005.SH","118006.SH","118007.SH","118008.SH","118009.SH","118010.SH","118011.SH","118012.SH","118013.SH","118014.SH","118015.SH","118016.SH","118017.SH","118018.SH","118019.SH","118020.SH","118021.SH","118022.SH","118023.SH","118024.SH","118025.SH","118026.SH","118027.SH","118028.SH","118029.SH","118030.SH","118031.SH","118032.SH","118033.SH","118034.SH","118035.SH","118036.SH","118037.SH","118038.SH","118039.SH","118040.SH","118041.SH","118042.SH","118043.SH","118044.SH","118045.SH","118046.SH","118048.SH","118049.SH","118050.SH","118051.SH","118052.SH","118053.SH","118054.SH","118055.SH","118056.SH","118057.SH","118058.SH","123002.SZ","123004.SZ","123007.SZ","123010.SZ","123011.SZ","123012.SZ","123013.SZ","123014.SZ","123015.SZ","123017.SZ","123018.SZ","123022.SZ","123023.SZ","123024.SZ","123025.SZ","123027.SZ","123028.SZ","123029.SZ","123030.SZ","123031.SZ","123033.SZ","123034.SZ","123035.SZ","123038.SZ","123039.SZ","123042.SZ","123043.SZ","123044.SZ","123045.SZ","123046.SZ","123047.SZ","123048.SZ","123049.SZ","123050.SZ","123051.SZ","123052.SZ","123053.SZ","123054.SZ","123055.SZ","123056.SZ","123057.SZ","123058.SZ","123059.SZ","123060.SZ","123061.SZ","123062.SZ","123063.SZ","123064.SZ","123065.SZ","123066.SZ","123067.SZ","123068.SZ","123069.SZ","123070.SZ","123071.SZ","123072.SZ","123073.SZ","123074.SZ","123075.SZ","123076.SZ","123077.SZ","123078.SZ","123079.SZ","123080.SZ","123081.SZ","123082.SZ","123083.SZ","123084.SZ","123085.SZ","123086.SZ","123087.SZ","123088.SZ","123089.SZ","123090.SZ","123091.SZ","123092.SZ","123093.SZ","123094.SZ","123096.SZ","123097.SZ","123098.SZ","123099.SZ","123100.SZ","123101.SZ","123102.SZ","123103.SZ","123104.SZ","123105.SZ","123106.SZ","123107.SZ","123108.SZ","123109.SZ","123110.SZ","123111.SZ","123112.SZ","123113.SZ","123114.SZ","123115.SZ","123116.SZ","123117.SZ","123118.SZ","123119.SZ","123120.SZ","123121.SZ","123122.SZ","123123.SZ","123124.SZ","123125.SZ","123126.SZ","123127.SZ","123128.SZ","123129.SZ","123130.SZ","123131.SZ","123132.SZ","123133.SZ","123134.SZ","123135.SZ","123136.SZ","123137.SZ","123138.SZ","123139.SZ","123140.SZ","123141.SZ","123142.SZ","123143.SZ","123144.SZ","123145.SZ","123146.SZ","123147.SZ","123148.SZ","123149.SZ","123150.SZ","123151.SZ","123152.SZ","123153.SZ","123154.SZ","123155.SZ","123156.SZ","123157.SZ","123158.SZ","123159.SZ","123160.SZ","123161.SZ","123162.SZ","123163.SZ","123164.SZ","123165.SZ","123166.SZ","123167.SZ","123168.SZ","123169.SZ","123170.SZ","123171.SZ","123172.SZ","123173.SZ","123174.SZ","123175.SZ","123176.SZ","123177.SZ","123178.SZ","123179.SZ","123180.SZ","123181.SZ","123182.SZ","123183.SZ","123184.SZ","123185.SZ","123186.SZ","123187.SZ","123188.SZ","123189.SZ","123190.SZ","123191.SZ","123192.SZ","123193.SZ","123194.SZ","123195.SZ","123196.SZ","123197.SZ","123198.SZ","123199.SZ","123200.SZ","123201.SZ","123202.SZ","123203.SZ","123204.SZ","123205.SZ","123206.SZ","123207.SZ","123208.SZ","123209.SZ","123210.SZ","123211.SZ","123212.SZ","123213.SZ","123214.SZ","123215.SZ","123216.SZ","123217.SZ","123218.SZ","123219.SZ","123220.SZ","123221.SZ","123222.SZ","123223.SZ","123224.SZ","123225.SZ","123226.SZ","123227.SZ","123228.SZ","123229.SZ","123230.SZ","123231.SZ","123232.SZ","123233.SZ","123234.SZ","123235.SZ","123236.SZ","123237.SZ","123238.SZ","123239.SZ","123240.SZ","123241.SZ","123242.SZ","123243.SZ","123244.SZ","123245.SZ","123246.SZ","123247.SZ","123248.SZ","123249.SZ","123250.SZ","123251.SZ","123252.SZ","123253.SZ","123254.SZ","123255.SZ","123256.SZ","123257.SZ","123258.SZ","127003.SZ","127004.SZ","127005.SZ","127006.SZ","127007.SZ","127008.SZ","127011.SZ","127012.SZ","127013.SZ","127014.SZ","127015.SZ","127016.SZ","127017.SZ","127018.SZ","127019.SZ","127020.SZ","127021.SZ","127022.SZ","127023.SZ","127024.SZ","127025.SZ","127026.SZ","127027.SZ","127028.SZ","127029.SZ","127030.SZ","127031.SZ","127032.SZ","127033.SZ","127034.SZ","127035.SZ","127036.SZ","127037.SZ","127038.SZ","127039.SZ","127040.SZ","127041.SZ","127042.SZ","127043.SZ","127044.SZ","127045.SZ","127046.SZ","127047.SZ","127048.SZ","127049.SZ","127050.SZ","127051.SZ","127052.SZ","127053.SZ","127054.SZ","127055.SZ","127056.SZ","127057.SZ","127058.SZ","127059.SZ","127060.SZ","127061.SZ","127062.SZ","127063.SZ","127064.SZ","127065.SZ","127066.SZ","127067.SZ","127068.SZ","127069.SZ","127070.SZ","127071.SZ","127072.SZ","127073.SZ","127074.SZ","127075.SZ","127076.SZ","127077.SZ","127078.SZ","127079.SZ","127080.SZ","127081.SZ","127082.SZ","127083.SZ","127084.SZ","127085.SZ","127086.SZ","127087.SZ","127088.SZ","127089.SZ","127090.SZ","127091.SZ","127092.SZ","127093.SZ","127094.SZ","127095.SZ","127096.SZ","127097.SZ","127098.SZ","127099.SZ","127100.SZ","127101.SZ","127102.SZ","127103.SZ","127104.SZ","127105.SZ","127106.SZ","127107.SZ","127108.SZ","127109.SZ","127110.SZ","127111.SZ","128010.SZ","128012.SZ","128013.SZ","128014.SZ","128015.SZ","128017.SZ","128018.SZ","128019.SZ","128021.SZ","128022.SZ","128023.SZ","128025.SZ","128026.SZ","128028.SZ","128029.SZ","128030.SZ","128032.SZ","128033.SZ","128034.SZ","128035.SZ","128036.SZ","128037.SZ","128039.SZ","128040.SZ","128041.SZ","128042.SZ","128044.SZ","128046.SZ","128048.SZ","128049.SZ","128050.SZ","128051.SZ","128052.SZ","128053.SZ","128056.SZ","128057.SZ","128062.SZ","128063.SZ","128064.SZ","128065.SZ","128066.SZ","128069.SZ","128070.SZ","128071.SZ","128072.SZ","128073.SZ","128074.SZ","128075.SZ","128076.SZ","128078.SZ","128079.SZ","128081.SZ","128082.SZ","128083.SZ","128085.SZ","128087.SZ","128090.SZ","128091.SZ","128093.SZ","128094.SZ","128095.SZ","128096.SZ","128097.SZ","128100.SZ","128101.SZ","128103.SZ","128104.SZ","128105.SZ","128106.SZ","128107.SZ","128108.SZ","128109.SZ","128110.SZ","128111.SZ","128112.SZ","128113.SZ","128114.SZ","128115.SZ","128116.SZ","128117.SZ","128118.SZ","128119.SZ","128120.SZ","128121.SZ","128122.SZ","128123.SZ","128124.SZ","128125.SZ","128126.SZ","128127.SZ","128128.SZ","128129.SZ","128130.SZ","128131.SZ","128132.SZ","128133.SZ","128134.SZ","128135.SZ","128136.SZ","128137.SZ","128138.SZ","128139.SZ","128140.SZ","128141.SZ","128142.SZ","128143.SZ","128144.SZ","128145.SZ"],"only_rotation_codes":[],"cooldown_days":0,"factors":[{"kind":"close","window":1,"window2":0,"window3":0,"weight":0,"direction":1,"usage":"filter","op":"gte","threshold":95,"enabled":true},{"kind":"close","window":1,"window2":0,"window3":0,"weight":0,"direction":1,"usage":"filter","op":"lte","threshold":140,"enabled":true},{"kind":"remain_y","window":1,"window2":0,"window3":0,"weight":0,"direction":1,"usage":"filter","op":"gte","threshold":1,"enabled":true},{"kind":"prem_now","window":1,"window2":0,"window3":0,"weight":1,"direction":-1,"usage":"rank","enabled":true},{"kind":"remain_y","window":1,"window2":0,"window3":0,"weight":1,"direction":-1,"usage":"rank","enabled":true},{"kind":"ytm","window":1,"window2":0,"window3":0,"weight":1,"direction":1,"usage":"rank","enabled":true}],"top_n":50,"rank_n":1,"rank_m":50,"standardize":"robust","buy_add":[],"sell_conds":[{"type":"rank","op":"gte","value":60,"enabled":true}],"hold_conds":[],"mode":"rotation","reb_weight_mode":"equal","reb_lookback":20,"rebalance_mode":"weekly","rebalance_interval":1,"annualize_factor":252,"score_floor":0,"r2_filter_mode":"normal_only","mm_on":false,"mm_bench":[],"mm_mode":"any","mm_window":20,"mm_enter_days":3,"mm_exit_days":3,"mm_action":"cut","mm_cut_pct":50,"mm_hedge_pool":[],"mm_weak_ma":false,"fallback_when_no_signal":"cash","reb_style":"equal","reb_dev_pct":10,"reb_period_on":true,"reb_band_on":false,"commission_rate":0.0002,"slippage_rate":0.0015,"tiered_slippage":false,"min_commission":0,"use_real_pool":true,"holding_weight":"equal","start_date":"2017-01-03","end_date":"2026-10-29","initial_capital":1000000,"risk_free_rate":0.02,"overseas_codes":[],"st_on":false,"benchmark":"399303.SZ","_saved_at":"2026-11-14T00:00:00.000Z","rebalance_anchor":"mon","cb_ex":{"rat":[],"st":true,"notice":true,"met":true,"hint":true,"expire":true,"newdays":3},"_thr_v":2}} };
  function presets(sys) { return PRESETS[sys === "cb" ? "cb" : "etf"] || {}; }
  function clonePreset(p) { try { return JSON.parse(JSON.stringify(p)); } catch (e) { return p; } }
  /* 内置策略自愈：账本里若残留空壳或字段缺失的同名记录，回测会报错
     （KPI 打不开、加载无结果、曲线写不上、组合页标「无曲线」），用包内完整预设恢复。
     只检查「预设里非私有顶层键是否齐全」，用户改过且保存完整的同名策略不受影响。 */
  function presetComplete(p, ref) {
    if (!p || typeof p !== "object") return false;
    if (!Array.isArray(p.codes) || !p.codes.length) return false;
    if (!("factors" in p) || !("mode" in p)) return false;
    var ks = Object.keys(ref || {}), i;
    for (i = 0; i < ks.length; i++) {
      if (ks[i].charAt(0) === "_") continue;
      if (!(ks[i] in p)) return false;
    }
    return true;
  }

  function sysKey(sys, what) {
    if (sys === "cb") return what === "st" ? KEYS.ST_CB : what === "combo" ? KEYS.COMBO_CB : what === "asof" ? KEYS.ASOF_CB : KEYS.HEALTH_CB;
    return what === "st" ? KEYS.ST_ETF : what === "combo" ? KEYS.COMBO_ETF : what === "asof" ? KEYS.ASOF_ETF : KEYS.HEALTH_ETF;
  }

  /* 系统页写入当前行情末日。统一以「本页行情对象的真实末日」为准：
     能读到真值就覆盖写，读不到就不写，兼容策略曲线刷新等旧调用。 */
  function writeAsOf(sys, asof) {
    sys = sys === "cb" ? "cb" : "etf";
    var a = String(asof || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return;
    set(sysKey(sys, "asof"), DateSync.real(sys) || a);
  }
  function readAsOf(sys) { return get(sysKey(sys, "asof")) || ""; }

  /* ============================================================
     统一日期（ETF / 可转债共用同一套参数，v39）
     · 唯一真值 = 当前页面行情对象的日历末日（统一取值优先级）
     · 统一信使 = ASOF_ETF / ASOF_CB 两个键，跨页面传递真值
     · 统一节奏 = TICK 毫秒，四个页面各 start(sys) 一次即可
     · 统一刷新 = paint(sys) 一处改掉顶栏徽标 / 数据止 / 右上角
     不再「只升不降」：能读到真值就覆盖写，读不到就不写、也不显示 "-"，
     因此不会出现「右上角 11-13 / 回测页 10-29」两套日期打架。
     ============================================================ */
  var DateSync = (function () {
    var TICK = (window.WufuHealthCfg && window.WufuHealthCfg.date && window.WufuHealthCfg.date.tick) || 3000;
    var DKEY = { etf: KEYS.ASOF_ETF, cb: KEYS.ASOF_CB };
    /* 结束日期是否跟随最新交易日：可转债跟随（历史习惯），ETF 不跟随（默认区间是 9-30，
       强行抬会改回测结果）。这是唯一允许两套系统不同的配置项，其余全部共用。 */
    var END_FOLLOW = (window.WufuHealthCfg && window.WufuHealthCfg.date && window.WufuHealthCfg.date.endFollow) || { cb: true, etf: false };
    function norm(sys) { return sys === "cb" ? "cb" : "etf"; }
    function dataObj() {
      var d = null;
      try { if (window.WufuUI && window.WufuUI.getData) d = window.WufuUI.getData(); } catch (e) { }
      if (!d) try { d = window.__WUFU_D || window.D || null; } catch (e) { }
      return (d && d.calendar && d.calendar.length) ? d : null;
    }
    function real(sys) { var d = dataObj(); return d ? String(d.calendar[d.calendar.length - 1]).slice(0, 10) : ""; }
    function read(sys) { return get(DKEY[norm(sys)]) || ""; }
    function current(sys) { return real(sys) || read(sys); }
    function publish(sys) {
      sys = norm(sys);
      var a = real(sys);
      if (!a) return read(sys);
      set(DKEY[sys], a);
      return a;
    }
    function followEnd(sys, a) {
      if (!END_FOLLOW[sys] || !a) return;
      var ed = document.getElementById("endDate");
      if (!ed) return;                       // 参数面板懒渲染时跳过，下次 tick 再试
      try {
        /* 不写死基线日期：首次见到输入框时记下当时的值。
           之后只有「仍是首屏值」或「是我们自己写进去的值」才跟随；
           用户手改成别的值就一律尊重，不再抬。 */
        if (ed.__wufuEndBase == null) ed.__wufuEndBase = String(ed.value || "");
        var v = String(ed.value || "");
        var allowed = v === ed.__wufuEndBase || (ed.__wufuEndAuto && v === ed.__wufuEndAuto);
        if (!allowed) return;
        if (v < a) { ed.value = a; ed.__wufuEndAuto = a; }
      } catch (e) { }
    }
    function paint(sys, a) {
      sys = norm(sys);
      a = a || current(sys);
      if (!a) return;                          // 数据没就绪就不动，绝不显示 "-"
      var d = dataObj();
      var bd = document.getElementById("dbDate");
      if (bd) {
        var first = "", old = bd.textContent || "", mm = /(\d{4}-\d{2}-\d{2})/g, r;
        while ((r = mm.exec(old)) !== null) { first = r[1]; break; }
        if (d) first = String(d.calendar[0]);
        bd.textContent = first ? "数据 " + first + " → " + a : "数据 → " + a;
      }
      var line = document.getElementById("qckUpdateLine");
      if (line) {
        var t = line.textContent || "";
        if (/当前数据止/.test(t)) line.textContent = t.replace(/当前数据止\s*\S*/, "当前数据止 " + a);
        else line.textContent = t + " · 当前数据止 " + a;
      }
      followEnd(sys, a);
      var badge = document.getElementById(sys === "cb" ? "asofCb" : "asofEtf");
      if (badge) badge.textContent = a;
      try { var h = (window.__wufuDateHooks || {})[sys]; if (typeof h === "function") h(a); } catch (e) { }
    }
    function tick(sys) { var a = publish(sys); paint(sys, a); }
    function start(sys) {
      sys = norm(sys);
      var S = window.__wufuDateStarted || (window.__wufuDateStarted = {});
      if (S[sys]) return;                     // 幂等：同页多个入口只起一个定时器
      S[sys] = 1;
      tick(sys);
      setInterval(function () { tick(sys); }, TICK);
      ["pageshow", "focus", "storage"].forEach(function (ev) {
        window.addEventListener(ev, function () { tick(sys); });
      });
      try { document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(sys); }); } catch (e) { }
    }
    return { TICK: TICK, END_FOLLOW: END_FOLLOW, real: real, read: read,
             current: current, publish: publish, paint: paint, start: start };
  })();


  /* 策略列表：统一结构，curve 为系统页保存/重算时写入的净值快照 */
  function readStrategies(sys) {
    var m = getJ(sysKey(sys, "st"), {}) || {}, out = [], b = presets(sys), added = 0;
    Object.keys(b).forEach(function (nm) {
      if (!presetComplete(m[nm], b[nm])) { m[nm] = clonePreset(b[nm]); added++; }
    });
    if (added) { try { setJ(sysKey(sys, "st"), m); } catch (e) { } }
    Object.keys(m).forEach(function (name) {
      var p = m[name] || {};
      if (!p || typeof p !== "object") return;
      var mode = p.mode || (p.dca_freq !== undefined ? "dca" : "rotation");
      out.push({
        id: sys + "::" + name,
        sys: sys, name: name, mode: mode,
        savedAt: p._saved_at || "",
        codes: (p.codes || []).slice(0, 6),
        curve: p.curve && p.curve.nav && p.curve.nav.length ? p.curve : null
      });
    });
    return out;
  }
  function allStrategies() { return readStrategies("etf").concat(readStrategies("cb")); }

  function readCombos(sys) { var a = getJ(sysKey(sys, "combo"), []) || []; return Array.isArray(a) ? a : []; }
  function readHubCombos() { var a = getJ(KEYS.HUB_COMBOS, []) || []; return Array.isArray(a) ? a : []; }
  function saveHubCombos(a) { setJ(KEYS.HUB_COMBOS, a); }

  /* 体检摘要：容错解析两套系统各自写入的 last 记录 */
  function healthSummary(sys) {
    var r = getJ(sysKey(sys, "health"), null);
    if (!r || typeof r !== "object") return { empty: true };
    var s = { empty: false };
    ["time", "ts", "date", "asof", "dataAsOf", "end", "last"].forEach(function (k) {
      if (r[k] && !s.time) s.time = String(r[k]);
    });
    var oks = r.ok || r.okCount || r.pass || r.passed || r.ok_cnt;
    var bad = r.bad || r.badCount || r.fail || r.hits || r.bad_cnt;
    if (oks != null) s.ok = oks;
    if (bad != null) s.bad = bad;
    var keys = Object.keys(r);
    s.text = r.summary || r.text || r.note || (keys.length ? "已记录 " + keys.length + " 项体检字段" : "已记录");
    return s;
  }

  /* 首页「请求全部检查」写标记；体检页打开时消费并自动点「开始体检」 */
  function requestCheck(sys) {
    var q = getJ(KEYS.CHECK_REQ, {}) || {};
    q[sys] = Date.now();
    setJ(KEYS.CHECK_REQ, q);
  }
  function consumeCheck(sys) {
    var q = getJ(KEYS.CHECK_REQ, {}) || {};
    var hit = !!q[sys];
    if (hit) { delete q[sys]; setJ(KEYS.CHECK_REQ, q); }
    return hit;
  }
  function pendingCheck(sys) { var q = getJ(KEYS.CHECK_REQ, {}) || {}; return !!q[sys]; }

  function fmtDate(s) {
    if (!s) return "—";
    var t = String(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    if (/^\d{8}$/.test(t)) return t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8);
    var d = new Date(t);
    return isNaN(d.getTime()) ? t.slice(0, 16) : d.toISOString().slice(0, 10);
  }
  function shortMode(m) {
    return m === "dca" ? "定投" : m === "rebalance" || m === "reb" ? "再平衡" : "轮动";
  }

  /* 统一补齐：任一页面加载本文件即补两套系统的内置策略条目（幂等）；
     同名记录若为空壳 / 缺字段则自动恢复，避免旧存档把内置策略卡成「回测失败」。
     首页 / 体检中心 / 组合页 / 系统页任一入口都能看到全部内置策略。 */
  try { readStrategies("etf"); readStrategies("cb"); } catch (e) { }

  return {
    KEYS: KEYS, get: get, set: set, getJ: getJ, setJ: setJ, sysKey: sysKey,
    writeAsOf: writeAsOf, readAsOf: readAsOf, DateSync: DateSync,
    presets: presets, readStrategies: readStrategies, allStrategies: allStrategies,
    readCombos: readCombos, readHubCombos: readHubCombos, saveHubCombos: saveHubCombos,
    healthSummary: healthSummary, requestCheck: requestCheck,
    consumeCheck: consumeCheck, pendingCheck: pendingCheck,
    fmtDate: fmtDate, shortMode: shortMode
  };
})();
