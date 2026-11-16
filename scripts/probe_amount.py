#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 GitHub Actions 出口实测「两市成交额」可得性：东财指数 K 线成交额字段。"""
import json, ssl, gzip, urllib.request, urllib.error, datetime, time

CTX = ssl._create_unverified_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
KL = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s&klt=101&fqt=1"
      "&beg=20100101&end=20500101&fields1=f1,f2,f3"
      "&fields2=f51,f52,f53,f54,f55,f56,f57,f58")

TARGETS = [
    ("1.000001", "上证指数"),
    ("0.399001", "深证成指"),
    ("1.000300", "沪深300"),
    ("0.399303", "国证2000"),
]


def get(url, timeout=15):
    for k in range(2):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip, deflate"})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                return r.status, raw.decode("utf-8", "replace")
        except Exception as e:
            err = "%s: %s" % (type(e).__name__, str(e)[:120])
            time.sleep(0.5)
    return None, err


out = {"at": datetime.datetime.utcnow().isoformat() + "Z", "sources": [], "sum": {}}
series = {}
for secid, name in TARGETS:
    st, txt = get(KL % secid)
    item = {"secid": secid, "name": name, "status": st, "ok": False, "rows": 0}
    if st == 200:
        try:
            d = json.loads(txt)
            kl = (d.get("data") or {}).get("klines") or []
            s = {}
            for line in kl:
                p = line.split(",")
                if len(p) >= 7:
                    try:
                        s[p[0]] = float(p[6])   # f57 成交额
                    except Exception:
                        pass
            item["rows"] = len(s)
            item["ok"] = len(s) > 200
            if s:
                ds = sorted(s)
                item["first"], item["last"] = ds[0], ds[-1]
                item["last_amount"] = s[ds[-1]]
                item["last_amount_yi"] = round(s[ds[-1]] / 1e8, 1)
                series[secid] = s
        except Exception as e:
            item["err"] = "parse: %s" % str(e)[:120]
    else:
        item["err"] = txt[:120]
    out["sources"].append(item)
    print(name, secid, "status", st, "ok", item["ok"], "rows", item["rows"],
          item.get("first"), "->", item.get("last"), "last_yi", item.get("last_amount_yi"), item.get("err", ""))

a, b = series.get("1.000001"), series.get("0.399001")
if a and b:
    common = sorted(set(a) & set(b))
    out["sum"] = {
        "ok": True, "common_days": len(common),
        "first": common[0] if common else None, "last": common[-1] if common else None,
        "last_yi": round((a[common[-1]] + b[common[-1]]) / 1e8, 1) if common else None,
        "note": "上证指数 + 深证成指 K 线成交额(f57)之和，单位亿元；为两市成交额近似口径",
    }
    print("两市合计 共同交易日", len(common), "末日", out["sum"]["last"], "亿元", out["sum"]["last_yi"])
else:
    out["sum"] = {"ok": False, "note": "上证/深证至少一条未取到，无法合成两市成交额"}
    print("两市合计：不可用")

with open("probe-amount.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("报告已写 probe-amount.json")
