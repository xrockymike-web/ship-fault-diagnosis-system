#!/usr/bin/env python3
"""预算闸门：读 `cost_ledger.jsonl`，按"单模型 ¥5"硬停。

用法：
    python experiment/code/common/budget.py --status          # 打印各模型累计/剩余
    python experiment/code/common/budget.py --status --json   # 机器可读
    python experiment/code/common/budget.py --check deepseek-flash --est 0.001

调用侧约定（别的脚本必须照做）：
    import budget
    budget.check("deepseek-flash", est_cny=0.002)   # 超限抛 BudgetExceeded
    ... 真正的 API 调用 ...
    budget.record("deepseek-flash", stage="question_draft", provider="deepseek",
                  input_tokens=..., output_tokens=...)

口径：
- 价格用 config.yaml 的 `pricing_usd_per_mtok`（保守价：DeepSeek 高峰、qwen 北京）；
- `estimate_cny` 默认把全部输入按 cache miss 计价（宁可高估，不可低估）；
- 达到 `per_model_cny` 上限或 `max_calls` 时 `check()` 抛异常；**不静默换模型**；
- 台账只追加，不改历史行。
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
from pathlib import Path
from typing import Any, Iterable

import config
import jsonio as io
import paths

try:  # Windows 控制台默认 GBK，统一 UTF-8，避免 ¥ 报 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


_RECORD_LOCK = threading.Lock()


class BudgetExceeded(RuntimeError):
    """预算/调用次数触顶。调用方应停机并报告，不得自动换模型。"""


# ---------------------------------------------------------------- 台账
def ledger_path() -> Path:
    return paths.COST_LEDGER


def load_ledger() -> list[dict[str, Any]]:
    return list(io.read_jsonl(ledger_path()))


def totals() -> dict[str, dict[str, Any]]:
    """按 model 汇总：调用数、token、累计 CNY。"""
    out: dict[str, dict[str, Any]] = {}
    for row in load_ledger():
        model = str(row.get("model") or row.get("provider") or "unknown")
        bucket = out.setdefault(
            model,
            {"model": model, "calls": 0, "input_tokens": 0, "output_tokens": 0, "cny": 0.0},
        )
        bucket["calls"] += 1
        bucket["input_tokens"] += int(row.get("input_tokens") or 0)
        bucket["output_tokens"] += int(row.get("output_tokens") or 0)
        bucket["cny"] += float(row.get("estimated_cny") or 0.0)
    return out


# ---------------------------------------------------------------- 计价
def price_of(model: str) -> dict[str, float]:
    table = config.pricing()
    if model not in table:
        raise BudgetExceeded(
            f"config.yaml 里没有 {model!r} 的价格；拒绝在未定价模型上调用（不静默换模型）"
        )
    price = table[model]
    for key in ("input", "output"):
        if key not in price:
            raise BudgetExceeded(f"{model!r} 价格缺少 {key}")
    return price


def estimate_cny(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_hit_tokens: int = 0,
) -> float:
    price = price_of(model)
    cache_price = float(price.get("cache_hit", price["input"]))
    miss_tokens = max(int(input_tokens) - int(cache_hit_tokens), 0)
    usd = (
        miss_tokens / 1_000_000 * price["input"]
        + int(cache_hit_tokens) / 1_000_000 * cache_price
        + int(output_tokens) / 1_000_000 * price["output"]
    )
    return round(usd * config.usd_cny(), 8)


# ---------------------------------------------------------------- 闸门
def check(model: str, est_cny: float = 0.0, calls: int = 1) -> dict[str, Any]:
    """调用前检查；超限抛 BudgetExceeded。返回本次调用前的快照，便于记录。"""
    caps = config.per_model_cap_cny()
    if model not in caps:
        raise BudgetExceeded(f"config.yaml 未给 {model!r} 设单模型上限，拒绝调用")
    cap = float(caps[model])
    if not config.hard_stop():
        return {"model": model, "spent_cny": 0.0, "cap_cny": cap, "hard_stop": False}

    stats = totals().get(model, {"calls": 0, "cny": 0.0})
    spent = float(stats["cny"])
    if spent + float(est_cny) > cap:
        raise BudgetExceeded(
            f"{model}: 累计 ¥{spent:.6f} + 本次预估 ¥{est_cny:.6f} 超过单模型上限 ¥{cap:.2f}；停机"
        )
    limits = config.max_calls()
    if model in limits and int(stats["calls"]) + calls > int(limits[model]):
        raise BudgetExceeded(
            f"{model}: 调用次数 {stats['calls']}+{calls} 超过上限 {limits[model]}；停机"
        )
    return {"model": model, "spent_cny": spent, "cap_cny": cap, "hard_stop": True}


def record(
    model: str,
    *,
    stage: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    cache_hit_tokens: int = 0,
    estimated_cny: float | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """调用后记账（只追加）。estimated_cny 不给就按配置价估算。"""
    if estimated_cny is None:
        estimated_cny = estimate_cny(model, input_tokens, output_tokens, cache_hit_tokens)
    row: dict[str, Any] = {
        "ts": io.now_iso(),
        "stage": stage,
        "provider": provider,
        "model": model,
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "cache_hit_tokens": int(cache_hit_tokens),
        "estimated_cny": round(float(estimated_cny), 8),
    }
    if note:
        row["note"] = note
    with _RECORD_LOCK:
        io.append_jsonl(ledger_path(), row)
    return row


# ---------------------------------------------------------------- 报告
def status() -> dict[str, Any]:
    caps = config.per_model_cap_cny()
    limits = config.max_calls()
    stats = totals()
    models = sorted(set(caps) | set(stats))
    rows: list[dict[str, Any]] = []
    total_cny = 0.0
    total_cap = 0.0
    over = False
    for model in models:
        spent = float(stats.get(model, {}).get("cny", 0.0))
        calls = int(stats.get(model, {}).get("calls", 0))
        cap = float(caps.get(model, 0.0))
        left = cap - spent
        pct = (spent / cap * 100.0) if cap else 0.0
        at_limit = cap > 0 and spent >= cap
        over = over or at_limit
        total_cny += spent
        total_cap += cap
        rows.append(
            {
                "model": model,
                "calls": calls,
                "call_limit": limits.get(model),
                "input_tokens": int(stats.get(model, {}).get("input_tokens", 0)),
                "output_tokens": int(stats.get(model, {}).get("output_tokens", 0)),
                "spent_cny": round(spent, 8),
                "cap_cny": cap,
                "left_cny": round(left, 8),
                "used_pct": round(pct, 4),
                "at_limit": at_limit,
            }
        )
    return {
        "at": io.now_iso(),
        "ledger": paths.rel(ledger_path()),
        "hard_stop": config.hard_stop(),
        "rows": rows,
        "total_cny": round(total_cny, 8),
        "total_cap_cny": round(total_cap, 8),
        "any_at_limit": over,
    }


def print_status(report: dict[str, Any] | None = None) -> None:
    report = report or status()
    print(f"[budget] ledger={report['ledger']}  hard_stop={report['hard_stop']}")
    header = f"{'model':<18}{'calls':>7}{'in_tok':>10}{'out_tok':>10}{'spent(CNY)':>14}{'cap':>7}{'left':>12}{'used%':>8}"
    print(header)
    print("-" * len(header))
    for row in report["rows"]:
        flag = "  AT LIMIT" if row["at_limit"] else ""
        print(
            f"{row['model']:<18}{row['calls']:>7}{row['input_tokens']:>10}{row['output_tokens']:>10}"
            f"{row['spent_cny']:>14.6f}{row['cap_cny']:>7.2f}{row['left_cny']:>12.6f}{row['used_pct']:>7.2f}%{flag}"
        )
    print("-" * len(header))
    print(
        f"{'TOTAL':<18}{'':>7}{'':>10}{'':>10}{report['total_cny']:>14.6f}"
        f"{report['total_cap_cny']:>7.2f}"
    )
    if report["any_at_limit"]:
        print("[budget] 有模型已触顶：停机，不静默换模型。")


# ---------------------------------------------------------------- CLI
def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="实验预算闸门")
    parser.add_argument("--status", action="store_true", help="打印各模型累计/剩余")
    parser.add_argument("--json", action="store_true", help="与 --status 连用，输出 JSON")
    parser.add_argument("--check", metavar="MODEL", help="检查某模型是否还有预算")
    parser.add_argument("--est", type=float, default=0.0, help="本次调用预估花费 CNY")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.check:
        try:
            snap = check(args.check, est_cny=args.est)
        except BudgetExceeded as exc:
            print(f"[budget] STOP: {exc}")
            return 3
        print(
            f"[budget] OK {args.check}: spent ¥{snap['spent_cny']:.6f} / cap ¥{snap['cap_cny']:.2f}"
        )
        return 0

    report = status()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_status(report)
    return 3 if report["any_at_limit"] else 0


if __name__ == "__main__":
    sys.exit(main())
