# Plan: Measured hint lift (holdout) + Bayesian confidence

- **Status:** Draft for review
- **Date:** 2026-09-25
- **Scope:** passive hints only (PreToolUse / UserPromptSubmit / PostToolBatch). Active recall
  (`recallMode`), `/api/search`, `/api/pil-context`, the Project Brief and evolution thresholds are
  out of scope unless stated.
- **Hard constraints:** zero runtime npm dependencies; every new behaviour is behind a config flag
  whose default reproduces today's output exactly; Node 22.

## 1. Problem

1. **We cannot measure whether hints help.** Every quality signal is self-reported or heuristic:
   agent verdicts (`/api/feedback`), the LLM judge (`judge-worker.js`), and implicit touch/unused
   classification (`intercept.js reconcilePendingHints` → `assessHintUsage`, a path/lang/project
   match). None of them observes whether the agent made *fewer mistakes* because a hint was shown.
   The offline holdout harness (`tools/exp-holdout-harness.js`) replays fixtures; nothing measures
   live, causal lift.
2. **Confidence is a stack of hand-tuned patches.** `scoring.js computeEffectiveConfidence` layers
   a seed bypass, a "bootstrap grace" (`surfaceCount <= 3`), a "clean-but-unvalidated grace", a
   graded negative penalty and an `ageFactor = min(1, 0.7 + 0.06·hits)`. Its comments document the
   failure these patches answer (170/263 selfqa entries "killed-innocent" by a single ignore).
   Constants (0.7, 0.06, 0.30, 0.50, 0.20, 0.05) have no shared model and interact.

## 2. Verified facts the design depends on

| Fact | Where |
|---|---|
| Passive surfacing pipeline: search → scope filter → `rerankByQuality` → probationary T2 selection → prompt precision gate → action relevance gate → noise suppression → `formatPoints` (confidence gate, min-search-score gate, hard gates) → budget → graph-edge expansion → session dedup (`trackSuggestions`) → brain relevance filter → line dedup | `.experience/experience-core.js interceptWithMeta` (~L85–590) |
| `recordSurface` is fired for `surfaced` = reranked candidates passing `solution && (probationary \|\| effConf >= minConfidence)`, **before** budget, session dedup and the brain filter remove lines — so `surfaceCount` over-counts what the agent saw | `experience-core.js` "const surfaced = allReranked.filter" |
| What was actually shown is recoverable: `shownSurfacedMeta` is derived from the final `[id:xxxxxxxx col:…]` markers and logged in the `op:'intercept'` activity event (`surfaced`, up to 8) and returned as `surfacedIds` | same function, end |
| Returned `surfacedIds` feed `/api/posttool` → judge queue and `reconcilePendingHints` (implicit touch / implicit-unused penalties) | `api/handlers/hooks.js handlePostTool`, `.experience/src/intercept.js` |
| `op:'posttool'` activity events carry `tool`, `toolOutcome` (`success`/`error`/`null` for non-mutating tools, from `classifyPostToolOutcome`) and `sourceSession`, but no fingerprint of the tool input | `api/handlers/hooks.js` |
| `applyHitUpdate` **resets** `ignoreCount` and `unusedCount` to 0 and raises `confidence` to a floor `0.50 + min(0.18, 0.04·validatedCount)`. Counters are therefore not cumulative totals, and `confidence` is not the creation-time prior | `.experience/src/hittrack.js` |
| `applyNoiseDispositionData`: `ignored` → ignoreCount++, `irrelevant` → irrelevantCount++, `unused` → unusedCount++ (+ irrelevantCount++ when `countIrrelevant`); every non-followed disposition also bumps `noiseReasonCounts[reason]` via `recordNoiseMetadataData`. Legacy `negativeSignal` = ignore + irrelevant + Σ noiseReasonCounts therefore double-counts irrelevant verdicts | `hittrack.js`, `noise.js`, `scoring.js` |
| All verdict sources (manual, judge, implicit) funnel through `applyHitUpdate` / `applyNoiseDispositionData` | `hittrack.js recordFeedback`, `intercept.js reconcilePendingHints` |
| `computeEffectiveConfidence` callers: `format.js formatPoints` (gate), `experience-core.js` (`surfaced` filter), `scoring.js computeEffectiveScore` (rank weight `0.6 + 0.4·conf`), `scoring.js isProbationaryT2Candidate`, `scoring.js computeBriefScore` | grep |
| `.experience/src/utils.js` holds an older, unused copy of `computeEffectiveConfidence` / `computeEffectiveScore` / `rerankByQuality` / `formatPoints` (no `_utils.<fn>` call sites) | grep |
| Config getters follow `cfgValue(key, envKey, fallback)`; bounded integers use `numericCfg` (logs `config-rejected`) | `.experience/src/config.js` |
| Activity log: `~/.experience/activity.jsonl` (`EXPERIENCE_ACTIVITY_LOG`), written by `activity.activityLog`; in thin-client mode the intercept runs on the server, so exposures and posttool outcomes land in the server's log | `.experience/src/activity.js` |

