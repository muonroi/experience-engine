---
name: post-donor-enrich-runbook
description: storyflow — ordered procedure to run after a donor source finishes (enrich → gap-census → relaunch)
metadata:
  type: project
  node_type: runbook
  derivedFromId: [4c81b5ca, d1934712, 1e5f095f]
---

Post-donor enrich (storyflow). Run after a donor source finishes. This entry is the
**procedure index** — the ordered steps only; each step's detail lives in its linked
atomic entry (do not duplicate it here).

1. **Source enrichment** — fill chapter-count + metadata from the donor source.
   → [[project_source_enrichment_validated]] (chapter-COUNT cross-source fill),
     [[metadata_enrich]] (metadata + title diacritic backfill).
2. **Gap census** — find content gaps and backfill biggest-first (crawl only gap > 10).
   → [[xtruyen-salvage]] (chapter-CONTENT gap backfill).
3. **Relaunch a fresh container after the proxy is live** — the cooldown does not
   self-heal, so a stale container must be replaced, not waited out.

Detail, exact commands, and flags for each step live in the linked atomic entries above.
