# experience-engine - Deep Map

> Repo-level map for Experience Engine. Read this before changing runtime behavior,
> hook behavior, storage, deployment, or tests.

---

## Purpose

`experience-engine/` is a zero-runtime-dependency Node.js system that lets coding
agents learn from previous sessions. It captures tool context, surfaces
pre-tool warnings, records feedback, evolves repeated lessons into principles,
and can run either fully local or as a thin client against a server.

Core operating modes:

- **Local mode**: hooks call `.experience/experience-core.js` directly and use
  Qdrant when available, otherwise FileStore under `~/.experience/store/<user>/`.
- **Thin-client/server mode**: hooks call `server.js` over HTTP; server handles
  Qdrant/FileStore, extraction, feedback, stats, gates, routing, and brain proxy.
- **Packaged npm mode**: `bin/experience-engine.js` installs or controls the
  runtime files published via `package.json.files`.

---

## Top-Level Entry Points

| Path | Purpose |
|------|---------|
| `README.md` | Product overview, quick start, docs links |
| `package.json` | npm package metadata, published files, CLI entry points, scripts |
| `server.js` | Main REST API runtime, auth, rate limiting, Qdrant-facing server flows |
| `Dockerfile` | Container image build for server deployment |
| `docker-compose.yml` | Local full-stack bootstrap; binds Qdrant, Ollama, and API to localhost |
| `REPO_DEEP_MAP.md` | This repo navigation map |
| `CONTRIBUTING.md` | Contribution guide |

---

## CLI and Install Surface

| Path | Purpose |
|------|---------|
| `bin/experience-engine.js` | Main npm CLI entry point |
| `bin/cli.js` | CLI wrapper/helper; dispatches `init` + `sync` to Node, other commands to bash |
| `bin/init.js` | Cross-platform (no-bash) installer: auto-detects local/docker/remote brain, installs thin-client file set (+ `tools/{bulk-extract,import-memory}.js` and their `THIN_SAFE_SRC` closure), writes `config.json`, wires hooks via `register-hooks.js`, injects agent MD block. Node port of `setup-thin-client.sh`; runs natively on Windows |
| `bin/sync.js` | Cross-platform (no-bash) port of `upgrade.sh --sync-only`: runs `tools/bulk-extract.js` (sessions → `/api/extract`) + `tools/import-memory.js` (curated `MEMORY.md` → `/api/import-memory`), writes `.last-sync.json`. Prefers installed `~/.experience/tools` copies, falls back to packaged. `--upgrade` re-runs `init --yes` first |
| `.experience/setup.sh` | Interactive/full setup script |
| `.experience/setup-thin-client.sh` | Thin-client bootstrap against a remote server |
| `.experience/setup.ps1` | Windows setup path |
| `.experience/sync-install.sh` | Runtime file sync helper |
| `.experience/exp-shell-init.sh` | Shell bootstrap for hook integration |
| `.experience/register-hooks.js` | Hook registration helper |
| `.experience/health-check.sh` | Runtime health validation |
| `.experience/remote-client.js` | Remote/thin-client transport layer |

---

## Runtime API Surface

`server.js` is a single-file HTTP server using Node built-ins only.

Important endpoints:

