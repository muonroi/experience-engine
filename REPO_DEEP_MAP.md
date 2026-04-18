# experience-engine — Deep Map

> Repo-level map for Experience Engine. Read this before exploring the repo.

---

## Purpose

`experience-engine/` provides a hook-driven system that captures mistakes, surfaces pre-tool warnings, evolves lessons into principles, and can run in local or thin-client/server modes.

---

## Top-Level Entry Points

| Path | Purpose |
|------|---------|
| `README.md` | Product overview, setup flows, local vs VPS guidance, REST API summary |
| `package.json` | npm package metadata, published files, CLI entry points |
| `server.js` | Main server runtime |
| `Dockerfile` | Container image build for server deployment |
| `docker-compose.yml` | Local full-stack bootstrap with dependencies |
| `CONTRIBUTING.md` | Contribution guide |

---

## CLI and Runtime Surface

| Path | Purpose |
|------|---------|
| `bin/experience-engine.js` | Main npm CLI entry point |
| `bin/cli.js` | CLI wrapper/helper |
| `.experience/setup.sh` | Interactive/full setup script |
| `.experience/setup-thin-client.sh` | Thin-client bootstrap against a remote server |
| `.experience/setup.ps1` | Windows setup path |
| `.experience/exp-shell-init.sh` | Shell bootstrap for hook integration |
| `.experience/health-check.sh` | Runtime health validation |
| `.experience/remote-client.js` | Remote/thin-client transport layer |

---

## Hook and Engine Internals

| Path | Purpose |
|------|---------|
| `.experience/interceptor.js` | Core intercept logic |
| `.experience/interceptor-prompt.js` | Prompt-side interception helpers |
| `.experience/interceptor-post.js` | Post-tool reconciliation path |
| `.experience/experience-core.js` | Shared runtime logic |
| `.experience/judge-worker.js` | Background judge/evolution worker |
| `.experience/extract-compact.js` | Extraction compaction logic |
| `.experience/activity-watch.js` | Activity watcher |
| `.experience/stop-extractor.js` | Extractor stop control |
| `.experience/backfill-why-scope.js` | Why/scope backfill helper |

---

## Admin and Maintenance Tools

| Path | Purpose |
|------|---------|
| `tools/exp-gates.js` | Gate inspection and management |
| `tools/exp-stats.js` | Stats reporting |
| `tools/exp-demote.js` | Demotion or reclassification operations |
| `tools/exp-portable-backup.js` | Portable export/backup |
| `tools/exp-portable-restore.js` | Portable restore |
| `tools/exp-replay-sessions.js` | Replay recorded sessions/events |
| `tools/exp-server-maintain.js` | Server maintenance flow |
| `tools/experience-bulk-seed.js` | Bulk seeding utility |

---

## SDK and Tests

| Path | Purpose |
|------|---------|
| `sdk/python/pyproject.toml` | Python SDK package definition |
| `sdk/python/muonroi_experience/` | Python client package |
| `sdk/python/test_client.py` | Python SDK test |
| `tests/npm-cli.test.js` | npm CLI coverage |
| `.experience/test-*.js` | Hook/runtime test coverage under the internal engine surface |

---

## Supporting Assets

| Path | Purpose |
|------|---------|
| `docs/` | Additional repo-local documentation |
| `demo.svg`, `demo.tape`, `demo.yml` | Demo assets |
| `.quick-codex-flow/` | Local Quick Codex artifacts used during repo work |

---

## What to Read First by Task

| Task | Read first |
|------|-----------|
| Understand setup/deployment | `README.md`, `Dockerfile`, `docker-compose.yml` |
| Modify CLI/install flow | `package.json`, `bin/experience-engine.js`, `.experience/setup*.sh` |
| Modify hook behavior | `.experience/interceptor*.js`, `.experience/experience-core.js` |
| Modify server behavior | `server.js`, `.experience/remote-client.js`, `tools/` |
| Work on SDK | `sdk/python/` |
