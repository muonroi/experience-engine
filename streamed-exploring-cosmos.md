# Phase 2: Slim experience-core.js from 3553 → ~1200 LOC

## Context

After modular refactor (13 modules in `src/`), core still holds 3553 LOC because:
- 62 empty stub functions (overwritten by delegation) = ~200 LOC wasted
- ~800 LOC duplicate function bodies already in modules (brain providers, organic support utils, evolution helpers, router config getters)
- Delegation pattern (`_delegate*()`) keeps stubs + assigns at bottom = ~200 LOC boilerplate

Target: **~1200 LOC** — only business logic orchestrators that cannot be moved.

## Approach: 3 safe steps, no consumer API changes

All 30+ consumers (`interceptor.js`, `server.js`, tests, tools) keep `require('./experience-core.js')` — exports don't change.

---

## Step 1: Remove 62 empty stubs (~200 LOC saved)

**Files:** `.experience/experience-core.js`

Replace empty stub definitions with `let` variable declarations. The delegation functions already assign them.

**Before:**
```js
function sanitizeSessionToken(value) {}
function getSessionTrackFile(meta) {}
function readSessionTrack(meta) {}
// ... 62 of these
```

**After:**
```js
let sanitizeSessionToken, getSessionTrackFile, readSessionTrack;
// ... compact declarations
```

**Stubs to remove** (by section):
- Lines 152-194: 15 session/noise stubs → `let` declarations
- Lines 208-234: 12 utils/context stubs → `let` declarations  
- Lines 461-465: 3 noise metadata stubs → `let` declarations
- Lines 596-598: 2 source meta stubs → `let` declarations
- Lines 629-688: 2 extract path stubs → `let` declarations
- Lines 1082-1197: 10+ context/extract stubs → `let` declarations
- Lines 1753-1771: 8 scoring/format stubs → `let` declarations
- Line 2615: 1 getEmbeddingRaw stub → `let` declaration

**Risk:** Zero — delegation assigns the same variables.

---

## Step 2: Remove duplicate function bodies (~600 LOC saved)

**Files:** `.experience/experience-core.js`

Functions that exist BOTH in core (full body) AND in a module (full body), and are delegated:

### 2a. Brain provider functions (~80 LOC) → already in `src/brain-llm.js`
Remove from core, keep delegation:
- `brainOllama()` (line ~1326)
- `brainOpenAI()` (line ~1340)
- `brainGemini()` (line ~1364)
- `brainClaude()` (line ~1379)
- `brainDeepSeek()` (line ~1394)
- `callBrainWithFallback()` (line ~1408)
- `brainRelevanceFilter()` (line ~1290)

### 2b. Organic support utils (~100 LOC) → already in `src/evolution.js`
Remove from core:
- `organicSupportText()`
- `tokenOverlapRatio()`
- `conditionOverlapCount()`
- `buildOrganicSupportKey()`
- `isOrganicSupportCandidate()`
- `findOrganicSupportCandidate()`
- `applyOrganicSupportUpdate()`

### 2c. Evolution helpers (~100 LOC) → already in `src/evolution.js`
Remove from core:
- `uniqueConfirmationCount()`
- `hasRepeatedSessionConfirmations()`
- `resetPromotionProbation()`
- `shouldPromoteBehavioralToPrinciple()`
- `buildPrincipleText()`
- `parsePayload()`
- `clusterByCosine()`

### 2d. Format/store helpers (~50 LOC) → already in `src/format.js`
Remove from core:
- `buildStorePayload()`
- `normalizeEvidenceClass()`
- `normalizeConditions()`
- `normalizeFailureMode()`
- `normalizeJudgment()`
- `ensureAbstractionFields()`
- `ensureNovelCaseEvidence()`
- `isPrincipleLikeEntry()`

### 2e. Router config getters (~50 LOC) → already in `src/router.js`
Remove from core (lines 61-150):
- `isRouterEnabled()`
- `getRouterHistoryThreshold()`
- `getRouterDefaultTier()`
- `getModelTiers()`
- `getReasoningEffortTiers()`
- `normalizeReasoningEffort()`
- `validateCodexModel()`
- `validateCodexReasoning()`

