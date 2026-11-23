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
import os, sys, json, colorsys, hashlib, re, argparse, importlib.util, shutil, datetime, subprocess

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

# §4.2 枚举（与 build-external.py 的 WARNING_ENUMS 一致）
WARNING_ENUMS = ('source_unpublished', 'fetch_failed', 'session_incomplete',
                 'stale_fallback', 'cross_source_divergent', 'known_gap', 'unclassified')


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
    """§4.3 链标识不是版本契约（P1③：目标态为对象）"""
    if isinstance(c, dict) and 'formatVersion' in c and 'minClient' in c:
        return 'accept'
    if c is None or isinstance(c, str):
        return 'legacy'          # 旧 chain/1：向后兼容放行，但非目标态
    return 'reject'


def judge_pair(a, b, guard_present):
    """§3.4 不同截止日同图必须有护栏；无护栏即拒"""
    if a == b:
        return 'accept'
    return 'accept' if guard_present else 'reject'


def judge_crosscheck(a, b, threshold=0.2):
    """§2.3 两源都拿到时：价差超阈值标 divergent，绝不静默取一个"""
    if a is None or b is None or a == 0:
        return 'single-source'
    diff = abs(a - b) / abs(a) * 100
    return 'divergent' if diff > threshold else 'matched'


def judge_minclient(mc, client='0.87'):
    """§4.3 minClient 高于前端则拒收（回退），不强行渲染"""
    def n(v):
        m = re.findall(r'\d+', str(v or ''))
        return int(m[0]) * 1000 + (int(m[1]) if len(m) > 1 else 0) if m else 0
    return 'reject' if n(mc) > n(client) else 'accept'


def judge_available_at(v, asof=None):
    """§2.5：null=历史不回填（合规）；ISO 时刻且不早于数据末日=新数据（合规）；
    早于数据末日的 ISO 时刻、非 ISO 值一律判伪造/非法（拒收）。"""
    if v is None:
        return 'legacy-null'
    s = str(v)
    if not re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', s):
        return 'reject'
    if asof and re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(asof)) and s[:10] < str(asof):
        return 'reject'          # 可得时刻早于数据末日 = 伪造历史
    return 'accept'


def judge_degrade(gate, level):
    """§3.6 / §6：0 放行 / 2 部分降级放行但标注 / 1 阻断（失败不绿灯）。"""
    if gate != 'pass':
        return 1
    if level == 'full':
        return 1
    return 2 if level == 'partial' else 0


def degrade_summary(root):
    """汇总全部快照 warnings → 枚举计数 + 降级等级，写进报告供发布流程消费。"""
    counts = {e: 0 for e in WARNING_ENUMS}
    by_file, total = {}, 0
    full = False
    for n in DATA_FILES + sorted(STATE_FILES):
        raw = blob(root, n)
        if not raw:
            continue
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if d.get('ok') is False:
            full = True
        ws = d.get('warnings') or []
        cs = d.get('warningClasses') or []
        if not cs and ws:
            # 消费端兜底分类：与生成端同规则，未匹配归 unclassified
            cs = []
            for w in ws:
                s = str(w)
                hit = 'unclassified'
                for key, kws in (('source_unpublished', ('未发布','源方未','无 FRED','暂无')),
                                 ('session_incomplete', ('未收盘','未完成','盘中','未定稿')),
                                 ('cross_source_divergent', ('divergent','价差','口径偏差','冲突')),
                                 ('stale_fallback', ('沿用','离线副本','兜底','较旧')),
                                 ('known_gap', ('缺口','缺 ','missingDates','未编造','留空','无免费')),
                                 ('fetch_failed', ('失败','RemoteDisconnected','超时','0 根','不足',
                                                  '拿不到','不可用','HTTP','script error','限流','空壳'))):
                    if any(k in s for k in kws):
                        hit = key; break
                cs.append(hit)
        for c in cs:
            counts[c if c in counts else 'unclassified'] += 1
        if ws:
            by_file[n] = {'count': len(ws), 'classes': sorted(set(cs)),
                          'level': d.get('degradeLevel') or 'partial'}
        total += len(ws)
    level = 'full' if full else ('partial' if total else 'none')
    return {'level': level, 'total': total, 'counts': counts, 'byFile': by_file,
            'exitCode': judge_degrade('pass', level)}


def judge_foreground(hidden, was, now, last, gap):
    """§6：仅有「曾离开前台且当前可见」才重取；窗口内合并；隐藏中/从未离开不取。"""
    if hidden: return 'skip:hidden'
    if not was: return 'skip:never-left'
    if last and now - last < gap: return 'skip:coalesced'
    return 'refresh'


def judge_crosscheck_status(currency_match, skew_seconds, same_session, freshness_ok, diff_pct, threshold=1.0):
    """对齐参考项目 crossCheckQuotes 的判定顺序（core.mjs L711-723）。"""
    if not freshness_ok: return 'stale'
    if not same_session or (skew_seconds is not None and skew_seconds > 120): return 'time-mismatch'
    if not currency_match: return 'currency-mismatch'
    return 'divergent' if (diff_pct is not None and diff_pct > threshold) else 'matched'


def judge_session_complete(hhmmss, close_hhmmss='150000'):
    """§2.5 / market-rules.mjs dailyBarMetadata：未完成当日 K 线不定稿。"""
    return str(hhmmss) >= str(close_hhmmss)


def judge_calendar(date_str, covered_years=('2026', '2027'), holidays=(), a_share=True):
    """§2.5：周末、节假日、覆盖外年份都不具备新鲜数据资格。"""
    try:
        y, m, d = (int(x) for x in str(date_str).split('-'))
        wd = datetime.date(y, m, d).weekday()
    except Exception:
        return 'invalid'
    if wd >= 5: return 'weekend'
    if a_share:
        if str(y) not in covered_years: return 'unverified-calendar'
        for a, b in holidays:
            if a <= date_str <= b: return 'holiday'
    return 'trading-day'


NODE_GATE = "\nconst G = require(process.argv[1]);\nconst calOK = { Coverage: { start: '2023-01-01', end: '2027-12-31', markets: ['A'], timezone: 'Asia/Shanghai' },\n  Evidence: [{ source: 'x', verifiedAt: '2025-12-22T00:00:00Z' }], HalfDaySessions: { A: [] }, Limitations: ['x'], Years: {} };\nconst seg = (n, cagr, excess) => ({ vs: 0, ve: n, res: { cagr: cagr, excess: excess, max_dd: 0.1, total: cagr } });\nconst out = {};\nout.availableAtA = G.availableAt('2026-11-20', 'A');\nout.availableAtUS = G.availableAt('2026-11-20', 'US');\nout.availableAtBad = G.availableAt('bad', 'A');\nout.pitHist = G.pointInTimeCutoff(['2026-11-19', '2026-11-20'], '2026-11-22T00:00:00Z', 'A');\nout.pitLive = G.pointInTimeCutoff(['2026-11-19', '2026-11-20'], '2026-11-20T06:00:00Z', 'A');\nout.calOK = G.calendarEvidence(calOK);\nout.calBad = G.calendarEvidence({ Years: {} });\nout.qGood = G.qualifyWFO([seg(100, 0.08, 0.05), seg(100, 0.12, 0.03), seg(100, 0.10, 0.02)]);\nout.qObserve = G.qualifyWFO([seg(100, 0.12, 0.05), seg(100, 0.10, 0.03), seg(100, 0.08, 0.02)]);\nout.qReject = G.qualifyWFO([seg(100, 0.12, 0.05)]);\nout.qHtml = G.qualificationHtml(out.qReject);\nout.skip = G.skipSummary({ __WUFU_NO_OPEN_SKIP: 3, __WUFU_NO_REAL_CLOSE_SKIP: 1,\n  __WUFU_LIMIT_BLOCK_BUY: 2, __WUFU_LIMIT_BLOCK_SELL: 1, __CB_SCALE_FILL_ISSUE: 0 },\n  { metrics: { n_days: 30, n_trades: 4 } });\nconsole.log(JSON.stringify(out));\n"


