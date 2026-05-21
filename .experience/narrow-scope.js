#!/usr/bin/env node
'use strict';

/**
 * narrow-scope.js — Narrow the scope of session-extracted entries that
 * landed with lang=all + framework=any.
 *
 * Why this exists:
 *   The session extractor errs on the side of "applies to everything" — a
 *   retry-loop incident in one Claude session gets tagged lang=all
 *   framework=any, then fires on every Bash/Edit call in unrelated
 *   contexts. This is the root cause of the recent hint-flood. See
 *   ~14 noise hints reported as wrong_task on 2026-05-21.
 *
 *   For each such entry, we feed the brain LLM the trigger/solution/
 *   failureMode and ask it to classify how broad the lesson actually is.
 *   The model picks one of:
 *     - keep_universal  — genuinely applies to any tool/language
 *     - narrow_lang     — applies to a specific language only
 *     - narrow_framework — applies to a specific framework only
 *     - narrow_tool     — applies to a specific tool family (Bash file
 *                         ops, Edit, etc.) — set scope.appliesToTools
 *     - demote          — too vague / not a real failure mode → drop tier
 *                         to T2 and lower confidence so it stops firing
 *
 * Usage:
 *   node narrow-scope.js --dry-run --limit=5
 *   node narrow-scope.js --batch-id=2026-05-21-narrow --concurrency=8
 *   node narrow-scope.js --rollback 2026-05-21-narrow
 */

const fs = require('fs');
const path = require('path');

const { callBrainWithFallback } = require('./src/brain-llm');
const { getQdrantBase, getQdrantApiKey } = require('./src/config');

const COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const BATCH_DIR = path.join(__dirname, 'narrow-scope-batches');
const DEFAULT_CONCURRENCY = 8;
const RETRY_PER_ENTRY = 1;

const VALID_LANGS = new Set([
  'C#', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Shell', 'all',
]);
const VALID_VERDICTS = new Set(['keep_universal', 'narrow_lang', 'narrow_framework', 'narrow_tool', 'demote']);

function parseArgs(argv) {
  const a = { dryRun: false, batchId: null, limit: null, rollback: null, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--rollback') a.rollback = argv[++i];
    else if (x.startsWith('--batch-id=')) a.batchId = x.slice('--batch-id='.length);
    else if (x.startsWith('--limit=')) a.limit = parseInt(x.slice('--limit='.length), 10);
    else if (x.startsWith('--concurrency=')) a.concurrency = parseInt(x.slice('--concurrency='.length), 10);
  }
  return a;
}

async function scrollBroadScope(collection) {
  const out = [];
  let offset = null;
  while (true) {
    const body = { limit: 500, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const j = await res.json();
    for (const p of j.result?.points || []) {
      let inner;
      try { inner = JSON.parse(p.payload?.json || '{}'); } catch { continue; }
      const cf = inner.createdFrom || '';
      // Only session-derived. Skip seed batches and the doc-to-experience
      // pass we just ran — those already have proper scope.
      if (cf.startsWith('seed-') || cf === 'doc-to-experience') continue;
      const scope = inner.scope || {};
      const lang = String(scope.lang || '').toLowerCase();
      const fw = String(scope.framework || '').toLowerCase();
      const isBroad = (lang === 'all' || lang === '' || lang === 'any') && (fw === 'any' || fw === '');
      if (!isBroad) continue;
      out.push({ id: p.id, collection, payload: p.payload, data: inner });
    }
    offset = j.result?.next_page_offset || null;
    if (!offset) break;
  }
  return out;
}

function buildPrompt(entry) {
  const trigger = String(entry.trigger || '').slice(0, 400);
  const solution = String(entry.solution || '').slice(0, 400);
  const failureMode = String(entry.failureMode || '').slice(0, 100);
  const why = String(entry.why || '').slice(0, 300);

  return `Classify how broad this session-extracted experience really is. It currently has scope lang=all + framework=any, which causes it to fire on every tool call. Pick the tightest accurate verdict.

Entry:
- trigger: ${trigger}
- solution: ${solution}
- failureMode: ${failureMode}
- why: ${why}

Verdicts (pick ONE):
1. keep_universal — truly applies to any agent action in any language. RARE. Reserve for things like "always check exit codes" / "don't ignore stderr".
2. narrow_lang — only meaningful in a specific language. Set scope.lang.
3. narrow_framework — only meaningful within one framework/library. Set scope.framework.
4. narrow_tool — applies to a specific tool family (Bash file ops, Edit/Write, Read, Grep). Set appliesToTools as a short regex matching the tool names (e.g. "^(Bash|Edit)$" or "^Bash$").
5. demote — the lesson is too vague to be actionable (e.g. "implement state tracking", "validate output"). It should stop surfacing.

Output JSON only, no markdown:
{"verdict":"narrow_tool","lang":"all","framework":"any","appliesToTools":"^Bash$","reason":"short justification"}

For demote verdict, just output: {"verdict":"demote","reason":"..."}.
For keep_universal: {"verdict":"keep_universal","reason":"..."}.
Always include "reason".`;
}

function parseLlmJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
  return null;
}

