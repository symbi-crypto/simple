#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微盘股指数接续：东财全 A 截面数据完整性探针（只在 GitHub Actions 出口跑）"""
import json, time, urllib.request, urllib.error, statistics, datetime, os, sys

OUT = 'probe-microcap.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
HDR = {'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/'}
HOSTS = ['https://82.push2.eastmoney.com', 'https://push2.eastmoney.com', 'https://16.push2.eastmoney.com']
FIELDS = 'f12,f14,f2,f3,f20,f21,f6,f8,f26,f124,f13'
FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'   # 沪主板/深主板/创业板/科创板（不含北交所）


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=HDR)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
        return r.status, body, round(time.time() - t0, 2), None
    except Exception as e:
        return None, '', round(time.time() - t0, 2), '%s: %s' % (type(e).__name__, str(e)[:160])


def clist_url(host, pz=10000, extra=''):
    return ('%s/api/qt/clist/get?pn=1&pz=%d&po=1&np=1&fltt=2&invt=2&fid=f3'
            '&fs=%s&fields=%s%s') % (host, pz, FS, FIELDS, extra)


def num(v):
    """东财 '-' / '' / None 视为缺失；返回 float 或 None"""
    if v is None or v == '-' or v == '' or v == 'null':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


report = {
    'probe_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'question': '按万得微盘股规则自制指数，东财全A截面数据齐不齐',
    'sources': [], 'snapshot': None, 'repeat': [], 'history': [],
}

# ---- 出口 IP ----
st, body, el, err = fetch('https://api.ipify.org?format=json', 15)
try:
    report['exit_ip'] = json.loads(body).get('ip')
except Exception:
    report['exit_ip'] = err or body[:80]
print('出口 IP:', report['exit_ip'])

# ---- 主探针：三个域名，pz=10000 一次拿全市场 ----
main = None
for host in HOSTS:
    url = clist_url(host)
    st, body, el, err = fetch(url)
    rec = {'id': host.split('//')[1], 'status': st, 'sec': el, 'err': err}
    if st == 200:
        try:
            d = json.loads(body)
            data = d.get('data') or {}
            diff = data.get('diff') or []
            rec['total'] = data.get('total')
            rec['rows'] = len(diff)
            rec['sample'] = diff[0] if diff else None
            if diff and main is None:
                main = (host, diff, data.get('total'))
        except Exception as e:
            rec['err'] = 'JSON解析失败: %s / %s' % (e, body[:120])
    else:
        rec['sample'] = body[:200]
    report['sources'].append(rec)
    print('HOST', rec['id'], 'status', st, 'rows', rec.get('rows'), 'total', rec.get('total'), 'err', err)

if main is None:
    report['summary'] = {'ok': False, 'reason': '三个域名均拿不到全A快照'}
    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('FAIL: 无可用快照'); sys.exit(0)

host, diff, total = main

# ---- 字段完整性逐项统计 ----
keys = FIELDS.split(',')
field_stat = {}
for k in keys:
    present = sum(1 for r in diff if k in r)
    nonnull = sum(1 for r in diff if k in r and r[k] not in (None, '-', '', 'null'))
    field_stat[k] = {'present': present, 'nonnull': nonnull,
                     'missing': len(diff) - nonnull}
report['fields'] = field_stat

# 数值字段分布
caps = [num(r.get('f20')) for r in diff]
caps_ok = [c for c in caps if c is not None and c > 0]
floats = [num(r.get('f21')) for r in diff]
floats_ok = [c for c in floats if c is not None and c > 0]
prices = [num(r.get('f2')) for r in diff]
prices_ok = [c for c in prices if c is not None and c > 0]

# 名称 ST / 退市
st_names = [r for r in diff if any(x in str(r.get('f14', '')) for x in ('ST', 'st', '退'))]
st_cnt = sum(1 for r in diff if 'ST' in str(r.get('f14', '')).upper())
tui_cnt = sum(1 for r in diff if '退' in str(r.get('f14', '')))

# 代码前缀分布（看北交所是否混入）
prefix = {}
for r in diff:
    c = str(r.get('f12', ''))
    p = c[:2] if len(c) >= 2 else '??'
    prefix[p] = prefix.get(p, 0) + 1

# 上市日期可用性
dates = [str(r.get('f26', '')) for r in diff]
date_ok = [d for d in dates if len(d) == 8 and d.isdigit() and d[:4] in ('19', '20')]

# 按总市值升序取最小 400 只（正式规则的候选成分）
pool = [(r.get('f12'), r.get('f14'), num(r.get('f20')), r.get('f26'), r.get('f2'))
        for r in diff if num(r.get('f20')) and num(r.get('f20')) > 0]
pool.sort(key=lambda x: x[2])
small400 = pool[:400]
s400_cap = [x[2] for x in small400]
s400_st = sum(1 for x in small400 if 'ST' in str(x[1]).upper() or '退' in str(x[1]))
s400_new = sum(1 for x in small400
               if str(x[3]) and len(str(x[3])) == 8 and str(x[3]).isdigit()
               and (datetime.date(2026, 11, 19) - datetime.date(int(str(x[3])[:4]), int(str(x[3])[4:6]), int(str(x[3])[6:8]))).days < 60)
s400_susp = sum(1 for x in small400 if num(x[4]) is None)

# 用「当日市值 / (1+涨跌幅)」近似还原昨收总市值，看排序口径差多少
pool_prev = []
for r in diff:
    c, ch = num(r.get('f20')), num(r.get('f3'))
    if c and c > 0:
        prev = c / (1 + ch / 100) if ch is not None and ch > -99 else c
        pool_prev.append((r.get('f12'), prev))
