# Plan: Refactor experience-core.js thành Modules Nhỏ (v2)

## Mục tiêu
Tách `experience-core.js` (4083 LOC, 187 functions, 55 exported) thành các module riêng biệt.
Mỗi module độc lập, dễ maintain, dễ test. **Không đổi behavior.**

## Nguyên tắc
1. **Copy thuần tuý** — Copy nguyên văn function từ core sang module, không sửa 1 dòng logic
2. **Verify = chạy test** — Mỗi bước phải pass full test suite
3. **Delegate trước, xoá sau** — Giữ code dup trong core để đối chiếu, xoá sau cùng
4. **Atomic commit** — Mỗi module 1 commit riêng
5. **Zero deps** — Giữ nguyên pattern zero npm dependencies

---

## Dependency Graph

```
config.js (constants, config loader)
  ├── session.js (session tracking, dedup)
  ├── context.js (transcript parse, mistake detect, domain detect)
  ├── helpers.js (normalize, classify, validate)
  │
  ├── embedding.js (getEmbedding, providers)
  │     └── qdrant.js (Qdrant I/O, FileStore)
  │           ├── scoring.js (effectiveScore, confidence, rerank)
  │           │     ├── noise.js (suppression, metadata)
  │           │     │     ├── brain-llm.js (brain providers, classifyViaBrain)
  │           │     │     │     ├── format.js (formatPoints, buildPayload)
  │           │     │     │     │     ├── evolution.js (evolve, promote, cluster)
  │           │     │     │     │     │     ├── graph.js (edges)
  │           │     │     │     │     │     │     ├── router.js (routeTask, routeModel)
  │           │     │     │     │     │     │     │     ├── intercept-core.js (intercept, reconcile)
  │           │     │     │     │     │     │     │     │     └── experience-core.js (re-export all)
```

---

## Group A (P0) — Align Module Hiện Tại + Delegate

### Trạng thái hiện tại:
| Module | LOC | Functions | Aligned? | Delegated? |
|--------|:---:|:---------:|:--------:|:----------:|
| `src/config.js` | 128 | 27 | ✅ OK | ⚠️ partial (const aliases) |
| `src/utils.js` | 465 | 24 | ✅ JUST FIXED | ✅ full |
| `src/embedding.js` | 157 | 8 | ❌ chưa check | ⚠️ only 2/8 |
| `src/qdrant.js` | 308 | 16 | ❌ chưa check | ❌ 0/16 |

#### A1: Align `src/embedding.js` + verify
- So sánh từng function trong module vs core
- Copy function body từ core nếu khác
- Chạy `node --test .experience/test-embedding.js` → pass
- Update `_delegateEmbedding()` để delegate ALL 8 functions
- **Commit**: `fix: align src/embedding.js with core behavior + full delegate`

#### A2: Align `src/qdrant.js` + verify
- So sánh từng function trong module vs core
- Copy function body từ core nếu khác
- Chạy `node --test .experience/test-qdrant-io.js` → pass
- Tạo `_delegateQdrant()` và gọi từ `_delegateAll()`
- **Commit**: `fix: align src/qdrant.js with core behavior + add delegate`

#### A3: Align `src/config.js` — delegate `activityLog`
- `activityLog` tồn tại trong cả core và config.js
- Delegate qua `_delegateConfig()` hoặc gán trực tiếp
- **Commit**: `fix: delegate activityLog from src/config.js`

---

## Group B (P1) — Extract Module Mới

Mỗi bước: tạo file `.experience/src/<module>.js` → copy function bodies từ core → thêm `require('./config')` nếu cần → update `_delegate*` trong core → chạy test → commit.

### B1: `src/session.js` — Session tracking
- Từ core lines 143-308 (~165 LOC)
- Functions: `sanitizeSessionToken`, `getSessionTrackFile`, `readSessionTrack`, `writeSessionTrack`, `trackSuggestions`, `sessionUniqueCount`, `incrementIgnoreCountData`, `incrementIrrelevantData`, `incrementUnusedData`, `normalizeNoiseDisposition`, `normalizeNoiseSource`, `normalizeFeedbackVerdict`, `normalizeNoiseReason`, `shortPointId`, `pointSourceKey`, `dedupePointsBySource`, `dedupeSuggestionLines`
- Deps: `require('./config')` — dùng `EXP_USER`, constants
- Verify: `node --test .experience/test-intercept-pipeline.js` (test trackSuggestions)
- **Commit**: `refactor: extract src/session.js`

