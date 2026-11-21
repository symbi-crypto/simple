/* ============================================================
   export.js — 导出「整站离线包.zip」（v47）
   数据来源：Cache Storage 里当前版本的全部同域条目（SW 预缓存已装好的整站文件）
            + 本机全量状态快照（策略 / 组合 / 行情增量 / 日历 / 体检 / 标的池…）
            + 离线包专用的启动脚本、状态恢复页、说明。
   零内嵌、零改写 .gz：行情基线文件保持原样，新数据放在 state.json 里；
   页面打开时由 hub-core.js 自动把 state.json 补回本机并重放补丁，
   所以「更新 → 导出 → 上传 → 打开」直接就是最新日期，无需点 restore.html。
   ============================================================ */
(function () {
  "use strict";

  var H = window.WufuHeader || {};
  var ROOT = H.root || new URL("./", location.href).href;

  /* ---------- 极简 ZIP（store 模式，不引外部库） ---------- */
  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function p16(a, v) { a.push(v & 255, (v >>> 8) & 255); }
  function p32(a, v) { a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
  function dos(d) {
    var y = Math.max(1980, d.getFullYear());
    return {
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    };
  }
  function Zip() { this.parts = []; this.entries = []; this.offset = 0; }
  Zip.prototype.add = function (name, data) {
    var nb = new TextEncoder().encode(name);
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var crc = crc32(bytes), t = dos(new Date());
    var lh = [];
    p32(lh, 0x04034b50); p16(lh, 20); p16(lh, 0x0800); p16(lh, 0);
    p16(lh, t.time); p16(lh, t.date);
    p32(lh, crc); p32(lh, bytes.length); p32(lh, bytes.length);
    p16(lh, nb.length); p16(lh, 0);
    var head = new Uint8Array(lh.concat(Array.from(nb)));
    this.parts.push(head, bytes);
    this.entries.push({ nb: nb, crc: crc, len: bytes.length, off: this.offset, t: t });
    this.offset += head.length + bytes.length;
  };
  Zip.prototype.blob = function () {
    var parts = this.parts, cdStart = this.offset, cdSize = 0, self = this;
    this.entries.forEach(function (e) {
      var c = [];
      p32(c, 0x02014b50); p16(c, 20); p16(c, 20); p16(c, 0x0800); p16(c, 0);
      p16(c, e.t.time); p16(c, e.t.date);
      p32(c, e.crc); p32(c, e.len); p32(c, e.len);
      p16(c, e.nb.length); p16(c, 0); p16(c, 0); p16(c, 0); p16(c, 0);
      p32(c, 0); p32(c, e.off);
      var h = new Uint8Array(c.concat(Array.from(e.nb)));
      parts.push(h); cdSize += h.length;
    });
    var z = [];
    p32(z, 0x06054b50); p16(z, 0); p16(z, 0);
    p16(z, self.entries.length); p16(z, self.entries.length);
    p32(z, cdSize); p32(z, cdStart); p16(z, 0);
    parts.push(new Uint8Array(z));
    return new Blob(parts, { type: "application/zip" });
  };
  function enc(s) { return new TextEncoder().encode(s); }

  /* ---------- 离线包附带文件 ---------- */
  var README = [
    "量化回测系统 · 整站离线包",
    "========================================",
    "",
    "一、怎么打开",
    "1. 解压到任意文件夹（保持目录结构，不要只解压出 index.html）。",
    "2. Windows 双击 START-Windows.bat；macOS / Linux 在终端运行 bash START-Mac.command。",
    "   需要本机装有 Python 3。也可以不用脚本，在文件夹内手动执行：",
    "       python3 -m http.server 8765",
    "   然后浏览器打开 http://localhost:8765/index.html",
    "3. 不要直接双击 index.html：file:// 下浏览器禁止读取 gz 数据文件，页面会加载失败。",
    "",
    "二、数据、策略与本机状态（自动生效）",
    "state.json 带上了导出瞬间的全部本机状态：行情增量（更新到的数据日期见 export-manifest.json）、",
    "策略、策略组合、修复记录、交易日历、标的池、分组管理、体检记录等。",
    "打开任意页面时会自动把「本机缺的」补回来，并让两套系统重放行情补丁、刷新数据日期；",
    "本机已有且更新的不会被覆盖。不用点任何按钮，也不用清缓存。",
    "restore.html 只是手动备用；手动恢复会覆盖当前地址下已有的同名数据。",
    "扶摇 API Key 只存于会话内存，出于安全不导出，需到 ETF 数据体检页重新填写。",
    "",
    "三、包里有什么",
    "- 首页、ETF 回测系统、可转债回测系统、数据体检中心、策略组合页及全部公共组件",
    "- 6 份行情 .gz：包内基线，导出不改写（新数据在 state.json 里，打开时自动回放）",
    "- state.json：导出瞬间的本机状态快照，含新行情增量；页面打开即自动生效",
    "- export-manifest.json：本次导出的文件清单、状态项数与数据止日期",
    "- sw.js / README.md：站点原有文件",
    "",
    "四、重新部署到线上",
    "把解压后的整个文件夹（或直接把这个 zip）拖到花生壳 Drop / Netlify 部署入口即可，",
    "入口是根目录 index.html。上传后打开首页或任一套系统，数据日期就是包里带到的那天。",
    "不用点 restore.html、不用手动恢复；多余的启动脚本、restore.html 不影响线上运行。",
    "",
    "五、断网与更新",
    "本机 server 运行时，断外网也能打开各页、跑回测、看策略与组合。",
    "「一键更新行情 / 更新交易日历 / 数据体检」需要外网，离线时请等下次联网再点。",
    "以后线上页面改版，重新导出一次即可拿到新快照。",
    ""
  ].join("\r\n");

  var BAT = [
    "@echo off",
    "cd /d \"%~dp0\"",
    "where py >nul 2>nul",
    "if %errorlevel%==0 (set PYEXE=py -3) else (set PYEXE=python)",
    "start \"WufuOfflineServer\" /min %PYEXE% -m http.server 8765",
    "timeout /t 2 >nul",
    "start \"\" \"http://localhost:8765/index.html\"",
    "echo.",
    "echo If the browser did not open, visit http://localhost:8765/index.html",
    "echo Keep this folder intact. Close the server window to stop the server.",
    "pause"
  ].join("\r\n");

  var SH = [
    "#!/bin/bash",
    "cd \"$(dirname \"$0\")\"",
    "python3 -m http.server 8765 &",
    "PID=$!",
    "sleep 1",
    "open \"http://localhost:8765/index.html\" 2>/dev/null || echo \"Open http://localhost:8765/index.html in your browser\"",
    "echo \"Local server running (PID $PID). Press Ctrl+C to stop.\"",
    "wait $PID"
  ].join("\n");

  var RESTORE = [
    "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>恢复本机状态 · 量化回测系统离线包</title>",
    "<style>",
    WufuTheme.sub("body{margin:0;background:§WFT0007§;color:§WFT0004§;font:14px/1.7 -apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif}"),
    WufuTheme.sub(".box{max-width:680px;margin:60px auto;padding:24px 28px;background:§WFT0008§;border:1px solid §WFT0001§;border-radius:10px}"),
    WufuTheme.sub("h1{font-size:19px;margin:0 0 14px;color:§WFT0032§}"),
    WufuTheme.sub("p{color:§WFT0003§;margin:10px 0}"),
    WufuTheme.sub("button{font-size:13px;padding:9px 16px;border-radius:6px;border:1px solid §WFT0006§;background:§WFT0008§;color:§WFT0005§;cursor:pointer}"),
    "button:disabled{opacity:.45;cursor:default}",
    WufuTheme.sub("button:hover:enabled{background:§WFT0037§}"),
    WufuTheme.sub("a{color:§WFT0006§}"),
    WufuTheme.sub(".warn{background:§WFT0019§;border:1px dashed §WFT0013§;color:§WFT0014§;padding:8px 12px;border-radius:8px;font-size:12px}"),
    WufuTheme.sub("code{background:§WFT0007§;padding:2px 6px;border-radius:4px;font-size:12px}"),
    "<script src=\"./common/storage.js\"></script></head><body><div class=\"box\">",
    "<h1>恢复本机状态</h1>",
    "<p id=\"msg\">正在读取 state.json …</p>",
    "<div class=\"warn\">本页只是手动备用：正常情况下打开任意页面都会自动补齐状态。点击恢复会覆盖当前地址下已有的同名数据。</div>",
    "<p><button id=\"btn\" disabled>恢复本机状态</button></p>",
    "<div id=\"detail\"></div>",
    "</div><script>",
    "(function(){",
    "  var st=null,msg=document.getElementById('msg'),btn=document.getElementById('btn'),dt=document.getElementById('detail');",
    "  fetch('./state.json').then(function(r){if(!r.ok)throw new Error('state.json 不存在');return r.json();})",
    "  .then(function(j){",
    "    st=j;",
    "    var ks=Object.keys((j&&j.localStorage)||{});",
    "    msg.innerHTML='已找到快照：导出于 <code>'+(j.exportedAt||'—')+'</code>，原站点 <code>'+(j.origin||'—')+'</code>';",
    "    dt.innerHTML='<p>本机状态共 <b>'+ks.length+'</b> 项（策略、组合、行情增量、日历、体检记录等）。扶摇 API Key 不在其中。</p>';",
    "    btn.disabled=false;",
    "  }).catch(function(e){",
    "    msg.innerHTML='未找到 state.json（'+e.message+'）。若你打开的是线上站点，请忽略本页并返回首页。';",
    "    dt.innerHTML='<p><a href=\"./index.html\">打开首页 →</a></p>';",
    "  });",
    "  btn.onclick=function(){",
    "    var o=(st&&st.localStorage)||{},n=0,fail=0,pend=false;",
    "    Object.keys(o).forEach(function(k){",
    "      try{",
    "        if(window.WufuStore&&WufuStore.put){var r=WufuStore.put(k,o[k]);if(!r.ok){fail++;return;}if(r.pending)pend=true;}",
    "        else localStorage.setItem(k,o[k]);",
    "        n++;",
    "      }catch(e){fail++;}",
    "    });",
    "    var finish=function(){",
    "      msg.innerHTML='已恢复 <b>'+n+'</b> 项本机状态'+(fail?'（'+fail+' 项写入失败）':'')+'。<a href=\"./index.html\">打开首页 →</a>';",
    "      btn.disabled=true;",
    "    };",
    "    if(pend&&window.WufuStore&&WufuStore.flush) WufuStore.flush().then(finish); else finish();",
    "  };",
    "})();",
    "</script></body></html>"
  ].join("\n");

  /* ---------- 本机状态 ---------- */
  /* 大仓库（IndexedDB）是异步预加载的：导出前等它就绪，避免拷到半截状态 */
  function awaitVault() {
    return new Promise(function (res) {
      try {
        if (!window.WufuStore || !WufuStore.vaultInfo) { res(); return; }
        var t = 0, iv = setInterval(function () {
          t++;
          var i = WufuStore.vaultInfo();
          if (i.ready || t > 25) { clearInterval(iv); res(); }
        }, 100);
      } catch (e) { res(); }
    });
  }
  /* 从两个主行情补丁里取「数据止」，写进 state.json 供导出提示与自检 */
  function bundleAsOf(ls) {
    var best = "";
    ["wufuCbQPatch_v1", "wufuQPatch_v1"].forEach(function (k) {
      try {
        var o = JSON.parse(ls[k] || "null"); if (!o) return;
        var d = o.days || [], last = "", i;
        if (Object.prototype.toString.call(d) === "[object Array]") {
          for (i = d.length - 1; i >= 0; i--) {
            if (d[i] && d[i].date) { last = String(d[i].date).slice(0, 10); break; }
          }
        }
        if (o.scale && o.scale.asof) {
          var q = String(o.scale.asof).slice(0, 10);
          if (q > last) last = q;
        }
        if (last > best) best = last;
      } catch (e) { }
    });
    return best;
  }
  function collectState() {
    var out = {}, ls = null;
    try { ls = window.localStorage; } catch (e) { }
    if (ls) {
      var n = 0;
      try { n = ls.length; } catch (e) { }
      for (var i = 0; i < n; i++) {
        var k = null, v = null;
        try { k = ls.key(i); } catch (e) { }
        if (!k) continue;
        try { v = ls.getItem(k); } catch (e) { }
        if (v != null) out[k] = v;
      }
    }
    return {
      format: "wufu-offline-state-v2",
      exportedAt: new Date().toISOString(),
      origin: location.origin,
      dataAsOf: bundleAsOf(out),
      note: "含 localStorage 与已迁到大仓库的行情增量；页面打开时自动补齐本机，扶摇 API Key 不导出",
      localStorage: out
    };
  }

  function openCache() {
    if (!("caches" in window)) return Promise.reject(new Error("浏览器不支持 Cache Storage"));
    if (H.cache) return caches.open(H.cache);
    return caches.keys().then(function (ks) {
      var v = ks.filter(function (k) { return /^wufu-all-v/.test(k); }).pop();
      return caches.open(v || "wufu-all");
    });
  }

  function build(onProgress) {
    var zip = new Zip(), files = [], rootPath = new URL(ROOT).pathname;
    return awaitVault().then(function () {
      return openCache().then(function (c) { return c.keys().then(function (ks) { return { c: c, ks: ks }; }); })
      .then(function (o) {
        var items = o.ks.filter(function (k) {
          try { return new URL(k.url).origin === location.origin; } catch (e) { return false; }
        });
        var chain = Promise.resolve();
        items.forEach(function (k, idx) {
          chain = chain.then(function () {
            var p = new URL(k.url).pathname;
            if (rootPath && p.indexOf(rootPath) === 0) p = p.slice(rootPath.length);
            p = p.replace(/^\/+/, "");
            if (!p) p = "index.html";
            return o.c.match(k).then(function (r) {
              if (!r) return null;
              return r.arrayBuffer().then(function (buf) {
                zip.add(p, new Uint8Array(buf));
                files.push(p);
                if (onProgress) onProgress(idx + 1, items.length, p);
              });
            }).catch(function () { return null; });
          });
        });
        return chain.then(function () { return { items: items.length }; });
      })
      .then(function (info) {
        /* 兼容旧缓存：新清单已含 sw.js / README.md；老缓存没有时走纯网络补齐
           （加 __swcache 让 SW 放行，避免污染 Cache Storage）。离线且老缓存时静默跳过。 */
        var extra = ["sw.js", "README.md"], chain = Promise.resolve();
        extra.forEach(function (ep) {
          chain = chain.then(function () {
            if (files.indexOf(ep) >= 0) return null;
            return fetch(new URL(ep, ROOT).href + "?__swcache=1").then(function (r) {
              if (!r || !r.ok) return null;
              return r.arrayBuffer().then(function (buf) {
                zip.add(ep, new Uint8Array(buf)); files.push(ep);
              });
            }).catch(function () { return null; });
          });
        });
        return chain.then(function () { return info; });
      })
      .then(function (info) {
        var state = collectState();
        var stBytes = enc(JSON.stringify(state));
        zip.add("state.json", stBytes);
        zip.add("restore.html", enc(RESTORE));
        zip.add("START-Windows.bat", enc(BAT));
        zip.add("START-Mac.command", enc(SH));
        zip.add("README-OFFLINE.txt", enc(README));
        var manifest = {
          format: "wufu-offline-package-v1",
          exportedAt: state.exportedAt,
          origin: state.origin,
          cacheName: H.cache || "",
          cachedEntries: info.items,
          siteFiles: files.slice(),
          stateKeys: Object.keys(state.localStorage).length,
          dataAsOf: state.dataAsOf,
          note: "state.json 由页面打开时自动补齐本机并重放行情补丁；restore.html 仅为手动备用"
        };
        zip.add("export-manifest.json", enc(JSON.stringify(manifest, null, 2)));
        return { blob: zip.blob(), stats: manifest, stateBytes: stBytes.length };
      });
    });
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }

  window.WufuExport = {
    build: build,
    download: function () {
      var btn = document.getElementById("btnExport"), msg = document.getElementById("exportMsg");
      if (btn) btn.disabled = true;
      if (msg) msg.textContent = "正在读取本机缓存 …";
      return build(function (i, n, p) {
        if (msg) msg.textContent = "正在打包 " + i + "/" + n + " · " + p;
      }).then(function (res) {
        var url = URL.createObjectURL(res.blob), a = document.createElement("a");
        a.href = url; a.download = "量化回测系统_离线包_" + stamp() + ".zip";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        if (msg) msg.textContent = "已导出 " + res.stats.siteFiles.length + " 个站点文件 + " +
          res.stats.stateKeys + " 项本机状态（数据止 " + (res.stats.dataAsOf || "基线") +
          "，" + (res.blob.size / 1048576).toFixed(1) + " MB）· 上传后打开即自动生效，无需手动恢复";
        if (btn) btn.disabled = false;
        return res;
      }).catch(function (e) {
        if (msg) msg.textContent = "导出失败：" + ((e && e.message) || e);
        if (btn) btn.disabled = false;
        throw e;
      });
    }
  };
})();
