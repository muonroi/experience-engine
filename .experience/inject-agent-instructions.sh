#!/usr/bin/env bash
# inject-agent-instructions.sh — write/refresh the Experience Engine managed
# instruction block into each installed agent's config file.
#
# Idempotent and safe to run on every install AND upgrade:
#   - creates the target MD file if its parent dir exists but the file does not
#   - replaces an existing managed block (marker-delimited) with the current one
#     (this auto-migrates older, stale blocks — e.g. the legacy raw-curl version)
#   - appends the block to an existing file that has no managed block yet
#   - skips any target whose parent dir is absent (agent not installed)
#
# The block is intentionally concise and points to ~/.experience/AGENT_GUIDE.md
# for the full recall / feedback / noise-decision-tree reference.
#
# Opt-out: set EXPERIENCE_SKIP_MD_INJECT=1 to skip entirely (for users who
# hand-manage their agent config files).
#
# Usage: bash inject-agent-instructions.sh
set -euo pipefail

if [ "${EXPERIENCE_SKIP_MD_INJECT:-0}" = "1" ]; then
  echo "  [inject] EXPERIENCE_SKIP_MD_INJECT=1 — skipping agent instruction injection"
  exit 0
fi

EXP_INSTRUCTION_BLOCK='<!-- experience-engine:start -->
## Experience Engine

Passive hints fire before Edit/Write/Bash and end with `[id col]` tags — follow
high-confidence ones. Beyond passive hints, **actively query the brain** whenever
a step is unfamiliar or risky:

```
node ~/.experience/exp-recall.js "<your question>"
```

**Recall-first, verify-before-acting.** On an unfamiliar or risky step, query the
brain to orient and surface prior gotchas BEFORE diving in — then read the specific
code it points to and confirm against ground truth before acting. Recall replaces
broad blind exploration (read 1 file, not 10); it does NOT replace verifying the
exact code you are about to change, and recalled lessons are point-in-time and can
be stale — Evidence-First wins over a remembered claim.

After acting on any hint, report the verdict so the brain learns (this drives
Gate-4 precision — skipping it lets useful hints get auto-pruned):

```
node ~/.experience/exp-feedback.js followed|ignored|noise <id> <col>
```

Use the helper above — NOT raw `curl http://localhost:8082/api/feedback`, which
defaults to localhost and silently no-ops on thin-client installs.

Noise reasons (pick the FIRST match): `stale_rule` → `wrong_repo` →
`wrong_language` → `wrong_task` (last resort). Wrong reason = lost knowledge.

Full workflow, verdict table, and the noise decision tree:
`~/.experience/AGENT_GUIDE.md` (also at https://docs.muonroi.com/docs/experience-engine).

### Project Memory Self-Curation
To document new lessons, core architectural decisions, specialized UI/UX workflows, or bug fixes from this session, you MUST write/update the workspace memory before you finish the task:
- **For Gemini CLI**: Append or update bullet points under headings in `~/.gemini/projects/<project-slug>/memory/MEMORY.md`.
- **For Antigravity**: Append or update bullet points under headings in `~/.gemini/antigravity/projects/<project-slug>/memory/MEMORY.md`.
- **For Codex CLI**: Append or update bullet points under headings in `~/.codex/projects/<project-slug>/memory/MEMORY.md`.
- **For Claude Code**: Create/update individual markdown files under `~/.claude/projects/<project-slug>/memory/<name>.md` with YAML frontmatter (fields: `name`, `type: feedback|project`, `description`).
*In a single-file MEMORY.md a bullet defaults to a project-scoped lesson; prefix the label with `[feedback]` for a behavioral rule/correction (e.g. `- **[feedback] Library-first**: …`). Dash, asterisk and numbered (`1.`) bullets are all parsed. Always create the parent directories if they do not exist. Write memories to ensure the team can automatically sync them.*
<!-- experience-engine:end -->'


injected=0
for MD_FILE in \
  "$HOME/.claude/CLAUDE.md" \
  "$HOME/.gemini/GEMINI.md" \
  "$HOME/.codex/AGENTS.md" \
  "$HOME/.config/opencode/AGENTS.md"; do

  MD_DIR=$(dirname "$MD_FILE")
  # Skip if the agent isn't installed (parent dir absent).
  [ -d "$MD_DIR" ] || continue

  # Create the file if it doesn't exist yet.
  if [ ! -f "$MD_FILE" ]; then
    if printf '%s\n' "$EXP_INSTRUCTION_BLOCK" > "$MD_FILE" 2>/dev/null; then
      echo "  [inject] created: $MD_FILE"
      injected=$((injected + 1))
    else
      echo "  [inject] WARN: failed to create $MD_FILE (skipped)" >&2
    fi
    continue
  fi

  # Replace an existing managed block (auto-migrates stale versions).
  # Detect the marker with a pure-bash substring test rather than grep: grep is
  # absent on some minimal/Windows bash environments, where `grep -q` exits 127,
  # the `if` silently takes the append branch, and the block is DUPLICATED on
  # every run (breaks idempotency and bloats agent context). `$(<file)` +
  # `${var#*needle}` needs no external tool.
  MD_CONTENT="$(<"$MD_FILE")"
  if [ "${MD_CONTENT#*experience-engine:start}" != "$MD_CONTENT" ]; then
    TMPFILE=$(mktemp 2>/dev/null) || { echo "  [inject] WARN: mktemp failed for $MD_FILE (skipped)" >&2; continue; }
    if awk '/<!-- experience-engine:start -->/{skip=1} /<!-- experience-engine:end -->/{skip=0; next} !skip' "$MD_FILE" > "$TMPFILE" \
       && printf '%s\n' "$EXP_INSTRUCTION_BLOCK" >> "$TMPFILE" \
       && mv "$TMPFILE" "$MD_FILE"; then
      echo "  [inject] updated: $MD_FILE"
      injected=$((injected + 1))
    else
      echo "  [inject] WARN: failed to update $MD_FILE (left unchanged)" >&2
      rm -f "$TMPFILE" 2>/dev/null || true
    fi
    continue
  fi

  # Append to an existing file with no managed block.
  if { printf '\n%s\n' "$EXP_INSTRUCTION_BLOCK" >> "$MD_FILE"; } 2>/dev/null; then
    echo "  [inject] injected: $MD_FILE"
    injected=$((injected + 1))
  else
    echo "  [inject] WARN: failed to append to $MD_FILE (skipped)" >&2
  fi
done

echo "  [inject] agent instruction block written to $injected file(s)"