function validateVerdict(out) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'no_output' };
  if (!VALID_VERDICTS.has(out.verdict)) return { ok: false, reason: 'invalid_verdict' };
  if (out.verdict === 'narrow_lang' && !VALID_LANGS.has(out.lang)) return { ok: false, reason: 'invalid_lang' };
  if (out.verdict === 'narrow_framework' && (typeof out.framework !== 'string' || !out.framework.trim() || out.framework === 'any'))
    return { ok: false, reason: 'invalid_framework' };
  if (out.verdict === 'narrow_tool' && (typeof out.appliesToTools !== 'string' || !out.appliesToTools.trim()))
    return { ok: false, reason: 'missing_appliesToTools' };
  return { ok: true };
}

function applyVerdict(entry, verdict) {
  const data = { ...entry.data };
  if (!data.scope || typeof data.scope !== 'object') data.scope = {};

  switch (verdict.verdict) {
    case 'keep_universal':
      data.scope.universalReviewed = true;
      break;
    case 'narrow_lang':
      data.scope.lang = verdict.lang;
      break;
    case 'narrow_framework':
      data.scope.framework = verdict.framework;
      break;
    case 'narrow_tool':
      data.scope.appliesToTools = verdict.appliesToTools;
      break;
    case 'demote':
      // Drop confidence so the surface filter kicks it out, mark for review.
      data.confidence = Math.max(0.10, Number(data.confidence || 0.5) * 0.3);
      data.tier = 2; // probationary
      data.demotedAt = new Date().toISOString();
      data.demoteReason = verdict.reason || 'narrow-scope:too_vague';
      break;
  }
  data.scopeNarrowedAt = new Date().toISOString();
  data.scopeNarrowReason = verdict.reason || verdict.verdict;
  return data;
}

