#!/usr/bin/env python3
"""DeepSeek 翻译客户端：并发、重试、用量记账（build/lang 专用，不影响实验代码）。"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / "workspace" / "build" / "lang" / "out"
OUT.mkdir(parents=True, exist_ok=True)

_LOCK = threading.Lock()
_USAGE = {"calls": 0, "in": 0, "out": 0, "errors": 0}


def load_env() -> dict:
    env = {}
    p = ROOT / "experiment" / ".env"
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    for k in ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"):
        if k in os.environ:
            env[k] = os.environ[k]
    return env


ENV = load_env()
BASE = (ENV.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
KEY = ENV.get("DEEPSEEK_API_KEY") or ""
MODEL = ENV.get("DEEPSEEK_MODEL") or "deepseek-flash"


def post(body: dict, timeout: int = 180, retries: int = 4) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                BASE + "/chat/completions",
                data=data,
                method="POST",
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"api failed: {last}")


def chat_json(system: str, user: str, max_tokens: int = 4096, temperature: float = 0.0) -> dict:
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
    }
    payload = post(body)
    usage = payload.get("usage") or {}
    with _LOCK:
        _USAGE["calls"] += 1
        _USAGE["in"] += int(usage.get("prompt_tokens") or 0)
        _USAGE["out"] += int(usage.get("completion_tokens") or 0)
    content = (payload["choices"][0]["message"].get("content") or "").strip()
    if not content:
        raise RuntimeError("empty content")
    return json.loads(content)


def flush_usage(tag: str) -> None:
    with _LOCK:
        rec = dict(_USAGE)
    rec["tag"] = tag
    rec["at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(OUT / "usage.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def run_batches(items: list, worker, batch_size: int, concurrency: int, label: str) -> list:
    """把 items 切片后并发执行；worker(batch) 返回结果列表。"""
    batches = [items[i:i + batch_size] for i in range(0, len(items), batch_size)]
    results = []
    done = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(worker, b): b for b in batches}
        for fut in as_completed(futs):
            batch = futs[fut]
            try:
                results.extend(fut.result())
                done += len(batch)
            except Exception as exc:  # noqa: BLE001
                with _LOCK:
                    _USAGE["errors"] += len(batch)
                print(f"[{label}] batch failed ({len(batch)}): {exc}", flush=True)
                with open(OUT / "failed_batches.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps({"label": label, "ids": [x.get("id") for x in batch], "error": str(exc)}, ensure_ascii=False) + "\n")
            if done and done % 100 < batch_size:
                print(f"[{label}] {done}/{len(items)} in {time.time()-started:.0f}s", flush=True)
    print(f"[{label}] done {len(results)}/{len(items)} in {time.time()-started:.0f}s", flush=True)
    flush_usage(label)
    return results
