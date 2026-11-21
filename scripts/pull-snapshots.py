# -*- coding: utf-8 -*-
"""
打包流程第一步（v0.86 纳入 index-gz2000.json / index-csi-patch.json 链 I 增量）：从 GitHub 仓库拉取最新看板/行情快照。

用法：
    python3 scripts/pull-snapshots.py [--root 站点根目录] [--token-file /path/.gh_token]

纪律（与系统既有约定一致）：
  · 只接受 dataAsOf 不倒退、ok 不为 false、结构完整的快照；
    失败或空壳一律沿用包内「上次成功真值」，绝不摆空壳。
  · index-daily.json 自 v0.84 起由基线 + state 日更增量生成，随周度同步前进，纳入拉取。
  · 校验不过的文件写进警告清单，不中断打包；打包仍能用包内副本出包。
  · 不推 GitHub，只读，不改动仓库内容。
"""
import os, sys, json, base64, argparse, urllib.request, urllib.error, hashlib

REPO = 'symbi-crypto/simple'
BRANCH = 'main'
API = 'https://api.github.com/repos/' + REPO

# 与打包有关、会随周度同步前进的快照
TARGETS = [
    'cb-daily.json', 'gold-daily.json', 'industry-daily.json', 'index-daily.json',
    'index-gz2000.json', 'index-csi-patch.json', 'market-amount.json', 'us-etf-daily.json', 'state.json',
    'sync-status.json', 'chain-R-status.json',
    'external-warnings.json', 'external-warnings-L.json',
    'external-warnings-A.json', 'external-warnings-G.json',
]
# 本机模板不随远端覆盖；index-daily.json 自 v0.84 起随日更增量前进，已纳入 TARGETS
EXCLUDE = {'local-overrides.json'}


