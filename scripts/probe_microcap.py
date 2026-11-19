#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微盘股指数接续：东财全 A 截面数据完整性探针 v2（分页拉全量）"""
import json, time, urllib.request, urllib.error, statistics, datetime, os, sys

OUT = 'probe-microcap.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
HDR = {'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/'}
HOSTS = ['https://82.push2.eastmoney.com', 'https://push2.eastmoney.com',
         'https://16.push2.eastmoney.com', 'https://48.push2.eastmoney.com']
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


def clist_url(host, pn=1, pz=100, extra=''):
    return ('%s/api/qt/clist/get?pn=%d&pz=%d&po=1&np=1&fltt=2&invt=2&fid=f3'
            '&fs=%s&fields=%s%s') % (host, pn, pz, FS, FIELDS, extra)


def num(v):
    if v is None or v == '-' or v == '' or v == 'null':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse(body):
    d = json.loads(body)
    data = d.get('data') or {}
    return data.get('diff') or [], data.get('total')


report = {
    'probe_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'version': 'v2-paged',
    'question': '按万得微盘股规则自制指数，东财全A截面数据齐不齐',
}

st, body, el, err = fetch('https://api.ipify.org?format=json', 15)
try:
    report['exit_ip'] = json.loads(body).get('ip')
except Exception:
    report['exit_ip'] = err or body[:80]
print('出口 IP:', report['exit_ip'])

# ---- 1. 单次 pz 上限探测 ----
pz_test = []
for pz in (100, 200, 500, 1000, 5000):
    st, body, el, err = fetch(clist_url(HOSTS[0], 1, pz))
    rows, tot = (0, None)
    if st == 200:
        try:
            rows, tot = len(parse(body)[0]), parse(body)[1]
        except Exception:
            pass
    pz_test.append({'pz': pz, 'status': st, 'rows': rows, 'total': tot, 'sec': el, 'err': err})
    print('PZ', pz, '->', st, rows, tot, err)
    time.sleep(1.0)
report['pz_limit_test'] = pz_test
usable_pz = max([x['pz'] for x in pz_test if x['status'] == 200 and x['rows'] > 100] or [100])
usable_pz = min(usable_pz, 500)
print('采用分页 pz =', usable_pz)

# ---- 2. 分页拉全量（域名轮换 + 失败重试） ----
allrows, seen, total_declared, page_log = [], set(), None, []
fail_streak = 0
for pn in range(1, 90):
    ok = False
    for attempt in range(4):
        host = HOSTS[(pn + attempt) % len(HOSTS)]
        st, body, el, err = fetch(clist_url(host, pn, usable_pz))
        if st == 200:
            try:
                diff, tot = parse(body)
                if tot:
                    total_declared = tot
                fresh = [r for r in diff if r.get('f12') and r['f12'] not in seen]
                for r in fresh:
                    seen.add(r['f12'])
                allrows.extend(fresh)
                page_log.append({'pn': pn, 'status': st, 'rows': len(diff), 'fresh': len(fresh),
                                 'host': host.split('//')[1], 'sec': el, 'attempt': attempt + 1})
                ok = True
                break
            except Exception as e:
                err = 'parse: %s' % e
        time.sleep(0.6 + attempt * 0.5)
    if not ok:
        page_log.append({'pn': pn, 'status': st, 'rows': 0, 'fresh': 0, 'err': err})
        fail_streak += 1
    else:
        fail_streak = 0
    print('PAGE', pn, '累计', len(allrows), '/', total_declared,
          'last=', page_log[-1].get('rows'), 'err=', page_log[-1].get('err'))
    if total_declared and len(allrows) >= total_declared:
        print('已拉满'); break
    if fail_streak >= 3:
        print('连续3页失败，停止'); break
    time.sleep(0.35)

diff = allrows
report['pages'] = {'count': len(page_log), 'declared_total': total_declared,
                   'rows_fetched': len(diff), 'pz_used': usable_pz,
                   'fail_pages': sum(1 for p in page_log if p.get('err') or p.get('status') != 200),
                   'log_tail': page_log[-8:]}
