/* 退役占位：全站预缓存已由根目录 /sw.js 统一负责（scope = 站点根）。
   老访客浏览器里若仍装着这份 /etf/ 作用域 SW，页面侧 header.js 会注销它；
   本文件被浏览器重新拉取时也会自行注销，避免两套 SW 抢控制权。 */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(self.registration.unregister());
});
