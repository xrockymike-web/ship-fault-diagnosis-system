# -*- coding: utf-8 -*-
"""图谱抽取 · 第三步：为实体生成 attributes（LLM，纯标准库）。

来源与定位
    提示词与校验规则沿用 2026-10-05 属性抽取时用的那一版（那份施工单见 交接/3.3.4），本轮做了三处
    适配：① 去掉"章节"字段（版权脱钩后已无章节）；② 输出补 aliases；③ 结果统一渲染成
    随包 `entities.csv` 的 attributes 列格式（定义和属性: … | … | 别名: …）。
    与另外两步一样：产出是**待复核**的候选属性（origin=llm-extract），重跑不逐字节复现随包图谱。

用法
    python workspace/build/graph/extract_attributes.py --dry-run
    python workspace/build/graph/extract_attributes.py --entities <out>/entities_raw.csv --limit 20 --api-key-file <key文件>
    python workspace/build/graph/extract_attributes.py --entities workspace/data/graph/entities.csv --api-key-file <key文件>

输出
    <out>/entities_attr.csv   （= 输入表 + attributes 列填好；origin 写 llm-extract）
    <out>/attributes_raw.jsonl（逐实体原始结果，断点/审计用）
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

SYS_PROMPT = """你是船舶电气知识图谱的实体事实抽取器。给定一个实体及其证据文本块，写出关于这个实体的、能从证据逐条核对的事实。这些事实将作为该实体的属性写入图数据库，并用于检索匹配。

【总则】
1. 只依据证据块。证据里没有的一律不写；禁止推测、补全、常识外推。
2. 每条事实必须回填 chunk_id，且只能从给定块里选。
3. 写什么由证据决定（类属、组成、功能、原理、型号、数值参数、工作条件、失效形式、后果、方法等），不预设固定属性名。
4. 禁止空话与套话：「起重要作用」「用于相关设备」「与故障有关」「便于维护」等放进任何同类实体都成立的话，一律不写。
5. 【可区分性自检 · 改写优先】输出前逐条自检：把某条事实里的实体名换成同类型的另一个实体，如果这句话依然成立，说明它过于通用。此时：
   ① 优先用证据中的信息把它改写得具体（补充所属设备/系统、型号、类型、数值参数、作用对象或适用条件），使之只对本实体成立；
   ② 若证据中确实没有可用于区分的具体信息，则原样保留，不删除、不编造；
   ③ 严禁为了「看起来独特」而添加证据里没有的型号、数值或归属。
   最终至少要有 2 条能通过上述检验（证据确实不足时如实少写，不凑数）。
6. 一条只讲一件事；同类信息合并去重；按重要性排序。
7. 只输出 JSON，不输出解释文字，不要 Markdown 代码围栏。
8. 顶层必须是 JSON 对象，键名固定为 definition / claims / aliases；不要输出数组，不要改名。

【输出格式】
{{"definition": {{"text": "", "chunk_id": ""}},
  "claims":    [{{"text": "", "chunk_id": ""}}],
  "aliases":   [{{"text": "", "chunk_id": ""}}]}}

字段说明：
- definition：一句话正式定义，形如「<类属>，<区别特征>」，≤60 字；证据不足留空。
- claims：3～10 条关于本实体的事实，每条 ≤40 字，带来源 chunk_id，按重要性排序。
- aliases：用户可能用来指代它的其他说法（简称/俗称/同义术语/英文名）；只写确实等价的，不造缩写；没有则空数组。
若证据不足以写出任何合格条目，返回 {{"claims": []}}，不要凑数。"""

USER_TMPL = """【实体】名称：{name}　类型：{type}

【证据块】（只能引用以下 chunk_id；块内不要跨块拼接）
{evidence}
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
            'desc': r[idx['entity_desc']],
            'chunk_ids': [x for x in (r[idx['chunk_ids']] or '').split('|') if x],
            'row': r,
        })
    return hdr, out


def evidence_of(entity, by_id, k):
    ids = entity['chunk_ids'][:k]
    parts = []
    for cid in ids:
        c = by_id.get(cid)
        if c:
            parts.append('[%s] %s' % (cid, c['text']))
    return ids, '\n\n'.join(parts)


def render(defn, claims, aliases):
    """渲染成随包 entities.csv 的 attributes 列格式（同一格式，便于对照复核）。"""
    segs = []
    if defn:
        segs.append(defn)
    segs.extend(claims)
    body = ' | '.join(segs)
    head = '定义和属性: ' + body if body else ''
    if aliases:
        return (head + ' | ' if head else '') + '别名: ' + '、'.join(aliases)
    return head


def normalize(raw, ids):
    """校验并截断：定义 ≤60 字、每条事实 ≤40 字、块号必须在给定集合内。"""
    stats = {'bad_claim': 0, 'bad_chunk': 0, 'ok': 0}
    d = raw.get('definition') or {}
    defn = str(d.get('text') or '').strip()[:60]
    claims = []
    for c in (raw.get('claims') or [])[:10]:
        t = str(c.get('text') or '').strip()
        cid = str(c.get('chunk_id') or '').strip()
        if not t or len(t) > 60:
            stats['bad_claim'] += 1
            continue
        if cid and cid not in ids:
            stats['bad_chunk'] += 1
            continue
        claims.append(t)
        stats['ok'] += 1
    aliases = [str(a.get('text') or '').strip() for a in (raw.get('aliases') or []) if str(a.get('text') or '').strip()]
    return {'definition': defn, 'claims': claims, 'aliases': aliases}, stats


