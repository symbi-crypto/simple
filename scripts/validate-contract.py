# -*- coding: utf-8 -*-
"""
数据契约门禁 · 把《数据方法与契约.md》的「必须 / 不得」变成可跑断言。

用法：
    python3 scripts/validate-contract.py --root . --write
    python3 scripts/validate-contract.py --root . --fixtures-only   # 只跑回归夹具

产出：contract-check.json（内容确定，不含机器路径与当前时间，可直接提交留痕）

设计约定（重要，别改坏）：
  · blocking = 规则已达标项，任一失败 → gate=fail → release-gate.py 阻断发布
  · advisory = 台账 P1/P2 待补项，只记 gaps、不拦，避免门禁刚上线就把自己锁死
  · fixtures = 台账 §4 九条历史改判各配一个回归用例，用构造数据验证「判定器会挡住错误做法」
  · 判定器是最小可执行化，仅用于回归，**不是生产实现、不进产品**（规则 §2.6）
  · 规则文件是断言的唯一依据；规则改了要同步改这里的 id 与 § 映射
"""
import os, sys, json, hashlib, re, argparse, importlib.util

# ── 常量 ────────────────────────────────────────────────────────────────
RULE_FILE = '数据方法与契约.md'
LEDGER_FILE = '数据契约落地台账.md'
README_FILE = 'README.md'
CHECK_FILE = 'contract-check.json'

# 静态回测基线指纹（规则 §5.4：日更不得写回 index.gz）。
# 若将来确需换基线，必须显式改这里并在台账记原因，不能让门禁默默放行。
BASELINE_SHA1 = '75b1118148bd1ef5642a5ac6505b875f8ca455fb'

# 与 pull-snapshots.py 的 TARGETS 保持一致
TARGETS = [
    'cb-daily.json', 'gold-daily.json', 'industry-daily.json', 'index-daily.json',
    'index-gz2000.json', 'index-csi-patch.json', 'market-amount.json', 'us-etf-daily.json',
    'state.json', 'sync-status.json', 'chain-R-status.json',
    'external-warnings.json', 'external-warnings-L.json',
    'external-warnings-A.json', 'external-warnings-G.json', 'external-warnings-I.json',
]
# 控制/状态类文件：按 §4.1 可不参与渲染，不强制 format / contract / 业务字段
STATE_FILES = {
    'state.json', 'sync-status.json', 'chain-R-status.json',
    'external-warnings.json', 'external-warnings-L.json',
    'external-warnings-A.json', 'external-warnings-G.json', 'external-warnings-I.json',
}
DATA_FILES = [f for f in TARGETS if f not in STATE_FILES]

# 规则文档纯度禁用词（§11：规则里不得混实现状态）
PURITY_FORBIDDEN = ['v0.8', 'v0.9', '2026-', '已落地', '上一轮', '翻案', 'commit', 'HEAD', 'Actions run']

ASSERTIONS = []
FIXTURES = []
GAPS = []


def add(aid, rule, severity, ok, detail, status=None):
    st = status or ('pass' if ok else 'fail')
    ASSERTIONS.append({'id': aid, 'rule': rule, 'severity': severity,
                       'status': st, 'detail': detail})
    if severity == 'advisory' and st == 'gap':
        GAPS.append({'id': aid, 'rule': rule, 'detail': detail})
    return ok


def gap(aid, rule, detail):
    return add(aid, rule, 'advisory', False, detail, status='gap')


# ── 最小判定器（仅用于回归夹具，不进产品） ──────────────────────────────
def judge_shell(d, name, valid_fn):
    """§3.2 空壳拒收"""
    ok, _ = valid_fn(name, d)
    return 'accept' if ok else 'reject'


def judge_baseline(sha):
    """§5.4 静态基线不得被日更写回"""
    return 'accept' if sha == BASELINE_SHA1 else 'reject'


def judge_fill(mode):
    """§5.3 允许补全确定真值，禁止未来事件点反填过去"""
    return 'accept' if mode in ('issue_scale', 'event_point') else 'reject'


def judge_qt(gap_days, pct, tight_pct=0.2, magnitude_pct=25.0):
    """§2.3 漏跑多日时不得用「紧邻旧末日」死阈值判成口径偏差"""
    if gap_days <= 1:
        return 'reject' if abs(pct) > tight_pct else 'accept'
    return 'reject' if abs(pct) > magnitude_pct else 'accept'


