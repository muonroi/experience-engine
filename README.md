<h1 align="center">Experience Engine</h1>

<p align="center">
  <strong>Continual learning infrastructure for AI coding agents.</strong><br>
  Agents don't just remember facts — they learn from mistakes, generalize principles, and get better with every session.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-20%2B-green">
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/runtime%20deps-zero-brightgreen">
  <img alt="Works Offline" src="https://img.shields.io/badge/works-offline-blue">
  <img alt="Agents" src="https://img.shields.io/badge/agents-Claude%20%7C%20Codex%20%7C%20Gemini%20%7C%20OpenCode%20%7C%20Antigravity-purple">
  <img alt="npm" src="https://img.shields.io/npm/v/@muonroi/experience-engine">
</p>

---

> Instead of accumulating facts linearly, knowledge evolves: incidents are captured, promoted to behavioral rules when confirmed, and generalized into principles that fire on novel cases never seen before. Memory shrinks as capability grows.

<p align="center">
  <img src="demo.gif" alt="Experience Engine intercepting a mistake in real time" width="820">
</p>

## Quick Start

**Just want to use it?** One command — any OS (Windows, macOS, Linux), no `git clone`, no Docker, no bash:

```bash
npx @muonroi/experience-engine init
```

`init` auto-detects a brain and wires your coding agent's hooks for you:

1. A local brain already running at `http://localhost:8082` → uses it (no token).
2. Otherwise, if Docker is available, it offers to start the local stack for you.
3. Otherwise it sets up a **thin client** against a remote brain — point it at one:

```bash
npx @muonroi/experience-engine init --server https://your-brain.example.com --token <TOKEN>
```

Add `--yes` for a non-interactive install. Windows is supported natively — no Git Bash required.

### Self-host the brain (advanced)

To run the full stack (Qdrant + Ollama + API) on your own machine:

```bash
git clone https://github.com/muonroi/experience-engine.git
cd experience-engine
docker compose up -d
```

Starts Qdrant (6333), Ollama (11434), and Experience Engine API (8082). Zero API keys. Zero config files.

```bash
curl http://localhost:8082/health
# {"status":"ok","qdrant":{"status":"ok"},"fileStore":{"status":"ok"}}
```

Then run `npx @muonroi/experience-engine init` (or `bash .experience/setup.sh` for the full local-install wizard) to wire your agent to it.

## Documentation

Full documentation at **[docs.muonroi.com/docs/experience-engine](https://docs.muonroi.com/docs/experience-engine/overview)**

| Topic | Link |
|---|---|
| Overview & architecture | [Overview](https://docs.muonroi.com/docs/experience-engine/overview) |
| Getting started | [Getting Started](https://docs.muonroi.com/docs/experience-engine/getting-started) |
| How it works | [How It Works](https://docs.muonroi.com/docs/experience-engine/how-it-works) |
| Configuration reference | [Configuration](https://docs.muonroi.com/docs/experience-engine/configuration) |
| REST API reference | [API Reference](https://docs.muonroi.com/docs/experience-engine/api-reference) |
| Observability & stats | [Observability](https://docs.muonroi.com/docs/experience-engine/observability) |
| Python SDK | [Python SDK](https://docs.muonroi.com/docs/experience-engine/python-sdk) |

## Agent instructions (auto-managed)

Install and upgrade write a small **managed block** (delimited by
`<!-- experience-engine:start -->` / `<!-- experience-engine:end -->`) into each
installed agent's config — `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`,
`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` — so agents load the
Experience Engine workflow at session start. The block is refreshed idempotently
on every `upgrade.sh`, so guidance never goes stale.

The block stays concise and points to the full reference shipped at
`~/.experience/AGENT_GUIDE.md` (active recall, the feedback verdict table, and the
noise decision tree). The two commands agents use:

```bash
node ~/.experience/exp-recall.js "<your question>"          # actively query the brain
node ~/.experience/exp-feedback.js followed|ignored|noise <id> <col>   # report the verdict
```

Use the helper for feedback — never raw `curl …:8082/api/feedback`, which
silently no-ops on thin-client installs.

To manage your own agent config instead, set `EXPERIENCE_SKIP_MD_INJECT=1` before
running setup/upgrade and the injection is skipped.

## Requirements

- Node.js 20+
- One of: Docker · Qdrant Cloud (free tier) · VPS with Qdrant
- One of: Ollama (free, local) · API key for any supported provider

## License

MIT © [muonroi](https://github.com/muonroi)
