/* common/cond-ops.js —— 条件比较符唯一真源（v0.9906）
   四类条件（筛选因子 / 买入附加 / 卖出 / 不卖）的比较判定、选项、文案都在这里。
   op 枚举：gte ≥ | lte ≤ | gt > | lt < | eq = | between 区间。
   gte / lte 保留旧语义且为默认，gt / lt / eq / between 为新增可选。
   「等于」按数值严格相等，不区分整数或浮点，不加容差（由使用者自行判断）。
   「区间」含端点：threshold = 下界，threshold2 = 上界；上界缺失按 +Infinity。
   老存档不含 threshold2 且 op 为 gte/lte，判定与序列化一律不变。 */
(function (g) {
  var OPS = ["gte", "lte", "gt", "lt", "eq", "between"];
  var LABEL = { gte: "≥", lte: "≤", gt: ">", lt: "<", eq: "=", between: "区间" };
  var WORD = { gte: "大于等于", lte: "小于等于", gt: "大于", lt: "小于",
               eq: "等于", between: "区间" };
  function norm(op) { return OPS.indexOf(op) >= 0 ? op : "gte"; }
  function isBetween(op) { return norm(op) === "between"; }
  /* 唯一判定入口。v 为因子/名次/数值，thr 为阈值，thr2 为区间上界。 */
  function hit(op, v, thr, thr2) {
    if (v === null || v === undefined || isNaN(v)) return false;
    var a = +v, b = +thr;
    switch (norm(op)) {
      case "lte": return a <= b;
      case "gt":  return a > b;
      case "lt":  return a < b;
      case "eq":  return a === b;
      case "between": {
        var hi = (thr2 === undefined || thr2 === null || thr2 === "") ? Infinity : +thr2;
        return a >= b && a <= hi;
      }
      default: return a >= b;   /* gte：旧默认，语义一字未改 */
    }
  }
  function label(op) { return LABEL[norm(op)]; }
  function word(op) { return WORD[norm(op)]; }
  function options() { return OPS.map(function (o) { return { v: o, t: LABEL[o] }; }); }
  function optionHtml() {
    return OPS.map(function (o) {
      return '<option value="' + o + '">' + LABEL[o] + '</option>';
    }).join("");
  }
  /* 条件摘要文案：区间显示「区间 a~b」，其余「符号 阈值」。 */
  function text(op, thr, thr2) {
    var num = function (x) {
      return (x === undefined || x === null || isNaN(+x)) ? "0" : String(+Number(x).toFixed(4));
    };
    if (isBetween(op)) {
      var hi = (thr2 === undefined || thr2 === null || thr2 === "") ? "∞" : num(thr2);
      return "区间 " + num(thr) + "~" + hi;
    }
    return label(op) + " " + num(thr);
  }
  /* 区间上界输入框：仅当 op=between 时显示。
     storeFn(display)→内部值、loadFn(internal)→显示值，由调用处提供，
     与同处下界输入框共用同一套量纲（ETF 按百分比 / CB 按 thrDisp·thrStore）。
     两者都不传时用恒等；obj 为 null 时只创建控件，值由调用方读取。 */
  function mountRange(opSel, host, obj, storeFn, loadFn) {
    var store = storeFn || function (v) { return +v; };
    var load = loadFn || function (v) { return +v; };
    var inp = document.createElement("input");
    inp.type = "number"; inp.step = "any";
    inp.className = "wufu-range-hi";
    inp.placeholder = "上界";
    inp.title = "区间上界（含端点，与下界同单位）";
    inp.style.cssText = "flex:0 0 56px;min-width:0;font-size:12px;padding:2px;" +
      "border:1px solid var(--c-edge,#ccc);border-radius:4px";
    if (obj && obj.threshold2 !== undefined && obj.threshold2 !== null) {
      var d = load(obj.threshold2);
      inp.value = isNaN(+d) ? "" : String(+(+d).toFixed(4));
    } else {
      inp.value = "";
    }
    function applyVal() {
      if (!obj) return;
      var x = parseFloat(inp.value);
      obj.threshold2 = isNaN(x) ? undefined : store(x);
    }
    function sync() {
      var on = isBetween(opSel.value);
      inp.style.display = on ? "" : "none";
      if (host && host.style) host.style.flexWrap = on ? "wrap" : "";
      if (on) applyVal();
    }
    opSel.addEventListener("change", sync);
    inp.addEventListener("input", applyVal);
    if (host) host.appendChild(inp);
    sync();
    return inp;
  }
  var api = { OPS: OPS, LABEL: LABEL, WORD: WORD, norm: norm, hit: hit,
              label: label, word: word, isBetween: isBetween,
              options: options, optionHtml: optionHtml, text: text,
              mountRange: mountRange };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.WufuCondOps = api;
})(typeof window !== "undefined" ? window : this);