## 3. Design

### Phase A — Live holdout: measure causal lift

**A1. Assignment (intent-to-treat).** New config `hintHoldoutRate` (env
`EXPERIENCE_HINT_HOLDOUT_RATE`, float 0–0.5, default **0** = feature off) and `hintHoldoutSalt`
(string, default `"v1"`).

In `interceptWithMeta`, passive mode only (`!recallMode`), and only when a session id is known
(`sourceMeta.sourceSession`): after noise suppression and before `formatPoints`, compute the
*eligible* set = candidates in r0/r1/r2 that pass the same predicate as today's `surfaced` filter.
For each eligible point:

```
u   = fnv1a32(`${salt}|${sessionId}|${pointId}`) / 2^32      // src/sparse.js already has fnv1a32
arm = u < hintHoldoutRate ? 'control' : 'treatment'
```

- Deterministic per (session, point): a hint stays in the same arm for the whole session, so
  session dedup and repeat-surfacing cannot leak it across arms.
- `control` points are removed from r0/r1/r2 before formatting. They are **not** passed to
  `recordSurface`, `trackSuggestions`, `surfacedIds`, the judge or `reconcilePendingHints` — a hint
  the agent never saw must never collect ignore/unused penalties.
- Graph-edge expansion must not re-introduce a control point (seed its `seenIds` with them).
- One activity event per intercept with at least one eligible point:
  `{op:'hint-assignment', sourceSession, tool, rate, salt, points:[{pointId, collection, arm}]}`.
  Analysis is by assignment (ITT): a treatment point later dropped by budget or brain filter still
  counts as treatment. This keeps the comparison unbiased despite the post-assignment filters.
- Rate 0, or no session id → no assignment, no event, no change.

**A2. Outcome signal.** Add `inputHash` (fnv1a32 of a normalised tool input: tool name + command or
file path, whitespace-collapsed) to the `op:'posttool'` event. Verify the local-mode post-tool path
(`.experience/interceptor-post.js` / `posttool-batch-hook.js`) emits an equivalent event with
`toolOutcome` and `sourceSession`; if not, add it there with the same shape.

**A3. Analyzer `tools/exp-hint-lift.js`** (zero-dep CLI, JSON + table output, `--since`, `--json`).
For each assignment of point *p* in session *s* at time *t*, the exposure window is the next
`K = 10` mutating `posttool` events in *s* within 30 min. Per exposure:
- `errorRate` = errors / mutating calls in window (exposures with 0 mutating calls are excluded and
  counted separately);
- `retryLoop` = 1 if the window contains ≥ 2 errors with the same `inputHash`.

Report, by arm: exposures, sessions, mean errorRate, retry-loop rate, and the difference
(control − treatment, positive = hints help) with a 95% CI from a **session-clustered bootstrap**
(1,000 resamples, seeded). Per-point lift only when both arms have ≥ 20 exposures; otherwise
"insufficient". Also print the share of treatment assignments that were actually shown (join with
`op:'intercept'.surfaced`) so ITT dilution is visible.

### Phase B — Bayesian confidence (shadow first)

**B1. Cumulative evidence.** Add a payload object `evidence: {pos, neg, priorMean, v}`:
- `applyHitUpdate` → `pos += 1`.
- `applyNoiseDispositionData`: `ignored` → `neg += wIgnored` (default 1.0); `irrelevant` →
  `neg += wIrrelevant` (1.0); `unused` → `neg += wUnused` (0.5), and when `countIrrelevant` add
  `wIrrelevant` instead of `wUnused` (the reconciler already judged it deterministic noise).
  `noiseReasonCounts` is **not** added again.
- Lazy initialisation on first update or read when `evidence` is absent:
  `pos = validatedCount`, `neg = ignoreCount + irrelevantCount + 0.5·unusedCount`,
  `priorMean = clamp(confidence ?? 0.5, 0.05, 0.95)`. This is approximate (hit updates reset the
  counters) and is documented as such; `priorMean` is frozen from here on and never touched by
  `applyHitUpdate`'s confidence floor.

