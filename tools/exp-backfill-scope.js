#!/usr/bin/env node
'use strict';
/**
 * exp-backfill-scope.js — LLM-classify scope.framework for existing brain hints.
 *
 * Phase 1+2+3-PartB tag NEW hints correctly at extraction time. This tool
 * walks the existing brain and re-tags hints that were stored before the
 * classifier landed (scope.framework='any' or missing).
 *
 * Safe by default:
 *   - DRY-RUN unless --apply is passed
 *   - Per-collection scroll with --limit cap
 *   - --rate-ms between LLM calls to be gentle on brain LLM provider
 *   - --known-frameworks REQUIRED (no hardcoded labels in this tool —
 *     admins pass their own framework labels at runtime, matching the
 *     same generic-engine principle as ~/.experience/config.json's
 *     org.frameworkPackages)
 *   - Audit log written to ~/.experience/backfill-scope-<ts>.jsonl
 *
 * Usage:
 *   node tools/exp-backfill-scope.js \
 *     --known-frameworks "<labelA>,<labelB>" \
 *     [--collection experience-behavioral] \
 *     [--limit 100] [--rate-ms 250] \
 *     [--brain-url http://localhost:8082/api/brain] \
 *     [--qdrant-url http://localhost:6333] \
 *     [--qdrant-key <key>] \
 *     [--apply]
 *
 * Defaults pull qdrant/brain URLs and tokens from ~/.experience/config.json.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLLECTIONS_DEFAULT = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const SCROLL_BATCH = 64;

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity, rateMs: 250, collection: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--apply':            args.apply = true; break;
      case '--limit':            args.limit = parseInt(next(), 10) || Infinity; break;
      case '--rate-ms':          args.rateMs = parseInt(next(), 10) || 250; break;
      case '--collection':       args.collection = next(); break;
      case '--known-frameworks': args.knownFrameworks = next(); break;
      case '--brain-url':        args.brainUrl = next(); break;
      case '--qdrant-url':       args.qdrantUrl = next(); break;
      case '--qdrant-key':       args.qdrantKey = next(); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`exp-backfill-scope.js — DRY-RUN by default.

Required:
  --known-frameworks "<a>,<b>,..."   comma-separated framework labels the brain may emit

Optional:
  --collection <name>                limit to one collection (default: all 3)
  --limit <N>                        process at most N points overall
  --rate-ms <N>                      delay between brain calls (default 250)
  --brain-url <url>                  brain proxy endpoint (default from config)
  --qdrant-url <url>                 Qdrant base URL (default from config)
  --qdrant-key <key>                 Qdrant API key (default from config)
  --apply                            actually write payload updates (default: dry-run)

Examples:
  # Dry-run on local Qdrant, classify against two framework labels:
  node tools/exp-backfill-scope.js --known-frameworks "framework-a,framework-b"

  # Actual apply, capped at 200 points in one collection:
  node tools/exp-backfill-scope.js --known-frameworks "framework-a" \\
    --collection experience-behavioral --limit 200 --apply
`);
}

function loadConfig() {
  try {
    const p = path.join(os.homedir(), '.experience', 'config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch { return {}; }
}

function resolveEndpoints(cfg, args) {
  const qdrantUrl = (args.qdrantUrl || cfg.qdrantUrl || '').replace(/\/$/, '');
  const qdrantKey = args.qdrantKey || cfg.qdrantKey || '';
  let brainUrl = args.brainUrl || '';
  if (!brainUrl) {
    if (cfg.brainProxyUrl) brainUrl = cfg.brainProxyUrl;
    else if (cfg.serverBaseUrl) brainUrl = cfg.serverBaseUrl.replace(/\/$/, '') + '/api/brain';
    else brainUrl = 'http://localhost:8082/api/brain';
  }
  return { qdrantUrl, qdrantKey, brainUrl };
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

async function callBrainProxy(brainUrl, prompt) {
  const res = await fetch(brainUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, timeoutMs: 8000 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`brain ${res.status} ${res.statusText}`);
  const j = await res.json();
  if (!j.ok) throw new Error(`brain proxy: ${j.error || 'unknown'}`);
  return j.result;
}

function buildClassifierPrompt(point, knownFrameworks) {
  const data = (() => { try { return JSON.parse(point.payload?.json || '{}'); } catch { return {}; } })();
  const trigger = String(data.trigger || '').slice(0, 400);
  const solution = String(data.solution || '').slice(0, 400);
  const why = String(data.why || '').slice(0, 400);
  const lang = (data.scope && data.scope.lang) || data.domain || 'unknown';
  const slug = data._projectSlug || 'unknown';
  const allowed = ['any', ...knownFrameworks].join(' | ');
  return `Classify the framework scope of ONE coding-agent lesson.

Trigger:  ${trigger}
Solution: ${solution}
Why:      ${why}
Language: ${lang}
Project:  ${slug}

Choose ONE label from: ${allowed}

Rules:
- Use "any" when the lesson is a plain language rule (no framework-bound identifier, type, or package).
- Use a specific framework label ONLY if the trigger/solution explicitly references identifiers, types, packages, or conventions tied to that framework.
- If unsure, prefer "any".

Reply with ONLY the label, no quotes, no explanation.`;
}

function normalizeLabel(raw, knownFrameworks) {
  const cleaned = String(raw || '').trim().split(/\s|\n/)[0].toLowerCase();
  if (cleaned === 'any') return 'any';
  for (const fw of knownFrameworks) {
    if (cleaned === fw.toLowerCase()) return fw;
  }
  return 'any';
}

async function updatePayload(qdrantUrl, qdrantKey, collection, point, newData) {
  await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/payload`, {
    points: [point.id],
    payload: { json: JSON.stringify(newData) },
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.knownFrameworks) {
    process.stderr.write('Error: --known-frameworks is required (no hardcoded labels in this tool).\n');
    printHelp();
    process.exit(1);
  }
  const knownFrameworks = args.knownFrameworks
    .split(',').map(s => s.trim()).filter(Boolean);
  if (knownFrameworks.length === 0) {
    process.stderr.write('Error: --known-frameworks parsed to an empty list.\n');
    process.exit(1);
  }

  const cfg = loadConfig();
  const { qdrantUrl, qdrantKey, brainUrl } = resolveEndpoints(cfg, args);
  if (!qdrantUrl) {
    process.stderr.write('Error: qdrant URL not resolvable from config or --qdrant-url.\n');
    process.exit(1);
  }

  const collections = args.collection ? [args.collection] : COLLECTIONS_DEFAULT;
  const auditPath = path.join(os.homedir(), '.experience',
    `backfill-scope-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const audit = fs.createWriteStream(auditPath, { flags: 'a' });

  const summary = { scanned: 0, eligible: 0, changed: 0, kept: 0, errors: 0 };
  process.stdout.write(`mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}\n`);
  process.stdout.write(`brain: ${brainUrl}\n`);
  process.stdout.write(`qdrant: ${qdrantUrl}\n`);
  process.stdout.write(`collections: ${collections.join(', ')}\n`);
  process.stdout.write(`known frameworks: ${knownFrameworks.join(', ')}\n`);
  process.stdout.write(`limit: ${args.limit === Infinity ? 'unbounded' : args.limit}\n`);
  process.stdout.write(`rate-ms: ${args.rateMs}\n`);
  process.stdout.write(`audit log: ${auditPath}\n\n`);

  for (const coll of collections) {
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, coll)) {
      if (summary.scanned >= args.limit) break;
      summary.scanned++;
      let data;
      try { data = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const currentFw = data.scope && typeof data.scope.framework === 'string'
        ? data.scope.framework.toLowerCase().trim() : '';
      const eligible = !currentFw || currentFw === 'any';
      if (!eligible) continue;
      summary.eligible++;

      let proposed = 'any';
      try {
        const prompt = buildClassifierPrompt(point, knownFrameworks);
        const raw = await callBrainProxy(brainUrl, prompt);
        proposed = normalizeLabel(raw, knownFrameworks);
      } catch (err) {
        summary.errors++;
        audit.write(JSON.stringify({ ts: new Date().toISOString(), coll, id: point.id, status: 'brain_error', error: err.message }) + '\n');
        continue;
      }

      const wouldChange = proposed !== 'any';
      audit.write(JSON.stringify({
        ts: new Date().toISOString(), coll, id: point.id,
        slug: data._projectSlug || null,
        trigger: String(data.trigger || '').slice(0, 120),
        before: currentFw || 'any', after: proposed,
        change: wouldChange, applied: args.apply && wouldChange,
      }) + '\n');

      if (wouldChange) {
        summary.changed++;
        if (args.apply) {
          const nextScope = Object.assign({}, data.scope || {}, { framework: proposed });
          const nextData = Object.assign({}, data, { scope: nextScope });
          try { await updatePayload(qdrantUrl, qdrantKey, coll, point, nextData); }
          catch (err) {
            summary.errors++;
            audit.write(JSON.stringify({ ts: new Date().toISOString(), coll, id: point.id, status: 'apply_error', error: err.message }) + '\n');
          }
        }
      } else {
        summary.kept++;
      }
      if (args.rateMs > 0) await new Promise(r => setTimeout(r, args.rateMs));
    }
    if (summary.scanned >= args.limit) break;
  }

  audit.end();
  process.stdout.write(`\nsummary: ${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
