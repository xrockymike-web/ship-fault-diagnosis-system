#!/usr/bin/env python3
"""最小 API 冒烟测试：DeepSeek deepseek-flash + 阿里云 qwen3.8-flash。

只发一条极短请求，确认 key、base_url、model id、JSON 输出可用；
不打印 key，不打印 Authorization；结果写 data_performance/api_smoke_test.json。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Windows 控制台可能是 GBK；统一用 UTF-8 打印，避免 ¥ 之类字符报 UnicodeEncodeError。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EXPERIMENT = Path(__file__).resolve().parents[2]
PROJECT = EXPERIMENT.parent
DATA = EXPERIMENT / "data_performance"
LEDGER = DATA / "cost_ledger.jsonl"
USD_CNY = 7.3
PER_MODEL_CAP_CNY = 5.0

PRICES = {
    "deepseek-flash": {"input": 0.30, "output": 1.20},   # 高峰价，保守
    "qwen3.8-flash": {"input": 0.113, "output": 0.382},  # 北京价
}


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name:
            env[name] = value
    return env


def post_json(url: str, api_key: str, body: dict, timeout: int = 60) -> tuple[int, dict, float]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw), time.time() - started
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"raw": raw[:800]}
        return exc.code, payload, time.time() - started


def usage_tokens(payload: dict) -> tuple[int, int]:
    usage = payload.get("usage") or {}
    inp = usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0
    out = usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
    return int(inp), int(out)


def estimate_cny(model: str, inp: int, out: int) -> float:
    price = PRICES[model]
    return (inp / 1_000_000 * price["input"] + out / 1_000_000 * price["output"]) * USD_CNY


def content_of(payload: dict) -> str:
    try:
        return (payload["choices"][0]["message"].get("content") or "")[:300]
    except Exception:
        return ""


def run_one(name: str, url: str, key: str, body: dict, model: str) -> dict:
    started = time.time()
    status, payload, latency = post_json(url, key, body)
    inp, out = usage_tokens(payload)
    cost = estimate_cny(model, inp, out)
    result = {
        "provider": name,
        "model": model,
        "status": status,
        "latency_s": round(latency, 3),
        "input_tokens": inp,
        "output_tokens": out,
        "estimated_cny": round(cost, 6),
        "content": content_of(payload),
        "error": None,
    }
    if status != 200:
        result["error"] = json.dumps(payload, ensure_ascii=False)[:800]
    return result


def main() -> int:
    env = load_env(EXPERIMENT / ".env")
    missing = [k for k in ("DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY") if not env.get(k)]
    if missing:
        print("[check_api] missing env: " + ", ".join(missing))
        return 2

    ds_model = env.get("DEEPSEEK_MODEL", "deepseek-flash")
    ds_base = env.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    qwen_model = env.get("QWEN_BUILD_MODEL", "qwen3.8-flash")
    qwen_base = env.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")

    ds_body = {
        "model": ds_model,
        "messages": [
            {"role": "system", "content": "只输出 JSON，不要解释。"},
            {"role": "user", "content": '返回 {"ok": true}'},
        ],
        "temperature": 0,
        "max_tokens": 32,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
    }
    qwen_body = {
        "model": qwen_model,
        "messages": [
            {"role": "system", "content": "只输出 JSON，不要解释。"},
            {"role": "user", "content": '返回 {"ok": true}'},
        ],
        "temperature": 0,
        "max_tokens": 64,
        "response_format": {"type": "json_object"},
    }
    if "enable_thinking" not in qwen_body:
        qwen_body["enable_thinking"] = False

    results = []
    results.append(run_one("deepseek", ds_base + "/chat/completions", env["DEEPSEEK_API_KEY"], ds_body, ds_model))
    results.append(run_one("dashscope", qwen_base + "/chat/completions", env["DASHSCOPE_API_KEY"], qwen_body, qwen_model))

    DATA.mkdir(parents=True, exist_ok=True)
    out = {
        "at": datetime.now(timezone.utc).isoformat(),
        "cap_cny_per_model": PER_MODEL_CAP_CNY,
        "results": results,
    }
    out_path = DATA / "first" / "report" / "api_smoke_test.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    with LEDGER.open("a", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps({
                "ts": out["at"],
                "stage": "api_smoke",
                "provider": r["provider"],
                "model": r["model"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "estimated_cny": r["estimated_cny"],
            }, ensure_ascii=False) + "\n")

    for r in results:
        print(f"[{r['provider']}] status={r['status']} model={r['model']} "
              f"latency={r['latency_s']}s input={r['input_tokens']} output={r['output_tokens']} "
              f"est=CNY {r['estimated_cny']:.6f}")
        print("  content=" + (r["content"] or "<empty>"))
        if r["error"]:
            print("  error=" + r["error"])

    ok = all(r["status"] == 200 for r in results)
    print("[check_api] " + ("OK" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
