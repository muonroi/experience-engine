#!/usr/bin/env node
'use strict';

/**
 * exp-repair-slugs.js — re-label experiences whose project_slug was invented by
 * a producer bug. DRY-RUN BY DEFAULT; --apply is deliberate.
 *
 * Two producers wrote slugs no caller ever derives:
 *   1. memory-import's tail fallback, which ran extractProjectSlug over a
 *      best-effort path that did not exist and got a canonical-LOOKING answer
 *      (`D--sources-eBerth-planner-new` -> `planner`).
 *   2. the session extractor, which stored extractProjectSlug's path-like
 *      "unresolved" signal verbatim (`c:/users`, `d:/personal`, `e:/tiennv`).
 *
 * Why this matters, and only here: experience-core applyScopeFilter drops a hint
 * "when both sides carry a project_slug AND they differ". No action derives
 * `c:/users`, so those entries are invisible to passive hints for EVERY project,
 * including the one they came from. Active recall (recallMode) skips the project
 * gate entirely, so the same entries still surface there — this repair buys back
 * passive hinting, not recall.
 *
 * NOTHING IS DELETED. The content is good; only the label was wrong. Every point
 * is either re-labelled to a real slug or unscoped (global = recallable
 * everywhere, which for a docker/bash/git lesson is the correct answer and a
 * strict improvement over a slug nobody queries).
 */

const path = require('path');
const RUNTIME = path.join(__dirname, '..', '.experience');
const { isCanonicalProjectSlug } = require(path.join(RUNTIME, 'src', 'utils.js'));

const COLLECTIONS = ['experience-behavioral', 'experience-principles', 'experience-selfqa'];

/**
 * Explicit remaps only. Derived from reading the entries' actual content, not
 * from string munging — `new` holds eberth-planner material (vessel queues,
 * berth-derived terminals), `core` holds Muonroi workspace infrastructure notes.
 * Anything not listed here and not canonical is UNSCOPED rather than guessed:
 * a wrong pin is what got us here.
 */
const REMAP = {
  new: 'eberth-planner',
  planner: 'eberth-planner',
  core: 'muonroi',
};

/** Decide this point's fate from its stored slug. */
function classify(slug) {
  if (!slug) return { action: 'skip', to: null, why: 'already global' };
  const s = String(slug).trim().toLowerCase();
  if (REMAP[s]) return { action: 'remap', to: REMAP[s], why: 'producer bug: bogus slug, content identifies the repo' };
  if (!isCanonicalProjectSlug(s)) return { action: 'unscope', to: null, why: 'path-like: extractProjectSlug "unresolved" signal, stored verbatim' };
  return { action: 'keep', to: s, why: 'canonical' };
}

async function qdrant(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function scrollAll(base, coll) {
  const out = [];
  let offset;
  for (;;) {
    const body = { limit: 500, with_payload: true, with_vector: false };
    if (offset !== undefined && offset !== null) body.offset = offset;
    const r = await qdrant(base, 'POST', `/collections/${coll}/points/scroll`, body);
    out.push(...r.result.points);
    offset = r.result.next_page_offset;
    if (offset === null || offset === undefined) return out;
  }
}

/** Patch BOTH the flat filterable field and the nested copy inside payload.json. */
function patchFor(point, to) {
  const payload = point.payload || {};
  let exp = {};
  try { exp = JSON.parse(payload.json || '{}'); } catch { /* rewritten below from scratch */ }
  const scope = { ...(exp.scope || {}) };
  // Preserve what the label USED to be. Same principle as the importer's
  // project_source: a repair that erases its own input cannot be re-judged.
  if (scope.project_slug && !scope.project_repaired_from) scope.project_repaired_from = scope.project_slug;
  if (to) scope.project_slug = to; else delete scope.project_slug;
  delete scope.projectSlug; // legacy alias — would out-vote project_slug on read
  exp.scope = scope;
  if (exp._projectSlug !== undefined) exp._projectSlug = to;
  return { json: JSON.stringify(exp), scope_project_slug: to };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const base = process.env.QDRANT_URL || 'http://localhost:6333';

  const rows = [];
  for (const coll of COLLECTIONS) {
    for (const p of await scrollAll(base, coll)) {
      const slug = (p.payload || {}).scope_project_slug || null;
      const verdict = classify(slug);
      if (verdict.action === 'skip' || verdict.action === 'keep') continue;
      rows.push({ coll, id: p.id, from: slug, ...verdict, point: p });
    }
  }

  const byFrom = new Map();
  for (const r of rows) {
    const k = `${r.from} -> ${r.to || '(global)'}`;
    if (!byFrom.has(k)) byFrom.set(k, { k, action: r.action, why: r.why, n: 0 });
    byFrom.get(k).n++;
  }

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${rows.length} points to re-label (0 deleted; nothing is ever deleted)\n`);
  const w = Math.max(...[...byFrom.keys()].map((k) => k.length), 10);
  console.log(`  ${'CHANGE'.padEnd(w)}  ${'N'.padStart(4)}  ACTION    WHY`);
  console.log(`  ${'-'.repeat(w)}  ----  --------  ---`);
  for (const v of [...byFrom.values()].sort((a, b) => b.n - a.n)) {
    console.log(`  ${v.k.padEnd(w)}  ${String(v.n).padStart(4)}  ${v.action.padEnd(8)}  ${v.why}`);
  }

  if (!apply) {
    console.log('\nRe-run with --apply to write. Back up Qdrant first.\n');
    return;
  }
  let ok = 0;
  for (const r of rows) {
    await qdrant(base, 'POST', `/collections/${r.coll}/points/payload`, {
      payload: patchFor(r.point, r.to),
      points: [r.id],
    });
    ok++;
  }
  console.log(`\napplied: ${ok}/${rows.length}\n`);
}

if (require.main === module) {
  main().catch((err) => { console.error(`[exp-repair-slugs] ${err?.message}`); process.exit(1); });
}

module.exports = { classify, patchFor, REMAP };