def http_json(path, headers, timeout=90):
    req = urllib.request.Request(API + path, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def git_blob(sha, headers):
    obj = http_json('/git/blobs/' + sha, headers)
    return base64.b64decode(obj['content'])


def asof(d):
    if not isinstance(d, dict):
        return ''
    v = d.get('dataAsOf') or d.get('at')  # external-warnings*.json 用 at（ISO 时间戳）
    return str(v)[:10] if v and len(str(v)) >= 10 else ''


def valid(name, d):
    """结构 + 契约校验；空壳、失败态、缺关键字段一律拒收。"""
    if not isinstance(d, dict):
        return False, 'not object'
    if d.get('ok') is False:
        return False, 'ok=false (失败态空壳)'
    a = asof(d)
    if not a:
        return False, 'dataAsOf 缺失'
    # 状态/警告类文件本来就没有 format 字段，只校验日期与失败态
    if d.get('format') is None and not (name in ('sync-status.json', 'chain-R-status.json')
                                        or name.startswith('external-warnings')):
        return False, 'format 缺失'
    fmt = str(d.get('format') or '')
    t = d.get('trend') if isinstance(d.get('trend'), dict) else {}
    t5 = t.get('5') if isinstance(t.get('5'), dict) else {}
    if fmt == 'wufu-dash-cb-v1':
        if not (isinstance(d.get('count'), int) and d['count'] > 0):
            return False, 'count 无效'
        if not (t5.get('labels') and t5.get('price')):
            return False, 'trend.5 不完整'
    elif fmt == 'wufu-dash-gold-v1':
        if not (t5.get('labels') and t5.get('price')):
            return False, 'trend.5 不完整'
    elif fmt == 'wufu-dash-industry-v2':
        if not (isinstance(d.get('boardCount'), int) and d['boardCount'] > 0
                and isinstance(d.get('sampleDays'), int) and d['sampleDays'] > 0):
            return False, 'boardCount/sampleDays 无效'
    elif fmt == 'wufu-dash-amount-v1':
        a5 = d.get('5') if isinstance(d.get('5'), dict) else {}
        if not a5.get('labels'):
            return False, '5.labels 为空'
    elif fmt == 'wufu-index-csi-patch-v1':
        if not (isinstance(d.get('series'), dict) and len(d['series']) >= 4
                and d.get('dataAsOf')):
            return False, 'index-csi-patch series 不完整'
    elif fmt == 'wufu-index-patch-v1':
        if not (isinstance(d.get('days'), list) and len(d['days']) >= 3):
            return False, 'index-gz2000 days 不完整'
    elif fmt == 'wufu-dash-idx-v2':
        i5 = (d.get('idxTrend') or {}).get('5') if isinstance(d.get('idxTrend'), dict) else {}
        if not (isinstance(d.get('idx'), dict) and (d['idx'].get('A') or [])
                and (i5.get('labels') if isinstance(i5, dict) else None)):
            return False, 'idx.A / idxTrend.5 不完整'
    elif fmt == 'wufu-offline-state-v2':
        pass  # dataAsOf 已校验，行情增量由 hub-core 自行合并
    return True, a


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--root', default=os.path.dirname(here))
    ap.add_argument('--token-file', default='/data/workspace/.gh_token')
    ap.add_argument('--report', default='/data/workspace/.v083_pull_report.json')
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    tok = ''
    if os.path.isfile(args.token_file):
        tok = open(args.token_file, encoding='utf-8').read().strip()
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'yuanbao-snapshot-puller'}
    if tok:
        headers['Authorization'] = 'Bearer ' + tok

    try:
        tree = http_json('/git/trees/%s?recursive=1' % BRANCH, headers)
    except Exception as e:
        print('PULL SKIP: 仓库树读取失败 %s（沿用包内副本）' % str(e)[:160], flush=True)
        json.dump({'ok': False, 'error': str(e)[:200], 'updated': [], 'skipped': TARGETS},
                  open(args.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        return 0  # 不阻断打包

    remote = {e['path']: e['sha'] for e in tree.get('tree', []) if e.get('type') == 'blob'}
    updated, skipped = [], []

    for name in TARGETS:
        if name in EXCLUDE:
            continue
        if name not in remote:
            skipped.append({'file': name, 'reason': '仓库无此文件'})
            continue
        local_path = os.path.join(root, name)
        if not os.path.isfile(local_path):
            skipped.append({'file': name, 'reason': '包内无兜底副本，跳过'})
            continue
        try:
            local = json.loads(open(local_path, 'rb').read())
            la = asof(local)
        except Exception:
            la = ''
        try:
            raw = git_blob(remote[name], headers)
            d = json.loads(raw)
        except Exception as e:
            skipped.append({'file': name, 'reason': '远端读取/解析失败: ' + str(e)[:80]})
            continue
        ok, why = valid(name, d)
        ra = asof(d)
        if not ok:
            skipped.append({'file': name, 'reason': why, 'remoteAsOf': ra, 'localAsOf': la})
            continue
        if la and ra and ra < la:
            skipped.append({'file': name, 'reason': '倒退保护：远端 %s < 包内 %s' % (ra, la)})
            continue
        if raw == open(local_path, 'rb').read():
            skipped.append({'file': name, 'reason': '与包内逐字节相同', 'asOf': ra})
            continue
        open(local_path, 'wb').write(raw)
        updated.append({'file': name, 'from': la or '(无)', 'to': ra,
                        'bytes': len(raw), 'sha1': hashlib.sha1(raw).hexdigest()[:12]})
        print('PULL %-30s %s -> %s  %d bytes' % (name, la or '(无)', ra, len(raw)), flush=True)

    report = {'ok': True, 'repo': REPO, 'branch': BRANCH, 'updated': updated,
              'skipped': skipped, 'exclude': sorted(EXCLUDE)}
    json.dump(report, open(args.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('PULL DONE: 更新 %d 份 / 沿用包内 %d 份（详见报告）' % (len(updated), len(skipped)), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
