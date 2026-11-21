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
import os, sys, json, hashlib, re, argparse, importlib.util, shutil

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
    gap('A9', '§6 回前台重取', '页面回到前台时未重取快照（P3，本轮不做）')
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