def judge_exec(row):
    """§3.5 只有当日存在真实行情行才允许记账成交；填充 close 不算"""
    o, c = row.get('open'), row.get('close')
    h, l = row.get('high'), row.get('low')
    real = (o is not None and o > 0) or (h is not None and l is not None and h > 0 and l > 0)
    return 'accept' if (real and c is not None and c > 0) else 'reject'


def judge_px(row):
    """§3.1 / §9 成交价必须落在当日 [low, high] 内"""
    px, h, l = row.get('px'), row.get('high'), row.get('low')
    if px is None or h is None or l is None or l < 0 or h < l:
        return 'reject'
    return 'accept' if l <= px <= h else 'reject'


def judge_contract(c):
    """§4.3 链标识不是版本契约"""
    if isinstance(c, dict) and 'formatVersion' in c and 'minClient' in c:
        return 'accept'
    return 'gap'


def judge_pair(a, b, guard_present):
    """§3.4 不同截止日同图必须有护栏；无护栏即拒"""
    if a == b:
        return 'accept'
    return 'accept' if guard_present else 'reject'


def judge_docs(rule, ledger, readme):
    """§11 规则 / 台账 / 版本日志三分离"""
    pure = not any(w in rule for w in PURITY_FORBIDDEN)
    sep = ('规则在哪' in readme[:200] and '## 2. 取数规则' not in readme
           and '## 2. 待补' in ledger and '## 4. 历史改判记录' in ledger)
    return 'accept' if (pure and sep) else 'reject'


def fixture(fid, case, rule, checks):
    """checks: [(说明, 实际, 期望)]；全对才算 pass"""
    bad = [c for c in checks if c[1] != c[2]]
    FIXTURES.append({'id': fid, 'case': case, 'rule': rule,
                     'status': 'pass' if not bad else 'fail',
                     'checks': [{'name': c[0], 'actual': c[1], 'expect': c[2]} for c in checks],
                     'failed': [c[0] for c in bad]})
    return not bad


# ── 读文件 ──────────────────────────────────────────────────────────────
def load_valid(root):
    """复用打包脚本的 valid()，不重复实现，避免两套校验漂移"""
    p = os.path.join(root, 'scripts', 'pull-snapshots.py')
    if not os.path.isfile(p):
        return None, 'pull-snapshots.py 缺失'
    try:
        spec = importlib.util.spec_from_file_location('_wufu_pull', p)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m.valid, None
    except Exception as e:
        return None, str(e)[:160]


def text(root, name):
    p = os.path.join(root, name)
    return open(p, 'r', encoding='utf-8').read() if os.path.isfile(p) else ''


def blob(root, name):
    p = os.path.join(root, name)
    return open(p, 'rb').read() if os.path.isfile(p) else b''


def asof(d):
    if not isinstance(d, dict):
        return ''
    v = d.get('dataAsOf') or d.get('at')
    s = str(v)[:10] if v else ''
    return s if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s) else ''


