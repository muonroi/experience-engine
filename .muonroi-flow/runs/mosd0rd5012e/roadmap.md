# Phase 1: P0 Tests + Core Refactoring

## Objective
Viết tests cho intercept pipeline, embedding module, Qdrant I/O module — sau đó extract thành modules riêng từ experience-core.js

## Steps

### Step 1: interceptor.test.js (P0)
- intercept() returns null for read-only commands
- intercept() respects session budget (max 8 unique)
- interceptWithMeta() returns { suggestions, surfacedIds, route }
- interceptWithMeta() handles embedding failure gracefully
- intercept() deduplicates across T0/T1/T2
- intercept() probationary T2 surfacing
- intercept() scope filter (lang matching)
- intercept() noise suppression

### Step 2: embedding.test.js (P0)
- getEmbeddingRaw() calls provider correctly (Ollama, OpenAI-compatible, Gemini, VoyageAI)
- getEmbeddingRaw() retry on failure
- getEmbeddingRaw() fallback to Ollama
- getEmbeddingRaw() timeout handling
- getEmbeddingRaw() returns null on total failure

### Step 3: qdrant-io.test.js (P0)
- searchCollection() calls Qdrant query API
- searchCollection() falls back to FileStore when Qdrant unavailable
- fetchPointById() reads from FileStore when Qdrant unavailable
- updatePointPayload() updates FileStore entries
- deleteEntry() removes from FileStore
- syncToQdrant() reconciles FileStore → Qdrant

### Step 4: Extract modules
- src/intercept.js — intercept() + interceptWithMeta() + helpers
- src/embedding.js — getEmbedding() + provider functions + EMBED_PROVIDERS
- src/qdrant.js — searchCollection(), syncToQdrant(), deleteEntry(), fetchPointById(), updatePointPayload()
- experience-core.js becomes a thin re-export wrapper

## Success Criteria
- All existing tests pass after refactoring
- New tests cover all critical paths
- intercept/embedding/qdrant work as separate require()-able modules
- No behavior change detected by existing integration tests
