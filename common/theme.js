/* ============================================================
   common/theme.js — v0.82 主题取值（零视觉变化）
   · css(name) 读 :root 自定义属性；自定义属性保留原始 token，不做 rgb 规范化，
     所以返回值与改造前的颜色字面量逐字相同。
   · 内置 FALLBACK：theme.css 未加载 / 老浏览器读不到自定义属性时，
     返回同一原始字面量，任何加载顺序都不会改变观感。
   · sub(s) 把字符串里的 §WFT####§ token 换成当前主题值。
   · v0.93：三态主题（深 / 浅 / 跟随系统）。CSS 变量层自动切换；
     sub() 产物（ECharts option、SVG 属性、动态 HTML）由 refresh() 重算，
     切主题不刷新页面、不丢回测与调优状态。
   · 主题写 localStorage，同源 iframe 经 storage 事件自动同步。
   ============================================================ */
(function (g) {
  var LIGHT = {"--c-accent":"#4338ca","--c-accent-2":"#0e7490","--c-accent-soft":"#8b83e8","--c-bad-ink":"#b91c1c","--c-bg":"#f4f5f7","--c-bg-deep":"#eceef1","--c-down":"#0f8a5f","--c-down-rgb":"15,138,95","--c-edge":"#d7dbe2","--c-gray":"#7a8492","--c-h06b6d4":"#188193","--c-h0b1220":"#ECEDF0","--c-h0b131d":"#EDEEF1","--c-h0b1420":"#ECEEF0","--c-h0e1622":"#EBEDF0","--c-h0e7490":"#16718A","--c-h100c2a":"#EBEBEF","--c-h101c29":"#EAECEF","--c-h10b981":"#179068","--c-h111827":"#1F2937","--c-h123329":"#E8EDEC","--c-h131c28":"#EAECEE","--c-h14532d":"#E4EAE6","--c-h14b8a6":"#189183","--c-h15202e":"#E9EBEE","--c-h16202e":"#E9EBED","--c-h162131":"#E8EAED","--c-h1b2735":"#E7E9EC","--c-h1c2a3a":"#E6E9EB","--c-h1d4e7a":"#1E5282","--c-h1e2a38":"#E6E9EC","--c-h233347":"#E3E6E9","--c-h2a3546":"#E2E5E9","--c-h2a3b50":"#D4DAE1","--c-h2c3b4e":"#D4DAE2","--c-h2dd4bf":"#1D9485","--c-h2e3d50":"#D3D9E1","--c-h334155":"#334156","--c-h33465c":"#CFD6DE","--c-h344860":"#CED5DD","--c-h38bdf8":"#1A769F","--c-h3a2a12":"#EDEBE8","--c-h3b1d1d":"#EBE6E6","--c-h3b82f6":"#1A4D9F","--c-h3e7a8c":"#C2D0D5","--c-h3f1d1d":"#EBE5E5","--c-h4ade80":"#1B9D4A","--c-h5a6b80":"#BFC7D2","--c-h6e7f93":"#B8C0CA","--c-h6ee7b7":"#1BA46E","--c-h7f1d1d":"#841D1D","--c-h7f3a3a":"#D7C6C6","--c-h818cf8":"#1C29AA","--c-h8a97a8":"#282E36","--c-h8fa3b8":"#28333F","--c-h8fa3ba":"#273340","--c-h9fb3c8":"#2A3949","--c-h9fd8f6":"#1C7BAE","--c-ha33a36":"#812D2A","--c-ha3e635":"#6B9C19","--c-ha5f3fc":"#1DA0AF","--c-hb9c8d9":"#2F4054","--c-hbfdbfe":"#1D5EAF","--c-hc084fc":"#631CAB","--c-hccfbf1":"#1DAF90","--c-hd8e6f2":"#326A9A","--c-hdce6f0":"#374D62","--c-he2e8f0":"#384B64","--c-he6edf5":"#396393","--c-he6edf6":"#356097","--c-he6eef8":"#2B5FA1","--c-he6f4ff":"#1D6FAF","--c-he879f9":"#961BA9","--c-he8a33d":"#9D681A","--c-hf472b6":"#A71B64","--c-hf97316":"#9A4E19","--c-hfb7185":"#A81B30","--c-hfecaca":"#AF1D1D","--c-hfef2f2":"#AF1D1E","--c-info":"#1d4ed8","--c-line":"#e4e6eb","--c-muted":"#5b6472","--c-purple":"#7c3aed","--c-r001":"rgba(31,129,173,0.2207)","--c-r002":"rgba(31,129,173,0.3014)","--c-r003":"rgba(18,86,105,0.1621)","--c-r004":"rgba(15,23,42,0.3928)","--c-r005":"rgba(173,134,31,0.1235)","--c-r006":"rgba(31,129,173,0.0642)","--c-r007":"rgba(15,23,42,0.741)","--c-r008":"rgba(15,23,42,0.5627)","--c-r009":"rgba(31,129,173,0.0814)","--c-r010":"rgba(173,31,31,0.1421)","--c-r011":"rgba(15,23,42,0.0258)","--c-r012":"rgba(15,23,42,0.2375)","--c-r013":"rgba(173,31,31,0.1242)","--c-r014":"rgba(15,23,42,0.092)","--c-r015":"rgba(15,23,42,0.2077)","--c-r016":"rgba(31,129,173,0.1214)","--c-r017":"rgba(15,23,42,0.4701)","--c-r018":"rgba(18,86,105,0.1028)","--c-r019":"rgba(15,23,42,0.7055)","--c-r020":"rgba(173,31,31,0.1042)","--c-r021":"rgba(173,31,31,0.1)","--c-r022":"rgba(173,31,31,0.4007)","--c-r023":"rgba(15,23,42,0.1394)","--c-r024":"rgba(15,23,42,0.5641)","--c-r025":"rgba(48,61,77,0.4028)","--c-r026":"rgba(15,23,42,0.5655)","--c-r027":"rgba(31,129,173,0.1042)","--c-r028":"rgba(18,86,105,0.45)","--c-r029":"rgba(173,31,31,0.0807)","--c-r030":"rgba(173,134,31,0.0814)","--c-r031":"rgba(15,23,42,0.0596)","--c-r032":"rgba(15,23,42,0.2558)","--c-r033":"rgba(15,23,42,0.3035)","--c-r034":"rgba(15,23,42,0.3042)","--c-r035":"rgba(36,168,120,0.08)","--c-r036":"rgba(31,130,173,0.4507)","--c-r037":"rgba(31,130,173,0.5014)","--c-r038":"rgba(48,61,77,0.1521)","--c-r039":"rgba(31,129,173,0.1628)","--c-r040":"rgba(15,23,42,0.4875)","--c-r041":"rgba(173,134,31,0.0642)","--c-r042":"rgba(31,129,173,0.04)","--c-r043":"rgba(31,129,173,0.0507)","--c-r044":"rgba(31,129,173,0.1814)","--c-r045":"rgba(31,129,173,0.2821)","--c-r046":"rgba(31,129,173,0.3528)","--c-r047":"rgba(31,129,173,0.4535)","--c-r048":"rgba(31,129,173,0.5542)","--c-surface":"#ffffff","--c-surface-2":"#fbfbfc","--c-text":"#15171c","--c-text-2":"#39414f","--c-up":"#c0392b","--c-up-rgb":"192,57,43","--c-warn":"#b45309","--c-warn-2":"#d97706","--c-warn-ink":"#92400e","--c-white":"#FFFFFE","--c-white-full":"#fffffe","--c-brand-a":"#fffffd","--c-brand-b":"#dfe7f2","--c-on-brand":"#15171d"};
  var FALLBACK = {
    "--c-accent": "#4FC3F7",
    "--c-accent-2": "#22D3EE",
    "--c-accent-soft": "#7DD3FC",
    "--c-bad-ink": "#FCA5A5",
    "--c-bg": "#1B2634",
    "--c-bg-deep": "#0F1822",
    "--c-down": "#34D399",
    "--c-down-rgb": "52,211,153",
    "--c-edge": "#3E4E63",
    "--c-gray": "#7C8DA1",
    "--c-h06b6d4": "#06B6D4",
    "--c-h0b1220": "#0B1220",
    "--c-h0b131d": "#0B131D",
    "--c-h0b1420": "#0B1420",
    "--c-h0e1622": "#0E1622",
    "--c-h0e7490": "#0E7490",
    "--c-h100c2a": "#100C2A",
    "--c-h101c29": "#101C29",
    "--c-h10b981": "#10B981",
    "--c-h111827": "#111827",
    "--c-h123329": "#123329",
    "--c-h131c28": "#131C28",
    "--c-h14532d": "#14532D",
    "--c-h14b8a6": "#14B8A6",
    "--c-h15202e": "#15202E",
    "--c-h16202e": "#16202E",
    "--c-h162131": "#162131",
    "--c-h1b2735": "#1B2735",
    "--c-h1c2a3a": "#1C2A3A",
    "--c-h1d4e7a": "#1D4E7A",
    "--c-h1e2a38": "#1E2A38",
    "--c-h233347": "#233347",
    "--c-h2a3546": "#2A3546",
    "--c-h2a3b50": "#2A3B50",
    "--c-h2c3b4e": "#2C3B4E",
    "--c-h2dd4bf": "#2DD4BF",
    "--c-h2e3d50": "#2E3D50",
    "--c-h334155": "#334155",
    "--c-h33465c": "#33465C",
    "--c-h344860": "#344860",
    "--c-h38bdf8": "#38BDF8",
    "--c-h3a2a12": "#3A2A12",
    "--c-h3b1d1d": "#3B1D1D",
    "--c-h3b82f6": "#3B82F6",
    "--c-h3e7a8c": "#3E7A8C",
    "--c-h3f1d1d": "#3F1D1D",
    "--c-h4ade80": "#4ADE80",
    "--c-h5a6b80": "#5A6B80",
    "--c-h6e7f93": "#6E7F93",
    "--c-h6ee7b7": "#6EE7B7",
    "--c-h7f1d1d": "#7F1D1D",
    "--c-h7f3a3a": "#7F3A3A",
    "--c-h818cf8": "#818CF8",
    "--c-h8a97a8": "#8A97A8",
    "--c-h8fa3b8": "#8FA3B8",
    "--c-h8fa3ba": "#8FA3BA",
    "--c-h9fb3c8": "#9FB3C8",
    "--c-h9fd8f6": "#9FD8F6",
    "--c-ha33a36": "#A33A36",
    "--c-ha3e635": "#A3E635",
    "--c-ha5f3fc": "#A5F3FC",
    "--c-hb9c8d9": "#B9C8D9",
    "--c-hbfdbfe": "#BFDBFE",
    "--c-hc084fc": "#C084FC",
    "--c-hccfbf1": "#CCFBF1",
    "--c-hd8e6f2": "#D8E6F2",
    "--c-hdce6f0": "#DCE6F0",
    "--c-he2e8f0": "#E2E8F0",
    "--c-he6edf5": "#E6EDF5",
    "--c-he6edf6": "#E6EDF6",
    "--c-he6eef8": "#E6EEF8",
    "--c-he6f4ff": "#E6F4FF",
    "--c-he879f9": "#E879F9",
    "--c-he8a33d": "#E8A33D",
    "--c-hf472b6": "#F472B6",
    "--c-hf97316": "#F97316",
    "--c-hfb7185": "#FB7185",
    "--c-hfecaca": "#FECACA",
    "--c-hfef2f2": "#FEF2F2",
    "--c-info": "#60A5FA",
    "--c-line": "#243244",
    "--c-muted": "#9FB0C3",
    "--c-purple": "#A78BFA",
    "--c-r001": "rgba(79,195,247,.22)",
    "--c-r002": "rgba(79,195,247,.3)",
    "--c-r003": "rgba(14,116,144,.16)",
    "--c-r004": "rgba(0,0,0,.5)",
    "--c-r005": "rgba(251,191,36,.12)",
    "--c-r006": "rgba(79,195,247,.06)",
    "--c-r007": "rgba(16,24,36,.95)",
    "--c-r008": "rgba(2,6,23,.72)",
    "--c-r009": "rgba(79,195,247,.08)",
    "--c-r010": "rgba(248,113,113,.14)",
    "--c-r011": "rgba(255,255,255,.02)",
    "--c-r012": "rgba(0,0,0,.3)",
    "--c-r013": "rgba(248,113,113,.12)",
    "--c-r014": "rgba(255,255,255,.08)",
    "--c-r015": "rgba(255,255,255,.18)",
    "--c-r016": "rgba(79,195,247,.12)",
    "--c-r017": "rgba(0,0,0,.6)",
    "--c-r018": "rgba(14,116,144,.10)",
    "--c-r019": "rgba(16,24,36,.9)",
    "--c-r020": "rgba(239,68,68,0.10)",
    "--c-r021": "rgba(248,113,113,.10)",
    "--c-r022": "rgba(248,113,113,.4)",
    "--c-r023": "rgba(255,255,255,.12)",
    "--c-r024": "rgba(4,10,18,.72)",
    "--c-r025": "rgba(62,78,99,0.4)",
    "--c-r026": "rgba(6,12,20,.72)",
    "--c-r027": "rgba(79,195,247,.10)",
    "--c-r028": "rgba(14,116,144,.45)",
    "--c-r029": "rgba(248,113,113,.08)",
    "--c-r030": "rgba(251,191,36,.08)",
    "--c-r031": "rgba(255,255,255,.05)",
    "--c-r032": "rgba(255,255,255,.22)",
    "--c-r033": "rgba(255,255,255,.55)",
    "--c-r034": "rgba(255,255,255,.88)",
    "--c-r035": "rgba(52,211,153,.08)",
    "--c-r036": "rgba(56,189,248,.45)",
    "--c-r037": "rgba(56,189,248,.5)",
    "--c-r038": "rgba(62,78,99,.15)",
    "--c-r039": "rgba(79,195,247,.16)",
    "--c-r040": "rgba(0,0,0,.62)",
    "--c-r041": "rgba(251,191,36,.06)",
    "--c-r042": "rgba(79,195,247,.04)",
    "--c-r043": "rgba(79,195,247,.05)",
    "--c-r044": "rgba(79,195,247,.18)",
    "--c-r045": "rgba(79,195,247,.28)",
    "--c-r046": "rgba(79,195,247,.35)",
    "--c-r047": "rgba(79,195,247,.45)",
    "--c-r048": "rgba(79,195,247,.55)",
    "--c-surface": "#202E3F",
    "--c-surface-2": "#2A3A4E",
    "--c-text": "#F1F5F9",
    "--c-text-2": "#D8E2EF",
    "--c-up": "#F87171",
    "--c-up-rgb": "248,113,113",
    "--c-warn": "#FBBF24",
    "--c-warn-2": "#F59E0B",
    "--c-warn-ink": "#FCD34D",
    "--c-white": "#fff",
    "--c-white-full": "#FFFFFF"
  };
  var TOKENS = {
    "0001": "--c-edge",
    "0002": "--c-gray",
    "0003": "--c-muted",
    "0004": "--c-text",
    "0005": "--c-text-2",
    "0006": "--c-accent",
    "0007": "--c-bg",
    "0008": "--c-surface",
    "0009": "--c-line",
    "0010": "--c-up",
    "0011": "--c-warn",
    "0012": "--c-down",
    "0013": "--c-warn-2",
    "0014": "--c-warn-ink",
    "0015": "--c-accent-soft",
    "0016": "--c-surface-2",
    "0017": "--c-white",
    "0018": "--c-bg-deep",
    "0019": "--c-h3a2a12",
    "0020": "--c-purple",
    "0021": "--c-white-full",
    "0022": "--c-h8fa3ba",
    "0023": "--c-h111827",
    "0024": "--c-h0e7490",
    "0025": "--c-h6e7f93",
    "0026": "--c-r001",
    "0027": "--c-info",
    "0028": "--c-r002",
    "0029": "--c-bad-ink",
    "0030": "--c-r003",
    "0031": "--c-h2e3d50",
    "0032": "--c-accent-2",
    "0033": "--c-h4ade80",
    "0034": "--c-he6eef8",
    "0035": "--c-he8a33d",
    "0036": "--c-r004",
    "0037": "--c-h2a3b50",
    "0038": "--c-r005",
    "0039": "--c-h1b2735",
    "0040": "--c-r006",
    "0041": "--c-r007",
    "0042": "--c-h0b1220",
    "0043": "--c-h16202e",
    "0044": "--c-h38bdf8",
    "0045": "--c-h9fb3c8",
    "0046": "--c-r008",
    "0047": "--c-h2a3546",
    "0048": "--c-h2c3b4e",
    "0049": "--c-h9fd8f6",
    "0050": "--c-r009",
    "0051": "--c-h2dd4bf",
    "0052": "--c-ha5f3fc",
    "0053": "--c-hbfdbfe",
    "0054": "--c-r010",
    "0055": "--c-r011",
    "0056": "--c-h06b6d4",
    "0057": "--c-h1c2a3a",
    "0058": "--c-h334155",
    "0059": "--c-h344860",
    "0060": "--c-h8a97a8",
    "0061": "--c-he2e8f0",
    "0062": "--c-r012",
    "0063": "--c-r013",
    "0064": "--c-r014",
    "0065": "--c-r015",
    "0066": "--c-r016",
    "0067": "--c-h0e1622",
    "0068": "--c-h100c2a",
    "0069": "--c-h10b981",
    "0070": "--c-h131c28",
    "0071": "--c-h14b8a6",
    "0072": "--c-h15202e",
    "0073": "--c-h3b1d1d",
    "0074": "--c-h3b82f6",
    "0075": "--c-h3e7a8c",
    "0076": "--c-h3f1d1d",
    "0077": "--c-h5a6b80",
    "0078": "--c-h6ee7b7",
    "0079": "--c-h7f3a3a",
    "0080": "--c-hccfbf1",
    "0081": "--c-hdce6f0",
    "0082": "--c-he6edf5",
    "0083": "--c-he6edf6",
    "0084": "--c-hf472b6",
    "0085": "--c-hfecaca",
    "0086": "--c-hfef2f2",
    "0087": "--c-r017",
    "0088": "--c-r018",
    "0089": "--c-r019",
    "0090": "--c-r020",
    "0091": "--c-r021",
    "0092": "--c-r022",
    "0093": "--c-r023",
    "0094": "--c-r024",
    "0095": "--c-r025",
    "0096": "--c-h0b1420",
    "0097": "--c-h162131",
    "0098": "--c-h33465c",
    "0099": "--c-r026",
    "0100": "--c-r027",
    "0101": "--c-h14532d",
    "0102": "--c-h1d4e7a",
    "0103": "--c-h1e2a38",
    "0104": "--c-h7f1d1d",
    "0105": "--c-h818cf8",
    "0106": "--c-ha33a36",
    "0107": "--c-ha3e635",
    "0108": "--c-hc084fc",
    "0109": "--c-he6f4ff",
    "0110": "--c-he879f9",
    "0111": "--c-hf97316",
    "0112": "--c-hfb7185",
    "0113": "--c-r028",
    "0114": "--c-r029",
    "0115": "--c-r030",
    "0116": "--c-r031",
    "0117": "--c-r032",
    "0118": "--c-r033",
    "0119": "--c-r034",
    "0120": "--c-r035",
    "0121": "--c-r036",
    "0122": "--c-r037",
    "0123": "--c-r038",
    "0124": "--c-r039",
    "0125": "--c-h0b131d",
    "0126": "--c-h101c29",
    "0127": "--c-h123329",
    "0128": "--c-h233347",
    "0129": "--c-h8fa3b8",
    "0130": "--c-hb9c8d9",
    "0131": "--c-hd8e6f2",
    "0132": "--c-r040",
    "0133": "--c-r041",
    "0134": "--c-r042",
    "0135": "--c-r043",
    "0136": "--c-r044",
    "0137": "--c-r045",
    "0138": "--c-r046",
    "0139": "--c-r047",
    "0140": "--c-r048"
  };
  function css(name) {
    var v = "";
    try {
      if (g.getComputedStyle && g.document && g.document.documentElement) {
        v = g.getComputedStyle(g.document.documentElement).getPropertyValue(name) || "";
      }
    } catch (e) { }
    v = String(v).trim();
    if (!v) {
      // CSS 未加载时按当前主题取值，避免浅色下误回退深色字面量
      if (curEff === "light" && LIGHT[name] != null) v = LIGHT[name];
      else if (FALLBACK[name] != null) v = FALLBACK[name];
    }
    return v;
  }
  function sub(s) {
    if (s == null) return s;
    if (typeof s !== "string") s = String(s);
    return s.replace(/§WFT(\d{4})§/g, function (_, n) {
      var name = TOKENS[n];
      return name ? css(name) : _;
    });
  }

  /* ───────────────── v0.93 主题状态机 ───────────────── */
  var KEY = "wufu_theme_v1";
  var curEff = "dark";                 // 当前生效主题
  var sysMQ = null;
  try { sysMQ = g.matchMedia ? g.matchMedia("(prefers-color-scheme: light)") : null; } catch (e) { }

  function mode() {
    var m = "dark";
    try { m = g.localStorage.getItem(KEY) || "dark"; } catch (e) { }
    return (m === "light" || m === "system") ? m : "dark";
  }
  function effective(m) {
    if (m === "light") return "light";
    if (m === "system") return (sysMQ && sysMQ.matches) ? "light" : "dark";
    return "dark";
  }
  function apply() {
    var eff = effective(mode());
    var de = g.document && g.document.documentElement;
    if (de) {
      // 默认深色【不设 data-theme】：:root 原值、无 color-scheme 变化 → 零回归
      if (eff === "light") de.setAttribute("data-theme", "light");
      else de.removeAttribute("data-theme");
    }
    var meta = g.document && g.document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", eff === "light" ? "#f4f5f7" : "#0E7490");
    curEff = eff;
    return eff;
  }

  /* 颜色字面量 → 变量名 的反向表。深色 142 值唯一、浅色 145 值唯一，
     且两集合不交，所以「切前主题的值 → 变量 → 切后主题的值」无歧义。 */
  var DARK_BY_VAL = {}, LIGHT_BY_VAL = {};
  Object.keys(FALLBACK).forEach(function (k) { if (DARK_BY_VAL[FALLBACK[k]] == null) DARK_BY_VAL[FALLBACK[k]] = k; });
  Object.keys(LIGHT).forEach(function (k) { if (LIGHT_BY_VAL[LIGHT[k]] == null) LIGHT_BY_VAL[LIGHT[k]] = k; });
  var COLOR_RE = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g;

  function replaceStr(s, fromMap) {
    if (typeof s !== "string" || !s) return s;
    return s.replace(COLOR_RE, function (tok) {
      var name = fromMap[tok];
      if (name == null) return tok;
      var nv = css(name);
      return nv || tok;
    });
  }
  function replaceDeep(o, fromMap, seen) {
    if (o == null) return o;
    if (typeof o === "string") return replaceStr(o, fromMap);
    if (typeof o !== "object") return o;
    if (seen.indexOf(o) >= 0) return o;
    seen.push(o);
    if (Object.prototype.toString.call(o) === "[object Array]") {
      for (var i = 0; i < o.length; i++) o[i] = replaceDeep(o[i], fromMap, seen);
    } else {
      Object.keys(o).forEach(function (k) { o[k] = replaceDeep(o[k], fromMap, seen); });
    }
    return o;
  }

  /* 切主题后重算 sub() 产物：CSS 变量层本来就自动生效，这里只管静态颜色值。 */
  function refresh(fromEff) {
    var fromMap = fromEff === "light" ? LIGHT_BY_VAL : DARK_BY_VAL;
    var doc = g.document;
    if (!doc) return;
    var ATTRS = ["style", "fill", "stroke", "stop-color", "color", "bgcolor", "border-color"];
    try {
      var els = doc.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        for (var j = 0; j < ATTRS.length; j++) {
          var a = ATTRS[j];
          if (!el.hasAttribute || !el.hasAttribute(a)) continue;
          var old = el.getAttribute(a);
          var nw = replaceStr(old, fromMap);
          if (nw !== old) el.setAttribute(a, nw);
        }
      }
    } catch (e) { }
    /* ECharts：容器带 _echarts_instance_ 标记，取回当前 option 换色后整份重给 */
    try {
      if (g.echarts && g.echarts.getInstanceByDom) {
        var doms = doc.querySelectorAll("[_echarts_instance_]");
        for (var d = 0; d < doms.length; d++) {
          var inst = g.echarts.getInstanceByDom(doms[d]);
          if (!inst || !inst.getOption) continue;
          var opt = inst.getOption();
          if (!opt) continue;
          var nopt = replaceDeep(opt, fromMap, []);
          inst.setOption(nopt, true);
        }
      }
    } catch (e2) { }
    try {
      doc.dispatchEvent(new g.CustomEvent("wufuthemechange",
        { detail: { mode: mode(), effective: curEff } }));
    } catch (e3) { }
  }

  function set(m) {
    m = (m === "light" || m === "system") ? m : "dark";
    var before = curEff;
    try { g.localStorage.setItem(KEY, m); } catch (e) { }
    var after = apply();
    if (before !== after) refresh(before);
    else {
      try { g.document.dispatchEvent(new g.CustomEvent("wufuthemechange",
        { detail: { mode: m, effective: after } })); } catch (e2) { }
    }
    return m;
  }
  function onChange(fn) {
    if (typeof fn !== "function" || !g.document) return;
    g.document.addEventListener("wufuthemechange", fn);
  }

  /* 同源 iframe / 其他标签页：写入方自己已 apply，这里只跟着同步 */
  if (g.addEventListener) {
    g.addEventListener("storage", function (e) {
      if (!e || e.key !== KEY) return;
      var before = curEff, after = apply();
      if (before !== after) refresh(before);
    }, false);
    if (sysMQ) {
      var sysChange = function () {
        if (mode() !== "system") return;
        var before = curEff, after = apply();
        if (before !== after) refresh(before);
      };
      if (sysMQ.addEventListener) sysMQ.addEventListener("change", sysChange);
      else if (sysMQ.addListener) sysMQ.addListener(sysChange);
    }
  }
  /* 统一注入切换键：所有页面都引 theme.js，包括不引 header.js 的 tool.html。
     iframe 内不注入（顶栏被隐藏），靠 storage 事件同步即可。 */
  function injectToggle() {
    var doc = g.document;
    if (!doc) return;
    try { if (g.top !== g) return; } catch (e) { return; }
    if (doc.getElementById("wufuThemeSel")) return;
    var host = doc.querySelector(".wh-top") || doc.querySelector("header") || null;
    if (!host) return;
    var sel = doc.createElement("select");
    sel.id = "wufuThemeSel"; sel.className = "wh-theme";
    sel.setAttribute("aria-label", "界面主题");
    sel.innerHTML = '<option value="dark">深色</option>' +
                    '<option value="light">浅色</option>' +
                    '<option value="system">跟随系统</option>';
    sel.value = mode();
    /* 内联兜底样式：tool.html 不引 header.css，必须自带；.wh-top 里 badge 已有 auto 边距 */
    var inWhTop = host.className && String(host.className).indexOf("wh-top") >= 0;
    sel.style.cssText = "flex:none;" + (inWhTop ? "" : "margin-left:auto;") +
      "margin-right:2px;font-size:11px;line-height:1.4;padding:4px 6px;border-radius:6px;" +
      "cursor:pointer;max-width:88px;outline:none;font-family:inherit";
    /* 页面里 select{color:...!important} 会压过普通内联样式；内联 important 优先级最高 */
    ["color", "background-color", "border-color"].forEach(function (p, i) {
      sel.style.setProperty(p, ["var(--c-on-brand)", "var(--c-surface)", "var(--c-edge)"][i], "important");
    });
    sel.style.setProperty("border", "1px solid var(--c-edge)", "important");
    sel.addEventListener("change", function () { set(sel.value); });
    onChange(function () { sel.value = mode(); });
    host.appendChild(sel);
  }
  if (g.document) {
    if (g.document.readyState === "loading")
      g.document.addEventListener("DOMContentLoaded", injectToggle);
    else injectToggle();
  }
  /* head 里同步执行：首屏 paint 前设好，不闪深色 */
  apply();

  g.WufuTheme = { css: css, sub: sub, tokens: TOKENS, fallback: FALLBACK,
    light: LIGHT, mode: mode, effective: effective, apply: apply,
    set: set, refresh: refresh, onChange: onChange };
})(typeof window !== "undefined" ? window : this);
