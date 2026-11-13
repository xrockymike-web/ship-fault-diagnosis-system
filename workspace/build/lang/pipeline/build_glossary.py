#!/usr/bin/env python3
"""生成术语表草稿：实体名 + 关系类型 + 核心术语，经 API 统一译法，落 CSV。"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from client import ROOT, chat_json, run_batches  # noqa: E402

DATA = ROOT / "workspace" / "data"
OUT = ROOT / "workspace" / "build" / "lang"

SEED = [
    "脱扣器", "失压脱扣器", "分励脱扣器", "热脱扣器", "欠电压", "过电压", "过载", "短路", "缺相", "断相",
    "灭弧室", "触头", "触头压力", "触头烧蚀", "熔断器", "熔断", "接触器", "继电器", "断路器", "主开关",
    "电枢", "换向", "换向器", "电刷", "励磁", "励磁绕组", "剩磁", "发电机", "电动机", "变压器",
    "配电板", "应急电源", "绝缘电阻", "接地", "漏电", "剩余电流", "温升", "振动", "噪声",
    "万用表", "兆欧表", "绝缘电阻表", "钳形电流表", "钳口", "保护环", "接线柱", "端子排",
    "故障树分析法", "专家系统", "经验诊断法", "故障现象", "故障原因", "维修步骤", "维护项目", "注意事项",
    "船舶电气设备", "控制回路", "主回路", "线圈", "衔铁", "脱扣轴", "自由脱扣", "储能弹簧",
]

FORBIDDEN = ["MF-47", "Q8_0", "PLC", "L/E/G", "TXT-", "PRT-", "E-", "T-", "V", "A", "Ω", "mA", "kV"]


def load_entities() -> list[dict]:
    p = DATA / "graph" / "entities.csv"
    with open(p, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def load_relations() -> list[str]:
    p = DATA / "graph" / "relations.csv"
    rows = []
    with open(p, encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            vals = [v for v in r.values() if v]
            if len(vals) >= 2:
                rows.append(vals[1])
            elif vals:
                rows.append(vals[0])
    return rows


def main() -> int:
    ents = load_entities()
    ents.sort(key=lambda r: len((r.get("chunk_ids") or "").split("|")), reverse=True)
    seen: list[str] = []
    for r in ents:
        n = (r.get("entity_name") or "").strip()
        if not n or not (2 <= len(n) <= 14):
            continue
        if n in seen:
            continue
        seen.append(n)
        if len(seen) >= 160:
            break
    terms = list(dict.fromkeys(SEED + seen + load_relations()))
    print(f"candidates={len(terms)}", flush=True)

    def worker(batch):
        payload = [{"zh": t} for t in batch]
        prompt = (
            "Translate each Chinese marine-electrical / ship-fault-diagnosis term into concise professional English. "
            "Rules: one fixed English term per entry; use standard IEC/electrical vocabulary; keep model numbers, IDs, "
            "units and abbreviations unchanged; do not add explanations. "
            'Return JSON: {"terms":[{"zh":"...","en":"..."}]}.\n'
            + json.dumps(payload, ensure_ascii=False)
        )
        out = chat_json("You are a bilingual terminologist for marine electrical engineering. Output JSON only.", prompt, max_tokens=2500)
        return out.get("terms") or []

    results = run_batches(terms, worker, batch_size=40, concurrency=8, label="glossary")
    mapping = {r["zh"]: r["en"].strip() for r in results if r.get("zh") and r.get("en")}

    out_path = OUT / "glossary.zh-en.csv"
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["zh", "en", "kind", "note", "status"])
        for t in terms:
            en = mapping.get(t, "")
            kind = "entity" if t in seen else ("relation" if t in load_relations() else "term")
            w.writerow([t, en, kind, "", "confirmed" if en else "missing"])
    print(f"wrote {out_path} rows={len(terms)} translated={len(mapping)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
