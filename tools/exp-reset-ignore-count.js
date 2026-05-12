#!/usr/bin/env node
'use strict';
/**
 * exp-reset-ignore-count.js — one-off reset of ignoreCount for legacy entries
 * tagged before Phase 1 scope filtering landed.
 *
 * Why this is needed
 * ------------------
 * Before Phase 1 (Qdrant hard-filter on scope_lang) and Phase 3 (scope.framework
 * classifier), hints from one stack would surface in unrelated stacks. Many of
 * those got marked IRRELEVANT by judge-worker, accumulating ignoreCount.
 *
 * Today the scope filter blocks the cross-stack surfaces at index level, so
 * future ignores reflect real quality signal. But the historical counters
 * still demote otherwise-good hints to T2 (one principle got demoted on the
 * first post-fix evolve run because its ignoreCount was pre-fix garbage).
 *
 * This tool resets ignoreCount to 0 on all points in selected collections.
 * Other quality signals (hitCount, validatedCount, confirmedAt) are left
 * intact — only the noise-tainted counter is cleared.
 *
 * Safety
 *   - DRY-RUN by default. --apply required to write.
 *   - Audit log written to ~/.experience/reset-ignore-<iso>.jsonl
 *   - --collection limits scope
 *   - --min-ignore N only resets entries with ignoreCount >= N
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLLECTIONS_DEFAULT = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const SCROLL_BATCH = 128;

function parseArgs(argv) {
  const args = { apply: false, minIgnore: 1, collection: null, qdrantUrl: null, qdrantKey: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--apply':       args.apply = true; break;
      case '--min-ignore':  args.minIgnore = parseInt(next(), 10) || 1; break;
      case '--collection':  args.collection = next(); break;
      case '--qdrant-url':  args.qdrantUrl = next(); break;
      case '--qdrant-key':  args.qdrantKey = next(); break;
      case '--help':
      case '-h':
        process.stdout.write(`exp-reset-ignore-count.js — DRY-RUN by default.\n\n` +
          `  --apply                actually write payload updates\n` +
          `  --min-ignore N         only reset entries with ignoreCount >= N (default 1)\n` +
          `  --collection <name>    limit to one collection (default: all 3)\n` +
          `  --qdrant-url <url>     override (default from config)\n` +
          `  --qdrant-key <key>     override (default from config)\n`);
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

  const collections = args.collection ? [args.collection] : COLLECTIONS_DEFAULT;
  const auditPath = path.join(os.homedir(), '.experience',
    `reset-ignore-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const audit = fs.createWriteStream(auditPath, { flags: 'a' });

  const summary = { scanned: 0, eligible: 0, reset: 0, errors: 0, totalIgnoreCleared: 0 };
  process.stdout.write(`mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}\n`);
  process.stdout.write(`min-ignore: ${args.minIgnore}\n`);
  process.stdout.write(`audit: ${auditPath}\n\n`);

  for (const coll of collections) {
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, coll)) {
      summary.scanned++;
      let data;
      try { data = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const before = Number(data.ignoreCount || 0);
      if (before < args.minIgnore) continue;
      summary.eligible++;
      summary.totalIgnoreCleared += before;
      audit.write(JSON.stringify({
        ts: new Date().toISOString(), coll, id: point.id,
        before, after: 0, applied: args.apply,
      }) + '\n');
      if (args.apply) {
        try {
          const nextData = Object.assign({}, data, { ignoreCount: 0 });
          // Also reset noiseReasonCounts because those drive shouldSuppressForNoise.
          if (nextData.noiseReasonCounts) nextData.noiseReasonCounts = {};
          await qdrantPost(qdrantUrl, qdrantKey, `/collections/${coll}/points/payload`, {
            points: [point.id],
            payload: { json: JSON.stringify(nextData) },
          });
          summary.reset++;
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
