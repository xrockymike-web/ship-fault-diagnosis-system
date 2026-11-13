# Knowledge-graph extraction (build/graph)

This directory answers one question: **where do the entities, triples and attributes in `data/graph/`
come from?** Three scripts plus two shared modules, standard library only.

| File | Role |
|---|---|
| `extract_entities.py` | chunk -> candidate entities (7 types, with chunk-id evidence) |
| `extract_triples.py` | chunk + entities -> candidate triples (relations constrained by `relations.csv`) |
| `extract_attributes.py` | entity + evidence chunks -> `attributes` column (definition / fact / alias) |
| `graph_common.py` | shared rules: chunk loading, windowing, mention anchoring, relation schema, CSV IO |
| `llm_client.py` | model client with a result cache (key = model + prompt + input) |

## Reproducibility boundary (read this first)

The published `data/graph/` is **not** the direct output of these scripts. The real process is two steps:

1. **machine extraction** - these scripts produce candidate entities / edges / attributes, each row tagged
   `origin=llm-extract`;
2. **human review** - type corrections, alias merging, relation reversal and de-duplication, removal of
   vague rows, gap filling. The review step is human judgement: no script, no per-row log.

Therefore:

- flow is reproducible: same chunk set + same prompts + same model at temperature 0 -> same candidates
  (the cache makes replays free);
- spot checks are reproducible: the "N rows checked, X% pass" reported in the paper can be re-run with
  the prompts and validation rules in this directory;
- **byte-identical output is not reproducible**: a re-run yields the candidate set, not
  `data/graph/entities.csv`. The difference is the human review step, and the paper says so.

## Usage

```powershell
# 0) free, offline: run the whole prompt -> parse -> validate -> write chain
python workspace/build/graph/extract_entities.py   --dry-run
python workspace/build/graph/extract_triples.py    --dry-run
python workspace/build/graph/extract_attributes.py --dry-run

# 1) small sample (first 20 windows / entities)
python workspace/build/graph/extract_entities.py   --limit 20 --api-key-file .env
python workspace/build/graph/extract_triples.py    --limit 20 --api-key-file .env
python workspace/build/graph/extract_attributes.py --limit 20 --api-key-file .env

# 2) full run (cached, replays cost nothing)
python workspace/build/graph/extract_entities.py   --api-key-file .env --concurrency 4
```

- **No keys in the repository**: pass `--api-key-file` or set `DASHSCOPE_API_KEY`; without either the
  script stops with a clear error.
- **Never writes into `data/graph/`**: output goes to `--out` (default `data/runtime/graph_extract/`,
  git-ignored). Review is a human step; the scripts only propose candidates.
