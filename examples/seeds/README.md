# Example seed files

Each file here is an **example** for one evidence class. Use `seed-ingest.js` to
load entries into your local Qdrant brain after editing scope/org to match your
own setup.

## Files

| File | Class | Notes |
|---|---|---|
| `org-doc.example.jsonl` | `org-doc` | Per-org knowledge. Every entry must set `scope.org` — only fires inside the matching org's repos. The shipped file is a real example from the engine author's stack; **replace before ingesting** unless you literally work on the same codebase. |

For universal hints (OWASP, 12-Factor, SRE patterns) see
`../../seed-common-principles.jsonl` at the repo root — those entries are
deliberately org-less (`evidenceClass: "common-doc"`) and safe to ingest as-is.

## Ingesting

```bash
node .experience/seed-ingest.js examples/seeds/org-doc.example.jsonl
```

The script validates each entry against the evidence-class contract before
upserting. Errors are reported per-line so you can fix and re-run.
