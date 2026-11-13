#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""4.2.1 建库 —— 两个检索库（chunk / graph）

2026-10-19（负责人拍板）：三库 → 两库。原第三库整体删除；
其中唯一仍有用的 `cooccurrence_edges`（共现图）**迁入 graph 库** —— 它本来就是
`entities.chunk_ids` 的物化，属于图。故表数 15 → 12（chunk 5 + graph 7）。
依据：交接/4.2-建库施工单-*.md + 《技术总纲》决策 D22 / D23
用法：python workspace/build/index/build_db.py
"""
import csv, hashlib, json, os, sqlite3, struct, sys, time

import jieba
jieba.setLogLevel(20)

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DATA = os.path.join(ROOT, 'workspace', 'data')
OUT = os.path.join(DATA, 'vector-index')
VEC = os.path.join(ROOT, 'workspace', 'build', 'vector-index')
APP_ID = 0x53484950
SCHEMA_VERSION = 1
MODEL_ID = 'Qwen3-Embedding-0.6B-Q8_0'
TEMPLATE = 'p23-v1'


def log(m):
    print(m, flush=True)


def sha16(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()[:16]


def read_jsonl(path):
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


Durable = None  # placeholder to keep linters quiet

# ============================================================================
# 🔴 2026-10-17 版权脱钩后的 schema（与 verify_db.py / rebuild.py 必须同步）
#   已删除：assets 表（上游来源表号/图注/章节/真页码）、
#           chunks.{section,asset_id,refs}、
#           entities.{chapter,source_ptr,status,batch_id}、
#           triples.{chapter,source_ptr,status,batch_id}、
#           relation_types.domain、communities.{parent_id,batch_id,status,evidence_chunk_ids}
#   编号体系：块 TXT/PRT/TBL-#### ｜ 实体 E-#### ｜ 三元组 T-####
#   origin 默认值：generated-v1（不再是 curated —— 语料由人工整理 + 大模型辅助生成）
# ============================================================================

DDL_CHUNK = '''
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, license TEXT,
                        redistributable INTEGER, source_ref TEXT, sha256 TEXT);
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, doc_id TEXT, chapter TEXT,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text', text TEXT, text_seg TEXT);
CREATE INDEX idx_chunks_parent ON chunks(parent_id);
CREATE INDEX idx_chunks_kind ON chunks(kind);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text_seg, content='chunks', content_rowid='rowid', tokenize='unicode61');
CREATE VIRTUAL TABLE chunks_fts_tri USING fts5(text, content='chunks', content_rowid='rowid', tokenize='trigram');
'''

DDL_GRAPH = '''
CREATE TABLE entities (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT,
  chunk_ids TEXT, attributes TEXT,
  origin TEXT NOT NULL DEFAULT 'generated-v1');
CREATE TABLE relation_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, range_ TEXT);
CREATE TABLE triples (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES entities(id),
  predicate_id TEXT NOT NULL REFERENCES relation_types(id), object_id TEXT NOT NULL REFERENCES entities(id),
  chunk_ids TEXT,
  origin TEXT NOT NULL DEFAULT 'generated-v1');
CREATE INDEX idx_triples_subject ON triples(subject_id, predicate_id);
CREATE INDEX idx_triples_object ON triples(object_id, predicate_id);
CREATE VIRTUAL TABLE entities_fts USING fts5(name, aliases, tokenize='trigram');
-- A3：chunk -> 实体 反查索引 = entities.chunk_ids 的转置 ∪ 子块父块提升（见 fill_chunk_entities）
CREATE TABLE chunk_entities (chunk_id TEXT NOT NULL, entity_id TEXT NOT NULL,
                             PRIMARY KEY (chunk_id, entity_id));
CREATE INDEX idx_chunk_entities_entity ON chunk_entities(entity_id);
-- A1：共现图物化（2026-10-19 迁入 graph 库）。口径照 4.0.1：只用子块、无向、weight = 共享子块数
CREATE TABLE cooccurrence_edges (entity_a TEXT NOT NULL, entity_b TEXT NOT NULL,
                                 weight INTEGER NOT NULL, chunk_ids TEXT,
                                 PRIMARY KEY (entity_a, entity_b));
CREATE INDEX idx_cooccurrence_b ON cooccurrence_edges(entity_b);
'''

DDL_VEC = '''
CREATE TABLE vectors (
  obj_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, blob BLOB NOT NULL,
  model_id TEXT NOT NULL, template_version TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, src_chars INTEGER);
'''

DDL_VEC_GRAPH = '''
CREATE TABLE vectors (
  obj_id TEXT PRIMARY KEY, obj_type TEXT, dim INTEGER NOT NULL, blob BLOB NOT NULL,
  model_id TEXT NOT NULL, template_version TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, src_chars INTEGER);
'''

# 语料台账（自建语料，1 行）。🔴 2026-10-17：旧台账 id → CORPUS-0001
#   （旧 id 曾指上游来源；现在这个 id 只表示"本项目的自建语料"，必须区分，避免语义打架）
def book_sha256():
    """语料台账的 sha256：建库时现场算 book.txt（2026-10-22 起不再是 None）。"""
    p = os.path.join(DATA, 'document', 'book.txt')
    return file_sha256(p) if os.path.exists(p) else None


DOCUMENTS = []  # 在 main() 里按 DATA 解析后填充


def new_db(path, ddl):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for suf in ('', '-wal', '-shm'):
        if os.path.exists(path + suf):
            os.remove(path + suf)
    con = sqlite3.connect(path)
    con.execute('PRAGMA foreign_keys=ON')
    con.execute('PRAGMA application_id=%d' % APP_ID)
    con.execute('PRAGMA user_version=%d' % SCHEMA_VERSION)
    con.executescript(ddl)
    return con


def kid_ids():
    """子块（kind != 'parent'）—— 4.0.1 共现口径只吃子块。"""
    return {c.get('id') for c in read_jsonl(os.path.join(DATA, 'chunk', 'chunks_filled.jsonl'))
            if (c.get('kind') or 'text') != 'parent'}


def parent_map():
    """{子块 id: 父块 id} —— 供 chunk_entities 的"父块提升"使用。"""
    out = {}
    for c in read_jsonl(os.path.join(DATA, 'chunk', 'chunks_filled.jsonl')):
        if c.get('parent_id'):
            out[c.get('id')] = c.get('parent_id')
    return out


def cooc_rows(entity_rows, kids):
    """共现边（照 4.0.1）：只在 kids 内、无向、weight = 两实体共享的子块数、带证据段落。

    🔴 2026-10-17：证据段落 `chunk_ids` **按块号升序**输出（此前是"首次遇到顺序"，
       不确定；规范化后与库内一致，也让重建结果可逐字节复现）。
    """
    c2e = {}
    for eid, cids in entity_rows:
        cs = sorted({c.strip() for c in (cids or '').split('|') if c.strip()} & kids)
        for c in cs:
            c2e.setdefault(c, []).append(eid)
    pair = {}
    for c, es in c2e.items():
        es = sorted(es)
        for i in range(len(es)):
            for j in range(i + 1, len(es)):
                pair.setdefault((es[i], es[j]), []).append(c)
    return [(a, b, len(cs), '|'.join(sorted(cs))) for (a, b), cs in sorted(pair.items())]


def fill_cooccurrence(con, entity_rows, kids):
    con.execute('DELETE FROM cooccurrence_edges')
    con.executemany('INSERT INTO cooccurrence_edges(entity_a,entity_b,weight,chunk_ids) VALUES (?,?,?,?)',
                    cooc_rows(entity_rows, kids))


def fill_chunk_entities(con_graph, parent_of=None):
    """chunk -> 实体 反查索引（A3）。

    = entities.chunk_ids 的全量转置  ∪  **子块父块提升**

    父块提升（2026-10-16 数据审核时脚本外补的 4,491 行）：若某实体定位到子块 ch-X，
    且该子块属于父块 pa-Y，则额外登记 (pa-Y, 实体) —— 因为检索最终把子块折叠成父块
    呈现（collapseToParents），父块也需要能被反查到。
    🔴 2026-10-17 起这条逻辑**并入本函数**：此前它只做转置（5,215 行），
       导致 rebuild.py 重跑会静默丢掉 4,491 行父块提升，与库里 9,706 行不符。
    """
    con_graph.execute('DELETE FROM chunk_entities')
    rows = set()
    for eid, cids in con_graph.execute('SELECT id, chunk_ids FROM entities'):
        for c in (cids or '').split('|'):
            c = c.strip()
            if not c:
                continue
            rows.add((c, eid))
            p = (parent_of or {}).get(c)
            if p:
                rows.add((p, eid))
    con_graph.executemany('INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) VALUES (?,?)', sorted(rows))
    return len(rows)


def load_vectors(path):
    out = []
    for o in read_jsonl(path):
        v = o['vec']
        out.append((o['obj_id'], len(v), struct.pack('<%df' % len(v), *v),
                    o['model_id'], o['template_version'], o.get('truncated', 0), o.get('src_chars')))
    return out


def insert_vectors(con, rows, obj_type=None):
    if obj_type is None:
        con.executemany('INSERT INTO vectors(obj_id,dim,blob,model_id,template_version,truncated,src_chars)'
                        ' VALUES (?,?,?,?,?,?,?)', rows)
    else:
        con.executemany('INSERT INTO vectors(obj_id,obj_type,dim,blob,model_id,template_version,truncated,src_chars)'
                        ' VALUES (?,?,?,?,?,?,?,?)',
                        [(r[0], obj_type) + r[1:] for r in rows])


def build_chunk():
    path = os.path.join(OUT, 'chunk', 'chunk.sqlite')
    con = new_db(path, DDL_CHUNK)
    con.executescript(DDL_VEC)
    con.executemany('INSERT INTO documents(id,title,license,redistributable,source_ref,sha256)'
                    ' VALUES (?,?,?,?,?,?)', DOCUMENTS)
    # 🔴 assets 表已按版权要求删除（上游来源表号/图注/章节/真页码），不再有 assets.jsonl
    chunks = read_jsonl(os.path.join(DATA, 'chunk', 'chunks_filled.jsonl'))
    rows = []
    for c in chunks:
        # 🔴 text_seg 一律用 jieba 现场分词：JSONL 里的 text_seg 是**未分词原文**（build_chunks_flat 写入的
        #    就是原文），直接拿来当词级 FTS 列会让 MATCH 失效。原实现即如此，保持不变。
        seg = ' '.join(jieba.lcut(c.get('text') or ''))
        rows.append((c.get('id'), c.get('doc_id'), c.get('chapter'),
                     c.get('parent_id'), c.get('kind') or 'text',
                     c.get('text'), seg))
    con.executemany('INSERT INTO chunks(id,doc_id,chapter,parent_id,kind,text,text_seg)'
                    ' VALUES (?,?,?,?,?,?,?)', rows)
    con.execute('INSERT INTO chunks_fts(rowid,text_seg) SELECT rowid,text_seg FROM chunks')
    con.execute('INSERT INTO chunks_fts_tri(rowid,text) SELECT rowid,text FROM chunks')
    insert_vectors(con, load_vectors(os.path.join(VEC, 'chunk', 'vector', 'chunk.jsonl')))
    con.commit()
    counts = {t: con.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]
              for t in ('documents', 'chunks', 'vectors')}
    con.close()
    return path, counts


def build_graph():
    path = os.path.join(OUT, 'graph', 'graph.sqlite')
    con = new_db(path, DDL_GRAPH)
    con.executescript(DDL_VEC_GRAPH)
    rels = []
    with open(os.path.join(DATA, 'graph', 'relations.csv'), encoding='utf-8-sig', newline='') as f:
        for r in csv.reader(f):
            if len(r) >= 5 and r[1].startswith('R'):
                # 列序：num, real_id, real_name, real_type, real_desc
                rels.append((r[1], r[2], r[3], r[4] if len(r) > 4 else None))
    con.executemany('INSERT INTO relation_types(id,name,type,range_) VALUES (?,?,?,?)', rels)
    # 🔴 按**列名**读取（原实现用 r[9]/r[11]/r[12] 位置取值，删列后会静默错列）
    ents = []
    with open(os.path.join(DATA, 'graph', 'entities.csv'), encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            ents.append((r['entity_id'], r['entity_name'], r['entity_type'], r.get('entity_desc'),
                         r.get('chunk_ids'), r.get('attributes'),
                         r.get('origin') or 'generated-v1'))
    con.executemany('INSERT INTO entities(id,name,type,description,chunk_ids,attributes,origin)'
                    ' VALUES (?,?,?,?,?,?,?)', ents)
    # A3：chunk -> 实体 反查（chunk_ids 转置 ∪ 子块父块提升）
    n_ce = fill_chunk_entities(con, parent_map())
    # A1：共现图（2026-10-19 迁入 graph 库）—— 从 entities.chunk_ids + 子块物化
    fill_cooccurrence(con, [(e[0], e[4]) for e in ents], kid_ids())
    # 🔴 三元组按列名读取；id 已是 T-#### 文本主键（不再是自增整数）
    trips = []
    with open(os.path.join(DATA, 'graph', 'triples.csv'), encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            tid = (r.get('triple_id') or '').strip()
            if not tid:
                continue
            trips.append((tid, r['subject_id'], r['predicate_id'], r['object_id'],
                          r.get('chunk_ids'), r.get('origin') or 'generated-v1'))
    con.executemany('INSERT INTO triples(id,subject_id,predicate_id,object_id,chunk_ids,origin)'
                    ' VALUES (?,?,?,?,?,?)', trips)
    con.execute("INSERT INTO entities_fts(rowid,name,aliases) SELECT rowid,name,'' FROM entities")
    insert_vectors(con, load_vectors(os.path.join(VEC, 'graph', 'vector', 'entity.jsonl')), 'entity')
    insert_vectors(con, load_vectors(os.path.join(VEC, 'graph', 'vector', 'triple.jsonl')), 'triple')
    con.commit()
    counts = {t: con.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]
              for t in ('entities', 'relation_types', 'triples', 'chunk_entities', 'cooccurrence_edges', 'vectors')}
    con.close()
    log('  graph: chunk_entities = %d 行（含父块提升）' % n_ce)
    return path, counts


TABLES = {
  'chunk': ['documents', 'chunks', 'chunks_fts', 'chunks_fts_tri', 'vectors'],
  'graph': ['entities', 'relation_types', 'triples', 'entities_fts', 'chunk_entities', 'cooccurrence_edges', 'vectors'],
}


def main():
    # 🔴 --out / --data / --vec：允许把两库建到别处（镜像/测试用），避免覆盖真实数据
    global OUT, DATA, VEC
    if '--out' in sys.argv:
        OUT = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
        log('target OUT = ' + OUT)
    if '--data' in sys.argv:
        DATA = os.path.abspath(sys.argv[sys.argv.index('--data') + 1])
        log('target DATA = ' + DATA)
    if '--vec' in sys.argv:
        VEC = os.path.abspath(sys.argv[sys.argv.index('--vec') + 1])
        log('target VEC = ' + VEC)
    DOCUMENTS[:] = [('CORPUS-0001', 'newbook', 'self-authored', 1, 'data/document/book.txt', book_sha256())]
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    built = {}
    built['chunk'] = build_chunk(); log('chunk.sqlite    %s' % (built['chunk'][1],))
    built['graph'] = build_graph(); log('graph.sqlite    %s' % (built['graph'][1],))
    vec_total = sum(c[1]['vectors'] for c in built.values())
    log('build done; vectors total = %d; elapsed = %.1f s' % (vec_total, time.time() - t0))
    log('next: python workspace/build/index/make_manifest.py   (4.3 装箱单)')


if __name__ == '__main__':
    main()
