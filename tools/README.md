# Experience Engine — Tools

## qdrant-find.js

Inspect vector-memory collections with the same config and user namespace that
Experience Engine already uses.

### Usage

```bash
# Semantic query across default collections
node tools/qdrant-find.js "experience formation"

# Restrict to one collection and print JSON
node tools/qdrant-find.js "novel case proof" --collection experience-principles --json

# Text/scroll mode when you want raw payload substring matching
node tools/qdrant-find.js "natural bootstrap" --mode scroll --collection experience-behavioral

# Show visible collections
node tools/qdrant-find.js --list-collections
```

Defaults:

- reads `~/.experience/config.json`
- uses the active `EXP_USER` namespace (or `default`)
- searches `experience-principles`, `experience-behavioral`,
  `experience-selfqa`, and `experience-routes`

## exp-holdout-harness.js

Run explicit seed-vs-holdout replay suites against principle candidates and
optionally write real novel-case proof evidence back into `novelCaseEvidence`.

### Usage

```bash
# Evaluate a fixture without mutating evidence
node tools/exp-holdout-harness.js --fixture ./fixtures/holdout.json

# Replay and write holdout tested/matched counts back to the target principle
node tools/exp-holdout-harness.js --fixture ./fixtures/holdout.json --apply --json

# Run every curated fixture suite in the repo
node tools/exp-holdout-harness.js --fixture ./fixtures/holdout --json
```

## Engine lift and Bayesian confidence

The experiment tools behind ADR-004 (`docs/adrs/004-measured-lift-and-bayesian-confidence.md`).
All read-only.

```bash
# Phase A0: can a holdout detect anything? Prints GO / NO-GO with the reasons.
node tools/exp-outcome-baseline.js --holdout-share 0.15 --weeks 3

# Phase A: analyse the holdout (control − treatment); a decision only on/after --end-date.
node tools/exp-engine-lift.js --end-date 2026-11-01
# Phase B ab: beta − legacy with the pre-registered keep/kill rule.
node tools/exp-engine-lift.js --compare model --end-date 2026-12-01

# B0: legacy vs beta gate on the corpus (Qdrant by default, or --store / --from-file).
node tools/exp-beta-replay.js --json
```

`exp-reset-ignore-count.js --beta` also clears the negative side of `betaEvidence`.

## experience-bulk-seed.js

Bootstrap your experience brain from existing memory/feedback files.
Reads `feedback_*.md` files, converts them to behavioral rules (Tier 1) or principles (Tier 0), and seeds them into Qdrant.

### Prerequisites

- Run `bash .experience/setup.sh` first (configures provider, creates Qdrant collections)
- Node.js 22+

### Usage

```bash
# Default: seed Tier 1 behavioral rules from auto-detected memory dir
node tools/experience-bulk-seed.js

# Dry run — show what would be seeded without writing to Qdrant
node tools/experience-bulk-seed.js --dry-run

# Custom memory directory
node tools/experience-bulk-seed.js --memory-dir /path/to/memory

# Seed as Tier 0 principles instead of Tier 1 rules
node tools/experience-bulk-seed.js --tier 0
```

### Provider Support

bulk-seed uses the same embed provider configured in `~/.experience/config.json`.
No separate configuration needed — whatever you chose in setup.sh applies here.

**Ollama (local):**
```bash
# Just works — uses Ollama config from setup.sh
node tools/experience-bulk-seed.js
```

**OpenAI:**
```bash
# Uses OpenAI embed config from setup.sh (model, key stored in config.json)
node tools/experience-bulk-seed.js
```

**SiliconFlow:**
```bash
# Uses SiliconFlow endpoint/key from config.json
node tools/experience-bulk-seed.js
```

**Custom endpoint:**
```bash
# Uses custom endpoint configured in setup.sh
node tools/experience-bulk-seed.js
```

### Troubleshooting

- **"embedDim not set"** — Run `setup.sh` first
- **"Collection dim mismatch"** — Re-run `setup.sh` (it recreates collections with correct dims)
- **"Cannot load experience-core.js"** — Run `setup.sh` to install engine files
