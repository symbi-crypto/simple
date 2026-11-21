/* ============================================================
   dash-source.js — 看板快照取数单一入口（v0.83 方案 C / v0.84 纳入指数看板）
   ------------------------------------------------------------
   · 随周度同步前进的快照：优先读 GitHub（jsDelivr 主 / raw 备），
     失败或拉到空壳时回退包内副本，页面标「离线副本」并照常显示真值。
   · 不是「摆空壳」：两份都不可用时才调用渲染器的 fail()，绝不写示意值。
   · v0.84：index-daily.json 由基线 + 日更增量生成，已纳入远端名单，与其余看板同源。
   · 跨域请求由 sw.js 的同源判断直接放行，不进 Cache Storage。
   · 远端若因 CDN 缓存返回比包内更旧的日期，取两者中较新的一份。
   测试可用 window.WUFU_DASH_REMOTE 覆盖远端基址（指向本地 mock）。
   ============================================================ */
(function (global) {
  'use strict';

  var GH = 'https://cdn.jsdelivr.net/gh/symbi-crypto/simple@main/';
  var RAW = 'https://raw.githubusercontent.com/symbi-crypto/simple/main/';
  var REMOTE = {
    'cb-daily.json': 1,
    'gold-daily.json': 1,
    'industry-daily.json': 1,
    'market-amount.json': 1,
    'index-daily.json': 1
  };
  var REMOTE_MS = 6000;   // 国内移动侧不让它拖住首屏
  var LOCAL_MS = 12000;
  var CMP_MS = 2500;      // 远端成功后比新旧用的本地请求

  function base(u) {
    var s = String(u || '').split('?')[0].split('#')[0];
    return s.slice(s.lastIndexOf('/') + 1);
  }
  function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  /* v0.87 / P1③：contract 从链标识升为 {chain,formatVersion,minClient}。
     旧字符串契约（chain/1）向后兼容放行；minClient 高于本前端则拒收该份，
     让 load() 继续回退包内副本，绝不强行渲染或白屏。 */
  var CLIENT_VER = '0.87';
  function vnum(v) {
    var m = String(v || '').match(/\d+/g);
    return m ? (parseInt(m[0], 10) * 1000 + (m[1] ? parseInt(m[1], 10) : 0)) : 0;
  }
  function contractOK(d) {
    var c = d && d.contract;
    if (c == null || typeof c === 'string') return true;   // 旧 chain/1 / 缺失：兼容
    if (typeof c !== 'object') return false;
    if (c.minClient && vnum(c.minClient) > vnum(CLIENT_VER)) return false;
    return true;
  }

  /* 只认结构完整的真值；失败态 / 空壳（ok=false、dataAsOf=null、空数组）一律拒收 */
  function valid(name, d) {
    if (!d || typeof d !== 'object' || d.ok === false) return false;
    if (!d.format || !isDate(d.dataAsOf)) return false;
    if (!contractOK(d)) return false;   // P1③：版本不匹配则回退，不渲染
    var t = (d.trend && typeof d.trend === 'object') ? d.trend : {};
    var t5 = (t['5'] && typeof t['5'] === 'object') ? t['5'] : {};
    var fmt = String(d.format);
    if (fmt === 'wufu-dash-cb-v1') {
      return (typeof d.count === 'number' && d.count > 0) &&
             !!(t5.labels && t5.labels.length && t5.price && t5.price.length);
    }
    if (fmt === 'wufu-dash-gold-v1') {
      /* 黄金是多资产：trend.5.price 是 {代码: 序列} 字典，不是数组。
         只要 labels 非空且字典里至少有一条非空序列即算真值；
         空壳（全空数组 / {}）仍拒收。 */
      var gl = t5.labels, gp = t5.price;
      if (!gl || !gl.length || !gp || typeof gp !== 'object') return false;
      if (Array.isArray(gp)) return gp.length > 0;
      return Object.keys(gp).some(function (k) {
        return Array.isArray(gp[k]) && gp[k].length > 0;
      });
    }
    if (fmt === 'wufu-dash-industry-v2') {
      return (typeof d.boardCount === 'number' && d.boardCount > 0) &&
             (typeof d.sampleDays === 'number' && d.sampleDays > 0);
    }
    if (fmt === 'wufu-dash-amount-v1') {
      var a5 = (d['5'] && typeof d['5'] === 'object') ? d['5'] : {};
      return !!(a5.labels && a5.labels.length);
    }
    if (fmt === 'wufu-dash-idx-v2') {
      var it = (d.idxTrend && typeof d.idxTrend === 'object') ? d.idxTrend : {};
      var i5 = (it['5'] && typeof it['5'] === 'object') ? it['5'] : {};
      return !!(d.idx && d.idx.A && d.idx.A.length && i5.labels && i5.labels.length);
    }
    return true;
  }

  function get(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false, timer = null, ctl = null;
      try { ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; }
      catch (e) { ctl = null; }
      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;
      timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ctl) ctl.abort(); } catch (e2) { }
        reject(new Error('timeout'));
      }, ms);
      fetch(url, opt).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(d);
      }).catch(function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function tag(d, name, from) {
    try { d.__dashName = name; d.__from = from; } catch (e) { }
    return d;
  }

  /* 远端命中后，再读一次包内副本比 dataAsOf，避免 CDN 旧缓存把日期拉回去 */
  function preferNewer(remote, name, localUrl, onOK) {
    get(localUrl, CMP_MS).then(function (local) {
      if (valid(name, local) && String(local.dataAsOf) > String(remote.dataAsOf)) {
        onOK(tag(local, name, 'local'));
      } else {
        onOK(remote);
      }
    }).catch(function () { onOK(remote); });
  }

  function load(localUrl, onOK, onFail) {
    var name = base(localUrl), chain = [], remoteN = 0;
    var override = global.WUFU_DASH_REMOTE;
    if (REMOTE[name]) {
      if (override) {
        chain.push(String(override).replace(/\/?$/, '/') + name); remoteN = 1;
      } else {
        chain.push(GH + name); chain.push(RAW + name); remoteN = 2;
      }
    }
    chain.push(localUrl);
    var i = 0, lastErr = null;

    function step() {
      if (i >= chain.length) { if (onFail) onFail(lastErr); return; }
      var idx = i++, isRemote = idx < remoteN;
      get(chain[idx], isRemote ? REMOTE_MS : LOCAL_MS).then(function (d) {
        if (!valid(name, d)) { lastErr = new Error('invalid snapshot: ' + name); step(); return; }
        if (isRemote) {
          preferNewer(tag(d, name, 'remote'), name, localUrl, onOK);
        } else {
          onOK(tag(d, name, 'local'));
        }
      }).catch(function (e) { lastErr = e; step(); });
    }
    step();
  }

  /* 仅「本该跟远端、却用了包内副本」时才提示；静态基线不提示 */
  function badge(d) {
    if (!d || !REMOTE[d.__dashName] || d.__from !== 'local') return '';
    return ' · 离线副本';
  }

  /* P3 BEGIN — v0.89 / §6：回到前台重取一次快照
     · 只在 visibilitychange / pageshow 且「曾离开过前台」时触发；首屏 pageshow 不重复取。
     · 无任何定时器：去重窗口只靠 Date.now() 比较，绝不是轮询（规则明禁分钟级轮询）。
     · 只调用渲染器注册的刷新函数；不改任何状态文字、不碰调优/回测状态机。
     · 未注册刷新函数的页面（tool.html 等）为空操作，加载本文件无副作用。 */
  var REFRESH = {};
  var FG_GAP = 2000;          // 合并窗口：2 秒内多次切回只重取一次
  var lastFg = 0, wasHidden = false;

  function judgeForeground(hidden, was, now, last, gap) {
    if (hidden) return 'skip:hidden';
    if (!was) return 'skip:never-left';
    if (last && now - last < gap) return 'skip:coalesced';
    return 'refresh';
  }
  function onRefresh(name, fn) {
    if (name && typeof fn === 'function') REFRESH[name] = fn;
  }
  function anyHidden() {
    if (document.hidden) return true;
    /* 看板被 tool.html 以 iframe 嵌入：部分移动 WebView 只把父文档标为隐藏 */
    try { return !!(window.parent && window.parent !== window && window.parent.document.hidden); }
    catch (e) { return false; }
  }
  function maybeRefresh() {
    if (anyHidden()) { wasHidden = true; return; }
    if (!wasHidden) return;                       // 从未离开前台 → 不取
    wasHidden = false;
    var now = Date.now();
    if (judgeForeground(false, true, now, lastFg, FG_GAP) !== 'refresh') return;
    lastFg = now;
    Object.keys(REFRESH).forEach(function (k) {
      try { REFRESH[k](); } catch (e) { }
    });
  }
  try {
    /* P3-L1 */ document.addEventListener('visibilitychange', maybeRefresh);
    /* P3-L2 */ window.addEventListener('pageshow', maybeRefresh);   // 部分安卓 WebView 兜底
    /* 看板 iframe：父文档也补一个监听，与自身监听共用同一去重窗口，不会重复取 */
    if (window.parent && window.parent !== window) {
      try { window.parent.document.addEventListener('visibilitychange', maybeRefresh); } catch (e) { }
    }
  } catch (e) { }
  /* P3 END */

  global.WufuDash = {
    load: load,
    badge: badge,
    valid: valid,
    onRefresh: onRefresh,
    judgeForeground: judgeForeground,
    maybeRefresh: maybeRefresh,
    REMOTE: REMOTE,
    REMOTE_BASE: GH,
    RAW_BASE: RAW
  };
})(window);
