# workspace — source, data and runtime layout

There is **no pre-built executable in this directory**: build artifacts are not committed. The
published release archive (see `../QUICKSTART.md`) contains a ready-to-run tree; from this repository
you build it yourself in three commands.

## Build the entry point

Requirements: Node.js 24 (see `environment/nodejs/README.md`), and the Electron runtime + model
weights from `../DEPOSIT.md` placed under `environment/`.

```powershell
cd workspace/query/frontend
npm install          # installs Electron + Vite + React (uses .npmrc mirror settings)
npm run build        # tsc -b && vite build
npm run assemble     # assembles the app into workspace/bin/
```

After `assemble`, the entry point appears at:

```text
workspace/bin/船舶故障诊断系统.exe      <- double-click to run (or: npm run app)
```

`npm run app` does build + assemble + launch in one step.

## What is in this directory

| Path | Contents |
|---|---|
| `query/` | TypeScript source of the application (retrieval, prompting, orchestration, UI) |
| `build/` | knowledge-base build pipeline (see `build/README.md`) |
| `data/` | corpus, chunk/graph assets, manifests (see `data/README.md`) |
| `environment/` | download placeholders for Electron, llama.cpp, models, Node, Python |
| `bin/` | **created by the build** — Electron runtime + entry exe (not committed) |

At run time the app writes only to `data/runtime/` (sessions, logs) and `data/user_data/` (knowledge
you add yourself). Both are git-ignored and recreated on demand.

## Helper scripts

| File | Purpose |
|---|---|
| `switch-mode.ps1` | switches `answer.backend` between `cpu`, `cuda` and `auto` in `query/config/models/default.json` (and in `bin/resources/app/` when a build exists). Restart the app afterwards. |
| `切换CPU模式.bat` | double-click wrapper: `switch-mode.ps1 -Mode cpu` |
| `切换GPU模式.bat` | double-click wrapper: `switch-mode.ps1 -Mode cuda` |
| `verify-layout.ps1` | developer guard for the frozen directory layout. **It fails on a fresh clone** because it also checks `bin/` (the build output); run it after `npm run assemble`. |

```powershell
# switch answer generation to CPU (also works before building: it then edits only the source config)
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\switch-mode.ps1 -Mode cpu

# layout check (expect OK only after npm run assemble)
pwsh -File workspace\verify-layout.ps1

# module structure check (source only, no build needed)
pwsh -File workspace\query\verify-structure.ps1
```

## Where to go next

- run it: `../QUICKSTART.md` (release archive) or the build steps above
- what is not in the repository: `../DEPOSIT.md`
- rebuild the knowledge base: `build/README.md`
- experiment data: `../experiment/README.md`
