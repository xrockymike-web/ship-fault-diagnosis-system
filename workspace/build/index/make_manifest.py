#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""4.3 交付装箱单 —— manifest.json（只写装箱单，不做裁剪）

用法：python workspace/build/index/make_manifest.py [--dir <两库目录>]
产出：workspace/data/vector-index/manifest.json（不进 git）

🔴 2026-10-17 版权脱钩后：
   · assets 表已删 → 声明表数 16 → **15**
   · inputs 不再含 chunk/assets.jsonl（该文件已删）
   · 台账层只有 CORPUS-0001（旧上游来源台账条目已随清洗移除）
"""
import hashlib, json, os, sqlite3, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DATA = os.path.join(ROOT, 'workspace', 'data')
OUT = os.path.join(DATA, 'vector-index')
if '--dir' in sys.argv:
    OUT = sys.argv[sys.argv.index('--dir') + 1]
if '--data' in sys.argv:
    DATA = sys.argv[sys.argv.index('--data') + 1]
if '--vec' in sys.argv:
    VEC = sys.argv[sys.argv.index('--vec') + 1]
else:
    VEC = os.path.join(ROOT, 'workspace', 'build', 'vector-index')
SCHEMA_VERSION = 1
APP_ID = '0x53484950'
STORES = {
    'chunk': ['documents', 'chunks', 'chunks_fts', 'chunks_fts_tri', 'vectors'],
    'graph': ['entities', 'relation_types', 'triples', 'entities_fts', 'chunk_entities', 'cooccurrence_edges', 'vectors'],
}
INPUTS = ['chunk/chunks_filled.jsonl', 'graph/entities.csv',
          'graph/triples.csv', 'graph/relations.csv']


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def ro(p):
    return sqlite3.connect('file:' + p.replace('\\', '/') + '?mode=ro', uri=True)


stores = {}
vmeta = {}
for name, tables in STORES.items():
    path = os.path.join(OUT, name, name + '.sqlite')
    con = ro(path)
    rows = {t: con.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0] for t in tables}
    v = con.execute('SELECT COUNT(*), MIN(dim), MAX(dim), MIN(length(blob)), MAX(length(blob)), SUM(truncated) FROM vectors').fetchone()
    mid = [x[0] for x in con.execute('SELECT DISTINCT model_id FROM vectors')]
    tpl = [x[0] for x in con.execute('SELECT DISTINCT template_version FROM vectors')]
    con.close()
    stores[name] = {'file': name + '/' + name + '.sqlite', 'sha256': sha256(path),
                    'bytes': os.path.getsize(path), 'tables': tables, 'rows': rows}
    vmeta[name] = {'count': v[0], 'dim_min': v[1], 'dim_max': v[2], 'blob_bytes': v[3],
                   'truncated': v[5] or 0, 'model_id': mid, 'template_version': tpl}

total_vec = sum(vmeta[n]['count'] for n in vmeta)
total_trunc = sum(vmeta[n]['truncated'] for n in vmeta)
chunk_rows = stores['chunk']['rows']
graph_rows = stores['graph']['rows']

# 2026-10-22：不再统计 table 块（该类型已下线）；切块元数据从 chunk_stats.json 读
chunk_meta = {}
_cs = os.path.join(DATA, 'chunk', 'chunk_stats.json')
if os.path.exists(_cs):
    _s = json.load(open(_cs, encoding='utf-8'))
    chunk_meta = {'version': _s.get('version'), 'book_sha256': (_s.get('book') or {}).get('sha256'),
                  'params': _s.get('params'), 'text_in_range_250_450': (_s.get('quality') or {}).get('text_in_range_250_450')}

params41 = {}
pp = os.path.join(VEC, 'params.json')
if os.path.exists(pp):
    src = json.load(open(pp, encoding='utf-8'))
    params41 = {k: src.get(k) for k in ('model_id', 'template_version', 'backend', 'concurrency', 'batch', 'max_chars', 'elapsed_ms')}

manifest = {
    'manifest_version': '1.0',
    'product': '船舶故障诊断与维护系统',
    'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
    'generator': 'workspace/build/index/make_manifest.py',
    'schema_version': SCHEMA_VERSION,
    'application_id': APP_ID,
    'delivery': {
        'mode': 'full',
        'trimming': 'none',
        'note': '2026-10-17 版权脱钩已完成：assets 表（上游来源表号/图注/章节/真页码）与所有上游来源溯源列已删除；'
                '块/实体/三元组编号已换新体系（TXT/PRT/TBL-#### / E-#### / T-####）',
    },
    'stores': stores,
    'totals': {'stores': len(stores), 'declared_tables': sum(len(v) for v in STORES.values()), 'vectors': total_vec},
    'vectors': {
        'dim': 1024,
        'dtype': 'float32-little-endian',
        'layout': '每库一张 vectors 表（D22）；obj_type 仅 graph 库有（entity / triple）',
        'by_store': {n: vmeta[n]['count'] for n in vmeta},
        'truncated': total_trunc,
        'determinism': {
            'bitwise_reproducible': False,
            'measured': '同进程同批同输入连续两次 max|Δ|≈4.4e-3、余弦 0.99976（CUDA）；CPU 亦如此（4.16e-3 / 0.99970）',
            'criterion': '余弦 >= 0.999',
        },
    },
    'params': {
        'chunking': {'source': 'chunks_filled.jsonl', 'blocks_total': chunk_rows['chunks'],
                     'sub_vectorized': vmeta['chunk']['count'],
                     'parents': chunk_rows['chunks'] - vmeta['chunk']['count'],
                     'kind_set': ['parent', 'text'],
                     'has_page_columns': False,
                     'chunker': chunk_meta,
                     'text_seg': 'jieba 分词（空格连接）'},
        'graph': {'entities': graph_rows['entities'], 'relation_types': graph_rows['relation_types'],
                  'triples': graph_rows['triples'], 'chunk_entities': graph_rows['chunk_entities'],
                  'cooccurrence_edges': graph_rows['cooccurrence_edges'],
                  'cooccurrence_scope': '只用子块、无向、weight = 共享子块数（照 4.0.1；2026-10-19 迁入）',
                  'note': '第一档有效图（只掉头 + 去重）；'
                          'chunk_entities = entities.chunk_ids 转置 ∪ 子块父块提升（A3，建库时生成）；'
                          'cooccurrence_edges = entities.chunk_ids 的子块共现物化（A1）'},
        'embedding': params41,
    },
    'inputs': {},
    'layers': {'CORPUS-0001': 'layer-a_open（本项目自建语料；原始素材不随包分发）'},
    'notes': ['entities_fts.aliases 置空（D3-11，无数据源）',
              'entities 不含 source 列、triples 不含「内容来源」列（§4.2 原则 4）',
              'chunks.text_seg = jieba 分词；chunks_fts(unicode61) / chunks_fts_tri(trigram) 均为 content="chunks" 外部内容表',
              '两库 application_id = 0x53484950 / user_version = 1；运行期只读',
              '表数按「声明名」核（FTS5 另有影子表）',
              '2026-10-19 三库 → 两库（负责人拍板）：原第三库整体删除，'
              'cooccurrence_edges 迁入 graph 库；表数 15 → 12（chunk 5 + graph 7），向量 3467 → 3389',
              '2026-10-17 版权脱钩：删 assets 表（上游来源表号/图注/章节/真页码）→ 表数 16 → 15；'
              '删 chunks.{section,asset_id,refs}、entities/triples.{chapter,source_ptr,status,batch_id}、'
              'relation_types.domain、原第三库的 {parent_id,batch_id,status,evidence_chunk_ids} 四列'],
}
for rel in INPUTS:
    manifest['inputs'][rel] = sha256(os.path.join(DATA, rel))[:16]

with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

print('manifest.json written')
print('  stores=%d  tables=%d  vectors=%d  truncated=%d' % (manifest['totals']['stores'], manifest['totals']['declared_tables'], total_vec, total_trunc))
for n in STORES:
    print('  %-10s %s  %d B' % (n, stores[n]['sha256'][:16], stores[n]['bytes']))