# ── 快照断言 ────────────────────────────────────────────────────────────
def snapshot_checks(root, valid_fn):
    file_report = {}
    for name in TARGETS:
        raw = blob(root, name)
        if not raw:
            add('B1.' + name, '§3.2 / §6', 'blocking', False, '文件缺失')
            file_report[name] = {'status': 'missing'}
            continue
        try:
            d = json.loads(raw)
        except Exception as e:
            add('B1.' + name, '§3.2 / §6', 'blocking', False, 'JSON 解析失败: ' + str(e)[:80])
            file_report[name] = {'status': 'bad-json'}
            continue
        ok, why = valid_fn(name, d)
        add('B1.' + name, '§3.2 空壳拒收', 'blocking', ok,
            'valid() 通过' if ok else 'valid() 拒收: ' + why)
        a = asof(d)
        add('B2.' + name, '§4.1 dataAsOf 合法', 'blocking', bool(a),
            'asOf=' + (a or '(非法/缺失)'))
        if name in DATA_FILES:
            add('B3.' + name, '§4.1 format 存在', 'blocking', bool(d.get('format')),
                'format=' + str(d.get('format')))
        file_report[name] = {'status': 'pass' if ok and bool(a) else 'fail',
                             'asOf': a or None, 'format': d.get('format'),
                             'bytes': len(raw),
                             'sha1': hashlib.sha1(raw).hexdigest()[:12],
                             'fields': sorted(d.keys()) if isinstance(d, dict) else []}

    # §3.4 指数曲线 / 成交额柱截止日一致性（有护栏即达标）
    idx = json.loads(blob(root, 'index-daily.json') or b'{}')
    amt = json.loads(blob(root, 'market-amount.json') or b'{}')
    ia, aa = asof(idx), asof(amt)
    board_src = text(root, 'common/dashboard.js')
    # 必须存在「计算不一致标志」的赋值语句 + 不叠柱说明；只出现变量名子串不算
    guard = (bool(re.search(r'\bamtMismatch\s*=', board_src))
             and '不叠柱' in board_src and 'idxAsOf' in board_src)
    add('B5', '§3.4 截止日一致性护栏', 'blocking', guard,
        'index=%s amount=%s guard=%s' % (ia, aa, guard))

    # advisory：P1 字段统一（按字段汇总，不逐文件刷屏）
    for field, aid, rule in [
        ('source', 'A1', '§4.1 source'),
        ('warnings', 'A2', '§4.1 warnings'),
        ('basis', 'A3', '§4.1 basis'),
        ('availableAt', 'A4', '§2.5 / §4.1 availableAt'),
    ]:
        missing = [n for n in DATA_FILES
                   if not (blob(root, n) and field in json.loads(blob(root, n) or b'{}'))]
        if missing:
            gap(aid, rule, '%d/%d 份数据快照缺 %s：%s' %
                (len(missing), len(DATA_FILES), field, ', '.join(missing)))
        else:
            add(aid, rule, 'advisory', True, '全部数据快照已带 ' + field, status='pass')

    bad_contract = [n for n in DATA_FILES
                    if judge_contract(json.loads(blob(root, n) or b'{}').get('contract')) != 'accept']
    gap('A5', '§4.3 contract 格式版本',
        '%d/%d 份仍为链标识（contract: chain/1），缺 {formatVersion,minClient}' %
        (len(bad_contract), len(DATA_FILES)))

    # 控制类文件用 at 而非 dataAsOf（§4.1 不得互相替代）
    at_only = [n for n in STATE_FILES if 'at' in json.loads(blob(root, n) or b'{}')]
    if at_only:
        gap('A5b', '§4.1 asOf 与 at 分离',
            '%d 份状态文件用 at（ISO 时间戳）代替 dataAsOf：%s' %
            (len(at_only), ', '.join(sorted(at_only))))
    return file_report


# ── 静态源码断言 ────────────────────────────────────────────────────────
def static_checks(root, valid_fn):
    pull = text(root, 'scripts/pull-snapshots.py')
    add('B4', '§3.3 不倒退保护', 'blocking', '倒退保护' in pull,
        'pull-snapshots.py %s倒退分支' % ('含' if '倒退保护' in pull else '缺'))

    dash = text(root, 'common/dash-source.js')
    b7 = all(k in dash for k in ('离线副本', 'dataAsOf', 'ok=false', '较新'))
    add('B7', '§3.6 失败回退不摆空壳', 'blocking', b7,
        'dash-source.js 含离线副本/较新/ok=false：%s' % b7)

    board = text(root, 'common/dashboard.js')
    add('B9', '§7 缺失显示占位符', 'blocking',
        ('不写示意值' in board and '—' in board),
        'dashboard.js 含「—」与「不写示意值」')

    for tag, name in (('CB', 'cb/tool.html'), ('ETF', 'etf/tool.html')):
        s = text(root, name)
        b = all(k in s for k in ('no_open', 'no_real_close', 'skipped', 'tradeRecords'))
        add('B6.' + tag, '§3.5 可成交闸门 / §9 逐笔留痕', 'blocking', b,
            '%s 含整期跳过标记与 tradeRecords：%s' % (name, b))
        add('B10.' + tag, '§9 逐笔留痕', 'blocking', 'skipped' in s and 'tradeRecords' in s,
            '%s 跳过原因可导出' % name)

    gz = blob(root, 'common/index.gz')
    sha = hashlib.sha1(gz).hexdigest() if gz else ''
    bidx = text(root, 'scripts/build-index-daily.py')
    writes_gz = bool(re.search(r"open\([^)]*index\.gz[^)]*['\"]w", bidx))
    add('B8', '§5.4 静态基线不得写回', 'blocking',
        bool(gz) and sha == BASELINE_SHA1 and not writes_gz,
        'index.gz sha1=%s 与基线一致=%s 生成端写回=%s' %
        (sha[:12], sha == BASELINE_SHA1, writes_gz))

    add('B12', '§6 发布门禁存在', 'blocking',
        os.path.isfile(os.path.join(root, 'scripts', 'release-gate.py')),
        'release-gate.py 存在')

    rule, ledger, readme = (text(root, x) for x in (RULE_FILE, LEDGER_FILE, README_FILE))
    b11 = (bool(rule) and bool(ledger) and judge_docs(rule, ledger, readme) == 'accept')
    add('B11', '§11 规则 / 台账 / 版本日志三分离', 'blocking', b11,
        '规则纯度 OK=%s 三分离 OK=%s' %
        (not any(w in rule for w in PURITY_FORBIDDEN), b11))

    # advisory：P1/P2 源码层待补项
    sr = text(root, 'scripts/build-external.py')
    if not ('sourceRole' in sr or 'crossCheck' in sr):
        gap('A6', '§2.1–2.3 双源标注与冷却',
            '生成端缺 sourceRole / 两源价差标注 / 失败冷却窗口')
    if not os.path.isfile(os.path.join(root, 'previous')):
        gap('A7', '§6 留一份可回退副本', '未发现 previous 完整副本目录/标记')
    gap('A8', '§3.6 部分降级退出码',
        'warnings 尚未接入打包流程的「部分降级」退出码（P2）')
    gap('A9', '§6 回前台重取', '页面回到前台时未重取快照（P3，边际收益最小）')
    return {'rule': rule, 'ledger': ledger, 'readme': readme, 'valid': valid_fn}


