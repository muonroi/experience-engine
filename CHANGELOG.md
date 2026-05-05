# Changelog

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

