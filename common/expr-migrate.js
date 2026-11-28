/* ============================================================
   common/expr-migrate.js — 自定义公式迁移（单一真源）
   v0.9913：涨幅族合并为 ROC（旧中文别名 → ROC）
   v0.9914：取消省略模式。所有窗口函数一律显式写「序列 + 窗口」两参数，
            MA(20) → MA(后复权收盘价,20)、ROC(20) → ROC(后复权收盘价,20)。
   · 标识符级精确匹配：长中文词（如「近两月涨幅均值」）不误伤
   · 幂等：已写全的公式再次执行零变化
   · 组合页 wufu_combos_v1 用独立规则：只补参数、不改中文函数名，
     因为那里「净值涨幅」作用于策略净值序列、且经 crTranslateExpr 翻译。
   ============================================================ */
(function () {
  var IDCH = /[\u4e00-\u9fffA-Za-z0-9_\u00b2]/;
  var CLOSE = '\u540e\u590d\u6743\u6536\u76d8\u4ef7';   // 后复权收盘价
  var NAV = '\u5355\u4f4d\u51c0\u503c';                 // 单位净值
  var STORES = ["wufu_strategies_v1", "wufu_cb_strategies_v1", "wufu_factor_lib_v1"];
  var COMBO_KEY = "wufu_combos_v1";

  // 旧名/单参数名 → [新函数名, 序列, 默认N, 是否三参数]
  var MAP = {
    'ROC': ['ROC', CLOSE, '20', 0], '\u6da8\u5e45': ['ROC', CLOSE, '20', 0],
    '\u53d8\u52a8\u7387': ['ROC', CLOSE, '20', 0], '\u6da8\u5e45\u52a8\u91cf': ['ROC', CLOSE, '20', 0],
    '\u51c0\u503c\u6da8\u5e45': ['ROC', NAV, '20', 0], 'NAV_ROC': ['ROC', NAV, '20', 0],
    'MA': ['MA', CLOSE, '20', 0], '\u5747\u7ebf': ['MA', CLOSE, '20', 0], 'N\u65e5\u5747\u7ebf': ['MA', CLOSE, '20', 0],
    'EMA': ['EMA', CLOSE, '20', 0], '\u6307\u6570\u79fb\u52a8\u5e73\u5747': ['EMA', CLOSE, '20', 0],
    'SMA': ['SMA', CLOSE, '10', 1], '\u5e73\u6ed1\u5747\u7ebf': ['SMA', CLOSE, '10', 1],
    'WMA': ['WMA', CLOSE, '20', 0], '\u52a0\u6743\u5747\u7ebf': ['WMA', CLOSE, '20', 0],
    'DMA': ['DMA', CLOSE, '10', 0], '\u52a8\u6001\u5747\u7ebf': ['DMA', CLOSE, '10', 0],
    'SUM': ['SUM', CLOSE, '20', 0], '\u6c42\u548c': ['SUM', CLOSE, '20', 0],
    'PRODUCT': ['PRODUCT', CLOSE, '20', 0], '\u4e58\u79ef': ['PRODUCT', CLOSE, '20', 0],
    'MAX': ['MAX', CLOSE, '20', 0], '\u6700\u5927\u503c': ['MAX', CLOSE, '20', 0],
    'MIN': ['MIN', CLOSE, '20', 0], '\u6700\u5c0f\u503c': ['MIN', CLOSE, '20', 0],
    'STD': ['STD', CLOSE, '20', 0], '\u6807\u51c6\u5dee': ['STD', CLOSE, '20', 0],
    'VOL': ['VOL', CLOSE, '20', 0], '\u6536\u76ca\u6ce2\u52a8\u7387': ['VOL', CLOSE, '20', 0],
    'BIAS': ['BIAS', CLOSE, '20', 0], '\u4e56\u79bb\u7387': ['BIAS', CLOSE, '20', 0]
  };
  // 组合页专用：保留中文函数名，补「后复权收盘价」（引擎口径），绝不改函数名
  var COMBO_MAP = {
    '\u51c0\u503c\u6da8\u5e45': '\u51c0\u503c\u6da8\u5e45',
    '\u6536\u76ca\u6ce2\u52a8\u7387': '\u6536\u76ca\u6ce2\u52a8\u7387',
    '\u4e56\u79bb\u7387': '\u4e56\u79bb\u7387',
    'ROC': 'ROC', 'MA': 'MA', 'VOL': 'VOL', 'BIAS': 'BIAS'
  };

  function scanCall(src, i, j) {
    var k = j, n = src.length;
    while (k < n && /\s/.test(src.charAt(k))) k++;
    if (src.charAt(k) !== '(') return null;
    var depth = 1, p = k + 1;
    while (p < n && depth > 0) {
      var c = src.charAt(p);
      if (c === '(') depth++; else if (c === ')') depth--;
      p++;
    }
    if (depth !== 0) return null;
    return { args: src.slice(k + 1, p - 1), end: p };
  }
  function isNum(s) { return /^\s*\d+(?:\.\d+)?\s*$/.test(s); }
  function trim(s) { return s.replace(/^\s+|\s+$/g, ''); }

  // 通用迁移（策略库 / 因子库）
  function migrateExpr(src) {
    if (typeof src !== 'string' || !src) return src;
    var out = '', i = 0, n = src.length;
    while (i < n) {
      var ch = src.charAt(i);
      if (!IDCH.test(ch)) { out += ch; i++; continue; }
      var j = i;
      while (j < n && IDCH.test(src.charAt(j))) j++;
      var tok = src.slice(i, j), m = MAP[tok], call = m ? scanCall(src, i, j) : null;
      if (m && !call) {                                   // 裸字段写法（仅涨幅族补成函数）
        if (m[0] === 'ROC') { out += 'ROC(' + m[1] + ',' + m[2] + ')'; i = j; continue; }
        out += tok; i = j; continue;
      }
      if (m && call) {
        var ps = call.args.split(',').map(trim), N, rep;
        if (ps.length === 1 && (ps[0] === '' || isNum(ps[0]))) {
          N = ps[0] === '' ? m[2] : trim(ps[0]);
          rep = m[0] + '(' + m[1] + ',' + N + (m[3] ? ',1' : '') + ')';
        } else if (ps.length >= 2 && tok !== 'ROC' && m[0] === 'ROC') {
          // 旧中文别名 / NAV_ROC 的两参数形式 → 统一 ROC，但保留原序列（单位净值必须保住）
          var seq = ps[0];
          if (seq === '' || isNum(seq)) seq = m[1];
          N = isNum(ps[ps.length - 1]) ? ps[ps.length - 1] : m[2];
          rep = 'ROC(' + seq + ',' + N + ')';
        } else if (m[3] && ps.length === 2) {
          // SMA(X,N) 缺 M → 补显式 1（旧版默认值）
          rep = 'SMA(' + ps[0] + ',' + ps[1] + ',1)';
        } else {
          rep = null;                                     // 已写全，原样保留（幂等）
        }
        if (rep !== null) { out += rep; i = call.end; continue; }
      }
      out += tok; i = j;
    }
    return out;
  }

  // 组合页专用：只把「函数名(数字)」补成「函数名(后复权收盘价,数字)」
  function migrateComboExpr(src) {
    if (typeof src !== 'string' || !src) return src;
    var out = '', i = 0, n = src.length;
    while (i < n) {
      var ch = src.charAt(i);
      if (!IDCH.test(ch)) { out += ch; i++; continue; }
      var j = i;
      while (j < n && IDCH.test(src.charAt(j))) j++;
      var tok = src.slice(i, j), keep = COMBO_MAP[tok];
      var call = keep ? scanCall(src, i, j) : null;
      if (keep && call) {
        var ps = call.args.split(',').map(trim);
        if (ps.length === 1 && (ps[0] === '' || isNum(ps[0]))) {
          out += keep + '(' + CLOSE + ',' + (ps[0] === '' ? '20' : trim(ps[0])) + ')';
          i = call.end; continue;
        }
      }
      out += tok; i = j;
    }
    return out;
  }

  // 只迁移公式字段，避免误改策略名/备注等普通字符串
  function migrateAny(v, key, fn) {
    fn = fn || migrateExpr;
    if (typeof v === 'string') return (key === 'expr' || key === 'formula') ? fn(v) : v;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (var i = 0; i < v.length; i++) v[i] = migrateAny(v[i], key, fn);
      return v;
    }
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) { v[k] = migrateAny(v[k], k, fn); });
      return v;
    }
    return v;
  }

  function migrateStore(keys) {
    var total = 0;
    var all = (keys || STORES).slice();
    // 组合存档无论调用方传了哪些键，都必须按专用规则补齐参数（否则老公式在新版会编译报错）
    if (all.indexOf(COMBO_KEY) < 0) all.push(COMBO_KEY);
    all.forEach(function (key) {
      var raw;
      try { raw = window.localStorage.getItem(key); } catch (e) { return; }
      if (!raw) return;
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      var before = JSON.stringify(obj);
      migrateAny(obj, null, key === COMBO_KEY ? migrateComboExpr : migrateExpr);
      var after = JSON.stringify(obj);
      if (after !== before) {
        try { window.localStorage.setItem(key, after); total++; } catch (e) {}
      }
    });
    return total;
  }

  window.WufuExprMigrate = {
    migrateExpr: migrateExpr, migrateComboExpr: migrateComboExpr,
    migrateAny: migrateAny, migrateStore: migrateStore,
    STORES: STORES, COMBO_KEY: COMBO_KEY, MAP: MAP, COMBO_MAP: COMBO_MAP
  };
})();