def node_gate(root):
    """P4：用 Node 实跑交付的 common/research-gate.js，验证的是产品代码而非 Python 复刻。"""
    r = subprocess.run(['node', '-e', NODE_GATE, os.path.join(root, 'common/research-gate.js')],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return {'error': r.stderr[:300]}
    return json.loads(r.stdout)


NODE_RULES = "\nconst R = require(process.argv[1]);\nconst out = {};\nconst p = { commission_rate: 0.0002, slippage_rate: 0.0015, min_commission: 5, tiered_slippage: false };\nout.cbFirst = R.cbLimit('2026-11-20', true, 100);\nout.cbNormal = R.cbLimit('2026-11-20', false, 130);\nout.cbOld = R.cbLimit('2022-07-01', false, 130);\nout.cbBad = R.cbLimit('2026-11-20', false, 0);\nout.etf20 = R.etfLimit('588000.SH');\nout.etf10 = R.etfLimit('510300.SH');\nout.etf159 = R.etfLimit('159915.SZ');\nout.board = R.boardRuleSummary();\nout.instrCB = R.instrumentOf('110031.SH');\nout.instrETF = R.instrumentOf('510300.SH');\nout.instrStock = R.instrumentOf('600000.SH');\nout.feeDefault = R.resolveFee(p, 'A', 'ETF');\nout.feeCB = R.resolveFee(p, 'A', 'CB');\nout.feeOverride = R.resolveFee(p, 'A', 'STOCK', { stampDuty: 0.001 });\nout.feeBreak = R.feeBreakdown(p, 'A', 'ETF');\nout.boundaryHtml = R.rulesBoundaryHtml();\nconsole.log(JSON.stringify(out));\n"


def node_rules(root):
    """②⑧：用 Node 实跑交付的 common/instrument-rules.js。"""
    r = subprocess.run(['node', '-e', NODE_RULES, os.path.join(root, 'common/instrument-rules.js')],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return {'error': r.stderr[:300]}
    return json.loads(r.stdout)


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
    ]:
        missing = [n for n in DATA_FILES
                   if not (blob(root, n) and field in json.loads(blob(root, n) or b'{}'))]
        if missing:
            gap(aid, rule, '%d/%d 份数据快照缺 %s：%s' %
                (len(missing), len(DATA_FILES), field, ', '.join(missing)))
        else:
            add(aid, rule, 'advisory', True, '全部数据快照已带 ' + field, status='pass')

    # A4 §2.5：availableAt 键必填；null（历史不回填）/ ISO 真实时刻均合法，伪造值拒收
    a4_bad = []
    for n in DATA_FILES:
        d = json.loads(blob(root, n) or b'{}')
        if 'availableAt' not in d:
            a4_bad.append(n + ':缺键')
        elif judge_available_at(d.get('availableAt'), d.get('dataAsOf')) == 'reject':
            a4_bad.append(n + ':值非法')
    gens = ['scripts/build-dashboards.mjs', 'scripts/build-external.py',
            'scripts/build-index-daily.py', 'scripts/build-us-etf.py', 'scripts/update.mjs']
    a4_gen = [g for g in gens if 'availableAt' not in text(root, g)]
    if a4_bad or a4_gen:
        gap('A4', '§2.5 / §4.1 availableAt',
            '快照问题=%s；生成器缺写入=%s' % (a4_bad or '无', a4_gen or '无'))
    else:
        add('A4', '§2.5 / §4.1 availableAt', 'advisory', True,
            '8 份快照带键（历史为 null，未伪造）+ 5 个生成器写入真实时刻', status='pass')

    bad_contract = [n for n in DATA_FILES
                    if judge_contract(json.loads(blob(root, n) or b'{}').get('contract')) != 'accept']
    if bad_contract:
        gap('A5', '§4.3 contract 格式版本',
            '%d/%d 份未升级为 {formatVersion,minClient}：%s' %
            (len(bad_contract), len(DATA_FILES), ', '.join(bad_contract)))
    else:
        add('A5', '§4.3 contract 格式版本', 'advisory', True,
            '全部数据快照已升级为对象契约', status='pass')

    # §4.1：dataAsOf / exportedAt / at 不得互相替代 —— 可执行化为「值类型不得串味」。
    # 状态文件带 dataAsOf（记同步覆盖到哪天）是合规的，不是冒用；规则另要求台账写明它不属数据快照。
    import re as _re
    mix = []
    for n in DATA_FILES + sorted(STATE_FILES):
        d = json.loads(blob(root, n) or b'{}')
        if 'dataAsOf' in d and not _re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(d['dataAsOf'])):
            mix.append(n + ':dataAsOf 不是日期（疑似塞了生成时间戳）')
        for k in ('at', 'exportedAt', 'validatedAt'):
            if k in d and _re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(d[k])):
                mix.append(n + ':' + k + ' 只有日期（疑似被当末日用）')
    for n in DATA_FILES:
        d = json.loads(blob(root, n) or b'{}')
        if 'at' in d and 'dataAsOf' not in d:
            mix.append(n + ':数据快照用 at 当末日')
    ledger_has_note = '状态文件字段集' in text(root, LEDGER_FILE)
    if mix or not ledger_has_note:
        gap('A5b', '§4.1 asOf 与 at 分离',
            '串味=%s；台账已写明状态文件不属数据快照=%s' % (mix or '无', ledger_has_note))
    else:
        add('A5b', '§4.1 asOf 与 at 分离', 'advisory', True,
            '16 份文件值类型无串味（dataAsOf=日期 / at=ISO 时间戳），台账已写明状态文件字段集', status='pass')
    return file_report


