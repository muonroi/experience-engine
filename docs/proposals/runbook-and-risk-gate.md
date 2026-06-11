# Proposal: Surface-at-the-right-moment — Runbooks (positive) + Risk-gate (negative)

Status: DRAFT (design only — not approved for build)
Date: 2026-06-11
Author: agent session (recall-fix follow-up)
Supersedes/merges: `~/.claude/plans/wondrous-twirling-finch.md` (risk-gate plan)

---

## 1. Problem (evidence-backed)

After the 2026-06-11 recall fix (`project_ee_recall_fixed`), a real agent used active
recall in storyflow and it worked — but it had to run **three** separate `exp-recall.js`
queries on the same task ("enrich chapter content after donor finishes") and then **stitch
the answers itself**, because the brain holds the three enrich branches as three *atomic*
entries with no entry describing the *sequence*:

- `project_source_enrichment_validated` (4c81b5ca) — chapter-COUNT cross-source fill
- `metadata_enrich` (d1934712) — metadata + title diacritic backfill
- `xtruyen salvage` (1e5f095f) — chapter-CONTENT gap backfill

The agent itself reported the gap: "brain có đủ mảnh cho từng nhánh nhưng chưa có memory
runbook nối 'donor xong → bước kế tiếp'." This is **not a recall bug** — recall ranked all
three correctly. It is a **knowledge-shape gap**: the corpus is atomic-fact-centric and has
no first-class representation for a *procedure* (an ordered, branched sequence of steps).

The same root shape underlies the pending risk-gate plan: an agent skips a recall nudge on a
risky step because the nudge fires every turn, id-less, and delegates "is this risky?" to the
agent (`interceptor-prompt.js:538-540`).

**Insight: these are two faces of one mechanism — surface the right knowledge at the right
moment.** Risk-gate is the *negative* trigger (danger → warn). Runbook is the *positive*
trigger (known multi-step task → hand over the procedure). Design them together; do not build
two parallel systems.

## 2. Verified anchors (no guessing)

| Fact | Evidence |
|---|---|
| `recall()` returns `{text, entries:[{id,collection}], count, query}`; `entries` ARE the `[id col]` handles | `.experience/exp-recall.js:73,121`; `server.js:1143-1144` |
| Recall reuses intercept pipeline with `recallMode:true` (raw cosine, scope-gate off, score-floor off; integrity gates kept) | `server.js:1125-1142` |
| `handleRecall` does **NOT** emit an `activity.jsonl` row, and CLI sends `sourceSession:null` | `server.js:1104-1145,1118` |
| `signal-detector.detectSignals({transcript, activityEvents})` already parses activity rows; today it filters only `op==='hook' && hook==='interceptor-prompt'` | `.experience/src/signal-detector.js:115,156,249` |
| Provenance is carried by `createdFrom` (seed-org-doc, doc-to-experience, session-extractor, evolution-abstraction, bulk-seed, imported, seed-common-doc) | grep across `.experience/*.js` |
| Derived-entry synthesis already has a precedent: scroll a collection → derive a NEW entry with `createdFrom` + `derivedFromId` | `.experience/doc-to-experience.js:24-29,136,267` |
| Memory format already supports `[[name]]` cross-links | `~/.claude/.../memory/*.md`, SessionStart brief `GET /api/graph?id=` |

## 3. Design

### 3.1 Runbook = thin sequence entry, not a monolith

A runbook is a normal experience entry with:

- `nodeKind: 'runbook'` — the runbook MARKER. **Correction to the original sketch:** it is NOT
  `createdFrom: 'runbook'`. Evidence: `storeImportedExperience` (`src/evolution.js:290`)
  hardcodes `createdFrom = 'seed-memory-import'`, so the import path would overwrite any
  caller-supplied `createdFrom`. That is actually desirable — `seed-*` provenance is treated as
  an authoritative manual seed and escapes session-extractor pruning (`src/evolution.js:350-352`).
  So a runbook keeps `createdFrom='seed-memory-import'` and is distinguished by the dedicated
  `nodeKind` field, threaded through `buildStorePayload` (`src/format.js`).
- Body = **ordered steps + decision branches ONLY**, each step delegating detail via `[[link]]`
  to its atomic entry. Example shape:
  > Post-donor enrich (storyflow). 1) `enrich_donor.py --auto --apply --sync` → metadata +
  > chapter-count from donor ([[project_source_enrichment_validated]]). 2) gap-census
  > (`state/gap_census.py`) → crawl only gap>10, biggest-first ([[xtruyen-salvage]]).
  > 3) relaunch a FRESH container after proxy is live (cooldown does not self-heal).
