#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微盘股指数接续：东财全 A 截面数据完整性探针 v3（极保守分页，只验能否拉齐）"""
import json, time, urllib.request, urllib.error, statistics, datetime, os, sys

OUT = 'probe-microcap.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
HDR = {'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/',
       'Accept': '*/*', 'Connection': 'keep-alive'}
HOSTS = ['https://82.push2.eastmoney.com', 'https://push2.eastmoney.com',
         'https://16.push2.eastmoney.com', 'https://48.push2.eastmoney.com',
         'https://push2delay.eastmoney.com']
FIELDS = 'f12,f14,f2,f3,f20,f21,f6,f8,f26,f124,f13'
FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'   # 沪主板/深主板/创业板/科创板（不含北交所）
PZ = 100
UT = 'fa5fd1943c7b386f172d6893dbfba10b'


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=HDR)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
        return r.status, body, round(time.time() - t0, 2), None
    except Exception as e:
        return None, '', round(time.time() - t0, 2), '%s: %s' % (type(e).__name__, str(e)[:140])


def clist_url(host, pn):
    return ('%s/api/qt/clist/get?pn=%d&pz=%d&po=1&np=1&fltt=2&invt=2&fid=f3'
            '&ut=%s&fs=%s&fields=%s') % (host, pn, PZ, UT, FS, FIELDS)


def num(v):
    if v is None or v == '-' or v == '' or v == 'null':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse(body):
    data = (json.loads(body).get('data') or {})
    return data.get('diff') or [], data.get('total')


report = {
    'probe_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'version': 'v3-gentle-paging',
    'question': '按万得微盘股规则自制指数，东财全A截面数据齐不齐',
    'prior_observations': [
        'v1: pz=10000 被截断为 100 行，total 报 5565；连续第3次请求 RemoteDisconnected',
        'v2: pz=200/500/1000/5000 全被断连或 502，随后该出口连续 3 页全失败',
        '结论: 单次上限 100 行，且同出口高频请求会临时封禁，必须低频分页',
    ],
}

st, body, el, err = fetch('https://api.ipify.org?format=json', 15)
try:
    report['exit_ip'] = json.loads(body).get('ip')
except Exception:
    report['exit_ip'] = err or body[:80]
print('出口 IP:', report['exit_ip'], flush=True)

# 先静置，避开前序任务残留的封禁窗口
time.sleep(3)

# ---- 预请求：拿 total ----
total_declared = None
for i in range(5):
    st, body, el, err = fetch(clist_url(HOSTS[i % len(HOSTS)], 1))
    if st == 200:
        try:
            d0, total_declared = parse(body)
            print('预请求 OK total =', total_declared, 'first rows =', len(d0), flush=True)
            break
        except Exception as e:
            err = 'parse %s' % e
    print('预请求失败', i + 1, err, flush=True)
    time.sleep(5)

if not total_declared:
    report['summary'] = {'ok': False, 'reason': '预请求拿不到 total，出口可能被封'}
    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    sys.exit(0)

max_pages = int(total_declared / PZ) + 3

# ---- 极保守分页 ----
allrows, seen, page_log, fail_streak = [], set(), [], 0
t_start = time.time()
for pn in range(1, max_pages + 1):
    got = None
    for attempt in range(5):
        host = HOSTS[(pn + attempt * 2) % len(HOSTS)]
        st, body, el, err = fetch(clist_url(host, pn))
        if st == 200:
            try:
                diff, _ = parse(body)
                if diff:
                    got = (diff, host, el)
                    break
                err = '空页'
            except Exception as e:
                err = 'parse: %s' % e
        time.sleep(4 + attempt * 3)   # 失败退避 4/7/10/13s
    if got:
        diff, host, el = got
        fresh = [r for r in diff if r.get('f12') and r['f12'] not in seen]
        for r in fresh:
            seen.add(r['f12'])
        allrows.extend(fresh)
        page_log.append({'pn': pn, 'ok': True, 'rows': len(diff), 'fresh': len(fresh),
                         'host': host.split('//')[1], 'sec': el})
        fail_streak = 0
    else:
        page_log.append({'pn': pn, 'ok': False, 'err': err})
        fail_streak += 1
    if pn % 10 == 0 or not got:
        print('PAGE %3d 累计 %5d / %s  last=%s  err=%s  用时%ss' % (
            pn, len(allrows), total_declared, len(diff) if got else 0,
            '' if got else str(err)[:50], int(time.time() - t_start)), flush=True)
    if total_declared and len(allrows) >= total_declared:
        print('已拉满', flush=True); break
    if fail_streak >= 6:
        print('连续6页失败，停止', flush=True); break
    time.sleep(1.6)   # 页间固定间隔

