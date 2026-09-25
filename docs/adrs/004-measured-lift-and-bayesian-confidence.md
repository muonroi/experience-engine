# ADR-004: Measure engine lift with a session holdout; gate hints with a Beta posterior

- **Status:** Accepted — shipped dark (defaults keep today's behaviour); rollout steps below
- **Date:** 2026-09-25
- **Deciders:** muonroi
- **See also:** [specs/2026-09-25-hint-lift-and-bayesian-confidence.md](../specs/2026-09-25-hint-lift-and-bayesian-confidence.md)

## Context

Two questions had no answer:

1. **Does the engine make agents better?** Every quality signal was self-reported
   (agent verdicts), LLM-judged, or heuristic (`assessHintUsage` path/lang match). None
   observed whether agents fail less — and for Claude Code the engine never even saw a
   failed tool call: `PostToolUse` fires only on success and only `PostToolUse` was
   registered.
2. **Is the confidence gate right?** `computeEffectiveConfidence` is a stack of
   hand-tuned patches (seed bypass, bootstrap grace, clean-but-unvalidated grace,
   graded penalty, ageFactor) over counters that reset on every hit.

A first plan (per-(session, point) randomisation, control = hint removed,
mode-aware `computeEffectiveConfidence`) was rejected in review: arms shared one
outcome window, an empty hint set made the risk gate and prompt auto-recall give
control sessions *extra* guidance, and a mode-aware legacy function would have leaked
into evolve's demotion, recall, the brief and the tools.

## Decision

**Observe outcomes first (A0).** Register `PostToolUseFailure` for Claude Code and
classify every call with `classifyToolFailure` — explicit signals only (failure event,
numeric exit code, `is_error`, `interrupted`, a non-empty `error`), never output
keywords. The legacy `toolOutcome` the judge reads is unchanged. The failure event
records the outcome and nothing else. `tools/exp-outcome-baseline.js` measures the
baseline and the minimum detectable effect; the experiment starts only if the
baseline failure rate is >= 2% of mutating calls and the relative MDE is <= 25%.

**Session-level holdout (A).** A session is the unit of randomisation and analysis:
`u = fmix32(fnv1a32(salt|holdout|session)) / 2^32`, control iff `u < experimentHoldoutShare`.
A control session gets **no passive engine output** — no hints, no risk-gate nudge, no
prompt auto-recall, no SessionStart brief, no static-rule hints — and triggers no
writer (`recordSurface`, `trackSuggestions`). Active recall is not held out, so the
estimand is the effect of *passive* output. Events go to a dedicated append-only
`experiment.jsonl` that rotates into date-stamped files, never overwritten.
`tools/exp-engine-lift.js` reports the pooled failure ratio per arm with a 2,000
resample session-cluster bootstrap CI.

**Beta confidence as a separate model (B).** `betaEvidence` records source-weighted
evidence at every writer (manual 1.0, judge 0.7, implicit touch 0.2, implicit noise
0.3, organic 0.3, session-repeat 0; one outcome per (session, point); seeds take
explicit evidence only). `betaConfidence(data, ctx)` is a new function used only when
the passive path hands it a beta ctx: provenance prior (seeds μ 0.7 k 20, others
μ 0.5 k 4), low-evidence pass-through to the legacy decision, hard floors kept, and a
deterministic draw `θ = betaQuantile(hash(session|point|UTC day), a, b)` — monotone in
evidence. `computeEffectiveConfidence` is untouched. `confidenceModel` is
`legacy | shadow | beta | ab`.

### Pre-registered rollout and decision rule

1. Ship with defaults (`experimentHoldoutShare: 0`, `confidenceModel: legacy`). Run
   `node tools/exp-outcome-baseline.js --holdout-share <s> --weeks <w>` on the server;
   stop here if it prints NO-GO.
2. Set `experimentHoldoutShare` from the MDE (expected 0.1–0.2) for the duration it
   gives, record the end date below, and run `confidenceModel: shadow` in parallel.
3. Run `node tools/exp-beta-replay.js` (B0); commit its output below; set
   `betaMinConfidence`, `betaPriorMeans`, `betaPriorStrength`, `betaEvidenceWeights`.
4. `confidenceModel: ab`, holdout still on. Primary comparison
   (`tools/exp-engine-lift.js --compare model --end-date <date>`): pooled failure
   ratio, beta vs legacy treatment sessions. **Keep beta iff** the upper bound of the
   95% CI of the relative difference (beta − legacy)/legacy is below **+10%** AND
   hints per intercept and the share of intercepts with a hint each drop by no more
   than **20%**. One analysis at the pre-registered end date; earlier runs are
   labelled "monitoring, not a decision".

| Pre-registration | Value |
|---|---|
| Holdout share / duration / end date | _set at step 2_ |
| Baseline report (step 1) | _paste `exp-outcome-baseline.js` output_ |
| B0 replay (step 3) | _paste `exp-beta-replay.js` output — not yet run; this repository has no production corpus_ |
| ab end date (step 4) | _set at step 4_ |

## Consequences

- **Positive:** the engine's value becomes a measured, pre-registered number instead
  of a proxy; the confidence model can be replaced on evidence, concurrently, without a
  before/after comparison.
- **Positive:** failed Claude Code calls are visible for the first time, and in-process
  payload updates no longer lose writes (`updatePointPayload` is chained per point).
- **Negative:** control sessions deliberately get a worse product for the duration.
  The share is capped at 0.5 and chosen from the MDE, not guessed.
- **Negative:** the default-on `betaEvidence` field grows payloads by up to 50 session
  records; `betaEvidenceEnabled: false` stops writing it.
- **Limits:** cross-process payload races (the detached judge worker) remain
  best-effort; manual verdicts dedupe per session only when the client sends
  `sourceSession`; a remote hook that times out before its first marker cannot know a
  control arm, so a nudge can leak on the very first prompt of a control session; the
  B0 intercept replay is removal-side only.
