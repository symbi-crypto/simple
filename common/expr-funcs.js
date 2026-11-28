/* ============================================================
   common/expr-funcs.js — 自定义公式解析器「单一真源」
   v0.9915：把 etf/cb × 回测页/策略页四份内嵌 WufuExpr 抽到本文件。

   · 骨架（canonId / tokenize / Parser / evalNum / validate / arity 校验）
     只保留一份，四页共用，杜绝「改一页漏三页」。
   · 表数据按「共有段 + 系统专属段」组装：
       ALIAS_COMMON(53) + ALIAS_EXTRA[etf|cb]
       FIELDS: HEAD(5) + MID(9) + TECH[etf|cb] + TAIL(16)
       FUNCS : HEAD(12) + [SLOPE 仅回测页] + MID(6) + TECH[etf|cb] + TAIL(19)
     组装结果与 v0.9914 四页原表逐元素、逐顺序一致。
   · profile：'etf-tool' / 'etf-index' / 'cb-tool' / 'cb-index'
     四页只传 profile 名；新增通用函数改一处共有段即可四页生效。
   · 本版不加任何函数、不改任何口径；求值仍由各页 exprCallAt 提供 ctx。
   ============================================================ */
(function () {
  var ALIAS_COMMON = {"后复权收盘价":"close","未复权收盘价":"rawclose","后复权开盘价":"open","后复权最高价":"high","后复权最低价":"low","开盘价":"open","最高价":"high","最低价":"low","成交量":"volume","成交额":"amount","换手率":"turnover","单位净值":"nav","溢价率均值":"premium","溢价率":"premium","引用":"ref","差分":"delta","均线":"ma","指数移动平均":"ema","平滑均线":"sma","加权均线":"wma","动态均线":"dma","求和":"sum","乘积":"product","最大值":"max","最小值":"min","标准差":"std","绝对值":"abs","变动率":"roc","对数":"log","净值":"close","净值涨幅":"nav_roc","乖离率":"bias","收益波动率":"vol","涨幅":"roc","涨幅动量":"roc","N日均线":"ma","ATR":"atr","斜率动量":"slope_r2","加权斜率动量":"wslope_r2","R²阈值":"r2","拟合优度R²":"r2","风险调整动量":"risk_adj","日内振幅":"amplitude","振幅":"amplitude","日内位置":"position","RSI":"rsi","放量比":"vol_ratio","RSRS":"rsrs","平均相关度":"avg_corr","收盘vs前均线":"c_vs_ma_lag","均线vs均线":"ma_vs_ma","均线vs前均线":"ma_vs_ma_lag","N日前均线":"ma_lag"};
  var ALIAS_EXTRA = {"etf":{"MACD":"macd_bar","MACD_DIF":"macd_dif","MACD_DEA":"macd_dea","MACD_BAR":"macd_bar","KDJ_RSV":"kdj_rsv","KDJ_K":"kdj_k","KDJ_D":"kdj_d","KDJ_J":"kdj_j","布林带上线":"boll_up","布林带中线":"boll_mid","布林带下线":"boll_dn","BOLL_UP":"boll_up","BOLL_MID":"boll_mid","BOLL_DN":"boll_dn"},"cb":{"MACD":"macd","KDJ":"kdj","布林线":"boll"}};
  var FIELDS_HEAD = [{"id":"close","cn":"后复权收盘价","cat":"price","win":null,"help":"当日后复权收盘价（轮动引擎主口径）"},{"id":"rawclose","cn":"未复权收盘价","cat":"price","win":null,"help":"当日未复权收盘价（真实成交口径）"},{"id":"open","cn":"后复权开盘价","cat":"price","win":null,"help":"当日开盘价"},{"id":"high","cn":"后复权最高价","cat":"price","win":null,"help":"当日最高价"},{"id":"low","cn":"后复权最低价","cat":"price","win":null,"help":"当日最低价"}];
  var FIELDS_MID = [{"id":"volume","cn":"成交量","cat":"price","win":[20],"help":"N 日平均成交量（手）"},{"id":"amount","cn":"成交额","cat":"price","win":[20],"help":"N 日平均成交额"},{"id":"turnover","cn":"换手率","cat":"price","win":[20],"help":"N 日换手率均值（%）"},{"id":"roc","cn":"ROC","cat":"price","win":[20],"expr":"ROC(后复权收盘价,20)","help":"N 日涨幅 = 今收 ÷ N 个交易日前收 − 1；写法 ROC(X,N)"},{"id":"nav_roc","cn":"净值涨幅","cat":"price","win":[20],"legacy":true,"help":"（旧写法）请改用 ROC(单位净值,N)"},{"id":"premium","cn":"溢价率均值","cat":"price","win":[20],"help":"N 日平均折溢价率（小数，负=折价）"},{"id":"vol","cn":"收益波动率","cat":"tech","win":[20],"expr":"VOL(后复权收盘价,20)","help":"N 日收益波动率（默认20日）"},{"id":"bias","cn":"乖离率","cat":"tech","win":[20],"expr":"BIAS(后复权收盘价,20)","help":"收盘价相对 N 日均线（默认20日，BIAS）"},{"id":"ma","cn":"N日均线","cat":"tech","win":[20],"expr":"MA(后复权收盘价,20)","help":"N 日均线值（默认20日）"}];
  var FIELDS_TECH = {"etf":[{"id":"macd_dif","cn":"MACD_DIF","cat":"tech","win":[12,26,9],"help":"DIF = EMA(收盘,12) − EMA(收盘,26)；参数 快线/慢线/信号。金叉写 MACD_DIF(12,26,9) − MACD_DEA(12,26,9) > 0"},{"id":"macd_dea","cn":"MACD_DEA","cat":"tech","win":[12,26,9],"help":"DEA = EMA(DIF,9)；收盘价站上长线写 close − MACD_DEA(12,26,9) > 0"},{"id":"macd_bar","cn":"MACD","cat":"tech","win":[12,26,9],"help":"柱 = DIF − DEA（不乘2）；参数 快/慢/信号"},{"id":"kdj_rsv","cn":"KDJ_RSV","cat":"tech","win":[9,3,3],"help":"RSV = (收盘 − N日最低) ÷ (N日最高 − N日最低) × 100；参数 RSV窗口/K平滑/D平滑"},{"id":"kdj_k","cn":"KDJ_K","cat":"tech","win":[9,3,3],"help":"K = (RSV + (M1−1)×前K) ÷ M1"},{"id":"kdj_d","cn":"KDJ_D","cat":"tech","win":[9,3,3],"help":"D = (K + (M2−1)×前D) ÷ M2"},{"id":"kdj_j","cn":"KDJ_J","cat":"tech","win":[9,3,3],"help":"J = 3K − 2D；超卖常写 KDJ_J(9,3,3) < 0"},{"id":"boll_up","cn":"布林带上线","cat":"tech","win":[20,2],"help":"上轨 = MA_N + K×σ；参数 均线窗口/σ倍数"},{"id":"boll_mid","cn":"布林带中线","cat":"tech","win":[20,2],"help":"中轨 = MA_N（σ倍数不参与此项）"},{"id":"boll_dn","cn":"布林带下线","cat":"tech","win":[20,2],"help":"下轨 = MA_N − K×σ；跌破下轨写 close − 布林带下线(20,2) < 0"}],"cb":[{"id":"macd","cn":"MACD","cat":"tech","win":[20],"help":"MACD 柱（DIF-DEA，参数12/26/9）"},{"id":"kdj","cn":"KDJ","cat":"tech","win":[9],"help":"KDJ 的 K 值（RSV 9/3/3）"},{"id":"boll","cn":"布林线","cat":"tech","win":[20],"help":"布林带 %B（20日2σ）"}]};
  var FIELDS_TAIL = [{"id":"atr","cn":"ATR","cat":"tech","win":[20],"help":"ATR÷收盘价（20日真实波幅相对值）"},{"id":"slope_r2","cn":"斜率动量","cat":"tech","win":[25],"help":"线性回归斜率×R²（默认25日）"},{"id":"wslope_r2","cn":"加权斜率动量","cat":"tech","win":[25],"help":"加权回归斜率×R²（默认25日）"},{"id":"r2","cn":"R²阈值","cat":"tech","win":[25],"help":"对数收盘价回归 R²（默认25日）"},{"id":"risk_adj","cn":"风险调整动量","cat":"tech","win":[60],"help":"年化斜率÷波动率（默认60日）"},{"id":"amplitude","cn":"日内振幅","cat":"tech","win":[20],"help":"(最高-最低)/最低（默认20日）"},{"id":"position","cn":"日内位置","cat":"tech","win":[20],"help":"(收盘-最低)/(最高-最低)（默认20日）"},{"id":"rsi","cn":"RSI","cat":"tech","win":[14],"help":"相对强弱指标（默认14日）"},{"id":"vol_ratio","cn":"放量比","cat":"tech","win":[20,60],"help":"近N日均量÷M日前M日均量（默认20/60）"},{"id":"rsrs","cn":"RSRS","cat":"tech","win":[20],"help":"N日RSRS：N日最高价对最低价OLS回归斜率"},{"id":"c_vs_ma_lag","cn":"收盘vs前均线","cat":"tech","win":[5,20],"help":"收盘价相对 N 日前 M 日均线（默认5/20）"},{"id":"ma_vs_ma","cn":"均线vs均线","cat":"tech","win":[20,60],"help":"近N日均线相对近M日均线（默认20/60）"},{"id":"ma_vs_ma_lag","cn":"均线vs前均线","cat":"tech","win":[20,5,20],"help":"近N日均线相对 M 日前 O 日均线（默认20/5/20）"},{"id":"ma_lag","cn":"N日前均线","cat":"tech","win":[5,20],"help":"N 日前 M 日均线（默认5/20）"},{"id":"nav","cn":"单位净值","cat":"price","win":null,"help":"基金官方公布单位净值"},{"id":"avg_corr","cn":"平均相关度","cat":"tech","win":[120],"help":"【截面因子】与当期候选池内其余标的近N日日收益的皮尔逊相关系数均值（默认120日）；值越低越不合群、越利于分散。需池子≥8只且持仓≥2只才有意义"}];
  var VOLUME_HELP_CB = "N 日平均成交量（手）· 与成交额同源，2017-01-03 起";
  var FUNCS_HEAD = [{"name":"REF","cn":"REF","help":"取 N 日前的值","args":2},{"name":"DELTA","cn":"Delta","help":"X - N日前X（差值）","args":2},{"name":"MA","cn":"MA","help":"N 日简单移动平均","args":2},{"name":"EMA","cn":"EMA","help":"N 日指数移动平均","args":2},{"name":"SMA","cn":"SMA","help":"递归移动平均：(X*M+前值*(N-M))/N","args":3},{"name":"WMA","cn":"WMA","help":"N 日加权移动平均（线性权重）","args":2},{"name":"DMA","cn":"DMA","help":"X 的 A 日动态移动平均","args":2},{"name":"SUM","cn":"SUM","help":"N 日累计求和","args":2},{"name":"PRODUCT","cn":"Product","help":"N 日连乘（累乘收益）","args":2},{"name":"MAX","cn":"MAX","help":"N 日最大值","args":2},{"name":"MIN","cn":"MIN","help":"N 日最小值","args":2},{"name":"STD","cn":"STD","help":"N 日总体标准差","args":2}];
  var SLOPE_ITEM = {"name":"SLOPE","cn":"SLOPE","help":"X 的 N 日线性回归斜率（OLS）；如 SLOPE(BIAS(后复权收盘价,90),25)","args":2};
  var FUNCS_MID = [{"name":"ABS","cn":"ABS","help":"绝对值","args":1},{"name":"ROC","cn":"ROC","help":"N 日涨幅：ROC(X,N)，必须写全两个参数，如 ROC(后复权收盘价,20)","args":2},{"name":"VOL","cn":"收益波动率","help":"N 日收益波动率：VOL(X,N)，必须写全两个参数，如 VOL(后复权收盘价,20)","args":2},{"name":"NAV_ROC","cn":"净值涨幅","legacy":true,"help":"（旧写法）请改用 ROC(单位净值,N)","args":2},{"name":"BIAS","cn":"乖离率","help":"乖离率：BIAS(后复权收盘价,N) 为收盘价相对 N 日均线（如 BIAS(后复权收盘价,20)）","args":2},{"name":"LOG","cn":"LOG","help":"自然对数 ln(X)","args":1}];
  var FUNCS_TECH = {"etf":[{"name":"macd_dif","cn":"MACD_DIF","fieldOnly":true,"help":"DIF(快,慢,信号)；如 MACD_DIF(12,26,9)","args":3},{"name":"macd_dea","cn":"MACD_DEA","fieldOnly":true,"help":"DEA(快,慢,信号)；如 MACD_DEA(12,26,9)","args":3},{"name":"macd_bar","cn":"MACD","fieldOnly":true,"help":"柱=DIF−DEA(快,慢,信号)；如 MACD(12,26,9)","args":3},{"name":"kdj_rsv","cn":"KDJ_RSV","fieldOnly":true,"help":"RSV(N,K平滑,D平滑)；如 KDJ_RSV(9,3,3)","args":3},{"name":"kdj_k","cn":"KDJ_K","fieldOnly":true,"help":"K(N,K平滑,D平滑)；如 KDJ_K(9,3,3)","args":3},{"name":"kdj_d","cn":"KDJ_D","fieldOnly":true,"help":"D(N,K平滑,D平滑)；如 KDJ_D(9,3,3)","args":3},{"name":"kdj_j","cn":"KDJ_J","fieldOnly":true,"help":"J=3K−2D(N,K平滑,D平滑)；如 KDJ_J(9,3,3)","args":3},{"name":"boll_up","cn":"布林带上线","fieldOnly":true,"help":"上轨(窗口,σ倍数)；如 布林带上线(20,2)","args":2},{"name":"boll_mid","cn":"布林带中线","fieldOnly":true,"help":"中轨(窗口,σ倍数)；如 布林带中线(20,2)","args":2},{"name":"boll_dn","cn":"布林带下线","fieldOnly":true,"help":"下轨(窗口,σ倍数)；如 布林带下线(20,2)","args":2}],"cb":[{"name":"MACD","cn":"MACD","fieldOnly":true,"help":"N 日 MACD 柱均值（DIF-DEA，参数12/26/9）；如 MACD(20)","args":1},{"name":"KDJ","cn":"KDJ","fieldOnly":true,"help":"N 日 KDJ 的 K 值均值（RSV 9/3/3）；如 KDJ(9)","args":1},{"name":"BOLL","cn":"布林线","fieldOnly":true,"help":"布林带 %B：收盘价在 N 日 2σ 带内位置；如 布林线(20)","args":1}]};
  var FUNCS_TAIL = [{"name":"ATR","cn":"ATR","fieldOnly":true,"help":"N 日 ATR÷收盘价；如 ATR(20)","args":1},{"name":"RSI","cn":"RSI","fieldOnly":true,"help":"N 日相对强弱指标；如 RSI(14)","args":1},{"name":"AMPLITUDE","cn":"日内振幅","fieldOnly":true,"help":"N 日振幅 (最高-最低)/最低；如 日内振幅(20)","args":1},{"name":"POSITION","cn":"日内位置","fieldOnly":true,"help":"N 日日内位置 (收盘-最低)/(最高-最低)；如 日内位置(20)","args":1},{"name":"SLOPE_R2","cn":"斜率动量","fieldOnly":true,"help":"线性回归斜率×R²；如 斜率动量(25)","args":1},{"name":"WSLOPE_R2","cn":"加权斜率动量","fieldOnly":true,"help":"加权回归斜率×R²；如 加权斜率动量(25)","args":1},{"name":"R2","cn":"R²阈值","fieldOnly":true,"help":"对数收盘价回归 R²；如 R²阈值(25)","args":1},{"name":"RISK_ADJ","cn":"风险调整动量","fieldOnly":true,"help":"年化斜率÷波动率；如 风险调整动量(60)","args":1},{"name":"VOL_RATIO","cn":"放量比","fieldOnly":true,"help":"近N日均量÷M日前M日均量；如 放量比(20,60)","args":2},{"name":"RSRS","cn":"RSRS","fieldOnly":true,"help":"N 日 RSRS：N 日最高价对最低价 OLS 回归斜率；如 RSRS(20)","args":1},{"name":"C_VS_MA_LAG","cn":"收盘vs前均线","fieldOnly":true,"help":"收盘价相对 N 日前 M 日均线；如 收盘vs前均线(5,20)","args":2},{"name":"MA_VS_MA","cn":"均线vs均线","fieldOnly":true,"help":"近N日均线相对近M日均线；如 均线vs均线(20,60)","args":2},{"name":"MA_VS_MA_LAG","cn":"均线vs前均线","fieldOnly":true,"help":"近N日均线相对 M 日前 O 日均线；如 均线vs前均线(20,5,20)","args":3},{"name":"MA_LAG","cn":"N日前均线","fieldOnly":true,"help":"N 日前 M 日均线；如 N日前均线(5,20)","args":2},{"name":"VOLUME","cn":"成交量","fieldOnly":true,"help":"N 日平均成交量；如 成交量(20)","args":1},{"name":"AMOUNT","cn":"成交额","fieldOnly":true,"help":"N 日平均成交额；如 成交额(20)","args":1},{"name":"TURNOVER","cn":"换手率","fieldOnly":true,"help":"N 日平均换手率；如 换手率(20)","args":1},{"name":"PREMIUM","cn":"溢价率均值","fieldOnly":true,"help":"N 日平均折溢价率；如 溢价率均值(20)","args":1},{"name":"AVG_CORR","cn":"平均相关度","fieldOnly":true,"help":"N 日平均相关度（截面因子，与候选池内其余标的的相关系数均值）；如 平均相关度(120)","args":1}];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function buildAlias(sys) {
    var a = {}, k;
    for (k in ALIAS_COMMON) a[k] = ALIAS_COMMON[k];
    for (k in ALIAS_EXTRA[sys]) a[k] = ALIAS_EXTRA[sys][k];
    return a;
  }
  function buildFields(sys) {
    var mid = clone(FIELDS_MID);
    if (sys === 'cb') mid[0].help = VOLUME_HELP_CB;
    return FIELDS_HEAD.concat(mid, clone(FIELDS_TECH[sys]), FIELDS_TAIL);
  }
  function buildFuncs(sys, withSlope) {
    return FUNCS_HEAD.concat(withSlope ? [SLOPE_ITEM] : [], FUNCS_MID,
                            clone(FUNCS_TECH[sys]), FUNCS_TAIL);
  }


  window.WufuExprLib = {
    create: function (profile) {
      if (!/^(etf|cb)-(tool|index)$/.test(profile))
        throw new Error('WufuExpr: 未知 profile "' + profile + '"');
      var sys = (profile.indexOf('etf') === 0) ? 'etf' : 'cb',
          withSlope = /-tool$/.test(profile);
    // 中文别名 → 规范 id（字段/函数）；英文 id 原样保留可解析
      var CN_ALIAS = buildAlias(sys);
    function canonId(v) { return CN_ALIAS[v] || v.toLowerCase(); }
    function tokenize(src) {
      var s = String(src).replace(/\s+/g, ''), out = [], i = 0;
      while (i < s.length) {
        var ch = s[i];
        if (/[0-9.]/.test(ch)) {
          var j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
          out.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
        }
        if (/[a-zA-Z_一-鿿²]/.test(ch)) {
          var k = i; while (k < s.length && /[a-zA-Z0-9_一-鿿²]/.test(s[k])) k++;
          out.push({ t: 'id', v: s.slice(i, k) }); i = k; continue;
        }
        var two = s.slice(i, i + 2);
        if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
          out.push({ t: 'op', v: two }); i += 2; continue;
        }
        if ('+-*/()><!,'.indexOf(ch) >= 0) { out.push({ t: 'op', v: ch }); i++; continue; }
        throw new Error('表达式不合法：无法识别字符 "' + ch + '"');
      }
      return out;
    }
    function Parser(toks) { this.t = toks; this.p = 0; }
    Parser.prototype.peek = function () { return this.t[this.p]; };
    Parser.prototype.next = function () { return this.t[this.p++]; };
    Parser.prototype.parse = function () { var n = this.parseOr(); if (this.p < this.t.length) throw new Error('表达式不合法：尾部多余 "' + (this.t[this.p].v) + '"'); return n; };
    Parser.prototype.parseOr = function () { var n = this.parseAnd(); while (this.peek() && this.peek().v === '||') { this.next(); var r = this.parseAnd(); n = { t: 'log', op: '||', l: n, r: r }; } return n; };
    Parser.prototype.parseAnd = function () { var n = this.parseCmp(); while (this.peek() && this.peek().v === '&&') { this.next(); var r = this.parseCmp(); n = { t: 'log', op: '&&', l: n, r: r }; } return n; };
    Parser.prototype.parseCmp = function () { var n = this.parseAdd(); while (this.peek() && ['>', '<', '>=', '<=', '==', '!='].indexOf(this.peek().v) >= 0) { var op = this.next().v; var r = this.parseAdd(); n = { t: 'cmp', op: op, l: n, r: r }; } return n; };
    Parser.prototype.parseAdd = function () { var n = this.parseMul(); while (this.peek() && (this.peek().v === '+' || this.peek().v === '-')) { var op = this.next().v; var r = this.parseMul(); n = { t: 'bin', op: op, l: n, r: r }; } return n; };
    Parser.prototype.parseMul = function () { var n = this.parseUnary(); while (this.peek() && (this.peek().v === '*' || this.peek().v === '/')) { var op = this.next().v; var r = this.parseUnary(); n = { t: 'bin', op: op, l: n, r: r }; } return n; };
    Parser.prototype.parseUnary = function () { if (this.peek() && this.peek().v === '!') { this.next(); return { t: 'not', e: this.parseUnary() }; } if (this.peek() && this.peek().v === '-') { this.next(); return { t: 'neg', e: this.parseUnary() }; } return this.parsePrimary(); };
    Parser.prototype.parsePrimary = function () {
      var tk = this.next(); if (!tk) throw new Error('表达式不合法：意外结束');
      if (tk.t === 'num') return { t: 'num', v: tk.v };
      if (tk.t === 'id') {
        var canon = canonId(tk.v);
        if (this.peek() && this.peek().v === '(') {
          this.next(); var args = [];
          if (!(this.peek() && this.peek().v === ')')) {
            args.push(this.parseOr());
            while (this.peek() && this.peek().v === ',') { this.next(); args.push(this.parseOr()); }
          }
          if (!this.peek() || this.peek().v !== ')') throw new Error('表达式不合法：函数 "' + tk.v + '" 缺少右括号 )');
          this.next();
          return { t: 'call', name: canon, args: args };
        }
        return { t: 'ref', v: canon };
      }
      if (tk.v === '(') { var n = this.parseOr(); this.next(); return n; }
      throw new Error('表达式不合法：意外符号 "' + tk.v + '"');
    };
    function truthy(v) { return !(v == null || isNaN(v)) && !!v; }
    // ctx.field(id) -> 标量；ctx.call(name, argsAst) -> 数值；ctx.evalNum(ast) 供函数递归求值参数
    function evalNum(node, ctx) {
      if (node.t === 'num') return node.v;
      if (node.t === 'ref') { var v = ctx.field(node.v); return (v == null || isNaN(v)) ? NaN : v; }
      if (node.t === 'call') return ctx.call(node.name, node.args);
      if (node.t === 'neg') return -evalNum(node.e, ctx);
      if (node.t === 'bin') { var a = evalNum(node.l, ctx), b = evalNum(node.r, ctx); if (isNaN(a) || isNaN(b)) return NaN;
        if (node.op === '+') return a + b; if (node.op === '-') return a - b; if (node.op === '*') return a * b; if (node.op === '/') return b === 0 ? NaN : a / b; }
      if (node.t === 'cmp') { var a2 = evalNum(node.l, ctx), b2 = evalNum(node.r, ctx); if (isNaN(a2) || isNaN(b2)) return 0;
        if (node.op === '>') return a2 > b2 ? 1 : 0; if (node.op === '<') return a2 < b2 ? 1 : 0; if (node.op === '>=') return a2 >= b2 ? 1 : 0; if (node.op === '<=') return a2 <= b2 ? 1 : 0; if (node.op === '==') return a2 === b2 ? 1 : 0; if (node.op === '!=') return a2 !== b2 ? 1 : 0; }
      if (node.t === 'log') { if (node.op === '&&') return (truthy(evalNum(node.l, ctx)) && truthy(evalNum(node.r, ctx))) ? 1 : 0; return (truthy(evalNum(node.l, ctx)) || truthy(evalNum(node.r, ctx))) ? 1 : 0; }
      if (node.t === 'not') return truthy(evalNum(node.e, ctx)) ? 0 : 1;
      return NaN;
    }
      var FIELDS = buildFields(sys);
      var FUNCS = buildFuncs(sys, withSlope);
    function validate(ast, fields, funcs) {
      var fset = {}, aset = {};
      fields.forEach(function (f) { fset[f.id] = 1; });
      funcs.forEach(function (f) { aset[f.name.toLowerCase()] = { n: f.args, fo: !!f.fieldOnly }; });
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'ref') { if (!fset[n.v]) throw new Error('表达式不合法：未识别字段 "' + n.v + '"'); return; }
        if (n.t === 'call') {
          var a = aset[n.name];
          if (!a) throw new Error('表达式不合法：未识别函数 "' + n.name + '"');
          // v0.9914：取消省略模式。非窗口白名单函数必须恰好传满声明的参数个数；
          // 漏写（或多写）一律报错，不再自动补 close / 不再用默认窗口兜底。
          if (!a.fo && n.args.length !== a.n)
            throw new Error('表达式不合法：函数 "' + n.name + '" 需要 ' + a.n + ' 个参数，实际 ' + n.args.length
              + ' 个；请写全「序列, 窗口」，如 ROC(后复权收盘价,20)');
          if (a.fo && (n.args.length < 1 || n.args.length > a.n))
            throw new Error('表达式不合法：函数 "' + n.name + '" 需要 1~' + a.n + ' 个参数，实际 ' + n.args.length + ' 个');
          n.args.forEach(walk); return;
        }
        for (var k in n) { if (n[k] && typeof n[k] === 'object') walk(n[k]); }
      })(ast);
    }
    return {
      compile: function (src) { var toks = tokenize(src); var p = new Parser(toks); var ast = p.parse(); validate(ast, FIELDS, FUNCS); return ast; },
      evalNum: function (ast, ctx) { return evalNum(ast, ctx); },
      evalBool: function (ast, ctx) { return truthy(evalNum(ast, ctx)); },
      FIELDS: FIELDS, FUNCS: FUNCS,
      ALLOWED: '字段(' + FIELDS.length + ')：' + FIELDS.map(function (f) { return f.cn; }).join('/') + '；函数(' + FUNCS.length + ')：' + FUNCS.map(function (f) { return f.name; }).join('/')
    };
    },
    PROFILES: ['etf-tool', 'etf-index', 'cb-tool', 'cb-index']
  };
})();