| Endpoint | Handler / Purpose |
|----------|-------------------|
| `GET /health` | Qdrant + FileStore health |
| `POST /api/intercept` | Query experience before a tool call |
| `POST /api/posttool` | Canonical post-tool reconciliation and judge enqueue |
| `POST /api/prompt-stale` | Reconcile prompt-only stale suggestions |
| `POST /api/extract` | Extract lessons from a session transcript |
| `POST /api/evolve` | Trigger evolution cycle |
| `GET /api/stats` | Observability data; supports read-token auth |
| `GET /api/gates` | Server-side readiness / gate report; supports read-token auth |
| `GET /api/timeline?topic=...` | Semantic timeline across principles, behavioral, and self-QA |
| `GET /api/graph?id=...` | Experience graph edges |
| `GET/POST /api/project-brief` | Breadth-first SessionStart digest: top-N project-scoped entries ranked by confidence×hits×recency (not similarity). GET (read-token) for observability/curl; POST for the SessionStart hook transport |
| `POST /api/recall` | Active agent self-query in **hybrid semantic-search mode** (`recallMode`): runs a **dense-vector leg + lexical full-text leg** and fuses per tier with **RRF** (`src/fusion.js` `hybridFuse`/`rrfFuse`/`lexicalRank`), so exact-term matches the embedding misses still surface. Casts a wider net (`recallTopK` per collection) and drops the passive-hint noise-control gates (positive lang/project/framework scope filters + min-search-score floor) so cross-repo/-language lessons surface; integrity gates kept (superseded / permanent-noise / irrelevant≥3 / learned exclusions / min-confidence). Lexical leg = **native Qdrant BM25** (scored sparse vector `text_bm25`, `modifier:"idf"` — Qdrant supplies idf; sparse vector built zero-dep by `src/sparse.js buildSparseVector`, values=term-freq, indices=FNV-1a hashes) via `qdrant.js searchCollectionSparse`; **falls back** to the boolean MatchText index on `text_search` (`searchCollectionLexical` + app-side `fusion.lexicalRank`) on un-migrated collections, then to vector-only. Write side: `evolution.js upsertEntry` probes `collectionSupportsSparse` → writes mixed `{"":dense, text_bm25:sparse}` when supported, dense-only otherwise (non-breaking before migration). Qdrant **cannot PATCH-add** a sparse vector to an existing dense-only collection: new installs are born with it (`setup.sh`), existing ones migrated by `tools/migrate-sparse-bm25.js` (snapshot-backed recreate + re-upload, dry-run default / `--apply`); `text_search` still backfilled by `tools/backfill-text-search.js`. Spans T0/T1/T2/self-QA, formatted with `[id col]` + 3 feedback verdicts (`followed`/`ignored`/`noise`), records SURFACE (not hit). Wiring: `server.js handleRecall` → `interceptWithMeta(…, {recallMode:true})`; `qdrant.js searchCollectionSparse/searchCollectionLexical/ensureTextIndex/setPayloadFields`; `scoring.js rerankByQuality({preserveOrder})` + `format.js formatPoints({skipSearchScoreGate})`. **Passive hints (PreToolUse/UserPromptSubmit)** stay vector-only by default but can opt into the same lexical leg via `getPassiveHybrid()` (env `EXPERIENCE_PASSIVE_HYBRID`, **default OFF** — passive is precision-tuned for Gate 4). When ON: lexical-only hits are **capped** (`getPassiveLexicalMaxAdds`, default 1) and given a **borderline display score** (`getPassiveLexicalDisplayScore`, default floor+0.10) so the existing scope + confidence + precision gates (NOT a new threshold) decide whether they surface; the floor is kept (unlike recall). `hybridFuse(..., {maxLexicalOnly})` enforces the cap. Toggle is env-only — no redeploy to enable/disable for A/B. |
| `POST /api/feedback` | Record agent verdict on a surfaced suggestion |
| `POST /api/principles/share` | Export a principle |
| `POST /api/principles/import` | Import a principle |
| `GET /api/user` | Current user identity |
| `POST /api/route-task` | Intelligent wrapper task routing |
| `POST /api/route-model` | Intelligent model-tier routing |
| `POST /api/route-feedback` | Record routing outcome feedback |
| `POST /api/brain` | Proxy brain LLM calls for clients behind a firewall |
| `POST /api/phase-outcome` | GSD phase-grain reinforcement, gated by `ENABLE_PHASE_OUTCOME=1` |
| `POST /api/pil-context` | Classification + retrieval in one call; used by muonroi-cli L1 |

Server config comes from `~/.experience/config.json` plus environment variables.
Qdrant config is resolved through `.experience/src/config.js`, so both flat keys
(`qdrantUrl`, `qdrantKey`) and nested keys (`qdrant.url`, `qdrant.key`) work.

---

## Hook and Engine Internals