def transaction_check(root):
    """§6 事务实跑：在临时目录里用 pull-snapshots.atomic_write 验证成功/失败两路径。"""
    import tempfile
    try:
        spec = importlib.util.spec_from_file_location(
            '_wufu_pull_tx', os.path.join(root, 'scripts', 'pull-snapshots.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        td = tempfile.mkdtemp(prefix='wufu-tx-')
        p = os.path.join(td, 'cb-daily.json')
        old = b'{"dataAsOf":"2026-11-20","ok":true}'
        open(p, 'wb').write(old)
        m.atomic_write(p, b'{"dataAsOf":"2026-11-21","ok":true}', td)
        ok1 = (json.loads(open(p, 'rb').read())['dataAsOf'] == '2026-11-21'
               and open(os.path.join(td, 'previous', 'cb-daily.json'), 'rb').read() == old)
        before = open(p, 'rb').read()
        try:
            m.atomic_write(p, b'{broken', td)          # 故意破坏：切换前校验应拦住
            ok2 = False
        except Exception:
            ok2 = open(p, 'rb').read() == before       # 旧文件未半写
        ok3 = m.restore_previous('cb-daily.json', td) and open(p, 'rb').read() == old
        shutil.rmtree(td, ignore_errors=True)
        return (ok1 and ok2 and ok3), '切换=%s 失败不半写=%s 一键恢复=%s' % (ok1, ok2, ok3)
    except Exception as e:
        return False, str(e)[:140]


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


    # ── 界面样式契约（§界面契约 6 节） ──────────────────────────
    ui_rule = text(root, '界面样式契约.md')
    add('V1', '界面契约 §1 规则文件存在且纯净', 'blocking',
        bool(ui_rule) and not any(w in ui_rule for w in
            ['v0.8','v0.9','2026-','已落地','上一轮','翻案','commit','HEAD','Actions run','待补'])
        and '## 2. 颜色与主题' in ui_rule and '## 3. 按钮与控件样式' in ui_rule,
        '契约 %d 字节'%len(ui_rule))
    add('V2', '界面契约 §6 README 指针与台账登记', 'blocking',
        '界面样式契约.md' in text(root,'README.md') and
        '界面样式契约.md' in text(root,'数据契约落地台账.md'), '指针/台账均含契约')
    tcss = text(root, 'common/theme.css')
    # 取自文章《我把这套看盘研究工作台开源了》界面截图的像素色板
    REF_EXPECT = {'--c-bg':'#f6f8f7','--c-surface':'#ffffff','--c-text':'#202725',
        '--c-muted':'#738079','--c-accent':'#147d5e','--c-up':'#d65359',
        '--c-edge':'#c3ddd0','--c-on-brand':'#111816'}
    lv = dict((k,v.strip()) for k,v in re.findall(r'(--c-[\w-]+)\s*:\s*([^;]+);',
        tcss.split(':root[data-theme="light"]{',1)[1].split('}',1)[0]))
    miss = [k for k,v in REF_EXPECT.items() if lv.get(k,'').lower()!=v.lower()]
    add('V3', '界面契约 §2 浅色值取自文章界面截图', 'blocking', not miss,
        '对齐 %d/%d'%(len(REF_EXPECT)-len(miss),len(REF_EXPECT)) + (' 缺: '+','.join(miss) if miss else ''))
    ui_names = sorted(set(re.findall(r'(--ui-[\w-]+)\s*:', tcss)))
    dark_names = sorted(set(re.findall(r'(--ui-[\w-]+)\s*:', tcss.split(':root{',1)[1].split('}',1)[0])))
    add('V4', '界面契约 §2 语义 tone 深浅成对', 'blocking',
        len(ui_names)>=25 and set(ui_names)==set(dark_names),
        '深浅各 %d 个'%len(ui_names))
    tjs = text(root, 'common/theme.js')
    add('V5', '界面契约 §3/§6 显示偏好控件组唯一外观 / 按行归位', 'blocking',
        'wufu-theme-toggle' in tjs and 'wh-theme' not in tjs
        and ('"margin-left":"auto"' in tjs or '"margin-left", "auto"' in tjs) and '"flex", "0 0 auto"' in tjs
        and '"position", "absolute"' not in tjs
        and 'margin-right", "96px"' not in tjs
        and '.wh-row' in tjs and '.homestrip' in tjs
        and '分两类' in ui_rule,
        '唯一 class + 参与布局流 + 自动外边距 + 无绝对定位')
    add('V6', '界面契约 §3 浅色选中态用 tone 而非实心块', 'blocking',
        ':root[data-theme="light"] .on' in tcss and 'var(--ui-accent-soft)' in tcss
        and 'var(--ui-accent-ink)' in tcss, 'accent-soft/line/ink 三档')
    # 遗留色登记覆盖：业务文件里出现的硬编码色，必须都在 LEGACY 里
    LEGACY_LITS = ['#c07a00','#1a9d5a','#c0392b','#888','#999','#aaa','#2b6cb0',
                   'rgba(127,127,127,.07)']
    business = ['cb/tool.html','etf/tool.html','common/research-gate.js','common/instrument-rules.js']
    found=set(); unregistered=[]
    def in_comment(src,pos):
        a=src.rfind('/*',0,pos); b=src.rfind('*/',0,pos)
        if a>b: return True
        ln=src.rfind('\n',0,pos)+1
        return '//' in src[ln:pos]
    for bn in business:
        bt = text(root, bn)
        for lit in LEGACY_LITS:
            if lit in bt: found.add(lit)
        for m in re.finditer(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)', bt):
            tok=m.group()
            if tok.lower() in [x.lower() for x in LEGACY_LITS]: continue
            if in_comment(bt,m.start()): continue
            ctx=bt[max(0,m.start()-90):m.end()+30]
            if 'data:image' in ctx or 'theme-color' in ctx or 'content="' in ctx: continue
            unregistered.append((bn,tok))
    add('V7', '界面契约 §2 遗留色登记覆盖 / 无新增硬编码', 'blocking',
        not unregistered and all(x in tjs for x in LEGACY_LITS),
        '登记 %d 类；未登记 %d'%(len(found),len(unregistered)))
    # ── v0.95：主色绿 / 标题单色 / 图表无紫 ─────────────────────
    light_css = tcss.split(':root[data-theme="light"]{',1)[1].split('\n}',1)[0]
    add('V8', '界面契约 §3 顶栏大标题单色（深白浅黑）', 'blocking',
        'h1 .fu' in tcss and 'color:inherit !important' in tcss
        and re.search(r'--c-on-brand\s*:\s*#fff', tcss) is not None
        and lv.get('--c-on-brand','').lower() == '#111816',
        'fu=inherit / 深#fff / 浅#111816')
    PURPLE = ['#4338ca','#312e81','#c9ccf5','#eef0fe','#6d66f0','#7c3aed',
              '#8580f5','#c7c4ff','#23234a','#3f3d84','#a78bfa','#818cf8']
    # 只查浅色块与 theme.js 的 LIGHT 字典；深色机械值保留原色相，不在禁止范围
    mlight = re.search(r'var LIGHT = (\{.*?\});\s*\n\s*var FALLBACK', tjs, re.S)
    scope = light_css.lower() + (mlight.group(1).lower() if mlight else '')
    hit = [p for p in PURPLE if p in scope]
    add('V9', '界面契约 §2 主色与浅色值不得含紫/靛蓝', 'blocking', not hit,
        '命中 %d'%len(hit) + (' : '+','.join(hit) if hit else ''))
    def hex_hsl(v):
        v=v.strip().lstrip('#')
        if len(v)==3: v=''.join(c*2 for c in v)
        if not re.fullmatch(r'[0-9a-fA-F]{6}',v): return None
        r,g,b=[int(v[i:i+2],16)/255 for i in (0,2,4)]
        h,l,s=colorsys.rgb_to_hls(r,g,b)
        return h*360,s
    purple_lines=[]
    for k,v in re.findall(r'(--c-h[\w-]+)\s*:\s*([^;]+);', light_css):
        hs=hex_hsl(v)
        if hs and 245<=hs[0]<=345 and hs[1]>0.24: purple_lines.append(k)
    _lc = tcss.split(':root[data-theme="light"]{',1)[1].split('\n}',1)[0]
    _lcm = dict((_k,_v.strip().lower()) for _k,_v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', _lc))
    _seq_l = [_lcm.get('--chart-s%d'%_i,'') for _i in range(1,7)]
    def _greenish(_c):
        _m = re.match(r'#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$', _c or '')
        if not _m: return False
        _r,_g,_b = [int(_x,16) for _x in _m.groups()]
        return _g > _r + 18 and _g > _b + 18
    add('V10', '界面契约 §5 图表序列多色相、不塌成单一色系', 'blocking',
        len(set(_seq_l)) == 6 and sum(_greenish(_x) for _x in _seq_l) <= 1,
        '浅色序列 %d 色 / 绿 %d 个'%(len(set(_seq_l)), sum(_greenish(_x) for _x in _seq_l)))
    add('V11', '界面契约 §3 主按钮与 tab 用墨绿 tone', 'blocking',
        'border-bottom:2px solid var(--c-accent)' in tcss
        and 'var(--ui-accent-soft)' in tcss and 'var(--ui-accent-ink)' in tcss
        and '#147d5e' in light_css.lower(), '绿下划线 + 浅绿底 + 深绿字')
    # ── 深色主色独立（用户未要求改深色，不得因浅色参考变更而连带改） ──
    css_dark = tcss.split(':root{',1)[1].split('\n}',1)[0]
    dv = dict((k,v.strip()) for k,v in re.findall(r'(--c-[\w-]+)\s*:\s*([^;]+);', css_dark))
    dark_accent = dv.get('--c-accent','').lower()
    light_accent = lv.get('--c-accent','').lower()
    add('V12', '界面契约 §2 深色主色独立于浅色参考', 'blocking',
        '深色主色**必须**独立于浅色参考色板' in ui_rule
        and dark_accent == '#4fc3f7' and dark_accent != light_accent,
        '深=%s 浅=%s'%(dark_accent,light_accent))
    fixture('R20', '「换浅色参考配色时顺手把深色主色也改了」→ 必须保持深色独立',
        '界面契约 §2', [
        ('深色主色仍为既定青蓝', dark_accent=='#4fc3f7', True),
        ('深浅主色不同', dark_accent!=light_accent, True),
        ('契约写明独立性', '深色主色**必须**独立于浅色参考色板' in ui_rule, True),
        ('浅色仍是文章墨绿', light_accent=='#147d5e', True),
        ('浅色值未被连带改动', lv.get('--c-bg','').lower()=='#f6f8f7', True),
    ])

    # ── v0.97 顶栏按结构归位 ──────────────────────────────────────
    add('V13', '界面契约 §3 数据日期回到标题右侧、不为控件让位', 'blocking',
        'margin-right", "96px"' not in tjs
        and 'margin-left:auto' in text(root, 'common/header.css')
        and '数据日期**必须**位于标题同一行右侧' in ui_rule,
        '无让位外边距 / 徽标自动右推')
    fixture('R21', '「绝对定位硬钉顶边 + 日期让位」→ 必须按结构分两类归位',
        '界面契约 §3', [
        ('不再绝对定位', '"position", "absolute"' not in tjs, True),
        ('自动外边距右推', ('"margin-left":"auto"' in tjs or '"margin-left", "auto"' in tjs), True),
        ('日期不让位', 'margin-right", "96px"' not in tjs, True),
        ('识别两类系统行', '.wh-row' in tjs and '.homestrip' in tjs, True),
        ('契约写明分两类', '位置**必须**按顶栏结构分两类' in ui_rule, True),
        ('浅色配色未连带改动', lv.get('--c-accent','').lower()=='#147d5e', True),
    ])

    # ── v0.98 图表主题 ─────────────────────────────────────────────
    chart_vars = ['--chart-tip-bg','--chart-tip-ink','--chart-tip-line',
                  '--chart-heat-neg','--chart-heat-mid','--chart-heat-pos',
                  '--chart-s1','--chart-s2','--chart-s3','--chart-s4','--chart-s5','--chart-s6']
    dark_css = tcss.split(':root{',1)[1].split('\n}',1)[0]
    light_css = tcss.split(':root[data-theme="light"]{',1)[1].split('\n}',1)[0]
    dmap = dict((k,v.strip()) for k,v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', dark_css))
    lmap = dict((k,v.strip()) for k,v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', light_css))
    def _lum(h):
        try:
            return 0.2126*int(h[1:3],16)+0.7152*int(h[3:5],16)+0.0722*int(h[5:7],16)
        except Exception: return -1
    add('V14', '界面契约 §5 浮层随主题、热力图深浅不装反', 'blocking',
        all(k in dmap and k in lmap for k in chart_vars)
        and dmap.get('--chart-tip-bg','').lower() != lmap.get('--chart-tip-bg','').lower()
        and lmap.get('--chart-tip-bg','').lower() == '#ffffff'
        and _lum(dmap.get('--chart-heat-mid','#000000')) < 160
        and _lum(lmap.get('--chart-heat-mid','#ffffff')) > 180
        and dmap.get('--chart-heat-mid','').lower() != lmap.get('--chart-heat-mid','').lower()
        and '## §5 图表主题' in ui_rule
        and '遮挡曲线与坐标标签' in ui_rule,
        '深tip=%s 浅tip=%s'%(dmap.get('--chart-tip-bg'),lmap.get('--chart-tip-bg')))
    seq_d = [dmap.get('--chart-s%d'%i,'').lower() for i in range(1,7)]
    seq_l = [lmap.get('--chart-s%d'%i,'').lower() for i in range(1,7)]
    def greenish(c):
        m = re.match(r'#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$', c or '')
        if not m: return False
        r0,g0,b0 = [int(x,16) for x in m.groups()]
        return g0 > r0 + 18 and g0 > b0 + 18
    add('V15', '界面契约 §5 序列色多色相、不以绿为主', 'blocking',
        len(set(seq_d)) == 6 and len(set(seq_l)) == 6
        and sum(greenish(x) for x in seq_d) <= 1 and sum(greenish(x) for x in seq_l) <= 1
        and lmap.get('--c-purple','').lower() == '#7c5cbf',
        '深绿数=%d 浅绿数=%d'%(sum(greenish(x) for x in seq_d),sum(greenish(x) for x in seq_l)))
    add('V16', '界面契约 §5 切主题整份重绘、不靠字面量反查', 'blocking',
        'function syncCharts' in tjs and 'function watchCharts' in tjs
        and 'function normColor' in tjs and 'fromMap[normColor(tok)]' in tjs
        and 'syncCharts(); } catch (e4)' in tjs
        and 'inst.setOption(opt, true)' in tjs
        and 'data-wufu-chart-sync' in tjs
        and 'function syncCharts() { return;' not in tjs
        and 'watchCharts();' in tjs
        and '整份重给 option' in ui_rule, '归一化 + 显式重设 + 幂等 + 首屏 watch')
    yfmt = 'Math.abs(v) < 2 ? v.toFixed(2) : v.toFixed(1)'
    _yfiles = ['cb/tool.html','etf/tool.html','cb/index.html','etf/index.html']
    _yold = 'var _yFmt = opts.yFmt || function (v) { return v.toFixed(1); };'
    _yhit = [f for f in _yfiles if yfmt in text(root, f)]
    _ybad = [f for f in _yfiles if _yold in text(root, f)]
    add('V17', '界面契约 §5 刻度精度足以区分相邻刻度', 'blocking',
        len(_yhit) >= 2 and not _ybad
        and '保留足以区分相邻刻度的精度' in ui_rule,
        '%d 页 yFmt 2 位小数，旧写法残留 %d'%(len(_yhit),len(_ybad)))
    # theme.js 的 LIGHT/FALLBACK 是 css() 的兜底真源，必须与 theme.css 逐值一致
    _ml = re.search(r'var LIGHT = (\{.*?\});\s*\n\s*var FALLBACK', tjs, re.S)
    _mf = re.search(r'var FALLBACK = (\{.*?\});\s*\n', tjs, re.S)
    _jl = json.loads(_ml.group(1)) if _ml else {}
    _jf = json.loads(_mf.group(1)) if _mf else {}
    _keys = ['--c-purple','--c-h2dd4bf','--c-h14b8a6','--c-hccfbf1','--c-r007',
             '--c-hfef2f2','--c-h14532d','--c-h7f1d1d',
             '--chart-tip-bg','--chart-tip-ink','--chart-heat-mid','--chart-s1','--chart-s3']
    _drift = [k for k in _keys if
              str(_jf.get(k,'')).lower() != str(dmap.get(k,'')).lower() or
              str(_jl.get(k,'')).lower() != str(lmap.get(k,'')).lower()]
    add('V18', '界面契约 §2 颜色单一真源：theme.js 字典与 theme.css 逐值一致', 'blocking',
        not _drift, '漂移 %d 项'%len(_drift) + (' : '+','.join(_drift[:4]) if _drift else ''))
    fixture('R22', '「浮层固定深灰 / 热力图深浅装反 / 序列全绿 / 不重绘」→ 必须全挡',
        '界面契约 §5', [
        ('浅色浮层为白底', lmap.get('--chart-tip-bg','').lower()=='#ffffff', True),
        ('深色热力图为深底', _lum(dmap.get('--chart-heat-mid','#000000'))<160, True),
        ('浅色热力图为浅底', _lum(lmap.get('--chart-heat-mid','#ffffff'))>180, True),
        ('深色序列绿<=1', sum(greenish(x) for x in seq_d)<=1, True),
        ('浅色 --c-purple 非绿', lmap.get('--c-purple','').lower()=='#7c5cbf', True),
        ('切主题显式重设', 'function syncCharts' in tjs, True),
        ('字体/顶栏主色未连带改动', dmap.get('--c-accent','').lower()=='#4fc3f7', True),
    ])

    # 首屏 heatmap 必须直接取语义变量（事后改 option 不会触发 ECharts 重绘格子）
    _vmfiles = ['cb/index.html','etf/index.html','cb/tool.html','etf/tool.html','combos/index.html']
    _vmold = [f for f in _vmfiles if re.search(r'inRange\s*:\s*\{\s*color\s*:\s*\[[^\]]*WFT', text(root, f))]
    _vmnew = sum(len(re.findall(r"css\('--chart-heat-", text(root, f))) + len(re.findall(r'WufuTheme\.heatColors\(\)', text(root, f))) for f in _vmfiles)
    add('V19', '界面契约 §5 热力图首屏取语义变量、不靠事后重绘', 'blocking',
        not _vmold and _vmnew >= 11,
        '旧 token 残留 %d 页 / 语义变量引用 %d 处'%(len(_vmold), _vmnew))
    fixture('R23', '「热力图首屏写死旧 token，只靠 syncCharts 事后改」→ 必须直接取语义变量',
        '界面契约 §5', [
        ('无旧 token 残留', not _vmold, True),
        ('语义变量引用充足', _vmnew >= 11, True),
        ('深浅三档已定义', all(k in dmap and k in lmap for k in
            ['--chart-heat-neg','--chart-heat-mid','--chart-heat-pos']), True),
    ])

    # ── v0.99 涨跌颜色偏好 ───────────────────────────────────────────
    _dr = dmap.get('--c-rise','').lower(); _df = dmap.get('--c-fall','').lower()
    _lr = lmap.get('--c-rise','').lower(); _lf = lmap.get('--c-fall','').lower()
    add('V20', '界面契约 §6 物理色与 green-up 语义槽规则齐备', 'blocking',
        _dr == dmap.get('--c-up','').lower() and _df == dmap.get('--c-down','').lower()
        and _lr == lmap.get('--c-up','').lower() and _lf == lmap.get('--c-down','').lower()
        and _dr != _df and _lr != _lf
        and ':root.green-up{' in tcss
        and ':root.green-up[data-theme="light"]{' in tcss
        and '.wufu-display-group .wh-slot:empty{display:none}' in tcss,
        '深 rise/fall=%s/%s 浅=%s/%s'%(_dr,_df,_lr,_lf))
    add('V21', '界面契约 §6 独立偏好 / 一处交换 / 跨页同步', 'blocking',
        all(k in tjs for k in ['var CKEY = "wufu_colors_v1"','function colors()',
            'function isGreenUp()','function applyColors()','function setColors(v)',
            'function onColorsChange(fn)','function rawCss(name)',
            'name === "--c-up" || name === "--c-down"',
            'if (e.key === CKEY)','applyColors();\n  apply();',
            'return css("--c-up") || tok','return css("--c-down") || tok'])
        and 'setColors: setColors' in tjs,
        '状态机 / 语义分发 / storage / 导出')
    add('V22', '界面契约 §6 两控件同组同位同外观、消费点走语义槽', 'blocking',
        all(k in tjs for k in ['wufuColorSel','wufuDisplayGroup','wufu-theme-toggle',
            '红涨绿跌','绿涨红跌','grp.appendChild(themeSel); grp.appendChild(colorSel)'])
        and '"0010": "--c-up"' in tjs and '"0012": "--c-down"' in tjs
        and '## §6 显示偏好正交' in ui_rule
        and '分别持久化' in ui_rule and '一处生效' in ui_rule,
        '双控件 + TOKENS + 契约')
    _ml2 = re.search(r'var LIGHT = (\{.*?\});\s*\n\s*var FALLBACK', tjs, re.S)
    _mf2 = re.search(r'var FALLBACK = (\{.*?\});\s*\n', tjs, re.S)
    _jl2 = json.loads(_ml2.group(1)) if _ml2 else {}
    _jf2 = json.loads(_mf2.group(1)) if _mf2 else {}
    _pk = ['--c-rise','--c-fall','--c-up','--c-down']
    _drift2 = [k for k in _pk if
               str(_jf2.get(k,'')).lower() != str(dmap.get(k,'')).lower() or
               str(_jl2.get(k,'')).lower() != str(lmap.get(k,'')).lower()]
    add('V23', '界面契约 §2/§6 颜色单一真源：物理色字典与 CSS 逐值一致', 'blocking',
        not _drift2, '漂移 %d 项'%len(_drift2) + (' : '+','.join(_drift2[:4]) if _drift2 else ''))
    fixture('R24', '「涨跌色写死 / 与外观合并 / 只改半个页面」→ 必须独立且一处交换',
        '界面契约 §6', [
        ('默认红涨绿跌', '"red-up"' in tjs and 'return c === "green-up" ? "green-up" : "red-up"' in tjs, True),
        ('语义槽一处交换', 'name === "--c-up" || name === "--c-down"' in tjs, True),
        ('独立持久化 key', 'var CKEY = "wufu_colors_v1"' in tjs, True),
        ('跨页同步入口', 'if (e.key === CKEY)' in tjs, True),
        ('两个控件同 class', 'wufu-theme-toggle' in tjs and tjs.count('mkSel("') >= 2, True),
        ('物理色字典无漂移', not _drift2, True),
        ('外观主色未连带改动', dmap.get('--c-accent','').lower()=='#4fc3f7'
            and lmap.get('--c-accent','').lower()=='#147d5e', True),
    ])

    # ── v0.9901 热力图层次 / 平板布局 ────────────────────────────────
    _stops = ['n6','n5','n4','n3','n2','n1','mid','p1','p2','p3','p4','p5','p6']
    _dvals = [dmap.get('--chart-heat-'+k,'').lower() for k in _stops]
    _lvals = [lmap.get('--chart-heat-'+k,'').lower() for k in _stops]
    add('V24', '界面契约 §7 热力图 ≥9 档、零两侧独立且深浅唯一', 'blocking',
        all(_dvals) and all(_lvals) and len(_dvals)==13
        and len(set(_dvals))==13 and len(set(_lvals))==13
        and _dvals[5] != _dvals[6] and _dvals[6] != _dvals[7]
        and _lvals[5] != _lvals[6] and _lvals[6] != _lvals[7],
        '深 %d 色 / 浅 %d 色'%(len(set(_dvals)),len(set(_lvals))))
    _vmfiles = ['cb/index.html','etf/index.html','cb/tool.html','etf/tool.html','combos/index.html']
    _vm_bad = []
    _vm_cnt = 0
    for _f in _vmfiles:
        _s = text(root,_f)
        for _m in re.finditer(r'inRange\s*:\s*\{\s*color\s*:\s*\[([^\]]+)\]',_s):
            _arr = _m.group(1)
            _n = _arr.count("css('--chart-heat-")
            _vm_cnt += 1
            # 13 档里本来就含 --chart-heat-mid（零档），旧别名 neg/pos 才属残留
            if _n != 13 or '--chart-heat-neg' in _arr or '--chart-heat-pos' in _arr:
                _vm_bad.append((_f,_n))
    _hm_cnt = sum(text(root,f).count('WufuTheme.heatColors()') for f in _vmfiles)
    add('V25', '界面契约 §7 首屏 visualMap 全走唯一取色入口、无旧三档残留', 'blocking',
        (_vm_cnt >= 10 or _hm_cnt == 11) and not _vm_bad and _hm_cnt == 11,
        'heatColors() %d 处，数组 %d 处，异常 %s'%(_hm_cnt,_vm_cnt,str(_vm_bad[:3])))
    add('V26', '界面契约 §7 重绘不降档、theme.js 字典逐值一致', 'blocking',
        'var HEAT_STOPS = [' in tjs and 'vm.inRange.color = heat.slice()' in tjs
        and '[hn, hm, hm, hp]' not in tjs
        and all(str(_jf2.get('--chart-heat-'+k,'')).lower()==dmap.get('--chart-heat-'+k,'').lower()
                and str(_jl2.get('--chart-heat-'+k,'')).lower()==lmap.get('--chart-heat-'+k,'').lower()
                for k in _stops),
        'HEAT_STOPS + 字典一致')
    _tab_files = ['cb/index.html','etf/index.html','cb/tool.html','etf/tool.html','common/combo-system.css']
    _tab_ok = all('position:static !important' in text(root,_f)
                  and 'max-height:none !important' in text(root,_f)
                  and '(hover:none) and (pointer:coarse)' in text(root,_f)
                  and 'flex-direction:row !important' in text(root,_f)
                  for _f in _tab_files)
    _tab_files = ['cb/index.html','etf/index.html','cb/tool.html','etf/tool.html','common/combo-system.css']
    _rule_ok = all('position:static !important' in text(root,_f)
                   and 'max-height:none !important' in text(root,_f)
                   and '(min-width:1081px)' in text(root,_f)
                   and 'flex-direction:row !important' in text(root,_f)
                   and 'flex-direction:column !important' not in text(root,_f)
                   and 'width:400px !important' in text(root,_f)
                   and '.cards{grid-template-columns:1fr !important' not in text(root,_f)
                   for _f in _tab_files)
    add('V27', '界面契约 §7 平板取消 sticky 限高、>1080px 恢复左右两列', 'blocking',
        _rule_ok and '## §7 热力图层次与平板布局' in ui_rule
        and '保持原有的左右两列布局' in ui_rule
        and '改变列数实现' in ui_rule,
        '%d 个文件含两列规则'%sum(1 for _f in _tab_files if 'flex-direction:row !important' in text(root,_f)))
    # v0.9903：防止再把 ≥1081 的窗口强制单列（用户指出的回归）
    _no_col = all('flex-direction:column !important' not in text(root,_f) for _f in _tab_files)
    add('V33', '界面契约 §7 中小桌面窗口不得被改成单列（防回归）', 'blocking',
        _no_col and all('(min-width:1081px) and (max-width:1279px)' in text(root,_f)
                        for _f in _tab_files),
        '残留 column 强制 %d 文件'%sum(1 for _f in _tab_files if 'flex-direction:column !important' in text(root,_f)))
    fixture('R27', '「平板/电脑被改成手机单列」→ 必须保持两列',
        '界面契约 §7', [
        ('无强制单列规则', _no_col, True),
        ('>1080 明确两列', all('flex-direction:row !important' in text(root,_f) for _f in _tab_files), True),
        ('参数区仍 400px', all('width:400px !important' in text(root,_f) for _f in _tab_files), True),
        ('sticky 仍已取消', all('position:static !important' in text(root,_f) for _f in _tab_files), True),
        ('卡片不再强制单列', all('.cards{grid-template-columns:1fr !important' not in text(root,_f) for _f in _tab_files), True),
        ('契约明文禁止改列数', '改变列数实现' in ui_rule, True),
    ])
    # 版本号约定：不得跨到 1.00，须在 0.99 后加两位数
    _sw = text(root,'sw.js')
    _rd = text(root,'README.md')
    add('V28', '发布版本不得跨 1.00，须为 0.9901', 'blocking',
        'wufu-all-v0.9905' in _sw and 'wufu-all-v0.100' not in _sw
        and '0.9905' in _rd and 'v1.00' not in _rd,
        '缓存=%s / README 命中=%s'%('wufu-all-v0.9905' in _sw, '0.9905' in _rd))

    # ── v0.9902 动态样式 / 色阶兜底 ────────────────────────────────
    _hard = re.search(r'var HEAT_HARD = \{(.*?)\n  \};', tjs, re.S)
    _hd = re.findall(r'"(#[0-9A-Fa-f]{6})"', _hard.group(1).split('light:')[0]) if _hard else []
    _hl = re.findall(r'"(#[0-9A-Fa-f]{6})"', _hard.group(1).split('light:')[1]) if _hard and 'light:' in _hard.group(1) else []
    _css_d = [dmap.get('--chart-heat-'+k,'').lower() for k in _stops]
    _css_l = [lmap.get('--chart-heat-'+k,'').lower() for k in _stops]
    add('V29', '界面契约 §8 热力图唯一入口 + 内置常量三份一致 + 恒合法', 'blocking',
        'function heatColors()' in tjs and 'heatColors: heatColors' in tjs
        and 'var heat = heatColors();' in tjs
        and len(_hd)==13 and len(_hl)==13
        and [x.lower() for x in _hd]==_css_d and [x.lower() for x in _hl]==_css_l
        and 'HEAT_HARD[curEff === "light" ? "light" : "dark"][hi]' in tjs,
        '硬兜底深%d浅%d / CSS 逐值一致=%s'%(len(_hd),len(_hl),
            [x.lower() for x in _hd]==_css_d and [x.lower() for x in _hl]==_css_l))
    _hmfiles = ['cb/index.html','etf/index.html','cb/tool.html','etf/tool.html','combos/index.html']
    _hm_bad = [f for f in _hmfiles
               if "WufuTheme.css('--chart-heat-n6')" in text(root,f)
               or "WufuTheme.css('--chart-heat-neg')" in text(root,f)]
    _hm_n = sum(text(root,f).count('WufuTheme.heatColors()') for f in _hmfiles)
    # _lum 已在 V14 前统一定义
    # C 方案：只抬零附近三档，两端极值保持；中间档明度既非近黑也非近白
    _mid_ok = (
        [x.lower() for x in _dvals[5:8]]==['#5c3a40','#4a5a66','#3a6353'] and
        [x.lower() for x in _lvals[5:8]]==['#f2dedf','#e9eceb','#d9ebe2'] and
        all(55 <= _lum(x) <= 160 for x in _dvals[5:8]) and
        all(180 <= _lum(x) <= 242 for x in _lvals[5:8]) and
        abs(_lum(_dvals[6])-_lum(dmap.get('--c-bg','#1b2634')))>=8 and
        abs(_lum(_lvals[6])-_lum(lmap.get('--c-bg','#f6f8f7')))>=8 and
        _dvals[0].lower()=='#f87173' and _dvals[12].lower()=='#4ade81' and
        _lvals[0].lower()=='#c0392d' and _lvals[12].lower()=='#147d60' and
        len(_dvals)==13 and len(_lvals)==13 and
        _dvals[6].lower() != _lvals[6].lower() and
        '接近纯黑' in ui_rule and '各自独立定义' in ui_rule
    )
    add('V34', '界面契约 §7 中间档非近黑近白、C 方案三档、两端极值不变', 'blocking',
        _mid_ok,
        '深mid=%s 浅mid=%s 明度深=%.0f 浅=%.0f'%(_dvals[6],_lvals[6],
            _lum(_dvals[6]),_lum(_lvals[6])))
    fixture('R28', '「中间档又变回近黑/近白，或顺手改掉两端」→ 必须全挡',
        '界面契约 §7', [
        ('深中间档 C 值', _dvals[6].lower()=='#4a5a66', True),
        ('浅中间档 C 值', _lvals[6].lower()=='#e9eceb', True),
        ('深 n1/p1 C 值', [_dvals[5].lower(),_dvals[7].lower()]==['#5c3a40','#3a6353'], True),
        ('浅 n1/p1 C 值', [_lvals[5].lower(),_lvals[7].lower()]==['#f2dedf','#d9ebe2'], True),
        ('中间档明度适中', all(55<=_lum(x)<=160 for x in _dvals[5:8]) and
                            all(180<=_lum(x)<=242 for x in _lvals[5:8]), True),
        ('两端极值未动', _dvals[0].lower()=='#f87173' and _dvals[12].lower()=='#4ade81'
                      and _lvals[0].lower()=='#c0392d' and _lvals[12].lower()=='#147d60', True),
        ('三份真源一致', [x.lower() for x in _hd]==_css_d and [x.lower() for x in _hl]==_css_l, True),
        ('契约明文禁止近黑近白', '接近纯黑' in ui_rule, True),
    ])
    # v0.9905：创建日标线标注必须走语义变量，深/浅各一组，切主题重设
    _mk_d = [dmap.get('--chart-mark-'+k,'').lower() for k in ['bg','ink','line']]
    _mk_l = [lmap.get('--chart-mark-'+k,'').lower() for k in ['bg','ink','line']]
    _mkfiles = ['etf/tool.html','cb/tool.html','etf/index.html','cb/index.html']
    _mk_ok = all('§WFT0141§' in text(root,f) and '§WFT0142§' in text(root,f)
                 and '§WFT0143§' in text(root,f) and '§WFT0089§' not in
                 text(root,f).split('创建日 "')[1][:400] if '创建日 "' in text(root,f) else
                 ('§WFT0141§' in text(root,f) and '§WFT0142§' in text(root,f)
                  and '§WFT0143§' in text(root,f))
                 for f in _mkfiles)
    add('V35', '界面契约 §5 创建日标注用语义变量、深浅各自独立、切主题重设', 'blocking',
        all(_mk_d) and all(_mk_l) and _mk_d[0] != _mk_l[0]
        and _mk_l[0] == '#ffffff' and _mk_d[0].startswith('rgba')
        and _mk_ok and 'css("--chart-mark-bg")' in tjs
        and 'ml.label.backgroundColor = mkBg' in tjs
        and '标线标签' in ui_rule and '只在单一主题下成立' in ui_rule,
        '深bg=%s 浅bg=%s 4页齐=%s' % (_mk_d[0], _mk_l[0], _mk_ok))
    fixture('R29', '「创建日框又变深底 / 只首屏生效 / 复用机械色」→ 必须全挡',
        '界面契约 §5', [
        ('深标注沿用深底', _mk_d[0].startswith('rgba'), True),
        ('浅标注为白底', _mk_l[0] == '#ffffff', True),
        ('深浅字色各自独立', _mk_d[1] != _mk_l[1] and _mk_d[2] != _mk_l[2], True),
        ('四页统一新 token', _mk_ok, True),
        ('syncCharts 实时重设', 'css("--chart-mark-bg")' in tjs
                              and 'ml.label.backgroundColor = mkBg' in tjs, True),
        ('契约明文禁止机械色', '机械色变量' in ui_rule and '页底色' in ui_rule, True),
    ])
    add('V30', '界面契约 §8 首屏 11 处色阶全走唯一入口', 'blocking',
        _hm_n==11 and not _hm_bad,
        'heatColors() %d 处，裸读残留 %s'%(_hm_n,str(_hm_bad[:3])))
    _rjs = text(root,'common/range.js')
    _rseg = _rjs[_rjs.index('var CSS = ['):_rjs.index("].join('\\n');")]
    add('V31', '界面契约 §8 注入样式用 var(--…)、无字面色值、无硬编码色彩方案', 'blocking',
        'function subVar(s)' in _rjs and 'subVar(' in _rseg
        and 'WufuTheme.sub(' not in _rseg and '"var(" + t[n]' in _rjs
        and 'color-scheme:dark' not in _rseg
        and ':root[data-theme="light"] .wr-quick-btns button{' in tcss
        and '## §8 动态样式与图表色阶' in ui_rule
        and '字面色值' in ui_rule,
        '注入段 %d 字符'%len(_rseg))
    add('V32', '界面契约 §8 heatColors 逐档校验并回退内置常量', 'blocking',
        'out.push(isColor(v) ? v.trim() : hard[i]);' in tjs
        and 'function isColor(c)' in tjs
        and 'var hard = HEAT_HARD[curEff === "light" ? "light" : "dark"];' in tjs,
        '校验+回退表达式齐备')

    fixture('R26', '「读空变黑白 / 注入字面色值不跟随 / 硬编码暗色方案」→ 必须全挡',
        '界面契约 §8', [
        ('唯一取色入口', 'function heatColors()' in tjs, True),
        ('恒返回 13 合法色', len(_hd)==13 and len(_hl)==13, True),
        ('内置常量与 CSS 一致', [x.lower() for x in _hd]==_css_d and [x.lower() for x in _hl]==_css_l, True),
        ('首屏全走入口', _hm_n==11 and not _hm_bad, True),
        ('注入样式变量化', 'subVar(' in _rseg and 'WufuTheme.sub(' not in _rseg, True),
        ('无硬编码 color-scheme:dark', 'color-scheme:dark' not in _rseg, True),
        ('浅色按钮显式兜底', ':root[data-theme="light"] .wr-quick-btns button{' in tcss, True),
    ])

    fixture('R25', '「三档同色 / 重绘降档 / iPad 面板 sticky 拉不动」→ 必须全挡',
        '界面契约 §7', [
        ('13 档深浅唯一', len(set(_dvals))==13 and len(set(_lvals))==13, True),
        ('零两侧不同色', _lvals[5]!=_lvals[6] and _lvals[6]!=_lvals[7], True),
        ('首屏色阶全走唯一入口', _hm_cnt==11 and not _vm_bad, True),
        ('重绘不降档', '[hn, hm, hm, hp]' not in tjs, True),
        ('平板规则覆盖 5 文件', _tab_ok, True),
        ('版本号未跨 1.00', '0.9905' in text(root,'README.md'), True),
    ])

    fixture('R19', '「照抄靛蓝 index.css 当文章配色」→ 必须以截图墨绿为准且标题单色',
        '界面契约 §2/§3', [
        ('主色是文章墨绿', lv.get('--c-accent','').lower()=='#147d5e', True),
        ('页底是浅灰绿', lv.get('--c-bg','').lower()=='#f6f8f7', True),
        ('浅色标题为黑', lv.get('--c-on-brand','').lower()=='#111816', True),
        ('大标题不分两色', 'color:inherit !important' in tcss, True),
        ('序列多色相且绿<=1', len(set(lmap.get('--chart-s%d'%_i,'') for _i in range(1,7))) == 6, True),
        ('无靛蓝主色残留', not hit, True),
    ])

    fixture('R18', '「按钮样式各页各写一套」→ 必须统一且浅色选中态不得为实心块',
        '界面契约 §3', [
        ('单一 class', 'wufu-theme-toggle' in tjs and
            'wufu-theme-toggle' in tcss and tcss.count('wufu-theme-toggle')>=2, True),
        ('浅色选中非实心', 'var(--ui-accent-soft)' in tcss and 'var(--ui-accent-ink)' in tcss, True),
        ('参考配色取自截图墨绿', lv.get('--c-accent','').lower()=='#147d5e', True),
        ('遗留色已登记', all(x in tjs for x in LEGACY_LITS), True),
        ('参与布局流且自动右推', ('"margin-left":"auto"' in tjs or '"margin-left", "auto"' in tjs) and '"position", "absolute"' not in tjs, True),
    ])

    rule, ledger, readme = (text(root, x) for x in (RULE_FILE, LEDGER_FILE, README_FILE))
    b11 = (bool(rule) and bool(ledger) and judge_docs(rule, ledger, readme) == 'accept')
    add('B11', '§11 规则 / 台账 / 版本日志三分离', 'blocking', b11,
        '规则纯度 OK=%s 三分离 OK=%s' %
        (not any(w in rule for w in PURITY_FORBIDDEN), b11))

    # advisory：P1/P2 源码层待补项
    sr = text(root, 'scripts/build-external.py')
    need = [k for k in ('sourceRole', 'crossCheck', 'cooldown', 'note_crosscheck', 'cool_down') if k not in sr]
    if need:
        gap('A6', '§2.1–2.3 双源标注与冷却', '生成端缺：' + ', '.join(need))
    else:
        add('A6', '§2.1–2.3 双源标注与冷却', 'advisory', True,
            'build-external.py 含 sourceRole / crossCheck / cooldown 标注与控制', status='pass')
    # A7 §6：不查目录是否存在（previous 是打包机本地产物、不进发布包），
    # 改为真跑一次事务：成功路径原子切换 + 失败路径旧文件不变且 previous 可恢复。
    tx_ok, tx_why = transaction_check(root)
    pull_src = text(root, 'scripts/pull-snapshots.py')
    a7_static = all(k in pull_src for k in ('atomic_write', 'os.replace', 'PREV_DIRNAME', 'restore_previous'))
    if tx_ok and a7_static:
        add('A7', '§6 原子写 + previous 回退', 'advisory', True,
            'pull-snapshots.py 含原子写/副本/恢复；实跑成功与失败两路径均通过', status='pass')
    else:
        gap('A7', '§6 原子写 + previous 回退',
            '静态=%s 实跑=%s（%s）' % (a7_static, tx_ok, tx_why))

    # A8 §3.6 / §4.2：枚举分类 + degradeSummary + 三态退出码 + 自动链接入
    ext = text(root, 'scripts/build-external.py')
    vc = text(root, 'scripts/validate-contract.py')
    rg = text(root, 'scripts/release-gate.py')
    a8 = []
    for k, src in (('classify_warning', ext), ('warningClasses', ext), ('degradeLevel', ext),
                   ('degradeSummary', vc), ('--degrade-exit', rg)):
        if k not in src:
            a8.append(k)
    wf_files = ['.github/workflows/update.yml', '.github/workflows/refresh-index-chain.yml',
                '.github/workflows/refresh-dashboards.yml']
    wf_ok = all('--degrade-exit' in text(root, f) for f in wf_files)
    if not wf_ok:
        a8.append('自动链未消费 --degrade-exit')
    if a8:
        gap('A8', '§3.6 / §4.2 部分降级退出码', '缺：' + ', '.join(a8))
    else:
        add('A8', '§3.6 / §4.2 部分降级退出码', 'advisory', True,
            '枚举分类 + degradeSummary + 0/2/1 三态 + 三条自动链消费', status='pass')
    # A9 §6：回前台重取「一次」，且不得轮询、不得改状态文字
    dsrc = text(root, 'common/dash-source.js')
    seg = dsrc[dsrc.find('/* P3 BEGIN'):dsrc.find('/* P3 END')] if '/* P3 BEGIN' in dsrc else ''
    a9 = []
    for k in ('onRefresh', 'wasHidden', 'judgeForeground', 'FG_GAP', 'Date.now'):
        if k not in seg: a9.append('P3 段缺 ' + k)
    if "/* P3-L1 */ document.addEventListener('visibilitychange', maybeRefresh)" not in seg:
        a9.append('缺 visibilitychange 监听注册')
    if "window.addEventListener('pageshow', maybeRefresh)" not in seg:
        a9.append('缺 pageshow 兜底注册')
    if "window.parent.document.addEventListener('visibilitychange', maybeRefresh)" not in seg:
        a9.append('缺 iframe 父文档监听（看板嵌在 tool.html 内）')
    if 'setInterval' in seg or 'setTimeout' in seg:
        a9.append('P3 段含定时器（规则禁止分钟级轮询）')
    if 'textContent' in seg or 'innerHTML' in seg:
        a9.append('P3 段改了页面文字（会覆盖完成态）')
    renders = ['common/dashboard.js', 'common/gold.js', 'common/industry.js']
    regs = [r for r in renders if 'onRefresh' not in text(root, r)]
    if regs: a9.append('渲染器未注册：' + ', '.join(regs))
    if a9:
        gap('A9', '§6 回前台重取', '；'.join(a9))
    else:
        add('A9', '§6 回前台重取', 'advisory', True,
            '单次去重（无定时器）+ 3 渲染器注册 + 回前台不改状态文字', status='pass')
    # ── v0.90：文章源码二次核查后新增的硬断言（不是"写文档就算落实"）──
    ext = text(root, 'scripts/build-external.py')
    cc_calls = len(re.findall(r'^\s+note_crosscheck\(', ext, re.M))
    role_calls = len(re.findall(r'^\s+note_role\(', ext, re.M))
    add('U1', '§4.1 unmodeled 必填', 'blocking',
        all('unmodeled' in json.loads(blob(root, n) or b'{}') for n in DATA_FILES),
        '8/8 份带 unmodeled 且指向集中清单')
    cc_bad = [n for n in DATA_FILES if 'crossCheck' not in json.loads(blob(root, n) or b'{}')]
    fake = [n for n in DATA_FILES
            if isinstance(json.loads(blob(root, n) or b'{}').get('crossCheck'), dict)
            and json.loads(blob(root, n) or b'{}').get('crossCheck', {}).get('status') == 'matched'
            and json.loads(blob(root, n) or b'{}').get('crossCheck', {}).get('priceDiffPct') is None]
    add('U2', '§2.1 单源显式标注 / 不伪装 matched', 'blocking',
        not cc_bad and not fake,
        '缺 crossCheck=%s；伪造 matched=%s' % (cc_bad or '无', fake or '无'))
    add('U3', '§2.3 双源核验真调用（不是空函数）', 'blocking',
        cc_calls >= 3 and role_calls >= 3 and 'overlap_check(' in ext,
        'note_crosscheck 调用 %d 处 / note_role %d 处 / overlap_check 已接入' % (cc_calls, role_calls))
    pull = text(root, 'scripts/pull-snapshots.py')
    dash = text(root, 'common/dash-source.js')
    add('U4', '§2.5 交易日历覆盖校验进 valid()', 'blocking',
        'calendar_check' in pull and 'HOLIDAY_FILE' in pull and 'calendarOK' in dash,
        '打包侧 calendar_check + 浏览器侧 calendarOK')
    add('U5', '§2.5 未完成当日 K 线不定稿', 'blocking',
        'int(hh) < 150000' in ext and '150000' in ext,
        'CSI/成交额 qt 收盘前不采信（源码已有判定，本轮由断言钉住）')

    # ── P4：①③④⑥ 硬断言（Node 实跑产品 JS + 静态真调用检查）──────────────
    ng = node_gate(root)
    hol_files = ['common/holiday-cn.json', 'cb/data/holiday-cn.json', 'etf/data/holiday-cn.json']
    hol_ok = all(all(k in json.loads(blob(root, f) or b'{}')
                     for k in ('Coverage', 'Evidence', 'HalfDaySessions', 'Limitations'))
                 for f in hol_files)
    add('U6', '§2.7 日历证据链 / 覆盖声明 / 半日时段', 'blocking',
        hol_ok and 'Coverage' in pull and 'Evidence' in pull
        and ng.get('calOK', {}).get('ok') is True and ng.get('calBad', {}).get('ok') is False,
        '三份日历字段齐=%s；calendar_check 真读；Node 证据判定 ok/bad=%s/%s'
        % (hol_ok, ng.get('calOK', {}).get('ok'), ng.get('calBad', {}).get('ok')))
    pit = ng.get('pitHist', {}); live = ng.get('pitLive', {})
    page_src = {f: text(root, f) for f in ('cb/tool.html', 'etf/tool.html')}
    add('U7', '§2.5 收盘定稿 / §9 信号只用已完成日线', 'blocking',
        all('availableAt' in json.loads(blob(root, n) or b'{}') for n in
            ('cb-daily.json', 'gold-daily.json', 'industry-daily.json', 'index-daily.json',
             'index-gz2000.json', 'index-csi-patch.json', 'market-amount.json', 'us-etf-daily.json'))
        and 'derive_available_at' in text(root, 'scripts/build-external.py')
        and all('research-gate.js' in s and 'pointInTimeCutoff' in s
                and 'params.end_date = _pit.lastUsable' in s for s in page_src.values())
        and pit.get('droppedDates') == [] and pit.get('lastUsable') == '2026-11-20'
        and live.get('droppedDates') == ['2026-11-20'] and live.get('lastUsable') == '2026-11-19',
        '8 份快照带 availableAt；两页真钳制 end_date；Node 历史/盘中=%s/%s'
        % (pit.get('lastUsable'), live.get('lastUsable')))
    add('U8', '§7 样本外结论资格判定', 'blocking',
        all('qualifyWFO(segs)' in s and 'qualificationHtml(_q)' in s for s in page_src.values())
        and ng.get('qGood', {}).get('status') == 'qualified'
        and ng.get('qObserve', {}).get('status') == 'observe'
        and ng.get('qReject', {}).get('status') == 'rejected'
        and 'data-status="rejected"' in ng.get('qHtml', '')
        and len(ng.get('qGood', {}).get('notApplicable', [])) >= 4,
        '两页真调用；Node 三态=%s/%s/%s；AUC/Brier 不照搬已声明'
        % (ng.get('qGood', {}).get('status'), ng.get('qObserve', {}).get('status'),
           ng.get('qReject', {}).get('status')))
    sk = ng.get('skip', {})
    add('U9', '§7 拒单/不可成交按原因成可见指标', 'blocking',
        all('__WUFU_LIMIT_BLOCK_BUY' in s and 'skipSummary(window, r)' in s
            and 'id = "skipDetail"' in s and 'id="skipTotal"' in s
            and 'data-total=' in s for s in page_src.values())
        and sk.get('total') == 7 and len(sk.get('byReason', [])) == 5
        and bool(sk.get('sampleWarning')),
        '两页真计数+KPI+独立总数节点#skipTotal+按原因明细；Node 合计=%s 条/5 类，样本不足提示=%s'
        % (sk.get('total'), bool(sk.get('sampleWarning'))))

    # ── ②⑧ 硬断言（Node 实跑产品 JS + 静态真调用检查）──────────────────
    nr = node_rules(root)
    cb, et = text(root, 'cb/tool.html'), text(root, 'etf/tool.html')
    add('U10', '§9 交易所默认口径需验证标记与边界', 'blocking',
        'common/instrument-rules.js' in text(root, 'sw.js')
        and all('instrument-rules.js' in s for s in (cb, et))
        and 'WufuRules.cbLimit(dateStr' in cb and 'WufuRules.etfLimit(code2).limR' in et
        and nr.get('board', {}).get('priceLimitRequiresVerification') is True
        and nr.get('board', {}).get('unverifiedEvidence') >= 1
        and len(nr.get('board', {}).get('limitations', [])) >= 4
        and nr.get('cbFirst', {}).get('meta', {}).get('verificationStatus') == 'default-unverified'
        and nr.get('etf20', {}).get('priceLimitRequiresVerification') is True
        and 'data-verify="required"' in nr.get('boundaryHtml', ''),
        '两页真调用；Node requiresVerification=%s 未核验证据=%s 条；默认口径数值未变'
        % (nr.get('board', {}).get('priceLimitRequiresVerification'),
           nr.get('board', {}).get('unverifiedEvidence')))
    fd, fo = nr.get('feeDefault', {}), nr.get('feeOverride', {})
    add('U11', '§9 费用按市场/品种拆项、零值默认', 'blocking',
        all('WufuRules.resolveFee' in s and '_fee.extraPct' in s
            and 'id="feeDetail"' in s for s in (cb, et))
        and fd.get('extraPct') == 0 and len(fd.get('itemized', [])) == 7
        and fd.get('commissionRate') == 0.0002 and fd.get('slippageRate') == 0.0015
        and fd.get('minCommission') == 5
        and fo.get('extraPct') == 0.001
        and '印花税' in nr.get('feeBreak', {}).get('zeroText', '')
        and 'data-extra=' in et,
        '两页真消费；Node 默认 extraPct=%s（零值）/ 显式覆盖=%s；7 项分项'
        % (fd.get('extraPct'), fo.get('extraPct')))

    return {'rule': rule, 'ledger': ledger, 'readme': readme, 'valid': valid_fn,
            'node_gate': ng, 'node_rules': nr}


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
    fixture('R8', '「其次才加 contract」→ 链标识不等于格式版本契约；旧格式仍须兼容放行', '§4.3', [
        ('chain/1 判为 legacy（兼容放行）', judge_contract('chain/1'), 'legacy'),
        ('缺 contract 判为 legacy（兼容放行）', judge_contract(None), 'legacy'),
        ('含 formatVersion/minClient 判为 accept', judge_contract({'formatVersion': 2, 'minClient': 'v0.87'}), 'accept'),
        ('畸形对象判为 reject', judge_contract(123), 'reject'),
    ])
    fixture('R10', '「qt 跨日跌幅被整只丢弃」→ 双源冲突须标 divergent，且 minClient 超前须回退', '§2.3 / §4.3', [
        ('两源一致 → matched', judge_crosscheck(5404.77, 5404.80), 'matched'),
        ('价差 40% → divergent（不静默取一个）', judge_crosscheck(100, 60), 'divergent'),
        ('单源 → single-source', judge_crosscheck(100, None), 'single-source'),
        ('minClient v0.87 == 前端 → 放行', judge_minclient('v0.87'), 'accept'),
        ('minClient v9.99 > 前端 → 拒收回退', judge_minclient('v9.99'), 'reject'),
    ])
    fixture('R11', '「历史快照空着 availableAt 是待补」→ 实为 §2.5 明令不得伪造历史', '§2.5 / §4.1', [
        ('历史 null 合规（不回填）', judge_available_at(None), 'legacy-null'),
        ('新数据真实 ISO 时刻合规', judge_available_at('2026-11-21T15:30:12+00:00', '2026-11-20'), 'accept'),
        ('伪造早于数据末日的可得时刻拒收', judge_available_at('2020-01-01T00:00:00', '2026-11-20'), 'reject'),
        ('伪造/非法可得时间拒收', judge_available_at('不确定'), 'reject'),
        ('拿 dataAsOf 冒充可得时间拒收', judge_available_at('2026-11-20'), 'reject'),
    ])
    fixture('R12', '「warnings 只是文本」→ 须驱动 0/2/1 部分降级退出码', '§3.6 / §4.2', [
        ('无 warning → 0 放行', judge_degrade('pass', 'none'), 0),
        ('部分降级 → 2 放行但标注', judge_degrade('pass', 'partial'), 2),
        ('全失败 → 1 阻断（不绿灯）', judge_degrade('pass', 'full'), 1),
        ('gate 失败 → 1 阻断', judge_degrade('fail', 'none'), 1),
    ])
    fixture('R13', '「切回前台就重取」→ 须单次、不轮询、不误取首屏', '§6', [
        ('首屏 pageshow（从未离开）不取', judge_foreground(False, False, 10000, 0, 2000), 'skip:never-left'),
        ('隐藏中不取', judge_foreground(True, True, 10000, 0, 2000), 'skip:hidden'),
        ('离开后首次回来重取', judge_foreground(False, True, 10000, 0, 2000), 'refresh'),
        ('2 秒内再回来合并跳过', judge_foreground(False, True, 11000, 10000, 2000), 'skip:coalesced'),
        ('超过窗口再回来仍重取', judge_foreground(False, True, 13000, 10000, 2000), 'refresh'),
    ])
    fixture('R14', '「双源比个价差就行」→ 币种/时间戳/新鲜度依次判；当日未收盘与日历外不定稿',
            '§2.3 / §2.5（METHODOLOGY L7/L11/L15、core.mjs L711-723）', [
        ('价差 0.1% 全通过 → matched', judge_crosscheck_status(True, 5, True, True, 0.1), 'matched'),
        ('币种不一致 → currency-mismatch', judge_crosscheck_status(False, 5, True, True, 0.1), 'currency-mismatch'),
        ('时间戳偏 300s → time-mismatch', judge_crosscheck_status(True, 300, True, True, 0.1), 'time-mismatch'),
        ('新鲜度不合格 → stale', judge_crosscheck_status(True, 5, True, False, 0.1), 'stale'),
        ('价差 40% → divergent', judge_crosscheck_status(True, 5, True, True, 40), 'divergent'),
        ('14:30 未收盘 → 不定稿', judge_session_complete('143000'), False),
        ('15:00 已收盘 → 定稿', judge_session_complete('150000'), True),
        ('周六 → weekend', judge_calendar('2026-11-21'), 'weekend'),
        ('覆盖外 2030 → unverified-calendar', judge_calendar('2030-01-03'), 'unverified-calendar'),
        ('节假日（周一）→ holiday', judge_calendar('2027-01-04', ('2026','2027'), [('2027-01-01','2027-01-04')]), 'holiday'),
        ('普通交易日 → trading-day', judge_calendar('2026-11-20'), 'trading-day'),
    ])
    ng = ctx.get('node_gate') or node_gate(root)
    nr = ctx.get('node_rules') or node_rules(root)
    pit, live = ng.get('pitHist', {}), ng.get('pitLive', {})
    fixture('R15', '「规则写了就算落实」→ ①③④⑥ 必须跑产品 JS 才算数',
            'P4 / market-rules.mjs:7-25,124-129 · research-validation.mjs:185-197 · AGENT_ARENA.md:100-102', [
        ('A 股收盘可得时刻', ng.get('availableAtA'), '2026-11-20T15:00:00+08:00'),
        ('海外链保守收盘时刻', ng.get('availableAtUS'), '2026-11-20T16:00:00-05:00'),
        ('非法日期返回 null', ng.get('availableAtBad'), None),
        ('历史数据不误删（收益口径不变）', pit.get('droppedDates'), []),
        ('历史数据末日', pit.get('lastUsable'), '2026-11-20'),
        ('盘中当日未收盘 → 剔除', live.get('droppedDates'), ['2026-11-20']),
        ('盘中钳到前一交易日', live.get('lastUsable'), '2026-11-19'),
        ('日历证据齐 → ok', ng.get('calOK', {}).get('ok'), True),
        ('日历证据缺 → ok=false', ng.get('calBad', {}).get('ok'), False),
        ('3 段全优 → qualified', ng.get('qGood', {}).get('status'), 'qualified'),
        ('有负段 → observe', ng.get('qObserve', {}).get('status'), 'observe'),
        ('仅 1 段 → rejected', ng.get('qReject', {}).get('status'), 'rejected'),
        ('rejected 明确写进 HTML', 'data-status="rejected"' in ng.get('qHtml', ''), True),
        ('AUC/Brier 明确不照搬', len(ng.get('qGood', {}).get('notApplicable', [])) >= 4, True),
        ('拒单按原因合计', ng.get('skip', {}).get('total'), 7),
        ('拒单分成 5 类', len(ng.get('skip', {}).get('byReason', [])), 5),
        ('样本不足出 sampleWarning', bool(ng.get('skip', {}).get('sampleWarning')), True),
    ])
    fixture('R16', '「涨跌停硬编码就是规则」→ 默认口径必须自带未验证标记',
            '§9 + 参考 market-rules.mjs:43-46', [
        ('CB 首日 up 不变', nr.get('cbFirst', {}).get('up'), 157.3),
        ('CB 首日 dn 不变', nr.get('cbFirst', {}).get('dn'), 56.7),
        ('CB 非首日 up=prev×1.2', nr.get('cbNormal', {}).get('up'), 156),
        ('CB 非首日 dn=prev×0.8', nr.get('cbNormal', {}).get('dn'), 104),
        ('新规前返回 null', nr.get('cbOld'), None),
        ('prevClose 非法返回 null', nr.get('cbBad'), None),
        ('ETF 20% 前缀 limR', nr.get('etf20', {}).get('limR'), 1.195),
        ('ETF 默认 limR', nr.get('etf10', {}).get('limR'), 1.095),
        ('ETF 名单内 159915', nr.get('etf159', {}).get('limR'), 1.195),
        ('A 股一律需验证', nr.get('board', {}).get('priceLimitRequiresVerification'), True),
        ('例外枚举 6 类', len(nr.get('board', {}).get('verificationRequiredFor', [])), 6),
        ('边界声明 ≥4 条', len(nr.get('board', {}).get('limitations', [])) >= 4, True),
        ('证据未附核验日期', nr.get('board', {}).get('unverifiedEvidence'), 3),
        ('判定状态 default-unverified', nr.get('cbFirst', {}).get('meta', {}).get('verificationStatus'), 'default-unverified'),
        ('边界写进 HTML', 'data-verify="required"' in nr.get('boundaryHtml', ''), True),
    ])
    fixture('R17', '「加税费分项」→ 默认必须零值，覆盖才生效，绝不偷偷改收益',
            '§9 + 参考 DESIGN.md:63,75', [
        ('默认 extraPct=0', nr.get('feeDefault', {}).get('extraPct'), 0),
        ('佣金原样回传', nr.get('feeDefault', {}).get('commissionRate'), 0.0002),
        ('滑点原样回传', nr.get('feeDefault', {}).get('slippageRate'), 0.0015),
        ('最低佣金原样回传', nr.get('feeDefault', {}).get('minCommission'), 5),
        ('分项共 7 项', len(nr.get('feeDefault', {}).get('itemized', [])), 7),
        ('印花税默认 0', nr.get('feeDefault', {}).get('extras', {}).get('stampDuty'), 0),
        ('过户费默认 0', nr.get('feeDefault', {}).get('extras', {}).get('transferFee'), 0),
        ('规费默认 0', nr.get('feeDefault', {}).get('extras', {}).get('regulatoryFee'), 0),
        ('经手费默认 0', nr.get('feeDefault', {}).get('extras', {}).get('exchangeFee'), 0),
        ('显式覆盖生效', nr.get('feeOverride', {}).get('extraPct'), 0.001),
        ('CB 品种识别', nr.get('instrCB'), 'CB'),
        ('ETF 品种识别', nr.get('instrETF'), 'ETF'),
        ('股票品种识别', nr.get('instrStock'), 'STOCK'),
        ('CB 分项同样零值', nr.get('feeCB', {}).get('extraPct'), 0),
        ('零值占位可见', '印花税 0' in nr.get('feeBreak', {}).get('zeroText', ''), True),
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
        'degradeSummary': degrade_summary(root),
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
