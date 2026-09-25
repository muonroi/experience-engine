# Plan: Measured engine lift (session holdout) + Bayesian confidence

- **Status:** Revised after three independent reviews (v2)
- **Date:** 2026-09-25
- **Hard constraints:** zero runtime npm dependencies; Node 22; with default config every
  surfaced hint, rank and payload decision is identical to today. The only default-on change is
  the additive `betaEvidence` bookkeeping (B1), which is written but read by nothing in legacy
  mode, and can be disabled.

## 0. What changed from v1 (review summary)

| v1 | Problem found in review | v2 |
|---|---|---|
| Randomise per (session, point), per-exposure windows | Arms share one outcome window; dilution towards 0; later exposures conditioned on treatment | **Session-level** randomisation; session is the unit of analysis |
| Control = hint removed | Empty hint set triggers the risk-gate recall nudge and prompt auto-recall, so control got *extra* guidance; recall and graph edges could leak control points | Control session = **no passive engine output at all** (hints, nudges, auto-recall, brief) |
| Outcome = `toolOutcome` | `PostToolUse` fires only on success in Claude Code, and only `PostToolUse` is registered, so failures never arrive; classifier is a keyword regex | **Phase A0**: register `PostToolUseFailure`, strict failure classifier, validate baseline and power before launch |
| Events in `activity.jsonl` | 10 MB rotation keeps ~20 MB; 2–4 weeks will be lost | Dedicated experiment log |
| Decision = beta period vs legacy period | Non-concurrent, ambiguous, circular guardrail | **Concurrent** per-session arms legacy vs beta, pre-registered metric and margin |
| `computeEffectiveConfidence` made mode-aware | Leaks into evolve demotion (`evolution.js:590`), recall, the brief, copied formulas in tools | New `betaConfidence(data, ctx)`; only the passive path passes a beta ctx |
| k=2, prior 0.5, Thompson draw vs `minConfidence` 0.42 | New entry passes 58%, one ignore → 34%: recreates "killed-innocent"; seeds lose bypass | Low-evidence pass-through to legacy, provenance priors, explicit-only evidence for seeds, calibrated threshold, monotone deterministic gate |
| Evidence = all verdicts, `priorMean` = current `confidence` | Implicit touch is near-automatic; judge + implicit double count; `confidence` already contains hits; several writers bypassed | Per-source weights (implicit touch low), one outcome per (session, point), provenance priors, every writer mapped |
| "All verdict sources funnel through two functions" | False: session repeat flag, organic support, promotion reset, demotion, narrow-scope, reset tool, re-import | Corrected in §2, handled in B1 |

## 1. Problem

1. **We cannot tell whether the engine makes agents better.** Quality signals are self-reported
   (agent verdicts), LLM-judged, or heuristic (`assessHintUsage` path/lang match). None observes
   whether agents fail less. For Claude Code the engine never even sees a failed tool call.
2. **Confidence is a stack of hand-tuned patches** (`scoring.js computeEffectiveConfidence`:
   seed bypass, bootstrap grace, clean-but-unvalidated grace, graded penalty, ageFactor), with
   counters that reset on every hit (`hittrack.js applyHitUpdate`).

## 2. Verified facts (corrected)

