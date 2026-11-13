# -*- coding: utf-8 -*-
"""图谱抽取 · 第一步：从块库抽实体（LLM，纯标准库）。

定位（重要）
    本脚本复现的是**抽取向**的流程：块 → 候选实体。随包发布的 `data/graph/entities.csv`
    是在抽取结果之上又做了一轮**人工复核与规范化**（改类型、并别名、删空话、补漏），
    所以重跑本脚本**不会**逐字节复现随包图谱 —— 它产出的是**待复核的候选集**（origin=llm-extract）。
    这条边界写在 build/graph/README.md 里，论文的「可复现」口径按那个说。

用法
    # 0) 不花钱看链路（不联网，打印提示词 + 用桩回复跑通解析/校验/落盘）
    python workspace/build/graph/extract_entities.py --dry-run

    # 1) 小样本试跑（前 20 个窗）
    python workspace/build/graph/extract_entities.py --limit 20 --api-key-file <key文件>

    # 2) 全量（有缓存，重跑不再花钱）
    python workspace/build/graph/extract_entities.py --api-key-file <key文件> --concurrency 4

输出
    <out>/entities_raw.csv   （表头与 data/graph/entities.csv 同构；attributes 列留空）
    <out>/cache/llm_<model>_<prompt_sha>.jsonl
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

SYS_PROMPT = """你是船舶电气知识图谱的实体抽取器。给定一段连续原文（按块号切分），列出其中**可被诊断流程引用**的实体。

【实体类型（只能取这七个之一）】
船舶装备 / 零部件 / 故障现象 / 故障原因 / 维修步骤 / 维护项目 / 注意事项

【类型判定（按它在句子里扮演什么，不是按词的长相）】
- 船舶装备：可独立运转的设备或系统（发电机、配电板、舵机、励磁系统）
- 零部件：装备的组成件或元件（励磁绕组、整流器、熔断器、电刷）
- 故障现象：可观察到的异常表现（电压建立不起来、机组过热、有异响）
- 故障原因：造成现象的因素（剩磁消失、绕组断路、气隙过小、接线接反）
- 维修步骤：一个可执行的动作（充磁、测量气隙、更换电刷、调大整定电阻）
- 维护项目：周期性保养工作（检查绝缘电阻、清洁换向器、定期润滑）
- 注意事项：操作禁忌与安全提醒（严禁带电插拔、充磁时注意极性）

【总则】
1. 只抽原文明确出现的名词性对象。动词短语、形容词、整句结论都不是实体。
2. 名称用原文措辞（2–20 字），不改写、不加书名号、不翻译；同义不同名（简称/俗称）放进 aliases。
3. 同一实体在多个块出现只输出一次；evidence 列出它出现过的块号（**只能取给定块号**，最多 5 个）。
4. 禁止造原文没有的词，禁止把段落主题当实体，禁止把"故障""维护"这类通用词单列成实体。
5. desc 写 ≤40 字的「它是什么/做什么」，只用原文信息；没把握就留空字符串。
6. 只输出 JSON，不要输出解释文字，不要输出 Markdown 代码围栏。

【输出格式】
{"entities": [{"name": "", "type": "", "desc": "", "aliases": [], "evidence": ["TXT-0001"]}]}
"""

USER_TMPL = """【原文】（每块以 [块号] 开头；块号是唯一可用的证据编号）
{text}

