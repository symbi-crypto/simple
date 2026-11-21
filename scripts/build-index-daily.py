# -*- coding: utf-8 -*-
"""build-index-daily.py — 指数看板快照（v0.84 / 方案 B）
   · 基线：common/index.gz 的真实日线，文件本身一个字节不动，只在内存里读。
   · 增量：state.json 的 wufuQPatch_v1（周度同步写入的真实指数日线），只接基线末日之后。
   · 重算：15 条指数涨跌幅 / 5·10 年分位、沪深300 / 国证2000 双线。
   · 缺口：无增量的序列不编造，曲线在其最后有效日断开，并写进 coverage.gaps。
   · 不引任何外部数据源；抓不到增量就保持基线真值并标注。
"""
import os, json, gzip, datetime

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(p):
    with open(os.path.join(R, p), 'r', encoding='utf-8') as f:
        return json.load(f)


gd = json.loads(gzip.decompress(open(os.path.join(R, 'common/index.gz'), 'rb').read()).decode('utf8'))
cal0 = gd['calendar'] or []
idxm = gd['index'] or {}
state = load('state.json')
try:
    qp = json.loads((state.get('localStorage') or {}).get('wufuQPatch_v1') or '{}')
except Exception:
    qp = {}
base_last = cal0[-1] if cal0 else ''

# 增量日：QPatch（14 条指数）+ 链 I 的国证2000 增量（index-gz2000.json）
seen, qp_rows = set(), {}
for day in (qp.get('days') or []):
    dt = day.get('date')
    if not dt or dt <= base_last:
        continue
    row = {}
    for c, v in (day.get('series') or {}).items():
        if c not in idxm or not isinstance(v, dict):
            continue
        x = v.get('close')
        if not isinstance(x, (int, float)) or x <= 0:
            x = v.get('raw_close')
        if isinstance(x, (int, float)) and x > 0:
            row[c] = float(x)
    if row:
        # 同日多组求并集：后一组只补前一组没有的代码，避免丢掉 930915.CSI 等只出现在前组的增量
        qp_rows.setdefault(dt, {}).update(row)
        seen.add(dt)

# 链 I 补丁：国证2000 真实日线；含基线末日（原值 -1）及其后交易日
gz_patch = {}
try:
    gp = load('index-gz2000.json')
    if gp.get('format') == 'wufu-index-patch-v1':
        for row in (gp.get('days') or []):
            d, v = row.get('date'), row.get('close')
            if isinstance(d, str) and isinstance(v, (int, float)) and v > 0:
                gz_patch[d] = float(v)
except Exception:
    gz_patch = {}

inc_dates = sorted(seen | set(d for d in gz_patch if d > base_last))
cal = cal0 + inc_dates
DATE0 = {d: i for i, d in enumerate(cal0)}
ext = {}
for c, base in idxm.items():
    a = list(base)
    if c == '399303.SZ':
        # 用链 I 真值覆盖基线里无效占位（如 10-30 的 -1），不编造平线
        for d, v in gz_patch.items():
            if d in DATE0:
                a[DATE0[d]] = v
    for d in inc_dates:
        v = (qp_rows.get(d) or {}).get(c)
        if c == '399303.SZ' and d in gz_patch:
            v = gz_patch[d]
        a.append(v if isinstance(v, (int, float)) and v > 0 else None)
    ext[c] = a
inc_codes = set(c for row in qp_rows.values() for c in row)
if any(d > base_last for d in gz_patch):
    inc_codes.add('399303.SZ')

GROUPS = {
    'A': [['000001.SH','上证指数'],['000300.SH','沪深300'],['000510.SH','中证A500'],
          ['000906.SH','中证800'],['000905.SH','中证500'],['399006.SZ','创业板指'],
          ['000680.SH','科创综指'],['000852.SH','中证1000'],['399303.SZ','国证2000']],
    'H': [['HSI.HI','恒生指数'],['HSTECH.HI','恒生科技'],['930915.CSI','港股通高股息']],
    'U': [['SPX.GI','标普500'],['NDX.GI','纳斯达克100'],['DJI.GI','道琼斯工业']],
}
DATE = {d: i for i, d in enumerate(cal)}


def gp(c):
    return [[i, v] for i, v in enumerate(ext.get(c, []))
            if isinstance(v, (int, float)) and v > 0]


def d_of(i):
    return datetime.date.fromisoformat(cal[i])


def pctl(g, years):
    if not g:
        return None
    i, v = g[-1]
    cut = d_of(i) - datetime.timedelta(days=int(365 * years))
    w = [x[1] for x in g if d_of(x[0]) >= cut]
    return round(100 * sum(1 for x in w if x <= v) / len(w)) if w else None