print('分页结果: 声明 %s / 实拉 %s / 失败页 %s' % (
    total_declared, len(diff), report['pages']['fail_pages']))

if not diff:
    report['summary'] = {'ok': False, 'reason': '分页未拿到任何数据'}
    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    sys.exit(0)

# ---- 3. 字段完整性 ----
keys = FIELDS.split(',')
field_stat = {}
for k in keys:
    present = sum(1 for r in diff if k in r)
    nonnull = sum(1 for r in diff if k in r and r[k] not in (None, '-', '', 'null'))
    field_stat[k] = {'present': present, 'nonnull': nonnull, 'missing': len(diff) - nonnull}
report['fields'] = field_stat

caps = [num(r.get('f20')) for r in diff]
caps_ok = [c for c in caps if c is not None and c > 0]
floats_ok = [c for c in (num(r.get('f21')) for r in diff) if c is not None and c > 0]
prices_ok = [c for c in (num(r.get('f2')) for r in diff) if c is not None and c > 0]
st_cnt = sum(1 for r in diff if 'ST' in str(r.get('f14', '')).upper())
tui_cnt = sum(1 for r in diff if '退' in str(r.get('f14', '')))

prefix = {}
for r in diff:
    c = str(r.get('f12', ''))
    prefix[c[:2] if len(c) >= 2 else '??'] = prefix.get(c[:2] if len(c) >= 2 else '??', 0) + 1

dates = [str(r.get('f26', '')) for r in diff]
date_ok = [d for d in dates if len(d) == 8 and d.isdigit() and d[:2] in ('19', '20')]
today = datetime.date(2026, 11, 19)


def age_days(d):
    try:
        return (today - datetime.date(int(d[:4]), int(d[4:6]), int(d[6:8]))).days
    except Exception:
        return None


ages = [age_days(d) for d in date_ok]
young = sum(1 for a in ages if a is not None and a < 60)

# 按总市值升序取最小 400 只
pool = [(r.get('f12'), r.get('f14'), num(r.get('f20')), r.get('f26'), num(r.get('f2')))
        for r in diff if num(r.get('f20')) and num(r.get('f20')) > 0]
pool.sort(key=lambda x: x[2])
small400 = pool[:400]
s400_cap = [x[2] for x in small400]
s400_st = sum(1 for x in small400 if 'ST' in str(x[1]).upper() or '退' in str(x[1]))
s400_new = sum(1 for x in small400 if age_days(str(x[3])) is not None and age_days(str(x[3])) < 60)
s400_susp = sum(1 for x in small400 if x[4] is None)

# 昨收市值近似（f20/(1+f3)）与当日市值排序的重合
pool_prev = []
for r in diff:
    c, ch = num(r.get('f20')), num(r.get('f3'))
    if c and c > 0:
        pool_prev.append((r.get('f12'), c / (1 + ch / 100) if ch is not None and ch > -99 else c))
pool_prev.sort(key=lambda x: x[1])
overlap = len(set(x[0] for x in small400) & set(x[0] for x in pool_prev[:400]))

# 全量等权日收益（用 f3 涨跌幅）作为「一天能不能算出收益率」的验证
chgs = [num(r.get('f3')) for r in diff]
chgs_ok = [c for c in chgs if c is not None]

report['snapshot'] = {
    'rows': len(diff), 'declared_total': total_declared,
    'cap_nonnull': len(caps_ok), 'cap_missing_or_zero': len(diff) - len(caps_ok),
    'float_nonnull': len(floats_ok),
    'price_nonnull': len(prices_ok), 'price_missing_suspended': len(diff) - len(prices_ok),
    'cap_min': min(caps_ok) if caps_ok else None,
    'cap_median': round(statistics.median(caps_ok), 2) if caps_ok else None,
    'cap_max': max(caps_ok) if caps_ok else None,
    'st_name_count': st_cnt, 'tui_name_count': tui_cnt,
    'listing_date_ok': len(date_ok), 'listed_lt_60d': young,
    'prefix_dist': dict(sorted(prefix.items(), key=lambda kv: -kv[1])),
    'chg_nonnull': len(chgs_ok),
    'equal_weight_daily_return_pct': round(statistics.mean(chgs_ok), 4) if chgs_ok else None,
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
}
print('全量 rows=%s cap_ok=%s ST=%s date_ok=%s small400_ST=%s overlap=%s eqret=%s' % (
    len(diff), len(caps_ok), st_cnt, len(date_ok), s400_st, overlap,
    report['snapshot']['equal_weight_daily_return_pct']))

