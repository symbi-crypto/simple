/* common/instrument-rules.js — ②⑧：交易所规则边界 / 费用按品种市场拆项
 *
 * 参考：honestTai/hrouter-market-pulse @90ed124
 *   mcp/market-rules.mjs:43-46   priceLimitPct / priceLimitRequiresVerification /
 *                               limitations「Board defaults require dated verification
 *                               for ST, IPO, delisting, funds and exceptional sessions.」
 *   docs/DESIGN.md:63,75        费用按券商配（佣金/最低收费/印花税/过户费/规费），按市场分开配
 *
 * 诚实边界（必须读）：
 *  · 本模块**不计算** ST / IPO / 退市整理 / 基金份额 / 特殊时段的例外限幅。
 *    工作台没有标的当日状态元数据，一律按默认板口径，但显式标 default-unverified。
 *    「需验证」是 flag，不是「已验证」，这正是参考项目 priceLimitRequiresVerification 的含义。
 *  · 费用新增分项（印花税/过户费/规费/经手费）**默认全为 0**，extraPct 严格 0。
 *    现行回测口径本来就不含这些税费；本版只把字段结构化 + 可配置化，
 *    不代表已按真实券商费率建模。启用非零值需提供带日期的费率证据，并会改变收益。
 *  · 两处都不得擅自改历史口径：A/B 同参数回测必须 Δ=0。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WufuRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  // ── ② 交易所板规则 ─────────────────────────────────────────────────
  var CB_LIM_DATE = '2022-08-01';

  var PRICE_LIMIT_RULES = {
    scope: 'A 股默认板规则，仅用于日线回测的一字板可成交判定',
    market: 'A',
    priceLimitRequiresVerification: true,
    limitations: [
      '默认板规则不足以证明 ST/*ST、IPO 上市首日、退市整理期、基金份额、特殊时段与临时停牌的执行口径。',
      '本工作台没有标的当日状态元数据（ST 标记、上市日、退市标记、基金分类），无法逐日核验例外；一律按默认口径但标注未验证。',
      '涨跌幅比例的生效日期需带官方来源与核验日期；CB 新规日与 ETF 20% 名单均为静态表，未逐年复核。',
      '异常休市、盘中临时停牌、集合竞价特殊规则未建模。'
    ],
    verificationRequiredFor: ['ST', 'IPO_FIRST_DAY', 'DELISTING', 'FUND', 'EXCEPTIONAL_SESSION', 'HALT'],
    evidence: [
      { rule: '可转债上市首日 +57.3% / -43.3%，基准为发行价 100 元',
        effectiveFrom: '2022-08-01', source: '沪深交易所可转债交易细则（静态表）',
        verifiedAt: null, note: '未附官方 URL 与核验日期，待补' },
      { rule: '可转债非首日 ±20%；2022-08-01 前不判涨跌停',
        effectiveFrom: CB_LIM_DATE, source: '沪深交易所可转债交易细则（静态表）',
        verifiedAt: null, note: '未附官方 URL 与核验日期，待补' },
      { rule: 'ETF 科创/创业板相关 20%，其余 10%',
        effectiveFrom: null, source: '包内静态代码前缀表 LIM20',
        verifiedAt: null, note: '名单为硬编码，未附生效日期与官方来源' }
    ],
    // 20% 名单：与原 etf/tool.html 的 LIM20 表逐项一致（数值一字不改）
    etf20: { '588': 1, '589': 1, '159915.SZ': 1, '159949.SZ': 1, '159516.SZ': 1 }
  };

  /** 与原 cbLimitOf 数值完全一致，额外带规则边界元数据。 */
  function cbLimit(dateStr, isFirst, prevClose) {
    var meta = {
      ruleScope: PRICE_LIMIT_RULES.scope,
      priceLimitRequiresVerification: PRICE_LIMIT_RULES.priceLimitRequiresVerification,
      verificationStatus: 'default-unverified',
      limitations: PRICE_LIMIT_RULES.limitations.slice(),
      verificationRequiredFor: PRICE_LIMIT_RULES.verificationRequiredFor.slice()
    };
    if (isFirst) {
      return { up: 157.3, dn: 56.7, base: 100, limitPct: null, firstDay: true,
               effectiveFrom: null, meta: meta };
    }
    if (!dateStr || dateStr < CB_LIM_DATE) return null;   // 新规前无涨跌幅限制
    if (!(prevClose > 0)) return null;
    return { up: prevClose * 1.20, dn: prevClose * 0.80, base: prevClose,
             limitPct: 20, firstDay: false, effectiveFrom: CB_LIM_DATE, meta: meta };
  }

  /** 与原 LIM20 分支数值完全一致（limR 1.195 / 1.095），额外带规则元数据。 */
  function etfLimit(code) {
    var c = String(code || '');
    var is20 = !!(PRICE_LIMIT_RULES.etf20[c.slice(0, 3)] || PRICE_LIMIT_RULES.etf20[c]);
    return {
      limR: is20 ? 1.195 : 1.095,
      limitPct: is20 ? 20 : 10,
      matchedPrefix: is20 ? c.slice(0, 3) : 'default',
      ruleScope: PRICE_LIMIT_RULES.scope,
      priceLimitRequiresVerification: PRICE_LIMIT_RULES.priceLimitRequiresVerification,
      verificationStatus: 'default-unverified',
      limitations: PRICE_LIMIT_RULES.limitations.slice()
    };
  }

  function boardRuleSummary() {
    return {
      scope: PRICE_LIMIT_RULES.scope,
      priceLimitRequiresVerification: PRICE_LIMIT_RULES.priceLimitRequiresVerification,
      verificationRequiredFor: PRICE_LIMIT_RULES.verificationRequiredFor.slice(),
      limitations: PRICE_LIMIT_RULES.limitations.slice(),
      evidenceCount: PRICE_LIMIT_RULES.evidence.length,
      unverifiedEvidence: PRICE_LIMIT_RULES.evidence.filter(function (e) { return !e.verifiedAt; }).length
    };
  }

  // ── ⑧ 费用按品种 / 市场拆项 ────────────────────────────────────────
  // 所有新增分项默认 0：现行口径不含它们，擅自给非零值会改变历史收益。
  var ZERO_EXTRAS = Object.freeze({
    stampDuty: 0, transferFee: 0, regulatoryFee: 0, exchangeFee: 0
  });

  var FEE_SCHEDULE = {
    version: 1,
    basis: '按券商 × 市场 × 品种拆项；现行回测口径下所有新增分项为零值，启用需提供带日期的费率证据',
    configurable: true,
    markets: {
      A: {
        ETF:   { label: 'ETF / 基金', extras: Object.assign({}, ZERO_EXTRAS), note: 'ETF 免印花税；过户费/规费现行口径未计' },
        CB:    { label: '可转债',     extras: Object.assign({}, ZERO_EXTRAS), note: '经手费现行口径未计' },
        STOCK: { label: 'A 股股票',   extras: Object.assign({}, ZERO_EXTRAS), note: '印花税/过户费/规费现行口径未计' }
      }
    },
    // 仅作参考示例，不参与计算；启用必须显式覆盖并附费率证据。
    referenceExamples: {
      'A.STOCK.stampDutySell': { value: 0.001, note: '示例：卖出方千分之一，非本工作台现行值，不启用' }
    },
    limitations: [
      '现行回测口径只含佣金、最低佣金、滑点；印花税/过户费/规费/经手费均为零值占位。',
      '未按券商配置（无券商费率来源、无核验日期），configurable=true 仅表示结构可覆盖，不表示已建模。',
      '把任一 extra 置为非零会改变成本与收益，必须同步做 A/B 对比并附费率生效日期。',
      '分档滑点与最低佣金沿用页面参数，本模块只登记分项，不重复实现。'
    ]
  };

  /** 按代码粗分品种（仅用于分项登记与展示，不改变任何数值）。 */
  function instrumentOf(code) {
    var c = String(code || '');
    if (/^(11|12)\d{4}\./.test(c)) return 'CB';
    if (/^(5[0-9]|1[5-9])\d{4}\./.test(c)) return 'ETF';
    return 'STOCK';
  }

  function num(v, fallback) {
    var x = +v;
    return Number.isFinite(x) ? x : fallback;
  }

  /** 真消费入口：返回 legCost 需要的费率与「新增分项净贡献 extraPct」。
   *  extraPct 严格 0（默认），保证 A/B Δ=0；被显式覆盖时会带入对应分项。 */
  function resolveFee(params, market, instrument, override) {
    var p = params || {}, mk = String(market || 'A'), ins = String(instrument || 'ETF');
    var sched = (FEE_SCHEDULE.markets[mk] || FEE_SCHEDULE.markets.A)[ins]
             || FEE_SCHEDULE.markets.A.STOCK;
    var ov = override || {};
    var extras = {
      stampDuty: num(ov.stampDuty, sched.extras.stampDuty),
      transferFee: num(ov.transferFee, sched.extras.transferFee),
      regulatoryFee: num(ov.regulatoryFee, sched.extras.regulatoryFee),
      exchangeFee: num(ov.exchangeFee, sched.extras.exchangeFee)
    };
    var extraPct = extras.stampDuty + extras.transferFee + extras.regulatoryFee + extras.exchangeFee;
    return {
      market: mk, instrument: ins, label: sched.label,
      commissionRate: num(p.commission_rate, 0),
      slippageRate: num(p.slippage_rate, 0),
      minCommission: num(p.min_commission, 0),
      tiered: !!p.tiered_slippage,
      extras: extras,
      extraPct: extraPct,
      itemized: [
        { key: 'commissionRate', label: '佣金率', value: num(p.commission_rate, 0), active: true },
        { key: 'minCommission', label: '最低佣金(元/笔)', value: num(p.min_commission, 0), active: true },
        { key: 'slippageRate', label: '滑点率', value: num(p.slippage_rate, 0), active: true },
        { key: 'stampDuty', label: '印花税', value: extras.stampDuty, active: extras.stampDuty !== 0 },
        { key: 'transferFee', label: '过户费', value: extras.transferFee, active: extras.transferFee !== 0 },
        { key: 'regulatoryFee', label: '规费', value: extras.regulatoryFee, active: extras.regulatoryFee !== 0 },
        { key: 'exchangeFee', label: '经手费', value: extras.exchangeFee, active: extras.exchangeFee !== 0 }
      ],
      limitations: FEE_SCHEDULE.limitations.slice(),
      feeRequiresVerification: true,
      note: sched.note
    };
  }

  function feeBreakdown(params, market, instrument, override) {
    var f = resolveFee(params, market, instrument, override);
    var on = f.itemized.filter(function (x) { return x.active; });
    var off = f.itemized.filter(function (x) { return !x.active; });
    return {
      market: f.market, instrument: f.instrument, label: f.label, extraPct: f.extraPct,
      activeText: on.map(function (x) {
        return x.label + ' ' + (x.key === 'minCommission' ? x.value : (x.value * 100).toFixed(4) + '%');
      }).join(' · '),
      zeroText: off.map(function (x) { return x.label + ' 0'; }).join(' / '),
      limitations: f.limitations, feeRequiresVerification: f.feeRequiresVerification
    };
  }

  function rulesBoundaryHtml() {
    var b = boardRuleSummary();
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    return '<div id="ruleFeeDetail" data-verify="' +
      (b.priceLimitRequiresVerification ? 'required' : 'none') + '" ' +
      'style="margin:6px 0 0;padding:7px 9px;font-size:11px;line-height:1.65;' +
      'border-left:3px solid #c07a00;background:rgba(127,127,127,.07);border-radius:4px">' +
      '<b>② 交易所规则边界</b>：默认板口径 · <span style="color:#c07a00">需带日期核验</span>' +
      '（' + b.verificationRequiredFor.map(esc).join(' / ') + '）；' +
      '本工作台无标的当日状态元数据，一律按默认口径但标 <code>default-unverified</code>。' +
      '证据 ' + b.evidenceCount + ' 条，其中 <b>' + b.unverifiedEvidence + ' 条未附核验日期</b>。' +
      '<div style="color:#999;margin-top:2px">' + b.limitations.map(esc).join('；') + '</div>' +
      '</div>';
  }

  return {
    PRICE_LIMIT_RULES: PRICE_LIMIT_RULES, FEE_SCHEDULE: FEE_SCHEDULE,
    CB_LIM_DATE: CB_LIM_DATE,
    cbLimit: cbLimit, etfLimit: etfLimit, boardRuleSummary: boardRuleSummary,
    instrumentOf: instrumentOf, resolveFee: resolveFee, feeBreakdown: feeBreakdown,
    rulesBoundaryHtml: rulesBoundaryHtml
  };
});
