# Model Router — Experience Engine Extension

## Summary

Add intelligent model routing to Experience Engine. Before spawning an agent, query the router to determine the optimal model tier (fast/balanced/premium) based on task complexity. Learns from outcomes to self-improve over time.

**Cross-agent**: Returns abstract tiers, not vendor-specific model names. Works with Claude Code, Gemini CLI, Codex CLI, OpenCode.

---

## Architecture

```
Agent Orchestrator (GSD / manual)
  │
  ├─ POST /api/route-model { task, context, runtime }
  │    │
  │    ├─ Layer 1: History check (semantic search, ~50ms)
  │    │    Embedding similarity with past routing decisions
  │    │    If similar task succeeded before → reuse tier
  │    │    If similar task failed before → upgrade tier
  │    │
  │    └─ Layer 2: Brain classify (SiliconFlow Qwen2.5-7B, ~200ms)
  │         Only called when Layer 1 has no confident match
  │         Input: ~100 tokens, Output: 1 word (fast/balanced/premium)
  │
  ├─ Response: { tier, model, confidence, source, reason }
  │    │
  │    └─ Console output: "🔀 [Model Router] → balanced (sonnet) — moderate complexity [brain]"
  │
  └─ POST /api/route-feedback { taskHash, model, outcome, retryCount }
       After agent completes → learn from result
```

## Components

### 1. `routeModel(task, context, runtime)` — experience-core.js

New exported function. Two-layer classification:

**Layer 1 — History check (semantic search)**
- Embed task description using existing `getEmbedding()`
- Search `experience-routes` collection (new Qdrant/FileStore collection)
- If match with score >= 0.80 and outcome data exists:
  - Previous success → return same tier (source: "history")
  - Previous fail/retry >= 3 → upgrade one tier (source: "history-upgrade")
- If no confident match → proceed to Layer 2

**Layer 2 — Brain classify**
- Call `callBrainWithFallback()` with classify prompt
- Prompt is multilingual-aware (handles Vietnamese, abbreviations, mixed language)
- Returns tier: "fast" | "balanced" | "premium"
- Source: "brain"

**Fallback**: If both layers fail → return "balanced" (safe default)

#### Classify prompt

```
Classify this coding task complexity. Reply ONLY one word: fast, balanced, or premium.

fast = trivial, mechanical, single action (rename, format, read file, delete unused, fix typo, update import, simple config change)
balanced = moderate, requires understanding (implement feature, write tests, refactor single file, add endpoint, update logic)
premium = complex, requires deep reasoning (multi-file architecture, race condition, security audit, system design, complex debug, breaking migration)

Task: "{task_description}"
```

### 2. `POST /api/route-model` — server.js

New endpoint. Request/Response:

```json
// Request
{
  "task": "sửa lỗi race condition trong auth",
  "context": {                          // optional
    "files": ["src/auth.ts"],
    "phase": "Phase 3: Auth System",
    "domain": "TypeScript"
  },
  "runtime": "claude"                   // optional — resolves tier → model name
}

// Response
{
  "tier": "premium",
  "model": "opus",                      // null if runtime not provided
  "confidence": 0.85,
  "source": "brain",                    // "history" | "history-upgrade" | "brain" | "default"
  "reason": "complex debugging task"
}
```

Auth: Same as other POST endpoints (Bearer token when configured).

### 3. `POST /api/route-feedback` — server.js

New endpoint. Records agent outcome for learning loop.

```json
// Request
{
  "taskHash": "abc123",                 // hash of task embedding
  "tier": "balanced",
  "model": "sonnet",
  "outcome": "success",                 // "success" | "fail" | "retry"
  "retryCount": 0,
  "duration": 45000                     // ms
}

// Response
{ "ok": true }
```

### 4. Data Storage — `experience-routes` collection

New collection in Qdrant/FileStore (same pattern as existing collections).

```json
{
  "id": "uuid",
  "vector": [0.12, -0.45, ...],        // task embedding
  "payload": {
    "json": "{...}",
    "user": "default"
  }
}

// Payload JSON structure:
{
  "id": "uuid",
  "taskSummary": "debug race condition in auth",
  "tier": "premium",
  "model": "opus",
  "runtime": "claude",
  "source": "brain",
  "outcome": "success",                // null until feedback received
  "retryCount": 0,
  "duration": 45000,
  "domain": "TypeScript",
  "projectSlug": "muonroi-control-plane",
  "createdAt": "2026-04-10T14:22:00Z",
  "feedbackAt": "2026-04-10T14:23:00Z"
}
```

### 5. Model Tier Mapping — config.json

