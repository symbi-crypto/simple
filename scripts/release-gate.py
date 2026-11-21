# -*- coding: utf-8 -*-
"""
发布放行门禁（规则 §6「失败不绿灯」）。

用法：
    python3 scripts/validate-contract.py --root . --write
    python3 scripts/release-gate.py --root .            # gate != pass → exit 1
    python3 scripts/release-gate.py --root . --strict   # P1/P2 补齐后启用：gaps 也拦

约定：
  · 只读 contract-check.json，不联网、不改文件
  · blocking 失败 / 夹具失败 → 一律阻断，打印失败项
  · advisory gaps 默认只提示不拦（台账待补项），--strict 才拦
  · 报告缺失或过期（规则文件 sha1 对不上）→ 阻断，不静默放行
"""
import os, sys, json, hashlib, argparse

CHECK_FILE = 'contract-check.json'
RULE_FILE = '数据方法与契约.md'


def die(msg, code=1):
    print('RELEASE GATE: ' + msg, file=sys.stderr)
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument('--check', default=None, help='显式指定 contract-check.json 路径')
    ap.add_argument('--strict', action='store_true')
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    cp = args.check or os.path.join(root, CHECK_FILE)
    if not os.path.isfile(cp):
        die('缺少 %s，请先跑 validate-contract.py --write' % cp)
    try:
        c = json.load(open(cp, 'r', encoding='utf-8'))
    except Exception as e:
        die('报告无法解析: %s' % str(e)[:120])

    # 规则文件改动后必须重跑校验，否则报告过期
    rp = os.path.join(root, RULE_FILE)
    if os.path.isfile(rp):
        cur = hashlib.sha1(open(rp, 'rb').read()).hexdigest()[:12]
        if c.get('contractSha1') and c['contractSha1'] != cur:
            die('规则文件已变更（%s → %s），报告过期，请重跑 validate-contract.py' %
                (c['contractSha1'], cur))

    s = c.get('summary', {})
    blocking_fail = c.get('failedBlocking', [])
    fixture_fail = c.get('failedFixtures', [])
    gaps = c.get('gaps', [])
    if blocking_fail or fixture_fail:
        for a in blocking_fail:
            print('  BLOCK %-28s %s' % (a.get('id'), a.get('detail', '')), file=sys.stderr)
        for f in fixture_fail:
            print('  FIX   %-6s %s' % (f.get('id'), ', '.join(f.get('failed', []))), file=sys.stderr)
        die('阻断发布：%d 条硬断言 / %d 条回归夹具失败' % (len(blocking_fail), len(fixture_fail)))

    if args.strict and gaps:
        for g in gaps:
            print('  GAP %-6s %s' % (g.get('id'), g.get('detail', '')), file=sys.stderr)
        die('strict 模式：%d 条 advisory 待补未清' % len(gaps))

    print('RELEASE GATE: PASS  blocking %s  fixtures %s  advisory gaps=%d%s' %
          (s.get('blocking', {}).get('passed'), s.get('fixtures', {}).get('passed'),
           len(gaps), '（strict 未启用，仅提示）' if gaps and not args.strict else ''), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
