# -*- coding: utf-8 -*-
"""三条链状态汇总：给链 L 补状态文件，再把 L/A/G 合并成前端读的 external-warnings.json。

任何一条链失败都不影响其它链写回；汇总里 byChain 标清"哪条链、哪天、是否沿用真值"。
"""
import json, os, datetime, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOW = datetime.datetime.utcnow().isoformat() + 'Z'


def read(p):
    try:
        with open(os.path.join(ROOT, p), encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save(p, obj):
    with open(os.path.join(ROOT, p), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print('写回', p, os.path.getsize(os.path.join(ROOT, p)), 'bytes')


def main():
    # 链 L：本地 gz，由两个快照的 dataAsOf 推断
    wl, files = [], {}
    for f in ('cb-daily.json', 'index-daily.json'):
        d = read(f)
        if not d or not d.get('dataAsOf'):
            wl.append('%s 未生成或无 dataAsOf' % f)
        else:
            files[f] = d.get('dataAsOf')
    L = {'chain': 'L', 'ok': not wl, 'at': NOW, 'warnings': wl, 'files': files}
    save('external-warnings-L.json', L)

    prev = read('external-warnings.json') or {}
    prev_by = prev.get('byChain', {})
    by, all_warn, all_fail = {}, [], []
    for c in ('L', 'A', 'G'):
        d = read('external-warnings-%s.json' % c)
        if not d:
            # 本次没跑到这条链：沿用上次状态，绝不把已有告警清空
            if c in prev_by:
                by[c] = prev_by[c]
                all_warn += prev_by[c].get('warnings', [])
            else:
                by[c] = {'ok': None, 'at': None, 'warnings': [], 'note': '本次未运行'}
            continue
        by[c] = {'ok': d.get('ok', not d.get('failed')),
                 'at': d.get('at'), 'warnings': d.get('warnings', []),
                 'note': '沿用上次真值' if d.get('warnings') else ''}
        all_warn += d.get('warnings', [])
        all_fail += d.get('failed', [])
    if not by and prev.get('warnings'):
        all_warn = prev['warnings']
    save('external-warnings.json', {
        'warnings': all_warn, 'at': NOW, 'failed': all_fail, 'byChain': by})
    print('链状态:', {c: v['ok'] for c, v in by.items()}, flush=True)
    if all_fail:
        print('失败链:', all_fail, flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
