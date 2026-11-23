/* ============================================================
   sw.js — 全站预缓存（scope = 站点根，覆盖首页 / etf / cb / 各工具页）
   首次联网把整包装进 Cache Storage；之后断网也能从首页点进任意一页。
   · 静态资源 cache-first；跨域联网请求（腾讯K线 / 扶摇 / 节假日 CDN / 字体）一律放行
   · .gz 统一去掉 Content-Encoding 头后入库，配合页面已有的 gzip 魔数兜底，
     兼容「服务器自动二次压缩」与「原样返回」两种托管行为
   · 导航请求离线时才回首页；静态资源失败原样抛错，不把 gz 伪装成 HTML
   · 先装小文件再串行装大 gz；单个大文件带超时 + 重试，失败不拖垮整批
   改任何页面或数据文件后请把 CACHE 末段 +1（v0.77 → v0.78）；1.0 之前一律用 v0.x。
   · v0.82：theme.css / theme.js 已入 LIST，随 install 一起预缓存。
   · v0.93：浅色主题（theme.css 双组值 + theme.js 状态机），静态资源随 CACHE 升版重取。
   · v0.84：index-daily.json 纳入日更，dash-source.js 已入 LIST；看板快照优先取 GitHub（跨域请求
     由同源判断直接放行、不进 Cache Storage），拉不到才回退包内副本。
   ============================================================ */
var CACHE = "wufu-all-v0.9904";

var LIST = [
  "index.html", "icon.svg", "manifest.webmanifest", "sw.js", "README.md",
  "common/theme.css", "common/theme.js", "common/header.css", "common/header.js", "common/hub.css", "common/hub-core.js",
  "common/health-config.js", "common/health-common.css",
  "common/storage.js", "common/echarts.min.js", "common/inflate.js",
  "common/index-unify.js", "common/index.gz", "common/holiday-cn.json", "common/icon.svg",
  "common/patch-etf.js", "common/patch-cb.js", "common/combo-system.css", "common/hub-combo.js",
  "common/export.js", "common/dashboard.css", "common/dash-source.js", "common/dashboard.js",
  "common/range.js", "common/gold.js", "common/industry.js", "common/research-gate.js", "common/instrument-rules.js",
  "etf/index.html", "etf/tool.html", "etf/dashboard.html", "etf/gold.html", "etf/manage.html", "etf/icon.svg", "etf/manifest.webmanifest",
  "etf/data/etf-data.gz", "etf/data/etf-data-vol.gz", "etf/data/etf-index.gz", "etf/data/holiday-cn.json",
  "cb/index.html", "cb/tool.html", "cb/dashboard.html", "cb/icon.svg", "cb/manifest.webmanifest",
  "cb/data/cb-data.gz", "cb/data/cb-vol.gz", "cb/data/cb-extra.gz", "cb/data/holiday-cn.json",
  "cb/data/cb-scale-daily.json",
  "combos/index.html", "cb-daily.json", "index-daily.json", "gold-daily.json", "industry-daily.json", "market-amount.json", "us-etf-daily.json",
  "health/index.html", "health/etf/index.html", "health/cb/index.html"
];

function cleanHeaders(h) {
  var n = new Headers(h);
  n.delete("content-encoding");
  n.delete("content-length");
  return n;
}
function cleanResponse(buf, r) {
  return new Response(buf, { status: 200, statusText: "OK", headers: cleanHeaders(r.headers) });
}
function withTimeout(p, ms) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error("timeout")); }, ms);
    p.then(function (v) { clearTimeout(t); res(v); },
           function (e) { clearTimeout(t); rej(e); });
  });
}

function grabOnce(url, c) {
  return withTimeout(
    fetch(new Request(url, { cache: "reload" })).then(function (r) {
      if (!r || !r.ok) return false;
      return r.arrayBuffer().then(function (buf) {
        return c.put(new Request(url), cleanResponse(buf, r)).then(function () { return true; },
                                                                   function () { return false; });
      });
    }).catch(function () { return false; }), 30000
  );
}
function grab(p, c) {
  var url = new URL(p, self.registration.scope).href;
  return grabOnce(url, c).then(function (ok) { return ok ? true : grabOnce(url, c); })
    .catch(function () { return false; });
}

