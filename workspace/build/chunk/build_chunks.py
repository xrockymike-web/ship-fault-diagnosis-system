# -*- coding: utf-8 -*-
"""切块器：语义分 + LLM 判决 → DP 最优切分 → 固定 N 个连续子块成父块

目标函数：
    max Σ [α·语义分 + β·LLM分 + γ·段落先验] − λ·长度惩罚
字数只作硬约束（250–520，软偏好 300–450），**切点由语义与 LLM 决定**。
父块默认 4 个连续子块（`--per-parent` 可改）。

输入（<data>/chunk/）：
  sem/sentence_index.jsonl, sem/boundary_scores.jsonl
  decisions/boundary_llm_<model>_<prompt_sha>.jsonl
输出：
  chunk/chunks.jsonl, chunks_filled.jsonl, chunk_spans.jsonl,
  chunk/segments.jsonl, chunk/chunk_stats.json, chunk/MANIFEST.sha256
"""
import argparse, glob, hashlib, json, os, sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

CHILD_MIN, CHILD_MAX, CHILD_HARD = 250, 450, 520
CHILD_FLOOR = 120
PER_PARENT = 4   # 父块 = 4 个连续子块（3 条证据的上下文约 3.8k 字）
ALPHA, BETA, GAMMA, LAM = 0.6, 1.2, 0.15, 0.9
DOC_ID, CHAPTER = 'CORPUS-0001', '语料'


def pen(length, hard=True):
    if length > CHILD_HARD:
        return float('inf')
    if CHILD_MIN <= length <= CHILD_MAX:
        return 0.0
    d = (CHILD_MIN - length) if length < CHILD_MIN else (length - CHILD_MAX)
    return (d / 100.0) ** 2