### B2: `src/context.js` — Context detection + transcript parse
- Từ core lines 1495-1622 (~130 LOC)
- Functions: `detectNaturalLang`, `parseTranscriptToolCall`, `isTranscriptReadOnlyToolCall`, `isMutatingTranscriptToolCall`, `extractRetryTarget`, `isTranscriptErrorSignal`, `detectTranscriptDomain`, `normalizeExtractText`, `isPlaceholderExtractField`, `isMetaWorkflowExtract`, `assessExtractedQaQuality`, `detectMistakes`
- Deps: `require('./config')`
- Verify: `node --test .experience/test-context.js`
- **Commit**: `refactor: extract src/context.js`

### B3: `src/scoring.js` — Scoring & Probation
- Từ core lines 2308-2425 (~120 LOC)
- Functions: `computeEffectiveConfidence`, `computeEffectiveScore`, `rerankByQuality`, `getSurfaceCountForProbation`, `hasProbationaryT2Debt`, `isProbationaryT2Candidate`, `selectProbationaryT2Points`
- Deps: `require('./config')` — dùng `getMinConfidence`, `getHighConfidence`, `SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD`, etc.
- Verify: `node --test .experience/test-scoring.js`
- **Commit**: `refactor: extract src/scoring.js`

### B4: `src/noise.js` — Noise suppression
- Từ core lines 656-710, 373-429 (~110 LOC)
- Functions: `ensureNoiseReasonCounts`, `ensureNoiseSourceCounts`, `recordNoiseMetadataData`, `applyNoiseDispositionData`, `incrementIrrelevantWithReasonData`, `shouldSuppressForNoise`, `filterNoiseSuppressedPoints`, `inferLanguageMismatch`, `hasRecentValidatedConfirmation`, `isCodeSpecificHint`
- Deps: `require('./config')`, `require('./scoring')` hoặc giữ inline
- Verify: `node --test .experience/test-project-noise.js`
- **Commit**: `refactor: extract src/noise.js`

### B5: `src/brain-llm.js` — Brain/LLM providers
- Từ core lines 1725-1928 (~200 LOC)
- Functions: `getBrainFallback`, `callBrainWithFallback`, `brainRelevanceFilter`, `extractQA`, `brainOllama`, `brainOpenAI`, `brainGemini`, `brainClaude`, `brainDeepSeek`
- Deps: `require('./config')` — dùng brain configs
- Verify: `node --test .experience/test-brain-llm.js`
- **Commit**: `refactor: extract src/brain-llm.js`

### B6: `src/format.js` — Format & Build payload
- Từ core lines 2059-2070, 2429-2468, 2477-2570, 2853-2868 (~120 LOC)
- Functions: `buildStorePayload`, `formatPoints`, `applyBudget`, `ensureSignalMetrics`, `normalizeEvidenceClass`, `normalizeConditions`, `normalizeFailureMode`, `normalizeJudgment`, `ensureAbstractionFields`, `ensureNovelCaseEvidence`, `isPrincipleLikeEntry`, `buildPrincipleText`
- Deps: `require('./config')`
- Verify: test gián tiếp qua test-scoring + test-intercept-pipeline
- **Commit**: `refactor: extract src/format.js`

### B7: `src/evolution.js` — Evolution pipeline
- Từ core lines 1938-2055, 2795-2870, 2870-3275 (~400 LOC — module lớn nhất)
- Functions: `tokenizeOrganicSupportText`, `organicSupportText`, `tokenOverlapRatio`, `conditionOverlapCount`, `buildOrganicSupportKey`, `isOrganicSupportCandidate`, `findOrganicSupportCandidate`, `applyOrganicSupportUpdate`, `storeExperience`, `uniqueConfirmationCount`, `hasRepeatedSessionConfirmations`, `resetPromotionProbation`, `shouldPromoteBehavioralToPrinciple`, `evolve`, `parsePayload`, `clusterByCosine`, `getAllEntries`, `upsertEntry`, `sharePrinciple`, `importPrinciple`, `migrateQdrantUserTags`
- Deps: `require('./config')`, `require('./embedding')`, `require('./qdrant')`, `require('./scoring')`, `require('./format')`
- Verify: `node --test .experience/test-evolve-principles.js`
- **Commit**: `refactor: extract src/evolution.js`

