# Desktop frontend — Electron main process + React renderer

## Stack

Electron 44, React 18, TypeScript 5.6, Vite 5 (electron plugin). Node 24 is bundled by Electron.

## Build

```powershell
cd workspace/query/frontend
npm run build          # tsc -b && vite build
npm run assemble       # assemble the app into workspace/bin
npm run build:launcher # one-click launcher (uses the system csc.exe)
```

## Layout

```
frontend/
├─ electron/          # main process, preload, lifecycle
├─ src/               # React app (components, hooks, lang provider, viz)
├─ scripts/           # assemble + smoke-test scripts
├─ public/            # static assets
├─ dist/              # vite build output (not committed)
└─ package.json
```

## Smoke tests

```powershell
npm run smoke:3way      # all retrieval paths (starts a temporary embedding service)
npm run smoke:text       # text path only
npm run smoke:graph      # graph path only
npm run smoke:retrieval  # embedding / reranker sanity
node scripts/smoke-user-kb.cjs   # user knowledge base (24 checks)
```

A successful run prints `RESULT OK`. See the repository root README for the Windows notes.
