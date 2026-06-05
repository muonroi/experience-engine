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

Or use the interactive setup:

```bash
bash .experience/setup.sh
```

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

## Requirements

- Node.js 20+
- One of: Docker · Qdrant Cloud (free tier) · VPS with Qdrant
- One of: Ollama (free, local) · API key for any supported provider

## License

MIT © [muonroi](https://github.com/muonroi)
