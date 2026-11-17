# -*- coding: utf-8 -*-
"""链 A（东财族）：美股 ETF 日线静态基线 + 周度增量追加。

首次：2012-01-03 起全量抓 5 只（文章主段 2012-2024 完整可验）。
之后：只读已有 us-etf-daily.json，从各自末日+1 追加，不重算历史。
任何一只抓取失败 -> 保留该只已有真值、写 warnings、整步红灯（不绿灯伪装）。
数据源统一为东财前复权（fqt=1），不引入 Yahoo，避免混用复权口径。
"""
import json, os, sys, time, datetime, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'us-etf-daily.json')
START = '20120101'
END = '20500101'

# 文章 5 只标的：东财 secid 前缀 105=NASDAQ / 107=NYSE Arca
SYMBOLS = [
    ('XLV',  '107.XLV',  '医疗ETF-SPDR'),
    ('XLP',  '107.XLP',  '日常消费ETF-SPDR'),
    ('QQQ',  '105.QQQ',  '纳斯达克100ETF-Invesco'),
    ('TQQQ', '105.TQQQ', '三倍做多纳斯达克100ETF-ProShare'),
    ('BTAL', '107.BTAL', 'AGF U.S. Market Neutral Anti-Beta'),
]
# 紧凑列：date, open, close, high, low, volume, amount(元)
COLS = ['d', 'o', 'c', 'h', 'l', 'v', 'a']

KL = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?'
      'secid=%s&fields1=f1,f2,f3,f4,f5,f6&'
      'fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&beg=%s&end=%s')


def get(url, timeout=20, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            last = e
            if i < tries - 1:
                time.sleep(1.5 * (i + 1))
    raise RuntimeError('请求失败 %s: %s' % (url[:90], last))


def fetch(secid, beg):
    d = get(KL % (secid, beg, END)).get('data')
    if not d or not d.get('klines'):
        return None, []
    rows = []
    for line in d['klines']:
        p = line.split(',')
        # date, open, close, high, low, volume, amount, amplitude
        rows.append([p[0], float(p[1]), float(p[2]), float(p[3]),
                     float(p[4]), int(float(p[5])), float(p[6])])
    return d.get('name'), rows


def load():
    if not os.path.exists(OUT):
        return None
    try:
        with open(OUT, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def main():
    old = load()
    is_inc = bool(old and old.get('series'))
    out = {
        'format': 'us-etf-daily/1',
        'chain': 'A',                       # 三条链统一标识：L 本地 / A 东财+申万 / G Yahoo+CBOE
        'contract': 'chain/1',
        'source': 'eastmoney/kline fqt=1',  # 单一上游，不混用 Yahoo
        'adjust': '前复权（东财 fqt=1，含分红再投）',
        'cols': COLS,
        'symbols': [],
        'series': {},
        'warnings': [],
    }
    errs = []
    for sym, secid, label in SYMBOLS:
        prev = (old or {}).get('series', {}).get(sym, {}).get('rows', []) if is_inc else []
        beg = START
        if prev:
            last = prev[-1][0].replace('-', '')
            beg = (datetime.datetime.strptime(last, '%Y%m%d') +
                   datetime.timedelta(days=1)).strftime('%Y%m%d')
            if beg > '20261117':
                beg = last  # 已是最新，重取末日确认
        try:
            name, rows = fetch(secid, beg)
            if prev and rows:
                # 去重：只保留严格晚于已有末日的新行
                last = prev[-1][0]
                rows = [r for r in rows if r[0] > last]
                merged = prev + rows
            elif prev and not rows:
                merged = prev
            else:
                merged = rows
            if not merged:
                raise RuntimeError('返回 0 行')
            out['series'][sym] = {'secid': secid, 'name': name or label, 'rows': merged}
            out['symbols'].append({
                'sym': sym, 'secid': secid, 'name': name or label,
                'from': merged[0][0], 'to': merged[-1][0], 'bars': len(merged),
                'added': len(rows) if prev else len(merged),
            })
            print('%s %s %s→%s 共%d根 本次+%d' %
                  (sym, name or label, merged[0][0], merged[-1][0],
                   len(merged), len(rows) if prev else len(merged)), flush=True)
        except Exception as e:
            msg = '%s 抓取失败：%s: %s' % (sym, type(e).__name__, str(e)[:150])
            errs.append(msg)
            out['warnings'].append(msg)
            if prev:  # 沿用上次真值，不摆空壳
                out['series'][sym] = old['series'][sym]
                out['symbols'].append({'sym': sym, 'secid': secid,
                                       'name': old['series'][sym]['name'],
                                       'from': prev[0][0], 'to': prev[-1][0],
                                       'bars': len(prev), 'added': 0,
                                       'stale': True})
                out['warnings'].append('%s 沿用上次真值，末日 %s' % (sym, prev[-1][0]))
            print(msg, flush=True)

    dates = [s['to'] for s in out['symbols']]
    out['dataAsOf'] = max(dates) if dates else None
    out['ok'] = not errs
    # 共同交易日（年度再平衡对齐用）
    sets = [set(r[0] for r in v['rows']) for v in out['series'].values()]
    out['commonDays'] = len(set.intersection(*sets)) if sets else 0
    out['sampleNote'] = ('2012-01-03 起；TQQQ 2010 上市、BTAL 2011 上市，'
                         '2012 起 5 只均有真实行情；1999/2000 起需合成杠杆与对冲腿，本基线不含。')
    out['note'] = ('文章主段 2012-2024 可直接用本基线回测；东财美股 ETF 历史起点为 '
                   'QQQ 2001 / XLV,XLP 2005 / TQQQ 2011 / BTAL 2011，1999 段须另接 Yahoo（链 G）。')

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('写出 %s %d 字节 | dataAsOf=%s | 共同交易日=%d | ok=%s' %
          (OUT, os.path.getsize(OUT), out['dataAsOf'], out['commonDays'], out['ok']), flush=True)
    if errs:
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
