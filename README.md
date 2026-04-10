<p align="center">
  <h1 align="center">Experience Engine</h1>
  <p align="center">
    <strong>AI agents that learn from mistakes — not just store facts.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> ·
    <a href="#how-it-works">How It Works</a> ·
    <a href="#comparison">Comparison</a> ·
    <a href="#rest-api">REST API</a> ·
    <a href="#python-sdk">Python SDK</a>
  </p>
  <p align="center">
    <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-zero-brightgreen">
    <img alt="Works Offline" src="https://img.shields.io/badge/works-offline-blue">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow">
    <img alt="Node.js 20+" src="https://img.shields.io/badge/node-20%2B-green">
    <img alt="Tests" src="https://img.shields.io/badge/tests-49%20passing-brightgreen">
  </p>
</p>

---

<p align="center">
  <img src="demo.svg" alt="Experience Engine Demo" width="800">
</p>

Memory stores what you know. **Experience changes how you act.**

```
Without Experience Engine:
  Session 1: DbContext singleton → bug → 15 min debug
  Session 2: DbContext singleton → same bug → 15 min debug (again)
  Session 50: 200 notes. Still making the same mistakes. Still a junior.

With Experience Engine:
  Session 1: DbContext singleton → bug → lesson extracted automatically
  Session 2: About to repeat → hook fires → "⚠️ Last time this caused state corruption"
  Session 15: 3 similar lessons → evolved into principle:
              "Stateful objects must be scoped, never singleton"
  Session 16: RedisConnection singleton (NEVER SEEN) → principle matches → avoided
              Memory: 50 entries → 15 principles. Fewer entries. More coverage.
```

**The only AI memory system where capability grows while memory shrinks.**

## Why Not Just Memory?

Every AI memory tool (Mem0, Letta, Zep) stores facts. More sessions = more entries = more tokens = more cost. They're giving your agent a bigger notebook — but a notebook doesn't make you experienced.

Experience Engine is different:

| | Memory tools | Experience Engine |
|---|---|---|
| **Storage** | Facts accumulate forever | Lessons evolve into principles, entries get deleted |
| **Over time** | 500 entries = 500 entries | 500 entries → 15 principles (then entries deleted) |
| **Novel cases** | Only matches exact cases seen before | Principles match cases **never seen before** |
| **Token cost** | Grows linearly | **Shrinks** as principles replace specific entries |
| **Agent level** | Junior with a big notebook | Mid-level who understands **why** |

## Quick Start

```bash
git clone https://github.com/muonroi/experience-engine.git
cd experience-engine
bash .experience/setup.sh
```

Interactive wizard guides you through vector store + AI provider setup:

```
Step A — Vector store:    Qdrant Cloud (free) / Local Docker / VPS SSH tunnel
Step B — Embed provider:  OpenAI / Gemini / SiliconFlow / VoyageAI / Ollama / Custom
Step C — Brain provider:  OpenAI / Gemini / Claude / DeepSeek / SiliconFlow / Ollama / Custom
Step D — Agent wiring:    Claude Code / Gemini CLI / Codex CLI / OpenCode
```

**Done.** Your agent starts learning from mistakes immediately.

### Shortcuts

```bash
bash .experience/setup.sh --local   # Docker Qdrant + Ollama (100% free, 100% local)
bash .experience/setup.sh --vps     # VPS Qdrant via SSH tunnel
```

## How It Works

```
YOU write code with any AI agent
  │
  ├─ BEFORE every Edit/Write/Bash
  │   └─ Hook queries brain: "Have I seen this mistake before?"
  │   └─ Detects language from file being edited (.ts → TypeScript, .cs → C#)
  │   └─ Ranks results by quality: hit count, recency, confidence, domain match
  │   └─ Follows 1-hop graph edges to surface related experiences
  │   └─ If match → injects warning: "⚠️ Last time this caused X"
  │
  └─ AFTER every session
      └─ Extracts lessons from mistakes (retry loops, user corrections, test failures)
      └─ Stores Q&A in vector DB with domain tags
      └─ Evolution engine: promote confirmed → generalize clusters → prune stale
      └─ Memory shrinks as capability grows
```

## 4-Tier Architecture

