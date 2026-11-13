#!/usr/bin/env python3
"""全量翻译知识库文本块 → data/chunk/chunks_en.jsonl（可断点续跑）。"""
from __future__ import annotations

import csv
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from client import ROOT, chat_json, run_batches  # noqa: E402

DATA = ROOT / "workspace" / "data"
LANG_DIR = ROOT / "workspace" / "build" / "lang"
OUT_FILE = DATA / "chunk" / "chunks_en.jsonl"
TMP = LANG_DIR / "out" / "chunks_en.partial.jsonl"
LOCK = threading.Lock()

SYSTEM = (
    "You are a professional translator of Chinese ship-electrical maintenance and fault-diagnosis manuals into English. "
    "Translate faithfully and completely; preserve sentence order and technical meaning. "
    "Keep every model number, part code, terminal label, unit and symbol exactly as in the source. "
    "Use the supplied glossary terms exactly. Do not add explanations, notes or extra sentences. "
    'Output JSON only, shape: {"items":[{"id":"...","en":"..."}]}'
)


def load_glossary() -> dict:
    p = LANG_DIR / "glossary.zh-en.csv"
    out = {}
    with open(p, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("zh") and r.get("en"):
                out[r["zh"].strip()] = r["en"].strip()
    return out


def glossary_block(text: str, gloss: dict, limit: int = 60) -> str:
    hits = [(z, e) for z, e in gloss.items() if z in text]
    hits.sort(key=lambda x: len(x[0]), reverse=True)
    hits = hits[:limit]
    if not hits:
        return "Glossary: (none of the fixed terms occur in this batch)"
    return "Glossary (must use exactly):\n" + "\n".join(f"{z} => {e}" for z, e in hits)


def main() -> int:
    gloss = load_glossary()
    rows = [json.loads(l) for l in open(DATA / "chunk" / "chunks.jsonl", encoding="utf-8") if l.strip()]
    done = {}
    if OUT_FILE.exists():
        for l in open(OUT_FILE, encoding="utf-8"):
            if l.strip():
                r = json.loads(l)
                if r.get("text_en"):
                    done[r["id"]] = r["text_en"]
    if TMP.exists():
        for l in open(TMP, encoding="utf-8"):
            if l.strip():
                r = json.loads(l)
                if r.get("en"):
                    done[r["id"]] = r["en"]
    todo = [r for r in rows if r["id"] not in done]
    print(f"total={len(rows)} done={len(done)} todo={len(todo)}", flush=True)

    def worker(batch):
        items = [{"id": r["id"], "zh": r["text"]} for r in batch]
        text_all = "".join(r["text"] for r in batch)
        user = glossary_block(text_all, gloss) + "\n\n" + json.dumps(items, ensure_ascii=False)
        out = chat_json(SYSTEM, user, max_tokens=8000)
        got = out.get("items") or []
        res = []
        with LOCK:
            with open(TMP, "a", encoding="utf-8") as f:
                for it in got:
                    if not it.get("id") or not it.get("en"):
                        continue
                    f.write(json.dumps({"id": it["id"], "en": it["en"]}, ensure_ascii=False) + "\n")
                    res.append({"id": it["id"], "en": it["en"]})
        return res

    results = run_batches(todo, worker, batch_size=4, concurrency=16, label="corpus")

    # 合并 + 校验 + 落盘（按原顺序）
    merged = dict(done)
    for r in results:
        merged[r["id"]] = r["en"]
    cjk = re.compile(r"[\u4e00-\u9fff]")
    qc = {"total": len(rows), "translated": 0, "missing": [], "cjk_residue": [], "short": [], "long": []}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        for r in rows:
            en = (merged.get(r["id"]) or "").strip()
            if not en:
                qc["missing"].append(r["id"])
                continue
            ratio = len(en) / max(1, len(r["text"]))
            if ratio < 0.25:
                qc["short"].append(r["id"])
            if ratio > 4.0:
                qc["long"].append(r["id"])
            hits = len(cjk.findall(en))
            if hits > 1:
                qc["cjk_residue"].append({"id": r["id"], "n": hits})
            qc["translated"] += 1
            f.write(json.dumps({"id": r["id"], "text_en": en}, ensure_ascii=False) + "\n")
    (LANG_DIR / "out" / "qc_corpus.json").write_text(json.dumps(qc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in qc.items()}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
