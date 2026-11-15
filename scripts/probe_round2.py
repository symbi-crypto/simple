#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第二轮细核：行业板块全量可取性 + 疑似误判源坐实。"""
import json, ssl, gzip, time, urllib.request, urllib.error, os, re, datetime, sys, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

def _fatal(exc_type, exc, tb):
    detail = "".join(traceback.format_exception(exc_type, exc, tb))
    try:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(dict(run_at=datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                           runner="GitHub Actions / ubuntu-latest (round2)",
                           error=detail[-6000:]), f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    print("FATAL\n" + detail[-3000:])
sys.excepthook = _fatal

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "probe-report2.json")

def get(url, headers=None, timeout=25):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip, deflate"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    ctx = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
                try: raw = gzip.decompress(raw)
                except Exception: pass
            return r.status, raw.decode("utf-8", "replace"), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8", "replace")
        except Exception: body = ""
        return e.code, body, ""
    except Exception as e:
        return None, "", type(e).__name__ + ": " + str(e)[:140]

def jload(text):
    try: return json.loads(text)
    except Exception: return {}

# ---------- A. 东财行业板块清单（全分页） ----------
boards, total, pages = [], None, 0
for pn in range(1, 10):
    st, txt, _ = get("https://push2.eastmoney.com/api/qt/clist/get?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3" % pn)
    o = jload(txt); d = o.get("data") or {}
    diff = d.get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    total = d.get("total")
    pages += 1
    if isinstance(diff, list):
        boards.extend([x for x in diff if isinstance(x, dict)])
    if not diff or (total and len(boards) >= total): break
    time.sleep(0.3)

# ---------- B. 全部板块并发拉全历史日线 ----------
def one(b):
    try:
        code = b.get("f12"); name = b.get("f14")
        url = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.%s&klt=101&fqt=1"
               "&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58" % code)
        st, txt, _ = get(url, timeout=30)
        o = jload(txt); kl = (o.get("data") or {}).get("klines") or []
        if not isinstance(kl, list): kl = []
        return dict(code=code, name=name, status=st, rows=len(kl),
                    first=kl[0].split(",")[0] if kl else None,
                    last=kl[-1].split(",")[0] if kl else None,
                    sample=kl[0] if kl else txt[:100])
    except Exception as e:
        return dict(code=str(b)[:40], name="?", status=None, rows=0,
                    first=None, last=None, sample=type(e).__name__ + ":" + str(e)[:120])

kl_results = []
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = [ex.submit(one, b) for b in boards[:60]]
    for f in as_completed(futs):
        try: kl_results.append(f.result())
        except Exception as e:
            kl_results.append(dict(code="?", name="?", status=None, rows=0,
                                   first=None, last=None, sample="future:" + str(e)[:120]))

ok_kl = [r for r in kl_results if r["rows"] > 0]
rows_list = [r["rows"] for r in ok_kl]
last_dates = sorted(set(r["last"] for r in ok_kl if r["last"]))
industry = dict(
    board_list_total=total, board_list_fetched=len(boards), pages=pages,
    sample_boards=[{"code": b.get("f12"), "name": b.get("f14")} for b in boards[:8]],
    kline_attempted=len(kl_results), kline_ok=len(ok_kl),
    kline_rows_min=min(rows_list) if rows_list else None,
    kline_rows_max=max(rows_list) if rows_list else None,
    kline_last_dates=last_dates[-5:],
    kline_top=[r for r in sorted(ok_kl, key=lambda x: -x["rows"])[:3]],
    kline_fails=[r for r in kl_results if r["rows"] == 0][:5],
    can_do_31_row_heatmap=len(ok_kl) >= 31,
)

# ---------- C. 疑似误判源坐实 ----------
clar = []
def clr(sid, url, headers=None, extract=None):
    st, txt, ctype = get(url, headers)
    item = dict(id=sid, status=st, ctype=ctype, bytes=len(txt),
                sample=re.sub(r"\s+", " ", txt[:260]))
    if extract:
        try: item["extract"] = extract(txt)
        except Exception as e: item["extract_err"] = str(e)[:100]
    clar.append(item)
    return txt

clr("sina_sw_hq", "https://hq.sinajs.cn/list=sw801010", {"Referer": "https://finance.sina.com.cn/"})
sina_k = clr("sina_sw_kline", "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData?symbol=sw801010&scale=240&ma=no&datalen=3000",
             {"Referer": "https://finance.sina.com.cn/"},
             lambda t: dict(keys=list(jload(t).keys()), n=len((jload(t).get("result") or {}).get("data") or [])))
clr("stooq_xauusd", "https://stooq.com/q/d/l/?s=xauusd&i=d")
clr("cftc_dea_head", "https://www.cftc.gov/dea/futures/deacmesf.htm",
    None, lambda t: dict(has_gold="GOLD" in t.upper(), gold_lines=[l.strip()[:120] for l in t.splitlines() if "GOLD" in l.upper()][:3]))
clr("em_au9999_tail", "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&klt=101&fqt=1&beg=20261101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58",
    None, lambda t: ((jload(t).get("data") or {}).get("klines") or [])[-5:])

# FRED 多候选
fred_candidates = [
    ("fred_csv_cosd", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10&cosd=2015-01-01"),
    ("fred_series_page", "https://fred.stlouisfed.org/series/DFII10"),
    ("fred_api_no_key", "https://api.stlouisfed.org/fred/series/observations?series_id=DFII10&file_type=json"),
    ("fred_download", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10&fq=Daily&fam=Average"),
]
fred = []
for sid, url in fred_candidates:
    st, txt, ctype = get(url, timeout=35)
    fred.append(dict(id=sid, status=st, bytes=len(txt), ctype=ctype,
                     sample=re.sub(r"\s+", " ", txt[:140])))

# SPDR 正确路径候选
spdr_candidates = [
    ("spdr_us_holdings", "https://www.spdrgoldshares.com/usa/holdings/"),
    ("spdr_json", "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_en/GLD_Holdings.json"),
    ("spdr_csv2", "https://www.spdrgoldshares.com/media/GLD/factsheet/GLD_Holdings.csv"),
]
spdr = []
for sid, url in spdr_candidates:
    st, txt, ctype = get(url)
    spdr.append(dict(id=sid, status=st, bytes=len(txt), ctype=ctype,
                     sample=re.sub(r"\s+", " ", txt[:140])))

report = dict(
    run_at=datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    runner="GitHub Actions / ubuntu-latest (round2)",
    industry=industry, clarifications=clar, fred=fred, spdr=spdr,
)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print("BOARD_LIST total=%s fetched=%s pages=%s" % (total, len(boards), pages))
print("KLINE attempted=%s ok=%s rows=%s..%s last_dates=%s" % (
    len(kl_results), len(ok_kl),
    industry["kline_rows_min"], industry["kline_rows_max"], last_dates[-5:]))
print("CAN_DO_31_ROW_HEATMAP =", industry["can_do_31_row_heatmap"])
print("--- clarifications ---")
for c in clar:
    print(c["id"], c["status"], c["bytes"], str(c.get("extract") or c.get("sample") or "")[:180])
print("--- fred ---")
for x in fred: print(x["id"], x["status"], x["bytes"], x["sample"][:90])
print("--- spdr ---")
for x in spdr: print(x["id"], x["status"], x["bytes"], x["sample"][:90])
