# -*- coding: utf-8 -*-
"""切块第 2 步：LLM 逐点判"此处该不该分段"（100% 覆盖，缓存到 data/chunk/decisions）

用法：
  python workspace/build/chunk/llm_boundaries.py --data <data dir> \
      --key-file .env --base https://dashscope.aliyuncs.com/compatible-mode/v1 \
      --model qwen3.8-flash --batch 20 --workers 4
"""
import argparse, hashlib, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

PROMPT = '''你是中文技术文档的"分段判断器"。下面给出若干"候选断点"，每个断点位于【前文】最后一句与【后文】第一句之间。
请判断：这里**是否应该另起一个新段落/新主题块**。

判断标准：
- 应该断（cut 高分）：话题切换（不同设备/不同故障/不同系统）、从总述转入具体、出现新的小标题性句子、"另一类/此外/与此相对"等转折。
- 不应该断（cut 低分）：同一设备连续参数、同一故障的连续原因或步骤、枚举未结束（"包括""如下""①②③"中间）、举例与解释、因果链的下一步。

对每个断点输出 0-100 的 cut（0=绝对不该断，100=绝对该断）与 reason 代码：
topic_shift / new_heading / enumeration / example / same_topic / continuation / contrast / summary

只输出 JSON，不要任何解释：{"results":[{"i":断点号,"c":整数,"r":"代码"}]}
c 是 0-100 的整数，r 是上面列出的一个代码（英文小写，不要写别的字）。'''

REASONS = {'topic_shift', 'new_heading', 'enumeration', 'example', 'same_topic', 'continuation', 'contrast', 'summary'}


def post(base, key, model, body, timeout=120):
    req = urllib.request.Request(base.rstrip('/') + '/chat/completions',
                                 data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--key-file', required=True)
    ap.add_argument('--base', required=True)
    ap.add_argument('--model', default='qwen3.8-flash')
    ap.add_argument('--batch', type=int, default=20)
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    data = os.path.abspath(a.data)
    key = open(a.key_file, encoding='utf-8').read().splitlines()[0].strip()

    sents = [json.loads(l) for l in open(os.path.join(data, 'chunk', 'sem', 'sentence_index.jsonl'), encoding='utf-8') if l.strip()]
    bounds = [json.loads(l) for l in open(os.path.join(data, 'chunk', 'sem', 'boundary_scores.jsonl'), encoding='utf-8') if l.strip()]
    prompt_sha = hashlib.sha256(PROMPT.encode('utf-8')).hexdigest()[:12]
    outdir = os.path.join(data, 'chunk', 'decisions')
    os.makedirs(outdir, exist_ok=True)
    cache = os.path.join(outdir, 'boundary_llm_%s_%s.jsonl' % (a.model, prompt_sha))

    done = {}
    if os.path.exists(cache):
        for l in open(cache, encoding='utf-8'):
            if l.strip():
                o = json.loads(l)
                done[o['i']] = o
    todo = [b['i'] for b in bounds if b['i'] not in done]
    if a.limit:
        todo = todo[:a.limit]
    print('边界 %d ｜ 已缓存 %d ｜ 本轮 %d' % (len(bounds), len(done), len(todo)), flush=True)

    def ctx(i):
        pre = ''.join(sents[k]['text'] for k in range(max(0, i - 2), i + 1))
        post_ = ''.join(sents[k]['text'] for k in range(i + 1, min(len(sents), i + 3)))
        return pre, post_

    batches = [todo[k:k + a.batch] for k in range(0, len(todo), a.batch)]

    def run(batch):
        lines = []
        for i in batch:
            pre, post_ = ctx(i)
            lines.append('#%d\n前文：%s\n后文：%s' % (i, pre, post_))
        # 🔴 关掉思考：qwen3.8-flash 默认会先输出大段 reasoning，判决场景纯属浪费
        body = {'model': a.model, 'temperature': 0, 'enable_thinking': False,
                'messages': [{'role': 'system', 'content': PROMPT},
                             {'role': 'user', 'content': '\n\n'.join(lines)}],
                'response_format': {'type': 'json_object'}, 'max_tokens': 700}
        last = None
        for attempt in range(6):
            try:
                payload = post(a.base, key, a.model, body)
                obj = json.loads(payload['choices'][0]['message'].get('content') or '{}')
                res = obj.get('results') or []
                out = []
                for r in res:
                    i = int(r.get('i'))
                    cut = int(max(0, min(100, int(r.get('c', r.get('cut', 50))))))
                    reason = str(r.get('r') or r.get('reason') or '').strip()
                    if reason not in REASONS:
                        reason = 'unknown'
                    out.append({'i': i, 'cut': cut, 'reason': reason,
                                'model': a.model, 'prompt_sha': prompt_sha})
                return out
            except Exception as exc:
                last = exc
                time.sleep(min(30, 2 ** (attempt + 1)))
        # 仍然失败：二分重试（限流时小批更容易过）
        if len(batch) > 1:
            mid = len(batch) // 2
            return run(batch[:mid]) + run(batch[mid:])
        print('  !! 单点失败 i=%s: %s' % (batch[0], last), flush=True)
        return [{'error': str(last), 'i': batch[0]}]

    t0 = time.time()
    written = 0
    with open(cache, 'a', encoding='utf-8', newline='\n') as f, ThreadPoolExecutor(max_workers=a.workers) as pool:
        futs = {pool.submit(run, b): b for b in batches}
        for n, fut in enumerate(as_completed(futs), 1):
            rows = fut.result()
            for row in rows:
                if 'error' in row:
                    continue
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
                written += 1
            f.flush()
            if n % 20 == 0:
                print('  %d/%d 批 ｜ 写入 %d ｜ %.0fs' % (n, len(batches), written, time.time() - t0), flush=True)

    have = set()
    for l in open(cache, encoding='utf-8'):
        if l.strip():
            have.add(json.loads(l)['i'])
    missing = [b['i'] for b in bounds if b['i'] not in have]
    print(json.dumps({'cache': cache, 'covered': len(have), 'missing': len(missing),
                      'elapsed_s': round(time.time() - t0, 1)}, ensure_ascii=False))
    if missing:
        print('MISSING 前 10:', missing[:10])
        sys.exit(2)


if __name__ == '__main__':
    main()
