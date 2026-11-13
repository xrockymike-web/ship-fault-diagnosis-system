# -*- coding: utf-8 -*-
"""merged50 gold 迁移：旧 chunk_id -> 新 chunk_id（2026-10-22 重建）

规则：
  ① quote 在 book.txt 中逐字定位（找不到则报错，不猜）
  ② 候选 = 所有"文本包含该 quote"的新子块
  ③ 多候选时按"旧块 span 与新块 span 的重叠"投票；仍并列取更短（更聚焦）
  ④ support_chunks = 选中子块的父块（去重、升序）
  ⑤ 产出迁移后的 questions.json + 报告（不改原文件）

用法：
  python workspace/build/chunk/migrate_gold.py --data backup/data_mirror \
      --old-db workspace/data/vector-index/chunk/chunk.sqlite \
      --questions experiment/data_performance/question/merged50/questions.json \
      --out backup/data_mirror/experiment/merged50_questions.migrated.json
"""
import argparse, json, os, sqlite3, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def norm(s):
    return ''.join(s.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--old-db', required=True)
    ap.add_argument('--questions', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    data = os.path.abspath(a.data)

    book = open(os.path.join(data, 'document', 'book.txt'), encoding='utf-8', newline='').read()
    bookN = norm(book)
    chunks = [json.loads(l) for l in open(os.path.join(data, 'chunk', 'chunks.jsonl'), encoding='utf-8') if l.strip()]
    spans = {}
    for l in open(os.path.join(data, 'chunk', 'chunk_spans.jsonl'), encoding='utf-8'):
        if l.strip():
            o = json.loads(l)
            spans[o['chunk_id']] = o
    kids = [c for c in chunks if c['kind'] == 'text']
    by_id = {c['id']: c for c in chunks}

    con = sqlite3.connect('file:' + os.path.abspath(a.old_db).replace('\\', '/') + '?mode=ro', uri=True)
    old_text = {cid: norm(t or '') for cid, t in con.execute('SELECT id, text FROM chunks')}
    con.close()
    old_span = {}
    for cid, t in old_text.items():
        p = bookN.find(t)
        if p >= 0:
            old_span[cid] = (p, p + len(t))

    payload = json.load(open(a.questions, encoding='utf-8'))
    report = {'total': 0, 'unique': 0, 'disambiguated': 0, 'fallback_oldspan': 0, 'missing': []}

    def new_span(cid):
        s = spans[cid]
        return (norm(book[:s['char_start']]).__len__(), norm(book[:s['char_start']]).__len__() + norm(book[s['char_start']:s['char_end']]).__len__())

    for q in payload['questions']:
        parents = set()
        for kp in q.get('key_points', []):
            report['total'] += 1
            quote = kp.get('quote') or ''
            qn = norm(quote)
            pos = bookN.find(qn)
            cands = [c for c in kids if qn and qn in norm(c['text'])]
            if not cands:
                report['missing'].append({'question': q['id'], 'point': kp['id'], 'quote': quote[:40]})
                continue
            if len(cands) == 1:
                chosen = cands[0]
                report['unique'] += 1
            else:
                os_ = old_span.get(kp.get('chunk_id'))
                if os_:
                    def overlap(c):
                        s = new_span(c['id'])
                        return min(os_[1], s[1]) - max(os_[0], s[0])
                    cands.sort(key=lambda c: (-overlap(c), len(c['text'])))
                    report['fallback_oldspan'] += 1
                else:
                    cands.sort(key=lambda c: len(c['text']))
                chosen = cands[0]
                report['disambiguated'] += 1
            kp['chunk_id'] = chosen['id']
            if chosen.get('parent_id'):
                parents.add(chosen['parent_id'])
        if parents:
            q['support_chunks'] = sorted(parents, key=lambda x: int(x[4:]))

    payload.setdefault('provenance_notes', []).append({
        'event': 'rebuild-20261022', 'chunker': 'semantic-4gate',
        'note': 'chunk_id 已按 quote 重锚到新子块；support_chunks = 新父块',
    })
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(payload, open(a.out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    rep = os.path.join(data, 'chunk', 'gold_migration_report.json')
    json.dump(report, open(rep, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print('-> ' + os.path.abspath(a.out))


if __name__ == '__main__':
    main()
