#!/usr/bin/env node
'use strict';
/**
 * exp-backfill-framework-from-flat.js
 *
 * Repair inner JSON `scope.framework` for legacy entries by copying from the
 * Qdrant-indexed flat `scope_framework` field. Background: the seeder
 * defaulted inner `scope.framework="any"` while the indexer (evolution.js
 * buildScopeFlatFields) extracted the correct framework from content.
 * Survey of 30 random entries with inner=any showed 30/30 had a correct
 * specific framework in the flat field — so flat is ground truth.
 *
 * Behavior:
 *   - DRY-RUN by default. Pass --apply to write.
 *   - Audit log to ~/.experience/backfill-framework-flat-<ts>.jsonl
 *
 * Usage:
 *   node tools/exp-backfill-framework-from-flat.js
 *   node tools/exp-backfill-framework-from-flat.js --apply
 *   node tools/exp-backfill-framework-from-flat.js --collection experience-behavioral --apply
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
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`exp-backfill-framework-from-flat — copy flat scope_framework -> inner scope.framework
  --apply              actually write (default: dry-run)
  --collection <name>  limit to one collection
  --limit <N>          stop after N points overall
  --qdrant-url <url>   override (default from ~/.experience/config.json)
  --qdrant-key <key>   override (default from config)
`);
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
  const auditPath = path.join(os.homedir(), '.experience', `backfill-framework-flat-${Date.now()}.jsonl`);
  const auditFd = fs.openSync(auditPath, 'a');
  const writeAudit = (rec) => fs.writeSync(auditFd, JSON.stringify(rec) + '\n');

  let totalScanned = 0;
  let totalCandidates = 0;
  let totalUpdated = 0;
  let totalSkippedFlatMissing = 0;
  let totalSkippedFlatAlsoAny = 0;
  const perColl = {};

  console.log(`mode=${args.apply ? 'APPLY' : 'DRY-RUN'}  qdrant=${qdrantUrl}  audit=${auditPath}`);

  for (const collection of collections) {
    perColl[collection] = { scanned: 0, candidates: 0, updated: 0 };
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, collection)) {
      if (totalScanned >= args.limit) break;
      totalScanned++;
      perColl[collection].scanned++;

      let exp;
      try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const innerFw = exp?.scope?.framework;
      if (innerFw !== 'any') continue; // only fix entries with inner=any
      totalCandidates++;
      perColl[collection].candidates++;

      const flatFw = point.payload?.scope_framework;
      if (!flatFw) { totalSkippedFlatMissing++; continue; }
      if (flatFw === 'any') { totalSkippedFlatAlsoAny++; continue; }

      const before = innerFw;
      const after = flatFw;
      writeAudit({ ts: new Date().toISOString(), collection, id: point.id, action: 'framework-flat-copy', before, after });

      if (args.apply) {
        if (!exp.scope || typeof exp.scope !== 'object') exp.scope = {};
        exp.scope.framework = flatFw;
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
    console.log(`  ${c}: scanned=${s.scanned} candidates=${s.candidates} updated=${s.updated}`);
  }
  console.log(`total scanned=${totalScanned} candidates=${totalCandidates} updated=${totalUpdated}`);
  console.log(`skipped: flat-missing=${totalSkippedFlatMissing} flat-also-any=${totalSkippedFlatAlsoAny}`);
  console.log(args.apply ? 'APPLIED.' : 'DRY-RUN — pass --apply to commit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
