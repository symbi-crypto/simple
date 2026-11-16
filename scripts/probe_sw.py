# -*- coding: utf-8 -*-
"""在 GitHub Actions 出口实测微信文章提到的行业抓取接口。"""
import json, re, traceback

SW31 = ['农林牧渔','基础化工','钢铁','有色金属','电子','家用电器','食品饮料',
        '纺织服饰','轻工制造','医药生物','公用事业','交通运输','房地产','商贸零售',
        '社会服务','综合','建筑材料','建筑装饰','电力设备','国防军工','计算机',
        '传媒','通信','银行','非银金融','汽车','机械设备','煤炭','石油石化','环保','美容护理']

res = {}


def run(name, fn):
    try:
        res[name] = dict(ok=True, **fn())
    except Exception as e:
        res[name] = dict(ok=False, err=(str(e) or repr(e))[:400])


import akshare as ak


def em_list():
    df = ak.stock_board_industry_name_em()
    names = df['板块名称'].astype(str).tolist()
    rom = [n for n in names if re.search(r'[ⅠⅡⅢⅣ]|(?<![A-Za-z])(?:II|III|IV)$', n)]
    return dict(rows=len(df), cols=list(map(str, df.columns)),
                first15=names[:15],
                roman_count=len(rom), roman_sample=rom[:15],
                after_drop_roman=len([n for n in names if n not in rom]),
                exact_sw31=[n for n in names if n in SW31],
                has_bk_code='板块代码' in df.columns)


def em_hist():
    df = ak.stock_board_industry_hist_em(symbol='小金属', start_date='20200101',
                                         end_date='20261113', period='日k', adjust='')
    return dict(rows=len(df), cols=list(map(str, df.columns)),
                first=str(df.iloc[0, 0]), last=str(df.iloc[-1, 0]))


def sw_realtime():
    df = ak.index_realtime_sw(symbol='一级行业')
    return dict(rows=len(df), cols=list(map(str, df.columns)),
                head=df.head(3).to_dict('records'))


def sw_first_info():
    df = ak.sw_index_first_info()
    return dict(rows=len(df), cols=list(map(str, df.columns)),
                head=df.head(3).to_dict('records'))


def sw_hist():
    df = ak.index_hist_sw(symbol='801010', period='day')
    return dict(rows=len(df), cols=list(map(str, df.columns)),
                first=str(df.iloc[0].to_dict()), last=str(df.iloc[-1].to_dict()))


def sw_level_one_old():
    df = ak.index_level_one_hist_sw(symbol='801010')
    return dict(rows=len(df), cols=list(map(str, df.columns)))


run('stock_board_industry_name_em', em_list)
run('stock_board_industry_hist_em', em_hist)
run('index_realtime_sw_一级行业', sw_realtime)
run('sw_index_first_info', sw_first_info)
run('index_hist_sw_801010', sw_hist)
run('index_level_one_hist_sw_老接口', sw_level_one_old)

try:
    res['akshare_version'] = ak.__version__
except Exception:
    pass

with open('probe-sw-result.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2, default=str)

print('==== 探针结果 ====')
for k, v in res.items():
    print(k, '=>', json.dumps(v, ensure_ascii=False, default=str)[:900])
