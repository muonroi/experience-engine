# exp-dashboard JSON Contract v1.0

Authoritative schema for `~/.experience/dashboard/latest.json`. Both
`exp-dashboard.js` (producer) and any agent (consumer) read this file
to align on shape.

**Versioning:** any breaking change → bump top-level `version`. Agents
MUST validate `version` before parsing further fields. Additive fields
(new dimensions, new metrics) do NOT bump major.

**Encoding:** UTF-8, JSON, pretty-printed (2-space indent) for human
diffability; size budget ~200KB.

---

## Top-level shape

```jsonc
{
  "version": "1.0",              // string — semver; consumers check before parsing
  "generatedAt": "ISO-8601",     // string — UTC timestamp of snapshot build
  "dataWindow": {                // object — what time range fed this snapshot
    "since": "ISO-8601",
    "until": "ISO-8601",
    "days": 30                   // number — window width
  },
  "gates":         { ... },      // Section A — Gate 1/2/3 status
  "precision":     { ... },      // Section B — precision drill-down 5 dimensions
  "funnel":        { ... },      // Section C — surfaced→outcome counts, 7d + 30d
  "topOffenders":  [ ... ],      // Section F — worst-noise entries
  "sessions":      { ... },      // Section S — per-session drill-down
  "meta":          { ... }       // Section M — debug info
}
```

---

## Section A — `gates`

Reflects `tools/exp-gates.js` verdict in structured form. Agent consumes
this to know which MUST/SHOULD criteria fail.

```jsonc
{
  "build": "pass" | "fail",          // Gate 1 — build + test suite
  "dogfood": {                       // Gate 2 — 14 criteria
    "must": {
      "passed": 6,                   // number — count of MUST passes
      "total":  10,                  // number — total MUST criteria
      "items":  [
        {
          "id": "interception_precision",
          "label": "Interception accurate (≥70% relevant)",
          "status": "fail",          // "pass" | "fail" | "pending"
          "current": 0.42,           // number | string | null — measured value
          "target":  0.70,           // number | string | null — pass threshold
          "evidence": "byBand 0.65-0.70 noise rate 88%"
        }
      ]
    },
    "should": {                      // Gate 2 SHOULD criteria — non-blocking
      "passed": 0,
      "total":  4,
      "items":  [ ... ]              // same item shape
    }
  },
  "acceptance": {                    // Gate 3 — Q1/Q2/Q3/Q4 yes/no questions
    "Q1": "pass" | "partial" | "fail" | "pending",
    "Q2": "...",
    "Q3": "...",
    "Q4": "..."
  },
  "verdict": "string"                // one-line human summary (no markup)
}
```

**MUST item IDs (stable, agent-queryable):**

| id | label |
|---|---|
| `extraction_works` | ≥5 QA entries / week |
| `dedup_hygiene` | 0 exact duplicates (cosine > 0.85) |
| `interception_fires` | ≥10 fires / week |
| `interception_precision` | ≥70% relevant |
| `non_blocking` | hook < 3s |
| `error_recurrence` | ≥30% reduction |
| `evolution_works` | ≥1 principle clustered |
| `memory_shrinks` | total tokens decrease post-evolve |
| `novel_coverage` | ≥1 principle hits unseen case |
| `auto_narrow_scope` | ≥1 entry auto-narrowed via Step 3d |
| `cross_cli_parity` | same entry surfaces across ≥2 CLIs |

**SHOULD item IDs:**

| id | label |
|---|---|
| `cost_stable` | $/session not increased |
| `brain_filter_precision` | 20-60% drop rate |
| `surface_follow_ratio_p75` | ≥0.4 |
| `ux_no_friction` | no blocking timeout |

---

## Section B — `precision`

The headline metric. Agents query this section to diagnose where noise
lives and recommend threshold / scope fixes.

