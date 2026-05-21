#!/usr/bin/env node
'use strict';

/**
 * doc-to-experience.js — Convert seed-org-doc entries into real experience
 * entries via the brain LLM.
 *
 * Why this exists:
 *   The 2026-05-11 BB seed batch ingested 1360 doc-derived "patterns" into
 *   experience-behavioral. They follow experience SHAPE but carry no real
 *   failure mode — every entry has `failureMode: "misapplied_pattern"`
 *   (placeholder) and `judgment: "follow"` (positive recommendation form),
 *   so they read like docs, not lessons from vapor sessions where someone
 *   actually got bitten.
 *
 *   We HAVE a brain LLM connected. Per the Experience Engine slogan, we
 *   should use it to derive concrete failure modes from these patterns
 *   instead of leaving them as static doc snippets. For each seed entry,
 *   ask the LLM: "What concrete bug/incident does this pattern prevent?
 *   What would actually break if violated?" Output a real experience-form
 *   entry with proper failureMode + alternativesToAvoid.
 *
 * Pipeline:
 *   1. Scroll experience-behavioral for createdFrom == "seed-org-doc"
 *   2. Skip entries already derived (createdFrom == "doc-to-experience"
 *      with derivedFromId pointing back)
 *   3. For each, build prompt with {trigger, guidance, why, alternativesToAvoid}
 *      → call brain LLM → parse JSON output
 *   4. Validate, embed, upsert as NEW entry with createdFrom "doc-to-experience"
 *   5. Batch ID + manifest for rollback
 *
 * Usage:
 *   node doc-to-experience.js --dry-run --limit=5
 *   node doc-to-experience.js --batch-id=2026-05-21-doc-exp --limit=50
 *   node doc-to-experience.js --rollback 2026-05-21-doc-exp
 *
 * Original seed-org-doc entries are NOT deleted by this script. After a
 * derivation pass the engine has BOTH: the doc-form snippet (still useful
 * as static guidance) AND the experience-form derivation (real failure
 * mode for the policing pipeline). A follow-up tool can demote / archive
 * originals once derived coverage proves itself.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { callBrainWithFallback } = require('./src/brain-llm');
const { getEmbedding } = require('./src/embedding');
const { upsertEntry } = require('./src/evolution');
const { deleteEntry } = require('./src/qdrant');

const BEHAVIORAL = 'experience-behavioral';
const BATCH_DIR = path.join(__dirname, 'doc-to-exp-batches');
const SOURCE_FROM = 'seed-org-doc';
const TARGET_FROM = 'doc-to-experience';

// Concurrency 8 is the sweet spot for SiliconFlow Qwen3-14B at ~5s/call —
// stays under typical rate limits while cutting a 1360-entry run from
// ~38 min (concurrency 3) to ~14 min. Bump higher only after watching
// for HTTP 429s in stderr.
const DEFAULT_CONCURRENCY = 8;
const RETRY_PER_ENTRY = 1;
const VALID_LANGS = new Set([
  'C#', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Shell', 'all',
]);
const VALID_EVIDENCE = new Set(['log', 'test', 'runtime', 'review', 'user-correction', 'other']);

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { dryRun: false, batchId: null, limit: null, rollback: null, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rollback') args.rollback = argv[++i];
    else if (a.startsWith('--batch-id=')) args.batchId = a.slice('--batch-id='.length);
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a.startsWith('--concurrency=')) args.concurrency = parseInt(a.slice('--concurrency='.length), 10);
  }
  return args;
}

// ---------- Qdrant scroll ----------

const { getQdrantBase, getQdrantApiKey } = require('./src/config');

async function scrollAllSeedDocs() {
  const out = [];
  let offset = null;
  while (true) {
    const body = {
      limit: 200,
      with_payload: true,
      with_vector: false,
      filter: { must: [{ key: 'evidenceClass', match: { value: 'org-doc' } }] },
    };
    if (offset) body.offset = offset;
    const res = await fetch(`${getQdrantBase()}/collections/${BEHAVIORAL}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`scroll failed: ${res.status}`);
    const j = await res.json();
    const pts = j.result?.points || [];
    for (const p of pts) {
      let inner;
      try { inner = JSON.parse(p.payload?.json || '{}'); } catch { continue; }
      if (inner.createdFrom !== SOURCE_FROM) continue;
      out.push({ id: p.id, payload: p.payload, data: inner });
    }
    offset = j.result?.next_page_offset || null;
    if (!offset) break;
  }
  return out;
}

async function scrollAlreadyDerivedIds() {
  const out = new Set();
  let offset = null;
  while (true) {
    const body = { limit: 500, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const res = await fetch(`${getQdrantBase()}/collections/${BEHAVIORAL}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const j = await res.json();
    const pts = j.result?.points || [];
    for (const p of pts) {
      let inner;
      try { inner = JSON.parse(p.payload?.json || '{}'); } catch { continue; }
      if (inner.createdFrom === TARGET_FROM && inner.derivedFromId) {
        out.add(inner.derivedFromId);
      }
    }
    offset = j.result?.next_page_offset || null;
    if (!offset) break;
  }
  return out;
}

// ---------- LLM prompt ----------

function buildPrompt(doc) {
  const trigger = String(doc.trigger || doc.triggerText || '').slice(0, 500);
  const guidance = String(doc.principle || doc.solution || doc.guidance || '').slice(0, 800);
  const why = String(doc.why || '').slice(0, 600);
  const alts = Array.isArray(doc.alternativesToAvoid) ? doc.alternativesToAvoid.slice(0, 4) : [];
  const lang = doc.scope?.lang || 'all';
  const framework = doc.scope?.framework || 'any';

  return `Convert this doc-pattern into a failure-rooted experience entry (the bug it prevents, not the pattern itself).

Input:
- Context: ${trigger}
- Pattern: ${guidance}
- Rationale: ${why}
- Anti: ${alts.length ? alts.join(' | ') : '(none)'}
- Lang/Framework: ${lang} / ${framework}

Rules:
- failureMode: snake_case, SPECIFIC (e.g. missing_validation, wrong_lifetime_scope, race_condition, silent_swallow, missing_observability, n_plus_one, stale_cache, security_misconfig, blocking_io_in_handler, missing_idempotency). NEVER "misapplied_pattern".
- trigger: session-form ("when X in Y context"), not a copy of input.
- solution: one concrete preventive action.
- judgment: portable rule ("X must Y because Z").
- conditions: 2-4 lowercase keywords.
- evidenceClass: "review".
- category: code | git | deploy | infra | security | review-meta | testing-meta | shell-meta.
- Preserve scope.lang="${lang}" and scope.framework="${framework}".
- If too vague for a concrete failureMode → {"skip":true,"reason":"too_abstract"}.

Output JSON only:
{"trigger":"...","question":"...","solution":"...","why":"...","failureMode":"snake_case_specific","judgment":"...","conditions":["k1","k2"],"evidenceClass":"review","category":"code","scope":{"lang":"${lang}","framework":"${framework}"},"alternativesToAvoid":["concrete antipattern"]}`;
}

// ---------- LLM result parsing ----------

function parseLlmJson(raw) {
  if (!raw || typeof raw !== 'object') {
    // callBrainWithFallback may already parse JSON; if it returns a string,
    // try to extract a JSON object.
    if (typeof raw === 'string') {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
      }
    }
    return null;
  }
  return raw;
}

function validateAndNormalize(out, sourceDoc) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'no_output' };
  if (out.skip === true) return { ok: false, reason: out.reason || 'skipped_by_llm' };

  const required = ['trigger', 'question', 'solution', 'why', 'failureMode', 'judgment'];
  for (const k of required) {
    if (typeof out[k] !== 'string' || out[k].trim().length < 3) return { ok: false, reason: `missing_${k}` };
  }
  if (out.failureMode === 'misapplied_pattern') return { ok: false, reason: 'still_generic_failuremode' };

  const conditions = Array.isArray(out.conditions) ? out.conditions.slice(0, 4).map((c) => String(c).slice(0, 40)) : [];
  if (!VALID_EVIDENCE.has(out.evidenceClass)) out.evidenceClass = 'review';
  const scope = (out.scope && typeof out.scope === 'object') ? out.scope : {};
  if (!VALID_LANGS.has(scope.lang)) scope.lang = sourceDoc.scope?.lang || 'all';
  if (typeof scope.framework !== 'string' || !scope.framework.trim()) scope.framework = sourceDoc.scope?.framework || 'any';
  if (sourceDoc.scope?.org) scope.org = sourceDoc.scope.org;
  if (sourceDoc.scope?.project_slug) scope.project_slug = sourceDoc.scope.project_slug;

  return {
    ok: true,
    entry: {
      trigger: out.trigger.trim(),
      question: out.question.trim(),
      solution: out.solution.trim(),
      why: out.why.trim(),
      failureMode: String(out.failureMode).trim(),
      judgment: out.judgment.trim(),
      conditions,
      evidenceClass: out.evidenceClass,
      category: typeof out.category === 'string' ? out.category : 'code',
      scope,
      alternativesToAvoid: Array.isArray(out.alternativesToAvoid)
        ? out.alternativesToAvoid.slice(0, 4).map((s) => String(s).slice(0, 200))
        : (sourceDoc.alternativesToAvoid || []),
    },
  };
}

// ---------- main pass ----------

async function processOne(doc, batchId, dryRun) {
  const prompt = buildPrompt(doc.data);
  let llmResult = null;
  for (let attempt = 0; attempt <= RETRY_PER_ENTRY; attempt++) {
    try {
      llmResult = await callBrainWithFallback(prompt, { source: 'extract' });
      if (llmResult) break;
    } catch (e) {
      if (attempt === RETRY_PER_ENTRY) throw e;
    }
  }
  const parsed = parseLlmJson(llmResult);
  const validated = validateAndNormalize(parsed, doc.data);
  if (!validated.ok) return { ok: false, reason: validated.reason, sourceId: doc.id };

  if (dryRun) return { ok: true, dryRun: true, sourceId: doc.id, preview: validated.entry };

  const id = crypto.randomUUID();
  const vector = await getEmbedding(validated.entry.trigger);
  if (!vector) return { ok: false, reason: 'embedding_failed', sourceId: doc.id };

  const data = {
    id,
    ...validated.entry,
    tier: 1,
    confidence: 0.7,
    hitCount: 0,
    confirmedAt: [],
    createdAt: new Date().toISOString(),
    createdFrom: TARGET_FROM,
    derivedFromId: doc.id,
    derivedFromBatch: batchId,
    seedSource: doc.data.seedSource || null,
  };
  await upsertEntry(BEHAVIORAL, id, vector, data);
  return { ok: true, sourceId: doc.id, newId: id };
}

async function runBatch(args) {
  const batchId = args.batchId || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

  process.stderr.write(`[doc-to-exp] scrolling seed-org-doc entries…\n`);
  const docs = await scrollAllSeedDocs();
  process.stderr.write(`[doc-to-exp] found ${docs.length} seed-org-doc entries\n`);

  process.stderr.write(`[doc-to-exp] checking already-derived ids…\n`);
  const derived = await scrollAlreadyDerivedIds();
  process.stderr.write(`[doc-to-exp] ${derived.size} already derived\n`);

  const todo = docs.filter((d) => !derived.has(d.id));
  const work = args.limit ? todo.slice(0, args.limit) : todo;
  process.stderr.write(`[doc-to-exp] processing ${work.length} entries (limit=${args.limit ?? 'none'}, concurrency=${args.concurrency})\n`);

  fs.mkdirSync(BATCH_DIR, { recursive: true });
  const manifest = { batchId, startedAt: new Date().toISOString(), entries: [], errors: [] };

  let index = 0;
  const stats = { ok: 0, skipped: 0, errors: 0 };
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= work.length) return;
      const doc = work[i];
      try {
        const result = await processOne(doc, batchId, args.dryRun);
        if (result.ok) {
          stats.ok++;
          if (!args.dryRun && result.newId) {
            manifest.entries.push({ sourceId: doc.id, newId: result.newId });
          }
          process.stderr.write(`[${i + 1}/${work.length}] ok ${doc.id.slice(0, 8)} → ${result.newId?.slice(0, 8) || 'preview'}\n`);
        } else {
          stats.skipped++;
          manifest.errors.push({ sourceId: doc.id, reason: result.reason });
          process.stderr.write(`[${i + 1}/${work.length}] skip ${doc.id.slice(0, 8)} (${result.reason})\n`);
        }
      } catch (e) {
        stats.errors++;
        manifest.errors.push({ sourceId: doc.id, reason: `exception: ${e?.message || e}` });
        process.stderr.write(`[${i + 1}/${work.length}] ERR ${doc.id.slice(0, 8)} ${e?.message || e}\n`);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => worker());
  await Promise.all(workers);

  manifest.finishedAt = new Date().toISOString();
  manifest.stats = stats;
  if (!args.dryRun) {
    const manifestPath = path.join(BATCH_DIR, `${batchId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    process.stderr.write(`[doc-to-exp] manifest written: ${manifestPath}\n`);
  }
  process.stderr.write(`[doc-to-exp] done. ok=${stats.ok} skipped=${stats.skipped} errors=${stats.errors}\n`);
  return stats;
}

async function runRollback(batchId) {
  const manifestPath = path.join(BATCH_DIR, `${batchId}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  process.stderr.write(`[doc-to-exp] rolling back ${manifest.entries.length} entries from ${batchId}\n`);
  let removed = 0;
  for (const e of manifest.entries) {
    try { await deleteEntry(BEHAVIORAL, e.newId); removed++; } catch (err) {
      process.stderr.write(`  failed to delete ${e.newId}: ${err.message}\n`);
    }
  }
  process.stderr.write(`[doc-to-exp] removed ${removed}/${manifest.entries.length}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) return runRollback(args.rollback);
  return runBatch(args);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildPrompt, parseLlmJson, validateAndNormalize, scrollAllSeedDocs, processOne };
