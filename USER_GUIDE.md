# User guide

Version 0.5.1 · Windows 10/11 x64 · fully offline

This guide describes how to use the application once it is running. For download, extraction and
the first launch, see [QUICKSTART.md](QUICKSTART.md). Screenshots of the English interface are in
[docs/screenshots/](docs/screenshots/).

## 1. First steps

Double-click `船舶故障诊断系统.exe`. The header shows the model status: when it reads
`Model ready` the local models are loaded and you can ask questions. The first start is slower
because the models are loaded into memory; later starts are faster.

The header also holds the language switch (`EN` / `中文`). Switching is immediate and does not
reload the page.

## 2. Q&A page (Fault Q&A)

**Ask a question.** Type a question about the equipment and press `Enter` (`Shift+Enter` inserts
a new line). Answers are generated locally from retrieved evidence.

**Sessions.** The left sidebar lists your sessions. Use `New session` to start fresh; click a
session to reopen it. Sessions are stored on this machine and survive restarts.

**While generating.** The `Stop` button interrupts generation; the text produced so far is kept.
After an answer, `Regenerate` re-runs the same question.

**Evidence and diagnosis.** Below each answer, the evidence panel lists the numbered citations
with their chunk ids and a searchable excerpt (`Expand full text`). The panel also shows the
co-occurrence associations (explicitly non-causal) and the evidence-tier rule. The header badge
(Sufficient / Partial / Insufficient) summarises how strong the retrieved evidence is.

**Three figures.** The answer is followed by three figures, which can be collapsed individually or
all at once from the top bar:
- *Related entities* — the knowledge-graph subgraph for this question, laid out in concentric hop
  rings; every node is labelled, and the label sits below its node. Hover a node for its name,
  type and edge count.
- *Graph paths (undirected)* — the diagnostic paths found in the graph.
- *What to check first* — the deterministic diagnostic tree (root = question anchor → matched
  symptom → cause → measure).

## 3. Knowledge-graph page

The overview shows the whole built-in graph with live statistics in the sidebar (entity and
relation counts, per-type breakdowns, isolated entities).

- **Filter** by entity name (type a name, press `Enter` or `Search`), by entity type or by
  relation type. `Show all` clears the filters. `Custom only` shows only the entries you added
  yourself.
- **Hover a node** to see its name, type and number of edges.
- **Zoom** with the mouse wheel or the `+` / `−` buttons; `⌂` restores the automatic layout.
- **Labels**: the most connected nodes are labelled; when you zoom in far enough, every node in
  the current view gets its label.
- **Drag** a node to pin it; double-click it to release it back to the automatic layout.

## 4. Knowledge management page

Add your own knowledge to the built-in base (kept in `data/user_data/`, never modifying the
built-in knowledge):

- **Entities** — name, type (the ontology has 7 entity types), aliases, description.
- **Triples** — connect two entities (one may be a built-in entity) with one of the 11 relation
  types.
- **Texts** — paste a maintenance note; it becomes retrievable evidence with a lower authority
  than the built-in knowledge base.

Your entries appear on the knowledge-graph page (custom nodes are outlined with a dashed ring).

## 5. Data, privacy and reset

The application runs fully offline: no network access, nothing leaves the machine. Runtime data
lives next to the program:

| Directory | Contents |
|---|---|
| `data\runtime\` | sessions, logs, caches (delete to clear history) |
| `data\user_data\` | knowledge you added yourself |

Both directories are recreated on the next start.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Header never shows `Model ready` | the model services are still loading, or a port is in use — check `data\runtime\logs\app.log` |
| `bad option: --remote-debugging-port` in a terminal | the shell is running Electron as Node — unset `ELECTRON_RUN_AS_NODE`, or double-click in Explorer |
| Very slow first start | the folder is on OneDrive / a network share / a USB stick — move it to a local disk |
| Antivirus removed the .exe | restore it and allow-list the folder (the binary is unsigned) |
| Answers are slow | CPU mode is active (no CUDA GPU); this is expected and documented in the header |