```
T0 Principles  (~400 tokens)  — generalized rules, always loaded
T1 Behavioral  (~600 tokens)  — specific reflexes, always loaded
T2 QA Cache    (semantic)     — detailed Q&A, retrieved on match
T3 Raw         (staging)      — unprocessed, TTL 30 days

Lifecycle: T2 (3x confirmed) → promote T1 → generalize → T0
           T2 (3x ignored) → demote → archive
           Memory SHRINKS as capability GROWS
```

## Experience Graph

Experiences are linked with typed edges — not isolated entries:

```
DbContext singleton ──generalizes──→ "Stateful objects: always scoped"
                    ──relates-to───→ HttpClient singleton
                    ──supersedes───→ [old] "Use transient for DbContext"
```

**Edge types:**
- `generalizes` — principle created from cluster of specific lessons
- `contradicts` — demoted experience that conflicted with reality
- `supersedes` — newer knowledge replaces older (temporal chain)
- `relates-to` — high similarity but different domain

Retrieval follows 1-hop edges automatically — when one experience matches, related ones surface too.

## Temporal Reasoning

Knowledge evolves. Experience Engine tracks **when** things were confirmed, not just **what** was learned:

```
Jan: "Use singleton for HttpClient" (confirmed 5x)
Mar: "Actually, use IHttpClientFactory" (contradicts Jan entry)
     → Jan entry superseded, not deleted
     → New entry ranked higher (recent confirmation)
     → Timeline API shows the evolution
```

## Multi-User Support

Multiple users on the same machine get isolated stores:

```bash
EXP_USER=alice node server.js    # Alice's experiences
EXP_USER=bob node server.js      # Bob's experiences (completely isolated)
```

Share principles across users without sharing personal data:

```bash
# Alice shares a principle
curl -X POST localhost:8082/api/principles/share \
  -d '{"principleId": "abc-123"}'
# Returns portable JSON — no personal data

# Bob imports it
curl -X POST localhost:8082/api/principles/import \
  -d '{"principle": "...", "solution": "...", "confidence": 0.85}'
```

## REST API

Start the server:

```bash
node server.js
# Experience Engine API running on http://localhost:8082
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Qdrant + FileStore status |
| `POST` | `/api/intercept` | Query experience before tool call |
| `POST` | `/api/extract` | Extract lessons from session transcript |
| `POST` | `/api/evolve` | Trigger evolution cycle |
| `GET` | `/api/stats` | Observability data (`?since=7d`, `?all=true`) |
| `GET` | `/api/graph` | Edges for experience ID (`?id={uuid}`) |
| `GET` | `/api/timeline` | Knowledge evolution for topic (`?topic={text}`) |
| `GET` | `/api/user` | Current user identity |
| `POST` | `/api/principles/share` | Export principle as portable JSON |
| `POST` | `/api/principles/import` | Import shared principle |

Zero dependencies — uses Node.js built-in `http` module. CORS enabled for browser extensions.

### Example: Intercept

```bash
curl -X POST http://localhost:8082/api/intercept \
  -H "Content-Type: application/json" \
  -d '{"toolName": "Write", "toolInput": {"file_path": "src/db.ts"}}'
```

```json
{
  "suggestions": "⚠️ [Experience - High Confidence (0.85)]: Stateful objects must be scoped, never singleton",
  "hasSuggestions": true
}
```

## Python SDK

```bash
pip install muonroi-experience   # (or copy sdk/python/ directly)
```

```python
from muonroi_experience import Client

client = Client("http://localhost:8082")

# Query experience before tool call
result = client.intercept("Write", {"file_path": "app.py"})
if result["hasSuggestions"]:
    print(result["suggestions"])

# Extract lessons from a session
client.extract("Agent tried singleton for DbContext, caused state corruption...")

# Trigger evolution
evolution = client.evolve()
print(f"Promoted: {evolution['promoted']}, Abstracted: {evolution['abstracted']}")

# Check stats
stats = client.stats(since="7d")
print(f"Mistakes avoided: {stats['suggestions']}")

# View knowledge timeline
timeline = client.timeline("dependency injection")
for entry in timeline["timeline"]:
    print(f"  {'[superseded]' if entry['superseded'] else ''} {entry['solution']}")
