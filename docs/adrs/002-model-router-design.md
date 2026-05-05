# ADR-002: Intelligent Model Router

- **Status:** Accepted
- **Date:** 2026-04-10
- **Deciders:** muonroi
- **Supersedes:** N/A
- **See also:** [specs/2026-04-10-model-router-design.md](../specs/2026-04-10-model-router-design.md)

## Context

AI agent sessions waste tokens and latency by using the same model tier for all tasks. Simple tasks (file reads, config tweaks) don't need premium models, while complex tasks (architecture, debugging) benefit from them.

## Decision

Two-layer routing architecture:
1. **History semantic search** (~50ms) — match task against past routing decisions stored in Qdrant.
2. **Brain classifier fallback** (~200ms) — LLM-based classification when no history match exists.

Three tiers: `fast`, `balanced`, `premium`. Endpoints: `/api/route-task`, `/api/route-model`, `/api/route-feedback`.

## Consequences

- **Positive:** Token cost reduction by routing simple tasks to cheaper models.
- **Positive:** Learning loop — route feedback improves future routing accuracy.
- **Negative:** Adds ~50-200ms latency per task start.
- **Negative:** Requires brain LLM availability for cold-start classification.