```json
{
  "modelTiers": {
    "claude": {
      "fast": "haiku",
      "balanced": "sonnet",
      "premium": "opus"
    },
    "gemini": {
      "fast": "gemini-2.0-flash",
      "balanced": "gemini-2.5-pro",
      "premium": "gemini-2.5-pro"
    },
    "codex": {
      "fast": "codex-mini",
      "balanced": "o3",
      "premium": "o3"
    },
    "opencode": {
      "fast": "haiku",
      "balanced": "sonnet",
      "premium": "opus"
    }
  }
}
```

Default tiers (if modelTiers not configured):
- `fast` → first entry
- `balanced` → second entry (or first if only one)
- `premium` → third entry (or last available)

### 6. User-Visible Output

When routing decision is made, output a single line to stdout so the user sees it:

```
🔀 [Model Router] → balanced (sonnet) — moderate complexity [brain]
🔀 [Model Router] → premium (opus) — similar task failed on balanced before [history-upgrade]
🔀 [Model Router] → fast (haiku) — similar task succeeded on fast [history]
```

Format: `🔀 [Model Router] → {tier} ({model}) — {reason} [{source}]`

If runtime not provided (model is null):
```
🔀 [Model Router] → balanced — moderate complexity [brain]
```

### 7. Activity Logging

Reuse existing `activityLog()` pattern:

```json
{"ts":"...","op":"route","task":"debug race condition","tier":"premium","model":"opus","source":"brain","confidence":0.85}
{"ts":"...","op":"route-feedback","taskHash":"abc123","tier":"premium","outcome":"success","retryCount":0,"duration":45000}
```

### 8. Collection Bootstrap

On first use, `experience-routes` collection is auto-created (same pattern as existing collections in `ensureCollection()`).

No seed data needed — starts empty, learns from usage.

## Integration Points

### GSD Integration

GSD executor/orchestrator calls `/api/route-model` before each `Agent()` spawn:

1. GSD reads task description from PLAN.md
2. Calls `POST /api/route-model { task, context, runtime }`
3. Receives tier + model
4. Passes model to `Agent({ model: response.model })`
5. After agent completes, calls `POST /api/route-feedback` with outcome

GSD profile mapping:
- `/gsd:set-profile budget` → forces tier "fast" (override router)
- `/gsd:set-profile balanced` → lets router decide (default)
- `/gsd:set-profile quality` → forces tier "premium" (override router)
- `/gsd:set-profile inherit` → lets router decide (default)

When profile is `balanced` or `inherit`, router is active. Otherwise profile overrides.

### Hook Integration

Experience Engine PreToolUse hooks remain unchanged. Model routing is a separate concern — it happens at agent spawn time, not at tool call time.

### Cross-Agent Compatibility

- No Claude-specific model names in core logic
- Tier system is vendor-agnostic
- `runtime` parameter determines model name resolution
- Works without `runtime` (returns tier only)
- Same API for all agents (Claude Code, Gemini CLI, Codex CLI, OpenCode)

## Configuration

All config in existing `~/.experience/config.json`:

```json
{
  "brainProvider": "siliconflow",
  "brainModel": "Qwen/Qwen2.5-7B-Instruct",
  "embedProvider": "siliconflow",
  "embedModel": "Qwen/Qwen3-Embedding-0.6B",
  "modelTiers": {
    "claude": { "fast": "haiku", "balanced": "sonnet", "premium": "opus" },
    "gemini": { "fast": "gemini-2.0-flash", "balanced": "gemini-2.5-pro", "premium": "gemini-2.5-pro" }
  },
  "routerHistoryThreshold": 0.80,
  "routerDefaultTier": "balanced"
}
```

New config keys:
- `modelTiers` — runtime-to-model mapping (optional, has defaults)
- `routerHistoryThreshold` — minimum similarity for history match (default: 0.80)
- `routerDefaultTier` — fallback when all layers fail (default: "balanced")

## Files Changed

| File | Change |
|------|--------|
| `.experience/experience-core.js` | Add `routeModel()`, `routeFeedback()`, `experience-routes` collection |
| `server.js` | Add `POST /api/route-model`, `POST /api/route-feedback` endpoints |
| `README.md` | Document model router feature |
| `tools/exp-stats.js` | Include route stats in observability |

## Success Criteria

- [ ] `POST /api/route-model` returns tier + model for any language input
- [ ] History layer reuses past successful routing decisions
- [ ] History layer upgrades tier when past routing failed
- [ ] Brain classify handles Vietnamese, English, mixed, abbreviations
- [ ] `POST /api/route-feedback` stores outcome and links to route decision
- [ ] User sees routing decision in console output
- [ ] Cross-agent: works with runtime=claude/gemini/codex/opencode/null
- [ ] Config: modelTiers customizable in config.json
- [ ] Activity log tracks all route + feedback events
- [ ] No hardcoded vendor-specific model names in core logic
- [ ] Zero new dependencies (Node.js built-in only)
