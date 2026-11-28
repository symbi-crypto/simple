/* ============================================================
   common/expr-migrate.js — 自定义公式「涨幅族」自动迁移（单一真源）
   · 旧写法：涨幅 / 净值涨幅 / 变动率 / 涨幅动量；新写法：统一 ROC(X,N)
   · 标识符级精确匹配：长中文词（如「近两月涨幅均值」）不会被误伤
   · 幂等：迁移结果里不再含旧 token，重复执行零变化
   · 组合页 wufu_combos_v1 的「净值涨幅」作用于策略净值序列，属独立语义，
     明确排除，绝不迁移。
   ============================================================ */
(function () {
  var IDCH = /[\u4e00-\u9fffA-Za-z0-9_\u00b2]/;
  var STORES = ["wufu_strategies_v1", "wufu_cb_strategies_v1", "wufu_factor_lib_v1"];
  var COMBO_EXCLUDED = "wufu_combos_v1";

  function migrateExpr(src) {
    if (typeof src !== 'string' || !src) return src;
    if (!/\u6da8\u5e45|\u53d8\u52a8\u7387/.test(src)) return src; // 涨幅|变动率
    var out = '', i = 0, n = src.length;
    while (i < n) {
      var ch = src.charAt(i);
      if (!IDCH.test(ch)) { out += ch; i++; continue; }
      var j = i;
      while (j < n && IDCH.test(src.charAt(j))) j++;
      var tok = src.slice(i, j);
      var k = j, args = null, consumed = j;
      while (k < n && /\s/.test(src.charAt(k))) k++;
      if (src.charAt(k) === '(') {
        var depth = 1, p = k + 1;
        while (p < n && depth > 0) {
          var pc = src.charAt(p);
          if (pc === '(') depth++; else if (pc === ')') depth--;
          p++;
        }
        if (depth === 0) { args = src.slice(k + 1, p - 1); consumed = p; }
      }
      var rep = null;
      if (tok === '\u51c0\u503c\u6da8\u5e45') {                 // 净值涨幅
        var N = '20';
        if (args !== null) {
          var ps = args.split(','), last = ps[ps.length - 1].replace(/^\s+|\s+$/g, '');
          if (last !== '') N = last;
        }
        rep = 'ROC(\u5355\u4f4d\u51c0\u503c,' + N + ')';       // ROC(单位净值,N)
      } else if (tok === '\u6da8\u5e45' || tok === '\u53d8\u52a8\u7387' || tok === '\u6da8\u5e45\u52a8\u91cf') {
        rep = (args !== null) ? ('ROC(' + args.replace(/^\s+|\s+$/g, '') + ')') : 'ROC(20)';
      }
      if (rep !== null) { out += rep; i = consumed; }
      else { out += tok; i = j; }
    }
    return out;
  }

  // 只迁移公式字段，避免误改策略名/备注等普通字符串
  function migrateAny(v, key) {
    if (typeof v === 'string') return (key === 'expr' || key === 'formula') ? migrateExpr(v) : v;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (var i = 0; i < v.length; i++) v[i] = migrateAny(v[i], key);
      return v;
    }
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) { v[k] = migrateAny(v[k], k); });
      return v;
    }
    return v;
  }

  // 读存档 → 就地迁移 → 有变化才写回；返回被改写的存储键数量
  function migrateStore(keys) {
    var total = 0;
    (keys || STORES).forEach(function (key) {
      if (key === COMBO_EXCLUDED) return;                       // 组合页存档绝不迁移
      var raw;
      try { raw = window.localStorage.getItem(key); } catch (e) { return; }
      if (!raw) return;
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      var before = JSON.stringify(obj);
      migrateAny(obj);
      var after = JSON.stringify(obj);
      if (after !== before) {
        try { window.localStorage.setItem(key, after); total++; } catch (e) {}
      }
    });
    return total;
  }

  window.WufuExprMigrate = {
    migrateExpr: migrateExpr, migrateAny: migrateAny, migrateStore: migrateStore,
    STORES: STORES, COMBO_EXCLUDED: COMBO_EXCLUDED
  };
})();
