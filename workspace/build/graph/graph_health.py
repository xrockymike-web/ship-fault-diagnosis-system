# -*- coding: utf-8 -*-
"""图谱体检（只读）—— 输出知识图谱质量分数卡。

- 纯标准库；**不改任何数据**
- 输入：workspace/data/graph/{entities,triples,relations}.csv
- 输出：workspace/data/graph/graph_health.json + graph_health.md
- 用法：& workspace/environment/python/python.exe workspace/build/graph/graph_health.py
"""
import csv, json, os, collections

NL = chr(10)
HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(os.path.dirname(HERE))
import sys
GRAPH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WS, "data", "graph")
OUT_JSON = os.path.join(GRAPH, "graph_health.json")
OUT_MD = os.path.join(GRAPH, "graph_health.md")


def read_csv(p):
    with open(p, encoding="utf-8", newline="") as f:
        rows = [r for r in csv.reader(f) if r and any(x.strip() for x in r)]
    return rows[0], rows[1:]


def nth(header, name, k):
    c = 0
    for i, n in enumerate(header):
        if n == name:
            c += 1
            if c == k:
                return i
    return -1


eh, er = read_csv(os.path.join(GRAPH, "entities.csv"))
th, tr = read_csv(os.path.join(GRAPH, "triples.csv"))
rh, rr = read_csv(os.path.join(GRAPH, "relations.csv"))

# ============================================================================
# 🔴 2026-10-17 版权脱钩后，entities.csv / triples.csv 的表头已换成英文列名：
#   entities: entity_id, entity_name, entity_type, entity_desc, chunk_ids, attributes, origin
#   triples : triple_id, subject_id, predicate_id, object_id, chunk_ids, origin
#   （原中文表头含 chapter / source_ptr / 内容来源 等列，随版权清洗删除）
# 这里显式校验表头：**表头不符就直接报错**，避免在旧 CSV 上跑出无意义的分数卡。
# ============================================================================
NEED_E = ['entity_id', 'entity_name', 'entity_type', 'entity_desc', 'chunk_ids', 'attributes']
NEED_T = ['triple_id', 'subject_id', 'predicate_id', 'object_id', 'chunk_ids']
miss_e = [c for c in NEED_E if c not in eh]
miss_t = [c for c in NEED_T if c not in th]
if miss_e or miss_t:
    raise SystemExit('表头不符（2026-10-17 新 schema）：entities 缺 %s ｜ triples 缺 %s\n'
                     '实际 entities 表头=%s\n实际 triples 表头=%s' % (miss_e, miss_t, eh, th))

ei = {n: i for i, n in enumerate(eh)}
T_HID = th.index('subject_id')
T_PRED = th.index('predicate_id')
T_TID = th.index('object_id')
T_CID = th.index('chunk_ids')

rel = {}
for r in rr:
    if len(r) >= 5 and r[1].startswith("R"):
        rel[r[1]] = r[2]
allowed = set()
for rid, o in [(k, v) for k, v in rel.items()]:
    pass
for r in rr:
    if len(r) >= 5 and r[1].startswith("R"):
        for part in r[4].split("；"):
            seg = [s.strip() for s in part.split("→") if s.strip()]
            if len(seg) >= 3:
                allowed.add((seg[0], r[1], seg[-1]))

ids = [r[ei["entity_id"]] for r in er]
id_set = set(ids)
types = collections.Counter(r[ei["entity_type"]] for r in er)
names = [r[ei["entity_name"]] for r in er]
dup = collections.Counter(names)
dup_groups = {k: v for k, v in dup.items() if v > 1}
# 实体 id -> 类型（新 CSV 的 triples 不再自带两端类型，需回查 entities）
et = {r[ei["entity_id"]]: r[ei["entity_type"]] for r in er}

used = set()
for r in tr:
    used.add(r[T_HID]); used.add(r[T_TID])
orphans = id_set - used

ok = 0
per = collections.Counter(); perok = collections.Counter()
for r in tr:
    rid = r[T_PRED]; per[rid] += 1
    if (et.get(r[T_HID], ''), rid, et.get(r[T_TID], '')) in allowed:
        ok += 1; perok[rid] += 1
compliance = ok / len(tr) if tr else 0

corr = [r for r in tr if r[T_PRED] == "R004"]
corr_ok = sum(1 for r in corr if (et.get(r[T_HID], ''), "R004", et.get(r[T_TID], '')) in allowed)

