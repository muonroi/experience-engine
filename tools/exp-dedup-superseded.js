#!/usr/bin/env node
'use strict';
/**
 * exp-dedup-superseded.js
 *
 * Group entries by sha1(normalize(trigger) + "::" + normalize(solution)),
 * keep the highest-effective-confidence as winner, mark the rest with
 * superseded=true and supersededBy=<winnerId>. Does not delete — the
 * evolve loop will eventually demote superseded points naturally, and
 * audit log lets us roll back.
 *
 * Survey of behavioral collection found dupes like #1 ≡ #25 (rule-engine
 * LoggingHook variant-expansion artifacts).
 *
 * Usage:
 *   node tools/exp-dedup-superseded.js
 *   node tools/exp-dedup-superseded.js --apply
 *   node tools/exp-dedup-superseded.js --collection experience-behavioral --apply
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const COLLECTIONS_DEFAULT = ['experience-behavioral', 'experience-selfqa'];
const SCROLL_BATCH = 128;

function parseArgs(argv) {
  const args = { apply: false, collection: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') args.apply = true;
    else if (k === '--collection') args.collection = argv[++i];
    else if (k === '--qdrant-url') args.qdrantUrl = argv[++i];
    else if (k === '--qdrant-key') args.qdrantKey = argv[++i];
    else if (k === '--help' || k === '-h') {
      process.stdout.write(`exp-dedup-superseded — mark duplicates as superseded
  --apply              actually write (default: dry-run)
  --collection <name>  limit to one collection
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

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function dupKey(exp) {
  const t = normalizeText(exp.trigger);
  const s = normalizeText(exp.solution);
  if (!t || !s) return null;
  return crypto.createHash('sha1').update(t + '::' + s).digest('hex');
}

// Mirror src/scoring.js#computeEffectiveConfidence at a basic level: prefer
// higher confidence, then more validations, then more hits.
function rank(exp) {
  const conf = typeof exp.confidence === 'number' ? exp.confidence : 0;
  const validated = typeof exp.validatedCount === 'number' ? exp.validatedCount : 0;
  const hits = typeof exp.hitCount === 'number' ? exp.hitCount : 0;
  return conf * 1000 + validated * 10 + hits;
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
  const auditPath = path.join(os.homedir(), '.experience', `dedup-superseded-${Date.now()}.jsonl`);
  const auditFd = fs.openSync(auditPath, 'a');

  console.log(`mode=${args.apply ? 'APPLY' : 'DRY-RUN'}  qdrant=${qdrantUrl}  audit=${auditPath}`);

  const perColl = {};
  for (const collection of collections) {
    perColl[collection] = { scanned: 0, groups: 0, dupsMarked: 0 };
    const byKey = new Map(); // key -> [{ id, rank, exp }]
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, collection)) {
      perColl[collection].scanned++;
      let exp;
      try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      if (exp.superseded) continue;
      const key = dupKey(exp);
      if (!key) continue;
      const arr = byKey.get(key) || [];
      arr.push({ id: point.id, rank: rank(exp), exp });
      byKey.set(key, arr);
    }

    for (const [key, members] of byKey.entries()) {
      if (members.length < 2) continue;
      perColl[collection].groups++;
      members.sort((a, b) => b.rank - a.rank);
      const winner = members[0];
      const losers = members.slice(1);
      for (const loser of losers) {
        fs.writeSync(auditFd, JSON.stringify({
          ts: new Date().toISOString(), collection, key, winnerId: winner.id, loserId: loser.id, action: 'mark-superseded',
        }) + '\n');
        if (args.apply) {
          loser.exp.superseded = true;
          loser.exp.supersededBy = String(winner.id);
          loser.exp.supersededAt = new Date().toISOString();
          await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/payload`, {
            points: [loser.id],
            payload: { json: JSON.stringify(loser.exp) },
          });
        }
        perColl[collection].dupsMarked++;
      }
    }
  }

  fs.closeSync(auditFd);
  console.log('\n=== summary ===');
  for (const [c, s] of Object.entries(perColl)) {
    console.log(`  ${c}: scanned=${s.scanned} dup-groups=${s.groups} marked=${s.dupsMarked}`);
  }
  console.log(args.apply ? 'APPLIED.' : 'DRY-RUN — pass --apply to commit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