def main():
    global ALPHA, BETA, GAMMA, LAM, PER_PARENT
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--model', default='qwen3.8-flash')
    ap.add_argument('--alpha', type=float, default=ALPHA)
    ap.add_argument('--beta', type=float, default=BETA)
    ap.add_argument('--gamma', type=float, default=GAMMA)
    ap.add_argument('--lam', type=float, default=LAM)
    ap.add_argument('--per-parent', type=int, default=PER_PARENT)
    a = ap.parse_args()
    ALPHA, BETA, GAMMA, LAM = a.alpha, a.beta, a.gamma, a.lam
    PER_PARENT = max(2, a.per_parent)
    data = os.path.abspath(a.data)
    book = open(os.path.join(data, 'document', 'book.txt'), encoding='utf-8', newline='').read()
    sents = [json.loads(l) for l in open(os.path.join(data, 'chunk', 'sem', 'sentence_index.jsonl'), encoding='utf-8') if l.strip()]
    bounds = {json.loads(l)['i']: json.loads(l) for l in open(os.path.join(data, 'chunk', 'sem', 'boundary_scores.jsonl'), encoding='utf-8') if l.strip()}
    caches = sorted(glob.glob(os.path.join(data, 'chunk', 'decisions', 'boundary_llm_%s_*.jsonl' % a.model)))
    if not caches:
        raise SystemExit('缺 LLM 判决缓存：%s/chunk/decisions/boundary_llm_%s_*.jsonl' % (data, a.model))
    llm = {}
    for c in caches:
        for l in open(c, encoding='utf-8'):
            if l.strip():
                o = json.loads(l)
                llm[o['i']] = o
    missing = [i for i in bounds if i not in llm]
    if missing:
        raise SystemExit('LLM 判决缺失 %d 个边界（例：%s）——strict 模式拒绝继续' % (len(missing), missing[:5]))

    meta = json.load(open(os.path.join(data, 'chunk', 'sem', 'meta.json'), encoding='utf-8'))
    mu, sd = meta['cos_mean'], meta['cos_sd']

    def boundary_score(i):
        b = bounds[i]
        sem = (mu - b['cos']) / (sd or 1e-9)          # 越不相似分越高
        cut = llm[i]['cut'] / 100.0
        para_prior = GAMMA if (sents[i + 1]['para'] != sents[i]['para']) else 0.0
        return ALPHA * sem + BETA * cut + para_prior, sem, cut, para_prior

    n = len(sents)
    NEG = float('-inf')
    dp = [NEG] * (n + 1)
    back = [-1] * (n + 1)
    dp[0] = 0.0
    for i in range(n):
        if dp[i] == NEG:
            continue
        for j in range(i + 1, min(n, i + 12) + 1):
            cs, ce = sents[i]['char_start'], sents[j - 1]['char_end']
            L = ce - cs
            if L > CHILD_HARD:
                break
            if (j - i) >= 2 and L < CHILD_FLOOR:
                continue
            gain = -LAM * pen(L)
            if i > 0:
                gain += boundary_score(i - 1)[0]
            v = dp[i] + gain
            if v > dp[j]:
                dp[j] = v
                back[j] = i
    if dp[n] == NEG:
        raise SystemExit('DP 无解：检查长度约束')
    cuts = []
    j = n
    while j > 0:
        i = back[j]
        cuts.append((i, j))
        j = i
    cuts.reverse()

    children = []
    attr = {'llm': 0, 'sem': 0, 'weak': 0}
    for idx, (i, j) in enumerate(cuts):
        cs, ce = sents[i]['char_start'], sents[j - 1]['char_end']
        rec = {'id': 'TXT-%04d' % (idx + 1), 'char_start': cs, 'char_end': ce,
               'para_start': sents[i]['para'], 'para_end': sents[j - 1]['para'],
               'text': book[cs:ce], 'sent_from': i, 'sent_to': j, 'cut_at_i': i}
        if i > 0:
            _, sem, cut, _ = boundary_score(i - 1)
            kind = 'llm' if cut >= 0.6 else ('sem' if sem >= 1.0 else 'weak')
            attr[kind] += 1
            rec['boundary'] = {'i': i - 1, 'sem': round(sem, 3), 'llm_cut': int(cut * 100), 'by': kind}
        children.append(rec)

    parents, k = [], 0
    while k < len(children):
        remain = len(children) - k
        take = PER_PARENT if remain >= PER_PARENT else remain
        if remain < 2 and parents:
            # 尾部不足 2 个：与最后一个父块合并后对半拆，保证每个父块 2–PER_PARENT 个子块
            last = parents.pop()
            tail = last['kids'] + children[k:k + remain]
            half = (len(tail) + 1) // 2
            parents.append({'ids': [c['id'] for c in tail[:half]], 'kids': tail[:half]})
            parents.append({'ids': [c['id'] for c in tail[half:]], 'kids': tail[half:]})
            k += remain
            continue
        parents.append({'ids': [children[k + t]['id'] for t in range(take)],
                        'kids': children[k:k + take]})
        k += take
    for idx, p in enumerate(parents):
        p['id'] = 'PRT-%04d' % (idx + 1)
        p['char_start'] = p['kids'][0]['char_start']
        p['char_end'] = p['kids'][-1]['char_end']
        p['para_start'] = p['kids'][0]['para_start']
        p['para_end'] = p['kids'][-1]['para_end']
        p['text'] = book[p['char_start']:p['char_end']]

    out = os.path.join(data, 'chunk')
    f1 = open(os.path.join(out, 'chunks.jsonl'), 'w', encoding='utf-8', newline='\n')
    f2 = open(os.path.join(out, 'chunks_filled.jsonl'), 'w', encoding='utf-8', newline='\n')
    f3 = open(os.path.join(out, 'chunk_spans.jsonl'), 'w', encoding='utf-8', newline='\n')
    rows = []
    for p in parents:
        rows.append({'id': p['id'], 'kind': 'parent', 'parent_id': None, 'text': p['text'],
                     'cs': p['char_start'], 'ce': p['char_end'], 'ps': p['para_start'], 'pe': p['para_end']})
    for c in children:
        parent = next(p['id'] for p in parents if c['id'] in p['ids'])
        rows.append({'id': c['id'], 'kind': 'text', 'parent_id': parent, 'text': c['text'],
                     'cs': c['char_start'], 'ce': c['char_end'], 'ps': c['para_start'], 'pe': c['para_end']})
    rows.sort(key=lambda r: r['id'])
    for r in rows:
        base = {'id': r['id'], 'doc_id': DOC_ID, 'chapter': CHAPTER, 'parent_id': r['parent_id'],
                'kind': r['kind'], 'text': r['text']}
        f1.write(json.dumps(base, ensure_ascii=False) + '\n')
        f2.write(json.dumps({**base, 'text_seg': r['text']}, ensure_ascii=False) + '\n')
        f3.write(json.dumps({'chunk_id': r['id'], 'char_start': r['cs'], 'char_end': r['ce'],
                             'para_start': r['ps'], 'para_end': r['pe'], 'chars': len(r['text'])},
                            ensure_ascii=False) + '\n')
    for f in (f1, f2, f3):
        f.close()
    with open(os.path.join(out, 'segments.jsonl'), 'w', encoding='utf-8', newline='\n') as f:
        for s in sents:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    kl = [len(c['text']) for c in children]
    pl = [len(p['text']) for p in parents]
    def dist(v):
        v = sorted(v); q = lambda p: v[min(len(v) - 1, int(p * (len(v) - 1)))]
        return {'n': len(v), 'min': v[0], 'p10': q(.1), 'median': q(.5), 'p90': q(.9), 'max': v[-1]}
    stats = {'generator': 'workspace/build/chunk/build_chunks.py', 'version': 'semantic-4gate',
             'book': {'sha256': hashlib.sha256(book.encode('utf-8')).hexdigest(),
                      'chars': len(book), 'sentences': len(sents)},
             'params': {'alpha_sem': ALPHA, 'beta_llm': BETA, 'gamma_para': GAMMA, 'lambda_len': LAM,
                        'per_parent': PER_PARENT, 'child_min': CHILD_MIN, 'child_max': CHILD_MAX,
                        'child_hard': CHILD_HARD, 'child_floor': CHILD_FLOOR},
             'weights': {'alpha_sem': ALPHA, 'beta_llm': BETA, 'gamma_para': GAMMA, 'lambda_len': LAM},
             'counts': {'text': len(children), 'parent': len(parents), 'total': len(rows)},
             'length': {'text': dist(kl), 'parent': dist(pl)},
             'quality': {'text_in_range_250_450': round(sum(1 for x in kl if CHILD_MIN <= x <= CHILD_MAX) / len(kl) * 100, 1),
                         'text_over_520': sum(1 for x in kl if x > CHILD_HARD),
                         'parent_over_1600': sum(1 for x in pl if x > 1600),
                         'single_child_parents': sum(1 for p in parents if len(p['ids']) < 2)},
             'attribution': attr,
             'llm': {'model': a.model, 'cache_files': [os.path.basename(c) for c in caches], 'points': len(llm)}}
    json.dump(stats, open(os.path.join(out, 'chunk_stats.json'), 'w', encoding='utf-8', newline='\n'),
              ensure_ascii=False, indent=1)
    lines = ['# 知识库中间产物校验清单（build_chunks.py 生成；无时间戳以保证可复现）',
             '# book.sha256(归一化前) = ' + hashlib.sha256(book.encode('utf-8')).hexdigest(),
             '# 说明: 切点由 语义分 + LLM 判决 决定；字数仅作约束']
    # 可复现集合 = 输出 + 判决缓存 + 语义分（缺一不可复现；全部纳入哈希）
    names = ['chunk/chunks.jsonl', 'chunk/chunks_filled.jsonl', 'chunk/chunk_spans.jsonl',
             'chunk/segments.jsonl', 'chunk/chunk_stats.json',
             'chunk/sem/sentence_index.jsonl', 'chunk/sem/boundary_scores.jsonl', 'chunk/sem/meta.json']
    names += ['chunk/decisions/' + os.path.basename(c) for c in caches]
    for name in names:
        p = os.path.join(data, name.replace('/', os.sep))
        if not os.path.exists(p):
            lines.append('%s  %d  %d  %s' % ('MISSING', 0, 0, name))
            continue
        b = open(p, 'rb').read()
        lines.append('%s  %d  %d  %s' % (hashlib.sha256(b).hexdigest(), len(b), b.count(b'\n'), name))
    open(os.path.join(out, 'MANIFEST.sha256'), 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
