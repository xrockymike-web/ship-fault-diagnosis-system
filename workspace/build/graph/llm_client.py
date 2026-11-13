# -*- coding: utf-8 -*-
"""LLM 客户端（DashScope 兼容模式，纯标准库）+ 结果缓存。

三条纪律（沿用 build/chunk/llm_boundaries.py 的教训）：
  ① 温度 0、`response_format=json_object`，输出必须是 JSON；
  ② **缓存键 = model + prompt_sha + input_sha**，命中即复用 —— 重跑零成本、结果可复现；
     改了 prompt 就会算出一个新缓存文件（旧缓存不删，可回溯）；
  ③ 限流/5xx 只做**单点重试 + 指数退避**，绝不整轮重跑。

密钥不写进仓库：优先 `--api-key-file`，其次环境变量 `DASHSCOPE_API_KEY`。
"""
import hashlib
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
DEFAULT_MODEL = 'qwen3.8-flash'          # 与判决缓存同一模型（见 build/chunk/decisions/）


def sha16(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]


def load_key(api_key_file=None, env='DASHSCOPE_API_KEY'):
    """取密钥：显式文件 → 环境变量。都没有就**明确报错**，不静默用空串。"""
    if api_key_file:
        with open(api_key_file, encoding='utf-8') as f:
            k = f.read().strip().splitlines()[0].strip()
        if not k:
            raise SystemExit('密钥文件是空的：%s' % api_key_file)
        return k
    k = os.environ.get(env, '').strip()
    if not k:
        raise SystemExit('缺 API 密钥：用 --api-key-file <文件> 或设置环境变量 %s' % env)
    return k


def extract_json(text):
    """从回复里取第一个 JSON 对象（容忍代码围栏、前后解释文字）。取不到就抛错，不猜。"""
    s = text.strip()
    if s.startswith('```'):
        s = s.split('```')[1] if s.count('```') >= 2 else s.strip('`')
        if s.lstrip().lower().startswith('json'):
            s = s.lstrip()[4:]
    i, j = s.find('{'), s.rfind('}')
    if i < 0 or j <= i:
        raise ValueError('回复里没有 JSON 对象：%s' % text[:200])
    return json.loads(s[i:j + 1])


class Client:
    def __init__(self, model=DEFAULT_MODEL, base_url=DEFAULT_BASE, api_key=None,
                 cache_dir=None, prompt_salt='v1', timeout=120, retries=4, verbose=True):
        self.model = model
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries
        self.verbose = verbose
        self.prompt_salt = prompt_salt
        self.usage = {'calls': 0, 'cached': 0, 'prompt_tokens': 0, 'completion_tokens': 0}
        self._lock = threading.Lock()
        self._cache = {}
        self._cache_path = None
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
            self._cache_path = os.path.join(cache_dir, 'llm_%s_%s.jsonl' % (model, sha16(prompt_salt)))
            if os.path.exists(self._cache_path):
                with open(self._cache_path, encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            o = json.loads(line)
                            self._cache[o['k']] = o['raw']

    # -------------------------------------------------- 缓存
    def cached(self, system, user):
        k = sha16(system + '\x00' + user)
        return k, self._cache.get(k)

    def _put(self, k, raw):
        self._cache[k] = raw
        if self._cache_path:
            with self._lock, open(self._cache_path, 'a', encoding='utf-8', newline='\n') as f:
                f.write(json.dumps({'k': k, 'raw': raw}, ensure_ascii=False) + '\n')

    # -------------------------------------------------- HTTP
    def _post(self, system, user, temperature=0):
        body = {
            'model': self.model,
            'messages': [{'role': 'system', 'content': system},
                         {'role': 'user', 'content': user}],
            'temperature': temperature,
            'response_format': {'type': 'json_object'},
        }
        req = urllib.request.Request(
            self.base_url + '/chat/completions',
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json',
                     'Authorization': 'Bearer ' + (self.api_key or '')},
            method='POST')
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        if 'choices' not in data:
            raise RuntimeError('回复里没有 choices：%s' % json.dumps(data, ensure_ascii=False)[:300])
        u = data.get('usage') or {}
        with self._lock:
            self.usage['prompt_tokens'] += int(u.get('prompt_tokens') or 0)
            self.usage['completion_tokens'] += int(u.get('completion_tokens') or 0)
        return data['choices'][0]['message']['content']

    def chat(self, system, user, temperature=0):
        """一次对话（带缓存 + 重试）。返回原始文本。"""
        k, hit = self.cached(system, user)
        if hit is not None:
            self.usage['cached'] += 1
            return hit
        last = None
        for attempt in range(self.retries + 1):
            try:
                raw = self._post(system, user, temperature)
                self.usage['calls'] += 1
                self._put(k, raw)
                return raw
            except urllib.error.HTTPError as e:
                last = e
                if e.code not in (429, 500, 502, 503, 504):
                    raise
            except Exception as e:                      # 网络抖动 / 超时
                last = e
            if attempt == self.retries:
                break
            time.sleep(min(30, (2 ** attempt) + random.uniform(0, 0.5)))
        raise RuntimeError('调用失败（已重试 %d 次）：%s' % (self.retries, last))

    def json_chat(self, system, user):
        return extract_json(self.chat(system, user))

    # -------------------------------------------------- 并发
    def map(self, fn, items, concurrency=4):
        """并发跑 fn(item)，结果按输入顺序返回；单个失败会抛出（不静默丢）。"""
        if concurrency <= 1 or len(items) <= 1:
            return [fn(x) for x in items]
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            return list(ex.map(fn, items))

    def report(self):
        u = self.usage
        return ('模型调用 %d 次（缓存命中 %d）｜prompt %d tok / completion %d tok'
                % (u['calls'], u['cached'], u['prompt_tokens'], u['completion_tokens']))


class StubClient(Client):
    """--dry-run 专用：不发网络请求，返回预先写好的回复。

    用途：让审稿人/接手人在**没有密钥、不花钱**的情况下把「提示词 → 解析 → 校验 → 落盘」
    整条链路跑一遍，确认代码能跑、输出格式对。
    """

    def __init__(self, responses, **kw):
        self.responses = list(responses)
        self.i = 0
        self.usage = {'calls': 0, 'cached': 0, 'prompt_tokens': 0, 'completion_tokens': 0}
        self.model = 'dry-run'
        self.prompt_salt = 'dry-run'

    def chat(self, system, user, temperature=0):
        r = self.responses[self.i % len(self.responses)]
        self.i += 1
        self.usage['calls'] += 1
        return r