- `derivedFromId: [<atomic ids>]` — records which entries it stitches (mirrors
  `doc-to-experience.js:136` precedent), so a future "rebuild runbook" pass can detect when a
  linked atomic entry changed. Also threaded through `buildStorePayload` (default `null`).
- Scope **tight**: `project_slug` set to the owning project (e.g. `storyflow`). A runbook is
  broad by nature (matches many queries in its domain); without a project scope it would add
  recall noise to unrelated repos. The recall ranking fixed on 2026-06-11 handles in-domain
  ordering.

**Why thin, not a full copy:** when a step's detail changes, the atomic entry changes and the
runbook's *pointer* survives. A monolithic runbook would stale as a whole and duplicate
content that already lives (and is feedback-tracked) in the atomic entries.

### 3.2 Recall behavior for runbooks

No new ranking math. A runbook entry competes on raw cosine like everything else. The only
addition: **when a runbook entry is in the result set, float it to the top of its domain
cluster** (it is the index/table-of-contents for the atomic entries that follow). Implement as
a post-rank stable nudge in `recallMode` only, gated by `nodeKind==='runbook'` — passive
hints keep current behavior. This is a small, optional refinement; ship runbooks without it
first and measure.

### 3.3 Detection — "I had to stitch N entries" signal

Goal: at session end, if the agent ran ≥3 recalls in one session that returned overlapping/
adjacent atomic entries with **no runbook among them**, nudge: "crystallize a runbook?".

This needs two prerequisites that **do not exist today** (call them out honestly):

- **P1 — recall must be observable per session.** `handleRecall` must emit an `activity.jsonl`
  row: `{ts, op:'recall', query, sourceSession, project_slug, surfacedIds:[...]}`. Today it
  emits nothing (`server.js:1104-1145`). Without this, the signal has no data.
- **P2 — the CLI must pass `sourceSession`.** `exp-recall.js` currently posts no session id,
  so all recalls share the null bucket (same limitation that forced recallMode to bypass
  session-dedup). Detection needs a stable per-session id (env `EXP_SESSION` or a transcript-
  derived id) threaded into the POST body.

Detection logic (extends `signal-detector.js`): group a session's `op:'recall'` rows; if
`count(distinct recalls) >= EXPERIENCE_RUNBOOK_STITCH_MIN` (default 3) AND the union of their
`surfacedIds` contains **no** `nodeKind==='runbook'` entry AND ≥2 distinct atomic entries
recur, emit a `runbook-candidate` signal carrying the queries + the recurring ids.

### 3.4 Nudge surface — session-end, not per-turn

`stop-extractor.js` already reads transcript + activity.jsonl at session end to propose
experiences. A `runbook-candidate` signal becomes a proposed self-QA artifact there:
"You stitched [ids] across N queries on <topic> — confirm to save a runbook." This is the
**low-friction, agent-confirmed** path. It fires once per session, off a deterministic signal,
never every turn — the opposite of the broken generic nudge.

### 3.5 Do NOT auto-synthesize the runbook body with an LLM

Stitching atomic facts into an ordered procedure means **asserting sequence/causality that no
single fact contains**. That is exactly the inference the project's Evidence-First rule
forbids without proof, and a knowledge base that invents procedures is worse than one with
gaps. The engine may *propose the candidate* (which ids, which topic — all observed) but the
*ordering and branch logic must be agent/human-confirmed*. `doc-to-experience.js` is doc-
grounded synthesis (the doc supplies the structure); there is no equivalent ground truth for
ad-hoc stitches, so no auto-write.

### 3.6 Lifecycle

- Runbooks carry `[id col]` like any entry → `exp-feedback.js followed/ignored/noise` works
  unchanged; closes the Gate-4 credit loop.
- A runbook that is repeatedly `ignored` decays and is pruned like any low-value entry.
- When a `derivedFrom` atomic entry is superseded, flag the runbook for re-confirm (do not
  auto-edit it) — future pass, out of scope here.

## 4. Risk-gate (folded in from the pending plan)

Keep the risk-gate plan's substance (`risk-triggers.js`, conditional gate replacing the
every-turn nudge, tool-level cross-repo/keyword triggers, `EXPERIENCE_RISK_GATE` escape hatch)
but unify the surfacing layer with §3: both produce a *trigger → targeted recall → inject
concrete payload with `[id col]`* flow. Difference is only the trigger source and the framing
("⚠️ risky" vs "▶ known procedure"). Shared module: a `surface-trigger.js` that both
`interceptor-prompt.js` and `interceptor.js` call, returning `{kind, topic, recall}`.

