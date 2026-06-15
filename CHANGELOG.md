# Changelog

## [Unreleased]

## [0.3.0] - 2026-06-15

### Added
- **2026-06-15:** `PostToolBatch` is now a first-class hook shipped across all
  install paths. `posttool-batch-hook.js` is published in the npm package
  (`files`), copied by `npx … init`, `setup-thin-client.sh`, and `setup.sh`, and
  wired by `register-hooks.js` via the optional `EXP_INTERCEPTOR_BATCH` env
  (Claude Code only; backward-compatible — skipped when unset). Previously the
  hook existed but reached only full `setup.sh` machines.

### Fixed
- **2026-06-15:** Windows libuv crash in `posttool-batch-hook.js`
  (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:76`).
  `process.exit()` raced the undici keep-alive socket (and a pending stdin read)
  mid-teardown. Now sends `Connection: close`, reads stdin to natural `end` with
  an unref'd watchdog, and drains via `process.exitCode` instead of
  `process.exit()` on the main path — matching the sibling hooks and
  `remote-client.js`. Reproduced 3/3 before, 0 after.

## [0.2.0] - 2026-06-15

### Added
- **2026-06-15:** cross-platform `npx @muonroi/experience-engine init` installer
  (`bin/init.js`) — Node-native, no `bash`/Git Bash dependency, runs on Windows.
  Auto-detects a brain (local `:8082` → offer Docker → remote thin-client),
  installs the thin-client runtime, wires agent hooks via `register-hooks.js`,
  and injects the managed agent-instruction block (`.experience/src/agent-md.js`,
  a Node port of `inject-agent-instructions.sh`). README Quick Start now leads
  with `npx … init`; docker-compose demoted to "Self-host the brain (advanced)".
- **2026-05-13:** add `/api/pil-context` endpoint (PIL unified call;
  consolidates 5-6 brain round-trips into 1; 5-min LRU cache). Spec:
  `muonroi-cli/docs/superpowers/specs/2026-05-13-pil-unified-brain-endpoint-design.md`.

### Fixed
- **scope**: `applyScopeFilter` is now fail-closed for org-tagged points when
  no org is configured. Previously, the post-`1b184df` org-agnostic refactor
  meant legacy data tagged `scope.org=muonroi` (or any other org) leaked into
  every project that shared the Qdrant brain. Now: a point with `scope.org`
  is dropped unless the local install has `org.name` set OR opts in via
  `org.globalScope=true` in `~/.experience/config.json`.
  (`.experience/experience-core.js` applyScopeFilter)
- **scoring**: `hitBoost` is capped at `HIT_BOOST_MAX=0.12` and bypassed
  entirely for seed entries (`createdFrom: 'seed-…'`). Previously, an
  unbounded organic boost let a stale 100-hit 0.45-cosine entry overtake a
  fresh 0-hit seed at 0.85 cosine, inverting the seed-promote intent.
  (`.experience/src/scoring.js`)
- **scoring**: `computeEffectiveConfidence` bypasses `ageFactor` for seeds.
  Previously a 0.7-base seed with 0 hits fell to 0.49 and was filtered
  below `minConfidence` at display time, even when retrieval was perfect.
- **scoring**: seeds no longer take `projectPenalty`. They originate from
  org/common docs, not project files; `_projectSlug` is missing by design.
  Cross-repo leakage is already prevented by the new org-stack gate.
- **query**: `extractCodeSymbols` is bounded — hard cap at 8000 chars of
  input and 2000 regex iterations. Prevents pathological diffs (long runs
  of `IFooService` / similar identifiers) from blowing latency on the hot
  intercept path. (`.experience/src/utils.js`)
- **upgrade.sh**: requires `node` in `PATH` before invoking `node -e` for
  mode detection; previously a missing Node silently propagated `MODE=""`
  and hit a useless catch-all. Also rejects non-string `c.version`.

### Tests
- `.experience/test-scope-fixes.js` — seed bypass + extractCodeSymbols bound.
- `.experience/test-scoring.js` — NOISE-01 updated for `HIT_BOOST_MAX`.

### Breaking

- **Engine is now org-agnostic.** Removed all hardcoded references to a
  specific organization name (previously `muonroi`) and consumer-repo
  whitelist (`storyflow`, `quick-codex`, `experience-engine`). Cross-project
  hint filtering is now driven entirely by `~/.experience/config.json`:
  ```json
  { "org": { "name": "<your-org>", "repoPatterns": ["<extra-slug>", "prefix-*"] } }
  ```
  When `org` is absent the engine runs in **global mode** — every hint is
  eligible, no leak gate. To opt back into filtering, re-run `setup.sh` and
  answer the new **Step A.5 — Org Binding** prompt (or set `EXP_ORG_NAME` /
  `EXP_ORG_PATTERNS` for non-interactive mode).
- `utils.isMuonroiStackRepo()` / `utils.getMuonroiStackRepos()` removed.
  Replaced by `utils.isOrgStackRepo(filePath, orgConfig)`. Downstream callers
  outside this repo must update.
- The previous `seed-entries.jsonl` (org-doc sample seeded from the author's
  own stack) moved to `examples/seeds/org-doc.example.jsonl`. The universal
  `seed-common-principles.jsonl` at repo root is unchanged and still safe to
  ingest as-is.

### Migration

Existing users running on the old hardcoded gate keep working without action:
just add an `org` block to your `~/.experience/config.json` when convenient
(or re-run `setup.sh` — your other settings are preserved). Without it, the
engine surfaces every hint instead of dropping org-tagged ones in foreign
repos.

## [0.1.1] - 2026-05-05

### Features

- OpenAPI spec, config encryption at rest (G10 + G20) (8ebc96e)
- rate limiting, /metrics endpoint, enhanced health with alerting (ecb60ee)
- embed inline feedback API in hint output (8212640)
- context-aware brain routing + Qwen3-14B + role constraint (2ac0285)
- **06-02:** add /api/search endpoint to experience-engine server.js (PIL-02 cross-repo) (88ff403)

### Bug Fixes

- metrics endpoint always emits 24h counters even without activity.jsonl (d980147)
- sync-install.sh and setup-thin-client.sh copy src/ modules (a9c1615)
- resolve 3 breaking issues from modular refactor (495088a)
- align src/qdrant.js with core behavior + add delegate (01a8d43)
- align src/embedding.js with core behavior + full delegate (481cd51)
- align src/utils.js with core behavior (verbatim extract) (a4753d2)
- embed resilience, evolution stability, data lifecycle, precision filtering (0dedc6c)
- update tests for brain-delegated classification + improve TASK_ROUTE_PROMPT (a66784c)
- rewrite CLASSIFY_PROMPT for Qwen3 few-shot format (85aa60f)
- improve CLASSIFY_PROMPT to bias toward fast tier (48142cd)
- rewrite CLASSIFY_PROMPT for language-agnostic tier detection (c191b0d)
- repair multiline string literal in error_fix detection (c34542b)
- **quick-01:** lower abstraction cosine threshold and min cluster size, deploy (d484a1f)
- **quick-01:** strengthen project-scope filter and tighten error_fix detection (48d04a7)

### Refactoring

- slim core from 3553 to 1909 LOC (-46%) (1af20fb)
- remove ~600 LOC duplicate function bodies from core (Group C) (662a963)
- extract evolution.js, router.js + add SELFQA_COLLECTION, setQdrantAvailable (4c6262f)
- extract brain-llm.js, format.js, graph.js (1c19c2d)
- extract src/noise.js (6a095d6)
- extract src/scoring.js (3e1a9d7)
- extract src/context.js (420f403)
- extract src/session.js (c1a389c)
- delegate ~40 functions from experience-core.js to extracted modules (1e20aa7)
- extract shared utility functions from experience-core.js (c8ee0f0)
- extract qdrant I/O module from experience-core.js (2c0ced4)
- extract config and embedding modules from experience-core.js (3c9abe5)
- remove hardcoded keyword classifiers, delegate to brain (1226b16)

### Documentation

- update PLAN.md with v2 refactoring plan (c944e80)
- **quick-260501-rqc:** Fix EE v3 tuning: project-scope filter, error_fix detection, abstraction threshold (ee32bf5)
- **quick-01:** complete 260501-rqc EE v3 tuning plan summary (ccfffce)

### Tests

- add P0 test coverage for intercept, embedding, and qdrant-io modules (23432b1)

### Chores

- add ESLint, Prettier, Docker publish, Python SDK CI, changelog script (bfb4dbe)

