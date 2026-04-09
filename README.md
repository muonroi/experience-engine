# Experience Engine v3.0

**AI agents that learn from mistakes, not just store facts.**

Memory stores what you know. Experience changes how you act.

```
Without experience: Agent makes same mistake every session
With experience:    Agent avoids mistakes it's seen before — even in new contexts
```

Works with **Claude Code, Gemini CLI, Codex CLI, OpenCode** — one brain, all agents.

## Quick Start

```bash
git clone https://github.com/muonroi/experience-engine.git
cd experience-engine
bash .experience/setup.sh
```

Interactive menu guides you through:

```
Step A — Vector store:
  [1] Qdrant Cloud  (free tier)
  [2] Local Docker
  [3] VPS tunnel

Step B — AI provider:
  [1] OpenAI         embed + brain, one key
  [2] Gemini         free tier
  [3] Claude         haiku brain
  [4] DeepSeek       cheapest direct API
  [5] SiliconFlow    cheapest, embed + brain, no Ollama needed
  [6] Custom         any OpenAI-compatible endpoint
  [7] Ollama         100% free, local, no API key
```

**Done.** Brain installs to `~/.experience/`, hooks wire to all agents automatically.

## How It Works

```
YOU write code with any AI agent
  │
  ├─ BEFORE every Edit/Write/Bash
  │   └─ Hook queries brain: "Have I seen this mistake before?"
  │   └─ If yes → injects warning: "⚠️ Last time this caused X"
  │
  └─ AFTER every response
      └─ Hook extracts lessons from session
      └─ Stores Q&A in vector DB
      └─ Next session: agent is smarter
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

## Non-Interactive Setup (CI/scripts)

```bash
# SiliconFlow (cheapest, recommended)
EXP_QDRANT_URL=https://xxx.cloud.qdrant.io:6333 \
EXP_QDRANT_KEY=your-qdrant-key \
EXP_BRAIN_ENDPOINT=https://api.siliconflow.com/v1/chat/completions \
EXP_BRAIN_KEY=sk-your-key \
EXP_BRAIN_MODEL=Qwen/Qwen2.5-7B-Instruct \
EXP_EMBED_ENDPOINT=https://api.siliconflow.com/v1/embeddings \
EXP_EMBED_KEY=sk-your-key \
EXP_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B \
bash .experience/setup.sh

# OpenAI (simplest)
EXP_QDRANT_URL=https://xxx.cloud.qdrant.io:6333 \
EXP_QDRANT_KEY=your-key \
OPENAI_API_KEY=sk-your-key \
bash .experience/setup.sh

# Full local (free)
# Requires: docker, ollama
bash .experience/setup.sh   # choose [2] Local Docker + [7] Ollama
```

## Reconfigure

```bash
EXP_RESET_CONFIG=1 bash .experience/setup.sh
```

## File Structure

```
.experience/
  experience-core.js    268 lines — brain (embed + search + extract + store)
  setup.sh              ~300 lines — one-time universal installer
  README.md
  test-hook.js

tools/
  experience-bulk-seed.js — bootstrap brain from existing rule files
```

## Supported Providers

| Embedding | Brain (extraction) |
|-----------|-------------------|
| Ollama (nomic-embed-text) | Ollama (qwen2.5:3b) |
| OpenAI (text-embedding-3-small) | OpenAI (gpt-4o-mini) |
| Gemini (text-embedding-004) | Gemini (gemini-2.0-flash) |
| VoyageAI (voyage-code-3) | Claude (haiku) |
| **SiliconFlow** (Qwen3-Embedding) | DeepSeek (deepseek-chat) |
| Any OpenAI-compatible | **SiliconFlow** (Qwen2.5-7B) |
| | Any OpenAI-compatible |

## Requirements

- Node.js 20+
- One of: Docker, Qdrant Cloud (free), or VPS with Qdrant
- One of: Ollama (free), or API key for any supported provider

## License

MIT