hc, ch, cm = set(), set(), set()
for r in tr:
    a, b = r[T_HID], r[T_TID]; ta, tb = et.get(a), et.get(b)
    if ta == "故障现象" and tb == "故障原因": hc.add((a, b))
    if ta == "故障原因" and tb == "故障现象": ch.add((b, a))
    if ta == "故障原因" and tb == "维修步骤": cm.add((a, b))
hc_all = hc | ch
reasons = set(a for a, b in hc_all)
reasons_cm = set(a for a, b in cm)
reasons_total = types.get("故障原因", 0)

parent = {i: i for i in id_set}
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
for r in tr:
    if r[T_HID] in parent and r[T_TID] in parent:
        ra, rb = find(r[T_HID]), find(r[T_TID])
        if ra != rb: parent[ra] = rb
comp = collections.Counter(find(i) for i in id_set)

attr_nonempty = sum(1 for r in er if r[ei["attributes"]].strip())
desc_empty = sum(1 for r in er if not r[ei["entity_desc"]].strip())
e_anchored = sum(1 for r in er if r[ei["chunk_ids"]].strip())
# 🔴 改为按列名取证据列（原实现写死 r[12]，新 CSV 只有 6 列会恒判 0）
t_anchored = sum(1 for r in tr if len(r) > T_CID and r[T_CID].strip())
maxname = max((len(n) for n in names), default=0)
longnames = sum(1 for n in names if len(n) > 40)
seen = set(); dupT = 0
for r in tr:
    k = (r[T_HID], r[T_PRED], r[T_TID])
    if k in seen: dupT += 1
    seen.add(k)
chap = collections.Counter()
# 🔴 2026-10-17：entities 已无 chapter 列（上游来源章节名属版权痕迹，已删）。
#    仍在此统计"章节粒度"会把所有实体都落进"空/其他"，变成一张无意义的卡 ——
#    改为：有 chapter 列才统计，否则显式标注"不适用"，不静默产出误导性数字。
if "chapter" in ei:
    for r in er:
        c = r[ei["chapter"]]
        if "第" in c and "节" in c: chap["章+节"] += 1
        elif "第" in c and "章" in c: chap["仅章"] += 1
        else: chap["空/其他"] += 1
else:
    chap["（不适用：entities 无 chapter 列）"] = len(er)

def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0

card = {
    "规模": {"实体": len(er), "三元组": len(tr), "关系类型": len(rel), "实体类型数": len(types)},
    "连通性": {"孤立实体": len(orphans), "孤立率%": pct(len(orphans), len(id_set)),
             "最大连通分量": max(comp.values()) if comp else 0,
             "最大分量占比%": pct(max(comp.values()) if comp else 0, len(id_set)),
             "连通分量数": len(comp)},
    "关系规范": {"schema合规率%": pct(ok, len(tr)),
              "对应条数": len(corr), "对应占比%": pct(len(corr), len(tr)),
              "对应方向合规": corr_ok},
    "诊断链": {"现象↔原因对": len(hc_all), "原因→措施对": len(cm),
             "原因总数": reasons_total, "能到措施的原因": len(reasons_cm),
             "原因到措施覆盖率%": pct(len(reasons_cm), reasons_total)},
    "身份": {"唯一名": len(set(names)), "重名组": len(dup_groups), "重名覆盖行": sum(dup_groups.values())},
    "特征与内容": {"attributes非空": attr_nonempty, "attributes覆盖%": pct(attr_nonempty, len(er)),
               "空描述": desc_empty, "空描述率%": pct(desc_empty, len(er)),
               "实体证据锚定%": pct(e_anchored, len(er)), "三元组证据锚定%": pct(t_anchored, len(tr))},
    "整洁度": {"最长实体名": maxname, "超40字实体名": longnames, "重复三元组": dupT,
             "章节粒度": dict(chap)},
    "类型分布": dict(types),
    "关系合规明细": {rel.get(k, k): {"条数": per[k], "合规": perok[k], "合规率%": pct(perok[k], per[k])} for k in per},
}

json.dump(card, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

L = []
L.append("# 知识图谱体检分数卡")
L.append("")
L.append("> 只读产出；数据未改动。生成：" + __import__("time").strftime("%Y-%m-%d %H:%M:%S"))
L.append("")
for sec, d in card.items():
    L.append("## " + sec)
    L.append("")
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, dict):
                L.append("- " + str(k) + "：" + json.dumps(v, ensure_ascii=False))
            else:
                L.append("- " + str(k) + "：" + str(v))
    L.append("")
open(OUT_MD, "w", encoding="utf-8").write(NL.join(L))
print("written:", OUT_MD)
print("written:", OUT_JSON)
