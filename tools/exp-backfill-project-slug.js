#!/usr/bin/env node
'use strict';
/**
 * exp-backfill-project-slug.js
 *
 * Migrate legacy `_projectSlug` (root level) → `scope.project_slug` (nested).
 * Background: buildStorePayload originally wrote projectSlug at root level
 * but experience-core#applyScopeFilter reads `scope.project_slug` — schema
 * mismatch made the project gate dead code for ALL existing entries.
 * Entries without _projectSlug are left untouched (filter falls back to
 * pass-through when project_slug is null).
 *
 * Usage:
 *   node tools/exp-backfill-project-slug.js
 *   node tools/exp-backfill-project-slug.js --apply
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLLECTIONS_DEFAULT = ['experience-behavioral', 'experience-selfqa', 'experience-principles'];
const SCROLL_BATCH = 128;

function parseArgs(argv) {
  const args = { apply: false, collection: null, limit: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') args.apply = true;
    else if (k === '--collection') args.collection = argv[++i];
    else if (k === '--limit') args.limit = parseInt(argv[++i], 10) || Infinity;
    else if (k === '--qdrant-url') args.qdrantUrl = argv[++i];
    else if (k === '--qdrant-key') args.qdrantKey = argv[++i];
    else if (k === '--help' || k === '-h') {
      process.stdout.write(`exp-backfill-project-slug — copy _projectSlug -> scope.project_slug
  --apply              actually write (default: dry-run)
  --collection <name>  limit to one collection
  --limit <N>          stop after N points
`);
      process.exit(0);
    }
  }
  return args;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')); }
  catch { return {}; }
}

async function qdrantPost(qdrantUrl, qdrantKey, urlPath, body) {
  const res = await fetch(`${qdrantUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`qdrant ${res.status} ${res.statusText} on ${urlPath}`);
  return res.json();
}

async function* scrollCollection(qdrantUrl, qdrantKey, collection) {
  let offset = null;
  for (;;) {
    const body = { limit: SCROLL_BATCH, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const res = await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/scroll`, body);
    const points = res?.result?.points || [];
    if (points.length === 0) break;
    for (const p of points) yield p;
    offset = res?.result?.next_page_offset;
    if (!offset) break;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const qdrantUrl = (args.qdrantUrl || cfg.qdrantUrl || 'http://localhost:6333').replace(/\/$/, '');
  const qdrantKey = args.qdrantKey || cfg.qdrantKey || '';
  const collections = args.collection ? [args.collection] : COLLECTIONS_DEFAULT;
  const auditPath = path.join(os.homedir(), '.experience', `backfill-project-slug-${Date.now()}.jsonl`);
  const auditFd = fs.openSync(auditPath, 'a');

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalNoSlug = 0;
  let totalAlreadyHasInner = 0;
  const perColl = {};

  console.log(`mode=${args.apply ? 'APPLY' : 'DRY-RUN'}  qdrant=${qdrantUrl}  audit=${auditPath}`);

  for (const collection of collections) {
    perColl[collection] = { scanned: 0, updated: 0 };
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, collection)) {
      if (totalScanned >= args.limit) break;
      totalScanned++;
      perColl[collection].scanned++;

      let exp;
      try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const rootSlug = exp._projectSlug;
      const innerSlug = exp?.scope?.project_slug || exp?.scope?.projectSlug;
      if (!rootSlug) { totalNoSlug++; continue; }
      if (innerSlug) { totalAlreadyHasInner++; continue; }

      fs.writeSync(auditFd, JSON.stringify({ ts: new Date().toISOString(), collection, id: point.id, action: 'project-slug-copy', value: rootSlug }) + '\n');

      if (args.apply) {
        if (!exp.scope || typeof exp.scope !== 'object') exp.scope = {};
        exp.scope.project_slug = rootSlug;
        await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/payload`, {
          points: [point.id],
          payload: { json: JSON.stringify(exp) },
        });
      }
      totalUpdated++;
      perColl[collection].updated++;
    }
    if (totalScanned >= args.limit) break;
  }

  fs.closeSync(auditFd);
  console.log('\n=== summary ===');
  for (const [c, s] of Object.entries(perColl)) {
    console.log(`  ${c}: scanned=${s.scanned} updated=${s.updated}`);
  }
  console.log(`total scanned=${totalScanned} updated=${totalUpdated} no-root-slug=${totalNoSlug} already-has-inner=${totalAlreadyHasInner}`);
  console.log(args.apply ? 'APPLIED.' : 'DRY-RUN — pass --apply to commit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
