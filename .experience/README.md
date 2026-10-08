# `.experience/` — the installed runtime

Everything in this directory is **runtime**: `bin/init.js`, `sync-install.sh`,
`setup*.sh` and the `Dockerfile` copy it to `~/.experience` (or
`/home/node/.experience` in the image), and the agent hooks run it from there.
Paths inside it are part of the install contract, so do not rename or move
files here without updating `package.json#files`, `bin/init.js` and
`sync-install.sh` together.

| Path | Role |
|---|---|
| `experience-core.js` | Thin facade over `src/`; the public API the hooks and the server load |
| `src/` | All engine logic (config, Qdrant I/O, scoring, evolution, router, experiment, …) |
| `interceptor*.js`, `posttool-batch-hook.js`, `stop-extractor.js`, `judge-worker.js` | Agent hooks. **Their stdout is the hook protocol** — never log to stdout from them; record a dropped error with `src/swallow.js` |
| `remote-client.js`, `exp-client-drain.js` | Thin-client transport and offline queue |
| `exp-recall.js`, `exp-feedback.js` | Commands agents call directly |
| `register-hooks.js`, `inject-agent-instructions.sh`, `setup*.sh`, `setup.ps1`, `sync-install.sh` | Installers |
| `tools/` | Runtime tools installed to `~/.experience/tools` (`bulk-extract`, `import-memory`, …) |

Not here, on purpose:

- Operator scripts run from a checkout (seed ingest, doc → experience, scope
  narrowing) live in `scripts/maintenance/`; their batch manifests in `data/batches/`.
- One-shot Qdrant migrations live in `tools/migrations/`.
