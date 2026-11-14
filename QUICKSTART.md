# QUICKSTART — run the system in five minutes

Windows 10/11 x64. No installation, no internet connection, no administrator rights.

## 1. Get the archive

Download the release archive from Zenodo — DOI
[10.5281/zenodo.24198739](https://doi.org/10.5281/zenodo.24198739) — and check its integrity:

```powershell
(Get-FileHash .\shipdiag-v0.5.1-win-x64.zip -Algorithm SHA256).Hash
```

The archive is `shipdiag-v0.5.1-win-x64.zip` (4,370,640,185 bytes); its checksum and the rest of the
payload list are in [DEPOSIT.md](DEPOSIT.md).

## 2. Extract

- Extract to a **local disk** folder (for example `D:\ship-diagnosis`).
- Do **not** extract into OneDrive, a network share or a cloud-synced folder: first start becomes very
  slow and may fail offline.
- Keep the folder structure intact; the whole folder can be renamed, moved or copied to a USB drive.

## 3. Run

Double-click **船舶故障诊断系统.exe** (or the fallback `启动.bat`).

The first start is slow (about 6-7 s to "models ready" on the development machine): Windows scans the
files, the UI cache is built, the GPU is detected and three local models are loaded. Later starts are
faster. If Windows SmartScreen or antivirus blocks the file:

- right-click the .exe -> Properties -> **Unblock** -> Apply, then run it again; or
- click "More info" -> "Run anyway".

## 4. Ask a question

Type a question about the electrical equipment, for example:

> 故障树分析法由哪几部分组成？

The answer is generated locally (Qwen3-0.6B) from the retrieved evidence. The evidence panel lists the
numbered citations (`[1]`, `[2]`, ...) with the chunk ids they come from, and the diagnostic tree shows
"what to check first". The header switch toggles `EN` / `中文` instantly, without reloading the page.
Screenshots of the English UI (Q&A, evidence panel, knowledge-graph overview) are in
[docs/screenshots/](docs/screenshots/).

## 5. GPU or CPU?

- NVIDIA GPU: acceleration is detected and used automatically.
- No GPU: the app tells you once and switches to the CPU profile (same functionality, slower answers).
  The CPU profile uses the smaller Q4_K_M answer model.

## 6. Reset

Both directories can be deleted at any time; they are recreated on the next start:

| Directory | What it holds |
|---|---|
| `data\runtime\` | sessions and logs (deleting clears history) |
| `data\user_data\` | knowledge you added yourself |

The program never connects to the network; nothing leaves the machine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "bad option: --remote-debugging-port" in a terminal | the shell is running Electron as Node — unset `ELECTRON_RUN_AS_NODE` and retry, or double-click in Explorer |
| Very slow first start | the folder is on OneDrive / network / USB — move it to a local disk |
| Antivirus removed the .exe | restore it and add the folder to the allow list (the binary is unsigned) |
| Model ports busy | close other llama.cpp instances; the app uses ports 18081-18083 |