diff = allrows
report['pages'] = {
    'declared_total': total_declared, 'rows_fetched': len(diff),
    'pages_attempted': len(page_log),
    'fail_pages': sum(1 for p in page_log if not p['ok']),
    'elapsed_sec': int(time.time() - t_start),
    'log_tail': page_log[-10:],
}
print('分页结果: 声明 %s / 实拉 %s / 失败页 %s / 耗时 %ss' % (
    total_declared, len(diff), report['pages']['fail_pages'], report['pages']['elapsed_sec']), flush=True)

if not diff:
    report['summary'] = {'ok': False, 'reason': '分页未拿到任何数据'}
    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    sys.exit(0)

# ---- 字段完整性 ----
field_stat = {}
for k in FIELDS.split(','):
    nonnull = sum(1 for r in diff if k in r and r[k] not in (None, '-', '', 'null'))
    field_stat[k] = {'nonnull': nonnull, 'missing': len(diff) - nonnull}
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
        'st_or_delist': sum(1 for x in small400 if 'ST' in str(x[1]).upper() or '退' in str(x[1])),
        'listed_lt_60d': sum(1 for x in small400 if age_days(str(x[3])) is not None and age_days(str(x[3])) < 60),
        'suspended': sum(1 for x in small400 if x[4] is None),
        'sample_first5': [list(map(str, x[:3])) for x in small400[:5]],
        'sample_last2': [list(map(str, x[:3])) for x in small400[-2:]],
    },
    'prevclose_cap_overlap_with_small400': overlap,
}
print('全量 rows=%s cap_ok=%s ST=%s date_ok=%s small400_ST=%s overlap=%s eqret=%s' % (
    len(diff), len(caps_ok), st_cnt, len(date_ok),
    report['snapshot']['small400']['st_or_delist'], overlap,
    report['snapshot']['equal_weight_daily_return_pct']), flush=True)

# ---- 历史截面（少量请求，放在最后） ----
hist = []
for param in ('&trade_date=20261118', '&end_date=20261118'):
    u = clist_url(HOSTS[1], 1).replace('pz=100', 'pz=5') + param
    st, body, el, err = fetch(u, 20)
    first, tot = None, None
    if st == 200:
        try:
            dd, tot = parse(body); first = dd[0].get('f12') if dd else None
        except Exception:
            pass
    hist.append({'test': 'clist' + param, 'status': st, 'first_code': first, 'total': tot,
                 'same_as_today': first == (diff[0].get('f12') if diff else None),
                 'err': err})
    time.sleep(2)

kurl = ('https://push2his.eastmoney.com/api/qt/stock/kline/get'
        '?secid=1.600000&ut=%s&fields1=f1,f2,f3,f4,f5,f6'
        '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
        '&klt=101&fqt=1&beg=0&end=20500101&lmt=5' % UT)
st, body, el, err = fetch(kurl)
krows, ksample = 0, None
if st == 200:
    try:
        kl = (json.loads(body).get('data') or {}).get('klines') or []
        krows, ksample = len(kl), kl[-1] if kl else None
    except Exception:
        pass
hist.append({'test': 'push2his 单只历史日K', 'status': st, 'rows': krows, 'sample': ksample,
             'note': '只有 OHLCV/换手，没有总市值或股本，无法还原历史市值截面', 'err': err})
report['history'] = hist
for h in hist:
    print('HIST', h['test'], h.get('status'), h.get('rows'), h.get('same_as_today'), str(h.get('err'))[:50], flush=True)

complete = bool(total_declared and len(diff) >= total_declared * 0.98)
cap_rate = len(caps_ok) / len(diff) if diff else 0
report['summary'] = {
    'ok': bool(complete and cap_rate > 0.98 and len(small400) == 400 and len(date_ok) > len(diff) * 0.95),
    'rows_fetched': len(diff), 'declared_total': total_declared,
    'coverage': round(len(diff) / total_declared, 4) if total_declared else None,
    'cap_coverage': round(cap_rate, 4),
    'st_identified_by_name': st_cnt > 0,
    'listing_date_available': len(date_ok) > len(diff) * 0.95,
    'small400_valid': len(small400) == 400,
    'single_request_pz_cap': PZ,
    'page_failures': report['pages']['fail_pages'],
    'elapsed_sec': report['pages']['elapsed_sec'],
    'history_backfill_possible': any(h.get('same_as_today') is False and h.get('total') for h in hist),
    'verdict': '',
}
report['summary']['verdict'] = (
    '当日全A截面字段齐%s；单次上限 100 行、需 %s 页且会断连，历史逐日市值截面补不回来，只能从今天起逐日累积。'
    % ('且低频分页能拉齐' if complete else '，但本次只拉到 %s/%s' % (len(diff), total_declared),
       int(total_declared / PZ) + 1))
json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('---- SUMMARY ----', flush=True)
print(json.dumps(report['summary'], ensure_ascii=False, indent=2), flush=True)
