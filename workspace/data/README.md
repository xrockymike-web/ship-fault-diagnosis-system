# workspace/data — knowledge base assets and build inputs

Everything needed to rebuild the knowledge base and to understand what the shipped database contains.
Runtime state (`runtime/`, `user_data/`) and the two SQLite stores are **not** committed; they are
generated locally (see "Rebuild" below).

## Contents

| Path | Role |
|---|---|
| `document/book.txt` | the authored corpus (1,188 paragraphs, ~331k characters) |
| `chunk/chunks_filled.jsonl` | build input: 1,332 chunks (1,065 text + 267 parent, parent = 4 children), with `text_seg` |
| `chunk/chunks.jsonl` | chunk master data (same chunks, without `text_seg`) |
| `chunk/chunk_spans.jsonl` | chunk -> corpus character/paragraph offsets |
| `chunk/chunk_stats.json` | chunking statistics (book sha256, parameters, length distribution) |
| `chunk/segments.jsonl` | sentence-level segmentation units (chunker intermediate) |
| `chunk/sem/` | sentence index + boundary scores (chunker input) |
| `chunk/decisions/` | cached LLM boundary decisions (chunker input, 7,478 rows) |
| `chunk/MANIFEST.sha256` | sha256/bytes/rows of the chunk artefacts (self-check) |
| `chunk/chunks_en.jsonl` | English translation of the chunks (English interface layer) |
| `graph/entities.csv` | 1,463 entities (7 types) |
| `graph/triples.csv` | 1,116 triples (11 relation types) |
| `graph/relations.csv` | relation ontology |
| `graph/graph_health.json/.md` | knowledge-graph health report |
| `graph/entities_en.csv`, `graph/labels_en.csv` | English entity names and labels |
| `vector-index/manifest.json` | manifest of the two SQLite stores (hashes, tables, row counts, vector counts) |

Scale: 1,332 chunks / 1,463 entities / 1,116 triples / 15,988 co-occurrence edges / 3,644 vectors
(1,065 chunk + 2,579 entity & triple vectors, 1024-dim).

Chunk ids are `TXT-0001…TXT-1065` (text) and `PRT-0001…PRT-0267` (parent); entities `E-0001…E-1463`;
triples `T-0001…T-1116`.

## Rebuild

```powershell
# 0) self-check: are the stores consistent with these inputs?
workspace\environment\python\python.exe workspace\build\index\verify_db.py

# 1) rebuild the two stores into a scratch directory (does not overwrite data/)
workspace\environment\python\python.exe workspace\build\index\build_db.py --data workspace\data --vec workspace\build\vector-index --out backup\temp\rebuild_check
workspace\environment\python\python.exe workspace\build\index\make_manifest.py --data workspace\data --vec workspace\build\vector-index --dir backup\temp\rebuild_check
workspace\environment\python\python.exe workspace\build\index\verify_db.py --dir backup\temp\rebuild_check --data workspace\data
```

Build inputs = `chunk/chunks_filled.jsonl` + `graph/{entities,triples,relations}.csv`; embeddings are
produced by `workspace/build/vector-index/embed_build.mjs` (needs the models under
`workspace/environment/`, not committed). The two SQLite stores themselves are not distributed:
`vector-index/manifest.json` is the reference your rebuild should match.

## Licensing and provenance

- Code **and** data in this repository are licensed under Apache-2.0 (see the repository `LICENSE`).
- The corpus is authored for this project (human curation together with LLMs); it contains no
  copyrighted third-party text, and the corpus-generation pipeline is **not** part of this repository.
- Chunk boundaries come from semantic scores plus LLM boundary decisions (build-time commercial API);
  the resulting chunks and the decision cache are provided so the result can be audited and replayed.
