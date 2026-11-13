#!/usr/bin/env python3
"""LightRAG 的 LLM / embedding 适配层。

口径（《实验总纲》§5.3）：
- **建库 LLM**：`qwen3.8-flash`（阿里云百炼，OpenAI 兼容）——只在这一处花钱；
- **查询期 LLM**：本地 llama-server `Qwen3-0.6B-Q8_0`（127.0.0.1:18082），不花钱；
- **embedding**：本地 llama-server `Qwen3-Embedding-0.6B-Q8_0`（127.0.0.1:18081），1024 维；
- 每次 qwen 调用前过 `budget.check()`，调用后写 `cost_ledger.jsonl`；进程内再设 ¥4.85 保险丝，
  触顶抛 `BuildBudgetStop`，**不静默换模型**。

注意：本文件不打印 key；所有请求体只在内存里拼。
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
from lightrag.utils import EmbeddingFunc

_COMMON = Path(__file__).resolve().parents[2] / "common"
if str(_COMMON) not in sys.path:
    sys.path.insert(0, str(_COMMON))

import budget  # noqa: E402
import config  # noqa: E402

QWEN_BASE = (config.env("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1") or "").rstrip("/")
QWEN_MODEL = config.env("QWEN_BUILD_MODEL", "qwen3.8-flash") or "qwen3.8-flash"
QWEN_KEY = config.require_env("DASHSCOPE_API_KEY")

LOCAL_ANSWER_BASE = "http://127.0.0.1:18082/v1"
LOCAL_EMBED_BASE = "http://127.0.0.1:18081/v1"
LOCAL_ANSWER_MODEL = "qwen3-0.6b"
EMBED_DIM = 1024
EMBED_MAX_TOKENS = 2048
EMBED_BATCH = 1

# 建库保险丝：单模型上限 ¥5，留 ¥0.15 给重试
BUILD_COST_GUARD_CNY = 4.85

_lock = threading.Lock()
_spent_cny = 0.0


class BuildBudgetStop(RuntimeError):
    """建库花费触顶。调用方应停机并报告。"""


def spent_cny() -> float:
    with _lock:
        return _spent_cny


def _add_spent(value: float) -> float:
    global _spent_cny
    with _lock:
        _spent_cny += float(value)
        return _spent_cny


def _post_json(url: str, api_key: str | None, body: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw[:400]}") from None
    except Exception as exc:  # 网络层
        raise RuntimeError(f"{type(exc).__name__}: {exc}") from None


def _messages(prompt: str, system_prompt: str | None, history_messages: list[dict[str, str]] | None) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for item in history_messages or []:
        if isinstance(item, dict) and item.get("role") and item.get("content") is not None:
            messages.append({"role": str(item["role"]), "content": str(item["content"])})
    messages.append({"role": "user", "content": prompt})
    return messages


def _content_of(payload: dict[str, Any]) -> str:
    try:
        return payload["choices"][0]["message"].get("content") or ""
    except Exception:
        return ""


def _usage_of(payload: dict[str, Any]) -> tuple[int, int]:
    usage = payload.get("usage") or {}
    inp = usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0
    out = usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
    return int(inp), int(out)


async def qwen_chat(
    prompt: str,
    system_prompt: str | None = None,
    history_messages: list[dict[str, str]] | None = None,
    **kwargs: Any,
) -> str:
    """LightRAG 的 llm_model_func：建库期走 qwen3.8-flash。"""
    max_tokens = int(kwargs.get("max_tokens") or config.env("QWEN_MAX_TOKENS", "3072"))
    response_format = kwargs.get("response_format")
    body: dict[str, Any] = {
        "model": QWEN_MODEL,
        "messages": _messages(prompt, system_prompt, history_messages),
        "temperature": 0,
        "max_tokens": max_tokens,
        "enable_thinking": False,   # 百炼 OpenAI 兼容：关思考，省 token 也稳输出
    }
    if isinstance(response_format, dict):
        body["response_format"] = response_format

    est_in = max(int(len(prompt) / 1.2), 1)
    budget.check(QWEN_MODEL, est_cny=budget.estimate_cny(QWEN_MODEL, est_in, max_tokens))

    last_error: Exception | None = None
    for attempt in range(4):
        try:
            payload = await asyncio.to_thread(
                _post_json, QWEN_BASE + "/chat/completions", QWEN_KEY, body
            )
            content = _content_of(payload)
            inp, out = _usage_of(payload)
            cost = budget.estimate_cny(QWEN_MODEL, inp, out)
            budget.record(
                QWEN_MODEL,
                stage="lightrag_build",
                provider="dashscope",
                input_tokens=inp,
                output_tokens=out,
                estimated_cny=cost,
            )
            total = _add_spent(cost)
            if total > BUILD_COST_GUARD_CNY:
                raise BuildBudgetStop(
                    f"建库累计 ¥{total:.4f} 超过保险丝 ¥{BUILD_COST_GUARD_CNY}；停机"
                )
            if not content:
                raise RuntimeError("空响应")
            return content
        except BuildBudgetStop:
            raise
        except Exception as exc:  # 429/5xx/网络：退避重试
            last_error = exc
            await asyncio.sleep(2 * (attempt + 1))
    raise RuntimeError(f"qwen 调用连续失败：{last_error}")


async def local_chat(
    prompt: str,
    system_prompt: str | None = None,
    history_messages: list[dict[str, str]] | None = None,
    **kwargs: Any,
) -> str:
    """LightRAG 的 llm_model_func：查询期走本地 Qwen3-0.6B。"""
    max_tokens = int(kwargs.get("max_tokens") or 1024)  # 2026-10-23：四臂统一 1024，避免 450 字答案被 800 截断
    body = {
        "model": LOCAL_ANSWER_MODEL,
        "messages": _messages(prompt, system_prompt, history_messages),
        "temperature": float(kwargs.get("temperature", 0.6)),
        "top_p": 0.95,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    response_format = kwargs.get("response_format")
    if isinstance(response_format, dict):
        body["response_format"] = response_format
    payload = await asyncio.to_thread(
        _post_json, LOCAL_ANSWER_BASE + "/chat/completions", None, body
    )
    content = _content_of(payload)
    if not content:
        raise RuntimeError("本地回答为空")
    return content


def _embed_batch(texts: list[str]) -> list[list[float]]:
    payload = _post_json(LOCAL_EMBED_BASE + "/embeddings", None, {"input": texts})
    rows = payload.get("data") or []
    rows = sorted(rows, key=lambda item: item.get("index", 0))
    vectors = [row["embedding"] for row in rows]
    if len(vectors) != len(texts):
        raise RuntimeError(f"embedding 返回 {len(vectors)} 条，期望 {len(texts)} 条")
    return vectors


async def embed_texts(texts: list[str]) -> np.ndarray:
    """批量 embedding；返回 (n, 1024) float32。"""
    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH):
        chunk = texts[start : start + EMBED_BATCH]
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                vectors.extend(await asyncio.to_thread(_embed_batch, chunk))
                break
            except Exception as exc:
                last_error = exc
                await asyncio.sleep(1.5 * (attempt + 1))
        else:
            raise RuntimeError(f"embedding 连续失败：{last_error}")
    array = np.asarray(vectors, dtype=np.float32)
    if array.shape[1] != EMBED_DIM:
        raise RuntimeError(f"embedding 维度 {array.shape[1]} != {EMBED_DIM}")
    return array


def make_embedding_func() -> EmbeddingFunc:
    return EmbeddingFunc(
        embedding_dim=EMBED_DIM,
        max_token_size=EMBED_MAX_TOKENS,
        func=embed_texts,
        model_name="Qwen3-Embedding-0.6B-Q8_0",
    )


def probe_endpoints() -> dict[str, Any]:
    """建库/查询前的就绪检查（不花钱）。"""
    report: dict[str, Any] = {}
    for name, url in (
        ("embedding", LOCAL_EMBED_BASE.replace("/v1", "") + "/health"),
        ("answer", LOCAL_ANSWER_BASE.replace("/v1", "") + "/health"),
    ):
        try:
            report[name] = _post_json(url, None, {}) if False else json.loads(
                urllib.request.urlopen(url, timeout=5).read().decode()
            )
        except Exception as exc:
            report[name] = f"FAIL: {exc}"
    return report


if __name__ == "__main__":
    print(json.dumps(probe_endpoints(), ensure_ascii=False))
    print("tokens_available qwen:", bool(QWEN_KEY))
    start = time.time()
    vec = asyncio.run(embed_texts(["船舶电气设备故障诊断", "发电机电压低"]))
    print("embedding:", vec.shape, "in", round(time.time() - start, 2), "s")
