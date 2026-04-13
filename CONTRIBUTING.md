# Contributing to Experience Engine

Thanks for your interest! Here's how to help.

## Quick Links

- [Issues](https://github.com/muonroi/experience-engine/issues) — bug reports and feature requests
- [Discussions](https://github.com/muonroi/experience-engine/discussions) — questions, ideas, show your principles

## Development Setup

```bash
git clone https://github.com/muonroi/experience-engine.git
cd experience-engine
bash .experience/setup.sh --local   # Docker Qdrant + Ollama
```

## Running Tests

```bash
node tools/test-server.js       # REST API tests (49 assertions)
node tools/test-scoring.js      # Anti-noise scoring tests
node tools/test-context.js      # Context-aware query tests
node tools/test-activity-log.js # Activity logging tests
node tools/test-exp-stats.js    # Observability CLI tests
```

All tests must pass with zero dependencies — Node.js 20+ only.

## Code Style

- **Zero npm dependencies** — this is a hard rule. Use Node.js built-in modules only.
- **Silent failures** — engine operations never crash the host. Wrap in try/catch.
- **Dual backend** — every storage operation must work with both Qdrant and FileStore.
- **Activity logging** — new operations should call `activityLog()`.

## What to Contribute

**High impact:**
- Mistake detection patterns (currently 5 — more is better)
- Provider implementations (new embedding/brain providers)
- Evolution algorithm improvements
- Real-world dogfood reports ("my agent learned X after Y sessions")

**Welcome:**
- Documentation improvements
- Test coverage for edge cases
- Bug fixes with regression tests
- Performance optimizations (especially embedding batching)

**Please discuss first:**
- New API endpoints
- Architecture changes
- Adding npm dependencies (answer is almost certainly "no")

## Submitting Changes

1. Fork → branch → change → test → PR
2. PR title: `feat:`, `fix:`, `docs:`, `test:` prefix
3. All tests must pass
4. Zero new dependencies

## Show Your Principles

The most interesting contribution: share what your Experience Engine learned!

Start a [Discussion](https://github.com/muonroi/experience-engine/discussions) with:
- How long you've been using it
- How many principles evolved
- The most surprising novel case a principle caught

This helps validate the "experience > memory" thesis with real data.
