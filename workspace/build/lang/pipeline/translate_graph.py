#!/usr/bin/env python3
"""翻译图谱层：实体名 + 实体类型/关系标签 → data/graph/*_en.csv。"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from client import ROOT, chat_json, run_batches  # noqa: E402

DATA = ROOT / "workspace" / "data"
LANG_DIR = ROOT / "workspace" / "build" / "lang"

SYSTEM = (
    "You translate Chinese ship-electrical fault-diagnosis entity names into concise English terms. "
    "One fixed English term per entity; standard electrical vocabulary; keep model codes and symbols unchanged; "
    "no explanations. "
    'Output JSON only: {"items":[{"id":"...","en":"..."}]}'
)


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def main() -> int:
    ents = list(csv.DictReader(open(DATA / "graph" / "entities.csv", encoding="utf-8-sig", newline="")))
    done = {r["id"]: r["name_en"] for r in read_jsonl(DATA / "graph" / "entities_en.jsonl")}
    todo = [e for e in ents if e["entity_id"] not in done]
    print(f"entities={len(ents)} done={len(done)} todo={len(todo)}", flush=True)

    def worker(batch):
        items = [{"id": e["entity_id"], "zh": e["entity_name"]} for e in batch]
        out = chat_json(SYSTEM, json.dumps(items, ensure_ascii=False), max_tokens=4000)
        res = []
        for it in out.get("items") or []:
            if it.get("id") and it.get("en"):
                res.append({"id": it["id"], "name_en": it["en"].strip()})
        with open(DATA / "graph" / "entities_en.jsonl", "a", encoding="utf-8") as f:
            for r in res:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        return res

    run_batches(todo, worker, batch_size=30, concurrency=10, label="entities")

    names = {r["id"]: r["name_en"] for r in read_jsonl(DATA / "graph" / "entities_en.jsonl")}
    with open(DATA / "graph" / "entities_en.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["entity_id", "name_en"])
        miss = 0
        for e in ents:
            en = names.get(e["entity_id"], "")
            if not en:
                miss += 1
            w.writerow([e["entity_id"], en])
    print(f"entities_en.csv written, missing={miss}", flush=True)

    # 关系 + 实体类型标签
    rel_rows = list(csv.DictReader(open(DATA / "graph" / "relations.csv", encoding="utf-8-sig", newline="")))
    rel_names = []
    for r in rel_rows:
        vals = [v for v in r.values() if v]
        rel_names.append(vals[1] if len(vals) > 1 else vals[0])
    etypes = sorted({(e.get("entity_type") or "").strip() for e in ents if e.get("entity_type")})
    labels = [("relation", z) for z in rel_names] + [("entity_type", z) for z in etypes]
    out_labels = chat_json(
        SYSTEM,
        json.dumps([{"id": f"L{i}", "zh": z, "kind": k} for i, (k, z) in enumerate(labels)], ensure_ascii=False),
        max_tokens=2000,
    )
    got = {it["id"]: it["en"].strip() for it in out_labels.get("items") or []}
    with open(DATA / "graph" / "labels_en.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["kind", "zh", "en"])
        for i, (k, z) in enumerate(labels):
            w.writerow([k, z, got.get(f"L{i}", "")])
    print(f"labels_en.csv rows={len(labels)} translated={len(got)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
