#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第三轮探针：黄金看板新增跨资产（银/油/铜/BTC）在 GitHub Actions 出口的可达性与对齐性。
只验证「拿不拿得到 / 有多少根 / 日期能否对齐」，不落原始日线进仓库。"""
import json, urllib.request, datetime, os

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get('Content-Type', '')
    except Exception as e:
        return None, b'', '%s: %s' % (type(e).__name__, e)


SYMBOLS = [
    ('GC=F',    'COMEX 黄金期货'),
    ('SI=F',    'COMEX 白银期货'),
    ('CL=F',    'WTI 原油期货'),
    ('BZ=F',    '布伦特原油期货'),
    ('HG=F',    'COMEX 铜期货'),
    ('BTC-USD', '比特币'),
    ('XAUUSD=X', '伦敦金现'),
    ('XAGUSD=X', '伦敦银现'),
]


def yahoo(sym, label):
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?range=10y&interval=1d' % sym
    st, body, extra = fetch(url)
    out = {'symbol': sym, 'label': label, 'url': url, 'status': st, 'bytes': len(body)}
    if st != 200 or not body:
        out['ok'] = False
        out['err'] = extra
        return out, None
    try:
        d = json.loads(body.decode('utf-8'))
        res = d['chart']['result'][0]
        ts = res.get('timestamp') or []
        q = ((res.get('indicators') or {}).get('quote') or [{}])[0]
        closes = q.get('close') or []
        series = {}
        for t, c in zip(ts, closes):
            if c is None:
                continue
            day = datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')
            series[day] = float(c)
        days = sorted(series)
        out.update({
            'ok': bool(series), 'rows': len(series),
            'first': days[0] if days else None, 'last': days[-1] if days else None,
            'last_close': round(series[days[-1]], 4) if days else None,
            'currency': (res.get('meta') or {}).get('currency'),
        })
        return out, series
    except Exception as e:
        out['ok'] = False
        out['err'] = '%s: %s' % (type(e).__name__, e)
        return out, None


def main():
    report = {'run_at': datetime.datetime.utcnow().isoformat() + 'Z', 'sources': [], 'ratios': {}}
    series = {}
    for sym, label in SYMBOLS:
        o, s = yahoo(sym, label)
        report['sources'].append(o)
        if s:
            series[sym] = s
        print('%-10s ok=%-5s rows=%-6s %s -> %s last=%s' % (
            sym, o.get('ok'), o.get('rows', 0), o.get('first'), o.get('last'), o.get('last_close')))

    # 比值必须按「共同交易日」对齐，不能各自最后一根直接除
    pairs = [
        ('金银比', 'GC=F', 'SI=F'),
        ('金油比', 'GC=F', 'CL=F'),
        ('金铜比', 'GC=F', 'HG=F'),
        ('金银比_现货', 'XAUUSD=X', 'XAGUSD=X'),
    ]
    for name, a, b in pairs:
        if a not in series or b not in series:
            report['ratios'][name] = {'ok': False, 'reason': '缺序列'}
            print(name, '缺序列', a, b)
            continue
        common = sorted(set(series[a]) & set(series[b]))
        vals = [(d, series[a][d] / series[b][d]) for d in common if series[b][d]]
        report['ratios'][name] = {
            'ok': bool(vals), 'aligned_days': len(vals),
            'first': vals[0][0] if vals else None, 'last': vals[-1][0] if vals else None,
            'last_value': round(vals[-1][1], 4) if vals else None,
        }
        print('%-12s 对齐天数=%-6s %s -> %s 最新=%s' % (
            name, len(vals), vals[0][0] if vals else '-', vals[-1][0] if vals else '-',
            round(vals[-1][1], 4) if vals else '-'))

    # 五资产归一曲线的共同交易日（BTC 含周末，交集才是能画的天数）
    core = ['GC=F', 'SI=F', 'CL=F', 'HG=F', 'BTC-USD']
    if all(x in series for x in core):
        common = set(series[core[0]])
        for x in core[1:]:
            common &= set(series[x])
        report['normalized_curve_days'] = len(common)
        print('五资产归一曲线共同交易日 =', len(common))

    # 复核 GVZ
    st, body, ct = fetch('https://cdn.cboe.com/api/global/us_indices/daily_prices/GVZ_History.csv')
    gvz = {'ok': False, 'status': st, 'bytes': len(body)}
    if st == 200 and body:
        lines = [l for l in body.decode('utf-8', 'replace').splitlines() if ',' in l]
        gvz.update({'ok': len(lines) > 2, 'rows': len(lines) - 1,
                    'first': lines[1].split(',')[0] if len(lines) > 1 else None,
                    'last': lines[-1].split(',')[0]})
    report['gvz'] = gvz
    print('GVZ', gvz)

    with open('probe-report3.json', 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('报告已写')


if __name__ == '__main__':
    main()
