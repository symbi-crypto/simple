# -*- coding: utf-8 -*-
"""第二轮：用 sw_index_first_info 的 31 个一级代码，逐个抓 index_hist_sw 日线。"""
import json, time
import akshare as ak

res = {'hist': [], 'summary': {}}
try:
    df = ak.sw_index_first_info()
    codes = [(str(r['行业代码']).split('.')[0], str(r['行业名称']))
             for r in df[['行业代码', '行业名称']].to_dict('records')]
    res['summary']['code_rows'] = len(codes)
except Exception as e:
    codes = []
    res['summary']['code_err'] = str(e)[:200]

start = time.time()
for i, (code, name) in enumerate(codes, 1):
    row = dict(code=code, name=name)
    for attempt in range(2):
        try:
            d = ak.index_hist_sw(symbol=code, period='day')
            row.update(ok=True, rows=len(d),
                       cols=[str(x) for x in d.columns],
                       first=str(d.iloc[0].to_dict())[:180],
                       last=str(d.iloc[-1].to_dict())[:180])
            break
        except Exception as e:
            row.update(ok=False, err=str(e)[:180], attempt=attempt + 1)
            time.sleep(1.5)
    res['hist'].append(row)
    print(i, '/', len(codes), code, name, row.get('ok'), row.get('rows', 0),
          str(row.get('err', ''))[:80], flush=True)
    time.sleep(0.7)

ok = [x for x in res['hist'] if x.get('ok')]
res['summary'].update(
    total=len(codes), ok_count=len(ok),
    rows_min=min([x['rows'] for x in ok], default=0),
    rows_max=max([x['rows'] for x in ok], default=0),
    elapsed_sec=round(time.time() - start, 1),
    failed=[dict(code=x['code'], name=x['name'], err=x.get('err'))
            for x in res['hist'] if not x.get('ok')])

# 顺带确认实时行情接口
try:
    rt = ak.index_realtime_sw(symbol='一级行业')
    res['summary']['realtime_rows'] = len(rt)
    res['summary']['realtime_cols'] = [str(x) for x in rt.columns]
except Exception as e:
    res['summary']['realtime_err'] = str(e)[:180]

with open('probe-sw2-result.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2, default=str)
print('SUMMARY', json.dumps(res['summary'], ensure_ascii=False, default=str)[:1500], flush=True)