def week_key(d):
    t = datetime.date.fromisoformat(d)
    return (t - datetime.timedelta(days=t.weekday())).isoformat()


def weekly(arr):
    out, last = [], None
    for x in arr:
        w = week_key(x['date'])
        if w != last:
            out.append(x); last = w
        else:
            out[-1] = x
    return out


def line(c, years):
    g = gp(c)
    if len(g) < 2:
        return [], []
    cut = d_of(g[-1][0]) - datetime.timedelta(days=int(365.25 * years))
    w = weekly([{'date': cal[j], 'v': v} for j, v in g if d_of(j) >= cut])
    if len(w) < 2:
        return [], []
    b = w[0]['v']
    return [round(100 * x['v'] / b, 2) for x in w], [x['date'] for x in w]


def last_valid_idx(c):
    a = ext.get(c, [])
    last = -1
    for i, v in enumerate(a):
        if isinstance(v, (int, float)) and v > 0:
            last = i
    return last


def line_on(c, dates, stop=None):
    g = gp(c)
    m = {cal[j]: v for j, v in g}
    last, vals = None, []
    for d in dates:
        i = DATE.get(d, -1)
        if stop is not None and i > stop:
            vals.append(None)          # 缺口之后断开，不编造平线
            continue
        v = m.get(d)
        if v is not None:
            last = v
        vals.append(last)
    b = next((v for v in vals if v is not None), None)
    return [round(100 * v / b, 2) if (v is not None and b) else None for v in vals]


asof = cal[-1] if cal else None
out = {
    'format': 'wufu-dash-idx-v2',
    'dataAsOf': asof,
    'sampleNote': '指数基线 %s 起 %d 交易日 + 日更增量 %d 天至 %s；分位与曲线由真实日线计算'
                  % (cal0[0] if cal0 else '—', len(cal0), len(inc_dates), asof or '—'),
    'idx': {}, 'idxTrend': {}, 'trendNote': {},
    'note': '15 条指数与 5/10 年分位、沪深300/国证2000 双线均由内嵌真实日线 + state 日更增量计算；'
            '不含外部抓取与占位值；无增量的序列在最后有效日断开并列入 coverage.gaps。',
    'chain': 'L', 'contract': 'chain/1',
}

for g, lst in GROUPS.items():
    out['idx'][g] = []
    for c, n in lst:
        q = gp(c)
        if len(q) < 2:
            out['idx'][g].append([n, None, None, None])
            continue
        v, p = q[-1][1], q[-2][1]
        out['idx'][g].append([n, round((v / p - 1) * 100, 2), pctl(q, 5), pctl(q, 10)])

for y in (5, 10):
    hs, labels = line('000300.SH', y)
    gz = line_on('399303.SZ', labels, last_valid_idx('399303.SZ'))
    out['idxTrend'][str(y)] = {'labels': labels, 'hs300': hs, 'gz2000': gz, 'points': len(labels)}

gzg = gp('399303.SZ')
gnote = ('国证2000 样本 %d 交易日（约 %.1f 年），末有效日 %s'
         % (len(gzg), len(gzg) / 250, cal[gzg[-1][0]])) if gzg else '国证2000 无有效序列'
out['trendNote']['5'] = '样本 5 年 · ' + gnote
out['trendNote']['10'] = '样本 10 年（沪深300）· ' + gnote

# 覆盖与缺口：15 条目标指数里，末有效日早于 asof 的都列出来
flat = [c for lst in GROUPS.values() for c, _ in lst]
gaps = []
for c in flat:
    li = last_valid_idx(c)
    last_date = cal[li] if li >= 0 else None
    if last_date and asof and last_date < asof:
        name = next((n for lst in GROUPS.values() for cc, n in lst if cc == c), c)
        gaps.append({'name': name, 'code': c, 'lastValidDate': last_date,
                     'reason': ('日更增量止于该日，未编造缺口' if c in inc_codes
                                else '日更补丁无该指数，未编造缺口')})
out['coverage'] = {'asOf': asof, 'baseDays': len(cal0), 'incDays': len(inc_dates),
                   'incCodes': sorted(inc_codes), 'gaps': gaps,
                   'gz2000Patch': {'source': 'chain I / index-gz2000.json',
                                   'days': len([d for d in gz_patch if d > base_last]),
                                   'lastDate': max([d for d in gz_patch], default=None)}}

with open(os.path.join(R, 'index-daily.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print('index-daily.json ->', asof, '基线', len(cal0), '增量', len(inc_dates),
      '指数覆盖', len(inc_codes), '缺口', [(g['name'], g['lastValidDate']) for g in gaps], flush=True)