self.addEventListener("install", function (e) {
  e.waitUntil((async function () {
    var c = await caches.open(CACHE);
    /* install 只装小文件：浏览器给 install 事件的总时长有限，串上 28 MB 的
       gz（尤其服务器自动加 Content-Encoding 时会被透明解压成几十 MB）容易超时，
       反拖累整批。大 gz 交给首页后台预取 + fetch 事件里的运行时补缓存。 */
    var small = LIST.filter(function (p) { return !/\.gz$/i.test(p); });
    for (var i = 0; i < small.length; i += 6) {
      await Promise.all(small.slice(i, i + 6).map(function (p) { return grab(p, c); }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var u;
  try { u = new URL(req.url); } catch (err) { return; }
  /* 联网类请求不拦截：腾讯 / 东财 / 扶摇 / jsDelivr / 飞书字体 */
  if (u.origin !== self.location.origin) return;
  /* 页面侧后台预取专用：由页面自己写缓存，SW 不重复 put，避免两份响应抢同一 key */
  if (u.searchParams.has("__swcache")) return;

  e.respondWith((async function () {
    var c = await caches.open(CACHE);
    /* 体检 iframe 走 tool.html?view=health，缓存里存的是无 query 的同一份文件；
       ignoreSearch 让「首次只开首页就断网」也能打开体检页，不必先联网进过一次。 */
    /* 日频剩余规模快照：整包可能只换数据、不升 CACHE 版本，
       必须 network-first，否则 cache-first 会让按钮永远读到旧快照 */
    if (/\/(cb-scale-daily|cb-daily|index-daily|gold-daily|industry-daily|market-amount|us-etf-daily)\.json$/.test(u.pathname)) {
      try {
        var fresh = await fetch(req);
        if (fresh && fresh.ok) {
          try {
            var fb = await fresh.clone().arrayBuffer();
            await c.put(new Request(new URL(u.pathname, u.origin).href), cleanResponse(fb, fresh));
          } catch (e3) { }
          return fresh;
        }
      } catch (e4) { }
      var stale = await c.match(new Request(new URL(u.pathname, u.origin).href), { ignoreVary: true });
      if (stale) return stale;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    /* v0.69d：主文档、看板 HTML 与 common 下看板脚本均 network-first（v0.83 加 dash-source.js）。
       u.pathname 不含 query，所以带 ?v=9904 的请求同样命中本分支并回写无 query 的缓存键。 */
    if (/\/(etf|cb)\/tool\.html$/.test(u.pathname) || /\/(etf|cb)\/(dashboard|gold)\.html$/.test(u.pathname) || /\/combos\/index\.html$/.test(u.pathname) || /\/common\/(range|dashboard|gold|industry|dash-source)\.js$/.test(u.pathname)) {
      try {
        var fresh2 = await fetch(req);
        if (fresh2 && fresh2.ok) {
          try {
            var fb2 = await fresh2.clone().arrayBuffer();
            await c.put(new Request(new URL(u.pathname, u.origin).href), cleanResponse(fb2, fresh2));
          } catch (e5) { }
          return fresh2;
        }
      } catch (e6) { }
    }
    var hit = await c.match(req, { ignoreVary: true, ignoreSearch: true });
    if (hit) return hit;
    try {
      var r = await fetch(req);
      if (r && r.ok) {
        /* 运行时补缓存：install 阶段没装上大文件时，首次进系统页也会补进去。
           键统一去掉 query，避免同一份文件被存成两份。 */
        try {
          var buf = await r.clone().arrayBuffer();
          var key = new Request(new URL(u.pathname, u.origin).href);
          await c.put(key, cleanResponse(buf, r));
        } catch (e2) { }
        return r;
      }
      return r;
    } catch (err) {
      /* 仅导航请求离线时回首页；静态资源 404 原样抛，避免 gz 被伪装成 HTML 引发解压怪错 */
      if (req.mode === "navigate") {
        var home = await c.match(new URL("index.html", self.registration.scope).href, { ignoreVary: true });
        if (home) return home;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
