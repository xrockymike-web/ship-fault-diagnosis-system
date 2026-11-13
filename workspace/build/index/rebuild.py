#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""4.4 重建验证 —— 删 FTS / 向量后一条命令重建（可丢弃派生读模型）

依据：交接/4.4-重建验证施工单-*.md
用法：
  python workspace/build/index/rebuild.py                 # 就地重建 data/vector-index 三库
  python workspace/build/index/rebuild.py --dir <目录>     # 对指定目录（如副本）重建
判据（2026-10-06 更正后）：条数 / 结构一致 + 向量余弦 >= 0.999
说明：FTS 从 chunks.text_seg / chunks.text / entities.name 重建；向量从 4.1 的 JSONL 重灌
      （JSONL 缺失时先跑 workspace/build/vector-index/embed_build.mjs）。
"""
import hashlib, json, os, sqlite3, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_db  # 复用向量装载（单一实现）

ROOT = build_db.ROOT


def vec_dir():
    """--vec 优先；否则用 build_db 的默认向量目录（2026-10-22 支持镜像建库）。"""
    if '--vec' in sys.argv:
        return os.path.abspath(sys.argv[sys.argv.index('--vec') + 1])
    return build_db.VEC
STORES = {
    'chunk': ['documents', 'chunks', 'chunks_fts', 'chunks_fts_tri', 'vectors'],
    'graph': ['entities', 'relation_types', 'triples', 'entities_fts', 'chunk_entities', 'cooccurrence_edges', 'vectors'],
}
FTS_OF = {'chunk': ['chunks_fts', 'chunks_fts_tri'], 'graph': ['entities_fts']}
# 2026-10-06 回炉：新增派生表 / 派生列的内容哈希（行数相同不等于内容相同）
# 2026-10-19：共现图迁入 graph 库，派生哈希随之移到 graph
DERIVED = {
    'chunk': [],
    'graph': [('chunk_entities', 'SELECT chunk_id, entity_id FROM chunk_entities ORDER BY chunk_id, entity_id'),
              ('cooccurrence_edges',
               'SELECT entity_a, entity_b, weight, chunk_ids FROM cooccurrence_edges ORDER BY entity_a, entity_b')],
}


def hash_rows(con, sql):
    h = hashlib.sha256()
    for row in con.execute(sql):
        h.update(('|'.join('' if v is None else str(v) for v in row)).encode('utf-8'))
        h.update(b'\n')
    return h.hexdigest()[:16]


def snapshot(root):
    snap = {}
    for name, tables in STORES.items():
        p = os.path.join(root, name, name + '.sqlite')
        con = sqlite3.connect(p)
        rows = {t: con.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0] for t in tables}
        h = hashlib.sha256()
        for oid, blob in con.execute('SELECT obj_id, blob FROM vectors ORDER BY obj_id'):
            h.update(oid.encode('utf-8'))
            h.update(bytes(blob))
        ds = {}
        for f in FTS_OF[name]:
            try:
                ds[f] = con.execute('SELECT count(*) FROM %s_docsize' % f).fetchone()[0]
            except Exception:
                ds[f] = -1
        m = {}
        if name == 'chunk':
            m['发电机'] = con.execute("SELECT count(*) FROM chunks_fts_tri WHERE chunks_fts_tri MATCH '发电机'").fetchone()[0]
            m['电压(词级)'] = con.execute("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '电压'").fetchone()[0]
        d = {label: hash_rows(con, sql) for label, sql in DERIVED[name]}
        con.close()
        snap[name] = {'rows': rows, 'vec_hash': h.hexdigest(), 'fts_docsize': ds, 'matches': m,
                      'derived': d, 'file_sha': build_db.file_sha256(p)}
    return snap


def rebuild(root):
    # chunk
    p = os.path.join(root, 'chunk', 'chunk.sqlite')
    con = sqlite3.connect(p)
    con.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')")
    con.execute("INSERT INTO chunks_fts_tri(chunks_fts_tri) VALUES('delete-all')")
    con.execute('DELETE FROM vectors')
    con.execute('INSERT INTO chunks_fts(rowid,text_seg) SELECT rowid,text_seg FROM chunks')
    con.execute('INSERT INTO chunks_fts_tri(rowid,text) SELECT rowid,text FROM chunks')
    build_db.insert_vectors(con, build_db.load_vectors(os.path.join(vec_dir(), 'chunk', 'vector', 'chunk.jsonl')))
    con.commit()
    kids = {r[0] for r in con.execute("SELECT id FROM chunks WHERE kind <> 'parent'")}
    # 🔴 父块提升需要 {子块: 父块}：chunk_entities = 转置 ∪ 子块父块提升
    parent_of = {r[0]: r[1] for r in con.execute('SELECT id, parent_id FROM chunks WHERE parent_id IS NOT NULL')}
    con.close()
    # graph
    p = os.path.join(root, 'graph', 'graph.sqlite')
    con = sqlite3.connect(p)
    con.execute('DELETE FROM entities_fts')
    con.execute('DELETE FROM vectors')
    con.execute("INSERT INTO entities_fts(rowid,name,aliases) SELECT rowid,name,'' FROM entities")
    build_db.fill_chunk_entities(con, parent_of)           # A3：转置 + 父块提升
    e_rows = list(con.execute('SELECT id, chunk_ids FROM entities'))
    build_db.fill_cooccurrence(con, e_rows, kids)          # A1：共现图（2026-10-19 迁入 graph 库）
    n_coo = con.execute('SELECT COUNT(*) FROM cooccurrence_edges').fetchone()[0]
    build_db.insert_vectors(con, build_db.load_vectors(os.path.join(vec_dir(), 'graph', 'vector', 'entity.jsonl')), 'entity')
    build_db.insert_vectors(con, build_db.load_vectors(os.path.join(vec_dir(), 'graph', 'vector', 'triple.jsonl')), 'triple')
    con.commit()
    con.close()
    print('  派生重建: 共现图 = %d 条' % n_coo)


def main():
    root = os.path.join(ROOT, 'workspace', 'data', 'vector-index')
    if '--data' in sys.argv:
        build_db.DATA = os.path.abspath(sys.argv[sys.argv.index('--data') + 1])
        log_data = build_db.DATA
    if '--dir' in sys.argv:
        root = sys.argv[sys.argv.index('--dir') + 1]
    print('target = ' + root)
    t0 = time.time()
    before = snapshot(root)
    print('--- 删索引与向量，再重建 ---')
    rebuild(root)
    after = snapshot(root)
    ok = True

    def same(a, b, label):
        nonlocal ok
        good = a == b
        ok = ok and good
        print('  %-28s %s' % (label, 'SAME' if good else 'DIFF  before=%s after=%s' % (a, b)))

    for n in STORES:
        same(before[n]['rows'], after[n]['rows'], n + ' 表行数')
        same(before[n]['fts_docsize'], after[n]['fts_docsize'], n + ' FTS docsize')
        same(before[n]['vec_hash'], after[n]['vec_hash'], n + ' 向量 blob 集')
        if before[n]['derived']:
            same(before[n]['derived'], after[n]['derived'], n + ' 派生表/列内容哈希')
        if before[n]['matches']:
            same(before[n]['matches'], after[n]['matches'], n + ' FTS 命中数')
    print('  两库文件 sha256（会变属正常：SQLite 页分配）')
    for n in STORES:
        print('    %-10s %s -> %s' % (n, before[n]['file_sha'][:16], after[n]['file_sha'][:16]))
    print('')
    print('向量 blob 集一致 ⇒ 余弦 = 1.0（判据「>= 0.999」满足）')
    print('elapsed %.1f s' % (time.time() - t0))
    print('RESULT ' + ('OK' if ok else 'FAIL'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
