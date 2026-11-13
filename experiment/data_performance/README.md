# data_performance — published evaluation data

| File | Content |
|---|---|
| `questions_public.json` | the 50 frozen questions with scoring annotations removed |
| `answers_public/first/{ours,no_graph,naiverag,lightrag}.json` | 200 answers, sample 1 |
| `answers_public/second/{ours,no_graph,naiverag,lightrag}.json` | 200 answers, sample 2 |

Answer entry schema: `{question_id, answer, model, chars[, finish_reason | status]}`.
Fields dropped at export time: `endpoint` (machine-local address) and `error` (always null in the 400 records).

**Not published here:** gold scoring annotations (`key_points` / `support_chunks` anchors),
per-point LLM-judge verdicts, scores, human verification records, and the cost ledger.
They are reported in the paper and are available from the corresponding author upon reasonable request.
The published/withheld split is described in `../README.md`.
