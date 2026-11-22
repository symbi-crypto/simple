/* common/research-gate.js — P4：时点可得 / 样本外资格 / 拒单指标 / 日历证据
 *
 * 参考：honestTai/hrouter-market-pulse @90ed124
 *   mcp/market-rules.mjs:7-25        日历证据链、覆盖声明、半日时段
 *   mcp/market-rules.mjs:124-129     dailyBarMetadata：未完成当日 K 线 complete=false
 *   mcp/research-validation.mjs:185  qualifyPrediction：未达标只给 observe/rejected
 *   docs/AGENT_ARENA.md:100-102      拒单数按原因分、统一 sampleWarning
 *
 * 边界（诚实声明）：本模块全是纯函数，不取数、不下单、不改任何收益数值。
 * 概率模型相关指标（AUC / Brier / logLoss / ECE / purged folds）不照搬：
 * 本工作台没有概率模型与分类标签，样本外资格按分段收益一致性判定。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WufuGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  // 收盘可得时刻。US 取 16:00-05:00（冬令时保守值，不做 DST 精算）；
  // 半日市与临时休市由日历证据文件的 HalfDaySessions 单独声明，本表不假装覆盖。
  var CLOSE = {
    A:  { suffix: 'T15:00:00+08:00', label: 'A 股 15:00 CST' },
    HK: { suffix: 'T16:00:00+08:00', label: '港股 16:00 HKT' },
    US: { suffix: 'T16:00:00-05:00', label: '美股 16:00 ET（保守取冬令时，未做 DST 精算）' }
  };

  function availableAt(sessionDate, market) {
    var d = String(sessionDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return d + (CLOSE[market || 'A'] || CLOSE.A).suffix;
  }

  /** 时点可得闸门：availableAt > now 的交易日一律剔除，当天未完成的 K 线永远看不到。
   *  返回 lastUsable 供回测把 end_date 钳到最后一个已收盘交易日。 */
  function pointInTimeCutoff(calendar, now, market) {
    var t = Date.parse(now || new Date().toISOString());
    if (!Number.isFinite(t)) t = Date.now();
    var cal = Array.isArray(calendar) ? calendar : [];
    var kept = [], dropped = [];
    for (var i = 0; i < cal.length; i++) {
      var a = availableAt(cal[i], market), at = a ? Date.parse(a) : NaN;
      if (!Number.isFinite(at) || at > t) dropped.push(cal[i]);
      else kept.push(cal[i]);
    }
    return {
      keptCount: kept.length,
      droppedDates: dropped,
      lastUsable: kept.length ? kept[kept.length - 1] : null,
      market: market || 'A',
      closeBasis: (CLOSE[market || 'A'] || CLOSE.A).label,
      evaluatedAt: new Date(t).toISOString(),
      reason: dropped.length ? '未完成当日 K 线已剔除' : '全部交易日均已收盘'
    };
  }

  /** ① 日历证据链：字段齐不代表来源权威，missing/limitations 必须显式暴露。 */
  function calendarEvidence(h) {
    var o = (h && typeof h === 'object') ? h : {};
    var cov = o.Coverage || {}, ev = Array.isArray(o.Evidence) ? o.Evidence : [];
    var missing = [];
    ['start', 'end', 'markets', 'timezone'].forEach(function (k) {
      if (!cov[k]) missing.push('Coverage.' + k);
    });
    if (!ev.length) missing.push('Evidence');
    else ev.forEach(function (e, i) {
      if (!e.source) missing.push('Evidence[' + i + '].source');
      if (!e.verifiedAt) missing.push('Evidence[' + i + '].verifiedAt');
    });
    if (!o.HalfDaySessions || typeof o.HalfDaySessions !== 'object') missing.push('HalfDaySessions');
    if (!Array.isArray(o.Limitations)) missing.push('Limitations');
    return { ok: missing.length === 0, missing: missing, coverage: cov,
             evidenceCount: ev.length, limitations: Array.isArray(o.Limitations) ? o.Limitations : [] };
  }

  /** ④ 样本外资格闸门。硬条件不满足 = rejected；软条件不满足 = observe；
   *  只有全过才是 qualified，且 qualified 仅代表「可用于研究复核」。 */
  function qualifyWFO(segs, opts) {
    var o = opts || {};
    var minFolds = o.minFolds || 3, minObs = o.minObservations || 90;
    var posRatio = (o.minPositiveExcessRatio != null) ? o.minPositiveExcessRatio : 0.6;
    var worstFloor = (o.maxWorstCagr != null) ? o.maxWorstCagr : -0.20;
    var s = Array.isArray(segs) ? segs : [];
    var reasons = [], hard = [], obs = 0, cagrs = [], excess = [];
    for (var i = 0; i < s.length; i++) {
      var seg = s[i], r = seg && seg.res;
      obs += Math.max(0, (seg && seg.ve != null && seg.vs != null) ? (seg.ve - seg.vs) : 0);
      if (!r || typeof r.cagr !== 'number' || !Number.isFinite(r.cagr)) {
        hard.push('第 ' + (i + 1) + ' 段结果缺失或无效'); continue;
      }
      cagrs.push(r.cagr);
      excess.push((typeof r.excess === 'number' && Number.isFinite(r.excess)) ? r.excess : 0);
    }
    if (s.length < minFolds) hard.push('样本外分段不足 ' + minFolds + ' 段（实际 ' + s.length + '）');
    if (obs < minObs) hard.push('样本外观测不足 ' + minObs + ' 个交易日（实际 ' + obs + '）');
    var avg = cagrs.length ? cagrs.reduce(function (a, b) { return a + b; }, 0) / cagrs.length : 0;
    var worst = cagrs.length ? Math.min.apply(null, cagrs) : 0;
    var pos = excess.filter(function (x) { return x > 0; }).length;
    var ratio = excess.length ? pos / excess.length : 0;
    var downRun = false;
    for (var j = 1; j < cagrs.length - 1; j++) {
      if (cagrs[j] < cagrs[j - 1] && cagrs[j + 1] < cagrs[j]) downRun = true;
    }
    if (!(avg > 0)) reasons.push('平均年化不为正');
    if (ratio < posRatio) reasons.push('相对基准为正的段占比 ' + Math.round(ratio * 100) + '% < ' + Math.round(posRatio * 100) + '%');
    if (worst < worstFloor) reasons.push('最差段年化 ' + (worst * 100).toFixed(1) + '% 低于 ' + (worstFloor * 100).toFixed(0) + '%');
    if (downRun) reasons.push('存在连续两段收益转差');
    var status = hard.length ? 'rejected' : (reasons.length ? 'observe' : 'qualified');
    return {
      status: status, qualified: status === 'qualified',
      reasons: hard.concat(reasons), hardReasons: hard,
      metrics: { folds: s.length, observations: obs, avgCagr: avg, worstCagr: worst,
                 positiveExcessRatio: ratio, downRun: downRun },
      meaning: '研究复核资格，不是投资建议或盈利保证；未通过不得当作可用结论。',
      notApplicable: ['AUC', 'Brier score', 'log loss', 'ECE', 'purged walk-forward folds'],
      notApplicableNote: '本工作台无概率模型与分类标签，参考项目的概率校准类指标不照搬；本闸门按分段收益一致性判定。'
    };
  }

  function qualificationHtml(q) {
    if (!q) return '';
    var color = q.status === 'qualified' ? '#1a9d5a' : (q.status === 'observe' ? '#c07a00' : '#c0392b');
    var word = q.status === 'qualified' ? '可用于研究复核' : (q.status === 'observe' ? '仅供参考，不作结论' : '未通过，结论不可用');
    var rs = q.reasons.length
      ? '<div style="margin-top:3px">理由：' + q.reasons.map(function (x) {
          return String(x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
        }).join('；') + '</div>'
      : '<div style="margin-top:3px">硬性条件（≥3 段 / ≥90 观测）与稳健性条件全部通过。</div>';
    return '<div id="wfoGate" data-status="' + q.status + '" style="margin:2px 0 7px;padding:6px 9px;' +
      'border-left:3px solid ' + color + ';background:rgba(127,127,127,.07);border-radius:4px">' +
      '<b>样本外资格：<span style="color:' + color + '">' + q.status + ' · ' + word + '</span></b>' + rs +
      '<div style="margin-top:3px;color:#888;font-size:11px">' + q.meaning +
      ' · 段 ' + q.metrics.folds + ' / 观测 ' + q.metrics.observations + ' 日</div></div>';
  }

  /** ⑥ 拒单/不可成交按原因汇总。计数来自回测引擎的保守跳过，不是券商失败统计。 */
  function skipSummary(win, res) {
    var w = win || {};
    var defs = [
      { key: '__WUFU_NO_OPEN_SKIP', label: '无开盘价·整期未成交' },
      { key: '__WUFU_NO_REAL_CLOSE_SKIP', label: '其中：收盘口径无真实收盘价' },
      { key: '__WUFU_LIMIT_BLOCK_BUY', label: '一字涨停·买单不可成交' },
      { key: '__WUFU_LIMIT_BLOCK_SELL', label: '一字跌停·卖单不可成交' },
      { key: '__CB_SCALE_FILL_ISSUE', label: '复权填充异常' }
    ];
    var byReason = defs.map(function (d) {
      var v = Number(w[d.key]);
      return { key: d.key, label: d.label, count: (Number.isFinite(v) && v > 0) ? Math.round(v) : 0 };
    });
    var total = byReason.reduce(function (a, b) { return a + b.count; }, 0);
    var short = byReason.filter(function (x) { return x.count > 0; })
      .map(function (x) { return x.label.split('·')[0] + ' ' + x.count; }).join(' · ') || '无';
    var m = (res && res.metrics) || {};
    var sw = null;
    if ((m.n_days && m.n_days < 60) || (m.n_trades != null && m.n_trades < 10)) {
      sw = '样本不足：' + (m.n_days || 0) + ' 个交易日 / ' + (m.n_trades || 0) +
           ' 次调仓，短期结果主要反映运气，请结合回撤与拒单情况看。';
    }
    return { total: total, byReason: byReason, short: short, sampleWarning: sw,
             note: '跳过是偏保守的近似（宁可少成交），不是券商成交失败统计；按原因分列。' };
  }

  return { availableAt: availableAt, pointInTimeCutoff: pointInTimeCutoff,
           calendarEvidence: calendarEvidence, qualifyWFO: qualifyWFO,
           qualificationHtml: qualificationHtml, skipSummary: skipSummary,
           CLOSE: CLOSE };
});