| Fact | Where |
|---|---|
| Passive pipeline: search → scope filter → rerank/dedupe → probationary T2 → prompt gate → action relevance gate → noise suppression → `formatPoints` (security, confidence, min-search-score, probationary <0, superseded, permanent noise `ignoreCount>=20&&hitCount===0`, `irrelevantCount>=3`) → per-collection budget → graph expansion → `surfaced` + `recordSurface` → `trackSuggestions` → brain filter → line dedup | `experience-core.js:85-583`, `format.js:79-162` |
| `recordSurface` fires for `surfaced` (confidence predicate only) before min-search-score, hard gates, budget, dedup and brain filter | `experience-core.js:481-488` |
| Shown set = `[id: col:]` markers in final lines → `surfacedIds`; `op:'intercept'.surfaced` is capped at 8 and uses 8-char ids; graph-expanded lines never enter `surfacedIds` | `experience-core.js:458-479, 563-582` |
| Claude Code: `PostToolUse` fires only on success; `PostToolUseFailure` fires on failure with `failure_reason`, `error_details`, `tool_use_id`, `session_id`; Bash success `tool_response` has `stdout`, `stderr`, `exit_code`. `tool_use_id` joins Pre/Post/Failure | Claude Code hooks docs |
| Only `PostToolUse` (matcher `Edit\|Write\|Bash`) is registered; no failure hook | `.experience/register-hooks.js:86-88,170` |
| Outcome classifiers read `exit_code/exitCode/error/is_error/output` + keyword regex | `api/handlers/hooks.js:130-143`, `interceptor-post.js:119-137` |
| When no hint surfaces, PreToolUse appends a risk-gate recall nudge and UserPromptSubmit runs a targeted auto-recall | `interceptor.js:540-546`, `interceptor-prompt.js:344-360` |
| Local mode logs `{op:'hook', hook:'interceptor-post', stage:'parsed', toolOutcome, …}` (suppressed in remote mode); offline-queued posttools are replayed later | `interceptor-post.js:61, 223-230, 257-260` |
| `activity.jsonl` rotates at 10 MB into a single `.1` (overwritten) | `activity.js:11-24` |
| Counter/confidence writers: `applyHitUpdate` (resets ignore/unused, raises confidence floor), `applyNoiseDispositionData`, session-repeat flag → `incrementIgnoreCount`, organic support (`evolution.js:139-183`), `resetPromotionProbation` (zeroes negatives, confidence ≥0.6/0.9, `evolution.js:321-336`), demotions (`evolution.js:568,593`), narrow-scope ×0.3 (`narrow-scope.js:162-164`), `tools/exp-reset-ignore-count.js:122-127`, re-import rebuild that preserves only listed fields (`evolution.js:285-305`) | as listed |
| `noiseReasonCounts` grows only for a valid reason; IGNORED passes `null`; so legacy double-counts IRRELEVANT-with-reason and implicit deterministic noise | `noise.js:117-131`, `hittrack.js:171` |
| `assessHintUsage` returns only `wrong_*` when untouched, so implicit-unused is always "deterministic noise"; the pre-surface relevance gate uses the same function, so shown PreToolUse hints on path-bearing actions are near-automatically "touched" | `intercept.js:162-240, 299-341` |
| `computeEffectiveConfidence` callers: `format.js:98`, `experience-core.js:485`, `scoring.js:181,228,267`, **`evolution.js:590`**; legacy formula copied in `tools/remediate-negsignal.js:52-66`, `tools/exp-dedup-superseded.js:64`, `tools/dashboard/aggregators.js:364`; harness uses `CORE._rerankByQuality` | grep |
| `numericCfg` truncates to integers; `cfgValue` returns env values as strings; config file wins over env | `config.js:69-106` |
| `updatePointPayload` is an unlocked read-modify-write of the whole JSON | `qdrant.js:398-427` |
| `.experience/src/utils.js:397-520` scoring copies are dead | grep |

## 3. Design

### Phase A0 — Make outcomes observable, then check the experiment can work

**A0.1 Failure events.** Register `PostToolUseFailure` (same matcher) in `register-hooks.js` for
Claude Code, routed to `interceptor-post.js` with a flag marking the failure event. Other runtimes:
register an equivalent failure event only where one exists; otherwise rely on explicit fields.

