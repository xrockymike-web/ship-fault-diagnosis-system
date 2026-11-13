# llama.cpp — Windows CUDA build

| | |
|---|---|
| Version | b11205 (CUDA variant, same upstream release as the CPU build) |
| Download | https://github.com/ggml-org/llama.cpp/releases (release tag `b11205`) |
| License | MIT |

Pick the CUDA 12.x (or 13.x) x64 asset matching the target machine. The archive must also provide the
runtime DLLs listed in `../cpu/README.md`. The application falls back to the CPU build automatically
when no usable NVIDIA GPU is detected.
