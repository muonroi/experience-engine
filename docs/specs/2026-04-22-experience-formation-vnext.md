# Experience Formation vNext

## Status

Design-locked roadmap/spec for the next Experience Engine learning loop.

This document is the canonical contract for "experience, not memory". Follow-on
implementation phases must trace back to this spec instead of redefining terms
locally in tools, tests, or prompts.

---

## Summary

Experience Engine is no longer evaluated primarily by memory hygiene or runtime
health. Those remain necessary, but they are not the success condition.

The success condition is now:

1. incidents become reusable judgments instead of literal reminders
2. those judgments catch novel cases that were not used to form them
3. mature judgments surface naturally during normal use, without forced routing
4. only after that, cross-project reuse counts as proof of transfer

Priority order:

1. Abstraction quality
2. Novel-case proof
3. Natural bootstrap
4. Cross-project reuse
5. Cost and runtime health as supporting signals

---

## Normative Definitions

### Lesson

A lesson is an incident-local statement extracted from one concrete failure. It
must preserve what happened and what should be done differently next time.

If an entry only stores a literal reminder and does not encode the failure class
 or corrective judgment, it is memory, not experience.

### Behavior

A behavior is a reusable rule inside one failure family or domain. It should
survive wording changes across multiple incidents, but it may still be scoped to
one technical area, workflow, or stack.

### Principle

A principle is a generalized judgment that captures a failure mode and the
preventive action in a way that can transfer to a novel case. A principle is not
just a summary of similar examples. It must express:

- the class of failure
- the corrective judgment
- why that judgment prevents the failure
- the conditions where it applies

Preferred principle format:

`when X class of failure appears, do Y because Z`

Literal log lines, test names, endpoint names, and one-off trigger phrasing are
supporting evidence, not the principle itself.

### Novel Case

A novel case is an incident that belongs to the same underlying failure family
as the seed set, but differs materially in wording, file names, tool names,
surface context, or repository-local terminology.

A case is not novel if retrieval only succeeds because of reused literal trigger
text from the seed incidents.

### Cross-Project Reuse

Cross-project reuse means a mature principle matches and helps resolve a case in
at least one different repository or project context without forced targeting.
This is proof of transfer only after the principle already passed holdout
novel-case proof inside its original failure family.

### Memory Drift

The system is drifting back into memory if one or more of the following appears:

- entries are keyed mainly by literal trigger wording
- abstraction collapses into "same words" instead of "same failure mode"
- principles cannot explain why the judgment works
- bootstrap depends on forced targeting as the default path
- gates declare success based only on extraction volume, shrinkage, or health

---

## Tier Semantics

Tier semantics are now fixed and must be used consistently in runtime payloads,
docs, tests, gates, and dashboards.

### T2

`T2` is an incident-local lesson.

Required outcome:

- captures one concrete failure accurately
- includes enough structure to support later abstraction
- may still contain incident-specific evidence

### T1

`T1` is a reusable behavioral rule for one failure family or domain.

Required outcome:

- multiple incident-local phrasings converge to the same judgment
- wording can vary without breaking retrieval
- rule is reusable in-family, but may still be domain-bounded

### T0

`T0` is a generalized principle with novel-case evidence.

Required outcome:

- abstraction is no longer incident-literal
- at least one holdout novel case matched successfully
- principle has explicit applicability conditions

A T0 without holdout evidence is not complete. It is a candidate principle, not
final proof of experience formation.

---

## Canonical Lesson Shape

Before abstraction, lesson-like entries must be normalized into a canonical
shape. This shape is the minimum contract for evolution from T2 to T1/T0.

```json
{
  "incidentSymptom": "observable failure or near-miss",
  "hiddenCause": "underlying failure mode, not just the visible trigger",
  "preventiveJudgment": "what to do next time and how to think about it",
  "applicabilityConditions": [
    "where the judgment applies",
    "important boundaries or exclusions"
  ],
  "evidenceClass": "log|test|runtime|review|user-correction|other"
}
```

Internal payloads for abstraction must support, at minimum:

```json
{
  "failureMode": "normalized failure family label",
  "judgment": "portable preventive action",
  "evidenceClass": "type of supporting evidence",
  "conditions": ["applicability condition"],
  "provenance": {
    "kind": "seed|holdout",
    "sourceSession": "session or replay source"
  }
}
```

Field rules:

- `failureMode` is mandatory before clustering or abstraction
- `judgment` is mandatory before a rule can promote beyond T2
- `conditions` is mandatory before a rule can be called T0
- `provenance.kind` is mandatory for novel-case proof

If these fields are missing, the entry may still exist operationally, but it is
not eligible to count toward experience-formation gates.

---

## Abstraction Contract

Abstraction must prioritize root cause and corrective judgment over surface
phrasing.

### Required behavior

- cluster by failure mode similarity before trigger wording similarity
- preserve incident evidence separately from the abstracted rule
- normalize principle text into a judgment form, not a transcript summary
- converge multiple differently worded incidents from the same family into one
  behavioral rule or principle

### Forbidden behavior

- using a shared log line as the main reason two incidents are grouped
- promoting a principle whose text still depends on a specific test name
- calling a summary "generalized" when it only compresses repeated wording

### Acceptance check

Given 3 to 5 incidents from the same family but with different wording, the
system should converge to one rule that still matches a new holdout case without
reusing the old literal trigger.

---

## Bootstrap Semantics

The normal dogfood path must become natural bootstrap, not forced targeting.

### Required modes

Dogfood and use-time retrieval must expose two explicit modes:

- `natural-bootstrap`
- `forced-bootstrap`

`natural-bootstrap` is the default production path.

