# query — application code

Module overview. In the source repository the modules are TypeScript (`*.ts`); the release
archive ships the same directory layout with compiled `*.js`.

| Directory | Responsibility |
|---|---|
| `text-retrieval/` | lexical (FTS + trigram) and dense text retrieval; English lexical path in `en.ts` |
| `graph-retrieval/` | entity seeding, causal path search, co-occurrence layer, local subgraphs |
| `evidence-prompt/` | six-segment prompt assembly with numbered citations (English variant in `en.ts`) |
| `answer-generation/` | embedding/rerank client and answer orchestration |
| `qa-core/` | orchestration, sessions, user knowledge base, locale-aware bundle localisation |
| `launcher/` | path resolution, process management, runtime diagnostics |
| `config/` | retrieval / evidence / model / prompt configuration (JSON) |
| `shared/` | diagnostic tree builder, dial, locale helpers, shared types |
| `frontend/` | Electron main process + React renderer (see its README) |
| `i18n/` | English string resources for the interface |

The release archive additionally contains the compiled Electron entry points (`main.js`,
`preload.js`, `package.json`) at this level.

## Build (from source)

```powershell
cd workspace/query/frontend
npm run build      # tsc -b && vite build
npm run assemble   # assemble the application tree
```

See the repository root README for requirements, smoke tests and architecture.
