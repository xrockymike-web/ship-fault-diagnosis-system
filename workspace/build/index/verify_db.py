#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""4.2 只读校验 —— 两个检索库（判据 ①–⑧ + ⑨ 指纹自检）

🔴 2026-10-17 版权脱钩后的口径（与 build_db.py 的 DDL 同步）：
   · assets 表已删（上游来源表号/图注/章节/真页码）→ 合计 **15 张表**（原 16）
   · chunks 已无 section / asset_id / refs 三列
   · entities/triples 已无 chapter / source_ptr / status / batch_id
   · 编号体系：块 TXT/PRT/TBL-#### ｜ 实体 E-#### ｜ 三元组 T-####
"""
import hashlib, json, os, sqlite3, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
OUT = os.path.join(ROOT, 'workspace', 'data', 'vector-index')
if '--dir' in sys.argv:
    OUT = sys.argv[sys.argv.index('--dir') + 1]
# 数据根（指纹自检用）：默认取 vector-index 的上一级；建到临时目录时用 --data 显式指定
DATA_ROOT = os.path.dirname(os.path.abspath(OUT))
if '--data' in sys.argv:
    DATA_ROOT = os.path.abspath(sys.argv[sys.argv.index('--data') + 1])
TABLES = {
    'chunk': ['documents', 'chunks', 'chunks_fts', 'chunks_fts_tri', 'vectors'],
    'graph': ['entities', 'relation_types', 'triples', 'entities_fts', 'chunk_entities', 'cooccurrence_edges', 'vectors'],
}
P = 0
F = 0


def ck(cond, msg):
    global P, F
    if cond:
        P += 1
    else:
        F += 1
        print('  FAIL ' + msg)


def ro(path):
    return sqlite3.connect('file:' + path.replace('\\', '/') + '?mode=ro', uri=True)


paths = {n: os.path.join(OUT, n, n + '.sqlite') for n in TABLES}
for n, p in paths.items():
    ck(os.path.exists(p), n + '.sqlite 存在')

# ① 12 张表（2026-10-17：assets 表随版权清洗删除，16 → 15；2026-10-19：三库 → 两库，15 → 12）
total = 0
for n, names in TABLES.items():
    con = ro(paths[n])
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = [t for t in names if t not in have]
    ck(not missing, n + ' 缺表: ' + str(missing))
    total += len(names)
    con.close()
ck(total == 12, '合计 12 张表（实测 %d）' % total)

# ② chunk 库 FTS 命中
con = ro(paths['chunk'])
n1 = con.execute("SELECT count(*) FROM chunks_fts_tri WHERE chunks_fts_tri MATCH '发电机'").fetchone()[0]
n2 = con.execute("SELECT count(*) FROM chunks WHERE text LIKE '%电压%'").fetchone()[0]
n3 = con.execute("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '电压'").fetchone()[0]
ck(n1 > 0, "trigram MATCH '发电机' 命中（%d）" % n1)
ck(n2 > 0, "LIKE '%%电压%%' 命中（%d）" % n2)
ck(n3 > 0, "词级(jieba) MATCH '电压' 命中（%d）" % n3)
print('  FTS: trigram发电机=%d  LIKE电压=%d  词级电压=%d' % (n1, n2, n3))

# ⑥ 输入口径（2026-10-17 版权脱钩后）
#   旧口径检查 chunks 的 refs / asset_id 两列 —— 这两列已随版权清洗**整列删除**，
#   改为检查"它们确实不存在"，防止有人把上游来源表图引用体系又加回来。
cols_chunks = {r[1] for r in con.execute('PRAGMA table_info(chunks)')}
gone = sorted(c for c in ('section', 'asset_id', 'refs', 'page_start', 'page_end') if c in cols_chunks)
ck(not gone, 'chunks 不应再有已删列 %s（实测仍存在 %s）' % (['section', 'asset_id', 'refs', 'page_start', 'page_end'], gone))
print('  输入口径: chunks 列 = %s' % ','.join(sorted(cols_chunks)))
chunk_con = con

# ③ 外键完整性
con = ro(paths['graph'])
fk = con.execute('PRAGMA foreign_key_check').fetchall()
ck(len(fk) == 0, 'graph 外键完整性（违规 %d）' % len(fk))
# 🔴 不得再有上游来源溯源列
cols_ent = {r[1] for r in con.execute('PRAGMA table_info(entities)')}
cols_tri = {r[1] for r in con.execute('PRAGMA table_info(triples)')}
for tbl, cols in (('entities', cols_ent), ('triples', cols_tri)):
    left = sorted(c for c in ('chapter', 'source_ptr', 'status', 'batch_id') if c in cols)
    ck(not left, '%s 不应再有已删列 %s（实测仍存在 %s）' % (tbl, ['chapter', 'source_ptr', 'status', 'batch_id'], left))
# chunk_ids 悬空
ids = {r[0] for r in chunk_con.execute('SELECT id FROM chunks')}
dangling = 0
tot_refs = 0
for (cids,) in con.execute("SELECT chunk_ids FROM entities WHERE chunk_ids IS NOT NULL AND chunk_ids != ''"):
    for c in cids.split('|'):
        c = c.strip()
        if not c:
            continue
        tot_refs += 1
        if c not in ids:
            dangling += 1
ck(dangling == 0, 'entities.chunk_ids 悬空 = 0（实测 %d / %d）' % (dangling, tot_refs))
print('  chunk->实体引用: %d 条, 悬空 %d' % (tot_refs, dangling))

# ⑦ 新增两张表 + 一列（2026-10-06 定案 A1 / A3 / A10）
EXP = json.load(open(os.path.join(OUT, 'manifest.json'), encoding='utf-8')) if os.path.exists(os.path.join(OUT, 'manifest.json')) else None
if EXP is None:
    raise SystemExit('缺少 manifest.json：期望值必须从装箱单读取（2026-10-22 起不再硬编码）')
ce = con.execute('SELECT count(*) FROM chunk_entities').fetchone()[0]
pairs = set()
for (eid, cids) in con.execute("SELECT id, chunk_ids FROM entities WHERE chunk_ids IS NOT NULL AND chunk_ids != ''"):
    for c in cids.split('|'):
        c = c.strip()
        if c:
            pairs.add((c, eid))
have_pairs = {(r[0], r[1]) for r in con.execute('SELECT chunk_id, entity_id FROM chunk_entities')}
ck(ce == EXP['stores']['graph']['rows']['chunk_entities'],
   'chunk_entities = %d（实测 %d）' % (EXP['stores']['graph']['rows']['chunk_entities'], ce))
# 2026-10-16 口径更正：chunk_entities = entities.chunk_ids 转置（5215）∪ 子块父块提升（4491）。
# 因此「完全互逆」不成立；真实不变式 = chunk_ids 转置 ⊆ chunk_entities（0 缺失）+ 多出项全为 parent 块。
ck(not (pairs - have_pairs),
   'chunk_ids 转置全部在 chunk_entities 内（缺失 %d）' % len(pairs - have_pairs))
extra = have_pairs - pairs
# 🔴 2026-10-17：块号已换新体系（不再是 pa- 前缀），判据改为"按 kind 判定父块"
parents = {r[0] for r in chunk_con.execute("SELECT id FROM chunks WHERE kind = 'parent'")}
kids = {r[0] for r in chunk_con.execute("SELECT id FROM chunks WHERE kind <> 'parent'")}
extra_non_parent = [e for e in extra if e[0] not in parents]
ck(not extra_non_parent,
   'chunk_entities 多出项全为 parent 父块（非父块多出 %d）' % len(extra_non_parent))
print('  chunk_entities = %d 行（chunk_ids 转置 %d ⊆ 库；多出 %d 全为父块）' % (ce, len(pairs), len(extra)))

kids = {r[0] for r in chunk_con.execute("SELECT id FROM chunks WHERE kind <> 'parent'")}
# A1 共现图（2026-10-19 迁入 graph 库）：口径照 4.0.1，只用子块、无向、weight = 共享子块数
co_n = con.execute('SELECT count(*) FROM cooccurrence_edges').fetchone()[0]
bad_w = bad_k = 0
for (cid, w) in con.execute('SELECT chunk_ids, weight FROM cooccurrence_edges'):
    cs = [c for c in (cid or '').split('|') if c]
    if len(cs) != w:
        bad_w += 1
    for c in cs:
        if c not in kids:
            bad_k += 1
ck(co_n == EXP['stores']['graph']['rows']['cooccurrence_edges'],
   'cooccurrence_edges = %d（实测 %d）' % (EXP['stores']['graph']['rows']['cooccurrence_edges'], co_n))
ck(bad_w == 0, 'cooccurrence_edges weight = 证据段数（不符 %d）' % bad_w)
ck(bad_k == 0, 'cooccurrence_edges 证据段落全部命中子块（悬空 %d）' % bad_k)
print('  cooccurrence_edges = %d 行（权重/证据 0 违规）' % co_n)

# ④⑤ 向量
vec = {}
for n in TABLES:
    con2 = ro(paths[n])
    rows = con2.execute('SELECT obj_id,dim,length(blob),model_id,template_version,truncated,src_chars FROM vectors').fetchall()
    vec[n] = rows
    con2.close()
allv = [r for n in vec for r in vec[n]]
ck(len(allv) == EXP['totals']['vectors'], '向量合计 %d（实测 %d）' % (EXP['totals']['vectors'], len(allv)))
ck(len({r[0] for r in allv}) == len(allv), 'obj_id 无重复')
ck(all(r[1] == 1024 and r[2] == 4096 for r in allv), 'dim=1024 且 blob=4096 B（float32）')
ck(all(r[3] == 'Qwen3-Embedding-0.6B-Q8_0' and r[4] == 'p23-v1' for r in allv), 'model_id / template_version 一致')
tr = [r for r in allv if r[5] == 1]
ck(len(tr) == EXP['vectors']['truncated'], 'truncated=1 共 %d 条（实测 %d）' % (EXP['vectors']['truncated'], len(tr)))
ck(all(r[6] is not None for r in allv), 'src_chars 全部非空')
ck(len(vec['chunk']) == EXP['vectors']['by_store']['chunk'] and len(vec['graph']) == EXP['vectors']['by_store']['graph'],
   '两库向量分布 %d/%d' % (EXP['vectors']['by_store']['chunk'], EXP['vectors']['by_store']['graph']))

# ⑧ application_id / user_version
for n, p in paths.items():
    con3 = ro(p)
    aid = con3.execute('PRAGMA application_id').fetchone()[0]
    uv = con3.execute('PRAGMA user_version').fetchone()[0]
    ck(aid == 0x53484950 and uv == 1, '%s application_id/user_version（%s/%s）' % (n, hex(aid), uv))
    con3.close()

# manifest
mf = os.path.join(OUT, 'manifest.json')
ck(os.path.exists(mf), 'manifest.json 存在')
if os.path.exists(mf):
    m = json.load(open(mf, encoding='utf-8'))
    ck(m['totals']['vectors'] == len(allv), 'manifest totals.vectors = %d' % m['totals']['vectors'])
    ck(m['totals']['declared_tables'] == 12, 'manifest totals.declared_tables = 12')
    ck(set(m['stores'].keys()) == {'chunk', 'graph'}, 'manifest 两库齐')

# ⑨ 指纹自检（2026-10-22）—— 库文件 vs 装箱单、输入文件 vs 装箱单
#    🔴 为什么要这最后一步：前八项只查「条数 / 悬空 / 取值」，它们证明不了
#       "这个库就是这份数据建出来的" —— 库被旧备份覆盖、或改了 CSV 没重建，前八项照样全绿。
#    三色口径（只报告，不阻断日常改数据）：
#       绿 = 库文件与输入文件指纹全对；
#       黄 = 输入改过、库没重建（重建并重出 manifest 后自动变绿）；
#       红 = 库文件本身对不上（被替换 / 拷错 / 行数不对）。
yellow = []


def sha_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''):
            h.update(blk)
    return h.hexdigest()


if os.path.exists(mf):
    for name, meta in m['stores'].items():
        p = paths.get(name)
        got = sha_file(p) if p and os.path.exists(p) else 'MISSING'
        ck(got == meta.get('sha256'), '%s 库文件指纹与 manifest 一致（实际 %s）' % (name, got[:16]))
    inputs = m.get('inputs') or {}
    present = [rel for rel in inputs if os.path.exists(os.path.join(DATA_ROOT, rel.replace('/', os.sep)))]
    if inputs and not present:
        # 交付态（portable / release）只带两库，不带建库输入 CSV/JSONL —— 这是设计，不是异常
        print('  输入指纹：交付态未随包带输入文件（%d 项），跳过（库指纹已核）' % len(inputs))
    for rel in present:
        got = sha_file(os.path.join(DATA_ROOT, rel.replace('/', os.sep)))[:16]
        if got != inputs[rel]:
            yellow.append('%s（当前 %s / 建库时 %s）' % (rel, got, inputs[rel]))

print('')
if F:
    print('RESULT FAIL (%d 项)' % F)
    print('自检 🔴 库与数据不一致：上面 FAIL 的项就是差异（库文件被换过/拷错，或建完库没重出 manifest）')
    sys.exit(1)
print('RESULT OK (%d 项全 PASS)' % P)
if yellow:
    print('自检 🟡 数据改过、库还是旧的 —— 重建库（跑 rebuild_chunks.ps1 或 build_db+make_manifest）后自动变绿：')
    for y in yellow:
        print('   · ' + y)
    sys.exit(2)
if present:
    print('自检 🟢 库与数据一致：这套库就是这份数据建的（%d 个输入文件 + 2 个库文件指纹全对）' % len(present))
else:
    print('自检 🟢 库文件指纹全对（2 个）；交付态未带输入文件，改用「库指纹」自证')
sys.exit(0)
