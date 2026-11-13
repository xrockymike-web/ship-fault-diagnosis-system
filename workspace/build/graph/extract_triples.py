# -*- coding: utf-8 -*-
"""图谱抽取 · 第二步：从块库抽三元组（LLM，关系受 relations.csv 约束）。

定位
    与 extract_entities.py 同一口径：产出**待复核的候选边**（origin=llm-extract）。
    随包 `data/graph/triples.csv` 在抽取之上做过人工复核（掉头、去重、删凑数边），重跑不会逐字节复现。

关系尺子
    关系编号、名称、允许的（头类型→尾类型）全部从 `data/graph/relations.csv` 现读，
    **不写死在代码里** —— 改 schema 只改那一份 CSV。模型自造关系 / 类型组合不合法的边一律丢弃并计数。

用法
    python workspace/build/graph/extract_triples.py --dry-run
    python workspace/build/graph/extract_triples.py --entities <out>/entities_raw.csv --limit 20 --api-key-file <key文件>
    python workspace/build/graph/extract_triples.py --entities <out>/entities_raw.csv --api-key-file <key文件>

输出
    <out>/triples_raw.csv   （表头与 data/graph/triples.csv 同构）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import graph_common as gc
from llm_client import DEFAULT_BASE, DEFAULT_MODEL, Client, StubClient, load_key

SYS_PROMPT = """你是船舶电气知识图谱的关系抽取器。给定【实体清单】与【原文】，只输出**原文明确表述**的（头实体，关系，尾实体）。

【关系（编号只能用下表里的，方向照图）】
{rels}

【总则】
1. 只抽原文直说的关系。禁止推理链、禁止多跳拼接（A→B、B→C 不等于 A→C）。
2. 头/尾必须是【实体清单】里的实体，用实体编号（E-####）写，不要写名字。
3. 关系方向按图：例如「故障原因 导致 故障现象」「故障现象 对应 维修步骤」；
   写反了就是错的（不要因为原句语序就倒置）。
4. 关系头尾的类型组合必须落在上表括号里的组合内；不在表内就**不要输出**这条边。
5. 同一条边只输出一次；evidence 只填原文里出现过的块号。
6. 只输出 JSON，不要解释文字，不要 Markdown 代码围栏。

【输出格式】
{{"triples": [{{"head": "E-0001", "rel": "R003", "tail": "E-0002", "evidence": ["TXT-0001"]}}]}}
"""

USER_TMPL = """【实体清单】（只可用这些编号）
{ents}

【原文】（每块以 [块号] 开头）
{text}

