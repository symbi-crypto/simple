#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5 决定性一枪：全新出口 IP 的第一次请求就用 pz=50000，只发 1 次，避免限流干扰"""
import json, time, urllib.request, urllib.error, statistics, datetime

OUT = 'probe-microcap.json'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/122.0.0.0 Safari/537.36')
HDR = {
    'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/center/gridlist.html',
    'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
    'sec-ch-ua-platform': '"Windows"',
}
FIELDS = 'f12,f14,f2,f3,f20,f21,f6,f8,f26,f124,f13'
FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
UT = 'fa5fd1943c7b386f172d6893dbfba10b'
PZ = 50000   # AKShare stock_zh_a_spot_em 用的值

url = ('https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=%d&po=1&np=1'
       '&fltt=2&invt=2&fid=f3&ut=%s&fs=%s&fields=%s') % (PZ, UT, FS, FIELDS)

t0 = time.time()
try:
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=45) as r:
        st, body = r.status, r.read().decode('utf-8', 'replace')
    el, err = round(time.time() - t0, 2), None
except Exception as e:
    st, body, el, err = None, '', round(time.time() - t0, 2), '%s: %s' % (type(e).__name__, str(e)[:200])

report = {
    'probe_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'version': 'v5-single-shot-pz50000',
    'question': '全新出口IP第一次请求 pz=50000 能否一次拿全 5565 只',
    'request_pz': PZ, 'status': st, 'sec': el, 'err': err,
    'note': '本轮只发 1 次请求，避免同IP限流污染结论',
}
try:
    st2, b2, _, _ = None, None, None, None
    r = urllib.request.Request('https://api.ipify.org?format=json', headers={'User-Agent': UA})
    with urllib.request.urlopen(r, timeout=15) as x:
        report['exit_ip'] = json.loads(x.read().decode()).get('ip')
except Exception as e:
    report['exit_ip'] = str(e)[:80]
print('出口IP', report['exit_ip'], 'status', st, 'sec', el, 'err', err, flush=True)

diff, total = [], None
if st == 200:
    try:
        d = (json.loads(body).get('data') or {})
        diff, total = d.get('diff') or [], d.get('total')
    except Exception as e:
        report['parse_err'] = str(e)

report['rows'] = len(diff)
report['declared_total'] = total
report['first3'] = [str(x.get('f12')) + ' ' + str(x.get('f14')) for x in diff[:3]]
print('rows =', len(diff), 'total =', total, 'first3 =', report['first3'], flush=True)

if not diff:
    report['summary'] = {'ok': False, 'reason': '首次请求未拿到数据'}
    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    raise SystemExit(0)


def num(v):
    if v is None or v in ('-', '', 'null'):
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


field_stat = {}
for k in FIELDS.split(','):
    nn = sum(1 for r in diff if k in r and r[k] not in (None, '-', '', 'null'))
    field_stat[k] = {'nonnull': nn, 'missing': len(diff) - nn}
report['fields'] = field_stat

caps_ok = [c for c in (num(r.get('f20')) for r in diff) if c is not None and c > 0]
floats_ok = [c for c in (num(r.get('f21')) for r in diff) if c is not None and c > 0]
prices_ok = [c for c in (num(r.get('f2')) for r in diff) if c is not None and c > 0]
st_cnt = sum(1 for r in diff if 'ST' in str(r.get('f14', '')).upper())
tui_cnt = sum(1 for r in diff if '退' in str(r.get('f14', '')))
prefix = {}
for r in diff:
    c = str(r.get('f12', '')); p = c[:2] if len(c) >= 2 else '??'
    prefix[p] = prefix.get(p, 0) + 1
today = datetime.date(2026, 11, 19)


def age_days(d):
    try:
        return (today - datetime.date(int(d[:4]), int(d[4:6]), int(d[6:8]))).days
    except Exception:
        return None


date_ok = [str(r.get('f26', '')) for r in diff
           if len(str(r.get('f26', ''))) == 8 and str(r.get('f26', '')).isdigit()
           and str(r.get('f26', ''))[:2] in ('19', '20')]
young = sum(1 for d in date_ok if age_days(d) is not None and age_days(d) < 60)

pool = [(r.get('f12'), r.get('f14'), num(r.get('f20')), r.get('f26'), num(r.get('f2')))
        for r in diff if num(r.get('f20')) and num(r.get('f20')) > 0]
pool.sort(key=lambda x: x[2])
small400 = pool[:400]
s400_cap = [x[2] for x in small400]

pool_prev = []
for r in diff:
    c, ch = num(r.get('f20')), num(r.get('f3'))
    if c and c > 0:
        pool_prev.append((r.get('f12'), c / (1 + ch / 100) if ch is not None and ch > -99 else c))
pool_prev.sort(key=lambda x: x[1])
overlap = len(set(x[0] for x in small400) & set(x[0] for x in pool_prev[:400]))
chgs_ok = [c for c in (num(r.get('f3')) for r in diff) if c is not None]

report['snapshot'] = {
    'rows': len(diff), 'declared_total': total,
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
        'st_or_delist': sum(1 for x in small400 if 'ST' in str(x[1]).upper() or '退' in str(x[1])),
        'listed_lt_60d': sum(1 for x in small400 if age_days(str(x[3])) is not None and age_days(str(x[3])) < 60),
        'suspended': sum(1 for x in small400 if x[4] is None),
        'sample_first5': [list(map(str, x[:3])) for x in small400[:5]],
        'sample_last2': [list(map(str, x[:3])) for x in small400[-2:]],
    },
    'prevclose_cap_overlap_with_small400': overlap,
}
print('字段:', {k: v['nonnull'] for k, v in field_stat.items()}, flush=True)
print('全量 rows=%s cap_ok=%s ST=%s date_ok=%s small400_ST=%s overlap=%s eqret=%s' % (
    len(diff), len(caps_ok), st_cnt, len(date_ok),
    report['snapshot']['small400']['st_or_delist'], overlap,
    report['snapshot']['equal_weight_daily_return_pct']), flush=True)

full = bool(total and len(diff) >= total * 0.98)
report['summary'] = {
    'ok': bool(full and len(caps_ok) > len(diff) * 0.98 and len(small400) == 400),
    'single_request_gets_all': full,
    'rows_fetched': len(diff), 'declared_total': total,
    'coverage': round(len(diff) / total, 4) if total else None,
    'cap_coverage': round(len(caps_ok) / len(diff), 4),
    'small400_valid': len(small400) == 400,
    'verdict': ('一次请求即拿全，方案可行：每交易日只需 1 次请求' if full else
                '一次请求仍被截断为 %s 行，自动任务分页拉全会触发限流' % len(diff)),
}
json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('---- SUMMARY ----', flush=True)
print(json.dumps(report['summary'], ensure_ascii=False, indent=2), flush=True)