# ── 九条历史改判回归夹具 ────────────────────────────────────────────────
def run_fixtures(ctx, root, valid_fn):
    rule, ledger, readme = ctx['rule'], ctx['ledger'], ctx['readme']
    sha = hashlib.sha1(blob(root, 'common/index.gz')).hexdigest()

    fixture('R1', '「指数基线按设计不追加」→ 实为看板未接入日更链', '§5.4', [
        ('基线指纹未被写回', judge_baseline(sha), 'accept'),
        ('不同截止日有护栏才放行', judge_pair('2026-11-20', '2026-10-30', True), 'accept'),
        ('不同截止日无护栏必须拒', judge_pair('2026-11-20', '2026-10-30', False), 'reject'),
    ])
    fixture('R2', '「成交额链跑不通，等下次同步」→ 空壳不得覆盖真值', '§3.2 / §6', [
        ('失败态空壳拒收', judge_shell({'ok': False, 'dataAsOf': '2026-11-20'}, 'cb-daily.json', valid_fn), 'reject'),
        ('空 dataAsOf 拒收', judge_shell({'dataAsOf': None}, 'cb-daily.json', valid_fn), 'reject'),
        ('结构完整的真值放行', judge_shell(json.loads(blob(root, 'cb-daily.json')), 'cb-daily.json', valid_fn), 'accept'),
    ])
    fixture('R3', '「用首点值 back-fill 初期余额」→ 发行规模才是静态真值', '§5.3', [
        ('上市时已知发行规模允许', judge_fill('issue_scale'), 'accept'),
        ('首个事件点及其后真值允许', judge_fill('event_point'), 'accept'),
        ('未来首点值反填过去必须拒', judge_fill('first_event_backfill'), 'reject'),
    ])
    fixture('R4', '「qt 昨收跨日跌幅是口径偏差」→ 漏跑多日的正常跌幅不得误杀', '§2.3', [
        ('跨 3 日 1.214% 放行', judge_qt(3, 1.214), 'accept'),
        ('同日 40% 仍按紧邻阈值拦', judge_qt(1, 40), 'reject'),
        ('跨 3 日 40% 按量级拦', judge_qt(3, 40), 'reject'),
    ])
    fixture('R5', '「收盘价交易就没有整期跳过」→ 填充 close 不得记账成交', '§3.5', [
        ('停牌日填充 close 拒', judge_exec({'open': None, 'high': None, 'low': None, 'close': 353.805}), 'reject'),
        ('有原始 open 放行', judge_exec({'open': 318.425, 'high': 360, 'low': 230, 'close': 234}), 'accept'),
        ('仅有 high/low 也放行', judge_exec({'open': None, 'high': 360, 'low': 230, 'close': 234}), 'accept'),
    ])
    fixture('R6', '「单日大涨是撮合 bug」→ 成交价须落当日区间', '§3.1 / §9', [
        ('价在区间内放行', judge_px({'px': 125.0, 'low': 120, 'high': 130}), 'accept'),
        ('价高于 high 拒', judge_px({'px': 400, 'low': 120, 'high': 130}), 'reject'),
        ('缺 high/low 拒', judge_px({'px': 125.0, 'low': None, 'high': None}), 'reject'),
    ])
    fixture('R7', '「health 壳没纳入系统化」类表述失误 → 文档须自证边界', '§11', [
        ('README 顶部明确不是规则', '不是规则，是版本日志' in readme[:600], True),
        ('台账含历史改判记录', '## 4. 历史改判记录' in ledger, True),
        ('README 不得内嵌规则正文', '## 2. 取数规则' in readme, False),
    ])
    fixture('R8', '「其次才加 contract」→ 链标识不等于格式版本契约', '§4.3', [
        ('chain/1 判为 gap', judge_contract('chain/1'), 'gap'),
        ('缺 contract 判为 gap', judge_contract(None), 'gap'),
        ('含 formatVersion/minClient 放行', judge_contract({'formatVersion': 2, 'minClient': 'v0.90'}), 'accept'),
    ])
    fixture('R9', '「P0 规则与现状混写」→ 规则 / 台账 / 版本日志三分离', '§11', [
        ('实际三份文件判定通过', judge_docs(rule, ledger, readme), 'accept'),
        ('规则里混进版本号必须拒',
         judge_docs(rule + '\nv0.86 已落地', ledger, readme), 'reject'),
        ('README 内嵌规则必须拒',
         judge_docs(rule, ledger, readme + '\n## 2. 取数规则'), 'reject'),
    ])