【任务】列出这段原文里**明确成立**的三元组；没有就返回空数组，不要凑数。
"""


def load_entities(path):
    hdr, rows = gc.read_csv(path)
    idx = {h: i for i, h in enumerate(hdr)}
    out = []
    for r in rows:
        out.append({
            'entity_id': r[idx['entity_id']],
            'name': r[idx['entity_name']],
            'type': r[idx['entity_type']],
            'chunk_ids': [x for x in (r[idx['chunk_ids']] or '').split('|') if x],
        })
    return out


def build_user(win, ents):
    lines = ['%s %s（%s）' % (e['entity_id'], e['name'], e['type']) for e in ents]
    return USER_TMPL.format(ents='\n'.join(lines), text=gc.window_text(win))


def normalize(raw, win_ids, ent_by_id, rels):
    stats = {'bad_ent': 0, 'bad_rel': 0, 'bad_pair': 0, 'no_evidence': 0, 'ok': 0}
    out = []
    for t in (raw.get('triples') or []):
        h = str(t.get('head') or '').strip()
        r = str(t.get('rel') or '').strip()
        o = str(t.get('tail') or '').strip()
        if h not in ent_by_id or o not in ent_by_id or h == o:
            stats['bad_ent'] += 1
            continue
        if r not in rels:
            stats['bad_rel'] += 1
            continue
        if (ent_by_id[h]['type'], ent_by_id[o]['type']) not in rels[r]['allowed']:
            stats['bad_pair'] += 1
            continue
        ev = [x for x in (t.get('evidence') or []) if x in win_ids]
        if not ev:
            stats['no_evidence'] += 1
            continue
        out.append({'head': h, 'rel': r, 'tail': o, 'chunk_ids': sorted(set(ev))})
        stats['ok'] += 1
    return out, stats


def merge(rows):
    """(头, 关系, 尾) 去重，块号并集。"""
    by_key, order = {}, []
    for r in rows:
        k = (r['head'], r['rel'], r['tail'])
        if k not in by_key:
            by_key[k] = dict(r, chunk_ids=set(r['chunk_ids']))
            order.append(k)
        else:
            by_key[k]['chunk_ids'] |= set(r['chunk_ids'])
    return [by_key[k] for k in order]


def assign_ids(rows):
    rows = sorted(rows, key=lambda r: (r['rel'], r['head'], r['tail']))
    for i, r in enumerate(rows, 1):
        r['triple_id'] = gc.TRIPLE_ID_FMT % i
    return rows


DRY_RESPONSE = json.dumps({'triples': [
    {'head': 'E-0001', 'rel': 'R001', 'tail': 'E-0002', 'evidence': []},
    {'head': 'E-0009', 'rel': 'R003', 'tail': 'E-0002', 'evidence': []},
    {'head': 'E-0001', 'rel': 'R999', 'tail': 'E-0002', 'evidence': []},
]}, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=gc.DATA)
    ap.add_argument('--out', default=os.path.join(gc.DATA, 'runtime', 'graph_extract'))
    ap.add_argument('--entities', help='实体 CSV（默认 <out>/entities_raw.csv）')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--base-url', default=DEFAULT_BASE)
    ap.add_argument('--api-key-file')
    ap.add_argument('--window-chars', type=int, default=3000)
    ap.add_argument('--max-blocks', type=int, default=8)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--concurrency', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    data = os.path.abspath(a.data)
    out = os.path.abspath(a.out)
    ent_path = a.entities or os.path.join(out, 'entities_raw.csv')
    if not os.path.exists(ent_path):
        dry = os.path.join(out, 'dry-run', 'entities_raw.csv')     # 串着跑 --dry-run 时复用上一步的预览
        if os.path.exists(dry):
            ent_path = dry
        else:
            raise SystemExit('缺实体表：%s（先跑 extract_entities.py，或用 --entities 指定）' % ent_path)
    ents = load_entities(ent_path)
    rels = gc.load_relations(data)
    chunks = gc.load_text_chunks(data)
    wins = gc.windows(chunks, a.window_chars, a.max_blocks)
    if a.limit:
        wins = wins[:a.limit]
    print('实体 %d 个 ｜ 关系 %d 个（来自 relations.csv）｜ 块 %d → 窗 %d'
          % (len(ents), len(rels), len(chunks), len(wins)))

    if a.dry_run:
        win = wins[0]
        win_ids = {c['id'] for c in win}
        nearby = [e for e in ents if set(e['chunk_ids']) & win_ids] or ents[:3]
        user = build_user(win, nearby).replace('{rels}', gc.relations_brief(rels))
        print('\n--- system（前 400 字）---\n' + SYS_PROMPT.format(rels=gc.relations_brief(rels))[:400] + '…')
        print('\n--- user（前 400 字）---\n' + user[:400] + '…')
        stub = StubClient([DRY_RESPONSE])
        raw = stub.json_chat(SYS_PROMPT.format(rels=gc.relations_brief(rels)), user)
        for t in raw.get('triples', []):
            if t['head'] not in {e['entity_id'] for e in nearby}:
                t['head'] = nearby[0]['entity_id']
            if t['tail'] not in {e['entity_id'] for e in nearby}:
                t['tail'] = nearby[min(1, len(nearby) - 1)]['entity_id']
            if not t.get('evidence'):
                t['evidence'] = [sorted(win_ids)[0]]
        by_id = {e['entity_id']: e for e in nearby}
        rows, st = normalize(raw, win_ids, by_id, rels)
        rows = assign_ids(merge(rows))
        path = os.path.join(out, 'dry-run', 'triples_raw.csv')
        gc.write_csv(path, gc.TRIPLE_HEADER,
                     [[r['triple_id'], r['head'], r['rel'], r['tail'],
                       '|'.join(r['chunk_ids']), 'llm-extract'] for r in rows])
        print('\n[dry-run] 链路 OK：合法 %d 条，丢弃 %s（bad_rel/bad_pair 属预期，桩回复里故意塞了非法边）'
              % (st['ok'], st))
        print('[dry-run] 预览 → ' + path)
        print('[dry-run] 未联网、未调用模型、未写 data/graph')
        return 0

    api_key = load_key(a.api_key_file)
    cache_dir = os.path.join(out, 'cache')
    rel_text = gc.relations_brief(rels)
    sys_prompt = SYS_PROMPT.format(rels=rel_text)
    cli = Client(model=a.model, base_url=a.base_url, api_key=api_key,
                 cache_dir=cache_dir, prompt_salt=sys_prompt)

    jobs = []
    for win in wins:
        ids = {c['id'] for c in win}
        nearby = [e for e in ents if set(e['chunk_ids']) & ids]
        if len(nearby) < 2:
            continue
        jobs.append((win, ids, nearby))
    print('可抽窗 %d（跳过实体不足 2 个的窗）' % len(jobs))

    def one(job):
        win, ids, nearby = job
        by_id = {e['entity_id']: e for e in nearby}
        raw = cli.json_chat(sys_prompt, build_user(win, nearby))
        return normalize(raw, ids, by_id, rels)

    results = cli.map(one, jobs, a.concurrency)
    allrows = []
    totals = {'bad_ent': 0, 'bad_rel': 0, 'bad_pair': 0, 'no_evidence': 0, 'ok': 0}
    for rows, st in results:
        allrows.extend(rows)
        for k in totals:
            totals[k] += st[k]
    rows = assign_ids(merge(allrows))
    path = os.path.join(out, 'triples_raw.csv')
    gc.write_csv(path, gc.TRIPLE_HEADER,
                 [[r['triple_id'], r['head'], r['rel'], r['tail'],
                   '|'.join(sorted(r['chunk_ids'])), 'llm-extract'] for r in rows])
    print('原始 %d 条（丢弃：实体不存在 %d / 关系不在表内 %d / 类型组合不合法 %d / 无有效块号 %d）→ 去重后 **%d 条边**'
          % (totals['ok'], totals['bad_ent'], totals['bad_rel'], totals['bad_pair'], totals['no_evidence'], len(rows)))
    by_rel = {}
    for r in rows:
        by_rel[r['rel']] = by_rel.get(r['rel'], 0) + 1
    print('关系分布：' + '，'.join('%s %s %d' % (k, rels[k]['name'], by_rel[k]) for k in sorted(by_rel)))
    print(cli.report())
    print('产物 → ' + path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
