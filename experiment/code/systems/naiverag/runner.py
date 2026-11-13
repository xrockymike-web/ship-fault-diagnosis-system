#!/usr/bin/env python3
"""naive RAG 基线（《实验总纲》§5.4）。

口径：
- 同一份 chunk 库（workspace/data/chunk/chunks.jsonl 的正文块）；
- 同一个本地 embedding（Qwen3-Embedding-0.6B，1024 维，127.0.0.1:18081）；
- **只做稠密向量 top-3**，无 FTS、无 rerank、无父子块提升；
- 同一个本地回答模型（Qwen3-0.6B，127.0.0.1:18082）；
- prompt 只有：角色规则 + 3 条原文证据 + 问题 + `[n]` 引用要求；
- 只跑领域题。

用法：
    python code/systems/naiverag/runner.py --stage 50questions [--sample first] [--limit N] [--topk 3]
产物：
    data_performance/answer/naiverag/<stage>/{runs/<题号>/r1/...,answer-content.json,stage_meta.json}
    experiment/baselines/naiverag/chunk_vectors.npz（向量缓存，git 忽略）
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parents[2]
COMMON = EXPERIMENT / "code" / "common"
sys.path.insert(0, str(COMMON))

import jsonio as io  # noqa: E402
import paths  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EMBED_BASE = "http://127.0.0.1:18081/v1"
ANSWER_BASE = "http://127.0.0.1:18082/v1"
ANSWER_MODEL = "qwen3-0.6b"
EMBED_DIM = 1024
DOMAIN_TYPES = ("fact", "causal", "diagnostic")
SYSTEM_PROMPT = "你是船舶电气设备的故障诊断助手。只依据给定的资料回答；资料不足时明确说明「资料不足」，不要编造。"
CACHE = paths.BASELINES_DIR / "naiverag" / "chunk_vectors.npz"


def post_json(url: str, body: dict[str, Any], timeout: int = 180) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def embed(texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), 1):
        batch = texts[i : i + 1]
        payload = post_json(EMBED_BASE + "/embeddings", {"input": batch})
        rows = sorted(payload.get("data") or [], key=lambda r: r.get("index", 0))
        out.extend(row["embedding"] for row in rows)
    return out


def chat(question: str, evidences: list[dict[str, Any]]) -> str:
    refs = "\n\n".join(f"[{i}] {e['text']}" for i, e in enumerate(evidences, 1))
    user = f"原文证据：\n{refs}\n\n问题：{question}\n\n【作答要求】总长 300–450 字。"
    payload = post_json(ANSWER_BASE + "/chat/completions",
        {
            "model": ANSWER_MODEL,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
            "temperature": 0.6,
            "top_p": 0.95,
            "max_tokens": 1024,
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    choice = payload["choices"][0]
    return {"answer": (choice["message"].get("content") or "").strip(),
            "finish_reason": choice.get("finish_reason")}


def load_chunks() -> list[dict[str, Any]]:
    rows = []
    for row in io.read_jsonl(paths.CHUNKS_FILE):
        if row.get("kind") == "text" and (row.get("text") or "").strip():
            rows.append({"id": row["id"], "parent": row.get("parent_id"), "text": row["text"].strip()})
    return rows


def load_parents() -> dict[str, str]:
    """父块正文：{父块 id: text}（naiverag 命中子块后折叠成父块呈现，与本系统口径一致）。"""
    out: dict[str, str] = {}
    for row in io.read_jsonl(paths.CHUNKS_FILE):
        if row.get("kind") == "parent" and (row.get("text") or "").strip():
            out[row["id"]] = row["text"].strip()
    return out


def vectors_for(chunks: list[dict[str, Any]]):
    import numpy as np

    if CACHE.exists():
        data = np.load(CACHE, allow_pickle=False)
        if list(data["ids"]) == [c["id"] for c in chunks]:
            return data["vecs"]
    print(f"[naiverag] 首次编码 {len(chunks)} 个 chunk（本地 embedding）…")
    started = time.time()
    vectors = np.asarray(embed([c["text"] for c in chunks]), dtype=np.float32)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CACHE, ids=np.array([c["id"] for c in chunks]), vecs=vectors)
    print(f"[naiverag] 编码完成 {vectors.shape}，{time.time()-started:.1f}s，缓存 {paths.rel(CACHE)}")
    return vectors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="naive RAG 基线")
    parser.add_argument("--stage", default="50questions", choices=paths.STAGES)
    parser.add_argument("--sample", default=paths.DEFAULT_SAMPLE, choices=paths.SAMPLES)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--topk", type=int, default=30, help="候选子块数（之后按父块折叠 + 字符预算截断）")
    parser.add_argument("--char-budget", type=int, default=3776, help="证据正文总字符预算（= 本系统 3 个父块实测均值 3,776 字）")
    parser.add_argument("--max-ctx-items", type=int, default=12, help="最多几条子块（默认切块；按字符预算截断）")
    args = parser.parse_args(argv)

    import numpy as np

    payload = io.read_json(paths.questions_file(args.stage, args.sample))
    if not payload:
        raise SystemExit("题集不存在")
    questions = [q for q in payload["questions"] if q.get("type") in DOMAIN_TYPES]
    if args.limit:
        questions = questions[: args.limit]

    chunks = load_chunks()
    parents = load_parents()
    vecs = vectors_for(chunks)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    unit = vecs / np.maximum(norms, 1e-9)

    answer_dir = paths.answer_dir("naiverag", args.stage, args.sample)
    answer_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for q in questions:
        qid = q["id"]
        t0 = time.time()
        try:
            qvec = np.asarray(embed([q["question"]])[0], dtype=np.float32)
            sims = unit @ (qvec / max(float(np.linalg.norm(qvec)), 1e-9))
            top = np.argsort(-sims)[: args.topk]
            # 2026-10-24 负责人口径：naive 用**自身默认切块**（text 子块，不折叠父块），
            # 只把“证据正文总长”对齐 ours 的 3 个父块（实测均值 3,776 字）。
            evidences, used = [], 0
            for i in top:
                c = chunks[int(i)]
                text = c["text"]
                if used + len(text) > args.char_budget and evidences:
                    continue
                evidences.append({"id": c["id"], "parent": c.get("parent"), "text": text})
                used += len(text)
                if len(evidences) >= args.max_ctx_items or used >= args.char_budget:
                    break
            res = chat(q["question"], evidences)
            answer = res["answer"]
            finish_reason = res.get("finish_reason")
            status = {"status": "completed", "error": None, "finish_reason": finish_reason}
        except Exception as exc:
            evidences, answer, finish_reason = [], "", None
            status = {"status": "error", "error": f"{type(exc).__name__}: {exc}", "finish_reason": None}
        elapsed = round((time.time() - t0) * 1000, 1)
        run_dir = answer_dir / "runs" / qid / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)
        io.write_json(run_dir / "request.json", {"question": q["question"], "topk": args.topk, "system_prompt": SYSTEM_PROMPT})
        io.write_json(run_dir / "retrieval_context.json", {"evidences": evidences})
        io.write_json(run_dir / "answer.json", {"answer": answer, "model": ANSWER_MODEL, "endpoint": ANSWER_BASE, "chars": len(answer), "finish_reason": finish_reason})
        io.write_json(run_dir / "timings.json", {"total_ms": elapsed})
        io.write_json(run_dir / "status.json", status)
        rows.append({"question_id": qid, "system": "naiverag", "condition": "naive", "runs": [{"run": "r1", **status, "answer_chars": len(answer), "total_ms": elapsed}]})
        print(f"[naiverag] {qid} {status['status']} {elapsed}ms chars={len(answer)} "
              f"ctx_chars={sum(len(e['text']) for e in evidences)} ctx_items={len(evidences)}", flush=True)

    io.write_json(answer_dir / "answer-content.json", {"stage": args.stage, "sample": args.sample, "system": "naiverag", "condition": "naive", "generated_at": io.now_iso(), "topk": args.topk, "answers": rows})
    io.write_json(answer_dir / "stage_meta.json", {"stage": args.stage, "sample": args.sample, "system": "naiverag", "topk": args.topk, "answer_model": ANSWER_MODEL, "embedding_model": "Qwen3-Embedding-0.6B-Q8_0", "questions": len(rows), "ok": sum(1 for r in rows if r["runs"][0]["status"] == "completed"), "at": io.now_iso()})
    print(f"[naiverag] 完成 {len(rows)} 题，写入 {paths.rel(answer_dir)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
