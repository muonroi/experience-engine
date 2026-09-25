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
npm run test:ci     # everything CI runs
npm test            # tests/*.test.js         — server, CLI, integration
npm run test:unit   # tests/runtime/*.test.js — hook runtime (.experience/)
npm run test:tools  # tests/tools/*.test.js   — operator tools (tools/)
```

New tests go under `tests/` (`tests/runtime/` for `.experience/` code, `tests/tools/`
for `tools/`), named `*.test.js`. `tests/manual/` holds scripts that need real local
session data and are not run in CI.

All tests must pass with zero dependencies — Node.js 22+ only.

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

## Releasing

Releases are published by `.github/workflows/release.yml` when a tag is pushed.

**npm package** (`@muonroi/experience-engine`):

```bash
npm version <patch|minor|major> -m "chore(release): v%s"   # bumps package.json, syncs openapi.yaml, commits, tags
git push origin develop --follow-tags
```

The workflow checks the tag equals `package.json`, runs the CI suite, publishes with
npm provenance and creates the GitHub release.

**Python SDK** (`muonroi-experience`): bump `version` in `sdk/python/pyproject.toml` and
`__version__` in `sdk/python/muonroi_experience/__init__.py`, commit, then
`git tag python-sdk-vX.Y.Z && git push origin python-sdk-vX.Y.Z`.

One-time setup by a maintainer:

- npm: on npmjs.com, add `muonroi/experience-engine` / `release.yml` / environment `npm`
  as a Trusted Publisher — or store an automation token as the `NPM_TOKEN` secret.
- PyPI: on pypi.org, add `muonroi/experience-engine` / `release.yml` / environment `pypi`
  as a Trusted Publisher.
- GitHub: create the `npm` and `pypi` environments (Settings → Environments); add
  required reviewers there if releases should need approval.