### B8: `src/graph.js` — Edge management
- Từ core lines 2755-2792 (~40 LOC)
- Functions: `createEdge`, `getEdgesForId`, `getEdgesOfType`
- Deps: `require('./config')`, `require('./qdrant')`
- Verify: test hiện có
- **Commit**: `refactor: extract src/graph.js`

### B9: `src/intercept-core.js` — Intercept pipeline
- Từ core lines 431-655, 838-865, 1075-1365 (~480 LOC)
- Functions: `assessHintUsage`, `reconcilePendingHints`, `promptStateSurfacedIds`, `isPromptOnlySuggestionState`, `reconcileStalePromptSuggestions`, `isHookRealtimeFastPath`, `isPromptHookPrecisionGate`, `promptHookScoreThreshold`, `filterPromptHookPoints`, `classifyActionKind`, `isReadOnlyCommand`, `interceptWithMeta`, `intercept`, `extractFromSession`
- Deps: HẦU HẾT các module khác — làm cuối cùng
- Verify: `node --test .experience/test-intercept-pipeline.js`
- **Commit**: `refactor: extract src/intercept-core.js`

### B10: `src/router.js` — Model routing
- Từ core lines 52-107, 3361-3964 (~600 LOC — module lớn)
- Functions: `isRouterEnabled`, `getRouterHistoryThreshold`, `getRouterDefaultTier`, `getModelTiers`, `getReasoningEffortTiers`, `normalizeReasoningEffort`, `validateCodexModel`, `validateCodexReasoning`, `preFilterComplexity`, `isQcFlowFrontHalfContext`, `maybeCapTierForCost`, `printRouteDecision`, `ensureRoutesCollection`, `classifyViaBrain`, `normalizeTierResponse`, `normalizeTaskRoute`, `foldClassifierText`, `preFilterTaskRoute`, `parseJsonObjectFromText`, `defaultTaskRouteOptions`, `normalizeTaskRoutePayload`, `buildTaskRoutePrompt`, `resolveTierModel`, `resolveTierReasoningEffort`, `buildModelRoutePrompt`, `shouldSkipKeywordModelPrefilter`, `storeRouteDecision`, `routeModel`, `routeTask`, `routeFeedback`
- Deps: `require('./config')`, `require('./embedding')`, `require('./qdrant')`
- Verify: `node --test tests/routing.test.js`
- **Commit**: `refactor: extract src/router.js`

---

## Group C (P2) — Cleanup + Remove Dup

### C1: Remove duplicate function bodies từ core
- Sau khi tất cả module đã delegate, xoá function BODIES khỏi core
- Giữ lại re-export: `module.exports = { ...require('./src/module'), ... }`
- Core chỉ còn ~50 dòng: require + module.exports

### C2: Update metadata
- `package.json` `files` field — thêm tất cả file `.experience/src/*.js`
- `REPO_DEEP_MAP.md` — cập nhật đường dẫn module

### C3: Final verification
- `node --test tests/*.test.js .experience/test-*.js` → all pass
- `npm pack --dry-run` → file list chính xác

### C4: Git tag + commit cuối
- `refactor: split experience-core.js into N modules`

---

## Tổng Kết Nỗ Lực

| Group | Priority | Module | Effort |
|:-----:|:--------:|--------|:------:|
| A1 | P0 | Align embedding.js + delegate | ~30m |
| A2 | P0 | Align qdrant.js + delegate | ~30m |
| A3 | P0 | Align config.js | ~10m |
| B1 | P1 | session.js | ~20m |
| B2 | P1 | context.js | ~20m |
| B3 | P1 | scoring.js | ~20m |
| B4 | P1 | noise.js | ~20m |
| B5 | P1 | brain-llm.js | ~30m |
| B6 | P1 | format.js | ~20m |
| B7 | P1 | evolution.js | ~45m |
| B8 | P1 | graph.js | ~15m |
| B9 | P1 | intercept-core.js | ~45m |
| B10 | P1 | router.js | ~45m |
| C1 | P2 | Remove dup + cleanup | ~30m |
| C2-4 | P2 | Verify + deploy | ~30m |
| | | **Total** | **~6-8h** |