# ── 主流程 ──────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument('--write', action='store_true', help='写 contract-check.json')
    ap.add_argument('--fixtures-only', action='store_true')
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    valid_fn, err = load_valid(root)
    if valid_fn is None:
        print('门禁自检失败：无法复用 pull-snapshots.valid() →', err, file=sys.stderr)
        return 2

    if not args.fixtures_only:
        files = snapshot_checks(root, valid_fn)
        ctx = static_checks(root, valid_fn)
    else:
        files, ctx = {}, static_checks(root, valid_fn)
    run_fixtures(ctx, root, valid_fn)

    blocking = [a for a in ASSERTIONS if a['severity'] == 'blocking']
    advisory = [a for a in ASSERTIONS if a['severity'] == 'advisory']
    bfail = [a for a in blocking if a['status'] == 'fail']
    ffix = [f for f in FIXTURES if f['status'] == 'fail']
    gate = 'pass' if (not bfail and not ffix) else 'fail'

    out = {
        'contract': RULE_FILE,
        'contractSha1': hashlib.sha1(text(root, RULE_FILE).encode()).hexdigest()[:12],
        'gate': gate,
        'summary': {
            'blocking': {'total': len(blocking), 'passed': len(blocking) - len(bfail), 'failed': len(bfail)},
            'advisory': {'total': len(advisory), 'gaps': len(GAPS)},
            'fixtures': {'total': len(FIXTURES), 'passed': len(FIXTURES) - len(ffix), 'failed': len(ffix)},
            'snapshots': len(files),
        },
        'failedBlocking': [{'id': a['id'], 'rule': a['rule'], 'detail': a['detail']} for a in bfail],
        'failedFixtures': [{'id': f['id'], 'case': f['case'], 'failed': f['failed']} for f in ffix],
        'gaps': GAPS,
        'assertions': ASSERTIONS,
        'fixtures': FIXTURES,
        'files': files,
        'note': '内容确定（无当前时间/机器路径），可直接提交留痕；advisory gaps 对应台账 P1/P2 待补，不阻断发布。',
    }
    if args.write:
        json.dump(out, open(os.path.join(root, CHECK_FILE), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
    print('gate=%s  blocking %d/%d  fixtures %d/%d  advisory gaps=%d' %
          (gate, len(blocking) - len(bfail), len(blocking),
           len(FIXTURES) - len(ffix), len(FIXTURES), len(GAPS)), flush=True)
    for a in bfail:
        print('  FAIL %-28s %s' % (a['id'], a['detail']), flush=True)
    for f in ffix:
        print('  FIXTURE FAIL %-6s %s' % (f['id'], ', '.join(f['failed'])), flush=True)
    return 0  # gate 结果交给 release-gate.py 决定退出码


if __name__ == '__main__':
    sys.exit(main())
