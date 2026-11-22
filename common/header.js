/* ============================================================
   header.js — 全站统一顶栏组件 + Service Worker 注册入口
   用法：<script src="../common/header.js" data-t1="数据" data-t2="体检中心"
              data-badge="asof" data-page="health" data-export="1"></script>
   data-badge: none | data | asof     data-home: none（首页不显示返回按钮）
   data-export: 1（在返回首页按钮右侧显示「导出整站离线包」，缓存就绪后可见）
   data-render="none"：只注册 SW，不渲染顶栏（纯 iframe 壳页）
   根路径由本文件 URL 自动推算，支持部署在站点子目录下。
   ============================================================ */
(function () {
  "use strict";
  var s = document.currentScript;
  if (!s) return;
  var d = s.dataset || {};
  var m = new URL(s.src, location.href).pathname.match(/^(.*)\/common\/header\.js$/i);
  var rootPath = m ? m[1] + "/" : "/";
  var rootURL = new URL(rootPath, location.href).href;   // 带尾斜杠的站点根
  var CACHE = "wufu-all-v0.91";

  var inFrame = (function () { try { return window.top !== window; } catch (e) { return false; } })();
  var healthMode = /[?&]view=health(?:[&#]|$)/.test(location.search);

  /* ---------- 1. 顶栏 DOM（唯一来源） ---------- */
  if (d.render !== "none" && !healthMode && !inFrame) {
    var title = "<h1>" + (d.t1 || "") + (d.t2 ? '<span class="fu">' + d.t2 + "</span>" : "") + "</h1>";
    var badge = "";
    if (d.badge === "asof") {
      badge = '<div class="wh-badge" title="数据截止日期"><span>ETF 数据 <b id="asofEtf">—</b></span><span>转债数据 <b id="asofCb">—</b></span></div>';
    } else if (d.badge === "data") {
      badge = '<div class="wh-badge" id="dataBadge" title="内置数据截止日期"><span class="db-date" id="dbDate">数据 —</span></div>';
    }
    var home = d.home === "none" ? "" :
      '<a class="wh-home" href="' + (d.homeUrl || rootURL + "index.html") + '">← 返回首页</a>';
    /* 导出按钮与返回按钮同一行、位于其右侧；沿用 .wh-home 样式，只在预缓存就绪后显示 */
    var exp = d.export === "1" ?
      '<span class="wh-export" id="exportBox" style="display:none">' +
        '<button id="btnExport" class="wh-home" type="button">导出整站离线包</button>' +
        WufuTheme.sub('<span id="exportMsg" class="mut" style="color:§WFT0003§"></span>') +
      '</span>' : "";
    /* 数据日期回到标题右侧；返回按钮仍独占第二行，渐变与按钮样式不动 */
    var row = (home || exp) ? '<div class="wh-row">' + home + exp + "</div>" : "";
    var html = '<div class="wh" id="whHeader"><div class="wh-top">' + title +
      badge + '<span class="wh-slot" id="whUpdateSlot"></span></div>' + row + "</div>";
    s.insertAdjacentHTML("beforebegin", html);
  }

  /* ---------- 2. 预缓存状态（首页显示「可离线」，体检中心显示导出按钮） ---------- */
  /* 关键资源齐备即算可离线：各页面 + 两个主数据 gz + 统一指数。
     成交量增量 gz 偶尔因托管平台传输行为没装上，不影响回测主数据。 */
  var KEY = [
    "index.html", "etf/index.html", "cb/index.html", "health/index.html", "combos/index.html",
    "common/header.css", "common/header.js", "common/hub-core.js",
    "etf/data/etf-data.gz", "cb/data/cb-data.gz", "common/index.gz"
  ];
  function readyCheck() {
    if (!("caches" in window)) return Promise.resolve(false);
    return caches.open(CACHE).then(function (c) {
      return Promise.all(KEY.map(function (p) {
        return c.match(new URL(p, rootURL).href, { ignoreVary: true });
      }));
    }).then(function (rs) { return rs.every(Boolean); }).catch(function () { return false; });
  }
  /* 按六个大 gz 是否齐备判断，而不是数缓存条数：
     看板页停留期间就把回测所需的重文件后台备齐，点页签时只剩解压建表。 */
  function allCached() {
    if (!("caches" in window)) return Promise.resolve(false);
    return caches.open(CACHE).then(function (c) {
      return Promise.all(BIG.map(function (p) {
        return c.match(new URL(p, rootURL).href, { ignoreVary: true });
      }));
    }).then(function (rs) { return rs.every(Boolean); }).catch(function () { return false; });
  }
  function poll(cb, n) {
    readyCheck().then(function (ok) {
      if (ok) { cb(true); return; }
      if (n > 0) setTimeout(function () { poll(cb, n - 1); }, 2000); else cb(false);
    });
  }
  window.WufuHeader = {
    root: rootURL, cache: CACHE,
    cacheReady: new Promise(function (res) { poll(res, 90); })
  };

  /* 大 gz 不放在 SW install 里（浏览器给 install 的时长有限，28 MB 容易被掐断）。
     页面侧后台串行预取并直接写 Cache Storage：不受 SW 生命周期限制，
     也兼容服务器给 .gz 自动加 Content-Encoding 的情况。 */
  var BIG = [
    "etf/data/etf-data.gz", "etf/data/etf-data-vol.gz", "etf/data/etf-index.gz",
    "cb/data/cb-data.gz", "cb/data/cb-vol.gz", "common/index.gz"
  ];
  function putOne(url, c) {
    /* 带 __swcache 走纯网络，由本函数独占写入，避免与 SW 运行时缓存竞争；
       整块读进内存再 put，比 stream Response 在各类 WebView 里更可靠。 */
    return fetch(url + "?__swcache=1").then(function (r) {
      if (!r || !r.ok) return false;
      var h = new Headers(r.headers);
      h.delete("content-encoding"); h.delete("content-length");
      return r.arrayBuffer().then(function (buf) {
        return c.put(url, new Response(buf, { status: 200, headers: h }))
          .then(function () { return true; }, function () { return false; });
      }).catch(function () { return false; });
    }).catch(function () { return false; });
  }
  function prefetchBig() {
    if (!("caches" in window)) return Promise.resolve();
    return caches.open(CACHE).then(function (c) {
      return BIG.reduce(function (chain, p) {
        return chain.then(function () {
          var url = new URL(p, rootURL).href;
          return c.match(url).then(function (hit) {
            if (hit) return true;
            return putOne(url, c).then(function (ok) { return ok ? true : putOne(url, c); });
          });
        });
      }, Promise.resolve());
    }).catch(function () { });
  }
  /* 开页即检查，未齐就后台补全两轮；cacheReady 的轮询负责显示提示 */
  allCached().then(function (done) {
    if (done || inFrame) return;
    prefetchBig().then(function () { return prefetchBig(); });
  });
  window.WufuHeader.cacheReady.then(function (ok) {
    if (!ok) return;
    if (d.page === "home") {
      var el = document.getElementById("offlineNote");
      if (el) el.style.display = "block";
    }
    if (d.export === "1") {
      var box = document.getElementById("exportBox");
      if (box) box.style.display = "inline-flex";
    }
  });

  /* ---------- 3. 全站 Service Worker（仅顶层页注册一次） ---------- */
  if (inFrame || !("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    /* 退役旧版 /etf/ 作用域 SW，避免它与全站 SW 抢控制权 */
    navigator.serviceWorker.getRegistrations().then(function (rs) {
      rs.forEach(function (r) {
        try { if (new URL(r.scope).pathname !== new URL(rootURL).pathname) r.unregister(); } catch (e) { }
      });
    }).catch(function () { });

    navigator.serviceWorker.register(rootURL + "sw.js", { scope: rootURL }).then(function (reg) {
      function showUpdate() {
        var slot = document.getElementById("whUpdateSlot");
        if (!slot || slot.childNodes.length) return;
        var b = document.createElement("span");
        b.className = "wh-update";
        b.textContent = "检测到新版本 · 点击刷新";
        b.onclick = function () { location.reload(); };
        slot.appendChild(b);
      }
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdate();
        });
      });
    }).catch(function () { });
  } catch (e) { }
})();
