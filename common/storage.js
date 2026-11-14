
/* ===== 安全存储层 v46 · 大仓库 =====
   1) 小键照旧走 localStorage（同步、可靠）；
   2) 大键（行情增量 / 修复包 / 撤销快照）改存 IndexedDB「大仓库」，容量远大于 5MB；
   3) 同步读写靠内存镜像 + localStorage 压缩兜底，页面刷新后靠启动时预加载恢复；
   4) WufuStore.flush() 等待大键真正落盘，一键更新必须等它成功才报「已存入」；
   5) 写失败仍抛回业务层弹红字，绝不把「没存住」说成「已生效」；
   6) 老版本留在本机的大值，打开页面时自动搬进大仓库，顺手腾出空间。 */
(function () {
  "use strict";
  var mem = {}, ok = false, ls = null;
  try {
    ls = window.localStorage;
    if (ls) {
      /* 探测写失败多半是「小本本已写满」，不是被禁用。
         此时仍保留原生引用：removeItem 不需要配额，迁移照样能腾出空间。 */
      try { var t = "__t__" + Date.now(); ls.setItem(t, "1"); ls.removeItem(t); ok = true; }
      catch (e) { ok = false; }
    }
  } catch (e) { ok = false; ls = null; }

  var PREFIX = "\u0001WZ1:";   /* 压缩标记 */
  var VMARK  = "\u0002WV1:";   /* 大仓库标记，值极短 */

  /* ---- 轻量可逆压缩：把 patch JSON 里反复出现的字段名换成 1 个私用区字符 ---- */
  var DICT = [
    '"raw_close":', '"excludedCodes":', '"corrections":', '"newSeries":',
    '"turnover":', '"premium":', '"resupply":', '"ohlcFix":', '"segments":',
    '"volume":', '"amount":', '"points":', '"source":', '"series":',
    '"report":', '"custom":', '"hidden":', '"close":', '"high":',
    '"open":', '"index":', '"date":', '"base":', '"scale":', '"asof":',
    '"days":', '"st":', '"ann":', '"ts":', '"nav":', '"low":',
    '"fix":', '"log":', '"p":', '"v":', '"c":'
  ];
  var TOK = [], qi;
  for (qi = 0; qi < DICT.length; qi++) TOK.push(String.fromCharCode(0xE000 + qi));
  var LZ = {
    compress: function (s) {
      s = String(s);
      if (/[\uE000-\uE0FF]/.test(s)) return null;
      var out = s, j;
      for (j = 0; j < DICT.length; j++) out = out.split(DICT[j]).join(TOK[j]);
      return out;
    },
    decompress: function (s) {
      var out = String(s), j;
      for (j = 0; j < DICT.length; j++) out = out.split(TOK[j]).join(DICT[j]);
      return out;
    }
  };

  function decode(v) {
    if (typeof v === "string" && v.indexOf(PREFIX) === 0) {
      try { var d = LZ.decompress(v.slice(PREFIX.length)); return d == null ? v : d; }
      catch (e) { return v; }
    }
    return v;
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* 原生写：成功即把 ok 恢复（空间腾出来后小键自动重新可用） */
  function nativeSet(k, v) {
    if (!ls) return false;
    try { ls.setItem(k, String(v)); ok = true; return true; } catch (e) { return false; }
  }
  function rawSet(k, v) {
    if (ls) {
      /* 小本本存在但写不下：必须把错误抛回上层，绝不静默改成内存（否则又成假成功） */
      ls.setItem(k, String(v));
      ok = true; delete mem[k]; return;
    }
    mem[k] = String(v);   /* 完全禁用 localStorage 时才退内存 */
  }
  function rawGet(k) {
    if (hasOwn(mem, k)) return mem[k];   /* 内存里的永远是最新值 */
    if (ls) { try { var v = ls.getItem(k); if (v != null) return v; } catch (e) { } }
    return null;
  }

  /* ================= 大仓库（IndexedDB） ================= */
  var DBNAME = "wufu_vault_v1", STORE = "kv";
  var db = null, vaultOK = false, vaultReady = false;
  var cache = {};          /* 同步镜像：保证 getItem 仍是同步的 */
  var pending = [];        /* 已发起的写事务，供 flush() 等待 */
  var BIG_RE = /(QPatch|QUndo|qck_snap|qck_fix|_fc_|Snap_v|Patch_v)/i;
  var BIG_LEN = 48 * 1024;

  function isBig(k, s) { return BIG_RE.test(k) || String(s).length > BIG_LEN; }
  function useVault(k, s) { return vaultOK && isBig(k, s); }

  function tx(mode, fn) {
    return new Promise(function (res) {
      if (!db) { res(false); return; }
      try {
        var t = db.transaction(STORE, mode), st = t.objectStore(STORE), out;
        t.oncomplete = function () { res(out === undefined ? true : out); };
        t.onerror = function () { res(false); };
        t.onabort = function () { res(false); };
        out = fn(st);
      } catch (e) { res(false); }
    });
  }
  function idbPut(k, v) {
    return tx("readwrite", function (st) { st.put({ k: k, v: v }); })
      .then(function (r) {
        if (r === false) { try { window.__WUFU_SAVE_FAIL = true; } catch (e) { } }
        return r;
      });
  }
  function idbDel(k) { return tx("readwrite", function (st) { st.delete(k); }); }
  function idbClear() { return tx("readwrite", function (st) { st.clear(); }); }
  function idbGetAll() {
    return new Promise(function (res) {
      if (!db) { res([]); return; }
      try {
        var t = db.transaction(STORE, "readonly"), r = t.objectStore(STORE).getAll(), arr = [];
        r.onsuccess = function () { arr = r.result || []; };
        t.oncomplete = function () { res(arr); };
        t.onerror = function () { res([]); };
        t.onabort = function () { res([]); };
      } catch (e) { res([]); }
    });
  }

  var PRUNE_RE = /(Undo|qck_snap|qck_fix|_fc_log|QSnap|QFix|Snap_v)/i;
  /* 只清 localStorage 里的可丢弃项，绝不碰大仓库里的数据 */
  function prune() {
    var freed = 0, keys = [];
    try {
      if (ls) for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k && PRUNE_RE.test(k)) keys.push(k); }
      for (var j = 0; j < Object.keys(mem).length; j++) { var mk = Object.keys(mem)[j]; if (PRUNE_RE.test(mk)) keys.push(mk); }
    } catch (e) { }
    keys.forEach(function (k) {
      try { var v = rawGet(k); freed += (v ? v.length : 0) * 2; } catch (e) { }
      try { if (ls) ls.removeItem(k); } catch (e) { }
      delete mem[k];
    });
    return freed;
  }

  /* 大键写入后，localStorage 只尽力留一份压缩兜底；放不下就换成极短标记，顺手腾空间 */
  function keepFallback(k, s) {
    if (!ls) return;
    try {
      var c = LZ.compress(s);
      if (c != null && nativeSet(k, PREFIX + c)) return;
    } catch (e) { }
    try { prune(); } catch (e) { }
    try {
      var c2 = LZ.compress(s);
      if (c2 != null && nativeSet(k, PREFIX + c2)) return;
    } catch (e) { }
    if (nativeSet(k, VMARK + k)) return;
    /* 连几十字节都放不下：把旧的大值直接删掉，空间当场腾出来 */
    try { ls.removeItem(k); } catch (e2) { }
  }

  function migrate() {
    if (!ls || !db) return;
    var moves = [];
    try {
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i); if (!k) continue;
        var v = ls.getItem(k);
        if (!v || String(v).indexOf(VMARK) === 0) continue;
        var real = decode(v);
        if (isBig(k, real) && !hasOwn(cache, k)) moves.push([k, real]);
      }
    } catch (e) { }
    if (!moves.length) return;
    var q = Promise.resolve(true);
    moves.forEach(function (p) { q = q.then(function () { return idbPut(p[0], p[1]); }); });
    q.then(function () {
      moves.forEach(function (p) {
        cache[p[0]] = p[1];
        /* 老的大值直接换成极短标记，5MB 小本本立刻腾出来 */
        if (!nativeSet(p[0], VMARK + p[0])) {
          try { ls.removeItem(p[0]); } catch (e2) { }
        }
      });
    });
  }

  function boot() {
    var IDB = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB;
    if (!IDB) { vaultReady = true; return; }
    var req;
    try { req = IDB.open(DBNAME, 1); } catch (e) { vaultReady = true; return; }
    req.onupgradeneeded = function (e) {
      try {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "k" });
      } catch (e2) { }
    };
    req.onerror = function () { vaultReady = true; };
    req.onblocked = function () { };
    req.onsuccess = function () {
      try { db = req.result; } catch (e) { vaultReady = true; return; }
      try {
        db.onversionchange = function () { try { db.close(); } catch (e) { } db = null; vaultOK = false; };
      } catch (e) { }
      idbGetAll().then(function (arr) {
        (arr || []).forEach(function (o) { if (o && o.k && typeof o.v === "string") cache[o.k] = o.v; });
        vaultOK = true;
        try { migrate(); } catch (e) { }
        vaultReady = true;
        try { window.dispatchEvent(new Event("wufu:vault-ready")); } catch (e) { }
      });
    };
  }

  function flush() {
    var q = pending.slice(); pending = [];
    if (!q.length) return Promise.resolve({ ok: true, count: 0, error: "" });
    return Promise.all(q).then(function (rs) {
      var good = rs.every(function (x) { return x !== false; });
      return { ok: good, count: rs.length,
               error: good ? "" : "大仓库写入失败（浏览器存储被禁用或空间不足）" };
    }).catch(function (e) { return { ok: false, count: q.length, error: String(e) }; });
  }

  /* ================= 对业务层保持同步的 localStorage 接口 ================= */
  function allKeys() {
    var seen = {}, out = [];
    try {
      if (ls) for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i); if (k && !seen[k]) { seen[k] = 1; out.push(k); }
      }
    } catch (e) { }
    Object.keys(mem).forEach(function (k) { if (!seen[k]) { seen[k] = 1; out.push(k); } });
    Object.keys(cache).forEach(function (k) { if (!seen[k]) { seen[k] = 1; out.push(k); } });
    return out;
  }

  var shim = {
    getItem: function (k) {
      if (hasOwn(cache, k)) return cache[k];
      var v = rawGet(k);
      if (v == null) return v;
      if (String(v).indexOf(VMARK) === 0) return null;   /* 真值在大仓库，预加载未赶上时返回空，绝不返回半截 */
      return decode(v);
    },
    setItem: function (k, v) {
      var s = String(v);
      if (useVault(k, s)) {
        cache[k] = s;
        pending.push(idbPut(k, s));
        keepFallback(k, s);
        delete mem[k];
        return;
      }
      delete cache[k];
      try { rawSet(k, s); return; }
      catch (e) {
        try { var c = LZ.compress(s); if (c != null) { rawSet(k, PREFIX + c); return; } }
        catch (e2) { }
        throw e;
      }
    },
    removeItem: function (k) {
      delete cache[k]; delete mem[k];
      if (ls) { try { ls.removeItem(k); } catch (e) { } }
      if (db) pending.push(idbDel(k));
    },
    clear: function () {
      cache = {}; mem = {};
      if (ls) { try { ls.clear(); } catch (e) { } }
      if (db) pending.push(idbClear());
    },
    key: function (i) { return allKeys()[i] || null; },
    get length() { return allKeys().length; },
    __isMemoryShim: !ok
  };
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, get: function () { return shim; } });
  } catch (e) { try { window.localStorage = shim; } catch (e2) { } }

  window.WufuStore = {
    /* 返回 {ok, mode, pending, error, freed}；大键的 pending=true 表示要等 flush() 才算真落盘 */
    put: function (k, v) {
      var s = String(v);
      if (useVault(k, s)) {
        try { shim.setItem(k, s); }
        catch (e) { return { ok: false, mode: "vault-fail", pending: false, error: String(e), freed: 0 }; }
        return { ok: true, mode: "vault", pending: true, error: "", freed: 0 };
      }
      try { shim.setItem(k, s); return { ok: true, mode: "stored", pending: false, error: "", freed: 0 }; }
      catch (e) {
        var freed = prune();
        try { shim.setItem(k, s); return { ok: true, mode: "pruned", pending: false, error: "", freed: freed }; }
        catch (e2) {
          return { ok: false, mode: "failed", pending: false,
                   error: String((e2 && e2.message) || e || "存储不可用"), freed: freed };
        }
      }
    },
    get: function (k) { return shim.getItem(k); },
    /* 一键更新收尾必须 await 这个；返回 {ok,count,error} */
    flush: flush,
    prune: prune,
    vaultOK: function () { return vaultOK; },
    vaultInfo: function () {
      return { ok: vaultOK, ready: vaultReady, db: !!db,
               keys: Object.keys(cache).length, pending: pending.length };
    },
    usage: function () {
      var n = 0, ks = allKeys();
      ks.forEach(function (k) { try { var v = shim.getItem(k); n += (k.length + (v ? v.length : 0)) * 2; } catch (e) { } });
      return n;
    },
    persisted: function (k) {
      if (hasOwn(cache, k)) return vaultOK;
      if (!ls) return false;
      try { return ls.getItem(k) != null; } catch (e) { return false; }
    },
    compress: function (s) { return LZ.compress(s); },
    decompress: function (s) { return LZ.decompress(s); },
    __memoryMode: !ok
  };

  try { boot(); } catch (e) { vaultReady = true; }
})();