### 2f. Qdrant/store helpers (~100 LOC) → already in `src/qdrant.js`
Remove from core:
- `getAllEntries()`
- `upsertEntry()`
- `deleteEntry()`
- `updatePointPayload()`
- `sharePrinciple()`
- `importPrinciple()`
- `migrateQdrantUserTags()`

### 2g. Graph helpers (~60 LOC) → already in `src/graph.js`
Remove from core:
- `createEdge()`
- `getEdgesForId()`
- `getEdgesOfType()`

**Risk:** Low — all these are overwritten by `_delegateAll()` at startup anyway. The only risk is if code between definition and delegation calls them before `_delegateAll()` runs, but `_delegateAll()` runs synchronously at module load time (line 3556).

---

## Step 3: Compact delegation boilerplate (~150 LOC saved)

**Files:** `.experience/experience-core.js`

Replace 10 individual `_delegate*()` functions with a single compact `_delegateAll()`:

**Before:** 10 functions × ~15 lines each = ~150 LOC
**After:** 1 function with object-spread assignments = ~40 LOC

```js
function _delegateAll() {
  const assign = (source) => { for (const [k, v] of Object.entries(source)) { eval cannot be used... } };
  // Better: explicit but compact
  Object.assign(module, { ...requires });
}
```

Actually, simpler approach — just use destructuring at top of file:

```js
// After all let declarations, do one-time assignment from modules
const _qdrant = require('./src/qdrant');
const _brain = require('./src/brain-llm');
// ...
checkQdrant = _qdrant.checkQdrant;
searchCollection = _qdrant.searchCollection;
// ...kept compact, no wrapper functions
```

**Risk:** Low — same effect, fewer lines.

---

## What STAYS in core (~1200 LOC)

| Block | ~LOC | Why |
|-------|------|-----|
| Imports + let declarations | 100 | Module requires + variable slots |
| `interceptWithMeta()` | 270 | Core orchestrator — calls all modules |
| `intercept()` wrapper | 5 | Backward compat |
| `reconcilePendingHints()` + stale | 200 | Session state machine |
| `assessHintUsage()` | 50 | Usage detection |
| `recordFeedback()` + variants | 100 | Verdict routing |
| `extractFromSession()` | 50 | Extract orchestrator |
| `storeExperience()` | 40 | Store + merge |
| `evolve()` | 180 | Promotion/demotion FSM |
| Signal updates (hit/surface/holdout) | 120 | Data mutation closures |
| `activityLog()` + helpers | 50 | Telemetry |
| `module.exports` | 35 | Re-export surface |
| **Total** | **~1200** | |

---

## Verification

After each step:
1. `node --test --test-concurrency=1 tests/*.test.js` — must be 71 pass, 0 fail
2. `node --test --test-concurrency=1 .experience/test-scoring.js .experience/test-project-noise.js .experience/test-detect-mistakes.js .experience/test-evolve-principles.js` — must pass
3. `node -e "const c = require('./.experience/experience-core.js'); console.log(Object.keys(c).length, 'exports')"` — must show same export count
4. `wc -l .experience/experience-core.js` — track LOC reduction

After all steps:
5. Deploy to VPS: `ssh ... "cd ~/experience-engine && git pull && bash .experience/sync-install.sh && pkill -f 'node.*server.js'; sleep 2; nohup node server.js &"`
6. Health check: `curl localhost:8082/health`
7. Intercept test: `curl -X POST localhost:8082/api/intercept -d '{"toolName":"Bash","toolInput":{"command":"git commit"}}'`

---

## Files modified

- `.experience/experience-core.js` — main target (3553 → ~1200 LOC)
- `.experience/sync-install.sh` — add `src/` directory copy (if not already)
- No changes to any `src/*.js` modules
- No changes to consumer files (interceptor.js, server.js, tests)
