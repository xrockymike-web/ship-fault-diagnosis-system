# experiment/code/systems — three pipelines (public view)

> Retrieval configuration matches the shipped software; prompts use the shared minimal experiment wording.
> Upstream LightRAG source is not vendored here — see `../../README.md` for install + citation.

## ours

| File | Role |
|---|---|
| `run_batch.py` | batch runner (one question at a time), calls `bridge/run_ours.mjs` |
| `bridge/run_ours.mjs` | headless driver for `workspace/bin/resources/app/qa-core/index.js` (same chain as the GUI) |

```powershell
python experiment/code/systems/ours/run_batch.py --system ours --stage 50questions \
  --program experiment/config_variants/ours --app workspace/bin/resources/app
```

- `--program experiment/config_variants/ours` is required for experiment runs (otherwise the wording changes);
- **no_graph has no separate directory**: same chain + `config_variants/no_graph` (only `graph.enabled=false`).

## naiverag

`runner.py`: dense top-k **sub-chunks** (no parent folding), truncated to a character budget
(default 3,776 chars ≈ three parent blocks of the shipped system).

```powershell
python experiment/code/systems/naiverag/runner.py --stage 50questions
```

## lightrag

| File | Role |
|---|---|
| `runner.py` | build/query entry point; `--query --stage 50questions` |
| `llm.py` | adapter: query-time calls the local Qwen server; index build used a commercial LLM API (see paper) |
| `condition.yaml` | arm settings (mode / top_k / max_total_tokens=5250 …) |

- Upstream package: `lightrag-hku==1.5.7` (https://github.com/HKUDS/LightRAG, MIT); **not vendored**.
  `runner.py` uses a local copy at `bin/lightrag-1.5.7/` only if present, otherwise the installed package.
- Ensure an index exists under `experiment/baselines/lightrag/` before `--query`;
  the runner does not check and an empty index would overwrite answers.

```powershell
python experiment/code/systems/lightrag/runner.py --query --stage 50questions
```

## Service contract

embedding 18081 / answer 18082 (**must run with enable_thinking=false**) / reranker 18083.

> `run_batch.py`, `naiverag/runner.py` and `lightrag/runner.py` all accept
> `--sample first|second` (default `first`).
