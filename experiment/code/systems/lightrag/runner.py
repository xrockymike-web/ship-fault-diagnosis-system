#!/usr/bin/env python3
"""LightRAG 适配器：建库（qwen3.8-flash）+ 查询（本地 Qwen3-0.6B）+ runs 落盘。

用法（必须用 experiment/.venv-lightrag 的 python 跑）：

    python code/systems/lightrag/runner.py --probe 10      # 10 个 chunk 成本探路
    python code/systems/lightrag/runner.py --build         # 全量建库（book.txt，默认切块）
    python code/systems/lightrag/runner.py --query [--sample first]   # 跑 50questions 领域题
    python code/systems/lightrag/runner.py --status        # 只看索引/花费状态

产物：
    experiment/baselines/lightrag/working_dir/           LightRAG 索引（git 忽略；已归档到 backup/temp/experiment_baselines_lightrag_20261024/）
    data_performance/answer/lightrag/<stage>/runs/<题号>/r1/   每题过程
    data_performance/answer/lightrag/<stage>/answer-content.json
    data_performance/answer/lightrag/<stage>/stage_meta.json

红线：
- 建库 LLM 只走 qwen3.8-flash，每次调用过预算闸门；查询期 LLM 走本地，不花钱；
- 不打印 key；不改 workspace；不跑 main；不改题集。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parents[2]                     # experiment/
COMMON = EXPERIMENT / "code" / "common"
BIN = HERE / "bin" / "lightrag-1.5.7"
if BIN.exists():   # public copy: vendored source optional; otherwise rely on an installed `lightrag-hku==1.5.7`
    sys.path.insert(0, str(BIN))                     # 用 vendored 源码，保证版本一致
sys.path.insert(0, str(COMMON))
sys.path.insert(0, str(HERE))

import jsonio as io  # noqa: E402
import paths  # noqa: E402
import budget  # noqa: E402

from lightrag import LightRAG, QueryParam  # noqa: E402

import llm  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

STAGE_DEFAULT = "50questions"
WORKING_DIR = paths.BASELINES_DIR / "lightrag" / "working_dir"
CHUNK_TOKEN_SIZE = 1200
CHUNK_OVERLAP = 100
CHARS_PER_CHUNK = 1500          # 探路时按字符估算 chunk 数（中文约 1.25 字/token）
QUERY_PARAMS = dict(
    mode="mix",
    top_k=20,
    chunk_top_k=6,
    max_entity_tokens=800,
    max_relation_tokens=1200,
    max_total_tokens=5250,      # 2026-10-23：与本系统四段预算之和对齐（text 3400 + entities 1150 + paths 400 + diagnostics 300）
    enable_rerank=False,        # 未接 rerank 模型，显式关闭避免告警
    stream=False,
)
DOMAIN_TYPES = ("fact", "causal", "diagnostic")
# 2026-10-23：长度要求走 QueryParam.user_prompt（不拼进检索 query，避免污染关键词抽取）
ANSWER_INSTRUCTION = "回答要求：先一句话结论；再列 3–5 个要点，每点 1–2 句；总长 300–450 字；不要复述问题、不要寒暄。"
# 公平性(2026-10-19): 不注入任何自定义 system_prompt，LightRAG 用官方默认 prompt；
# 旧 LIGHTRAG_SYSTEM(限长180-240字)为死代码且造成 102 字短答，已删除。


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("lightrag-hku")
    except Exception:
        return "unknown"


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _spend() -> dict[str, float]:
    return {row["model"]: row["spent_cny"] for row in budget.status()["rows"]}


def make_rag(working_dir: Path, llm_func, gleaning: int = 1) -> LightRAG:
    return LightRAG(
        working_dir=str(working_dir),
        llm_model_func=llm_func,
        embedding_func=llm.make_embedding_func(),
        chunk_token_size=CHUNK_TOKEN_SIZE,
        chunk_overlap_token_size=CHUNK_OVERLAP,
        entity_extract_max_gleaning=gleaning,
        llm_model_max_async=16,
        embedding_func_max_async=16,
    )


# ---------------------------------------------------------------- build
async def build(limit_chunks: int | None, gleaning: int, reset: bool) -> dict[str, Any]:
    if reset and WORKING_DIR.exists():
        shutil.rmtree(WORKING_DIR)
    WORKING_DIR.mkdir(parents=True, exist_ok=True)

    text = paths.BOOK_FILE.read_text(encoding="utf-8")
    if limit_chunks:
        text = text[: limit_chunks * CHARS_PER_CHUNK]

    before = _spend().get(llm.QWEN_MODEL, 0.0)
    rag = make_rag(WORKING_DIR, llm.qwen_chat, gleaning)
    await rag.initialize_storages()
    started = time.time()
    try:
        await rag.ainsert(text, ids=["BOOK-0001"], file_paths=["book.txt"])
    finally:
        await rag.finalize_storages()
    elapsed = time.time() - started
    after = _spend().get(llm.QWEN_MODEL, 0.0)

    meta = {
        "system": "lightrag",
        "lightrag_version": _version(),
        "built_at": io.now_iso(),
        "mode": "probe" if limit_chunks else "full",
        "limit_chunks": limit_chunks,
        "chars": len(text),
        "chunk_token_size": CHUNK_TOKEN_SIZE,
        "chunk_overlap_token_size": CHUNK_OVERLAP,
        "entity_extract_max_gleaning": gleaning,
        "build_llm": llm.QWEN_MODEL,
        "build_cost_cny": round(after - before, 8),
        "elapsed_s": round(elapsed, 1),
        "working_dir": paths.rel(WORKING_DIR),
        "working_dir_bytes": _dir_size(WORKING_DIR),
    }
    index_meta = WORKING_DIR / "experiment_build_meta.json"
    io.write_json(index_meta, meta)
    print("[build] " + json.dumps(meta, ensure_ascii=False))
    return meta


# ---------------------------------------------------------------- query
def _write_run(answer_dir: Path, qid: str, payload: dict[str, Any]) -> None:
    run_dir = answer_dir / "runs" / qid / "r1"
    run_dir.mkdir(parents=True, exist_ok=True)
    for name, data in payload.items():
        io.write_json(run_dir / f"{name}.json", data)


async def query(stage: str, limit: int | None, repeat: int, sample: str = paths.DEFAULT_SAMPLE) -> int:
    questions_path = paths.questions_file(stage, sample)
    payload = io.read_json(questions_path)
    if not payload:
        raise SystemExit(f"题集不存在：{paths.rel(questions_path)}")
    domain = [q for q in payload["questions"] if q.get("type") in DOMAIN_TYPES]
    if limit:
        domain = domain[:limit]
    if not domain:
        raise SystemExit("没有领域题可跑")

    answer_dir = paths.answer_dir("lightrag", stage, sample)
    answer_dir.mkdir(parents=True, exist_ok=True)

    rag = make_rag(WORKING_DIR, llm.local_chat, gleaning=1)
    await rag.initialize_storages()
    rows: list[dict[str, Any]] = []
    try:
        for q in domain:
            qid = q["id"]
            question = q["question"]
            record: dict[str, Any] = {
                "question_id": qid,
                "system": "lightrag",
                "condition": "lightrag",
                "mode": QUERY_PARAMS["mode"],
                "stage": stage,
                "runs": [],
                "error": None,
            }
            for rep in range(1, repeat + 1):
                run_name = f"r{rep}"
                request = {
                    "question": question,
                    "query_param": QUERY_PARAMS,
                    "repeat": rep,
                    "answer_model": llm.LOCAL_ANSWER_MODEL,
                    "embedding_model": "Qwen3-Embedding-0.6B-Q8_0",
                }
                t0 = time.time()
                try:
                    # 2026-10-23：检索用**原问题**（长度指令不再污染关键词）；长度要求经 user_prompt 只作用于作答
                    context = (await rag.aquery(question, QueryParam(only_need_context=True, **QUERY_PARAMS))) or ""
                    t_ctx = time.time()
                    answer = (await rag.aquery(question, QueryParam(user_prompt=ANSWER_INSTRUCTION, **QUERY_PARAMS))) or ""
                    t_done = time.time()
                    status = {"status": "completed", "error": None}
                except Exception as exc:
                    t_ctx = t_done = time.time()
                    context, answer = "", ""
                    status = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
                run_dir = answer_dir / "runs" / qid / run_name
                run_dir.mkdir(parents=True, exist_ok=True)
                io.write_json(run_dir / "request.json", request)
                io.write_json(run_dir / "retrieval_context.json", {"context": context})
                io.write_json(
                    run_dir / "answer.json",
                    {
                        "answer": answer,
                        "model": llm.LOCAL_ANSWER_MODEL,
                        "endpoint": llm.LOCAL_ANSWER_BASE,
                        "chars": len(answer),
                    },
                )
                io.write_json(
                    run_dir / "timings.json",
                    {
                        "context_ms": round((t_ctx - t0) * 1000, 1),
                        "total_ms": round((t_done - t0) * 1000, 1),
                    },
                )
                io.write_json(run_dir / "status.json", status)
                record["runs"].append(
                    {
                        "run": run_name,
                        **status,
                        "answer_chars": len(answer),
                        "context_ms": round((t_ctx - t0) * 1000, 1),
                        "total_ms": round((t_done - t0) * 1000, 1),
                    }
                )
                if status["status"] != "completed":
                    record["error"] = status["error"]
                    break
            rows.append(record)
            first = record["runs"][0] if record["runs"] else {}
            print(f"[query] {qid} {first.get('status')} {first.get('total_ms', '-')}ms chars={first.get('answer_chars', 0)}")
    finally:
        await rag.finalize_storages()

    content = {
        "stage": stage,
        "sample": sample,
        "system": "lightrag",
        "condition": "lightrag",
        "generated_at": io.now_iso(),
        "query_param": QUERY_PARAMS,
        "answers": rows,
    }
    io.write_json(answer_dir / "answer-content.json", content)
    stage_meta = {
        "stage": stage,
        "sample": sample,
        "system": "lightrag",
        "lightrag_version": _version(),
        "mode": QUERY_PARAMS["mode"],
        "query_param": QUERY_PARAMS,
        "answer_model": llm.LOCAL_ANSWER_MODEL,
        "embedding_model": "Qwen3-Embedding-0.6B-Q8_0",
        "embedding_dim": llm.EMBED_DIM,
        "working_dir": paths.rel(WORKING_DIR),
        "questions": len(rows),
        "ok": sum(1 for row in rows if row["error"] is None),
        "failed": sum(1 for row in rows if row["error"]),
        "budget_cny": _spend(),
        "at": io.now_iso(),
    }
    io.write_json(answer_dir / "stage_meta.json", stage_meta)
    print("[query] " + json.dumps(stage_meta, ensure_ascii=False))
    return 0 if stage_meta["failed"] == 0 else 1


# ---------------------------------------------------------------- status
def status() -> int:
    meta_path = WORKING_DIR / "experiment_build_meta.json"
    meta = io.read_json(meta_path)
    print(f"working_dir={paths.rel(WORKING_DIR)} exists={WORKING_DIR.exists()} bytes={_dir_size(WORKING_DIR)}")
    if meta:
        print("build_meta=" + json.dumps(meta, ensure_ascii=False))
    print("spend=" + json.dumps(_spend(), ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LightRAG 适配器")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--probe", type=int, metavar="N", help="用前 N 个 chunk 量级做成本探路")
    group.add_argument("--build", action="store_true", help="全量建库")
    group.add_argument("--query", action="store_true", help="跑 50questions 领域题")
    group.add_argument("--status", action="store_true", help="查看索引/花费")
    parser.add_argument("--stage", default=STAGE_DEFAULT, choices=paths.STAGES)
    parser.add_argument("--sample", default=paths.DEFAULT_SAMPLE, choices=paths.SAMPLES)
    parser.add_argument("--limit", type=int, default=None, help="--query 时只跑前 N 题")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--gleaning", type=int, default=1)
    parser.add_argument("--reset", action="store_true", help="建库前清空 working_dir")
    args = parser.parse_args(argv)

    if args.status:
        return status()
    if args.probe is not None:
        asyncio.run(build(args.probe, args.gleaning, args.reset))
        return 0
    if args.build:
        asyncio.run(build(None, args.gleaning, args.reset))
        return 0
    return asyncio.run(query(args.stage, args.limit, args.repeat, args.sample))


if __name__ == "__main__":
    sys.exit(main())
