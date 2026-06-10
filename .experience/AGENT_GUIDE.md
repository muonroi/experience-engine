# Experience Engine — Agent Guide

This is the full reference for AI coding agents working alongside the Experience
Engine. A concise pointer to this file is auto-injected into your agent config
(`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) on every install and upgrade. Read this
file for the complete workflow.

> Shipped to `~/.experience/AGENT_GUIDE.md`. Online docs: https://docs.muonroi.com/docs/experience-engine

---

## 1. Passive hints (automatic)

PreToolUse hooks inject experience-based warnings before relevant tool calls
(`Edit` / `Write` / `Bash`, depending on runtime). They appear as:

- `⚠️ [Experience - High Confidence]` — confirmed patterns; **follow them**.
- `💡 [Suggestion]` — lower-confidence; weigh them.

Each warning carries a `Why:` line and ends with `[id:xxxx col:name]`. The hint
line itself prints the exact feedback command — copy it verbatim when reporting.

## 2. Active recall (pull on demand — higher signal)

Don't only wait for passive hints. The moment you hit an unfamiliar or risky
step, or are unsure how something is done in this stack, **query the brain**:

```
node ~/.experience/exp-recall.js "<your question>"      # add --project <slug> to scope
```

It runs the full scope-filtered retrieval across all tiers (T0 principles → T1
behavioral → T2 seeds → self-QA) and returns ranked lines with `[id col]`
handles. Active recall is higher-signal than passive hints: you chose to ask, so
your follow-up verdict reinforces precisely and noise is filtered faster.

Each returned entry is **surfaced** (bumps surfaceCount, not a hit). After you
act, always report the verdict.

**Recall-first, verify-before-acting.** Recall to ORIENT — surface prior gotchas
and narrow where to look — then read the specific code it points to and confirm
against ground truth before you act. Recall replaces broad blind exploration
(read 1 file, not 10); it does NOT replace verifying the exact code you are about
to change. Recalled lessons are point-in-time and can be stale, so Evidence-First
always wins over a remembered claim — when recall and the live code disagree, the
code is right and the stale entry should be corrected.

## 3. Feedback verdict — what to call

Always go through the helper (it resolves the engine URL + auth token from
`~/.experience/config.json`). **Never** use raw `curl http://localhost:8082/api/feedback`
— it defaults to localhost and **silently no-ops on thin-client installs.**

| Situation | Command |
|---|---|
| You read the hint AND changed your approach because of it | `node ~/.experience/exp-feedback.js followed <id> <col>` |
| Hint was topical but you decided it didn't apply this time | `node ~/.experience/exp-feedback.js ignored <id> <col>` |
| Hint was wrong by category — fix the brain | `node ~/.experience/exp-feedback.js noise <id> <col> <reason>` |

**Reporting `followed` matters.** Dashboard Gate 4 (precision) is measured as
`(followed + ignored) / (followed + ignored + noise)`. If a hint changed your
action and you don't call `followed`, the win is never recorded and the hint is
eventually auto-pruned as dead weight even though it helped.

## 4. Noise `<reason>` — DECISION TREE (check in order, pick FIRST match)

The choice determines whether the engine **preserves** the entry by narrowing
scope, or **deletes** it. Wrong reason = lost knowledge.

1. **Hint references an API / lib / version that no longer exists or was replaced?**
   → `stale_rule` (correct outcome — entry is obsolete; counts toward supersede + delete).
2. **Your action's `project_slug` differs from the hint's `scope.project_slug`?**
   → `wrong_repo` (engine adds your project to `scope.project_exclude` — **entry survives** for other projects).
3. **Your action's language differs from the hint's `scope.lang`?** Includes the case where
   `scope.lang` is `any`/unset but the hint's principle is clearly language-specific.
   → `wrong_language` (engine adds your lang to `scope.lang_exclude` — **entry survives** for other langs).
4. **None of the above — genuinely irrelevant across ALL contexts?**
   → `wrong_task` (LAST RESORT — counts toward supersede only, no scope preservation;
   4 reports + 14d age → permanently DELETE).

**Anti-patterns (these create garbage faster than the engine improves):**
- Defaulting to `wrong_task` because picking the right reason takes 5 more seconds.
  After 4 hits the entry is gone forever, even if valid for the OTHER 90% of contexts.
  Always check #2 and #3 first.
- Reporting noise on a hint that's merely over-triggered by broad `commandMatch` /
  `toolMatch` — that's `wrong_language` or `wrong_repo`, not whole-hint noise.
- Spamming a noise reason on a borderline hint when `ignored` is the honest answer.
  `ignored` keeps the entry alive; `noise` pushes it toward deletion.

**Examples:**
- Hint about `pnpm install` lockfile fires while you edit `.cs` → `wrong_language`.
- Hint scoped to `muonroi-cli` fires in `experience-engine` work → `wrong_repo`.
- Hint cites `npm cache verify` (removed in npm 7) → `stale_rule`.
- Hint with no clear language/project home, irrelevant to the task → `wrong_task` (only after confirming #1–#3 don't apply).

## 5. If a hint is wrong or noisy — tell the user

Noise in the brain degrades ALL agents (Claude, Gemini, Codex). Do NOT silently
ignore repeated bad suggestions. Flagging noise is more valuable than working
around it — the user can inspect or remove the bad entry directly.