`forced-bootstrap` exists only for debug, repair, and controlled diagnosis.

### Required behavior

- query construction should prefer failure-mode and condition similarity early
- scoring should use canonical tags or conditions before pure surface semantics
- new organic lessons should be able to surface again in the normal loop without
  pointing directly at their own id

### Metrics

The system must report at least:

- `natural_surface_success`
- `forced_surface_fallback`
- `forced_bootstrap_ratio`

`forced_bootstrap_ratio` must trend down over time on the same harness. A high
ratio is evidence that experience is not bootstrapping naturally yet.

---

## Novel-Case Proof Harness

Novel-case proof is the primary evidence of experience quality.

Every principle candidate must be evaluated with two buckets:

- `seed-support cases`
- `holdout novel cases`

### Seed-support cases

These are incidents used to form the behavioral rule or principle.

Required use:

- prove the abstraction still explains the original family
- verify convergence across wording variance

### Holdout novel cases

These are kept out of the abstraction seed set and used only for validation.

Required use:

- prove the principle transfers beyond the seen incidents
- prevent "summary of examples" from being mistaken for experience

### Pass condition

A principle only passes novel-case proof if:

1. it matches at least one holdout incident from the same failure family
2. the match does not rely on literal reuse from the seed set
3. false positives remain below the threshold defined by the harness owner

`holdout catch` is therefore a gate condition, not a nice-to-have stat.

### Required stats

Gates and stats must expose at least:

- `principles_with_novel_hit`
- `holdout_matched`
- `holdout_tested`
- `holdout_match_rate`

---

## Cross-Project Reuse

Cross-project reuse is a later-stage proof. It must not be used to compensate
for weak abstraction.

### Preconditions

Cross-project verification is allowed only after:

1. abstraction quality is acceptable
2. natural bootstrap is working
3. holdout novel-case proof has passed

### Required proof

At least one mature principle should eventually demonstrate:

- `confirmedProjects >= 2`
- one non-forced match in a different repository or stack wording context

Same-judgment / different-stack wording is valid evidence. Literal copy-paste
across repos is not.

---

## Metric Hierarchy

Metrics are ordered by decision importance.

### Primary metrics

- principle quality
- novel-case catch rate
- natural bootstrap rate

### Secondary metrics

- organic extraction yield
- promotion latency
- forced-bootstrap ratio

### Supporting metrics

- cost
- recurrence reduction
- runtime health
- storage shrinkage

Supporting metrics can diagnose efficiency. They cannot declare experience
success on their own.

---

## Gate Semantics

Gate semantics must separate pipeline health from experience proof.

### Gate A: Pipeline Healthy

Confirms the system runs:

- storage reachable
- embed and brain calls work
- hooks fire
- extraction stores usable entries

This gate proves infrastructure only.

### Gate B: Principle Formed

Confirms the system formed at least one usable abstraction:

- multiple incidents converged into one T1/T0 candidate
- abstraction is judgment-level, not literal incident wording
- canonical lesson fields exist

This gate proves abstraction quality only.

### Gate C: Novel Case Caught

Confirms experience exists:

- at least one holdout novel case matched
- match did not rely on literal seed wording
- false positives stay within the defined threshold

This is the minimum gate required before any overall "done" verdict.

### Gate D: Reused Cross-Project

Confirms transfer breadth:

- mature principle reused in another project
- reuse happened through normal retrieval, not forced routing

This is advanced proof, not the first success bar.

### Overall verdict rule

`overall = 100%` is invalid unless Gate C passes.

A pipeline may be healthy and even produce abstractions, but it is not "done"
until novel-case proof exists.

---

## Acceptance Rubric

This rubric is the reference for future tool and test assertions.

### T2 acceptable

- incident is concrete and accurate
- hidden cause is plausible
- preventive judgment is actionable
- enough structure exists for abstraction

### T1 acceptable

- 3 to 5 incidents from one failure family converge
- rule no longer depends on one literal trigger phrasing
- judgment is reusable inside the family/domain

### T0 acceptable

- rule is written at the principle level
- applicability conditions are explicit
- at least one holdout novel case matched
- the successful holdout was not part of the seed set

### Reject as memory

Reject or demote if:

- text is just a restatement of one error string
- no hidden cause is captured
- no portable judgment exists
- proof depends on forced bootstrap in the default path

---

## Required Test Scenarios

The following scenarios are mandatory for this roadmap:

1. Extract 3 incidents with different wording but the same failure mode and
   converge them into one unified rule.
2. Validate that the resulting principle matches at least 1 holdout incident not
   used in formation.
3. Show that an organic lesson can move through at least `T2 -> T1` via natural
   bootstrap in the standard dogfood loop.
4. Keep forced bootstrap available only as a fallback and record its use
   separately.
5. Run cross-project verification only after holdout proof passes.
6. Ensure gates distinguish:
   - pipeline healthy
   - principle formed
   - principle caught novel case
   - principle reused cross-project

---

## Phase Traceability

Implementation phases must map back to this spec as follows:

- `P1` locks definitions, metrics, and gate semantics
- `P2` upgrades abstraction toward failure mode and judgment
- `P3` makes natural bootstrap the default path
- `P4` adds the holdout-based proof harness
- `P5` proves cross-project reuse after `P2` to `P4` succeed

Recommended execution order for the next implementation run:

- `P1 + P2` together first
- then `P3`
- then `P4`
- then `P5`

---

## Out Of Scope For This Spec

This document does not introduce a new platform layer or deployment model.

It also does not claim that current tools already satisfy these contracts.
Existing tools such as `tools/exp-gates.js` and `tools/exp-dogfood-loop.js`
should be updated in later implementation phases to align with this spec.