DRY_RESPONSE = json.dumps({
    'definition': {'text': '把机械能转换为电能的旋转电机，船上用作主电源与应急电源', 'chunk_id': ''},
    'claims': [
        {'text': '建立电压前需检查有无剩磁电压', 'chunk_id': ''},
        {'text': '无剩磁时须充磁后再起压', 'chunk_id': ''},
        {'text': '起重要作用', 'chunk_id': ''},
    ],
    'aliases': [{'text': '发电机组', 'chunk_id': ''}],
}, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=gc.DATA)
    ap.add_argument('--out', default=os.path.join(gc.DATA, 'runtime', 'graph_extract'))
    ap.add_argument('--entities', help='实体 CSV（默认 <out>/entities_raw.csv）')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--base-url', default=DEFAULT_BASE)
    ap.add_argument('--api-key-file')
    ap.add_argument('--top-blocks', type=int, default=4, help='每个实体喂几块证据（默认 4）')
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
    hdr, ents = load_entities(ent_path)
    if a.limit:
        ents = ents[:a.limit]
    chunks = gc.load_text_chunks(data)
    by_id = {c['id']: c for c in chunks}
    todo = [e for e in ents if e['chunk_ids']]
    print('实体 %d 个（有证据块 %d / 无证据块 %d，后者跳过）' % (len(ents), len(todo), len(ents) - len(todo)))

    if a.dry_run:
        e = todo[0]
        ids, ev = evidence_of(e, by_id, a.top_blocks)
        user = USER_TMPL.format(name=e['name'], type=e['type'], evidence=ev)
        print('\n--- system（前 300 字）---\n' + SYS_PROMPT[:300] + '…')
        print('\n--- user（前 300 字）---\n' + user[:300] + '…')
        stub = StubClient([DRY_RESPONSE])
        raw = stub.json_chat(SYS_PROMPT, user)
        res, st = normalize(raw, ids)
        txt = render(res['definition'], res['claims'], res['aliases'])
        path = os.path.join(out, 'dry-run', 'entities_attr.csv')
        row = list(e['row'])
        if 'attributes' in hdr:
            row[hdr.index('attributes')] = txt
        gc.write_csv(path, hdr, [row])
        print('\n[dry-run] 链路 OK：定义 1 条 / 事实 %d 条 / 别名 %d 个；丢弃 %s' % (len(res['claims']), len(res['aliases']), st))
        print('[dry-run] 渲染样例：' + txt[:160] + ('…' if len(txt) > 160 else ''))
        print('[dry-run] 预览 → ' + path)
        print('[dry-run] 未联网、未调用模型、未写 data/graph')
        return 0

    api_key = load_key(a.api_key_file)
    cache_dir = os.path.join(out, 'cache')
    cli = Client(model=a.model, base_url=a.base_url, api_key=api_key,
                 cache_dir=cache_dir, prompt_salt=SYS_PROMPT)

    def one(e):
        ids, ev = evidence_of(e, by_id, a.top_blocks)
        if not ev:
            return e, None, {'bad_claim': 0, 'bad_chunk': 0, 'ok': 0}
        raw = cli.json_chat(SYS_PROMPT, USER_TMPL.format(name=e['name'], type=e['type'], evidence=ev))
        res, st = normalize(raw, ids)
        return e, res, st

    results = cli.map(one, todo, a.concurrency)
    rows, total_claims, total_alias, dropped = [], 0, 0, 0
    raw_path = os.path.join(out, 'attributes_raw.jsonl')
    gc.ensure_dir(out)
    with open(raw_path, 'w', encoding='utf-8', newline='\n') as fraw:
        for e, res, st in results:
            dropped += st['bad_claim'] + st['bad_chunk']
            row = list(e['row'])
            if res is None:
                rows.append(row)
                continue
            total_claims += len(res['claims'])
            total_alias += len(res['aliases'])
            txt = render(res['definition'], res['claims'], res['aliases'])
            if 'attributes' in hdr:
                row[hdr.index('attributes')] = txt
            if 'origin' in hdr:
                row[hdr.index('origin')] = 'llm-extract'
            rows.append(row)
            fraw.write(json.dumps({'entity_id': e['entity_id'], 'name': e['name'], **res}, ensure_ascii=False) + '\n')

    path = os.path.join(out, 'entities_attr.csv')
    gc.write_csv(path, hdr, rows)
    print('已生成 %d 个实体（事实 %d 条 / 别名 %d 个；丢弃不合规事实 %d 条）'
          % (len(results), total_claims, total_alias, dropped))
    print(cli.report())
    print('产物 → ' + path + ' ／ ' + raw_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
