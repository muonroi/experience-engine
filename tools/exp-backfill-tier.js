#!/usr/bin/env node
'use strict';
/**
 * exp-backfill-tier.js — set the `tier` payload field on legacy entries.
 *
 * Why
 * ---
 * Bulk-seeded entries and pre-modular-refactor stores often lack the `tier`
 * field. Evolution code uses `data.tier === 2` / `data.tier === 0` to decide
 * promote/demote eligibility. Missing tier silently skips some paths.
 *
 * Mapping (matches src/evolution.js and src/format.js):
 *   experience-principles  -> tier: 0
 *   experience-behavioral  -> tier: 1
 *   experience-selfqa      -> tier: 2
 *
 * Safety
 *   - DRY-RUN by default. --apply required.
 *   - Only writes when current tier is missing OR mismatched. Idempotent.
 *   - Audit log at ~/.experience/backfill-tier-<iso>.jsonl
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TIER_MAP = {
  'experience-principles': 0,
  'experience-behavioral': 1,
  'experience-selfqa': 2,
};

const SCROLL_BATCH = 128;

function parseArgs(argv) {
  const args = { apply: false, collection: null, qdrantUrl: null, qdrantKey: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--apply':       args.apply = true; break;
      case '--collection':  args.collection = next(); break;
      case '--qdrant-url':  args.qdrantUrl = next(); break;
      case '--qdrant-key':  args.qdrantKey = next(); break;
      case '--help':
      case '-h':
        process.stdout.write(`exp-backfill-tier.js — DRY-RUN by default.\n\n` +
          `  --apply                actually write\n` +
          `  --collection <name>    limit to one collection\n` +
          `  --qdrant-url <url>     override\n` +
          `  --qdrant-key <key>     override\n`);
        process.exit(0);
    }
  }
  return args;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')) || {};
  } catch { return {}; }
}

async function qdrantPost(qdrantUrl, qdrantKey, urlPath, body) {
  const res = await fetch(`${qdrantUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`qdrant ${res.status} ${res.statusText}`);
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
  const qdrantUrl = (args.qdrantUrl || cfg.qdrantUrl || '').replace(/\/$/, '');
  const qdrantKey = args.qdrantKey || cfg.qdrantKey || '';
  if (!qdrantUrl) { process.stderr.write('Error: qdrant URL not resolvable.\n'); process.exit(1); }

  const collections = args.collection ? [args.collection] : Object.keys(TIER_MAP);
  const auditPath = path.join(os.homedir(), '.experience',
    `backfill-tier-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const audit = fs.createWriteStream(auditPath, { flags: 'a' });

  const summary = { scanned: 0, eligible: 0, written: 0, errors: 0, byTier: {} };
  process.stdout.write(`mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}\n`);
  process.stdout.write(`audit: ${auditPath}\n\n`);

  for (const coll of collections) {
    const expectedTier = TIER_MAP[coll];
    if (expectedTier === undefined) {
      process.stderr.write(`Skipping unknown collection ${coll}\n`);
      continue;
    }
    summary.byTier[expectedTier] = summary.byTier[expectedTier] || 0;
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, coll)) {
      summary.scanned++;
      let data;
      try { data = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const currentTier = data.tier;
      if (currentTier === expectedTier) continue;
      summary.eligible++;
      summary.byTier[expectedTier]++;
      audit.write(JSON.stringify({
        ts: new Date().toISOString(), coll, id: point.id,
        before: currentTier ?? null, after: expectedTier, applied: args.apply,
      }) + '\n');
      if (args.apply) {
        try {
          const nextData = Object.assign({}, data, { tier: expectedTier });
          await qdrantPost(qdrantUrl, qdrantKey, `/collections/${coll}/points/payload`, {
            points: [point.id],
            payload: { json: JSON.stringify(nextData) },
          });
          summary.written++;
        } catch (err) {
          summary.errors++;
          audit.write(JSON.stringify({ ts: new Date().toISOString(), coll, id: point.id, status: 'apply_error', error: err.message }) + '\n');
        }
      }
    }
  }

  audit.end();
  process.stdout.write(`\nsummary: ${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
