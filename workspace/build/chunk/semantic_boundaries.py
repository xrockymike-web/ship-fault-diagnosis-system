# -*- coding: utf-8 -*-
"""切块第 1 步：句子级语义边界分（TextTiling 口径）

产物（都在 <data>/chunk/sem/ 下）：
  sentence_index.jsonl   {seg_id, para, char_start, char_end, chars, text}
  boundary_scores.jsonl  {i, cos, depth, z}   i = 边界号（第 i 句与第 i+1 句之间）

用法：
  python workspace/build/chunk/semantic_boundaries.py --data <data dir> --port 18401
"""
import argparse, json, math, os, sys, urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
SENT_END = '。；！？'


def build_sentences(book):
    out, para = [], -1
    pos = 0
    for line in book.splitlines(True):
        body = line.rstrip('\r\n')
        left = len(body) - len(body.lstrip())
        right = len(body.rstrip())
        if right <= left:
            pos += len(line)
            continue
        para += 1
        start = pos + left
        text = body[left:right]
        cur = 0
        for k, ch in enumerate(text):
            if ch in SENT_END:
                piece = text[cur:k + 1]
                if piece.strip():
                    out.append({'seg_id': len(out), 'para': para,
                                'char_start': start + cur, 'char_end': start + k + 1,
                                'chars': len(piece), 'text': piece})
                cur = k + 1
        if cur < len(text) and text[cur:].strip():
            out.append({'seg_id': len(out), 'para': para,
                        'char_start': start + cur, 'char_end': start + len(text),
                        'chars': len(text) - cur, 'text': text[cur:]})
        pos += len(line)
    return out


def embed(texts, port, batch=32):
    vecs = []
    for k in range(0, len(texts), batch):
        chunk = texts[k:k + batch]
        body = json.dumps({'input': chunk, 'encoding_format': 'float'}).encode('utf-8')
        req = urllib.request.Request('http://127.0.0.1:%d/v1/embeddings' % port, data=body,
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode('utf-8'))
        vecs.extend([d['embedding'] for d in data['data']])
        if (k // batch) % 20 == 0:
            print('  embed %d/%d' % (min(k + batch, len(texts)), len(texts)), flush=True)
    return vecs


def cos(a, b):
    s = 0.0
    for x, y in zip(a, b):
        s += x * y
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--port', type=int, default=18401)
    ap.add_argument('--window', type=int, default=2, help='左右各取多少句做块相似度')
    a = ap.parse_args()
    data = os.path.abspath(a.data)
    book = open(os.path.join(data, 'document', 'book.txt'), encoding='utf-8', newline='').read()
    sents = build_sentences(book)
    outdir = os.path.join(data, 'chunk', 'sem')
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, 'sentence_index.jsonl'), 'w', encoding='utf-8', newline='\n') as f:
        for s in sents:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')
    print('句子 %d ｜ 段落 %d' % (len(sents), sents[-1]['para'] + 1), flush=True)

    vecs = embed([s['text'] for s in sents], a.port)
    W = a.window
    def block(i, j):
        v = [0.0] * len(vecs[0])
        for k in range(i, j):
            for d, x in enumerate(vecs[k]):
                v[d] += x
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]
    sims = []
    for i in range(1, len(sents)):
        l = block(max(0, i - W), i)
        r = block(i, min(len(sents), i + W))
        sims.append(cos(l, r))
    # TextTiling 深度分
    depth = []
    for i, s in enumerate(sims):
        lmax = max(sims[max(0, i - 4):i] or [0])
        rmax = max(sims[i + 1:min(len(sims), i + 5)] or [0])
        depth.append((lmax - s) + (rmax - s))
    mu = sum(sims) / len(sims)
    sd = math.sqrt(sum((x - mu) ** 2 for x in sims) / len(sims)) or 1e-9
    with open(os.path.join(outdir, 'boundary_scores.jsonl'), 'w', encoding='utf-8', newline='\n') as f:
        for i, (c, d) in enumerate(zip(sims, depth)):
            f.write(json.dumps({'i': i, 'cos': round(c, 6), 'depth': round(d, 6),
                                'z': round((c - mu) / sd, 6)}, ensure_ascii=False) + '\n')
    meta = {'model': 'Qwen3-Embedding-0.6B-Q8_0', 'template': 'p23-v1', 'window': W,
            'sentences': len(sents), 'boundaries': len(sims),
            'cos_mean': round(mu, 6), 'cos_sd': round(sd, 6)}
    json.dump(meta, open(os.path.join(outdir, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(meta, ensure_ascii=False))
    print('-> ' + outdir)


if __name__ == '__main__':
    main()