| Path | Purpose |
|------|---------|
| `.experience/interceptor.js` | Agent hook entry; calls local core or remote client |
| `.experience/interceptor-prompt.js` | UserPromptSubmit hook: similarity-gated experience hints + **active-recall nudge** (one-line reminder to PULL via `exp-recall` injected per prompt, but ONLY when no hint surfaced that turn — survives context compaction that buries SessionStart/CLAUDE.md). Disable with `EXPERIENCE_RECALL_NUDGE=0`. **Trivial-prompt gate is config-driven** (no longer hardcoded): `getMinPromptLength` (`minPromptLength` / `EXPERIENCE_MIN_PROMPT_LENGTH`, default 10) + `getPromptSkipRegex` (`promptSkipWords[]` or `EXPERIENCE_PROMPT_SKIP_WORDS`, multilingual default incl. vi greetings; full override via `promptSkipPattern` / `EXPERIENCE_PROMPT_SKIP_PATTERN`). Fails open to hardcoded defaults if config.js can't load |
| `.experience/interceptor-session.js` | SessionStart hook; injects the breadth-first Project Brief once per session. Wired for Claude/Codex/Gemini/Antigravity (all expose a native SessionStart + `hookSpecificOutput.additionalContext`; Antigravity tagged `--runtime=antigravity`). **Also injects the "Who Am I" live profile block** (slice 2): composed FRESH on-device via `_loadProfileDeps()` → `getPrivacyLevel()` → `loadProfile()` → `renderProfileBlock()`, gated by privacy level (off ⇒ nothing), prepended to the brief in `additionalContext`. Independent of the slug (fires even with no project), never written to the brief cache. |
| `.experience/interceptor-post.js` | Post-tool reconciliation hook |
| `.experience/posttool-batch-hook.js` | Batched post-tool hook path |
| `.experience/experience-core.js` | Shared hook runtime facade and compatibility surface |
| `.experience/judge-worker.js` | Background judge/evolution worker |
| `.experience/extract-compact.js` | Extraction compaction logic |
| `.experience/activity-watch.js` | Activity watcher |
| `.experience/stop-extractor.js` | Extractor stop control |
| `.experience/source-meta-enrich.js` | Derives lang/framework/project metadata from paths |
| `.experience/narrow-scope.js` | Scope narrowing helper |
| `.experience/backfill-why-scope.js` | Why/scope backfill helper |
| `.experience/doc-to-experience.js` | Converts documentation into seedable experience records |
| `.experience/exp-recall.js` | CLI helper for active recall: POSTs `/api/recall`, prints formatted experience with `[id col]`. Thin-client aware (config baseUrl+token) |
| `.experience/seed-ingest.js` | Seed ingest helper |

---

## Shared Runtime Modules

Modules under `.experience/src/` are the preferred place for reusable runtime
logic. `server.js` and `.experience/experience-core.js` should call into these
modules instead of reimplementing cross-cutting behavior.

