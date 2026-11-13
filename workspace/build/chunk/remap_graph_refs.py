# -*- coding: utf-8 -*-
"""图谱溯源重映射：旧块号 -> 新块号（提及锚点法）

为什么不能按"区间重叠"搬：旧块是任意切的，实体真正出现的那句话有 40% 概率落在
重叠较小的那一半，argmax 会把实体搬丢（实测基线保持率 89.5% vs 99.8%）。

规则：
  ① 在旧块文本里找实体名（去空白后）的字符位置 -> 换算成 book.txt 的绝对位置
  ② 该位置落在哪个**新子块**的 [char_start, char_end) 内，就登记哪个新块
  ③ 找不到名字（旧数据本身就没命中）或旧块无法定位 -> 回退到"新块区间重叠最大者"
  ④ 旧块是"标题堆叠"（book 里不连续）-> 拆段逐段定位后再按 ①② 处理

用法：
  python workspace/build/chunk/remap_graph_refs.py --data backup/data_mirror --old-db workspace/data/vector-index/chunk/chunk.sqlite
产物：
  <data>/graph/entities.csv / triples.csv 的 chunk_ids 列（原地改写）
  <data>/chunk/remap_report.json
"""
import argparse, bisect, csv, json, os, sqlite3, sys
from array import array

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def norm(s):
    return ''.join(s.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--old-db', required=True)
    a = ap.parse_args()
    data = os.path.abspath(a.data)

    book = open(os.path.join(data, 'document', 'book.txt'), encoding='utf-8', newline='').read()
    bookN = norm(book)
    # 原始偏移 -> 归一化偏移 的前缀表
    pref = array('i', [0]) * (len(book) + 1)
    cnt = 0
    for i, ch in enumerate(book):
        pref[i] = cnt
        if not ch.isspace():
            cnt += 1
    pref[len(book)] = cnt

    spans = {}
    for line in open(os.path.join(data, 'chunk', 'chunk_spans.jsonl'), encoding='utf-8'):
        if not line.strip():
            continue
        o = json.loads(line)
        spans[o['chunk_id']] = o
    tids = sorted([k for k in spans if k.startswith('TXT-')], key=lambda x: int(x[4:]))
    nstart = [pref[spans[t]['char_start']] for t in tids]
    nend = [pref[spans[t]['char_end']] for t in tids]

    def which(pos):
        i = bisect.bisect_right(nstart, pos) - 1
        if i >= 0 and nstart[i] <= pos < nend[i]:
            return tids[i]
        return None

    # 旧块
    con = sqlite3.connect('file:' + os.path.abspath(a.old_db).replace('\\', '/') + '?mode=ro', uri=True)
    old = {}
    for cid, kind, text in con.execute("SELECT id, kind, text FROM chunks"):
        old[cid] = norm(text or '')
    con.close()

    cache = {}

    def old_range(cid):
        if cid in cache:
            return cache[cid]
        t = old.get(cid)
        r = None
        if t:
            p = bookN.find(t)
            if p >= 0:
                r = (p, p + len(t))
        cache[cid] = r
        return r

    stats = {'unlocatable_old': [], 'fallback_refs': 0, 'anchor_refs': 0, 'unmapped_refs': 0}

    def map_one(cid, names):
        """返回新块 id 集合"""
        out = set()
        t = old.get(cid, '')
        r = old_range(cid)
        anchors = []
        if r:
            for nm in names:
                if not nm:
                    continue
                p = t.find(nm)
                while p >= 0:
                    anchors.append(r[0] + p)
                    p = t.find(nm, p + 1)
        else:
            # 标题堆叠：拆段逐段定位
            for piece in [x for x in t.split('\n\n') if x]:
                p = bookN.find(piece)
                if p < 0:
                    continue
                for nm in names:
                    if not nm:
                        continue
                    q = piece.find(nm)
                    while q >= 0:
                        anchors.append(p + q)
                        q = piece.find(nm, q + 1)
        for pos in anchors:
            w = which(pos)
            if w:
                out.add(w)
        if out:
            stats['anchor_refs'] += 1
            return out
        # 回退：区间重叠最大者
        if r:
            k = bisect.bisect_right(nend, r[0])
            best, bov = None, 0
            for i in range(max(0, k - 1), len(tids)):
                if nstart[i] >= r[1]:
                    break
                ov = min(r[1], nend[i]) - max(r[0], nstart[i])
                if ov > bov:
                    bov, best = ov, tids[i]
            if best:
                stats['fallback_refs'] += 1
                return {best}
        else:
            stats['unlocatable_old'].append(cid)
        stats['unmapped_refs'] += 1
        return set()

    def rewrite(csv_path, name_cols):
        rows = list(csv.DictReader(open(csv_path, encoding='utf-8-sig', newline='')))
        if not rows:
            raise SystemExit('空 CSV: ' + csv_path)
        # 幂等守卫：出现旧库不认识的 id，说明这份 CSV 已经被映射过（或指错了库），直接中止
        unknown = sorted({x.strip() for r in rows for x in (r.get('chunk_ids') or '').split('|')
                          if x.strip() and x.strip() not in old})
        if unknown:
            raise SystemExit('ABORT：%s 里有 %d 个块号不在旧库（例：%s）——拒绝重复映射'
                             % (os.path.basename(csv_path), len(unknown), unknown[:5]))
        cols = list(rows[0].keys())
        before = after = 0
        zero = 0
        for row in rows:
            olds = [x.strip() for x in (row.get('chunk_ids') or '').split('|') if x.strip()]
            before += len(olds)
            names = [norm(row.get(c) or '') for c in name_cols]
            news = set()
            for cid in olds:
                news |= map_one(cid, names)
            new_list = sorted(news, key=lambda x: (x[:3], int(x[4:])))
            row['chunk_ids'] = '|'.join(new_list)
            after += len(new_list)
            if not new_list:
                zero += 1
        with open(csv_path, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols, lineterminator='\n')
            w.writeheader()
            w.writerows(rows)
        return {'rows': len(rows), 'refs_before': before, 'refs_after': after, 'zero_ref_rows': zero}

    ent = rewrite(os.path.join(data, 'graph', 'entities.csv'), ['entity_name'])
    tri = rewrite(os.path.join(data, 'graph', 'triples.csv'), ['subject_id', 'object_id'])

    report = {'generator': 'workspace/build/chunk/remap_graph_refs.py',
              'method': 'mention-anchor with span-overlap fallback',
              'new_chunks': len(tids), 'old_chunks': len(old),
              'entities': ent, 'triples': tri,
              'anchor_refs': stats['anchor_refs'], 'fallback_refs': stats['fallback_refs'],
              'unmapped_refs': stats['unmapped_refs'],
              'unlocatable_old': sorted(set(stats['unlocatable_old']))}
    with open(os.path.join(data, 'chunk', 'remap_report.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
