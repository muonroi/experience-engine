# ADR-003: Experience Formation vNext

- **Status:** Accepted
- **Date:** 2026-04-22
- **Deciders:** muonroi
- **See also:** [specs/2026-04-22-experience-formation-vnext.md](../specs/2026-04-22-experience-formation-vnext.md)

## Context

Traditional AI memory systems store facts that accumulate linearly. This creates unbounded token cost and doesn't improve agent capability — it just gives the agent a bigger notebook.

## Decision

Experience formation pipeline with three tiers:
- **Lesson** — incident-local observation (e.g., "DbContext singleton caused state corruption")
- **Behavior** — reusable rule across similar cases (e.g., "stateful objects must be scoped")
- **Principle** — cross-domain wisdom that matches novel cases never seen before

Evolution algorithm promotes lessons to behaviors to principles, then deletes consumed entries. Over time, memory shrinks while coverage grows.

Priority order: Abstraction quality > Novel-case proof > Natural bootstrap > Cross-project reuse.

## Consequences

- **Positive:** Token cost shrinks over time instead of growing.
- **Positive:** Principles match cases never explicitly seen — true generalization.
- **Negative:** Evolution algorithm complexity — needs careful threshold tuning.
- **Negative:** Risk of over-abstraction creating vague principles.
