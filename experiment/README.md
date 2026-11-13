# Experiment — four-arm question answering for ship fault diagnosis

This folder publishes the evaluation **inputs and outputs** used in the paper: the frozen question set
(without scoring annotations) and the answers produced by the four pipelines, together with the runners
and arm configurations needed to regenerate them.

> **Published:** questions + answers.
> **Withheld:** gold scoring annotations, per-point LLM-judge outputs, human verification records, and all
> scores. These are reported in the paper and are available from the corresponding author upon reasonable
> request. The repository `.gitignore` enforces this split — evaluation internals are never committed.

## What is here

| Path | Content |
|---|---|
| `data_performance/questions_public.json` | 50 questions, design fields only; scoring annotations removed |
| `data_performance/answers_public/{first,second}/<arm>.json` | 400 answers (2 samples × 4 arms × 50 questions) |
| `code/systems/` | runners that produced the answers |
| `code/config_variants/` | arm definitions (ours / no_graph) |
| `code/common/` | shared path/config/JSON/budget helpers |
| `config.yaml`, `requirements.txt`, `.env.example` | run configuration (API keys come from `.env`, never committed) |

## The four arms

| Arm | Description |
|---|---|
| `ours` | the shipped system: two-path retrieval (text + graph) with evidence-grounded generation |
| `no_graph` | identical to ours with the graph path disabled (`config_variants/no_graph`) |
| `naiverag` | dense sub-chunk top-k retrieval baseline |
| `lightrag` | LightRAG baseline via the `lightrag-hku` package, unmodified upstream code |

All 400 answers were generated locally with **Qwen3-0.6B** (verified across all 400 records).

### LightRAG

- Repository: https://github.com/HKUDS/LightRAG (MIT license), distributed on PyPI as `lightrag-hku`.
- This repository does **not** vendor the LightRAG source code. Install it before running the arm:

```powershell
pip install lightrag-hku==1.5.7
```

```bibtex
@article{guo2024lightrag,
  title   = {LightRAG: Simple and Fast Retrieval-Augmented Generation},
  author  = {Guo, Zirui and Xia, Lianghao and Yu, Yanhua and Ao, Tu and Huang, Chao},
  journal = {arXiv preprint arXiv:2410.05779},
  year    = {2024}
}
```

## Regenerating the answers (not the scores)

Prerequisites: the built application (see the repository root README) and the three local services —
embedding `:18081`, answer `:18082` (must run with `enable_thinking=false`), reranker `:18083`.

```powershell
# ours (no_graph: same chain with --program experiment/config_variants/no_graph)
python experiment/code/systems/ours/run_batch.py --system ours --stage 50questions \
  --program experiment/config_variants/ours --app workspace/bin/resources/app

# naiverag
python experiment/code/systems/naiverag/runner.py --stage 50questions

# lightrag (requires the pip package; an index must exist under experiment/baselines/lightrag/ before --query)
python experiment/code/systems/lightrag/runner.py --query --stage 50questions
```

All runners accept `--sample first|second` (default `first`). Details: `code/systems/README.md`.

## Notes

- Both samples share the identical question set; `questions_public.json` is the single copy
  (the two private source files are byte-identical).
- `config.yaml` references a cost ledger path; that file is created on first run when costing
  is enabled and is never committed.
- Scoring, judging and question-generation code are intentionally not part of this public view
  (see the published/withheld split above).