pool_prev.sort(key=lambda x: x[1])
overlap = len(set(x[0] for x in small400) & set(x[0] for x in pool_prev[:400]))

report['snapshot'] = {
    'rows': len(diff), 'declared_total': total,
    'cap_nonnull': len(caps_ok), 'cap_zero_or_missing': len(diff) - len(caps_ok),
    'float_nonnull': len(floats_ok),
    'price_nonnull': len(prices_ok), 'price_missing_suspended': len(diff) - len(prices_ok),
    'cap_min': min(caps_ok) if caps_ok else None,
    'cap_median': round(statistics.median(caps_ok), 2) if caps_ok else None,
    'cap_max': max(caps_ok) if caps_ok else None,
    'st_name_count': st_cnt, 'tui_name_count': tui_cnt,
    'prefix_dist': dict(sorted(prefix.items(), key=lambda kv: -kv[1])[:12]),
    'listing_date_ok': len(date_ok),
    'small400': {
        'count': len(small400),
        'cap_min': min(s400_cap) if s400_cap else None,
        'cap_median': round(statistics.median(s400_cap), 2) if s400_cap else None,
        'cap_max': max(s400_cap) if s400_cap else None,
        'st_or_delist': s400_st,
        'listed_lt_60d': s400_new,
        'suspended': s400_susp,
        'sample_first5': [list(map(str, x[:3])) for x in small400[:5]],
        'sample_last2': [list(map(str, x[:3])) for x in small400[-2:]],
    },
    'prevclose_cap_overlap_with_small400': overlap,
    'prevclose_cap_note': '用 f20/(1+f3) 近似昨收总市值；与当日市值排序前400的重合数',
}
print('快照 rows=%s total=%s cap_ok=%s ST=%s small400_ST=%s overlap=%s' % (
    len(diff), total, len(caps_ok), st_cnt, s400_st, overlap))

# ---- 重复请求 / 限流 ----
for i in range(3):
    st, body, el, err = fetch(clist_url(host))
    rows = 0
    tot = None
    if st == 200:
        try:
            d = json.loads(body).get('data') or {}
            rows = len(d.get('diff') or [])
            tot = d.get('total')
        except Exception:
            pass
    report['repeat'].append({'seq': i + 1, 'status': st, 'rows': rows, 'total': tot, 'sec': el, 'err': err})
    print('REPEAT', i + 1, st, rows, el, err)
    time.sleep(1.2)

# ---- 历史截面能不能补（关键判断：单日快照 vs 历史逐日） ----
# A. clist 加日期参数，看是否被忽略（首行/total 是否变化）
for param in ('&date=20261118', '&trade_date=20261118', '&as_of=20261118', '&end_date=20261118'):
    st, body, el, err = fetch(clist_url(host, pz=5, extra=param))
    first, tot = None, None
    if st == 200:
        try:
            d = json.loads(body).get('data') or {}
            dd = d.get('diff') or []
            first = dd[0].get('f12') if dd else None
            tot = d.get('total')
        except Exception:
            pass
    report['history'].append({'test': 'clist' + param, 'status': st,
                              'first_code': first, 'total': tot,
                              'same_as_today': first == (diff[0].get('f12') if diff else None),
                              'sec': el, 'err': err})
    time.sleep(0.8)

# B. 单只股票历史日K（能拿价格，但拿不到历史总市值）
kurl = ('%s/api/qt/stock/kline/get?secid=1.600000&klt=101&fqt=1&lmt=5'
        '&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58' % host)
st, body, el, err = fetch(kurl)
krows = 0
ksample = None
if st == 200:
    try:
        kl = (json.loads(body).get('data') or {}).get('klines') or []
        krows = len(kl)
        ksample = kl[-1] if kl else None
    except Exception:
        pass
report['history'].append({'test': 'push2his kline 单只历史', 'status': st,
                          'rows': krows, 'sample': ksample,
                          'note': '只有 OHLCV，没有历史总市值/股本，无法还原历史市值截面',
                          'sec': el, 'err': err})

# C. 东财 datacenter 历史市值报表候选（探一下有没有按交易日全市场市值）
dc = ('https://datacenter-web.eastmoney.com/api/data/v1/get'
      '?reportName=RPT_DMSK_TS_STOCK&columns=ALL&pageNumber=1&pageSize=5'
      '&filter=(TRADE_DATE%3D%272026-11-18%27)')
st, body, el, err = fetch(dc, 20)
report['history'].append({'test': 'datacenter RPT_DMSK_TS_STOCK', 'status': st,
                          'sample': body[:220], 'sec': el, 'err': err})

# ---- 结论 ----
cap_rate = len(caps_ok) / len(diff) if diff else 0
report['summary'] = {
    'ok': bool(diff) and cap_rate > 0.95 and len(small400) == 400,
    'rows': len(diff),
    'cap_coverage': round(cap_rate, 4),
    'st_identified_by_name': st_cnt > 0,
    'listing_date_available': len(date_ok) > len(diff) * 0.9,
    'repeat_all_ok': all(x['status'] == 200 and x['rows'] > 4000 for x in report['repeat']),
    'history_backfill_possible': any(h.get('same_as_today') is False and h.get('total') for h in report['history']),
    'verdict': '',
}
s = report['summary']
s['verdict'] = ('当日全A快照齐，可支撑「从今天起逐日累积」；'
                '历史逐日市值截面补不回来（clist 忽略日期参数，单只K线无市值字段）。')

json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('---- SUMMARY ----')
print(json.dumps(s, ensure_ascii=False, indent=2))
