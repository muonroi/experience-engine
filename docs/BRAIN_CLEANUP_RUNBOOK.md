# Brain Cleanup Runbook

> Periodic maintenance for the Experience Engine brain (Qdrant collections
> `experience-behavioral`, `experience-selfqa`, `experience-principles`).
>
> The brain accumulates mis-scoped or empty entries over time because ingest
> (`bulk-extract.js` via `upgrade.sh`) cannot always resolve a session's repo
> from the local filesystem (container sessions with no `.git`, synced
> transcripts, changelog-style notes with no `files_touched`). This is **by
> design** — the engine refuses to guess a scope rather than pin entries to a
> slug no caller derives (see commits `1226b16`, `8d90964`). Cleanup is a
> human-in-the-loop read-and-relabel operation, never automated guessing.
>
> Authored 2026-07-29 after a real cleanup pass: 695 → 657 entries, UNSCOPED
> 55% → 17%, with the methodology below.

---

## When to run

- After every `upgrade.sh` batch if `exp-hint-stats.js` shows UNSCOPED > ~25%,
  or entries with `ignoreCount` in the hundreds/thousands (spam signal).
- Ad hoc when recall starts surfacing cross-project noise (a hint about
  TypeScript firing while you edit Go, etc.).

## Prerequisites

- SSH access to the VPS hosting the brain (`experience-engine-qdrant-1`).
- Qdrant healthy — check `curl -s http://127.0.0.1:6333/collections` returns
  the 3 experience collections. If it returns connection-reset, see
  **"Qdrant fd exhaustion"** in the Troubleshooting section below BEFORE
  proceeding — a down Qdrant makes every step here return empty.

---

## Step 1 — Inventory (read-only)

Scroll every experience collection and aggregate by `project_slug`, `lang`,
and `ignoreCount`. This tells you the shape of the mess before touching
anything.

```python
# Run on the VPS. Requires nothing but python3 (stdlib only).
import json, urllib.request
from collections import Counter
BASE = "http://127.0.0.1:6333"
def scroll(col):
    out, offset = [], None
    while True:
        body = {"limit": 500, "with_payload": True, "with_vector": False}
        if offset: body["offset"] = offset
        req = urllib.request.Request(f"{BASE}/collections/{col}/points/scroll",
              data=json.dumps(body).encode(),
              headers={"Content-Type": "application/json"})
        r = json.load(urllib.request.urlopen(req))["result"]
        out += r["points"]; offset = r.get("next_page_offset")
        if not offset: break
    return out
def getj(pl):
    j = pl.get("json")
    if isinstance(j, str):
        try: return json.loads(j)
        except: return {}
    return j or {}

proj, unscoped, garbage = Counter(), 0, 0
for col in ["experience-behavioral", "experience-selfqa", "experience-principles"]:
    for p in scroll(col):
        j = getj(p.get("payload") or {})
        sc = j.get("scope") or {}
        ps = sc.get("project_slug") or "UNSCOPED"
        proj[ps] += 1
        if ps == "UNSCOPED": unscoped += 1
        # garbage = no textual content in ANY field
        if not any(str(j.get(k,"")).strip() for k in ("trigger","when","solution","rule","text")):
            garbage += 1
print(f"UNSCOPED: {unscoped}  garbage(empty): {garbage}")
for k, c in proj.most_common(): print(f"  {c:4d}  {k}")
```

**Decision gate:**
- UNSCOPED < ~15% and no garbage → brain is healthy, stop here.
- Otherwise continue to Step 2.

---

## Step 2 — Delete true garbage (safe)

"Garbage" = entries whose payload `json` is `{}` or has **no textual content
in any field** (`trigger`/`when`/`solution`/`rule`/`text` all empty). These are
corrupt/failed ingests, not lessons. Deleting them loses nothing.

```python
# Delete empty-payload points. ALWAYS dry-run the selection first (Step 1
# already counts them). Qdrant delete is irreversible — back up the volume
# (snapshot) before the first time you run this on a given brain.
for col in ["experience-behavioral", "experience-selfqa", "experience-principles"]:
    ids = []
    for p in scroll(col):
        j = getj(p.get("payload") or {})
        if not any(str(j.get(k,"")).strip() for k in ("trigger","when","solution","rule","text")):
            ids.append(str(p["id"]))
    if not ids: continue
    body = json.dumps({"points": ids}).encode()
    req = urllib.request.Request(f"{BASE}/collections/{col}/points/delete?wait=true",
          data=body, headers={"Content-Type":"application/json"}, method="POST")
    json.load(urllib.request.urlopen(req))
    print(f"{col}: deleted {len(ids)} empty")
```

**Do NOT delete based on high `ignoreCount` alone.** A high ignore-count with
real content means the entry is *over-triggered*, not wrong — it belongs to a
scope nobody queries, or has no scope at all. The fix is to relabel its scope
(Step 3), not delete the lesson. Deleting content because it fires too often
throws away knowledge.

---

## Step 3 — Relabel scope (read-then-remap, NEVER regex-guess)