**B2. Posterior.** Prior strength by provenance: seeds (`seed-*`, `imported`, `bulk-seed`,
`evolution-abstraction`) `k = 8`; everything else `k = 2`. `a = priorMean·k + pos`,
`b = (1 − priorMean)·k + neg`, `mean = a / (a + b)`.
New module `.experience/src/bayes.js`: `posterior(data)`, `posteriorMean(data)`,
`sampleBeta(a, b, rng)` (Marsaglia–Tsang gamma sampling), `seededRng(seed)` (mulberry32),
all pure.

**B3. Mode switch.** Config `confidenceModel` (env `EXPERIENCE_CONFIDENCE_MODEL`):
`legacy` (default) | `shadow` | `beta`.
- `legacy`: today's code path, byte-for-byte.
- `shadow`: legacy decides. For each eligible candidate also compute the beta gate; when the two
  decisions differ, log `{op:'confidence-shadow', pointId, collection, legacy:{conf,pass},
  beta:{mean,sample,pass}}`, capped at 20 events per intercept.
- `beta`: `computeEffectiveConfidence` returns the posterior mean (used for rank weight, probationary
  selection and the brief), and the confidence **gate** passes when a Thompson sample
  `θ ~ Beta(a, b)` with `rng = seededRng(fnv1a32(sessionId|pointId|YYYY-MM-DD))` satisfies
  `θ ≥ minConfidence`. Stable within a session and day; uncertain entries get explored; a
  well-evidenced bad entry almost never passes. Without a session id, the gate uses the mean.

**B4. One gate, one definition.** Today the confidence gate is written twice (`formatPoints` and
the `surfaced` filter). Extract `scoring.passesConfidenceGate(point, data, ctx)` and call it from
both, so the displayed set and the surface-counted set cannot drift. The hard gates (superseded,
`irrelevantCount >= 3`, noise suppression, security filter, min-search-score) are unchanged.

### Rollout and decision rule

1. Ship A + B with defaults (`hintHoldoutRate: 0`, `confidenceModel: legacy`).
2. Enable `hintHoldoutRate: 0.1` for 2–4 weeks and run the analyzer weekly.
3. Enable `confidenceModel: shadow`, keep the holdout; inspect disagreement volume and cases.
4. Switch to `beta` with the holdout still on. Keep it if, over ≥ 2 weeks, the lift CI does not
   fall below the legacy period's point estimate and the dashboard precision (Gate 4) does not
   drop by more than 5 points; otherwise revert the flag.

## 4. Files

- `.experience/experience-core.js` — assignment + removal of control points, deferred
  `recordSurface` on non-control points, `seenIds` seeding, shadow logging, use of
  `passesConfidenceGate`.
- `.experience/src/scoring.js` — `passesConfidenceGate`, mode-aware `computeEffectiveConfidence`.
- `.experience/src/format.js` — call `passesConfidenceGate`.
- `.experience/src/hittrack.js` — maintain `evidence`.
- `.experience/src/bayes.js` (new), `.experience/src/config.js` (getters).
- `api/handlers/hooks.js` (+ local post-tool hook if needed) — `inputHash`.
- `tools/exp-hint-lift.js` (new).
- Tests under `tests/runtime/` and `tests/tools/`; docs: `REPO_DEEP_MAP.md`, `CHANGELOG.md`.
- Do not modify the dead copies in `.experience/src/utils.js`.

## 5. Tests / acceptance

- Defaults: the whole existing suite passes unchanged (`npm run test:ci`, `check:syntax`,
  `typecheck`, lint). A golden test runs `interceptWithMeta` on a fixed stubbed search result with
  default config and asserts identical `suggestions` / `surfacedIds` to the pre-change output.
- Assignment: deterministic per (salt, session, point); empirical control share within ±2% of the
  rate over 10k synthetic pairs; control points absent from `suggestions`, `surfacedIds`,
  `recordSurface` and `trackSuggestions` inputs, and not re-added via graph edges; no assignment
  without a session id or in recall mode.
- Evidence: hit/ignore/irrelevant/unused increments with the configured weights, no double count
  of `noiseReasonCounts`, lazy init from legacy counters, `priorMean` frozen across hits.
- Bayes: `sampleBeta` mean within 1% of `a/(a+b)` over 20k draws for several (a, b); seeded RNG
  reproducible; posterior math for seed vs organic priors.
- Modes: `shadow` returns the same suggestions as `legacy` and logs only on disagreement (capped);
  `beta` gate is stable for a fixed (session, point, day).
- Analyzer: synthetic activity logs with a planted effect recover its sign and CI; windows respect
  session boundaries, K and the 30-minute limit; per-point output gated at n ≥ 20.
