#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build-external.py — 在 GitHub Actions 出口抓取并「算好」两份看板快照。

产出：
  industry-daily.json  申万一级行业指数口径的 A股行业宽度全景 + 全行业热力图
  gold-daily.json      国际金/银/油/铜/BTC + GVZ + 上海金 + 三项比价

原则：
  · 只写算好的小 JSON，原始日线不进仓库、不进页面。
  · 抓不到就明确报错或标 null，绝不用示意值补位。
  · 口径写进 JSON：申万 2021 版 31 个一级行业指数，非东财细分板块。
"""
import json, ssl, gzip, time, os, sys, datetime, urllib.request, urllib.error, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, ALL_COMPLETED

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CTX = ssl._create_unverified_context()
ROOT = os.getcwd()
WARN = []


def get(url, timeout=12, tries=2):
    """带重试的 GET；返回 (status, text) 或 (None, 错误串)。
    超时刻意压短：宁可少一个板块，也不让无人值守任务卡几十分钟。"""
    last = ""
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip, deflate"})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
                return r.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
        time.sleep(0.6 * (k + 1))
    return None, last


def jload(t):
    try:
        return json.loads(t)
    except Exception:
        return {}


def med(a):
    a = [x for x in a if isinstance(x, (int, float)) and -1e12 < x < 1e12]
    if not a:
        return None
    a = sorted(a)
    m = len(a) >> 1
    return a[m] if len(a) % 2 else (a[m - 1] + a[m]) / 2


def pct(series, v):
    s = [x for x in series if isinstance(x, (int, float)) and -1e12 < x < 1e12]
    if v is None or not s:
        return None
    return round(100 * sum(1 for x in s if x <= v) / len(s))


def sample(arr, n):
    """等距抽样到 n 点（保留首末）。"""
    if not arr:
        return []
    if len(arr) <= n:
        return list(arr)
    step = (len(arr) - 1) / (n - 1)
    return [arr[min(len(arr) - 1, round(k * step))] for k in range(n)]


def week_pick(days):
    """返回每周最后一个交易日在 days 中的下标（ISO 周，跨年用 isocalendar 不串）。"""
    out = []
    last = None
    for i, d in enumerate(days):
        w = datetime.date.fromisoformat(d).isocalendar()[:2]
        if w != last:
            out.append(i)
            last = w
        else:
            out[-1] = i
    return out


def window(days, years):
    """按自然年截取日期列表。"""
    if not days:
        return []
    end = datetime.date.fromisoformat(days[-1])
    cut = end - datetime.timedelta(days=int(365.25 * years))
    return [d for d in days if datetime.date.fromisoformat(d) >= cut]


def save(name, obj):
    with open(os.path.join(ROOT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print("写回", name, os.path.getsize(os.path.join(ROOT, name)), "bytes")


# =====================================================================
# 一、行业宽度（申万一级行业指数 31 个）
#   数据源：AKShare -> 申万宏源研究 index_hist_sw / sw_index_first_info
#   口径：真正的申万 2021 版 31 个一级行业指数日线，不再是东财细分板块。
#   失败：抓不到的行业标进 warnings；少于 25 条直接失败，不覆盖上次快照。
# =====================================================================


SW_LEVEL1 = [
    ("801010", "农林牧渔"), ("801030", "基础化工"), ("801040", "钢铁"),
    ("801050", "有色金属"), ("801080", "电子"), ("801110", "家用电器"),
    ("801120", "食品饮料"), ("801130", "纺织服饰"), ("801140", "轻工制造"),
    ("801150", "医药生物"), ("801160", "公用事业"), ("801170", "交通运输"),
    ("801180", "房地产"), ("801200", "商贸零售"), ("801210", "社会服务"),
    ("801230", "综合"), ("801710", "建筑材料"), ("801720", "建筑装饰"),
    ("801730", "电力设备"), ("801740", "国防军工"), ("801750", "计算机"),
    ("801760", "传媒"), ("801770", "通信"), ("801780", "银行"),
    ("801790", "非银金融"), ("801880", "汽车"), ("801890", "机械设备"),
    ("801950", "煤炭"), ("801960", "石油石化"), ("801970", "环保"),
    ("801980", "美容护理"),
]
SW_TREND = "https://www.swsresearch.com/institute-sw/api/index_publish/trend/?swindexcode=%s&period=DAY"


def get_sw_boards():
    """申万 2021 版 31 个一级行业（硬编码，避免再依赖一次官网清单请求）。"""
    print("申万一级行业清单", len(SW_LEVEL1), flush=True)
    return [{"code": c, "name": n} for c, n in SW_LEVEL1]


def one_sw(b):
    """直连申万官网 JSON 接口，带硬超时；不用 akshare（其 requests 无 timeout 会挂死无人值守任务）。"""
    url = SW_TREND % b["code"]
    last = ""
    for k in range(3):
        st, txt = get(url, timeout=10, tries=1)
        if st == 200:
            try:
                rows = (jload(txt) or {}).get("data") or []
                series = {}
                for row in rows:
                    d = str(row.get("bargaindate") or "")[:10]
                    try:
                        c = float(row.get("closeindex"))
                        a = float(row.get("bargainsum") or 0)
                    except (TypeError, ValueError):
                        continue
                    if len(d) == 10 and c > 0:
                        series[d] = (c, a)
                if len(series) >= 220:
                    return {"code": b["code"], "name": b["name"], "series": series, "ok": True}
                last = "仅 %d 根日线" % len(series)
            except Exception as e:
                last = "解析失败 %s: %s" % (type(e).__name__, str(e)[:100])
        else:
            last = "HTTP %s %s" % (st, str(txt)[:80])
        time.sleep(0.6 * (k + 1))
    WARN.append("申万 %s %s 抓取失败: %s" % (b["code"], b["name"], last))
    return {"code": b["code"], "name": b["name"], "series": {}, "ok": False}

def build_industry():
    boards = get_sw_boards()
    if len(boards) < 28:
        raise RuntimeError("申万一级清单仅 %d 条，异常，拒绝生成" % len(boards))
    # 串行抓取：31 个请求，官网对并发敏感
    res = []
    for b in boards:
        res.append(one_sw(b))
        time.sleep(0.35)
    ok = [r for r in res if r["ok"]]
    ok.sort(key=lambda x: x["code"])
    print("申万一级日线成功", len(ok), "/", len(boards), flush=True)
    if len(ok) < 25:
        raise RuntimeError("仅 %d 个申万一级行业拿到 >=220 根日线，拒绝生成空壳" % len(ok))
    if len(ok) < len(boards):
        WARN.append("申万一级行业日线成功 %d/%d，热力图按实际成功数全铺" % (len(ok), len(boards)))

    todo = boards
    # 全局交易日 = 所有成功行业日期的并集
    all_days = sorted(set().union(*[set(r["series"]) for r in ok]))
    all_days = [d for d in all_days if d >= "2016-01-01"]
    if len(all_days) < 250:
        raise RuntimeError("全局交易日仅 %d 天，不足" % len(all_days))

    prepared = []
    for r in ok:
        ds = sorted(r["series"])
        prepared.append({"name": r["name"], "code": r["code"],
                         "dates": ds, "close": [r["series"][d][0] for d in ds],
                         "amt": [r["series"][d][1] for d in ds]})

    calc_days = set(window(all_days, 10))
    metrics = {k: {} for k in ["ma20", "ma60", "ma200", "up", "posmom", "mommedian", "amount"]}
    for r in prepared:
        dmap = {d: i for i, d in enumerate(r["dates"])}
        closes = r["close"]
        pre = [0.0]
        for c in closes:
            pre.append(pre[-1] + c)
        for d, i in dmap.items():
            if d not in calc_days:
                continue
            c = closes[i]
            for N, key in [(20, "ma20"), (60, "ma60"), (200, "ma200")]:
                if i + 1 >= N:
                    ma = (pre[i + 1] - pre[i + 1 - N]) / N
                    metrics[key].setdefault(d, []).append(1 if c > ma else 0)
            if i >= 1 and closes[i - 1]:
                metrics["up"].setdefault(d, []).append(1 if c > closes[i - 1] else 0)
            if i >= 20 and closes[i - 20]:
                metrics["posmom"].setdefault(d, []).append(1 if c > closes[i - 20] else 0)
                metrics["mommedian"].setdefault(d, []).append((c / closes[i - 20] - 1) * 100)
            metrics["amount"].setdefault(d, []).append(r["amt"][i])

    days = sorted(metrics["ma20"])
    breadth_series, ma60_series, ma200_series, up_series, posmom_series = [], [], [], [], []
    mom_series, amt_series = [], []
    for d in days:
        a = metrics["ma20"].get(d, [])
        breadth_series.append(round(100 * sum(a) / len(a)) if a else None)
        b = metrics["ma60"].get(d, [])
        ma60_series.append(round(100 * sum(b) / len(b)) if b else None)
        c = metrics["ma200"].get(d, [])
        ma200_series.append(round(100 * sum(c) / len(c)) if c else None)
        u = metrics["up"].get(d, [])
        up_series.append(round(100 * sum(u) / len(u)) if u else None)
        p = metrics["posmom"].get(d, [])
        posmom_series.append(round(100 * sum(p) / len(p)) if p else None)
        m = metrics["mommedian"].get(d, [])
        mom_series.append(round(med(m), 2) if med(m) is not None else None)
        amt_series.append(round(sum(metrics["amount"].get(d, [])), 2))

    last = days[-1] if days else None

    def v(arr, back=0):
        if not arr or len(arr) <= back:
            return None
        x = arr[-1 - back]
        return x if isinstance(x, (int, float)) else None

    keys = ["行业宽度", "MA60占比", "MA200占比", "上涨占比", "动量>0占比", "中位动量分位", "成交额分位"]
    seqs = {"行业宽度": breadth_series, "MA60占比": ma60_series, "MA200占比": ma200_series,
            "上涨占比": up_series, "动量>0占比": posmom_series,
            "中位动量分位": [pct(mom_series[max(0, i - 1250):i + 1], mom_series[i]) if i > 250 else None for i in range(len(mom_series))],
            "成交额分位": [pct(amt_series[max(0, i - 1250):i + 1], amt_series[i]) if i > 250 else None for i in range(len(amt_series))]}

    today = [v(seqs[k]) for k in keys]
    lastweek = [v(seqs[k], 5) for k in keys]

    area = {}
    for Y in (5, 10):
        wset = set(window(days, Y))
        wd = [i for i in week_pick(days) if days[i] in wset]
        labels = [days[i] for i in wd]
        series = {k: [seqs[k][i] for i in wd] for k in keys}
        area[str(Y)] = {"labels": labels, "series": series, "points": len(wd)}

    # 热力图：最近 6 个交易日，每个行业当日涨跌 与 距 MA20 乖离
    hd = days[-6:]
    hnames, hchg, hbias = [], [], []
    for r in prepared:
        dmap = {d: i for i, d in enumerate(r["dates"])}
        closes = r["close"]
        pre = [0.0]
        for c in closes:
            pre.append(pre[-1] + c)
        chrow, birow = [], []
        for d in hd:
            i = dmap.get(d)
            if i is None or i < 20:
                chrow.append(None); birow.append(None); continue
            c = closes[i]
            chrow.append(round((c / closes[i - 1] - 1) * 100, 2) if closes[i - 1] else None)
            ma = (pre[i + 1] - pre[i - 19]) / 20
            birow.append(round((c / ma - 1) * 100, 2) if ma else None)
        hnames.append(r["name"]); hchg.append(chrow); hbias.append(birow)

    weeks, seen_w, week_cells = [], set(), [[] for _ in keys]
    for i in range(len(days) - 1, -1, -1):
        iso = datetime.date.fromisoformat(days[i]).isocalendar()
        w = "%d-W%02d" % (iso[0], iso[1])
        if w in seen_w:
            continue
        seen_w.add(w); weeks.append(w)
        for j, k in enumerate(keys):
            week_cells[j].append(seqs[k][i])
        if len(weeks) >= 24:
            break
    weeks.reverse()
    for j in range(len(week_cells)):
        week_cells[j] = [x for x in reversed(week_cells[j])]

    out = {
        "format": "wufu-dash-industry-v2",
        "dataAsOf": last,
        "source": "申万一级行业指数（AKShare index_hist_sw / 申万宏源研究，2021 版 31 个一级）",
        "boardCount": len(ok),
        "boardTotal": 31,
        "sampleDays": len(days),
        "sampleFrom": days[0] if days else None,
        "sampleNote": "样本 %d 个交易日（%s 起）· 申万一级行业 %d/31 条成功" % (len(days), days[0] if days else "—", len(ok)),
        "keys": keys,
        "indicators": [{"key": k, "name": k, "value": today[j]} for j, k in enumerate(keys)],
        "radar": {"today": today, "lastWeek": lastweek},
        "area": area,
        "heat": {"dates": hd, "names": hnames, "chg": hchg, "bias": hbias},
        "heatbar": {"names": keys, "weeks": weeks, "cells": week_cells},
        "warnings": WARN,
        "note": "宽度 = 当日站上自身20日均线的申万一级行业数 / 有数据行业数 ×100；分母是 31 条申万一级行业指数，不是全A个股，数值不与参考站直接对照。MA200 需 200 日预热，早期为 null。"
    }
    save("industry-daily.json", out)
    print("行业宽度当前值", dict(zip(keys, today)))
    print("热力图", len(hnames), "行 ×", len(hd), "列")


# =====================================================================
# 二、黄金看板（国际价格）
# =====================================================================
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=10y&interval=1d"
GVZ = "https://cdn.cboe.com/api/global/us_indices/daily_prices/GVZ_History.csv"
AU = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&klt=101&fqt=1"
      "&beg=20100101&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58")


def yahoo(sym):
    st, txt = get(YAHOO % sym, timeout=18, tries=2)
    if st != 200:
        WARN.append("Yahoo %s 失败: %s" % (sym, txt[:80]))
        return {}
    try:
        res = jload(txt)["chart"]["result"][0]
        ts = res.get("timestamp") or []
        q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
        closes = q.get("close") or []
        s = {}
        for t, c in zip(ts, closes):
            if c is None:
                continue
            day = datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
            s[day] = float(c)
        return s
    except Exception as e:
        WARN.append("Yahoo %s 解析失败: %s" % (sym, str(e)[:80]))
        return {}


def gvz_series():
    st, txt = get(GVZ, timeout=18, tries=2)
    if st != 200:
        WARN.append("GVZ 失败: %s" % txt[:80])
        return {}
    out = {}
    for line in txt.splitlines()[1:]:
        p = line.split(",")
        if len(p) < 2:
            continue
        try:
            d = datetime.datetime.strptime(p[0].strip(), "%m/%d/%Y").strftime("%Y-%m-%d")
            out[d] = float(p[-1])
        except Exception:
            continue
    return out


def au_series():
    st, txt = get(AU, timeout=18, tries=2)
    if st != 200:
        WARN.append("上海金 Au99.99 失败: %s" % txt[:80])
        return {}
    out = {}
    kl = (jload(txt).get("data") or {}).get("klines") or []
    for line in kl:
        p = line.split(",")
        if len(p) >= 3:
            try:
                out[p[0]] = float(p[2])
            except Exception:
                pass
    return out


def build_gold():
    syms = ["GC=F", "SI=F", "CL=F", "HG=F", "BTC-USD"]
    labels = {"GC=F": "国际金", "SI=F": "国际银", "CL=F": "WTI原油", "HG=F": "COMEX铜", "BTC-USD": "比特币"}
    units = {"GC=F": "美元/盎司", "SI=F": "美元/盎司", "CL=F": "美元/桶", "HG=F": "美元/磅", "BTC-USD": "美元"}
    colors = {"GC=F": "#FBBF24", "SI=F": "#C0CADA", "CL=F": "#34D399", "HG=F": "#F87171", "BTC-USD": "#A78BFA"}
    S = {s: yahoo(s) for s in syms}
    good = [s for s in syms if len(S[s]) > 200]
    print("黄金源成功", [(s, len(S[s])) for s in syms])
    if len(good) < 4:
        raise RuntimeError("核心资产仅 %d/5 成功，拒绝生成黄金空壳" % len(good))

    G = gvz_series()
    A = au_series()
    # 五资产共同交易日（BTC 周末自动被排除）
    common = set(S[good[0]])
    for s in good[1:]:
        common &= set(S[s])
    days = sorted(common)
    if len(days) < 250:
        raise RuntimeError("共同交易日仅 %d 天" % len(days))

    def val(s, d):
        return S[s].get(d)

    def chg(s):
        ds = sorted(S[s])
        if len(ds) < 2 or not S[s][ds[-1]] or not S[s][ds[-2]]:
            return None
        return round((S[s][ds[-1]] / S[s][ds[-2]] - 1) * 100, 2)

    def pctl(s, years):
        ds = window(sorted(S[s]), years)
        if not ds:
            return None
        cur = S[s][sorted(S[s])[-1]]
        return pct([S[s][d] for d in ds], cur)

    kpi = []
    for s in syms:
        ds = sorted(S[s])
        cv = S[s][ds[-1]] if ds else None
        kpi.append({
            "label": labels[s], "value": cv, "unit": units[s], "chg": chg(s),
            "p5": pctl(s, 5), "p10": pctl(s, 10), "color": colors[s], "ok": bool(ds)
        })
    gdays = sorted(G)
    gv = G[gdays[-1]] if gdays else None
    gchg = round((G[gdays[-1]] / G[gdays[-2]] - 1) * 100, 2) if len(gdays) > 1 and G[gdays[-2]] else None
    kpi.append({"label": "黄金波动 GVZ", "value": gv, "unit": "", "chg": gchg,
                "p5": pct([G[d] for d in window(gdays, 5)], gv),
                "p10": pct([G[d] for d in window(gdays, 10)], gv),
                "color": "#FBBF24", "ok": bool(gdays)})

    # 三项比价（共同交易日）
    ratios = {}
    for name, a, b in [("金银比", "GC=F", "SI=F"), ("金油比", "GC=F", "CL=F"), ("金铜比", "GC=F", "HG=F")]:
        if a not in S or b not in S or not S[a] or not S[b]:
            ratios[name] = {"ok": False}
            continue
        cd = sorted(set(S[a]) & set(S[b]))
        v = [(d, S[a][d] / S[b][d]) for d in cd if S[b][d]]
        ratios[name] = {"ok": bool(v), "days": len(v), "current": round(v[-1][1], 4) if v else None,
                        "series": dict(v)}
    rkeys = ["金银比", "金油比", "金铜比"]
    rcolors = ["#4FC3F7", "#FBBF24", "#A78BFA"]

    trend, pos = {}, []
    for Y in (5, 10):
        wset = set(window(days, Y))
        wd = [days[i] for i in week_pick(days) if days[i] in wset]
        lb = list(wd)
        price, ratio = {}, {}
        for s in syms:
            base = S[s].get(wd[0]) if wd else None
            price[s] = [round(100 * S[s][d] / base, 2) if base and S[s].get(d) else None for d in wd]
        for rk in rkeys:
            rs = ratios.get(rk, {}).get("series") or {}
            lastv, vals = None, []
            for d in wd:
                if d in rs:
                    lastv = rs[d]
                vals.append(lastv)
            base = next((v for v in vals if v), None)
            ratio[rk] = [round(100 * v / base, 2) if v and base else None for v in vals]
        lastg, gvals = None, []
        for d in wd:
            if d in G:
                lastg = G[d]
            gvals.append(lastg)
        gline = [round(v, 2) if v is not None else None for v in gvals]
        trend[str(Y)] = {"labels": lb, "price": price, "ratio": ratio, "gvz": gline, "points": len(wd)}

    for rk in rkeys:
        rs = ratios.get(rk, {}).get("series") or {}
        if not rs:
            pos.append({"name": rk, "p5": None, "p10": None})
            continue
        rd = sorted(rs)
        cur = rs[rd[-1]]
        pos.append({"name": rk, "p5": pct([rs[d] for d in window(rd, 5)], cur),
                    "p10": pct([rs[d] for d in window(rd, 10)], cur)})

    adays = sorted(A)
    sh = {"value": A[adays[-1]] if adays else None,
          "chg": round((A[adays[-1]] / A[adays[-2]] - 1) * 100, 2) if len(adays) > 1 and A[adays[-2]] else None,
          "date": adays[-1] if adays else None}

    out = {
        "format": "wufu-dash-gold-v1",
        "dataAsOf": days[-1],
        "source": "Yahoo Finance 期货主力连续（GC=F/SI=F/CL=F/HG=F）、BTC-USD、CBOE GVZ、东财 Au99.99",
        "sampleNote": "共同交易日 %d 天（%s 起）· BTC 周末已按共同交易日对齐剔除" % (len(days), days[0]),
        "kpi": kpi, "ratios": {k: ratios[k]["current"] for k in rkeys},
        "ratioColors": dict(zip(rkeys, rcolors)),
        "pos": pos, "trend": trend, "shGold": sh,
        "warnings": WARN,
        "note": "金/银/油/铜为 COMEX 期货主力连续（非伦敦金现，XAUUSD=X 在该源 404）；比价均为国际美元价之比，上海金仅作人民币对照、不参与比价。无 FRED 宏观/CFTC/GLD 持仓/WGC 购金，不摆空壳。"
    }
    save("gold-daily.json", out)
    print("黄金末值", [(k["label"], k["value"], k["chg"]) for k in kpi])
    print("三项比价", out["ratios"])


# =====================================================================
# 三、两市成交额（指数看板叠柱用）
# 探针实测（GitHub Actions 出口）：东财 1.000001 / 0.399001 K 线 f57
# 均 4094 根、2010-01-04 起，末日 2026-11-13，合计约 16556.7 亿元。
# 口径是「上证指数 + 深证成指成交额之和」，是两市成交额的近似，
# 不是全A逐股加总；只写算好的小 JSON，原始日线不进仓库。
# =====================================================================
AMT_KL = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s&klt=101&fqt=1"
          "&beg=20100101&end=20500101&fields1=f1,f2,f3"
          "&fields2=f51,f52,f53,f54,f55,f56,f57,f58")


def amt_index(secid):
    st, txt = get(AMT_KL % secid, timeout=15, tries=2)
    if st != 200:
        return {}
    out = {}
    for line in (jload(txt).get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) >= 7:
            try:
                out[p[0]] = float(p[6])   # f57 成交额（元）
            except Exception:
                pass
    return out


def build_amount():
    sh = amt_index("1.000001")
    sz = amt_index("0.399001")
    ok = len(sh) > 200 and len(sz) > 200
    if not ok:
        WARN.append("两市成交额：上证 %d 根 / 深证 %d 根，不足，本次不叠柱" % (len(sh), len(sz)))
    days = sorted(set(sh) & set(sz)) if ok else []
    out = {
        "format": "wufu-dash-amount-v1",
        "dataAsOf": days[-1] if days else None,
        "ok": ok,
        "source": "东财指数 K 线成交额 f57：上证指数(1.000001) + 深证成指(0.399001)",
        "note": "两市成交额 ≈ 上证指数 + 深证成指成交额之和（亿元），非全A逐股加总；柱形单独归一，不与指数点位混算。",
        "5": {"labels": [], "amount": []},
        "10": {"labels": [], "amount": []},
        "warnings": list(WARN),
    }
    if ok:
        vals = [round((sh[d] + sz[d]) / 1e8, 1) for d in days]   # 亿元
        for Y in (5, 10):
            wset = set(window(days, Y))
            pick = [i for i in week_pick(days) if days[i] in wset]
            if not pick:
                continue
            out[str(Y)] = {"labels": [days[i] for i in pick],
                           "amount": [vals[i] for i in pick], "points": len(pick)}
        print("两市成交额 共同交易日", len(days), "末日", days[-1], "亿元", vals[-1])
    save("market-amount.json", out)


def main():
    errs = []
    for name, fn in [("两市成交额", build_amount), ("行业宽度", build_industry), ("黄金看板", build_gold)]:
        print("===", name, "===", flush=True)
        try:
            fn()
        except Exception as e:
            traceback.print_exc()
            msg = "%s 失败：%s: %s" % (name, type(e).__name__, str(e)[:180])
            WARN.append(msg)
            errs.append(msg)
            print(msg, flush=True)
    save("external-warnings.json", {
        "warnings": list(WARN),
        "at": datetime.datetime.utcnow().isoformat() + "Z",
        "failed": errs})
    print("完成，warnings:", WARN, flush=True)
    if errs:
        # 单个源失败仍让该步红灯（不绿灯伪装），但其它源已经写回，不牵连
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
