/* ============================================================
   dash-source.js — 看板快照取数单一入口（v0.83 / 方案 C）
   ------------------------------------------------------------
   · 随周度同步前进的快照：优先读 GitHub（jsDelivr 主 / raw 备），
     失败或拉到空壳时回退包内副本，页面标「离线副本」并照常显示真值。
   · 不是「摆空壳」：两份都不可用时才调用渲染器的 fail()，绝不写示意值。
   · index-daily.json 是 index.gz 静态基线（按设计不追加），不在远端名单，
     仍只读包内，行为与 v0.82 完全一致。
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
    'market-amount.json': 1
  };
  var REMOTE_MS = 6000;   // 国内移动侧不让它拖住首屏
  var LOCAL_MS = 12000;
  var CMP_MS = 2500;      // 远端成功后比新旧用的本地请求

  function base(u) {
    var s = String(u || '').split('?')[0].split('#')[0];
    return s.slice(s.lastIndexOf('/') + 1);
  }
  function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }

  /* 只认结构完整的真值；失败态 / 空壳（ok=false、dataAsOf=null、空数组）一律拒收 */
  function valid(name, d) {
    if (!d || typeof d !== 'object' || d.ok === false) return false;
    if (!d.format || !isDate(d.dataAsOf)) return false;
    var t = (d.trend && typeof d.trend === 'object') ? d.trend : {};
    var t5 = (t['5'] && typeof t['5'] === 'object') ? t['5'] : {};
    var fmt = String(d.format);
    if (fmt === 'wufu-dash-cb-v1') {
      return (typeof d.count === 'number' && d.count > 0) &&
             !!(t5.labels && t5.labels.length && t5.price && t5.price.length);
    }
    if (fmt === 'wufu-dash-gold-v1') {
      return !!(t5.labels && t5.labels.length && t5.price && t5.price.length);
    }
    if (fmt === 'wufu-dash-industry-v2') {
      return (typeof d.boardCount === 'number' && d.boardCount > 0) &&
             (typeof d.sampleDays === 'number' && d.sampleDays > 0);
    }
    if (fmt === 'wufu-dash-amount-v1') {
      var a5 = (d['5'] && typeof d['5'] === 'object') ? d['5'] : {};
      return !!(a5.labels && a5.labels.length);
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

  global.WufuDash = {
    load: load,
    badge: badge,
    valid: valid,
    REMOTE: REMOTE,
    REMOTE_BASE: GH,
    RAW_BASE: RAW
  };
})(window);