```

Zero dependencies — uses Python stdlib `urllib`. Python 3.8+.

## Comparison

| | Mem0 | Letta | Zep | **Experience Engine** |
|---|---|---|---|---|
| **Architecture** | Vector + Graph | Tiered (OS-inspired) | KG + Temporal | **4-tier + Graph + Temporal** |
| **Learning** | Store facts | Agent self-edit | Store facts | **Extract → Evolve → Generalize** |
| **Over time** | Grows linearly | Grows linearly | Grows linearly | **Shrinks (principles replace entries)** |
| **Novel cases** | No | No | No | **Yes (principles generalize)** |
| **Mistake detection** | No | No | No | **Yes (5 patterns)** |
| **Local-first** | Optional | Optional | Partial | **Yes (FileStore default)** |
| **Dependencies** | Python + SDK | PostgreSQL + pgvector | PostgreSQL | **Zero (Node.js built-in)** |
| **Multi-agent** | Yes | Yes | Limited | **Yes (Claude/Gemini/Codex/OpenCode)** |
| **Multi-user** | Cloud | Cloud | Cloud | **Yes (namespaced, local)** |
| **Data ownership** | Cloud: vendor | Cloud: SaaS | Cloud: vendor | **You own everything** |
| **REST API** | Yes | Yes | Yes | **Yes** |
| **Python SDK** | Yes | Yes | Yes | **Yes** |

## Observability

```bash
node tools/exp-stats.js              # last 7 days
node tools/exp-stats.js --since 30d  # last 30 days
node tools/exp-stats.js --all        # all time
```

Shows: suggestions fired, hit rate, mistakes avoided, learning velocity, per-project breakdown.

## Bootstrap Brain Instantly

Don't wait months for organic learning. Seed from existing rules:

```bash
node tools/experience-bulk-seed.js --memory-dir ~/.claude/projects/*/memory
```

## Anti-Noise Scoring

Not all experiences are equal. The engine ranks by:

- **Hit frequency** — confirmed experiences rank higher
- **Recency** — recently confirmed > stale
- **Confidence aging** — new entries start lower, climb with confirmation
- **Ignore tracking** — suggestions ignored 3+ times get demoted
- **Domain match** — `.ts` file → TypeScript experiences rank higher
- **Temporal decay** — no confirmation in 60+ days → penalty
- **Superseded penalty** — replaced knowledge ranks lower

## Supported Providers

| Embedding | Brain (extraction) |
|-----------|-------------------|
| Ollama (nomic-embed-text) | Ollama (qwen2.5:3b) |
| OpenAI (text-embedding-3-small) | OpenAI (gpt-4o-mini) |
| Gemini (text-embedding-004) | Gemini (gemini-2.0-flash) |
| VoyageAI (voyage-code-3) | Claude (haiku) |
| SiliconFlow (Qwen3-Embedding) | DeepSeek (deepseek-chat) |
| Custom (any OpenAI-compatible) | SiliconFlow (Qwen2.5-7B) |
| | Custom (any OpenAI-compatible) |

## File Structure

```
.experience/
  experience-core.js    — brain (1236 LOC, zero deps)
  stop-extractor.js     — session extraction + evolution trigger
  setup.sh              — guided setup wizard

server.js               — REST API (270 LOC, zero deps)

sdk/
  python/               — Python SDK (pip install muonroi-experience)

tools/
  exp-stats.js          — observability CLI
  experience-bulk-seed.js — bootstrap from existing rules
  test-server.js        — 49 integration tests
  test-activity-log.js  — activity logging tests
  test-scoring.js       — anti-noise scoring tests
  test-context.js       — context-aware query tests
  test-exp-stats.js     — observability CLI tests
```

## Philosophy

> **"Enterprise AI replaces you. Personal AI empowers you. Same technology. Different owner."**

- Your data never leaves your machine (unless you choose cloud sync)
- Zero vendor lock-in — standard formats, portable profiles
- Engine is open source — you pay for convenience, not capability
- No "enterprise clone" mode — profiles belong to individuals, not companies

## Requirements

- Node.js 20+
- One of: Docker, Qdrant Cloud (free), or VPS with Qdrant
- One of: Ollama (free), or API key for any supported provider

## License

MIT
