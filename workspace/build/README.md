# workspace/build — knowledge-base build pipeline

This directory turns the authored corpus (`workspace/data/document/book.txt`) into the two SQLite
stores the application searches: `chunk.sqlite` (text chunks + FTS + chunk vectors) and
`graph.sqlite` (entities, triples, evidence links, co-occurrence edges, entity/triple vectors).

> **Domain scope (read this first).** Everything here is tuned for one domain: marine electrical
> equipment fault diagnosis. The corpus, the **7 entity types**, the **11 relation types** and the
> LLM prompts are domain-specific. The pipeline structure is reusable, but a different domain
> requires replacing the ontology and the prompts — see [Adapting to another domain](#adapting-to-another-domain).

## Pipeline (11 steps)

| Step | What happens | File(s) | Output |
|---|---|---|---|
| 1 | Text chunking: rule -> semantic score -> LLM boundary decisions -> size gates (parents = 4 children) | `chunk/build_chunks.py`, `chunk/semantic_boundaries.py`, `chunk/llm_boundaries.py`, `chunk/params.json` | `data/chunk/chunks.jsonl`, `chunks_filled.jsonl`, `chunk_spans.jsonl`, `segments.jsonl`, `sem/`, `decisions/` |
| 2 | Entity type schema (7 types) | `graph/graph_common.py:27` `ENTITY_TYPES` | — |
| 3 | Relation type schema (11 types, with allowed head/tail types) | `data/graph/relations.csv` | — |
| 4 | Per-window entity extraction (LLM: chunk + entity types -> name/type/desc/aliases) | `graph/extract_entities.py` | `<out>/entities_raw.csv` (candidates) |
| 5 | Entity de-duplication: same-name merge (type = first seen, chunk ids + aliases unioned) | inside `extract_entities.py` (`merge()`) | merged candidate list |
| 6 | Per-window triple extraction (LLM: chunk + relation schema + entities in the window) | `graph/extract_triples.py` | `<out>/triples_raw.csv` (candidates) |
| 7 | Triple de-duplication: (head, relation, tail) key, chunk ids unioned | inside `extract_triples.py` (`dedup()`) | merged candidate list |
| 8 | Attribute backfill (LLM: entity + all its evidence chunks + output template -> definition/facts/aliases) | `graph/extract_attributes.py` | `<out>/entities_attr.csv`, `attributes_raw.jsonl` |
| 9 | Build the two stores (graph from triples; FTS indexes; vector tables; co-occurrence edges) | `index/build_db.py` | `data/vector-index/{chunk,graph}/*.sqlite`, `manifest.json` |
| 10 | Chunk embeddings | `vector-index/embed_build.mjs --only chunk` | `build/vector-index/chunk/vector/chunk.jsonl` |
| 11 | Entity embeddings (**entity name + attributes**), plus triple embeddings | `vector-index/embed_build.mjs --only entity,triple` | `build/vector-index/graph/vector/{entity,triple}.jsonl` |

> **Order note:** steps 10-11 run **before** step 9. `build_db.py` loads the pre-computed vector
> JSONL files into the `vectors` tables; run the embedder first, then the store builder.

### Human review between steps

Steps 4-8 produce **candidates** (`origin=llm-extract`). The files shipped in `data/graph/` went
through an additional human review pass (type fixes, alias merging, relation reversal, removal of
padding edges, gap filling). That pass is human judgement: there is no script and no per-row log.
The pipeline therefore guarantees *flow* reproducibility and *spot-check* reproducibility, not
byte-identical graph reproduction — the same boundary is described in `graph/README.md`.

## Commands (reference — adapt paths and the model endpoint to your setup)

All commands are run from the repository root. The extraction scripts need a LLM endpoint and a key
(`--api-key-file` or `DASHSCOPE_API_KEY`); `--dry-run` runs the whole chain offline with stub replies.

```powershell
# 1) chunking (rebuild_chunks.ps1 wraps the three chunker steps + verification)
powershell -File workspace\build\chunk\rebuild_chunks.ps1 -Data workspace\data

# 4) entity candidates (add --dry-run for an offline smoke test)
python workspace\build\graph\extract_entities.py --api-key-file .env --concurrency 4

# 6) triple candidates (uses the entity candidates from step 4)
python workspace\build\graph\extract_triples.py --entities workspace\data\runtime\graph_extract\entities_raw.csv --api-key-file .env

# 8) attributes (backfill into the reviewed entity table)
python workspace\build\graph\extract_attributes.py --entities workspace\data\graph\entities.csv --api-key-file .env

# 10-11) embeddings (starts a temporary llama-server; idempotent, cached per obj_id)
node workspace\build\vector-index\embed_build.mjs --only chunk,entity,triple

# 9) build the stores (loads the vectors produced above)
python workspace\build\index\build_db.py

# verification
python workspace\build\index\verify_db.py
python workspace\build\index\make_manifest.py
```

Notes:

- the extraction scripts never write `data/graph/`; output goes to `--out` (default
  `data/runtime/graph_extract/`, git-ignored). Promote candidates to `data/graph/*.csv` only after review;
- chunking, entity extraction and attribute extraction all use a result cache keyed by
  model + prompt + input, so replays are free;
- `params.json` files hold the tunable parameters (`chunk/params.json`: size gates and parent ratio;
  `vector-index/params.json`: embedding batch/truncation settings).

## Data contract

| Stage | Path |
|---|---|
| Input | `workspace/data/document/book.txt` |
| Chunking | `data/chunk/chunks.jsonl`, `chunks_filled.jsonl`, `chunk_spans.jsonl`, `segments.jsonl`, `sem/`, `decisions/` |
| Graph candidates | `data/runtime/graph_extract/{entities_raw.csv, triples_raw.csv, entities_attr.csv}` |
| Reviewed graph | `data/graph/{entities.csv, triples.csv, relations.csv}` |
| Embeddings | `build/vector-index/{chunk/vector/chunk.jsonl, graph/vector/entity.jsonl, graph/vector/triple.jsonl}` |
| Final stores | `data/vector-index/{chunk/chunk.sqlite, graph/graph.sqlite, manifest.json}` |

## Adapting to another domain

The reusable part is the pipeline shape (chunk -> extract -> review -> stores -> vectors). The
domain-specific parts you must replace:

| # | Item | Where |
|---|---|---|
| 1 | Corpus | `workspace/data/document/book.txt` |
| 2 | Entity types (7 here) | `graph/graph_common.py` `ENTITY_TYPES` |
| 3 | Relation types + allowed head/tail types (11 here) | `data/graph/relations.csv` |
| 4 | Extraction prompts (Chinese, marine-electrical wording) | `extract_entities.py` / `extract_triples.py` / `extract_attributes.py` (`SYS_PROMPT`) |
| 5 | Chunking gates (Chinese text, 250-450 chars per child) | `chunk/params.json` |
| 6 | Retrieval-side type weights (the 7 types are referenced by name) | `workspace/query/graph-retrieval/` |
| 7 | Evidence prompt and answer wording | `workspace/query/evidence-prompt/` |
| 8 | Evaluation question set | `experiment/data_performance/questions_public.json` |

Nothing else assumes the maritime domain: the store schemas, the FTS layout, the vector tables and
the CLI shape stay the same.
