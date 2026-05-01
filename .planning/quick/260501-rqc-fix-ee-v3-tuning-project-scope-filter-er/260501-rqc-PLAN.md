---
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .experience/experience-core.js
autonomous: true
requirements: [EE-V3-TUNING]
must_haves:
  truths:
    - "Cross-project entries without _projectSlug get a penalty instead of bypassing filter"
    - "Single error->fix cycles no longer count as mistakes; only repeated errors or user corrections do"
    - "Abstraction clustering catches more related T2 entries with lowered threshold"
  artifacts:
    - path: ".experience/experience-core.js"
      provides: "Project penalty fix, error_fix filter, abstraction threshold"
      contains: "projectPenalty"
  key_links:
    - from: "computeEffectiveScore"
      to: "interceptWithMeta"
      via: "queryProjectSlug parameter"
      pattern: "projectPenalty"
---

<objective>
Fix three EE v3 tuning issues that cause noise and missed abstractions:
1. Project-scope filter bypassed when entry lacks _projectSlug (62% of noise is wrong_repo)
2. error_fix detection too aggressive — single error->fix = normal dev, not a mistake (89% of detections)
3. Abstraction cosine threshold 0.80 too high — only 3 abstractions in 681 evolve runs

Purpose: Reduce noise surfacing, improve signal-to-noise ratio, and enable more principle abstractions.
Output: Updated experience-core.js deployed on VPS.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
Target: VPS at 100.79.164.25
SSH: ssh -i C:/Users/phila/.ssh/muonroi_vps_rsa phila@100.79.164.25
Runtime file: ~/.experience/experience-core.js
Repo file: /home/phila/experience-engine/.experience/experience-core.js
Service: systemctl --user restart experience-engine.service
</context>

<tasks>

<task type="auto">
  <name>Task 1: Strengthen project-scope filter and tighten error_fix detection</name>
  <files>.experience/experience-core.js</files>
  <action>
SSH into VPS and edit ~/.experience/experience-core.js with TWO changes:

**Change A: Project penalty for entries missing _projectSlug (line ~2366)**

Current code:
```js
if (queryProjectSlug && data._projectSlug) {
```
This means entries with NO `_projectSlug` bypass the penalty entirely.

Replace the project penalty block (lines ~2365-2371) with:
```js
let projectPenalty = 0;
if (queryProjectSlug) {
  const scopeLang = data.scope?.lang;
  const principleLike = !!data.principle || data.createdFrom === 'evolution-abstraction' || getValidatedHitCount(data) >= SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD;
  if (scopeLang === 'all') {
    projectPenalty = 0; // Universal rules surface everywhere
  } else if (!data._projectSlug) {
    // No project slug on entry — apply moderate penalty (unknown origin)
    projectPenalty = principleLike ? 0.05 : 0.25;
  } else if (queryProjectSlug !== data._projectSlug) {
    // Cross-project — heavy penalty
    projectPenalty = principleLike ? 0.18 : 0.70;
  }
}
```

This adds a 0.25 penalty for non-principle entries with no project slug (previously 0), which is enough to drop marginal cross-project matches below minConfidence.

**Change B: Require 2+ consecutive errors for error_fix detection (line ~1705-1715)**

Current code in `detectMistakes()`:
```js
// Error -> fix patterns
for (let i = 0; i < lines.length; i++) {
  if (!isTranscriptErrorSignal(lines[i])) continue;
  for (let j = i + 1; j <= Math.min(i + 6, lines.length - 1); j++) {
    if (!isMutatingTranscriptToolCall(lines[j])) continue;
    mistakes.push({
      type: 'error_fix',
      ...
    });
    break;
  }
}
```

