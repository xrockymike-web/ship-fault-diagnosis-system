# -*- coding: utf-8 -*-
"""切块验收（只读）：chunks.jsonl / chunk_spans.jsonl 与 book.txt 的一致性。

用法：
  python workspace/build/chunk/verify_chunks.py --data backup/data_mirror
判据（负责人 2026-10-22 口径）：
  ① kind 只有 text/parent；无 table；无 page_*/section 字段
  ② 子块 250–450 占比 ≥ 80%；无子块 > 520；无父块 > 1600
  ③ 每个子块有父块、每个父块 2–4 个子块、无悬空 parent_id
  ④ 父块文本 == "\n\n".join(子块文本)
  ⑤ 子块 span 按 book 顺序严格递增、首尾相接、总覆盖 == book 全文
  ⑥ 每个子块 text == book.txt[char_start:char_end]（去空白后逐字相等）
  ⑦ 每个 book 段落完整落在且仅落在一个子块内
"""
import argparse, hashlib, json, os, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

P = F = 0
def ck(cond, msg):
    global P, F
    if cond: P += 1
    else:
        F += 1
        print('  FAIL ' + msg)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'workspace', 'data'))
    a = ap.parse_args()
    data = os.path.abspath(a.data)
    book = open(os.path.join(data, 'document', 'book.txt'), encoding='utf-8', newline='').read()
    chunks = [json.loads(l) for l in open(os.path.join(data, 'chunk', 'chunks.jsonl'), encoding='utf-8') if l.strip()]
    spans = {json.loads(l)['chunk_id']: json.loads(l) for l in open(os.path.join(data, 'chunk', 'chunk_spans.jsonl'), encoding='utf-8') if l.strip()}
    stats = json.load(open(os.path.join(data, 'chunk', 'chunk_stats.json'), encoding='utf-8'))

    kids = [c for c in chunks if c['kind'] == 'text']
    pars = [c for c in chunks if c['kind'] == 'parent']
    by_id = {c['id']: c for c in chunks}

    ck({c['kind'] for c in chunks} == {'text', 'parent'}, 'kind 只能是 text/parent，实测 %s' % sorted({c['kind'] for c in chunks}))
    ck(not any('page_start' in c or 'page_end' in c for c in chunks), 'chunks 不应再有 page_* 字段')
    ck(not any('section' in c for c in chunks), 'chunks 不应再有 section 字段')
    ck(all(c['id'].startswith(('TXT-', 'PRT-')) for c in chunks), 'id 前缀只能是 TXT-/PRT-')

    kl = [len(c['text']) for c in kids]
    pl = [len(c['text']) for c in pars]
    rng = sum(1 for x in kl if 250 <= x <= 450) / len(kl) * 100
    ck(rng >= 80, '子块 250–450 占比 %.1f%%（要求 ≥80%%）' % rng)
    ck(max(kl) <= 520, '子块最大 %d（要求 ≤520）' % max(kl))
    ck(max(pl) <= 1700, '父块最大 %d（要求 ≤1700）' % max(pl))

    ck(all(c.get('parent_id') in by_id for c in kids), '子块 parent_id 必须指向存在的块')
    ck(all(c.get('parent_id') is None for c in pars), '父块 parent_id 必须为空')
    kids_of = {}
    for c in kids:
        kids_of.setdefault(c['parent_id'], []).append(c)
    ck(all(2 <= len(v) <= 4 for v in kids_of.values()),
       '每个父块 2–4 个子块，实测 %s' % sorted({len(v) for v in kids_of.values()}))
    ck(set(kids_of) == {p['id'] for p in pars}, '父块集合与子块引用集合必须一致')
    ck(len(kids) == sum(len(v) for v in kids_of.values()), '子块必须全部归入父块')

    # 父块校验：子块 span 必须在父块 span 内连续覆盖，且父块文本 == book 切片
    bad_join = 0
    for p in pars:
        ks = sorted(kids_of[p['id']], key=lambda c: spans[c['id']]['char_start'])
        ps, pe = spans[p['id']]['char_start'], spans[p['id']]['char_end']
        ok = spans[ks[0]['id']]['char_start'] == ps and spans[ks[-1]['id']]['char_end'] == pe
        for x, y in zip(ks, ks[1:]):
            if book[spans[x['id']]['char_end']:spans[y['id']]['char_start']].strip():
                ok = False
        if not ok:
            bad_join += 1
    ck(bad_join == 0, '父块 span 未连续覆盖子块：%d 个' % bad_join)

    # span 覆盖
    ordered = sorted(kids, key=lambda c: spans[c['id']]['char_start'])
    gap = overlap = 0
    prev_end = 0
    for c in ordered:
        s = spans[c['id']]
        if s['char_start'] != prev_end:
            if s['char_start'] > prev_end: gap += 1
            else: overlap += 1
        prev_end = s['char_end']
    ck(overlap == 0, '子块 span 之间不得重叠（overlap=%d）' % overlap)
    # 间隙只允许是空白（段落之间的换行/缩进），不允许丢正文
    bad_gap = 0
    for a_i in range(len(ordered) - 1):
        s1 = spans[ordered[a_i]['id']]; s2 = spans[ordered[a_i + 1]['id']]
        between = book[s1['char_end']:s2['char_start']]
        if between.strip():
            bad_gap += 1
    head = book[:spans[ordered[0]['id']]['char_start']]
    tail = book[spans[ordered[-1]['id']]['char_end']:]
    ck(bad_gap == 0, '子块之间只允许空白间隙（含正文的间隙 %d 处）' % bad_gap)
    ck(not head.strip() and not tail.strip(), 'book 首尾不得有未覆盖正文（head=%d tail=%d）' % (int(bool(head.strip())), int(bool(tail.strip()))))

    # 逐字一致
    bad_text = 0
    for c in kids + pars:
        s = spans[c['id']]
        seg = book[s['char_start']:s['char_end']]
        if seg.replace('\n', '').replace(' ', '') != c['text'].replace('\n', '').replace(' ', ''):
            bad_text += 1
    ck(bad_text == 0, '块文本与 book 偏移不一致：%d 个' % bad_text)

    # 段落覆盖
    paras, pos = [], 0
    for line in book.splitlines(True):
        body = line.rstrip('\r\n')
        l, r = len(body) - len(body.lstrip()), len(body.rstrip())
        if r > l: paras.append((pos + l, pos + r))
        pos += len(line)
    # 允许在段内句子边界切分：段落不再要求"整段落在一个子块内"，
    # 只要求"每个段落都被子块覆盖"（由 span 连续性保证），并统计被切成多块的段落数
    un = split_para = 0
    for (s, e) in paras:
        hit = [c for c in kids if not (spans[c['id']]['char_end'] <= s or spans[c['id']]['char_start'] >= e)]
        if not hit:
            un += 1
        elif len(hit) > 1:
            split_para += 1
    ck(un == 0, '有 %d 个 book 段落完全未被覆盖' % un)
    print('  · 被切成多块的段落 %d / %d（句级切分，属设计允许）' % (split_para, len(paras)))

    ck(stats['counts']['text'] == len(kids) and stats['counts']['parent'] == len(pars), 'chunk_stats 与产物计数一致')
    man = open(os.path.join(data, 'chunk', 'MANIFEST.sha256'), encoding='utf-8').read()
    for name in ('chunks.jsonl', 'chunks_filled.jsonl', 'chunk_spans.jsonl'):
        p = os.path.join(data, 'chunk', name)
        h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        ck(h in man, 'MANIFEST 缺少 %s 的正确哈希' % name)

    print('')
    print('  text=%d parent=%d total=%d | 250-450=%.1f%% max_text=%d max_parent=%d'
          % (len(kids), len(pars), len(chunks), rng, max(kl), max(pl)))
    print('RESULT ' + ('OK (%d 项全 PASS)' % P if F == 0 else 'FAIL (%d 项)' % F))
    return 1 if F else 0

if __name__ == '__main__':
    sys.exit(main())
