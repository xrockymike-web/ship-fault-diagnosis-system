# Contributing to the Ship Fault Diagnosis System

Thanks for your interest. This project is a Windows desktop application for offline,
knowledge-graph-augmented RAG question answering over marine electrical maintenance knowledge.
Contributions of code, documentation, tests and bug reports are welcome.

## Repository layout

| Path | Purpose |
|---|---|
| `workspace/query/` | Application source (TypeScript): retrieval, evidence prompt, answer orchestration, desktop UI |
| `workspace/build/` | Corpus / graph / index build pipeline (Python) |
| `workspace/data/` | Tracked knowledge assets: corpus, chunk/graph inputs, English layer, manifests |
| `workspace/environment/` | Download placeholders for runtimes and model weights (not tracked) |
| `experiment/` | Evaluation harness and the public question/answer export |
| `docs/` | Screenshots and user documentation |

Large payloads (model weights, SQLite stores, Electron runtime) are **not** tracked; see `DEPOSIT.md`.

## Development setup

Requirements: Windows 10/11 x64, Node.js 24.21.0, and the payloads described in `DEPOSIT.md`.

```powershell
cd workspace/query/frontend
npm ci                                  # dependencies (the repository .npmrc pins a mirror)
npm run build                           # tsc -b && vite build -> workspace/bin/resources/app
npm run assemble                        # assemble the Electron runtime into workspace/bin
npm run app                             # build, assemble and launch
```

> Windows note: when launching from an Electron-hosted shell (e.g. a terminal inside an
> Electron app), unset `ELECTRON_RUN_AS_NODE` first; otherwise the bundled Electron runs in
> Node mode and exits with `bad option`. Double-clicking in Explorer is unaffected.

## Tests and quality gates

- `npx tsc -b` (in `workspace/query/frontend`) type-checks the application and must stay clean.
- Smoke scripts under `workspace/query/frontend/scripts/` exercise the retrieval pipeline and the
  UI; they require the local model services and the SQLite stores to be present, so they are run
  manually, not in CI.
- CI (GitHub Actions) runs the model-free jobs: install, type-check and build. Any new model-free
  test belongs in the CI job; anything that needs models must be documented as manual.

## Coding guidelines

1. **UI strings go through the i18n layer.** Never hard-code user-visible text in components.
   Write the Chinese source string inside `tr("...")` and add the English entry to
   `workspace/query/frontend/src/lang/messages.ts` (`Msg` is the enforced key type).
2. **TypeScript must stay erasable.** The backend is executed with native type stripping, so avoid
   enums, namespaces and other non-erasable syntax.
3. **The renderer never talks to model ports.** All model and database access happens in the
   backend (`qa-core`); the renderer only receives results.
4. **Do not add dependencies casually.** If a new package is required, explain why in the PR.
5. **Never commit** model weights, SQLite stores, `data/runtime/`, `data/user_data/`, logs or
   secrets. Runtime data lives under `data/` only.

## Commit and PR conventions

- Branch names: `feat/...`, `fix/...`, `docs/...`.
- Commit messages: short imperative subject, optional scope, e.g. `fix(ui): graph page i18n`.
- A PR should: build, pass `tsc -b`, keep UI text internationalised, and describe user-visible
  changes (with a screenshot for UI work).
- User-visible behaviour changes should update `README.md`, `QUICKSTART.md` or this guide.

## License

The project is licensed under Apache-2.0. By contributing you agree that your contribution is
provided under the same license.