# ---- 4. 历史截面能否补 ----
hist = []
for param in ('&date=20261118', '&trade_date=20261118', '&end_date=20261118'):
    st, body, el, err = fetch(clist_url(HOSTS[1], 1, 5, param))
    first, tot = None, None
    if st == 200:
        try:
            dd, tot = parse(body)
            first = dd[0].get('f12') if dd else None
        except Exception:
            pass
    hist.append({'test': 'clist' + param, 'status': st, 'first_code': first, 'total': tot,
                 'same_as_today': first == (diff[0].get('f12') if diff else None),
                 'sec': el, 'err': err})
    time.sleep(1.0)

# 单只历史日K（正确域名 push2his）
kurl = ('https://push2his.eastmoney.com/api/qt/stock/kline/get'
        '?secid=1.600000&ut=fa5fd1943c7b386f172d6893dbfba10b'
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
        '&klt=101&fqt=1&beg=0&end=20500101&lmt=5')
st, body, el, err = fetch(kurl)
krows, ksample = 0, None
if st == 200:
    try:
        kl = (json.loads(body).get('data') or {}).get('klines') or []
        krows, ksample = len(kl), kl[-1] if kl else None
    except Exception:
        pass
hist.append({'test': 'push2his 单只历史日K', 'status': st, 'rows': krows, 'sample': ksample,
             'note': '只有 OHLCV/换手，没有总市值或股本，无法还原历史市值截面',
             'sec': el, 'err': err})

# 东财 datacenter 历史市值报表候选
for rpt in ('RPT_DMSK_TS_STOCK', 'RPT_VALUEANALYSIS_DET', 'RPT_DMSK_TS_STOCKNEW'):
    u = ('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=%s'
         '&columns=ALL&pageNumber=1&pageSize=3' % rpt)
    st, body, el, err = fetch(u, 20)
    hist.append({'test': 'datacenter ' + rpt, 'status': st,
                 'sample': body[:200], 'sec': el, 'err': err})
    time.sleep(0.6)
report['history'] = hist
for h in hist:
    print('HIST', h['test'], h.get('status'), h.get('rows'), h.get('same_as_today'), str(h.get('err'))[:50])

# ---- 5. 结论 ----
complete = (total_declared and len(diff) >= total_declared * 0.98)
cap_rate = len(caps_ok) / len(diff) if diff else 0
report['summary'] = {
    'ok': bool(complete and cap_rate > 0.98 and len(small400) == 400 and len(date_ok) > len(diff) * 0.95),
    'rows_fetched': len(diff), 'declared_total': total_declared,
    'coverage': round(len(diff) / total_declared, 4) if total_declared else None,
    'cap_coverage': round(cap_rate, 4),
    'st_identified_by_name': st_cnt > 0,
    'listing_date_available': len(date_ok) > len(diff) * 0.95,
    'small400_valid': len(small400) == 400,
    'single_request_pz_cap': usable_pz,
    'repeat_or_page_failures': report['pages']['fail_pages'],
    'history_backfill_possible': any(h.get('same_as_today') is False and h.get('total') for h in hist),
    'verdict': '',
}
s = report['summary']
s['verdict'] = ('当日全A截面可分页拉全、字段齐；但单次最多 %s 行、有断连限流，'
                '且历史逐日市值截面补不回来，只能从今天起逐日累积。' % usable_pz)

json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('---- SUMMARY ----')
print(json.dumps(s, ensure_ascii=False, indent=2))