【任务】列出这段原文里的实体。命名与类型按系统提示的规则；evidence 只填上面出现过的块号。
"""


def build_user(win):
    return USER_TMPL.format(text=gc.window_text(win))


def normalize(raw, win_ids):
    """把模型输出变成可落盘的行；不合法的一律丢弃并计数（不猜、不补）。"""
    stats = {'bad_type': 0, 'bad_name': 0, 'no_evidence': 0, 'ok': 0}
    out = []
    for e in (raw.get('entities') or []):
        name = str(e.get('name') or '').strip()
        typ = str(e.get('type') or '').strip()
        if typ not in gc.ENTITY_TYPES:
            stats['bad_type'] += 1
            continue
        if not (2 <= len(name) <= 20):
            stats['bad_name'] += 1
            continue
        ev = [x for x in (e.get('evidence') or []) if x in win_ids]
        if not ev:
            stats['no_evidence'] += 1
            continue
        aliases = [str(a).strip() for a in (e.get('aliases') or []) if 2 <= len(str(a).strip()) <= 20]
        out.append({
            'name': name,
            'type': typ,
            'desc': str(e.get('desc') or '').strip()[:80],
            'aliases': aliases,
            'chunk_ids': sorted(set(ev)),
        })
        stats['ok'] += 1
    return out, stats


def merge(rows):
    """同名合并（类型取先出现者，块号并集，别名并集），保持首次出现顺序。"""
    by_name = {}
    order = []
    for r in rows:
        k = r['name']
        if k not in by_name:
            by_name[k] = dict(r, chunk_ids=set(r['chunk_ids']), aliases=list(r['aliases']))
            order.append(k)
        else:
            cur = by_name[k]
            cur['chunk_ids'] |= set(r['chunk_ids'])
            for a in r['aliases']:
                if a not in cur['aliases']:
                    cur['aliases'].append(a)
            if not cur['desc'] and r['desc']:
                cur['desc'] = r['desc']
    return [by_name[k] for k in order]


def assign_ids(rows):
    """稳定编号：先按类型（7 类的固定顺序）再按名称排序 → E-0001…，同一批输入必然同一套号。"""
    order = {t: i for i, t in enumerate(gc.ENTITY_TYPES)}
    rows = sorted(rows, key=lambda r: (order[r['type']], r['name']))
    for i, r in enumerate(rows, 1):
        r['entity_id'] = gc.ENTITY_ID_FMT % i
    return rows


DRY_RESPONSE = json.dumps({
    'entities': [
        {'name': '发电机', 'type': '船舶装备', 'desc': '把机械能转换为电能的设备',
         'aliases': ['发电机组'], 'evidence': []},
        {'name': '励磁绕组', 'type': '零部件', 'desc': '产生磁场的绕组',
         'aliases': [], 'evidence': []},
        {'name': '剩磁消失', 'type': '故障原因', 'desc': '磁极失去剩磁', 'aliases': [], 'evidence': []},
        {'name': '不存在的东西', 'type': '不存在的类型', 'desc': '', 'aliases': [], 'evidence': []},
    ]
}, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=gc.DATA)
    ap.add_argument('--out', default=os.path.join(gc.DATA, 'runtime', 'graph_extract'))
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--base-url', default=DEFAULT_BASE)
    ap.add_argument('--api-key-file')
    ap.add_argument('--cache-dir')
    ap.add_argument('--window-chars', type=int, default=3000)
    ap.add_argument('--max-blocks', type=int, default=8)
    ap.add_argument('--limit', type=int, default=0, help='只跑前 N 个窗（0 = 全部）')
    ap.add_argument('--concurrency', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true', help='不联网：打印提示词并用桩回复跑通链路')
    a = ap.parse_args()

    data = os.path.abspath(a.data)
    out = os.path.abspath(a.out)
    chunks = gc.load_text_chunks(data)
    wins = gc.windows(chunks, a.window_chars, a.max_blocks)
    if a.limit:
        wins = wins[:a.limit]
    print('块 %d（%d 字）→ 窗 %d（每窗 ≤%d 字 / ≤%d 块）'
          % (len(chunks), sum(len(c['text']) for c in chunks), len(wins), a.window_chars, a.max_blocks))

    if a.dry_run:
        win = wins[0]
        user = build_user(win)
        print('\n--- system（前 300 字）---\n' + SYS_PROMPT[:300] + '…')
        print('\n--- user（前 400 字）---\n' + user[:400] + '…')
        stub = StubClient([DRY_RESPONSE])
        raw = stub.json_chat(SYS_PROMPT, user)
        win_ids = {c['id'] for c in win}
        for e in raw.get('entities', []):
            if not e.get('evidence'):
                e['evidence'] = sorted(win_ids)[:2]
        rows, st = normalize(raw, win_ids)
        rows = assign_ids(merge(rows))
        path = os.path.join(out, 'dry-run', 'entities_raw.csv')
        gc.write_csv(path, gc.ENTITY_HEADER,
                     [[r['entity_id'], r['name'], r['type'], r['desc'],
                       '|'.join(r['chunk_ids']), '', 'llm-extract'] for r in rows])
        print('\n[dry-run] 解析/校验/落盘链路 OK：合法 %d 条，丢弃 %s' % (st['ok'], st))
        print('[dry-run] 预览 → ' + path)
        print('[dry-run] 未联网、未调用模型、未写 data/graph')
        return 0

    api_key = load_key(a.api_key_file)
    cache_dir = a.cache_dir or os.path.join(out, 'cache')
    cli = Client(model=a.model, base_url=a.base_url, api_key=api_key,
                 cache_dir=cache_dir, prompt_salt=SYS_PROMPT)

    def one(win):
        raw = cli.json_chat(SYS_PROMPT, build_user(win))
        ids = {c['id'] for c in win}
        rows, st = normalize(raw, ids)
        return rows, st

    print('开始抽取（并发 %d，缓存目录 %s）…' % (a.concurrency, cache_dir))
    results = cli.map(one, wins, a.concurrency)

    allrows, totals = [], {'bad_type': 0, 'bad_name': 0, 'no_evidence': 0, 'ok': 0}
    for rows, st in results:
        allrows.extend(rows)
        for k in totals:
            totals[k] += st[k]
    merged = merge(allrows)
    # 块号以**原文提及**为准（模型给的 evidence 只是"它读到了哪块"）：
    # 实体名/别名在全库里的字面出现位置才是它的出处，与 remap_graph_refs.py 同一口径。
    names = [r['name'] for r in merged] + [a for r in merged for a in r['aliases']]
    idx = gc.MentionIndex(chunks).scan(names)
    anchored = 0
    for r in merged:
        hit = set(idx.get(r['name']))
        for a in r['aliases']:
            hit |= set(idx.get(a))
        if hit:
            r['chunk_ids'] = sorted(hit)[:8]
            anchored += 1
    rows = assign_ids(merged)
    path = os.path.join(out, 'entities_raw.csv')
    gc.write_csv(path, gc.ENTITY_HEADER,
                 [[r['entity_id'], r['name'], r['type'], r['desc'],
                   '|'.join(sorted(r['chunk_ids'])), '', 'llm-extract'] for r in rows])
    print('原始 %d 条（丢弃：类型不符 %d / 名称不合规 %d / 无有效块号 %d）→ 同名合并后 **%d 个实体**'
          % (totals['ok'], totals['bad_type'], totals['bad_name'], totals['no_evidence'], len(rows)))
    print('块号锚定：%d / %d 个实体在原文里找到字面出处（其余用模型给的证据块）' % (anchored, len(rows)))
    by_type = {}
    for r in rows:
        by_type[r['type']] = by_type.get(r['type'], 0) + 1
    print('类型分布：' + '，'.join('%s %d' % (k, by_type[k]) for k in gc.ENTITY_TYPES if k in by_type))
    print(cli.report())
    print('产物 → ' + path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