**A0.2 Strict classifier.** Add `classifyToolFailure({hookEvent, toolName, toolResponse})` →
`'fail' | 'ok' | 'unknown'` using explicit signals only: failure hook event; numeric
`exit_code`/`exitCode` ≠ 0; `is_error === true`; `interrupted === true`; a non-empty `error` field.
No keyword matching. Logged as a new field `failure` next to the unchanged legacy `toolOutcome`
(the judge's use of `toolOutcome` must not change).

**A0.3 Baseline tool `tools/exp-outcome-baseline.js`.** From existing logs (`activity.jsonl` +
`.1`, both posttool shapes) and, after A0.1 ships, from the experiment log: mutating calls,
`failure` rates by `sourceRuntime` × tool, sessions per week, calls per session, and the
between-session variance of the per-session failure ratio. It prints the minimum detectable
effect (two-arm, α=0.05, power 0.8) for a given holdout share and duration.
**Go/no-go:** Phase A only starts if the baseline failure rate is ≥ 2% of mutating calls and the
MDE for the planned duration is ≤ 25% relative. Otherwise the report says so and Phase A waits.

### Phase A — Session-level holdout

**A1. Experiment log.** New `~/.experience/experiment.jsonl` (`EXPERIENCE_EXPERIMENT_LOG`),
append-only, rotated to date-stamped files (never overwritten), written only when an experiment
flag is active. Events:
- `session-arm` — once per (session, experiment): `{experiment, arm, salt, runtime}`;
- `exposure` — once per intercept in a treatment session: `{interceptId, tool, toolUseId?, shown:[full ids], graphShown:[full ids], hookEvent}`;
- `outcome` — per post-tool/failure event: `{toolUseId?, tool, inputHash, failure, toolOutcome, clientTs, runtime}`.
All carry `sourceSession` and server `ts`. `interceptId` is a random id per intercept.

**A2. Assignment.** Config `experimentHoldoutShare` (float getter, clamp [0, 0.5], NaN → 0,
invalid → `config-rejected` log; default **0**) and `experimentSalt` (default `"v1"`).
`u = fmix32(fnv1a32(salt + "|holdout|" + sessionId)) / 2^32`; `arm = u < share ? 'control' : 'treatment'`.
No session id → not in the experiment (behaves as today).

**A3. What "control" means.** For a control session the server returns no passive engine output
and a machine-readable marker `experiment: {arm:'control'}`:
- `/api/intercept` (non-recall), `/api/posttool-batch`, `/api/project-brief`: no suggestions,
  `surfacedIds: []`, no `recordSurface`, no `trackSuggestions`;
- hooks seeing the marker skip the risk-gate recall nudge (`interceptor.js`) and the prompt
  auto-recall (`interceptor-prompt.js`), and the SessionStart brief (`interceptor-session.js`);
- local mode computes the same arm from the same config.
Agent-initiated active recall (`exp-recall.js`, MCP `ee.query`) is **not** blocked: the CLI sends
no session id, so it cannot be attributed. The estimand is therefore *the effect of passive engine
output*, stated as such in the report.

**A4. Analyzer `tools/exp-engine-lift.js`.** Unit = session (sessions with < 5 mutating calls
excluded, counted separately). Primary metric: pooled failure ratio = failed mutating calls /
mutating calls, per arm; difference control − treatment with a 95% session-cluster bootstrap CI
(2,000 resamples, fixed seed). Secondary: sessions with a retry loop (≥ 2 failures with the same
`inputHash`), failures per 100 calls by runtime. Guardrails (treatment only): hints shown per
intercept, share of intercepts with ≥ 1 hint, distinct entries shown. Results are stratified by
runtime. No per-point lift in v1. Analysis runs once at the pre-registered end date; interim runs
are labelled "monitoring, not a decision".

### Phase B — Bayesian confidence

**B0. Offline replay `tools/exp-beta-replay.js`.** Scroll the corpus, compute legacy vs beta gate
pass rates and posterior means by `createdFrom` and tier, and the expected change in hints per
intercept on a sample of recent `op:'intercept'` queries. Used to pick `betaMinConfidence`,
priors and weights before any online use; its output is committed to the ADR.

**B1. `betaEvidence` bookkeeping (default on, `betaEvidenceEnabled`).** Payload field
`betaEvidence: {pos, neg, v:1, sessions:[{s, src, w, sign}] (last 50)}`:
- Weights by source (config): manual verdict 1.0, judge 0.7, implicit touch 0.2, implicit
  noise/unused 0.3, organic support 0.3, session-repeat flag **0**.
- One outcome per (session, point): if an event arrives for a session already in `sessions`, keep
  only the highest-priority source (manual > judge > implicit) — replace its contribution.
- Seeds (`createdFrom` starts with `seed-`, `doc-to-experience`, `evolution-abstraction`): only
  manual and judge evidence counts.
- Initialisation (inside the update function, **before** any mutation; on read it is computed
  but not persisted): `pos = 0.5·(validatedCount ?? hitCount ?? 0)`, `neg = 0.5·(ignoreCount + irrelevantCount)`
  — low weight because historical sources are unknown.
- Writers: `applyHitUpdate` / `applyNoiseDispositionData` / `recordFeedback` pass their source;
  organic support adds `pos` with its weight; promotion, demotion and `resetPromotionProbation`
  do **not** touch `betaEvidence` (tier moves are not evidence); narrow-scope demotion and
  permanent-noise remain hard gates in both modes (see B3); `exp-reset-ignore-count.js` gains
  `--beta` to also clear `neg`; re-import preserves `betaEvidence`.
- In-process per-point serialisation of `updatePointPayload` (promise chain keyed by
  collection:id) to cut lost updates; cross-process races (judge worker) are documented as
  best-effort.

**B2. Posterior.** Prior mean by `createdFrom` (table in config, defaults: `seed-*` 0.7,
`doc-to-experience` 0.7, `evolution-abstraction` 0.7, `bulk-seed` 0.8, `imported` 0.6, others 0.5)
and strength k (seeds 20, others 4). `a = μ·k + pos`, `b = (1−μ)·k + neg`. New pure module
`.experience/src/bayes.js`: `posterior`, `posteriorMean`, `betaQuantile(u, a, b)` (regularised
incomplete beta via continued fraction + bisection; monotone in a and b), `fmix32`.

**B3. Gate and ranking in beta mode.** `betaConfidence(data, ctx)` is used only when
`ctx.model === 'beta'` and `!ctx.recallMode`:
- **Low-evidence pass-through:** if `pos + neg < 3`, use the legacy decision and legacy value.
- Otherwise gate: `θ = betaQuantile(u, a, b)` with `u = fmix32(fnv1a32(sessionId|pointId|UTC-date))/2^32`;
  pass iff `θ ≥ betaMinConfidence` (default = `minConfidence`, overridden by B0). Deterministic,
  monotone in evidence; a session crossing UTC midnight may flip (documented). No session id →
  use the posterior mean.
- Rank weight uses the posterior mean. Hard gates (superseded, permanent noise, `irrelevantCount>=3`,
  noise suppression, security, min-search-score, legacy confidence < 0.2 which catches
  narrow-scope kills) apply in both modes. Probationary T2 selection keeps the legacy value in v1.
- `computeEffectiveConfidence` itself is unchanged, so evolve, recall, the brief, tools and the
  harness stay legacy.

**B4. Modes and plumbing.** `confidenceModel`: `legacy` (default) | `shadow` | `beta` | `ab`
(`ab` assigns legacy/beta per session with a second salt `"|model|"`, share `confidenceAbShare`,
default 0.5, independent of the holdout). Mode, salts, shares and session id are resolved **once
per intercept** into `ctx` and passed via `fmtOpts`/rank opts to the passive `formatPoints`,
`rerankByQuality`, the `surfaced` predicate and graph expansion. A shared
`scoring.passesConfidenceGate(point, data, ctx)` replaces the two copies of the confidence
predicate (this unifies only that predicate; the other gates stay where they are).
`shadow`: legacy decides; the passive ranking + formatting + budget are also run with the beta
ctx, and **one** aggregated `confidence-shadow` event per intercept records the shown-set
difference (counts + up to 5 ids each way) to the experiment log.

### Rollout and decision rule (pre-registered)

1. Ship A0 + A + B with defaults. Run A0.3 on the server; stop here if the go/no-go fails.
2. `experimentHoldoutShare` = value chosen from the MDE (expected 0.1–0.2) for the duration it
   gives; `confidenceModel: shadow` in parallel.
3. Run B0; set priors, weights and `betaMinConfidence`.
4. `confidenceModel: ab` with the holdout still on. Primary comparison: pooled failure ratio,
   beta vs legacy treatment sessions. Keep beta iff the upper bound of the 95% CI of
   (beta − legacy) is below a +10% relative non-inferiority margin **and** the guardrails (hints per
   intercept, share of intercepts with a hint) do not drop by more than 20%. One analysis at the
   pre-registered end date.

## 4. Files

- Hooks: `.experience/register-hooks.js` (failure hook), `interceptor-post.js` (failure event,
  `classifyToolFailure`, `inputHash`, `clientTs`, local `outcome`), `interceptor.js`,
  `interceptor-prompt.js`, `interceptor-session.js` (honour the control marker),
  `remote-client.js` (pass the marker through).
- Server: `api/handlers/hooks.js` (outcome event, control handling for posttool-batch),
  `api/handlers/observability.js` (brief), knowledge unaffected.
- Core: `.experience/experience-core.js` (arm, ctx, control short-circuit, exposure event,
  shadow), `.experience/src/scoring.js` (`betaConfidence`, `passesConfidenceGate`),
  `.experience/src/format.js`, `.experience/src/hittrack.js` + `evolution.js` (organic support,
  re-import), `.experience/src/qdrant.js` (per-point serialisation), new `bayes.js`,
  new `experiment.js` (assignment + experiment log), `config.js` (float getter + keys).
- Tools: `exp-outcome-baseline.js`, `exp-engine-lift.js`, `exp-beta-replay.js`;
  `exp-reset-ignore-count.js --beta`.
- Docs: this spec, an ADR for the decision, `REPO_DEEP_MAP.md`, `CHANGELOG.md`, `openapi.yaml`
  (the `experiment` response field).
- Untouched: `utils.js` dead copies; evolution thresholds.

## 5. Tests / acceptance

- **Golden:** before changing code, snapshot `interceptWithMeta` output (suggestions, surfacedIds,
  recordSurface calls) for fixed stubbed search results with `Date.now` pinned and isolated
  tmpdirs (session dir, activity log). Assert identical output after the change with defaults,
  and with `betaEvidenceEnabled` on.
- Full suite, `check:syntax`, `typecheck`, lint pass.
- Assignment: deterministic; control share within ±0.01 absolute of the configured share over
  100k synthetic session ids; no session id → no arm; float getter clamps and logs rejections.
- Control sessions: no suggestions, empty `surfacedIds`, no `recordSurface`/`trackSuggestions`,
  hooks skip nudge / auto-recall / brief; treatment sessions unchanged vs golden.
- Classifier: table test over success/failure payload shapes (Claude Code success with
  `exit_code`, `PostToolUseFailure`, Codex `{output}`, `is_error`, `interrupted`, keyword-only
  output → `ok`/`unknown`, never `fail`).
- `betaEvidence`: per-source weights; session dedupe with priority replacement; seed rule; init
  before mutation (a first manual hit on an entry with 2 ignores and `validatedCount = v` yields `neg = 1.0`, `pos = 0.5·v + 1.0`);
  re-import preserves it; `--beta` reset.
- `bayes`: `betaQuantile` against known values (absolute tolerance 1e-6) and monotonicity in a, b;
  posterior math; low-evidence pass-through equals legacy.
- Modes: `shadow` output identical to legacy and one event per intercept; `ab` split and
  independence from the holdout; beta never changes recall, brief or evolve outputs.
- Analyzers: synthetic experiment logs with a planted effect recover its sign and CI coverage;
  both posttool shapes parsed; sessions below the call minimum excluded.
