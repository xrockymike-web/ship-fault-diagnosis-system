# -*- coding: utf-8 -*-
"""图谱抽取公共件 —— 本目录三个抽取脚本共用的口径（读块 / 开窗 / 提及锚定 / 关系 schema / CSV 读写）。

为什么单独一个文件
    实体、三元组、属性三步必须用**同一套**块读取、开窗、块号锚定与类型校验，否则三步拼起来
    会产生「实体有、三元组引不到」「块号不在窗口里」这类对不上的结果。口径只有一份，改这里。

纪律（与 build/chunk 的判决缓存同一套）
    · 只读 <data>/chunk/chunks.jsonl 与 <data>/graph/*.csv，不写 data/graph；
    · 输出一律写到 `--out`（默认 data/runtime/graph_extract/，gitignore 覆盖）；
    · 文本按 `book.txt` 顺序，不跨窗拼接、不改原文。
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))          # workspace/build/graph
WS = os.path.dirname(os.path.dirname(HERE))                # workspace
DATA = os.path.join(WS, 'data')

# 实体类型：7 类，与 build_db / 检索侧一致（graph-retrieval 的类型权重表也按这 7 类写）
ENTITY_TYPES = ['船舶装备', '零部件', '故障现象', '故障原因', '维修步骤', '维护项目', '注意事项']

ENTITY_HEADER = ['entity_id', 'entity_name', 'entity_type', 'entity_desc', 'chunk_ids', 'attributes', 'origin']
TRIPLE_HEADER = ['triple_id', 'subject_id', 'predicate_id', 'object_id', 'chunk_ids', 'origin']

ENTITY_ID_FMT = 'E-%04d'
TRIPLE_ID_FMT = 'T-%04d'


# ---------------------------------------------------------------- 基础 I/O
def read_jsonl(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def read_csv(path):
    """读 CSV → (表头, 行 list)。文件里的空行、全空行忽略（relations.csv 带一行说明行）。"""
    with open(path, encoding='utf-8', newline='') as f:
        rows = [r for r in csv.reader(f) if r and any(x.strip() for x in r)]
    return rows[0], rows[1:]


def write_csv(path, header, rows, newline_ok=False):
    """写 CSV：LF 结尾、utf-8、无 BOM（与 data/graph 现有文件一致）。"""
    ensure_dir(os.path.dirname(path))
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(header)
        for r in rows:
            w.writerow(r)


def ensure_dir(p):
    if p and not os.path.isdir(p):
        os.makedirs(p, exist_ok=True)


# ---------------------------------------------------------------- 块库
def load_text_chunks(data=None, kinds=('text',)):
    """取块库里参与抽取的块（默认只取子块 kind='text'），按块号升序（= 书中顺序）。"""
    data = data or DATA
    chunks = read_jsonl(os.path.join(data, 'chunk', 'chunks.jsonl'))
    out = [c for c in chunks if c.get('kind') in kinds]
    out.sort(key=lambda c: c['id'])
    return out


def windows(chunks, max_chars=3000, max_blocks=8):
    """把连续块按「字数 + 块数」开窗。窗是抽取的最小单位：模型一次只看这么多原文。

    窗只切在块边界上（不切断块），因此每条证据都能回到完整块。
    """
    out, cur, size = [], [], 0
    for c in chunks:
        n = len(c['text'])
        if cur and (size + n > max_chars or len(cur) >= max_blocks):
            out.append(cur)
            cur, size = [], 0
        cur.append(c)
        size += n
    if cur:
        out.append(cur)
    return out


def window_text(win, limit=3500):
    """窗内原文渲染：每块一个 `[块号]` 抬头，便于模型把证据写成块号。"""
    parts = []
    for c in win:
        parts.append('[%s] %s' % (c['id'], c['text']))
    return '\n\n'.join(parts)


# ---------------------------------------------------------------- 提及锚定
class MentionIndex:
    """实体名 → 出现过它的块号集合（**提及锚点**，与 remap_graph_refs.py 同一口径）。

    为什么不按"区间重叠"：块已经按句切过，用区间重叠会把实体挂到它根本没被提到的块上。
    """

    def __init__(self, chunks):
        self.chunks = chunks
        self.hit = {}                      # name -> set(chunk_id)

    def scan(self, names):
        names = [n for n in dict.fromkeys(names) if n and len(n) >= 2]
        for c in self.chunks:
            t = c['text']
            for n in names:
                if n in t:
                    self.hit.setdefault(n, set()).add(c['id'])
        return self

    def get(self, name, limit=5):
        ids = sorted(self.hit.get(name, ()))
        return ids[:limit]


# ---------------------------------------------------------------- 关系 schema
def load_relations(data=None):
    """读 relations.csv → {R001: {name, type, desc, allowed: {(头类型, 尾类型)}}}。

    relations.csv 是**唯一尺子**：抽取只允许落在这 11 个关系上，且头尾类型必须在
    real_desc 声明的组合里。这样可以避免模型自造关系名或把因果倒置。
    """
    data = data or DATA
    hdr, rows = read_csv(os.path.join(data, 'graph', 'relations.csv'))
    out = {}
    for r in rows:
        if len(r) < 5 or not r[1].startswith('R'):
            continue
        rid, name, rtype, desc = r[1], r[2], r[3], r[4]
        # 描述形如「船舶装备→包含→零部件」：取**首尾**两个类型（中间那段是关系名，
        # 不是类型 —— 取 seg[1] 会得到 ("船舶装备","包含")，永远匹配不上实体类型）
        allowed = set()
        for part in desc.split('；'):
            seg = [s.strip() for s in part.split('→') if s.strip()]
            if len(seg) >= 3:
                allowed.add((seg[0], seg[-1]))
        out[rid] = {'name': name, 'type': rtype, 'desc': desc, 'allowed': allowed}
    return out


def relations_brief(rels):
    """给提示词用的一行式关系表：`R001 包含（船舶装备→零部件、船舶装备→维护项目）`。"""
    lines = []
    for rid in sorted(rels):
        r = rels[rid]
        pairs = '、'.join('%s→%s' % (h, t) for h, t in sorted(r['allowed']))
        lines.append('%s %s（%s）' % (rid, r['name'], pairs or '—'))
    return '\n'.join(lines)


# 编号由各脚本自己的 assign_ids() 负责（排序规则不同：实体按类型+名称，边按关系+头+尾）
