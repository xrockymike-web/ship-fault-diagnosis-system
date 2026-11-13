#!/usr/bin/env python3
"""批量跑 ours 三变体：逐题调用 bridge/run_ours.mjs，汇总 answer-content.json。

用法：
    python experiment/code/systems/ours/run_batch.py --system ours --stage 50questions \
        --program experiment/config_variants/ours
    python experiment/code/systems/ours/run_batch.py --system no_graph --stage 50questions \
        --app workspace/bin/resources/app --program experiment/config_variants/no_graph
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parents[2]
COMMON = EXPERIMENT / "code" / "common"
sys.path.insert(0, str(COMMON))

import jsonio as io  # noqa: E402
import paths  # noqa: E402

DOMAIN = ("fact", "causal", "diagnostic")
CLI = HERE / "bridge" / "run_ours.mjs"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ours / 消融变体批量跑")
    parser.add_argument("--system", default="ours", choices=("ours", "no_graph"))
    parser.add_argument("--stage", default="50questions", choices=paths.STAGES)
    parser.add_argument("--sample", default=paths.DEFAULT_SAMPLE, choices=paths.SAMPLES)
    parser.add_argument("--app", default=None)
    parser.add_argument("--program", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", nargs="*", default=None, help="只跑指定题号(选择性重跑)")
    args = parser.parse_args(argv)

    payload = io.read_json(paths.questions_file(args.stage, args.sample))
    if not payload:
        raise SystemExit("题集不存在")
    questions = [q for q in payload["questions"] if q.get("type") in DOMAIN]
    if args.only:
        questions = [q for q in questions if q["id"] in set(args.only)]
    if args.limit:
        questions = questions[: args.limit]

    answer_dir = paths.answer_dir(args.system, args.stage, args.sample)
    answer_dir.mkdir(parents=True, exist_ok=True)
    if args.system != "ours" and not args.app:
        raise SystemExit("--system %s 需要显式给 --app/--program（默认只跑 ours 的正式构建）" % args.system)
    app = args.app or str(EXPERIMENT.parent / "workspace" / "bin" / "resources" / "app")
    program = args.program or str(EXPERIMENT.parent / "workspace" / "query")

    rows: list[dict] = []
    started = time.time()
    for idx, q in enumerate(questions, 1):
        qid = q["id"]
        print("[%d/%d %5.1f%%] %s 开始" % (idx, len(questions), 100.0 * idx / len(questions), qid), flush=True)
        outdir = answer_dir / "runs" / qid / "r1"
        cmd = [sys.executable.replace("python.exe", "python.exe")]  # 占位，下面用 node
        cmd = [
            "node",
            str(CLI),
            "--question", q["question"],
            "--outdir", str(outdir),
            "--runtime", str(answer_dir / "_runtime"),
            "--app", app,
            "--program", program,
        ]
        t0 = time.time()
        for attempt in range(2):

            proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)

            answer_path = outdir / 'answer.json'

            if answer_path.exists():

                _d = json.loads(answer_path.read_text(encoding='utf-8'))

                if (_d.get('status') == 'completed' and (_d.get('answer') or '').strip()) or attempt == 1:

                    break

        elapsed = round((time.time() - t0) * 1000, 1)
        answer_path = outdir / "answer.json"
        status = "error"
        answer = ""
        if answer_path.exists():
            data = json.loads(answer_path.read_text(encoding="utf-8"))
            answer = data.get("answer") or ""
            status = data.get("status") or "error"
        if status != "completed":
            print(f"[{args.system}] {qid} {status} {elapsed}ms stderr={proc.stderr[-200:]}")
        else:
            print(f"[{args.system}] {qid} completed {elapsed}ms chars={len(answer)}")
        rows.append(
            {
                "question_id": qid,
                "system": args.system,
                "condition": args.system,
                "runs": [{"run": "r1", "status": status, "error": None if status == "completed" else (proc.stderr[-200:] or "error"), "answer_chars": len(answer), "total_ms": elapsed}],
            }
        )

    # 合并写：选择性重跑(--only)时保留未重跑题的旧记录
    merged = {r["question_id"]: r for r in rows}
    prev_path = answer_dir / "answer-content.json"
    if prev_path.exists():
        try:
            prev = io.read_json(prev_path) or {}
            for row in prev.get("answers", []):
                merged.setdefault(row.get("question_id"), row)
        except Exception:
            pass
    ordered = [merged[q["id"]] for q in questions if q["id"] in merged] + \
        [v for k, v in merged.items() if k and k not in {q["id"] for q in questions}]
    io.write_json(
        prev_path,
        {"stage": args.stage, "sample": args.sample, "system": args.system, "condition": args.system, "generated_at": io.now_iso(), "answers": ordered},
    )
    io.write_json(
        answer_dir / "stage_meta.json",
        {
            "stage": args.stage,
            "sample": args.sample,
            "system": args.system,
            "app_root": str(app),
            "program_root": str(program),
            "questions": len(rows),
            "ok": sum(1 for r in rows if r["runs"][0]["status"] == "completed"),
            "elapsed_s": round(time.time() - started, 1),
            "at": io.now_iso(),
        },
    )
    print(f"[{args.system}] 完成 {len(rows)} 题，写入 {paths.rel(answer_dir)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
