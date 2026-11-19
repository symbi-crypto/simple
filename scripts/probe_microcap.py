#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v4 定位：pn>1 是否被挡 / 同IP是否被限流 / ulist.np 批量备选 / AKShare 现成接口"""
import json, time, urllib.request, urllib.error, os, sys

OUT = 'probe-microcap.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
HDR = {'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/', 'Accept': '*/*'}
HOSTS = ['https://82.push2.eastmoney.com', 'https://push2.eastmoney.com',
         'https://16.push2.eastmoney.com']
FIELDS = 'f12,f14,f2,f3,f20,f21,f6,f8,f26,f124,f13'
FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
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


def clist(host, pn, pz=100, extra=''):
    return ('%s/api/qt/clist/get?pn=%d&pz=%d&po=1&np=1&fltt=2&invt=2&fid=f3'
            '&ut=%s&fs=%s&fields=%s%s') % (host, pn, pz, UT, FS, FIELDS, extra)


def one(tag, url):
    st, body, el, err = fetch(url)
    rows, total, first = 0, None, None
    if st == 200:
        try:
            d = (json.loads(body).get('data') or {})
            diff = d.get('diff') or []
            rows, total = len(diff), d.get('total')
            first = diff[0].get('f12') if diff else None
        except Exception as e:
            err = 'parse %s / %s' % (e, body[:100])
    rec = {'tag': tag, 'status': st, 'rows': rows, 'total': total,
           'first': first, 'sec': el, 'err': err, 'raw_head': body[:160] if st != 200 else ''}
    print('%s -> status=%s rows=%s total=%s first=%s err=%s' % (
        tag, st, rows, total, first, err), flush=True)
    return rec


report = {
    'probe_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'version': 'v4-diagnose',
    'question': '东财全A截面：pn>1 是否被挡 / 是否IP限流 / 有无批量备选',
    'prior': [
        'v1 pz=10000 被截断为100行(total 5565)，连续第3次请求断连',
        'v2 pz>100 全被断连或502，随后连续3页全失败',
        'v3 预请求拿到 total=5565，但 pn=1..6 六页全 502/断连，耗时341s',
    ],
}
st, b, _, e = fetch('https://api.ipify.org?format=json', 15)
try:
    report['exit_ip'] = json.loads(b).get('ip')
except Exception:
    report['exit_ip'] = e
print('出口IP', report['exit_ip'], flush=True)
time.sleep(3)

# ---- A. 交替 pn=1 / pn>1，间隔 8s，判断是分页被挡还是IP限流 ----
seq = []
for i, pn in enumerate([1, 2, 1, 10, 1, 30, 1]):
    host = HOSTS[i % len(HOSTS)]
    seq.append(one('A%d pn=%d %s' % (i + 1, pn, host.split('//')[1]), clist(host, pn)))
    time.sleep(8)
report['seq_pn'] = seq

# ---- B. ulist.np 批量查（一次给多个 secid），看能否拿到含 f20 的市值 ----
secids = '1.600000,0.000001,1.600519,0.300750,1.688981'
u = ('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
     '&fields=f12,f14,f2,f3,f20,f21&secids=%s&ut=%s' % (secids, UT))
seqb = one('B ulist.np 批量5只', u)
report['ulist'] = seqb
time.sleep(5)

# ---- C. 按市场细分 fs，只取 pn=1，看 total 是否变小（能否靠切 fs 绕开翻页） ----
fss = {
    '沪主板': 'm:1+t:2', '深主板': 'm:0+t:6', '创业板': 'm:0+t:80', '科创板': 'm:1+t:23',
}
seqc = []
for k, fs in fss.items():
    url = ('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1'
           '&fltt=2&invt=2&fid=f3&ut=%s&fs=%s&fields=%s' % (UT, fs, FIELDS))
    seqc.append(one('C %s' % k, url))
    time.sleep(6)
report['fs_split'] = seqc

# ---- D. pz 小值 + pn=1 重复，看是否随时间恢复（判断封禁窗口） ----
seqd = []
for i in range(3):
    seqd.append(one('D%d pn=1 重复' % (i + 1), clist(HOSTS[i % len(HOSTS)], 1, pz=100)))
    time.sleep(8)
report['seq_repeat'] = seqd

# ---- E. AKShare 现成接口（若已安装） ----
try:
    import akshare as ak
    t0 = time.time()
    df = ak.stock_zh_a_spot_em()
    report['akshare'] = {'available': True, 'rows': len(df),
                         'cols': list(df.columns)[:20], 'sec': round(time.time() - t0, 1),
                         'has_total_mv': any('总市值' in str(c) for c in df.columns)}
    print('AKSHARE rows=%s cols=%s' % (len(df), list(df.columns)[:8]), flush=True)
except Exception as ex:
    report['akshare'] = {'available': False, 'err': str(ex)[:200]}
    print('AKSHARE 不可用:', str(ex)[:120], flush=True)

pn1_ok = sum(1 for x in seq if x['tag'].endswith('pn=1 ' + x['tag'].split()[-1]) or ' pn=1 ' in x['tag'])
report['diagnosis'] = {
    'pn1_success': sum(1 for x in seq if 'pn=1 ' in x['tag'] and x['status'] == 200),
    'pn1_total': sum(1 for x in seq if 'pn=1 ' in x['tag']),
    'pngt1_success': sum(1 for x in seq if 'pn=1 ' not in x['tag'] and x['status'] == 200),
    'pngt1_total': sum(1 for x in seq if 'pn=1 ' not in x['tag']),
    'repeat_success': sum(1 for x in seqd if x['status'] == 200),
    'ulist_ok': seqb['status'] == 200 and seqb['rows'] > 0,
    'akshare_ok': report['akshare'].get('available') and report['akshare'].get('rows', 0) > 4000,
}
print('---- DIAGNOSIS ----', flush=True)
print(json.dumps(report['diagnosis'], ensure_ascii=False, indent=2), flush=True)
json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