async function updatePayloadOnly(collection, id, newData, originalPayload) {
  const newPayload = { ...originalPayload, json: JSON.stringify(newData) };
  // Refresh flattened scope fields if scope changed.
  if (newData.scope?.lang) newPayload.scope_lang = String(newData.scope.lang).toLowerCase();
  if (newData.scope?.framework) newPayload.scope_framework = String(newData.scope.framework).toLowerCase();
  if (newData.scope?.org) newPayload.scope_org = String(newData.scope.org).toLowerCase();
  const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/payload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
    body: JSON.stringify({ payload: newPayload, points: [id] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`payload update failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function processOne(entry, batchId, dryRun) {
  const prompt = buildPrompt(entry.data);
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
  const valid = validateVerdict(parsed);
  if (!valid.ok) return { ok: false, reason: valid.reason, id: entry.id };

  const oldScope = { ...(entry.data.scope || {}) };
  const newData = applyVerdict(entry, parsed);
  if (dryRun) return { ok: true, dryRun: true, id: entry.id, verdict: parsed.verdict, preview: { from: oldScope, to: newData.scope, demoted: parsed.verdict === 'demote' } };

  await updatePayloadOnly(entry.collection, entry.id, newData, entry.payload);
  return { ok: true, id: entry.id, verdict: parsed.verdict, oldScope, newScope: newData.scope, batchId };
}

async function runBatch(args) {
  const batchId = args.batchId || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  process.stderr.write('[narrow-scope] scrolling broad-scope entries from 3 collections…\n');
  const all = [];
  for (const c of COLLECTIONS) {
    const found = await scrollBroadScope(c);
    process.stderr.write(`  ${c}: ${found.length}\n`);
    all.push(...found);
  }
  const work = args.limit ? all.slice(0, args.limit) : all;
  process.stderr.write(`[narrow-scope] processing ${work.length} entries (concurrency=${args.concurrency})\n`);

  const manifest = { batchId, startedAt: new Date().toISOString(), updates: [], errors: [] };
  const stats = { keep: 0, lang: 0, framework: 0, tool: 0, demote: 0, errors: 0, skipped: 0 };

  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= work.length) return;
      const entry = work[idx];
      try {
        const r = await processOne(entry, batchId, args.dryRun);
        if (!r.ok) { stats.skipped++; manifest.errors.push({ id: entry.id, reason: r.reason }); process.stderr.write(`[${idx + 1}/${work.length}] skip ${entry.id.slice(0, 8)} (${r.reason})\n`); continue; }
        const verdictKey = r.verdict === 'narrow_lang' ? 'lang' : r.verdict === 'narrow_framework' ? 'framework' : r.verdict === 'narrow_tool' ? 'tool' : r.verdict === 'demote' ? 'demote' : 'keep';
        stats[verdictKey]++;
        manifest.updates.push({ id: entry.id, collection: entry.collection, verdict: r.verdict, oldScope: r.oldScope, newScope: r.newScope });
        process.stderr.write(`[${idx + 1}/${work.length}] ${r.verdict.padEnd(16)} ${entry.id.slice(0, 8)}\n`);
      } catch (e) {
        stats.errors++;
        manifest.errors.push({ id: entry.id, reason: e?.message || String(e) });
        process.stderr.write(`[${idx + 1}/${work.length}] ERR ${entry.id.slice(0, 8)} ${e?.message || e}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));
  manifest.finishedAt = new Date().toISOString();
  manifest.stats = stats;
  if (!args.dryRun) {
    const p = path.join(BATCH_DIR, `${batchId}.json`);
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
    process.stderr.write(`[narrow-scope] manifest: ${p}\n`);
  }
  process.stderr.write(`[narrow-scope] done. ${JSON.stringify(stats)}\n`);
  return stats;
}

async function runRollback(batchId) {
  const p = path.join(BATCH_DIR, `${batchId}.json`);
  if (!fs.existsSync(p)) throw new Error(`manifest not found: ${p}`);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  process.stderr.write(`[narrow-scope] rolling back ${m.updates.length} entries\n`);
  for (const u of m.updates) {
    try {
      const restore = { scope: u.oldScope || {} };
      // Best-effort restore — re-read current entry, replace scope.
      const res = await fetch(`${getQdrantBase()}/collections/${u.collection}/points/${u.id}`, {
        headers: { 'api-key': getQdrantApiKey() },
      });
      const j = await res.json();
      const pt = j.result;
      if (!pt) continue;
      const data = JSON.parse(pt.payload?.json || '{}');
      data.scope = restore.scope;
      delete data.scopeNarrowedAt; delete data.scopeNarrowReason; delete data.demotedAt; delete data.demoteReason;
      await updatePayloadOnly(u.collection, u.id, data, pt.payload);
    } catch (e) {
      process.stderr.write(`  rollback err ${u.id}: ${e.message}\n`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) return runRollback(args.rollback);
  return runBatch(args);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildPrompt, parseLlmJson, validateVerdict, applyVerdict };