```jsonc
{
  "overall": {
    "surfaced":   8524,            // number — hint surface events in window
    "followed":   202,             // number — judge classified FOLLOWED
    "ignored":    4,               // number — IGNORED
    "noise":      594,             // number — IRRELEVANT (any reason)
    "noResponse": 7724,            // number — no posttool / no judge verdict
    "precision":  0.42             // number — followed / (followed+ignored+noise)
  },

  "byBand": [                      // array — fixed 7 confidence bands
    {
      "band":      "0.65-0.70",    // string — half-open [lo, hi)
      "surfaced":  3120,
      "followed":  12,
      "ignored":   2,
      "noise":     445,
      "precision": 0.10            // null if (followed+ignored+noise) == 0
    }
    // bands: 0.00-0.50, 0.50-0.65 (decayed/suppressed),
    //        0.65-0.70, 0.70-0.75, 0.75-0.80, 0.80-0.85, 0.85-1.00
    // Sub-0.65 bands surface only historically — current feedback against
    // them refers to entries whose confidence has decayed since.
  ],

  "byCollection": [                // array — 3 collections
    {
      "collection": "experience-principles" | "experience-behavioral" | "experience-selfqa",
      "surfaced":   ...,
      "followed":   ...,
      "noise":      ...,
      "precision":  ...
    }
  ],

  "byFramework": [                 // array — top-10 frameworks by surfaceCount desc
    {
      "framework":  "c#" | "typescript" | "muonroi-dotnet" | "react" | "next" | "any" | ...,
      "surfaced":   ...,
      "followed":   ...,
      "noise":      ...,
      "precision":  ...
    }
  ],

  "byRuntime": [                   // array — claude | codex | gemini | muonroi-cli | unknown
    {
      "runtime":    "claude",
      "surfaced":   ...,
      "followed":   ...,
      "noise":      ...,
      "precision":  ...
    }
  ],

  "noiseReasons": {                // object — count per reason (only IRRELEVANT verdicts)
    "wrong_task":      540,
    "wrong_language":  39,
    "wrong_repo":      12,
    "stale_rule":      3,
    "unspecified":     0           // feedback with verdict=IRRELEVANT but no reason field
  }
}
```

**Sentinel: `precision: null`** — emitted when denominator is 0
(insufficient feedback). Consumers must handle null explicitly, NOT
treat as 0.

**Window:** all precision counts respect `dataWindow.days`.

---

## Section C — `funnel`

Surface-to-outcome funnel at 7d and 30d windows. Same JSON shape per
window for trivial agent diffing.

```jsonc
{
  "7d": {
    "surfaced":   ...,
    "followed":   ...,
    "ignored":    ...,
    "noise":      ...,
    "noResponse": ...,             // surface event without matching judge verdict in window
    "totalEvents": ...             // surfaced + ... (sanity check)
  },
  "30d": { ...same shape... }
}
```

---

## Section F — `topOffenders`

Top 20 brain entries with worst ignore-ratio AND non-trivial surface
count. Sorted by `ignoreRatio` desc, then `surfaceCount` desc.

```jsonc
[
  {
    "id":               "uuid",                // string — Qdrant point id
    "collection":       "experience-behavioral", // string
    "tier":             1,                     // number | null
    "confidence":       0.71,                  // number
    "surfaceCount":     47,                    // number — total surfaces lifetime
    "ignoreCount":      43,                    // number — feedback ignored+noise
    "hitCount":         4,                     // number — feedback followed
    "ignoreRatio":      0.91,                  // number — ignoreCount / (ignoreCount+hitCount)
    "framework":        "c#",                  // string | null
    "lang":             "c#",                  // string | null
    "principle":        "first 120 chars...",  // string — trigger/principle preview
    "lastNoiseReasons": ["wrong_task", "wrong_task", "wrong_language"]  // array — last 5 verdicts
  }
]
```

**Inclusion threshold:** surfaceCount ≥ 5 (else excluded as
insufficient sample).

---

## Section S — `sessions`

Per-session drill-down. Lets agents answer "what hints fired in session X,
what tool actions triggered them, what feedback came back". Drives the
HTML collapsible cards + the flat `sessions.csv` export.

