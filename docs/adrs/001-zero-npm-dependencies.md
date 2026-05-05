# ADR-001: Zero npm Dependencies

- **Status:** Accepted
- **Date:** 2026-03-01
- **Deciders:** muonroi

## Context

Experience Engine hooks run in the critical path of AI agent tool calls (PreToolUse, PostToolUse). Any dependency adds supply chain risk, install time, and potential breakage. The engine must also work offline and in air-gapped environments.

## Decision

Use only Node.js built-in modules (`http`, `fs`, `path`, `os`, `crypto`, `child_process`). No npm dependencies for runtime code.

Dev dependencies (ESLint, Prettier, c8) are allowed for development workflows only.

## Consequences

- **Positive:** Zero supply chain risk, instant install (`npm pack` is tiny), works offline, no version conflicts with host project.
- **Positive:** Dockerfile requires no `npm install` step — just `COPY` and `CMD`.
- **Negative:** Must re-implement utilities that libraries provide (JSON schema validation, structured logging, HTTP routing).
- **Negative:** Embedding/brain provider HTTP calls use raw `fetch()` instead of SDKs.