## 5. Prerequisites before any build (ordered)

1. **P1** — emit `op:'recall'` activity rows from `handleRecall` (server.js).
2. **P2** — thread `sourceSession` from `exp-recall.js` → `/api/recall` body.
3. Then runbook entry convention (`nodeKind:'runbook'` marker — NOT `createdFrom`, see §3.1 —
   plus `derivedFromId`, thin body + `[[links]]`, tight scope).
4. Then detection in `signal-detector.js` + nudge in `stop-extractor.js`.
5. Risk-gate per the existing plan, sharing the surfacing layer.

Steps 1–2 are independently useful (recall becomes observable in forensics regardless of
runbooks) and are the minimum honest foundation — without them, detection is fiction.

## 6. Verification (when built)

- **Unit**: `signal-detector` emits `runbook-candidate` for a synthetic 3-recall session with
  recurring ids and no runbook; emits nothing when a runbook is already present or recalls < 3.
- **Unit**: recall floats a `nodeKind:'runbook'` entry above same-cosine atomic siblings in
  `recallMode`, leaves passive hints unchanged.
- **Pre-Push gate (MANDATORY)**: full `npm test` + `npm run test:unit`, 0 failures.
- **Live**: after seeding one storyflow runbook, `exp-recall.js "post donor enrich next step"`
  returns the runbook leading, followed by its linked atomic entries; `exp-feedback followed
  <runbook-id>` accepted.
- **Live**: a 3-recall session produces a session-end `crystallize runbook?` nudge in the
  stop-extractor output.

## 7. Explicitly out of scope

- Auto-writing runbook bodies (§3.5).
- Auto-rebuilding a runbook when a linked atomic entry changes (§3.6 — flag only).
- The storyflow `post-donor` runbook *content* itself — that is a storyflow corpus decision for
  the user, created via the normal memory-import path once the convention (step 3) exists.

## 8. Implementation status (2026-06-11)

All five prerequisite steps (§5) plus the §3.2 float and §4 shared layer are SHIPPED on `develop`:

| Item | Where | State |
|---|---|---|
| P1 emit `op:recall` rows | `server.js handleRecall` + `activity.buildRecallEvent` | ✅ `82c906f` |
| P2 thread `sourceSession` | `exp-recall.js` | ✅ `82c906f` |
| Runbook convention (`nodeKind`/`derivedFromId`) | `format.buildStorePayload` | ✅ `82c906f` |
| Detection (`detectRunbookCandidates`) | `signal-detector.js` | ✅ `be07e31` |
| Session-end nudge | `stop-extractor.maybeNudgeRunbookCandidate` | ✅ `be07e31` |
| Client-side recall log (CLI) | `exp-recall.js recall()` | ✅ `b459a91` |
| §3.2 runbook-float | `scoring.floatRunbooks` + recall merge | ✅ `7b5e7c8` |
| §4 shared `surface-trigger.js` | both hooks | ✅ `7b5e7c8` |
| Import-path `nodeKind`/`derivedFromId` | `memory-import.mapMemoryToExperience` + `claudeAdapter.parse` | ✅ this commit |
| muonroi-cli MCP/builtin recall mirror | `src/ee/search.recallEE` | ✅ muonroi-cli PR #67 |

**Storyflow runbook content (the §7 corpus decision)** is delivered as a reviewable artifact at
`docs/proposals/storyflow-post-donor-runbook.example.md` — a ready-to-import memory file using the
thin-body design (steps delegate detail to the linked atomic entries `4c81b5ca` /  `d1934712` /
`1e5f095f`, all verified present in the brain). It is NOT auto-written to production: this session
could not verify the storyflow step commands/order against the live repo, and §3.5 forbids
asserting an unverified procedure as an authoritative seed.

**To apply (after confirming the steps against the storyflow repo):**
```bash
# 1. Review/edit the file, then copy it into the storyflow project memory dir:
cp docs/proposals/storyflow-post-donor-runbook.example.md \
   ~/.claude/projects/D--sources-Core-storyflow/memory/post-donor-enrich-runbook.md
# 2. Import (stable-id upsert; createdFrom=seed-memory-import, nodeKind=runbook):
node .experience/tools/import-memory.js          # scans memory dirs, imports incrementally
# 3. Verify the float + recall:
node .experience/exp-recall.js "post donor enrich next step"   # runbook should lead
```
