#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 GitHub Actions 真实出口里逐个真拉数据源，记录可达性与实际数据量。"""
import json, ssl, gzip, time, urllib.request, urllib.error, os, re, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SINA_REF = {"Referer": "https://finance.sina.com.cn/"}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "probe-report.json")

def src(group, sid, url, kind="text", headers=None, note=""):
    return dict(group=group, id=sid, url=url, kind=kind, headers=headers or {}, note=note)

SOURCES = [
    # ---------- 出口信息 ----------
    src("info", "exit_ip", "https://api.ipify.org?format=json", "json"),

    # ---------- 申万 / 行业日线 ----------
    src("industry", "em_board_list",
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3",
        "em_list", note="东财行业板块清单"),
    src("industry", "em_kline_bk0475",
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0475&klt=101&fqt=1&beg=20100101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "em_kline", note="东财行业板块日线 3000+根"),
    src("industry", "em_kline_bk0475_http",
        "http://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0475&klt=101&fqt=1&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58",
        "em_kline", note="东财行业板块日线(http)"),
    src("industry", "em_kline_bk0447",
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0447&klt=101&fqt=1&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58",
        "em_kline", note="东财另一行业板块日线"),
    src("industry", "qq_ifzq_kline",
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,3000,qfq",
        "qq_kline", note="腾讯K线(宽基,验证接口本身)"),
    src("industry", "qq_proxy_kline",
        "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=sh000001,day,,,3000,qfq",
        "qq_kline", note="腾讯proxy.finance通道"),
    src("industry", "sws_trend_api",
        "https://www.swsresearch.com/institute-sw/api/index_publish/trend/?swindexcode=801010&period=DAY&start=20100101&end=20261115",
        "json", note="申万研究新版接口(AKShare底层)"),
    src("industry", "sws_old_page",
        "https://www.swsindex.com/idx0110.aspx?swindexcode=801010",
        "text", note="申万旧版页面(文章使用)"),
    src("industry", "sina_sw_hq",
        "https://hq.sinajs.cn/list=sw801010", "text", SINA_REF, "新浪申万实时行情"),
    src("industry", "sina_sw_kline",
        "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData?symbol=sw801010&scale=240&ma=no&datalen=3000",
        "json", SINA_REF, "新浪申万日线"),
    src("industry", "netease_kline",
        "https://quotes.money.163.com/service/chddata.html?code=0000001&start=20100101&end=20261115&fields=TCLOSE;HIGH;LOW;TOPEN;LCLOSE;CHG;PCHG;VOTURNOVER;VATURNOVER",
        "csv", note="网易财经日线(验证通道)"),

    # ---------- 黄金 / 境外源 ----------
    src("gold", "fred_dfii10", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10", "csv", note="FRED 10年期实际利率"),
    src("gold", "fred_dgs10", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10", "csv", note="FRED 10年期名义利率"),
    src("gold", "fred_pcepilfe", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=PCEPILFE", "csv", note="FRED 核心PCE"),
    src("gold", "fred_unrate", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE", "csv", note="FRED 失业率"),
    src("gold", "cboe_gvz", "https://cdn.cboe.com/api/global/us_indices/daily_prices/GVZ_History.csv", "csv", note="CBOE 黄金波动率GVZ"),
    src("gold", "cboe_vix", "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", "csv", note="CBOE VIX(同域对照)"),
    src("gold", "cftc_socrata", "https://publicreporting.cftc.gov/resource/6y4j-8x89.json?$limit=5", "json", note="CFTC 持仓 Socrata API"),
    src("gold", "cftc_dea", "https://www.cftc.gov/dea/futures/deacmesf.htm", "text", note="CFTC 旧版持仓报告"),
    src("gold", "spdr_holdings", "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_en/GLD_Holdings.csv", "csv", note="SPDR GLD 持仓"),
    src("gold", "yahoo_gc", "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=10y&interval=1d", "yahoo", note="Yahoo 黄金期货10年"),
    src("gold", "yahoo_gld", "https://query1.finance.yahoo.com/v8/finance/chart/GLD?range=10y&interval=1d", "yahoo", note="Yahoo GLD 10年"),
    src("gold", "stooq_xauusd", "https://stooq.com/q/d/l/?s=xauusd&i=d", "csv", note="stooq 伦敦金现日线"),
    src("gold", "sge_daily", "https://www.sge.com.cn/sjzx/mrhq", "text", note="上海黄金交易所每日行情"),
    src("gold", "sina_hf_gc", "https://hq.sinajs.cn/list=hf_GC", "text", SINA_REF, "新浪外盘黄金"),
    src("gold", "em_au9999",
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&klt=101&fqt=1&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58",
        "em_kline", note="东财 上金所Au99.99日线"),
    src("gold", "wgc_site", "https://www.gold.org/goldhub/data/gold-demand-trends", "text", note="世界黄金协会"),
]

def _decode(raw, enc):
    if enc == "gzip" or raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
    return raw.decode("utf-8", "replace")

def _parse(text, kind):
    r = dict(rows=None, first=None, last=None, detail="")
    try:
        if kind == "csv":
            lines = [l for l in text.splitlines() if l.strip()]
            r["rows"] = max(0, len(lines) - 1)
            if len(lines) > 1:
                r["first"] = lines[1].split(",")[0][:24]
                r["last"] = lines[-1].split(",")[0][:24]
        elif kind == "json":
            o = json.loads(text)
            if isinstance(o, list):
                r["rows"] = len(o)
                r["detail"] = "list"
            elif isinstance(o, dict):
                r["detail"] = "keys=" + ",".join(list(o.keys())[:6])
                for k in ("data", "result", "results", "observations"):
                    if isinstance(o.get(k), list):
                        r["rows"] = len(o[k]); break
        elif kind == "em_list":
            o = json.loads(text)
            d = (o.get("data") or {})
            diff = d.get("diff") or []
            r["rows"] = len(diff) if isinstance(diff, list) else (d.get("total") or 0)
            r["detail"] = "total=%s" % d.get("total")
        elif kind == "em_kline":
            o = json.loads(text)
            kl = ((o.get("data") or {}).get("klines") or [])
            r["rows"] = len(kl)
            if kl:
                r["first"] = kl[0].split(",")[0]; r["last"] = kl[-1].split(",")[0]
        elif kind == "qq_kline":
            o = json.loads(text)
            d = o.get("data") or {}
            k = None
            for v in d.values():
                if isinstance(v, dict):
                    k = v.get("qfqday") or v.get("day") or v.get("qfqweek") or []
                    break
            r["rows"] = len(k or [])
            if k:
                r["first"] = k[0][0] if isinstance(k[0], list) else str(k[0])[:24]
                r["last"] = k[-1][0] if isinstance(k[-1], list) else str(k[-1])[:24]
        elif kind == "yahoo":
            o = json.loads(text)
            res = ((o.get("chart") or {}).get("result") or [{}])[0]
            ts = res.get("timestamp") or []
            r["rows"] = len(ts)
            if ts:
                cvt = lambda t: datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
                r["first"] = cvt(ts[0]); r["last"] = cvt(ts[-1])
        elif kind == "text":
            r["detail"] = "len=%d" % len(text)
    except Exception as e:
        r["detail"] = "parse_err=" + str(e)[:100]
    return r

def probe(item):
    t0 = time.time()
    rec = dict(group=item["group"], id=item["id"], note=item["note"], url=item["url"],
               ok=False, status=None, ctype="", bytes=0, rows=None, first=None,
               last=None, detail="", sample="", err="", elapsed=0)
    hdrs = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip, deflate"}
    hdrs.update(item["headers"])
    try:
        req = urllib.request.Request(item["url"], headers=hdrs)
        ctx = ssl.create_default_context()
        try:
            resp = urllib.request.urlopen(req, timeout=20, context=ctx)
        except urllib.error.URLError as ue:
            # 证书链问题则降级重试一次
            if "SSL" in str(ue) or "certificate" in str(ue).lower():
                ctx = ssl._create_unverified_context()
                resp = urllib.request.urlopen(req, timeout=20, context=ctx)
            else:
                raise
        with resp:
            raw = resp.read()
            rec["status"] = resp.status
            rec["ctype"] = resp.headers.get("Content-Type", "")
            text = _decode(raw, resp.headers.get("Content-Encoding", ""))
        rec["bytes"] = len(raw)
        rec["sample"] = re.sub(r"\s+", " ", text[:180])
        p = _parse(text, item["kind"])
        rec.update(rows=p["rows"], first=p["first"], last=p["last"], detail=p["detail"])
        rec["ok"] = (rec["rows"] is None or rec["rows"] > 0) and bool(text.strip())
    except urllib.error.HTTPError as e:
        rec["status"] = e.code
        try:
            body = _decode(e.read(), e.headers.get("Content-Encoding", ""))
            rec["sample"] = re.sub(r"\s+", " ", body[:180])
        except Exception:
            pass
        rec["err"] = "HTTPError %s" % e.code
    except Exception as e:
        rec["err"] = type(e).__name__ + ": " + str(e)[:160]
    rec["elapsed"] = round(time.time() - t0, 2)
    return rec

def main():
    results = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(probe, s): s for s in SOURCES}
        for f in as_completed(futs):
            results.append(f.result())
    order = {s["id"]: i for i, s in enumerate(SOURCES)}
    results.sort(key=lambda r: order.get(r["id"], 999))

    # AKShare 文章做法：新版 index_hist_sw（可选）
    ak = dict(id="akshare_index_hist_sw", group="industry", note="AKShare 新版申万一级日线",
              url="(akshare python)", ok=False, status=None, ctype="", bytes=0, rows=None,
              first=None, last=None, detail="", sample="", err="", elapsed=0)
    t0 = time.time()
    try:
        import akshare as akmod
        df = akmod.index_hist_sw(symbol="801010", period="day")
        ak["ok"] = True
        ak["rows"] = len(df)
        ak["detail"] = "cols=" + ",".join(map(str, list(df.columns)[:8]))
        if len(df):
            ak["first"] = str(df.iloc[0, 0])[:24]; ak["last"] = str(df.iloc[-1, 0])[:24]
        ak["sample"] = str(df.head(2).to_dict("records"))[:180]
    except Exception as e:
        ak["err"] = type(e).__name__ + ": " + str(e)[:180]
    ak["elapsed"] = round(time.time() - t0, 2)
    results.append(ak)

    ip = ""
    for r in results:
        if r["id"] == "exit_ip" and r["sample"]:
            try:
                ip = json.loads(r["sample"]).get("ip", "")
            except Exception:
                m = re.search(r"\d+\.\d+\.\d+\.\d+", r["sample"])
                ip = m.group(0) if m else ""
    ind_ok = [r["id"] for r in results if r["group"] == "industry" and r["ok"]]
    gold_ok = [r["id"] for r in results if r["group"] == "gold" and r["ok"]]
    report = dict(
        run_at=datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        runner="GitHub Actions / ubuntu-latest",
        exit_ip=ip,
        summary=dict(industry_ok=ind_ok, gold_ok=gold_ok,
                     industry_total=sum(1 for r in results if r["group"] == "industry"),
                     gold_total=sum(1 for r in results if r["group"] == "gold")),
        sources=results,
    )
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("EXIT_IP=%s" % ip)
    print("INDUSTRY_OK=%s" % ",".join(ind_ok))
    print("GOLD_OK=%s" % ",".join(gold_ok))
    for r in results:
        print("%-9s %-22s status=%-5s ok=%-5s rows=%-6s %s -> %s  %s" % (
            r["group"], r["id"], str(r["status"]), str(r["ok"]), str(r["rows"]),
            str(r["first"])[:12], str(r["last"])[:12], (r["err"] or r["detail"])[:70]))

if __name__ == "__main__":
    main()
