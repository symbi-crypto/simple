#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build-external.py — 在 GitHub Actions 出口抓取并「算好」两份看板快照。

产出：
  industry-daily.json  东财行业板块口径的 A股行业宽度全景 + 全行业热力图
  gold-daily.json      国际金/银/油/铜/BTC + GVZ + 上海金 + 三项比价

原则：
  · 只写算好的小 JSON，原始日线不进仓库、不进页面。
  · 抓不到就明确报错或标 null，绝不用示意值补位。
  · 口径写进 JSON：东财「行业板块」是细分板块，不是申万一级行业。
"""
import json, ssl, gzip, time, os, sys, datetime, urllib.request, urllib.error, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CTX = ssl._create_unverified_context()
ROOT = os.getcwd()
WARN = []


def get(url, timeout=30, tries=3):
    """带重试的 GET；返回 (status, text) 或 (None, 错误串)。"""
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
# 一、行业宽度（东财行业板块口径）
# =====================================================================
EM_LIST = ("https://push2.eastmoney.com/api/qt/clist/get?pn=%d&pz=100&po=1&np=1"
           "&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3")
EM_KL = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.%s&klt=101&fqt=1"
         "&beg=20100101&end=20500101&fields1=f1,f2,f3"
         "&fields2=f51,f52,f53,f54,f55,f56,f57,f58")


def get_boards():
    out, total = [], None
    for pn in range(1, 7):
        st, txt = get(EM_LIST % pn, timeout=25)
        d = (jload(txt).get("data") or {})
        diff = d.get("diff") or []
        if isinstance(diff, dict):
            diff = list(diff.values())
        total = d.get("total") or total
        if not isinstance(diff, list) or not diff:
            break
        out += [x for x in diff if isinstance(x, dict) and x.get("f12") and x.get("f14")]
        if total and len(out) >= total:
            break
        time.sleep(0.25)
    # 去重
    seen, uniq = set(), []
    for b in out:
        if b["f12"] not in seen:
            seen.add(b["f12"])
            uniq.append(b)
    print("板块清单", len(uniq), "total", total)
    return uniq


def one_board(b):
    code, name = b["f12"], b["f14"]
    st, txt = get(EM_KL % code, timeout=30, tries=3)
    o = jload(txt)
    kl = (o.get("data") or {}).get("klines") or []
    series = {}
    if isinstance(kl, list):
        for line in kl:
            p = line.split(",")
            if len(p) < 7:
                continue
            try:
                series[p[0]] = (float(p[2]), float(p[6]))  # close, amount
            except Exception:
                continue
    return {"code": code, "name": name, "series": series, "ok": len(series) >= 220}


def build_industry():
    boards = get_boards()
    if not boards:
        raise RuntimeError("东财板块清单为空，无法生成行业宽度")
    res = []
    # 低并发 + 每请求自带 3 次重试，避开东财限流
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {ex.submit(one_board, b): b for b in boards}
        for f in as_completed(futs):
            try:
                res.append(f.result())
            except Exception as e:
                WARN.append("板块任务异常: %s" % str(e)[:100])
    ok = [r for r in res if r["ok"]]
    ok.sort(key=lambda x: x["code"])
    print("板块日线成功", len(ok), "/", len(boards))
    if len(ok) < 31:
        raise RuntimeError("仅 %d 个板块拿到 >=220 根日线，不足 31，拒绝生成空壳" % len(ok))
    if len(ok) < len(boards):
        WARN.append("板块日线成功 %d/%d，热力图按实际成功数全铺" % (len(ok), len(boards)))

    # 全局交易日 = 所有成功板块日期的并集
    all_days = sorted(set().union(*[set(r["series"]) for r in ok]))
    # 只保留 2016 年以后，MA200 需要预热但更早的样本对 10 年窗口无意义
    all_days = [d for d in all_days if d >= "2016-01-01"]
    if len(all_days) < 250:
        raise RuntimeError("全局交易日仅 %d 天，不足" % len(all_days))

    # 为每个板块建按日期索引的 close 列表，便于算 MA
    prepared = []
    for r in ok:
        ds = sorted(r["series"])
        prepared.append({"name": r["name"], "code": r["code"],
                         "dates": ds, "close": [r["series"][d][0] for d in ds],
                         "amt": [r["series"][d][1] for d in ds]})

    # 逐日指标（只对 10 年窗口算；MA 用前缀和，避免 O(n^2)）
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

    # 七项：行业宽度(=MA20占比)、MA60、MA200、上涨占比、20日动量为正占比、中位动量分位、成交额分位
    keys = ["行业宽度", "MA60占比", "MA200占比", "上涨占比", "动量>0占比", "中位动量分位", "成交额分位"]
    seqs = {"行业宽度": breadth_series, "MA60占比": ma60_series, "MA200占比": ma200_series,
            "上涨占比": up_series, "动量>0占比": posmom_series,
            # 滚动 5 年窗口分位（250 日预热后才有值）
            "中位动量分位": [pct(mom_series[max(0, i - 1250):i + 1], mom_series[i]) if i > 250 else None for i in range(len(mom_series))],
            "成交额分位": [pct(amt_series[max(0, i - 1250):i + 1], amt_series[i]) if i > 250 else None for i in range(len(amt_series))]}

    today = [v(seqs[k]) for k in keys]
    lastweek = [v(seqs[k], 5) for k in keys]

    area = {}
    for Y, N in [(5, 61), (10, 121)]:
        wset = set(window(days, Y))
        wd = [i for i, d in enumerate(days) if d in wset]
        labels = [days[i][:7] for i in wd]
        series = {}
        for k in keys:
            series[k] = sample([seqs[k][i] for i in wd], N)
        area[str(Y)] = {"labels": sample(labels, N), "series": series}

    # 热力图：最近 6 个交易日，每个板块当日涨跌 与 距 MA20 乖离
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

    # 温度条：七指标 × 最近 24 周（每周取最后一个交易日）
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
        "format": "wufu-dash-industry-v1",
        "dataAsOf": last,
        "source": "东财行业板块（m:90+t:2，细分板块，非申万一级行业）",
        "boardCount": len(ok),
        "boardTotal": len(boards),
        "sampleDays": len(days),
        "sampleFrom": days[0] if days else None,
        "sampleNote": "样本 %d 个交易日（%s 起）· %d/%d 个板块成功" % (len(days), days[0] if days else "—", len(ok), len(boards)),
        "keys": keys,
        "indicators": [{"key": k, "name": k, "value": today[j]} for j, k in enumerate(keys)],
        "radar": {"today": today, "lastWeek": lastweek},
        "area": area,
        "heat": {"dates": hd, "names": hnames, "chg": hchg, "bias": hbias},
        "heatbar": {"names": keys, "weeks": weeks, "cells": week_cells},
        "warnings": WARN,
        "note": "宽度 = 当日站上自身20日均线的板块数 / 有数据板块数 ×100；分母是东财细分行业板块，不是全A个股，数值不与参考站直接对照。MA200 需 200 日预热，早期为 null。"
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
    st, txt = get(YAHOO % sym, timeout=30, tries=3)
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
    st, txt = get(GVZ, timeout=30, tries=3)
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
    st, txt = get(AU, timeout=30, tries=3)
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
    for Y, N in [(5, 61), (10, 121)]:
        wd = window(days, Y)
        lb = sample([d[:7] for d in wd], N)
        price, ratio, gline = {}, {}, []
        for s in syms:
            price[s] = sample([round(100 * S[s][d] / S[s][wd[0]], 2) if S[s].get(d) and S[s].get(wd[0]) else None for d in wd], N) if S[s].get(wd[0]) else []
        for rk in rkeys:
            rs = ratios.get(rk, {}).get("series") or {}
            rd = [d for d in wd if d in rs]
            ratio[rk] = sample([round(100 * rs[d] / rs[rd[0]], 2) for d in rd], N) if rd else []
        gd = [d for d in wd if d in G]
        gline = sample([round(G[d], 2) for d in gd], N)
        trend[str(Y)] = {"labels": lb, "price": price, "ratio": ratio, "gvz": gline}

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


def main():
    print("=== 行业宽度 ===")
    build_industry()
    print("=== 黄金看板 ===")
    build_gold()
    save("external-warnings.json", {"warnings": WARN, "at": datetime.datetime.utcnow().isoformat() + "Z"})
    print("完成，warnings:", WARN)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