| Path | Purpose |
|------|---------|
| `.experience/src/config.js` | Config loader, encrypted values, env fallbacks, constants, collection list. Includes the "Who Am I" privacy getters: `getPrivacyLevel` (`privacyLevel` / `EXPERIENCE_PRIVACY_LEVEL`, default `off`), `getProfilePath`, `getSignalWindowDays` |
| `.experience/src/profile-render.js` | "Who Am I" v4.0 slice 2 — **pure** profile→directive renderer (no fs/wall-clock/`getPrivacyLevel` inside; caller passes `level` + `now`). `selectInjectableDims` (positive per-dim-NAME allowlist by tier + `ELIGIBLE_NAMESPACES` Tang-3 guard + per-tier confidence floor on top of the `value!=null` commit gate) and `renderProfileBlock` (marker-delimited `experience-profile:*` block, supersedes the static GSD profile by precedence). Golden-tested in `tests/profile-render.test.js` |
| `.experience/src/logger.js` | Structured JSON logger; `EXPERIENCE_LOG_LEVEL=debug` enables debug entries |
| `.experience/src/qdrant.js` | Qdrant I/O, Qdrant health cache, FileStore fallback, FileStore locks |
| `.experience/src/embedding.js` | Embedding provider + vector generation. Providers return `{vector, err}` (No-Silent-Catch: HTTP status/body + timeout/network classified, recorded as `errKind`/`status` on the embed cost-call). Per-request timeout configurable (`getEmbedTimeoutMs`, default 10s — provider tail-latency spikes >5s were being turned into hard failures by a fixed 5s abort) |
| `.experience/src/sparse.js` | Zero-dep BM25 sparse-vector builder (`buildSparseVector`, `fnv1a32`): term-freq values + FNV-1a-hashed indices for Qdrant native idf-scored lexical retrieval. `SPARSE_VECTOR_NAME='text_bm25'` |
| `.experience/src/brain-llm.js` | Brain LLM provider calls and fallback behavior |
| `.experience/src/intercept.js` | Intercept pipeline and extraction orchestration |
| `.experience/src/brief.js` | Project Brief builder: scroll project-scoped entries, rank by confidence×hits×recency, format 1-line index, per-project TTL cache |
| `.experience/src/context.js` | Context retrieval and PIL context helpers |
| `.experience/src/scoring.js` | Ranking, score gates, effective-score logic |
| `.experience/src/format.js` | Suggestion formatting and output filtering |
| `.experience/src/evolution.js` | Lesson evolution and principle formation |
| `.experience/src/noise.js` | Noise verdicts, suppression, ignored/irrelevant handling |
| `.experience/src/hittrack.js` | Hit counters and confirmation tracking |
| `.experience/src/graph.js` | Experience graph edge helpers |
| `.experience/src/router.js` | Task and model routing logic |
| `.experience/src/phase-outcome.js` | Phase outcome reinforcement |
| `.experience/src/query-builder.js` | Query construction helpers |
| `.experience/src/session.js` | Session/transcript helpers |
| `.experience/src/activity.js` | Activity log helper |
| `.experience/src/validate.js` | Request body validation |
| `.experience/src/utils.js` | Small shared utilities |
| `.experience/src/agent-md.js` | Managed agent-instruction block + injector (Node port of `inject-agent-instructions.sh`); used by `bin/init.js`. Keep `INSTRUCTION_BLOCK` in sync with the bash heredoc |

---

## Main Runtime Flow

```text
Agent hook
  -> .experience/interceptor*.js
  -> local .experience/experience-core.js
     or remote .experience/remote-client.js -> server.js
  -> source metadata enrichment
  -> embedding
  -> qdrant.searchCollection(...)
       -> Qdrant when healthy
       -> FileStore fallback when Qdrant is unavailable
  -> scoring + formatting + stale/noise gates
  -> warning/suggestion returned to agent
  -> post-tool feedback/reconciliation
  -> judge/evolution/extraction paths update stored experience
```

Important storage details:

- Qdrant availability is cached with separate TTLs for success and failure.
- FileStore writes use per-collection lock files and atomic temp-file renames.
- User isolation is applied through Qdrant filters and `~/.experience/store/<user>/`.
- Qdrant requests include `api-key` only when a key is configured.
- Collection dimensions follow `embedDim`, defaulting to `768`.

---

## Observability and Logging

Runtime logs are structured JSON lines through `.experience/src/logger.js`.

```json
{"ts":"2026-05-24T00:00:00.000Z","level":"info","msg":"extract_api_start","project":"example"}
```

Logging conventions:

- Use `logger.log(level, msg, meta)` for runtime logs.
- Use `logger.serializeError(err)` for error metadata.
- `error` writes to stderr; `warn`, `info`, and `debug` write to stdout.
- Default level is `info`; set `EXPERIENCE_LOG_LEVEL=debug` for verbose traces.
- CLI/tools may still write user-facing terminal output directly.

Stats and gates are primarily handled by:

