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
  /* v0.95：浅色值取自文章界面截图色板，深色主色换亮绿族；
     两表各自唯一，refresh() 按主题分表反查，深浅重合不产生歧义。 */
  var UI_LIGHT = {"--ui-sunken":"#E9EEEB","--ui-line-strong":"#C3DDD0","--ui-ink-2":"#3D4A45","--ui-ink-3":"#738079","--ui-accent-hover":"#0E6A4F","--ui-accent-soft":"#EDF6F0","--ui-accent-line":"#C3DDD0","--ui-accent-ink":"#0B5D46","--ui-ok":"#147D5E","--ui-ok-soft":"#EDF6F0","--ui-ok-line":"#C3DDD0","--ui-warn":"#B45309","--ui-warn-soft":"#FFF7E7","--ui-warn-line":"#F1CEA7","--ui-warn-ink":"#8A5A10","--ui-bad":"#D65359","--ui-bad-soft":"#FFF0EF","--ui-bad-line":"#F1CCCC","--ui-legacy-warn":"#B45309","--ui-legacy-ok":"#147D5E","--ui-legacy-bad":"#C0392B","--ui-legacy-muted":"#738079","--ui-legacy-muted-2":"#73807A","--ui-legacy-muted-3":"#73807B","--ui-legacy-line":"#147D5E","--ui-legacy-surface":"rgba(32,39,37,.045)"};
  var UI_DARK  = {"--ui-sunken":"#2A3A4E","--ui-line-strong":"#3E4E63","--ui-ink-2":"#D8E2EF","--ui-ink-3":"#9FB0C3","--ui-accent-hover":"#22D3EE","--ui-accent-soft":"#233347","--ui-accent-line":"#1D4E7A","--ui-accent-ink":"#BFDBFE","--ui-ok":"#34D399","--ui-ok-soft":"#123329","--ui-ok-line":"#14532D","--ui-warn":"#FBBF24","--ui-warn-soft":"#3A2A12","--ui-warn-line":"#E8A33D","--ui-warn-ink":"#FCD34D","--ui-bad":"#F87171","--ui-bad-soft":"#3B1D1D","--ui-bad-line":"#7F1D1D","--ui-legacy-warn":"#c07a00","--ui-legacy-ok":"#1a9d5a","--ui-legacy-bad":"#c0392b","--ui-legacy-muted":"#888","--ui-legacy-muted-2":"#999","--ui-legacy-muted-3":"#aaa","--ui-legacy-line":"#2b6cb0","--ui-legacy-surface":"rgba(127,127,127,.07)"};
  var LEGACY = {
    "#c07a00": "--ui-legacy-warn", "#1a9d5a": "--ui-legacy-ok",
    "#c0392b": "--ui-legacy-bad", "#888": "--ui-legacy-muted",
    "#999": "--ui-legacy-muted-2", "#aaa": "--ui-legacy-muted-3",
    "#2b6cb0": "--ui-legacy-line",
    "rgba(127,127,127,.07)": "--ui-legacy-surface"
  };
  var LIGHT = {"--c-accent":"#147D5E","--c-accent-2":"#258663","--c-accent-soft":"#EDF6F0","--c-bg":"#F6F8F7","--c-bg-deep":"#E9EEEB","--c-surface":"#FFFFFF","--c-surface-2":"#FAFCFB","--c-line":"#E9EEEC","--c-edge":"#C3DDD0","--c-text":"#202725","--c-text-2":"#3D4A45","--c-muted":"#738079","--c-gray":"#73807A","--c-up":"#D65359","--c-up-rgb":"214,83,89","--c-down":"#147D5F","--c-down-rgb":"20,125,94","--c-warn":"#B45309","--c-warn-2":"#F1CEA7","--c-warn-ink":"#8A5A10","--c-bad-ink":"#C0392B","--c-info":"#0E7490","--c-purple":"#7C5CBF","--c-white":"#FFFFFE","--c-white-full":"#FFFFFC","--c-brand-a":"#FFFFFB","--c-brand-b":"#F0F6F2","--c-on-brand":"#111816","--c-h06b6d4":"#188193","--c-h0b1220":"#ECEDF0","--c-h0b131d":"#EDEEF1","--c-h0b1420":"#ECEEF0","--c-h0e1622":"#EBEDF0","--c-h0e7490":"#16718A","--c-h100c2a":"#EBEBEF","--c-h101c29":"#EAECEF","--c-h10b981":"#179068","--c-h111827":"#1F2937","--c-h123329":"#E8EDEC","--c-h131c28":"#EAECEE","--c-h14532d":"#BFE3D2","--c-h14b8a6":"#B45309","--c-h15202e":"#E9EBEE","--c-h16202e":"#E9EBED","--c-h162131":"#E8EAED","--c-h1b2735":"#E7E9EC","--c-h1c2a3a":"#E6E9EB","--c-h1d4e7a":"#237D7A","--c-h1e2a38":"#E6E9EC","--c-h233347":"#E3E6E9","--c-h2a3546":"#E2E5E9","--c-h2a3b50":"#D4DAE1","--c-h2c3b4e":"#D4DAE2","--c-h2dd4bf":"#1A769F","--c-h2e3d50":"#D3D9E1","--c-h334155":"#334156","--c-h33465c":"#CFD6DE","--c-h344860":"#CED5DD","--c-h38bdf8":"#1A769F","--c-h3a2a12":"#EDEBE8","--c-h3b1d1d":"#EBE6E6","--c-h3b82f6":"#27928F","--c-h3e7a8c":"#C2D0D5","--c-h3f1d1d":"#EBE5E5","--c-h4ade80":"#1B9D4A","--c-h5a6b80":"#BFC7D2","--c-h6e7f93":"#B8C0CA","--c-h6ee7b7":"#1BA46E","--c-h7f1d1d":"#F3C7C9","--c-h7f3a3a":"#D7C6C6","--c-h818cf8":"#2A9C99","--c-h8a97a8":"#282E36","--c-h8fa3b8":"#28333F","--c-h8fa3ba":"#273340","--c-h9fb3c8":"#2A3949","--c-h9fd8f6":"#1C7BAE","--c-ha33a36":"#812D2A","--c-ha3e635":"#6B9C19","--c-ha5f3fc":"#1DA0AF","--c-hb9c8d9":"#2F4054","--c-hbfdbfe":"#2BA19D","--c-hc084fc":"#26A177","--c-hccfbf1":"#5B4B9E","--c-hd8e6f2":"#379592","--c-hdce6f0":"#374D62","--c-he2e8f0":"#384B64","--c-he6edf5":"#3E8E8C","--c-he6edf6":"#3A928F","--c-he6eef8":"#319B98","--c-he6f4ff":"#2BA19E","--c-he879f9":"#259F83","--c-he8a33d":"#9D681A","--c-hf472b6":"#259D97","--c-hf97316":"#9A4E19","--c-hfb7185":"#A81B30","--c-hfecaca":"#AF1D1D","--c-hfef2f2":"#F3C7C9","--c-r001":"rgba(31,129,173,0.2207)","--c-r002":"rgba(31,129,173,0.3014)","--c-r003":"rgba(18,86,105,0.1621)","--c-r004":"rgba(15,23,42,0.3928)","--c-r005":"rgba(173,134,31,0.1235)","--c-r006":"rgba(31,129,173,0.0642)","--c-r007":"#FFFFFF","--c-r008":"rgba(15,23,42,0.5627)","--c-r009":"rgba(31,129,173,0.0814)","--c-r010":"rgba(173,31,31,0.1421)","--c-r011":"rgba(15,23,42,0.0258)","--c-r012":"rgba(15,23,42,0.2375)","--c-r013":"rgba(173,31,31,0.1242)","--c-r014":"rgba(15,23,42,0.092)","--c-r015":"rgba(15,23,42,0.2077)","--c-r016":"rgba(31,129,173,0.1214)","--c-r017":"rgba(15,23,42,0.4701)","--c-r018":"rgba(18,86,105,0.1028)","--c-r019":"rgba(15,23,42,0.7055)","--c-r020":"rgba(173,31,31,0.1042)","--c-r021":"rgba(173,31,31,0.1)","--c-r022":"rgba(173,31,31,0.4007)","--c-r023":"rgba(15,23,42,0.1394)","--c-r024":"rgba(15,23,42,0.5641)","--c-r025":"rgba(48,61,77,0.4028)","--c-r026":"rgba(15,23,42,0.5655)","--c-r027":"rgba(31,129,173,0.1042)","--c-r028":"rgba(18,86,105,0.45)","--c-r029":"rgba(173,31,31,0.0807)","--c-r030":"rgba(173,134,31,0.0814)","--c-r031":"rgba(15,23,42,0.0596)","--c-r032":"rgba(15,23,42,0.2558)","--c-r033":"rgba(15,23,42,0.3035)","--c-r034":"rgba(15,23,42,0.3042)","--c-r035":"rgba(36,168,120,0.08)","--c-r036":"rgba(31,130,173,0.4507)","--c-r037":"rgba(31,130,173,0.5014)","--c-r038":"rgba(48,61,77,0.1521)","--c-r039":"rgba(31,129,173,0.1628)","--c-r040":"rgba(15,23,42,0.4875)","--c-r041":"rgba(173,134,31,0.0642)","--c-r042":"rgba(31,129,173,0.04)","--c-r043":"rgba(31,129,173,0.0507)","--c-r044":"rgba(31,129,173,0.1814)","--c-r045":"rgba(31,129,173,0.2821)","--c-r046":"rgba(31,129,173,0.3528)","--c-r047":"rgba(31,129,173,0.4535)","--c-r048":"rgba(31,129,173,0.5542)","--ui-sunken":"#E9EEEE","--ui-line-strong":"#C3DDD1","--ui-ink-2":"#3D4A46","--ui-ink-3":"#73807C","--ui-accent-hover":"#0E6A4F","--ui-accent-soft":"#EDF6F1","--ui-accent-line":"#C3DDD3","--ui-accent-ink":"#0B5D46","--ui-ok":"#147D61","--ui-ok-soft":"#EDF6F3","--ui-ok-line":"#C3DDD6","--ui-warn":"#B4530A","--ui-warn-soft":"#FFF7E7","--ui-warn-line":"#F1CEA8","--ui-warn-ink":"#8A5A11","--ui-bad":"#D6535A","--ui-bad-soft":"#FFF0EF","--ui-bad-line":"#F1CCCC","--ui-legacy-warn":"#B4530C","--ui-legacy-ok":"#147D64","--ui-legacy-bad":"#C0392C","--ui-legacy-muted":"#73807F","--ui-legacy-muted-2":"#73807B","--ui-legacy-muted-3":"#73807E","--ui-legacy-line":"#147D68","--ui-legacy-surface":"rgba(32,39,37,.045)","--chart-tip-bg":"#FFFFFF","--chart-tip-ink":"#202725","--chart-tip-line":"#C3DDD0","--chart-axis-ink":"#738079","--chart-grid":"#E9EEEC","--chart-heat-neg":"#F3C7C9","--chart-heat-mid":"#F6F8F7","--chart-heat-pos":"#BFE3D2","--chart-s1":"#147D5E","--chart-s2":"#B45309","--chart-s3":"#5B4B9E","--chart-s4":"#D65359","--chart-s5":"#1A769F","--chart-s6":"#5A6B64"};
  var FALLBACK = {"--c-accent":"#4FC3F7","--c-accent-2":"#22D3EE","--c-accent-soft":"#7DD3FC","--c-bad-ink":"#FCA5A5","--c-bg":"#1B2634","--c-bg-deep":"#0F1822","--c-down":"#34D399","--c-down-rgb":"52,211,153","--c-edge":"#3E4E63","--c-gray":"#7C8DA1","--c-h06b6d4":"#06B6D4","--c-h0b1220":"#0B1220","--c-h0b131d":"#0B131D","--c-h0b1420":"#0B1420","--c-h0e1622":"#0E1622","--c-h0e7490":"#0E7490","--c-h100c2a":"#100C2A","--c-h101c29":"#101C29","--c-h10b981":"#10B981","--c-h111827":"#111827","--c-h123329":"#123329","--c-h131c28":"#131C28","--c-h14532d":"#14532D","--c-h14b8a6":"#FBBF24","--c-h15202e":"#15202E","--c-h16202e":"#16202E","--c-h162131":"#162131","--c-h1b2735":"#1B2735","--c-h1c2a3a":"#1C2A3A","--c-h1d4e7a":"#1D4E7A","--c-h1e2a38":"#1E2A38","--c-h233347":"#233347","--c-h2a3546":"#2A3546","--c-h2a3b50":"#2A3B50","--c-h2c3b4e":"#2C3B4E","--c-h2dd4bf":"#38BDF8","--c-h2e3d50":"#2E3D50","--c-h334155":"#334155","--c-h33465c":"#33465C","--c-h344860":"#344860","--c-h38bdf8":"#38BDF8","--c-h3a2a12":"#3A2A12","--c-h3b1d1d":"#3B1D1D","--c-h3b82f6":"#3B82F6","--c-h3e7a8c":"#3E7A8C","--c-h3f1d1d":"#3F1D1D","--c-h4ade80":"#4ADE80","--c-h5a6b80":"#5A6B80","--c-h6e7f93":"#6E7F93","--c-h6ee7b7":"#6EE7B7","--c-h7f1d1d":"#7F1D1D","--c-h7f3a3a":"#7F3A3A","--c-h818cf8":"#818CF8","--c-h8a97a8":"#8A97A8","--c-h8fa3b8":"#8FA3B8","--c-h8fa3ba":"#8FA3BA","--c-h9fb3c8":"#9FB3C8","--c-h9fd8f6":"#9FD8F6","--c-ha33a36":"#A33A36","--c-ha3e635":"#A3E635","--c-ha5f3fc":"#A5F3FC","--c-hb9c8d9":"#B9C8D9","--c-hbfdbfe":"#BFDBFE","--c-hc084fc":"#C084FC","--c-hccfbf1":"#A78BFA","--c-hd8e6f2":"#D8E6F2","--c-hdce6f0":"#DCE6F0","--c-he2e8f0":"#E2E8F0","--c-he6edf5":"#E6EDF5","--c-he6edf6":"#E6EDF6","--c-he6eef8":"#E6EEF8","--c-he6f4ff":"#E6F4FF","--c-he879f9":"#E879F9","--c-he8a33d":"#E8A33D","--c-hf472b6":"#F472B6","--c-hf97316":"#F97316","--c-hfb7185":"#FB7185","--c-hfecaca":"#FECACA","--c-hfef2f2":"#FEF2F2","--c-info":"#60A5FA","--c-line":"#243244","--c-muted":"#9FB0C3","--c-purple":"#A78BFA","--c-r001":"rgba(79,195,247,.22)","--c-r002":"rgba(79,195,247,.3)","--c-r003":"rgba(14,116,144,.16)","--c-r004":"rgba(0,0,0,.5)","--c-r005":"rgba(251,191,36,.12)","--c-r006":"rgba(79,195,247,.06)","--c-r007":"rgba(16,24,36,.95)","--c-r008":"rgba(2,6,23,.72)","--c-r009":"rgba(79,195,247,.08)","--c-r010":"rgba(248,113,113,.14)","--c-r011":"rgba(255,255,255,.02)","--c-r012":"rgba(0,0,0,.3)","--c-r013":"rgba(248,113,113,.12)","--c-r014":"rgba(255,255,255,.08)","--c-r015":"rgba(255,255,255,.18)","--c-r016":"rgba(79,195,247,.12)","--c-r017":"rgba(0,0,0,.6)","--c-r018":"rgba(14,116,144,.10)","--c-r019":"rgba(16,24,36,.9)","--c-r020":"rgba(239,68,68,0.10)","--c-r021":"rgba(248,113,113,.10)","--c-r022":"rgba(248,113,113,.4)","--c-r023":"rgba(255,255,255,.12)","--c-r024":"rgba(4,10,18,.72)","--c-r025":"rgba(62,78,99,0.4)","--c-r026":"rgba(6,12,20,.72)","--c-r027":"rgba(79,195,247,.10)","--c-r028":"rgba(14,116,144,.45)","--c-r029":"rgba(248,113,113,.08)","--c-r030":"rgba(251,191,36,.08)","--c-r031":"rgba(255,255,255,.05)","--c-r032":"rgba(255,255,255,.22)","--c-r033":"rgba(255,255,255,.55)","--c-r034":"rgba(255,255,255,.88)","--c-r035":"rgba(52,211,153,.08)","--c-r036":"rgba(56,189,248,.45)","--c-r037":"rgba(56,189,248,.5)","--c-r038":"rgba(62,78,99,.15)","--c-r039":"rgba(79,195,247,.16)","--c-r040":"rgba(0,0,0,.62)","--c-r041":"rgba(251,191,36,.06)","--c-r042":"rgba(79,195,247,.04)","--c-r043":"rgba(79,195,247,.05)","--c-r044":"rgba(79,195,247,.18)","--c-r045":"rgba(79,195,247,.28)","--c-r046":"rgba(79,195,247,.35)","--c-r047":"rgba(79,195,247,.45)","--c-r048":"rgba(79,195,247,.55)","--c-surface":"#202E3F","--c-surface-2":"#2A3A4E","--c-text":"#F1F5F9","--c-text-2":"#D8E2EF","--c-up":"#F87171","--c-up-rgb":"248,113,113","--c-warn":"#FBBF24","--c-warn-2":"#F59E0B","--c-warn-ink":"#FCD34D","--c-white":"#fff","--c-white-full":"#FFFFFF","--c-brand-a":"#1B2635","--c-brand-b":"#0E7490","--c-on-brand":"#fff ","--ui-sunken":"#2A3A4F","--ui-line-strong":"#3E4E64","--ui-ink-2":"#D8E2F0","--ui-ink-3":"#9FB0C4","--ui-accent-hover":"#22D3EE","--ui-accent-soft":"#233347","--ui-accent-line":"#1D4E7A","--ui-accent-ink":"#BFDBFE","--ui-ok":"#34D39A","--ui-ok-soft":"#12332C","--ui-ok-line":"#14532E","--ui-warn":"#FBBF25","--ui-warn-soft":"#3A2A13","--ui-warn-line":"#E8A33E","--ui-warn-ink":"#FCD34E","--ui-bad":"#F87172","--ui-bad-soft":"#3B1D1E","--ui-bad-line":"#7F1D1E","--ui-legacy-warn":"#c07a00","--ui-legacy-ok":"#1a9d5a","--ui-legacy-bad":"#c0392b","--ui-legacy-muted":"#888","--ui-legacy-muted-2":"#999","--ui-legacy-muted-3":"#aaa","--ui-legacy-line":"#2b6cb0","--ui-legacy-surface":"rgba(127,127,127,.07)","--chart-tip-bg":"#233247","--chart-tip-ink":"#E8EEF6","--chart-tip-line":"#3E4E63","--chart-axis-ink":"#9FB0C4","--chart-grid":"#243244","--chart-heat-neg":"#7F1D1D","--chart-heat-mid":"#22354A","--chart-heat-pos":"#14532D","--chart-s1":"#4FC3F7","--chart-s2":"#FBBF24","--chart-s3":"#A78BFA","--chart-s4":"#F87171","--chart-s5":"#34D399","--chart-s6":"#94A3B8"};
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
  /* ECharts getOption() 会把颜色规范化（hex 小写、rgba 补 0、去空格、.95→0.95）。
     反查表与待替换串都走同一归一化，否则切主题时值匹配不上、图表停在首屏配色。 */
  function normColor(c) {
    if (!c) return c;
    var x = String(c).trim().toLowerCase().replace(/\s+/g, "");
    x = x.replace(/,0+(\d)/g, ",$1").replace(/,\.(\d)/g, ",0.$1");
    x = x.replace(/,0\./g, ",.");          // 0.741 → .741 与 FALLBACK 写法统一
    if (/^#[0-9a-f]{3}$/.test(x)) x = "#" + x[1]+x[1]+x[2]+x[2]+x[3]+x[3];
    return x;
  }
  Object.keys(FALLBACK).forEach(function (k) { var n=normColor(FALLBACK[k]); if (DARK_BY_VAL[n] == null) DARK_BY_VAL[n] = k; });
  Object.keys(LIGHT).forEach(function (k) { var n=normColor(LIGHT[k]); if (LIGHT_BY_VAL[n] == null) LIGHT_BY_VAL[n] = k; });
  var COLOR_RE = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g;


  /* 遗留色统一替换：按「登记的字面量 → 变量 → 当前主题值」逐项换，
     不依赖 value→name 反查表，故浅色值重复也不会歧义。 */
  function legacyReplace(s, fromEff) {
    if (typeof s !== "string" || !s) return s;
    var out = s;
    Object.keys(LEGACY).forEach(function (lit) {
      var name = LEGACY[lit];
      var oldVal = fromEff === "light" ? LIGHT[name] : FALLBACK[name];
      if (!oldVal) return;
      if (out.indexOf(oldVal) >= 0) out = out.split(oldVal).join(css(name));
      if (out.indexOf(lit) >= 0) out = out.split(lit).join(css(name));
    });
    return out;
  }
  function replaceStr(s, fromMap, fromEff) {
    if (typeof s !== "string" || !s) return s;
    var s2 = legacyReplace(s, fromEff);
    return s2.replace(COLOR_RE, function (tok) {
      var name = fromMap[normColor(tok)];
      if (name == null) return tok;
      var nv = css(name);
      return nv || tok;
    });
  }
  function replaceDeep(o, fromMap, seen, fromEff) {
    if (o == null) return o;
    if (typeof o === "string") return replaceStr(o, fromMap, fromEff);
    if (typeof o !== "object") return o;
    if (seen.indexOf(o) >= 0) return o;
    seen.push(o);
    if (Object.prototype.toString.call(o) === "[object Array]") {
      for (var i = 0; i < o.length; i++) o[i] = replaceDeep(o[i], fromMap, seen, fromEff);
    } else {
      Object.keys(o).forEach(function (k) { o[k] = replaceDeep(o[k], fromMap, seen, fromEff); });
    }
    return o;
  }

  /* 切主题后重算 sub() 产物：CSS 变量层本来就自动生效，这里只管静态颜色值。 */
  /* ── v0.98：图表浮层 / 热力图按语义变量显式重设 ──────────────────
     richText tooltip 由 zrender 画在 canvas 上，DOM 扫描改不到；且很多 tooltip
     根本没写 backgroundColor，用 ECharts 内置深灰。这里对每个实例整份重给，
     不依赖值反查，深浅两态都拿到正确的浮层与热力图底色。 */
  function syncCharts() {
    if (!g.echarts || !g.echarts.getInstanceByDom || !g.document) return;
    var doms = g.document.querySelectorAll("[_echarts_instance_]");
    for (var d = 0; d < doms.length; d++) {
      var inst = g.echarts.getInstanceByDom(doms[d]);
      if (!inst || !inst.getOption || !inst.setOption) continue;
      var opt;
      try { opt = inst.getOption(); } catch (e) { continue; }
      if (!opt) continue;
      var tipBg = css("--chart-tip-bg"), tipInk = css("--chart-tip-ink"),
          tipLine = css("--chart-tip-line"), axisInk = css("--chart-axis-ink");
      if (!tipBg) continue;
      var changed = false;
      /* 幂等：标记写在容器上，不靠 option 值推断。ECharts 默认 tooltip 恰好是
         #fff，与浅色目标归一化后相等，若按值判断会误判「已同步」而漏掉
         textStyle / 边框 / 热力图；同时 setOption 改动内部 DOM 会再触发
         MutationObserver，不幂等就会死循环。切主题时 tipBg 变化，标记自然失效。 */
      try {
        if (doms[d].getAttribute("data-wufu-chart-sync") === tipBg) continue;
      } catch (e6) { }
      try { doms[d].setAttribute("data-wufu-chart-sync", tipBg); } catch (e7) { }
      /* tooltip：白底墨字（浅）/ 深底浅字（深），细边、小内边距，不再压住曲线 */
      if (opt.tooltip && opt.tooltip.length) {
        for (var t = 0; t < opt.tooltip.length; t++) {
          var tt = opt.tooltip[t]; if (!tt) continue;
          tt.backgroundColor = tipBg; tt.borderColor = tipLine; tt.borderWidth = 1;
          tt.textStyle = Object.assign({}, tt.textStyle || {}, { color: tipInk });
          tt.padding = [7, 9]; tt.confine = true;
          changed = true;
        }
      }
      /* visualMap / 热力图：深底用深红-深灰-深绿，浅底用粉-浅灰-浅绿，不再装反 */
      var hn = css("--chart-heat-neg"), hm = css("--chart-heat-mid"), hp = css("--chart-heat-pos");
      if (hn && opt.visualMap && opt.visualMap.length) {
        for (var v = 0; v < opt.visualMap.length; v++) {
          var vm = opt.visualMap[v]; if (!vm) continue;
          var old = vm.inRange && vm.inRange.color;
          if (vm.inRange) {
            vm.inRange.color = old && old.length >= 4
              ? [hn, hm, hm, hp] : [hn, hm, hp];
            if (vm.textStyle) vm.textStyle.color = axisInk;
            changed = true;
          }
        }
      }
      /* 轴 / 图例文字跟随主题 */
      ["xAxis", "yAxis"].forEach(function (ax) {
        (opt[ax] || []).forEach(function (a) {
          if (a && a.axisLabel) { a.axisLabel.color = axisInk; changed = true; }
          if (a && a.axisLine && a.axisLine.lineStyle) { a.axisLine.lineStyle.color = tipLine; changed = true; }
          if (a && a.splitLine && a.splitLine.lineStyle) { a.splitLine.lineStyle.color = css("--chart-grid"); changed = true; }
        });
      });
      (opt.legend || []).forEach(function (lg) {
        if (lg && lg.textStyle) { lg.textStyle.color = axisInk; changed = true; }
      });
      if (changed) { try { inst.setOption(opt, true); } catch (e2) { } }
    }
  }
  /* 首屏图表是异步 init 的：监听容器出现，防抖同步一次。切主题由 refresh() 调用。 */
  function watchCharts() {
    if (!g.document || !g.MutationObserver) return;
    var timer = null;
    var kick = function () {
      if (timer) return;
      timer = setTimeout(function () { timer = null; syncCharts(); }, 120);
    };
    try {
      /* echarts.init 会给容器挂 _echarts_instance_ 属性，常晚于容器插入。
         只监听 childList 会漏掉这类实例；加属性监听后 init 当次即触发，
         仍是事件驱动，不引入定时轮询。 */
      new g.MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if ((r.addedNodes && r.addedNodes.length) ||
              (r.type === "attributes" && r.attributeName === "_echarts_instance_")) {
            kick(); return;
          }
        }
      }).observe(g.document.documentElement || g.document,
                 { childList: true, subtree: true, attributes: true,
                   attributeFilter: ["_echarts_instance_"] });
    } catch (e) { }
    kick();
  }

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
          var nw = replaceStr(old, fromMap, fromEff);
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
          var nopt = replaceDeep(opt, fromMap, [], fromEff);
          inst.setOption(nopt, true);
        }
      }
    } catch (e2) { }
    try { syncCharts(); } catch (e4) { }
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
    try { if (g.top !== g) return; } catch (e) { return; }   /* iframe 内不注入 */
    if (doc.getElementById("wufuThemeSel")) return;
    var host = doc.querySelector(".wh-top") || doc.querySelector("header");
    if (!host) return;

    var sel = doc.createElement("select");
    sel.id = "wufuThemeSel"; sel.className = "wufu-theme-toggle";
    sel.setAttribute("aria-label", "界面主题");
    sel.innerHTML = '<option value="dark">深色</option>' +
                    '<option value="light">浅色</option>' +
                    '<option value="system">跟随系统</option>';
    sel.value = mode();
    sel.addEventListener("change", function () { set(sel.value); });
    onChange(function () { sel.value = mode(); });

    /* 样式锁死：页面里普遍有 select{...!important}，且它的选择器可能是
       「header select」这类比单个 class 更高的特异性。内联 important 优先级最高，
       保证 8 个页面算出来的宽高、字号、内边距、圆角逐位一致。 */
    var LOCK = {
      "width":"82px", "height":"28px", "min-height":"28px", "max-height":"28px",
      "font-size":"10px", "line-height":"1.4", "padding":"4px 6px",
      "border-radius":"9px", "box-sizing":"border-box",
      "border":"1px solid var(--ui-line-strong)",
      "background-color":"var(--c-surface)", "color":"var(--c-text)",
      "font-weight":"600", "appearance":"none", "-webkit-appearance":"none"
    };
    Object.keys(LOCK).forEach(function (p) {
      sel.style.setProperty(p, LOCK[p], "important");
    });

    /* 顶栏位置按结构分两类（用户 v0.97 要求，同类页面逐位一致）：
         首页   无「返回首页」行 → 控件与标题同一行、靠右、垂直居中对齐；
         系统页 有「返回首页」行 → 日期回到标题同一行右侧（不再为控件让位），
                 控件放到返回首页那一行右侧，与返回按钮垂直居中、右边缘与日期对齐。
       不再用绝对定位硬钉容器顶边：绝对定位会让控件比标题高一截（首页截图的问题），
       也会把日期徽标挤到中间。改为参与所在行的布局流，靠自动外边距推到右侧。 */
    var whRoot = host.closest ? host.closest(".wh") : null;
    var second = (whRoot ? whRoot.querySelector(".wh-row") : null) ||
                 host.querySelector(".homestrip");
    var target = second || host;
    /* cb/tool.html 的 .homestrip 是块级；补成 flex 才能让 auto 外边距生效。
       两类系统页因此得到完全一致的第二行布局。 */
    try {
      if (g.getComputedStyle(target).display.indexOf("flex") < 0) {
        target.style.setProperty("display", "flex", "important");
        target.style.setProperty("align-items", "center", "important");
        target.style.setProperty("flex-wrap", "wrap", "important");
        target.style.setProperty("gap", "8px", "important");
      }
    } catch (e5) { }
    sel.style.setProperty("margin-left", "auto", "important");
    sel.style.setProperty("margin-right", "0", "important");
    sel.style.setProperty("margin-top", "0", "important");
    sel.style.setProperty("margin-bottom", "0", "important");
    sel.style.setProperty("flex", "0 0 auto", "important");
    sel.style.setProperty("align-self", "center", "important");
    /* 日期徽标不再让位：原先的 margin-right:96px 正是它跑到中间的原因。 */
    var badge = host.querySelector(".wh-badge, .databadge") ||
                (whRoot ? whRoot.querySelector(".wh-badge, .databadge") : null);
    if (badge) badge.style.removeProperty("margin-right");
    /* header.js 的 .wh-slot 平时是空 span，但 .wh-top 的 gap:12px 仍占一格，
       会把日期徽标推离右边缘 12px。挪到第二行后第一行只剩标题+日期，
       两者右边缘与第二行控件逐位对齐；「检测到新版本」提示也回到操作行。 */
    var slot = whRoot ? whRoot.querySelector(".wh-slot") : null;
    if (slot) {
      if (second && slot.parentNode !== second) second.appendChild(slot);
      slot.style.setProperty("margin-left", "0", "important");
    }
    target.appendChild(sel);

    /* 首屏：业务 JS 里登记的遗留色写死的是深色字面量，浅色下换成当前主题值。
       深色下 css(var) 返回原值，逐字不变。 */
    try { refresh(curEff === "light" ? "dark" : "light"); } catch (e2) { }
  }
  if (g.document) {
    if (g.document.readyState === "loading")
      g.document.addEventListener("DOMContentLoaded", function () { injectToggle(); watchCharts(); });
    else { injectToggle(); watchCharts(); }
  }
  /* head 里同步执行：首屏 paint 前设好，不闪深色 */
  apply();

  g.WufuTheme = { css: css, sub: sub, tokens: TOKENS, fallback: FALLBACK,
    light: LIGHT, mode: mode, effective: effective, apply: apply,
    set: set, refresh: refresh, onChange: onChange, syncCharts: syncCharts, watchCharts: watchCharts };
})(typeof window !== "undefined" ? window : this);
