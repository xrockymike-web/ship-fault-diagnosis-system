# Qwen3-0.6B Q4_K_M — CPU profile answer model

| | |
|---|---|
| File | `qwen3.0.6B-Q4_K_M.gguf` (396,704,416 B) |
| sha256 | `15E434D8DDF0AF38FE3F7003AF6CE6EAC4EDADA6DF34324AA45979F9CC79F02E` |
| Source | requantized offline from `../answer/qwen3.0.6B-Q8_0.gguf` (sha256 `9465E63A…043BB031`) |
| License | Apache-2.0 (derived from the Qwen3-0.6B Q8_0 weights) |

Generated with the bundled `llama-quantize` tool:

```powershell
llama-quantize.exe --allow-requantize qwen3.0.6B-Q8_0.gguf qwen3.0.6B-Q4_K_M.gguf Q4_K_M
```

Note: this is a Q8_0 -> Q4_K_M requantization (no F16 source is published upstream), so quantization
loss can be larger than a regular Q4_K_M build. The CPU profile selects this file via
`workspace/query/config/models/default.json` (`cpu.answer`).
