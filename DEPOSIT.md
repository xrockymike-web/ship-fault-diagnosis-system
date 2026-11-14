# DEPOSIT — what is not in the repository, and how to get it

This repository tracks source, configuration, manifests, the corpus, the chunk/graph build inputs and
the English layer. **Large binary payloads are not tracked.** This file lists them with versions,
download URLs and sha256 checksums.

## 1. Model weights (into `workspace/environment/models/`)

| Model | File | Bytes | sha256 | License |
|---|---|---:|---|---|
| Qwen3-0.6B Q8_0 (answer) | `models/answer/qwen3.0.6B-Q8_0.gguf` | 639,446,688 | `9465E63A22ADD5354D9BB4B99E90117043C7124007664907259BD16D043BB031` | Apache-2.0 |
| Qwen3-0.6B Q4_K_M (CPU answer) | `models/answer-q4km/qwen3.0.6B-Q4_K_M.gguf` | 396,704,416 | `15E434D8DDF0AF38FE3F7003AF6CE6EAC4EDADA6DF34324AA45979F9CC79F02E` | Apache-2.0 |
| Qwen3-Embedding-0.6B Q8_0 | `models/embedding/Qwen3-Embedding-0.6B-Q8_0.gguf` | 639,150,592 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` | Apache-2.0 |
| Qwen3-Reranker-0.6B Q8_0 | `models/reranker/qwen3-reranker-0.6b-q8_0.gguf` | 639,153,312 | `99bcc225f0a38b73059b31627d28131cbea9c11b7ca894e56b95621aac878d65` | Apache-2.0 |

Per-file download URLs, alternative mirrors and notes: see each subdirectory `README.md` under
`workspace/environment/models/`.

## 2. Runtime binaries (into `workspace/environment/`)

| Component | Directory | Version |
|---|---|---|
| Electron (win32-x64) | `electron/` | 44.4.5 |
| llama.cpp CPU build | `llamacpp/cpu/` | b11205 |
| llama.cpp CUDA build | `llamacpp/cuda/` | b11205 |
| Node.js (build tooling) | `nodejs/` | 24.21.0 |
| Python embeddable (build pipeline) | `python/` | 3.12.4 |

URLs and checksums: each subdirectory `README.md`.

## 3. The two SQLite stores (not tracked, rebuildable)

`workspace/data/vector-index/chunk/chunk.sqlite` and `.../graph/graph.sqlite` are generated from the
tracked inputs. Rebuild instructions: `workspace/data/README.md`.

The expected result is recorded in `workspace/data/vector-index/manifest.json` (store sha256, tables,
row counts, vector counts) — the rebuild should match it.

## 4. Release archive

A self-contained Windows archive is distributed through Zenodo:
`shipdiag-v0.5.1-win-x64.zip`, 4,370,640,185 bytes, DOI
[10.5281/zenodo.24198739](https://doi.org/10.5281/zenodo.24198739). Its SHA-256 is
`4237624becf9d6b0e4034297785642ba79c66f212b6c814e9e5174f3c911bdb2`.

The same record carries `boat-diagnosis-experiment-v1.0.0.zip` (3,412,639 bytes, CC BY 4.0), the
evaluation questions and the four-pipeline answers. The archive corresponds to version 0.5.1 of this
repository.

## 5. Verify anything you downloaded

```powershell
(Get-FileHash .\<file> -Algorithm SHA256).Hash.ToLower()
```

Compare with the checksum listed above or in the corresponding `SOURCE`/`README`.