| Path | Purpose |
|------|---------|
| `tools/exp-stats.js` | Stats aggregation and reporting |
| `tools/exp-gates.js` | Gate inspection and management |
| `tools/exp-hint-stats.js` | Hint stats |
| `tools/deep-health.js` | Deeper health checks |
| `tools/dashboard/` | Static dashboard rendering support |

---

## Admin and Maintenance Tools

| Path | Purpose |
|------|---------|
| `tools/exp-dogfood-loop.js` | Controlled live confirmation loop for organic lessons |
| `tools/exp-holdout-harness.js` | Seed-vs-holdout replay harness for novel-case proof |
| `tools/exp-demote.js` | Demotion or reclassification operations |
| `tools/exp-portable-backup.js` | Portable export/backup |
| `tools/exp-portable-restore.js` | Portable restore |
| `tools/exp-replay-sessions.js` | Replay recorded sessions/events |
| `tools/exp-replay-trajectory.js` | Replay trajectory analysis |
| `tools/exp-server-maintain.js` | Server maintenance flow |
| `tools/experience-bulk-seed.js` | Bulk seeding utility |
| `tools/qdrant-find.js` | Qdrant search/debug utility |
| `scripts/config-encrypt.js` | Config encryption helper |
| `scripts/split-bb-behavioral.mjs` | Behavioral seed split helper |
| `scripts/generate-changelog.js` | Changelog generator |
| `scripts/deploy-vps.sh` | VPS deployment helper |

---

## SDK, Specs, and Assets

| Path | Purpose |
|------|---------|
| `sdk/python/pyproject.toml` | Python SDK package definition |
| `sdk/python/muonroi_experience/` | Python client package |
| `sdk/python/test_client.py` | Python SDK test |
| `docs/openapi.yaml` | REST API schema |
| `docs/specs/2026-04-10-model-router-design.md` | Model router design |
| `docs/specs/2026-04-22-experience-formation-vnext.md` | Experience formation roadmap/spec |
| `docs/adrs/001-zero-npm-dependencies.md` | Zero dependency ADR |
| `docs/adrs/002-model-router-design.md` | Model router ADR |
| `docs/adrs/003-experience-formation-vnext.md` | Formation vNext ADR |
| `fixtures/holdout/` | Curated holdout fixtures for replay harness |
| `examples/seeds/` | Example seed data and docs |
| `demo.svg`, `demo.tape`, `demo.yml`, `demo.gif` | Demo assets |

---

## Tests

| Command | Coverage |
|---------|----------|
| `npm run lint` | ESLint over `server.js`, `.experience/experience-core.js`, `.experience/src/` |
| `npm test` | Node tests under `tests/*.test.js` |
| `npm run test:unit` | Internal `.experience/test-*.js` tests |
| `npm run test:holdout` | Holdout harness and fixtures |
| `npm run test:health` | Health check and setup tests |
| `npm run test:server` | End-to-end server checks |
| `npm run test:ci` | Main CI-style sequence |
| `npm run test:coverage` | Coverage report through `c8` |

High-signal tests by area:

| Area | Tests |
|------|-------|
| Qdrant/FileStore/config | `tests/qdrant-io.test.js`, `.experience/test-qdrant-io.js`, `.experience/test-update-point-payload.js` |
| Server auth/runtime | `tests/server-auth-runtime.test.js`, `tests/server-health-metrics.test.js`, `tools/test-server.js` |
| Intercept pipeline | `tests/interceptor.test.js`, `.experience/test-intercept-pipeline.js`, `.experience/test-hook-payloads.js` |
| Evolution/scoring/noise | `tests/experience-core-evolution.test.js`, `.experience/test-scoring.js`, `.experience/test-unused-hints.js` |
| Routing | `tests/server-route-task.test.js`, `tests/experience-core-task-routing.test.js`, `.experience/test-model-router.js` |
| Setup/CLI | `tests/npm-cli.test.js`, `.experience/test-setup.js`, `.experience/test-health-check.js` |

---

## Who Am I v4.0 — Profile Injection (slice 2)