This is the core of the cleanup and the step most likely to be done wrong.

### The maintainer's principle (non-negotiable)

> Refusing to guess is the point. An entry read UNSCOPED is recallable
> EVERYWHERE — which for a cross-cutting lesson (docker, git, ssh) is the
> correct scope. A wrong pin hides it from the project it belongs to.
> Only remap a slug when you have **read the entry's content** and it
> unambiguously identifies one repo. Anything ambiguous stays UNSCOPED or
> goes to a REVIEW bucket for a human.

The bundled `tools/exp-repair-slugs.js` encodes this: an explicit `REMAP` map
of `{ bogus_slug: real_slug }` derived from reading entries, an `UNSCOPE` set
for workspace roots, and a `REVIEW` set for ambiguous cases it refuses to
decide. **Use it as the pattern, not a one-off.**

### Procedure

1. **Dump the candidates.** For each UNSCOPED or suspicious slug, print 2-3
   sample entries' `trigger`/`solution` so you can read what the content is.

2. **Classify each slug into exactly one bucket:**
   - `REMAP` — content unambiguously names ONE repo (e.g. "Muonroi.Pdf Engine"
     → `muonroi-dotnet`). Add to the map.
   - `UNSCOPE` — content is true everywhere (workspace root, generic shell/git
     tricks). Stays global.
   - `REVIEW` — content mixes repos or doesn't settle the question. **Leave
     untouched** and decide by hand. Do not force a guess.

3. **Apply via `exp-repair-slugs.js --apply`** (after a `--dry-run`), OR via
   the direct Qdrant `set_payload` shown below if you need a one-off map. The
   tool preserves `project_repaired_from` so the original label is recoverable.

```python
# Minimal apply loop for a hand-built {from_slug: to_slug_or_None} map.
# to=None means unscope (delete project_slug, keep the entry).
MAP = {
  "muonroi.pdf engine": "muonroi-dotnet",   # read the content, then fill this
  "core": None,                              # workspace root → global
}
def patch_for(point, to):
    payload = point.payload or {}
    exp = json.loads(payload.get("json","{}"))
    scope = exp.get("scope") or {}
    if scope.get("project_slug") and not scope.get("project_repaired_from"):
        scope["project_repaired_from"] = scope["project_slug"]
    if to: scope["project_slug"] = to
    else: scope.pop("project_slug", None)
    exp["scope"] = scope
    out = {"json": json.dumps(exp)}
    if to: out["scope_project_slug"] = to
    return out
# ... scroll, match by content, POST /collections/<col>/points/payload
```

### What NOT to do

- ❌ Keyword/regex inference ("if text contains 'angular' → storyflow_ui"). This
  was removed from the engine deliberately (`1226b16`) because guessing creates
  debris faster than it cleans it. If you want automated help, the engine
  delegates classification to the brain LLM — not a regex table.
- ❌ Bulk-unscoping everything to "clean up." Unscoping a repo-specific lesson
  turns it into cross-project noise.
- ❌ Deleting entries with high `ignoreCount` and real content. Narrow their
  scope or unscope them; the lesson itself is valuable.

---

## Step 4 — Verify

Re-run the Step 1 inventory. Expect:
- UNSCOPED dropped materially (target < ~20%).
- No empty-payload garbage remaining.
- Recall scoped to a project returns relevant entries (test with a known
  query, e.g. `POST /api/recall {"query":"...","project":"shipd-challenges"}`).

---

## Troubleshooting

### Qdrant returns "Connection reset by peer" / empty responses

The Qdrant container is out of file descriptors. Symptom in `docker logs
experience-engine-qdrant-1`:

```
ERROR actix_server::accept: error accepting connection: Too many open files (os error 24)
ERROR collection::update_handler: Failed to flush: ... Too many open files
```

**Fix:** raise the `nofile` ulimit on the `qdrant` service in
`docker-compose.yml`, then recreate the container:

```yaml
  qdrant:
    # ... existing config ...
    ulimits:
      nofile:
        soft: 65536
        hard: 262144
```

```bash
cd ~/experience-engine
cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d)
# (edit docker-compose.yml to add the ulimits block above)
docker compose up -d qdrant          # recreates only qdrant, leaves EE + ollama running
docker exec experience-engine-qdrant-1 sh -c 'ulimit -n'   # confirm 65536
curl -s http://127.0.0.1:6333/collections | head -c 200    # confirm API responds
```

This is an ops bug, not a data bug — fix it before any cleanup or every
inventory query returns empty and you'll misdiagnose an empty result as
"nothing to clean."

### exp-hint-stats.js returns empty / hangs

Same root cause as above — it queries Qdrant via the server, which is
resetting connections. Fix Qdrant first.

### `project_slug` edits change the entry's stable id

`stableId` hashes `projectSlug`, so relabelling inserts under a new id and
orphans the old point. After a remap pass, run the inverse scroll to delete
orphaned old-id points if the brain has a duplicate-detection gap. (The
`exp-repair-slugs.js` NOTE documents this; re-import after repair is the
expected path, not a bug.)
