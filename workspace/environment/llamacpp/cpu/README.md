# llama.cpp — Windows CPU build

| | |
|---|---|
| Version | b11205 (`llama-server.exe --version` self-reports 0.5.0-dev, commit 95887577a) |
| Download | https://github.com/ggml-org/llama.cpp/releases/download/b11205/llama-b11205-bin-win-cpu-x64.zip |
| sha256 | `2A8BF1FF808E8F6D2329F50F7005419A9930D9ECFBEAE5047CFFF475E87C2DB0` |
| License | MIT |

The archive must also provide the Visual C++ runtime DLLs (`msvcp140.dll`, `vcruntime140.dll`,
`vcruntime140_1.dll`) next to `llama-server.exe`; a clean Windows installation does not ship them.
Unzip flat into this directory.