The Stop hook (`stop-extractor.js maybeUpdateProfile`, slice 1) WRITES `~/.experience/profile.yaml`; the SessionStart hook (`interceptor-session.js`, slice 2) READS and INJECTS it. All on-device — the profile never transits the network and is never assembled server-side (Tang-3-never-off-device holds by construction).

- **Live check (full install):** set `privacyLevel: standard` in `~/.experience/config.json`, run `node .experience/tools/whoami.js --rebuild` to commit ≥1 dimension, start a fresh session in a known project, and confirm the SessionStart `additionalContext` contains `## Developer Profile (live`. Inspect `~/.codex/log/experience-hook-debug.jsonl` for the `profile_injected` / `profile_skip` / `profile_read_failed` records. Flip `privacyLevel: off` and confirm the block disappears next session.
- **Privacy gate:** enforced at INJECTION time (not trusted from the file) via a positive per-dimension-NAME allowlist keyed on the LIVE `getPrivacyLevel()` — `off`=[], `minimal`=3 Tang-1 work dims, `standard`/`full`=+5 Tang-2 dims; `full` is default-deny. A `standard→minimal` downgrade strips stale Tang-2 values even though they remain physically in `profile.yaml`.
- **Adaptation metric (deferred):** the hook emits a `{stage:'profile_injected', level, injected, chars}` breadcrumb; a future `tools/` aggregator can join injected sessions against signal-detector brevity/feedback axes from `activity.jsonl` to confirm the agent actually adapts.
- **Deferred:** user-edit DURABILITY (a per-dim override flag honored by `aggregateProfile`, which currently re-derives every dim each Stop write — a hand-edited `value:` is rendered verbatim but reverted on the next aggregation); thin-client `minimal`-tier data source (local `activity.jsonl` isn't written on thin clients, so Tang-1 dims stay pending there — `standard`-tier transcript signals still work); the static agent-md companion directive (parameterize `applyBlock` + bash twin); full migration of the GSD `## Developer Profile` block.

## What to Read First by Task

| Task | Read first |
|------|-----------|
| Understand setup/deployment | `README.md`, `Dockerfile`, `docker-compose.yml`, `.experience/setup*.sh` |
| Modify CLI/install flow | `package.json`, `bin/experience-engine.js`, `.experience/setup*.sh`, `.experience/sync-install.sh` |
| Modify hook behavior | `.experience/interceptor*.js`, `.experience/experience-core.js`, `.experience/src/intercept.js` |
| Modify server behavior | `server.js`, `.experience/src/config.js`, `.experience/src/qdrant.js`, `.experience/remote-client.js` |
| Modify Qdrant/FileStore behavior | `.experience/src/qdrant.js`, `.experience/src/config.js`, `tests/qdrant-io.test.js` |
| Modify logging | `.experience/src/logger.js`, `server.js`, `.experience/src/brain-llm.js`, `.experience/src/intercept.js` |
| Modify retrieval/scoring output | `.experience/src/context.js`, `.experience/src/scoring.js`, `.experience/src/format.js` |
| Modify learning semantics/gates | `docs/specs/2026-04-22-experience-formation-vnext.md`, `.experience/src/evolution.js`, `tools/exp-gates.js` |
| Modify noise or feedback handling | `.experience/src/noise.js`, `.experience/src/hittrack.js`, `server.js` feedback endpoints |
| Modify task/model routing | `.experience/src/router.js`, `docs/specs/2026-04-10-model-router-design.md`, routing tests |
| Work on SDK | `sdk/python/` |
| Update API docs | `docs/openapi.yaml`, `server.js` endpoint handlers |

---

## Current Architecture Notes

- Runtime code should remain compatible with Node.js 20 and CommonJS.
- Avoid adding runtime npm dependencies unless the zero-dependency ADR changes.
- Keep user-facing CLI output separate from runtime structured logs.
- Preserve thin-client compatibility when changing request/response bodies.
- Prefer `.experience/src/` modules for shared logic and keep `server.js` as HTTP
  orchestration.
- When changing hooks, update both prompt and post-tool paths if behavior spans
  both phases.
- When changing storage, verify both Qdrant and FileStore fallback behavior.
