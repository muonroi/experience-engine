---
phase: quick
plan: 260501-rqc
subsystem: experience-engine
tags: [ee-v3, tuning, project-scope, noise-reduction, abstraction]
depends_on: []
provides: [project-penalty-fix, error-fix-filter-v2, abstraction-threshold-0.70]
affects: [experience-core.js, computeEffectiveScore, detectMistakes, evolve]
tech_stack:
  patterns: [project-penalty-filter, cosine-clustering, mistake-detection]
key_files:
  modified:
    - .experience/experience-core.js
decisions:
  - "Apply 0.25 penalty (non-principle) / 0.05 (principle-like) for entries missing _projectSlug instead of bypassing filter entirely"
  - "Require 2+ consecutive error signals OR user intervention for error_fix detection"
  - "Lower abstraction cosine threshold to 0.70 and min cluster size to 2"
metrics:
  duration: "3 minutes"
  completed: "2026-05-01T13:04:16Z"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 1
---

# Quick Task 260501-rqc: Fix EE v3 Tuning — Project Scope Filter and Error Detection

**One-liner:** Three targeted tuning fixes to reduce 62% wrong-repo noise, filter 89% spurious error_fix detections, and unblock abstraction clustering that produced only 3 abstractions in 681 evolve runs.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Strengthen project-scope filter and tighten error_fix detection | 48d04a7 | .experience/experience-core.js |
| 2 | Lower abstraction cosine threshold and min cluster size, deploy | d484a1f | .experience/experience-core.js |

## Changes Applied

### Change A: Project Penalty for Entries Missing `_projectSlug`

**File:** `.experience/experience-core.js` — `computeEffectiveScore()` (~line 2365)

**Before:** `if (queryProjectSlug && data._projectSlug)` — entries without `_projectSlug` bypassed the penalty entirely.

**After:** Restructured to handle three cases:
- `scopeLang === 'all'` → no penalty (universal rules surface everywhere)
- `!data._projectSlug` → moderate penalty: 0.05 (principle-like) / 0.25 (non-principle)
- Cross-project match → heavy penalty: 0.18 (principle-like) / 0.70 (non-principle)

**Impact:** 62% of noise was wrong_repo entries without project slug — now penalized at 0.25, dropping marginal matches below `minConfidence`.

### Change B: error_fix Detection Requires 2+ Errors or User Intervention

**File:** `.experience/experience-core.js` — `detectMistakes()` (~line 1703)

**Before:** Any single error signal followed by a mutating tool call was counted as a mistake.

**After:** Only counts as mistake if:
- 2+ consecutive error signals detected, OR
- A `User:` line appears between error and fix (user had to intervene)

**Impact:** Filters 89% of spurious detections (normal single error->fix dev cycles).

### Change C: Lower Abstraction Cosine Threshold

**File:** `.experience/experience-core.js` — `evolve()` (~line 2975)

**Before:** `clusterByCosine(remainingT2, 0.80)` with `cluster.length < 3` guard.

**After:** `clusterByCosine(remainingT2, 0.70)` with `cluster.length < 2` guard.

**Impact:** Only 3 abstractions in 681 evolve runs at 0.80. Lower threshold enables more related T2 entries to cluster and abstract to T0 principles.

## Deployment

- Runtime: `~/.experience/experience-core.js` (VPS: 100.79.164.25)
- Repo: `/home/phila/experience-engine/.experience/experience-core.js`
- Both copies in sync (diff verified)
- Service restarted: `systemctl --user restart experience-engine.service`
- Health check: `{"status":"ok","qdrant":{"status":"ok"},"fileStore":{"status":"ok"}}`

## Verification Results

| Check | Result |
|-------|--------|
| `grep 'No project slug on entry'` | 1 match |
| `grep 'errorCount < 2'` | 1 match |
| `grep 'clusterByCosine(remainingT2, 0.70)'` | 1 match |
| `grep 'cluster.length < 2'` | 1 match |
| `systemctl --user is-active experience-engine.service` | active |
| Runtime vs repo diff | in sync |

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- Commit 48d04a7: present in git log
- Commit d484a1f: present in git log
- `.experience/experience-core.js`: modified and synced
- VPS service: active and healthy
