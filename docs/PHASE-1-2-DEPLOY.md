# Phase 1 + 2 Deploy Guide

> EE server changes for BB-aware /ideal.
> **User executes these steps on VPS `72.61.127.154`.** Agent does NOT push or deploy.

## What changed

| Phase | Change | File |
|---|---|---|
| 1.1 | `canonicalizeProjectSlug()` helper | `lib/path-canonical.js` |
| 1.2 | Wire into `deriveCallerMeta` in `server.js` | `server.js` |
| 1.3 | `handleStats` response now includes `bySlug` bucket | `server.js` |
| 1.4 | Unit tests | `tests/path-canonical.test.js` |
| 1.5 | Backfill migration script | `scripts/backfill-project-slug.mjs` |
| 2.1 | `bb-behavioral` added to `KNOWN_COLLECTIONS` + auto-created on startup | `server.js` |
| 2.2 | `bb-recipes` added to `KNOWN_COLLECTIONS` + auto-created on startup | `server.js` |
| 2.2b | `--rollback` flag in split script | `scripts/split-bb-behavioral.mjs` |
| 2.3 | Copy BB points from `experience-behavioral` → `bb-behavioral` | `scripts/split-bb-behavioral.mjs` |
| 2.4 | Dedup within `bb-behavioral` (archive near-dupes ≥ 0.97 cosine) | `scripts/split-bb-behavioral.mjs` |

---

## VPS restart procedure

```bash
# SSH into VPS
ssh -i ~/.ssh/muonroi_vps_rsa phila@72.61.127.154

# Pull the latest develop branch
cd /opt/muonroi/experience-engine
git fetch origin
git checkout develop
git pull origin develop

# Restart the server (adjust if using systemd unit vs. pm2)
# Option A — systemd:
sudo systemctl restart experience-engine

# Option B — pm2:
pm2 restart experience-engine

# Verify server is healthy
curl -s http://localhost:8082/health | jq .
```

---

## Step 1 — Verify server health + new collections

After restart, confirm:

```bash
# Health check
curl -s http://localhost:8082/health | jq .qdrant

# Stats — should now include bySlug field
curl -s -H "Authorization: Bearer <readAuthToken>" \
  "http://localhost:8082/api/stats?since=30d" | jq '{bySlug}'

# Check bb-behavioral collection was auto-created
curl -s http://localhost:6333/collections/bb-behavioral | jq .result.status
# Expected: "green" or "ok"

curl -s http://localhost:6333/collections/bb-recipes | jq .result.status
# Expected: "green" or "ok"
```

---

## Step 2 — Run backfill (Phase 1.5)

Dry-run first to see what will be updated:

```bash
cd /opt/muonroi/experience-engine
node scripts/backfill-project-slug.mjs --dry-run --collections=experience-behavioral
```

Apply:

```bash
node scripts/backfill-project-slug.mjs --collections=experience-behavioral
```

---

## Step 3 — Run BB split migration (Phase 2.3 + 2.4)

Dry-run:

```bash
node scripts/split-bb-behavioral.mjs --dry-run
```

Apply (migration + dedup):

```bash
node scripts/split-bb-behavioral.mjs
```

---

## Step 4 — Verification queries (Phase 2.6)

```bash
# Search bb-behavioral for BB-specific rules
curl -s -X POST http://localhost:8082/api/search \
  -H "Authorization: Bearer <authToken>" \
  -H "Content-Type: application/json" \
  -d '{"query":"MExtractAsRule","collections":["bb-behavioral"],"limit":5}' | jq '.points[] | {score, text: .text[:80]}'
# Expected: ≥1 hit with score >0.65, all from bb-behavioral.

# Confirm experience-behavioral still has its points (non-destructive migration)
curl -s -X POST http://localhost:8082/api/search \
  -H "Authorization: Bearer <authToken>" \
  -H "Content-Type: application/json" \
  -d '{"query":"MExtractAsRule","collections":["experience-behavioral"],"limit":5}' | jq '.points | length'
# Expected: same count as before migration.

# Stats bySlug should show muonroi-building-block bucket
curl -s -H "Authorization: Bearer <readAuthToken>" \
  "http://localhost:8082/api/stats?since=30d" | jq '.bySlug | to_entries | sort_by(-.value) | .[0:5]'
```

---

## Rollback (if needed)

```bash
# Delete bb-behavioral + bb-recipes and reset state
node scripts/split-bb-behavioral.mjs --rollback
```

This removes `bb-behavioral` and `bb-recipes` from Qdrant and resets
`scripts/.split-bb-state.json`. The `KNOWN_COLLECTIONS` set in `server.js`
still references them — a subsequent server restart will re-create empty
collections (safe). To fully undo the code changes, `git revert` the Phase 2
commit and redeploy.
