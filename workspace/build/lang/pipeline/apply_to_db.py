#!/usr/bin/env python3
"""把英文层写入两库（可重复执行，幂等）：chunks.text_en / chunks_fts_en / entities.name_en / labels_en。"""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / "workspace" / "data"
VI = DATA / "vector-index"
OUT = ROOT / "workspace" / "build" / "lang" / "out"
BACKUP = OUT / "db_backup"
BACKUP.mkdir(parents=True, exist_ok=True)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def cols(con, table: str) -> list[str]:
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})")]


def main() -> int:
    ts = time.strftime("%Y%m%d-%H%M%S")
    chunk_db = VI / "chunk" / "chunk.sqlite"
    graph_db = VI / "graph" / "graph.sqlite"
    for p in (chunk_db, graph_db):
        bak = BACKUP / f"{p.name}.{ts}.bak"
        if not bak.exists():
            shutil.copy2(p, bak)

    # ---------- chunk ----------
    con = sqlite3.connect(chunk_db)
    con.execute("PRAGMA foreign_keys=OFF")
    if "text_en" not in cols(con, "chunks"):
        con.execute("ALTER TABLE chunks ADD COLUMN text_en TEXT")
    pairs = []
    for line in open(DATA / "chunk" / "chunks_en.jsonl", encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        pairs.append((r["text_en"], r["id"]))
    con.executemany("UPDATE chunks SET text_en=? WHERE id=?", pairs)
    n_en = con.execute("SELECT COUNT(*) FROM chunks WHERE text_en IS NOT NULL AND text_en <> ''").fetchone()[0]
    con.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_en USING fts5(text_en, content='chunks', content_rowid='rowid', tokenize='trigram')"
    )
    # 外部内容 FTS 只能用 rebuild 重建索引（直接 DELETE 会破坏 shadow 表）
    con.execute("INSERT INTO chunks_fts_en(chunks_fts_en) VALUES('rebuild')")
    con.commit()
    print(f"chunk: text_en={n_en} fts_rows={con.execute('SELECT COUNT(*) FROM chunks_fts_en').fetchone()[0]}", flush=True)
    con.close()

    # ---------- graph ----------
    con = sqlite3.connect(graph_db)
    if "name_en" not in cols(con, "entities"):
        con.execute("ALTER TABLE entities ADD COLUMN name_en TEXT")
    name_map = {}
    with open(DATA / "graph" / "entities_en.csv", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            name_map[r["entity_id"]] = r["name_en"]
    con.executemany("UPDATE entities SET name_en=? WHERE id=?", [(v, k) for k, v in name_map.items()])
    n_ent = con.execute("SELECT COUNT(*) FROM entities WHERE name_en IS NOT NULL AND name_en <> ''").fetchone()[0]

    con.execute("DROP TABLE IF EXISTS entities_fts")
    con.execute("CREATE VIRTUAL TABLE entities_fts USING fts5(name, name_en, aliases, tokenize='trigram')")
    con.execute(
        "INSERT INTO entities_fts(rowid, name, name_en, aliases) "
        "SELECT rowid, name, COALESCE(name_en,''), '' FROM entities"
    )

    con.execute("DROP TABLE IF EXISTS labels_en")
    con.execute("CREATE TABLE labels_en (kind TEXT NOT NULL, zh TEXT NOT NULL, en TEXT, PRIMARY KEY (kind, zh))")
    labels = []
    with open(DATA / "graph" / "labels_en.csv", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            labels.append((r["kind"], r["zh"], r["en"]))
            con.execute("INSERT OR REPLACE INTO labels_en(kind,zh,en) VALUES (?,?,?)", (r["kind"], r["zh"], r["en"]))
    con.commit()
    print(f"graph: name_en={n_ent} labels={len(labels)} fts_rows={con.execute('SELECT COUNT(*) FROM entities_fts').fetchone()[0]}", flush=True)
    con.close()

    # ---------- manifest ----------
    mf = VI / "manifest.json"
    m = json.loads(mf.read_text(encoding="utf-8"))
    for key, path in (("chunk", chunk_db), ("graph", graph_db)):
        st = m["stores"][key]
        st["sha256"] = sha256(path)
        st["bytes"] = path.stat().st_size
        con = sqlite3.connect(path)
        tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        rows = {}
        for t in tables:
            try:
                rows[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except Exception:
                rows[t] = -1
        con.close()
        st["tables"] = tables
        st["rows"] = rows
    m["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    m["i18n"] = {"enabled": True, "chunks_en": n_en, "entities_en": n_ent, "labels_en": len(labels), "vectors_en": 0}
    mf.write_text(json.dumps(m, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("manifest updated", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
