# Experience Engine v3.2

**AI agents that learn from mistakes, not just store facts.**

Memory stores what you know. Experience changes how you act.

```
Without experience: Agent makes same mistake every session
With experience:    Agent avoids mistakes it's seen before — even in new contexts
```

Works with **Claude Code, Gemini CLI, Codex CLI, OpenCode** — one brain, all agents.

## What's New in v3.2

- **Activity Logging** — every intercept/extract/evolve call writes a structured JSONL event to `~/.experience/activity.jsonl` with 10MB auto-rotation
- **Anti-Noise Scoring** — search results ranked by hit frequency, recency, confidence aging, and contradiction detection. Confirmed experiences rank higher; stale/ignored ones sink
- **Context-Aware Query** — detects language/framework from file being edited (`.ts` → TypeScript, `.cs` → C#), enriches search queries, tags stored experiences with domain
- **Observability CLI** — `node tools/exp-stats.js` shows suggestions fired, hit rate, mistakes avoided, learning velocity, and per-project breakdown with `--since` filtering

## Quick Start

```bash
git clone https://github.com/muonroi/experience-engine.git
cd experience-engine
bash .experience/setup.sh
```

Interactive wizard guides you through:

```
Step A — Vector store:
  [1] Qdrant Cloud     free tier available
  [2] Local Docker     needs Docker Desktop
  [3] VPS SSH tunnel   needs SSH key + remote Qdrant

Step B — Providers (2 separate menus):
  Embed:  [1] OpenAI  [2] Gemini  [3] SiliconFlow  [4] VoyageAI  [5] Custom  [6] Ollama
  Brain:  [1] OpenAI  [2] Gemini  [3] Claude  [4] DeepSeek  [5] SiliconFlow  [6] Custom  [7] Ollama

Step C — Agent selection:
  Choose which AI CLIs to wire up (Claude, Gemini, Codex, OpenCode)

Step D (optional) — Bootstrap brain from existing memory/rules
```

**Done.** Brain installs to `~/.experience/`, hooks wire to selected agents.

### Shortcuts

```bash
bash .experience/setup.sh --local   # Docker Qdrant + Ollama (100% free)
bash .experience/setup.sh --vps     # VPS Qdrant via SSH tunnel
bash .experience/setup.sh --help    # All options, env vars, reconfigure instructions
```

## How It Works

```
YOU write code with any AI agent
  │
  ├─ BEFORE every Edit/Write/Bash
  │   └─ Hook queries brain: "Have I seen this mistake before?"
  │   └─ Detects language from file being edited (.ts → TypeScript)
  │   └─ Enriches query with language context for better matches
  │   └─ Ranks results by quality: hit count, recency, confidence, domain match
  │   └─ If match → injects warning: "⚠️ Last time this caused X"
  │   └─ Records hit for matched experiences (improves future ranking)
  │
  └─ AFTER every response (Stop hook)
      └─ Extracts lessons from session transcript
      └─ Tags experiences with detected language/domain
      └─ Stores Q&A in vector DB
      └─ Logs event to activity.jsonl (observability)
  │
  └─ DAILY (on Stop hook)
      └─ Evolution engine: promote confirmed patterns, demote contradictions
      └─ Tracks ignored suggestions → auto-demotes after 3 consecutive ignores
      └─ Memory shrinks as capability grows
```

## Why Not Just Memory?

```
Memory:     "DbContext should not be singleton"
            → Agent reads → may or may not follow

Experience: "WHEN DbContext + DI → MUST check lifetime FIRST"
            → Fires automatically BEFORE the edit → agent can't ignore it
```

Memory stores facts. Experience creates reflexes.

## 4-Tier Architecture

```
T0 Principles  (~400 tokens)  — generalized rules, always loaded
T1 Behavioral  (~600 tokens)  — specific reflexes, always loaded
T2 QA Cache    (semantic)     — detailed Q&A, retrieved on match
T3 Raw         (staging)      — unprocessed, TTL 30 days

Lifecycle: T2 (3x confirmed) → promote T1 → generalize → T0
           Memory SHRINKS as capability GROWS
```

## Add to Any Existing Repo

Just copy `.experience/` to your repo:

```bash
cp -r experience-engine/.experience/ your-repo/.experience/
cd your-repo
bash .experience/setup.sh
```

Setup installs to `~/.experience/` (user-level). Runs once, works everywhere.

## Bootstrap Brain Instantly

Don't wait 6 months for organic learning. Seed from existing rules:

```bash
# Seed from Claude memory files
node tools/experience-bulk-seed.js --memory-dir ~/.claude/projects/<project>/memory

# Seed from any markdown rule files
node tools/experience-bulk-seed.js --memory-dir /path/to/rules
```

Format: markdown files with `---` frontmatter + `**Why:**` / `**How to apply:**` sections.

See `tools/README.md` for provider-specific examples and troubleshooting.

## Non-Interactive Setup (CI/scripts)

All 5 required `EXP_*` vars must be set — partial sets fall through to interactive mode with a warning.

```bash
# SiliconFlow (cheapest, recommended)
EXP_QDRANT_URL=http://localhost:6333 \
EXP_EMBED_PROVIDER=siliconflow \
EXP_BRAIN_PROVIDER=siliconflow \
EXP_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B \
EXP_BRAIN_MODEL=Qwen/Qwen2.5-7B-Instruct \
EXP_EMBED_KEY=sk-your-key \
EXP_BRAIN_KEY=sk-your-key \
EXP_EMBED_ENDPOINT=https://api.siliconflow.com/v1/embeddings \
EXP_BRAIN_ENDPOINT=https://api.siliconflow.com/v1/chat/completions \
bash .experience/setup.sh

# OpenAI
EXP_QDRANT_URL=https://xxx.cloud.qdrant.io:6333 \
EXP_QDRANT_KEY=your-qdrant-key \
EXP_EMBED_PROVIDER=openai \
EXP_BRAIN_PROVIDER=openai \
EXP_EMBED_MODEL=text-embedding-3-small \
EXP_BRAIN_MODEL=gpt-4o-mini \
EXP_EMBED_KEY=sk-your-key \
EXP_BRAIN_KEY=sk-your-key \
bash .experience/setup.sh

# Full local (free) — requires Docker + Ollama
bash .experience/setup.sh --local
```

Embedding dimension is **probed from the actual API** at setup time — never hardcoded.

## Reconfigure

```bash
bash .experience/setup.sh
# Choose [2] Reconfigure from scratch
```

## Configuration

Config lives at `~/.experience/config.json`. Key fields:

| Field | Description | Default |
|-------|-------------|---------|
| `embedProvider` | `ollama`, `openai`, `gemini`, `siliconflow`, `custom` | — |
| `brainProvider` | `ollama`, `openai`, `gemini`, `claude`, `deepseek`, `siliconflow`, `custom` | — |
| `embedDim` | Vector dimension (probed from API) | — |
| `minConfidence` | Minimum score to show suggestions | `0.42` |
| `highConfidence` | Score threshold for ⚠️ warnings vs 💡 suggestions | `0.60` |

Tune `minConfidence` / `highConfidence` based on your embedding model:
- Small models (Qwen3-0.6B, nomic-embed-text): `0.42` / `0.60`
- Large models (text-embedding-3-small, voyage-code-3): `0.55` / `0.70`

## Observability

Check how your experience engine is performing:

```bash
node tools/exp-stats.js              # last 30 days (default)
node tools/exp-stats.js --since 7d   # last 7 days
node tools/exp-stats.js --since 30d  # last 30 days
node tools/exp-stats.js --all        # all time
```

Output includes:
- **Summary** — suggestions fired, hit rate, misses
- **Mistakes Avoided** — patterns detected vs stored as lessons
- **Learning Velocity** — extraction rate, promotion stats (T2→T1→T0), evolution frequency
- **Per-Project Breakdown** — which projects benefit most from the engine

## File Structure

```
.experience/
  experience-core.js    — brain (config + embed + search + extract + evolve + scoring)
  stop-extractor.js     — session extraction + evolution trigger
  setup.sh              — guided setup wizard
  README.md

tools/
  exp-stats.js            — observability CLI (activity stats + per-project breakdown)
  test-activity-log.js    — activity logging tests (23 assertions)
  test-scoring.js         — anti-noise scoring tests (31 tests)
  test-context.js         — context-aware query tests (29 tests)
  test-exp-stats.js       — observability CLI tests (19 tests)
  experience-bulk-seed.js — bootstrap brain from existing rule files
  README.md               — bulk-seed usage examples per provider
```

## Supported Providers

| Embedding | Brain (extraction) |
|-----------|-------------------|
| Ollama (nomic-embed-text) | Ollama (qwen2.5:3b) |
| OpenAI (text-embedding-3-small) | OpenAI (gpt-4o-mini) |
| Gemini (text-embedding-004) | Gemini (gemini-2.0-flash) |
| VoyageAI (voyage-code-3) | Claude (haiku) |
| **SiliconFlow** (Qwen3-Embedding) | DeepSeek (deepseek-chat) |
| Custom (any OpenAI-compatible) | **SiliconFlow** (Qwen2.5-7B) |
| | Custom (any OpenAI-compatible) |

## Health Check

Setup runs a 3-point health check automatically:

1. **Embed API** — probes embedding endpoint with test input
2. **Qdrant** — verifies connectivity and auth
3. **Collections** — checks all 3 collections exist with correct dimensions

If any check fails, setup shows the exact error and fix instructions.

## Cross-Platform

Works on Linux, macOS, and Windows (Git Bash / MSYS2). Paths resolve correctly on all platforms via `os.homedir()`.

## Requirements

- Node.js 20+
- One of: Docker, Qdrant Cloud (free), or VPS with Qdrant
- One of: Ollama (free), or API key for any supported provider

## License

MIT
