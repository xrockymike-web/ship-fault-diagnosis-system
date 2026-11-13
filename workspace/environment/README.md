# workspace/environment — third-party runtimes and model weights

Nothing in this directory is distributed with the repository. Each subdirectory carries a short
`README.md` with the exact version, download URL, sha256 and license of the artifact it expects;
place the downloaded files there to build or run the software from source.

| Subdirectory | Artifact |
|---|---|
| `electron/` | Electron runtime (win32-x64) |
| `llamacpp/cpu/` | llama.cpp Windows CPU build (bundled VC++ runtime DLLs) |
| `llamacpp/cuda/` | llama.cpp Windows CUDA build |
| `models/answer/` | Qwen3-0.6B GGUF Q8_0 (answer generation) |
| `models/answer-q4km/` | Qwen3-0.6B Q4_K_M (CPU-profile answer model) |
| `models/embedding/` | Qwen3-Embedding-0.6B GGUF Q8_0 (1024-dim) |
| `models/reranker/` | Qwen3-Reranker-0.6B GGUF Q8_0 |
| `python/` | Python 3.12 embeddable, build pipeline only |

The full set is also shipped in the release archive (see the repository README), so reviewers do not
need to assemble it manually.

## Licenses

All bundled components keep their own licenses: Electron (MIT), llama.cpp (MIT), Qwen3 models
(Apache-2.0), Python (PSF-2.0). See each subdirectory README.