Replace with:
```js
// Error -> fix patterns (v2: require 2+ consecutive errors OR user correction nearby)
for (let i = 0; i < lines.length; i++) {
  if (!isTranscriptErrorSignal(lines[i])) continue;
  // Count consecutive error signals starting at i
  let errorCount = 1;
  let errorEnd = i;
  for (let k = i + 1; k <= Math.min(i + 6, lines.length - 1); k++) {
    if (isTranscriptErrorSignal(lines[k])) { errorCount++; errorEnd = k; }
    else if (isMutatingTranscriptToolCall(lines[k])) break;
  }
  // Check for user correction between error and fix
  let hasUserCorrection = false;
  for (let k = i + 1; k <= Math.min(errorEnd + 6, lines.length - 1); k++) {
    if (/^User:/i.test(lines[k])) { hasUserCorrection = true; break; }
  }
  // Only count as mistake if repeated errors or user had to intervene
  if (errorCount < 2 && !hasUserCorrection) continue;
  for (let j = errorEnd + 1; j <= Math.min(errorEnd + 6, lines.length - 1); j++) {
    if (!isMutatingTranscriptToolCall(lines[j])) continue;
    mistakes.push({
      type: 'error_fix',
      context: `${errorCount} error(s) followed by correction${hasUserCorrection ? ' (user intervened)' : ''}`,
      excerpt: lines.slice(Math.max(0, i - 2), j + 3).join('\n')
    });
    break;
  }
}
```

This filters out normal single error->fix dev cycles (the 89% flood), keeping only repeated failures or user-corrected mistakes.

After editing: copy to repo location.
```bash
cp ~/.experience/experience-core.js /home/phila/experience-engine/.experience/experience-core.js
```
  </action>
  <verify>
    <automated>ssh -i C:/Users/phila/.ssh/muonroi_vps_rsa phila@100.79.164.25 "grep -c 'No project slug on entry' ~/.experience/experience-core.js && grep -c 'errorCount < 2' ~/.experience/experience-core.js"</automated>
  </verify>
  <done>Both grep commands return 1, confirming the two changes are present in the file.</done>
</task>

<task type="auto">
  <name>Task 2: Lower abstraction cosine threshold and min cluster size, then deploy</name>
  <files>.experience/experience-core.js</files>
  <action>
SSH into VPS and edit ~/.experience/experience-core.js:

**Change A: Lower cosine threshold from 0.80 to 0.70 (line ~2955)**

Find:
```js
const clustered = clusterByCosine(remainingT2, 0.80);
```
Replace with:
```js
const clustered = clusterByCosine(remainingT2, 0.70);
```

Also update the comment on line ~2953:
```js
// Cluster T2 by cosine > 0.70, groups of 2+ -> brain abstract -> T0 principle
```

**Change B: Lower minimum cluster size from 3 to 2 (line ~2957)**

Find:
```js
if (cluster.length < 3) continue;
```
Replace with:
```js
if (cluster.length < 2) continue;
```

After editing, copy and restart:
```bash
cp ~/.experience/experience-core.js /home/phila/experience-engine/.experience/experience-core.js
systemctl --user restart experience-engine.service
systemctl --user status experience-engine.service --no-pager
```

Verify the service is running (active).
  </action>
  <verify>
    <automated>ssh -i C:/Users/phila/.ssh/muonroi_vps_rsa phila@100.79.164.25 "grep 'clusterByCosine(remainingT2, 0.70)' ~/.experience/experience-core.js && grep 'cluster.length < 2' ~/.experience/experience-core.js && systemctl --user is-active experience-engine.service"</automated>
  </verify>
  <done>Cosine threshold is 0.70, min cluster size is 2, and experience-engine service is active.</done>
</task>

</tasks>

<verification>
All three tuning changes applied and service running:
1. `grep 'No project slug on entry' ~/.experience/experience-core.js` returns match
2. `grep 'errorCount < 2' ~/.experience/experience-core.js` returns match
3. `grep 'clusterByCosine(remainingT2, 0.70)' ~/.experience/experience-core.js` returns match
4. `systemctl --user is-active experience-engine.service` returns "active"
5. Both runtime (~/.experience/) and repo (/home/phila/experience-engine/.experience/) copies match
</verification>

<success_criteria>
- Project penalty applies to entries without _projectSlug (0.25 for non-principles)
- error_fix detection requires 2+ consecutive errors or user intervention
- Abstraction cosine threshold lowered to 0.70 with min cluster size 2
- Service restarted and running
- Runtime and repo copies in sync
</success_criteria>

<output>
After completion, create `.planning/quick/260501-rqc-fix-ee-v3-tuning-project-scope-filter-er/260501-rqc-SUMMARY.md`
</output>
