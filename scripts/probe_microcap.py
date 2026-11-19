#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v6 矩阵：每个独立 runner 只发 1 个东财请求，测不同 pz 能返回几行"""
import json, time, urllib.request, urllib.error, os

PZ = int(os.environ.get('PZ', '100'))
OUT = 'probe-pz-%d.json' % PZ
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/122.0.0.0 Safari/537.36')
HDR = {
    'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/center/gridlist.html',
    'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"', 'sec-ch-ua-platform': '"Windows"',
}
FIELDS = 'f12,f14,f2,f3,f20,f21,f6,f8,f26,f124,f13'
FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
UT = 'fa5fd1943c7b386f172d6893dbfba10b'
url = ('https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=%d&po=1&np=1'
       '&fltt=2&invt=2&fid=f3&ut=%s&fs=%s&fields=%s') % (PZ, UT, FS, FIELDS)

t0 = time.time()
try:
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=45) as r:
        st, body = r.status, r.read().decode('utf-8', 'replace')
    el, err = round(time.time() - t0, 2), None
except Exception as e:
    st, body, el, err = None, '', round(time.time() - t0, 2), '%s: %s' % (type(e).__name__, str(e)[:160])

res = {'pz': PZ, 'status': st, 'sec': el, 'err': err,
       'probe_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
try:
    r = urllib.request.Request('https://api.ipify.org?format=json', headers={'User-Agent': UA})
    with urllib.request.urlopen(r, timeout=15) as x:
        res['exit_ip'] = json.loads(x.read().decode()).get('ip')
except Exception as e:
    res['exit_ip'] = str(e)[:80]

diff, total = [], None
if st == 200:
    try:
        d = (json.loads(body).get('data') or {})
        diff, total = d.get('diff') or [], d.get('total')
    except Exception as e:
        res['parse_err'] = str(e)

res['rows'] = len(diff)
res['declared_total'] = total
res['first3'] = [str(x.get('f12')) + ' ' + str(x.get('f14')) for x in diff[:3]]
if diff:
    nn = {}
    for k in FIELDS.split(','):
        nn[k] = sum(1 for r in diff if k in r and r[k] not in (None, '-', '', 'null'))
    res['field_nonnull'] = nn
    res['sample'] = diff[0]
    caps = []
    for r in diff:
        v = r.get('f20')
        try:
            c = float(v)
            if c > 0:
                caps.append(c)
        except (TypeError, ValueError):
            pass
    res['cap_nonnull'] = len(caps)
    res['st_count'] = sum(1 for r in diff if 'ST' in str(r.get('f14', '')).upper())
    res['date_ok'] = sum(1 for r in diff
                         if len(str(r.get('f26', ''))) == 8 and str(r.get('f26', '')).isdigit())
print('PZ=%s status=%s rows=%s total=%s cap=%s st=%s date_ok=%s err=%s' % (
    PZ, st, len(diff), total, res.get('cap_nonnull'), res.get('st_count'),
    res.get('date_ok'), err), flush=True)
json.dump(res, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