```jsonc
{
  "windowDays":    30,           // number — same as dataWindow.days
  "totalSessions": 42,           // number — sessions with ≥1 surfaced hint
  "items": [                     // sorted by lastActivity desc, capped at 50
    {
      "sessionId":      "416f3d76",        // string — 8-char prefix
      "fullSessionId":  "416f3d76-2a92-4432-...",
      "runtime":        "claude-code",     // string — sourceRuntime
      "project":        "D:/sources/.../IAuditable.cs",  // string|null — first project seen in session
      "projectSlug":    "muonroi-building-block",  // string|null — derived repo root
      "firstActivity":  "ISO-8601",
      "lastActivity":   "ISO-8601",
      "duration":       "10m",             // string — humanized
      "silent":         false,             // bool — true when session had intercepts but 0 surfaces (hints will be [])
      "stats": {
        "intercepts":    18,               // intercept events count
        "surfacedHints": 5,                // total surface fires (may double-count same hint)
        "uniqueHints":   3,                // distinct pointIds surfaced
        "posttools":     21,
        "feedback":      { "followed": 0, "ignored": 1, "noise": 4 }
      },
      "hints": [                           // sorted by surfaceCount desc
        {
          "pointId":           "07725b71",
          "collection":        "experience-behavioral",
          "framework":         "c#",
          "lang":              "c#",
          "confidence":        0.87,
          "tier":              1,
          "principleSnippet":  "first 120 chars of principle…",
          "surfaceCount":      2,          // times surfaced in THIS session
          "surfaces": [                    // each surface = an agent action
            {
              "ts":           "ISO-8601",
              "tool":         "PostToolBatch",
              "query":        "[C#] Using Muonroi.Data. Read: D:\\sources\\...\\IAuditable.cs",
              "queryPreview": "shortened to ≤80 chars + ellipsis"
            }
          ],
          "feedback": {                    // null if no feedback within session window+30min
            "verdict": "FOLLOWED" | "IGNORED" | "IRRELEVANT",
            "reason":  "wrong_task" | null,
            "ts":      "ISO-8601"
          }
        }
      ]
    }
  ]
}
```

**Flat CSV export** at `~/.experience/dashboard/sessions.csv` and
`https://experience.muonroi.com/api/sessions.csv` (token required). One
row per surface action, columns:

```
session_id, runtime, project_slug, project, first_activity,
surface_ts, tool, query_preview,
point_id, collection, framework, lang, confidence, tier,
principle_snippet,
feedback_verdict, feedback_reason, feedback_ts
```

Useful for spreadsheet analysis or `pandas.read_csv(URL)`.

---

## Section M — `meta`

Build-time debug info for reproducibility.

```jsonc
{
  "sourceFiles":   ["activity.jsonl", "activity.jsonl.1"],  // array — files scanned
  "linesScanned":  47922,                                    // number — total JSONL lines
  "qdrantPoints":  1117,                                     // number — total brain entries scanned
  "buildMs":       2840,                                     // number — wall-clock build time
  "engineConfig": {                                          // partial config snapshot for context
    "minConfidence":   0.65,
    "highConfidence":  0.75,
    "brainProvider":   "siliconflow"
  }
}
```

---

## Agent query examples (informational)

Given `latest.json` as input, an agent can answer:

1. **"Where is precision worst?"**
   → scan `precision.byBand[]` sorted by `precision` asc → identify lowest band
   → cross-ref `precision.byFramework[]` and `precision.byCollection[]` for confounders

2. **"Why is precision low?"**
   → read `precision.noiseReasons` distribution
   → if `wrong_task` dominates → suggest scope narrowing (Step 3d) or threshold bump
   → if `wrong_language` → suggest `scope.lang_exclude` enforcement audit

3. **"Which entries should be demoted?"**
   → iterate `topOffenders[]` where `ignoreRatio > 0.7` AND `surfaceCount > 10`

4. **"Is v3.0 ready to ship?"**
   → check `gates.dogfood.must.items[].status` — any "fail" = NO

---

## Schema change history

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-05-22 | Initial — sections A/B/C/F/M |
| 1.1 | 2026-05-22 | Section S — `silent: true` stub for sessions with ≥50 intercepts but 0 surfaced hints. Surfaces v3.0 "brain went quiet" effectiveness signal. `hints: []` + `surfacedHints: 0` when silent. |
