#!/usr/bin/env node
/**
 * exp-beta-replay.js — offline replay of the Beta confidence model (spec §3 B0).
 *
 * Before `confidenceModel` leaves `legacy`, scroll the corpus and compare, per
 * createdFrom and per tier:
 *   - the legacy gate pass rate (computeEffectiveConfidence >= minConfidence);
 *   - the beta gate pass rate (scoring.betaConfidence with a session-less ctx, i.e.
 *     the posterior mean against betaMinConfidence), and how many entries fall
 *     back to legacy for lack of evidence;
 *   - the mean posterior;
 * plus a threshold sweep, and the expected change in hints per intercept on a
 * sample of recent op:'intercept' rows from activity.jsonl.
 *
 * The intercept estimate is REMOVAL-SIDE only: an intercept row lists what legacy
 * showed; replaying it tells us which of those beta would have dropped, but not
 * which legacy-rejected candidates beta would have added (those never reached the
 * log). The corpus-level pass-rate delta is the proxy for additions. The output of
 * this tool is what the ADR records before betaMinConfidence, priors and weights
 * are chosen.
 *
 * Usage:
 *   node tools/exp-beta-replay.js [--store <dir> | --from-file points.json]
 *        [--collections a,b,c] [--activity <activity.jsonl>] [--sample 500]
 *        [--beta-min-confidence 0.42] [--min-evidence 3] [--json]
 * Without --store/--from-file the corpus is scrolled from Qdrant (config qdrantUrl).
 *
 * Zero dependencies. Read-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../.experience/src/config');
const scoring = require('../.experience/src/scoring');
const betaEvidence = require('../.experience/src/beta-evidence');

const DEFAULT_COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const SWEEP = [0.3, 0.35, 0.4, 0.42, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

// --- corpus loading ----------------------------------------------------------------

function loadFromFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (Array.isArray(raw) ? raw : []).map((p) => ({ id: String(p.id), collection: p.collection || p._collection || 'unknown', payload: p.payload || {} }));
}

function loadFromStore(dir, collections) {
  const out = [];
  for (const collection of collections) {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(path.join(dir, `${collection}.json`), 'utf8')); } catch { continue; }
    for (const e of entries) out.push({ id: String(e.id), collection, payload: e.payload || {} });
  }
  return out;
}

async function loadFromQdrant(collections) {
  const base = String(config.getQdrantBase() || '').replace(/\/$/, '');
  const key = config.getQdrantApiKey();
  const out = [];
  for (const collection of collections) {
    let offset = null;
    for (;;) {
      const body = { limit: 256, with_payload: true, with_vector: false, ...(offset ? { offset } : {}) };
      const res = await fetch(`${base}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'api-key': key } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`qdrant scroll ${collection}: HTTP ${res.status}`);
      const result = (await res.json()).result || {};
      for (const p of result.points || []) out.push({ id: String(p.id), collection, payload: p.payload || {} });
      offset = result.next_page_offset;
      if (!offset || !(result.points || []).length) break;
    }
  }
  return out;
}

// --- replay ------------------------------------------------------------------------

function parseData(point) {
  try { return JSON.parse(point.payload?.json || '{}'); } catch { return null; }
}

function replayPoint(point, ctx) {
  const data = parseData(point);
  if (!data || !data.solution) return null;
  const legacyValue = scoring.computeEffectiveConfidence(data);
  const legacyPass = !(legacyValue < ctx.minConfidence);
  const beta = scoring.betaConfidence(data, ctx, point.id);
  const ev = betaEvidence.readBetaEvidence(data);
  return {
    id: point.id,
    collection: point.collection,
    createdFrom: data.createdFrom || 'unknown',
    tier: data.tier ?? 'unknown',
    legacyValue,
    legacyPass,
    betaPass: beta.pass,
    betaMode: beta.mode,
    posteriorMean: beta.mode === 'beta' ? beta.mean : null,
    evidence: ev.pos + ev.neg,
    stored: betaEvidence.isValidEvidence(data.betaEvidence),
  };
}

function summarise(rows) {
  const n = rows.length;
  const beta = rows.filter((r) => r.betaMode === 'beta');
  return {
    entries: n,
    legacyPassRate: n ? rows.filter((r) => r.legacyPass).length / n : NaN,
    betaPassRate: n ? rows.filter((r) => r.betaPass).length / n : NaN,
    lowEvidenceShare: n ? rows.filter((r) => r.betaMode === 'legacy-low-evidence').length / n : NaN,
    hardGatedShare: n ? rows.filter((r) => r.betaMode === 'hard-gate').length / n : NaN,
    meanPosterior: beta.length ? beta.reduce((a, r) => a + r.posteriorMean, 0) / beta.length : NaN,
    storedEvidenceShare: n ? rows.filter((r) => r.stored).length / n : NaN,
    flippedToFail: rows.filter((r) => r.legacyPass && !r.betaPass).length,
    flippedToPass: rows.filter((r) => !r.legacyPass && r.betaPass).length,
  };
}

function groupBy(rows, key) {
  const groups = {};
  for (const r of rows) (groups[String(r[key])] ||= []).push(r);
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarise(v)]));
}

function sweep(points, baseCtx) {
  return SWEEP.map((t) => {
    const ctx = { ...baseCtx, betaMinConfidence: t };
    let pass = 0; let n = 0;
    for (const p of points) {
      const data = parseData(p);
      if (!data || !data.solution) continue;
      n++;
      if (scoring.betaConfidence(data, ctx, p.id).pass) pass++;
    }
    return { betaMinConfidence: t, betaPassRate: n ? pass / n : NaN };
  });
}

/** Removal-side replay of recent intercept rows (8-char ids → corpus entries). */
function replayIntercepts(interceptRows, rowsById) {
  const byPrefix = new Map();
  for (const r of rowsById.values()) byPrefix.set(r.id.slice(0, 8), r);
  let legacyHints = 0; let betaHints = 0; let legacyWith = 0; let betaWith = 0; let unresolved = 0;
  for (const row of interceptRows) {
    const shown = Array.isArray(row.surfaced) ? row.surfaced : [];
    let kept = 0;
    for (const s of shown) {
      const r = byPrefix.get(String(s.pointId || '').slice(0, 8));
      if (!r) { unresolved++; kept++; continue; } // unknown now → assume unchanged
      if (r.betaPass) kept++;
    }
    legacyHints += shown.length; betaHints += kept;
    if (shown.length > 0) legacyWith++;
    if (kept > 0) betaWith++;
  }
  const n = interceptRows.length;
  return {
    intercepts: n,
    legacyHintsPerIntercept: n ? legacyHints / n : NaN,
    betaHintsPerIntercept: n ? betaHints / n : NaN,
    legacyShareWithHint: n ? legacyWith / n : NaN,
    betaShareWithHint: n ? betaWith / n : NaN,
    unresolvedIds: unresolved,
    note: 'removal-side only: entries beta would ADD never reached the intercept log',
  };
}

function loadInterceptRows(activityPath, sample) {
  const rows = [];
  for (const file of [activityPath + '.1', activityPath]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"op":"intercept"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.op === 'intercept' && e.stage === 'search_done') rows.push(e);
      } catch { /* skip */ }
    }
  }
  return rows.slice(-sample);
}

/**
 * @param {Array<object>} points
 * @param {{interceptRows?: Array<object>, betaMinConfidence?: number, minEvidence?: number}} [opts]
 */
function replay(points, { interceptRows = [], betaMinConfidence, minEvidence } = {}) {
  const ctx = scoring.buildConfidenceCtx({ model: 'beta', sessionId: null });
  if (Number.isFinite(betaMinConfidence)) ctx.betaMinConfidence = betaMinConfidence;
  if (Number.isFinite(minEvidence)) ctx.minEvidence = minEvidence;
  const rows = points.map((p) => replayPoint(p, ctx)).filter(Boolean);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  return {
    settings: { minConfidence: ctx.minConfidence, betaMinConfidence: ctx.betaMinConfidence, minEvidence: ctx.minEvidence, priorMeans: ctx.priorMeans, priorStrength: ctx.priorStrength, weights: config.getBetaEvidenceWeights() },
    overall: summarise(rows),
    byCreatedFrom: groupBy(rows, 'createdFrom'),
    byTier: groupBy(rows, 'tier'),
    sweep: sweep(points, ctx),
    intercepts: replayIntercepts(interceptRows, rowsById),
  };
}

// --- CLI -------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { store: null, fromFile: null, collections: DEFAULT_COLLECTIONS, activity: process.env.EXPERIENCE_ACTIVITY_LOG || path.join(os.homedir(), '.experience', 'activity.jsonl'), sample: 500, betaMinConfidence: undefined, minEvidence: undefined, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--store') args.store = next();
    else if (k === '--from-file') args.fromFile = next();
    else if (k === '--collections') args.collections = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--activity') args.activity = next();
    else if (k === '--sample') args.sample = Number(next()) || 500;
    else if (k === '--beta-min-confidence') args.betaMinConfidence = Number(next());
    else if (k === '--min-evidence') args.minEvidence = Number(next());
    else if (k === '--json') args.json = true;
    else if (k === '--help' || k === '-h') args.help = true;
  }
  return args;
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a');

function renderTable(title, groups) {
  const lines = [title];
  lines.push(`  ${'group'.padEnd(26)} ${'n'.padStart(6)}  legacy  beta    low-ev  hard   mean-post  flips(-/+)`);
  for (const [k, g] of Object.entries(groups)) {
    lines.push(`  ${k.slice(0, 26).padEnd(26)} ${String(g.entries).padStart(6)}  ${pct(g.legacyPassRate).padEnd(7)} ${pct(g.betaPassRate).padEnd(7)} ${pct(g.lowEvidenceShare).padEnd(7)} ${pct(g.hardGatedShare).padEnd(6)} ${Number.isFinite(g.meanPosterior) ? g.meanPosterior.toFixed(3) : 'n/a'}      ${g.flippedToFail}/${g.flippedToPass}`);
  }
  return lines.join('\n');
}

function renderReport(r) {
  const out = [];
  out.push('Experience Engine — Beta confidence replay (B0)');
  out.push(`minConfidence ${r.settings.minConfidence}  betaMinConfidence ${r.settings.betaMinConfidence}  minEvidence ${r.settings.minEvidence}`);
  out.push(renderTable('overall:', { all: r.overall }));
  out.push(renderTable('by createdFrom:', r.byCreatedFrom));
  out.push(renderTable('by tier:', r.byTier));
  out.push('threshold sweep (beta pass rate):');
  out.push('  ' + r.sweep.map((s) => `${s.betaMinConfidence}: ${pct(s.betaPassRate)}`).join('  '));
  const i = r.intercepts;
  out.push(`intercepts (${i.intercepts}): hints/intercept legacy ${Number.isFinite(i.legacyHintsPerIntercept) ? i.legacyHintsPerIntercept.toFixed(2) : 'n/a'} → beta ${Number.isFinite(i.betaHintsPerIntercept) ? i.betaHintsPerIntercept.toFixed(2) : 'n/a'}; with >=1 hint ${pct(i.legacyShareWithHint)} → ${pct(i.betaShareWithHint)} (${i.note})`);
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: exp-beta-replay.js [--store dir | --from-file points.json] [--collections a,b] [--activity path] [--sample N] [--beta-min-confidence X] [--min-evidence N] [--json]\n');
    return;
  }
  const points = args.fromFile ? loadFromFile(args.fromFile)
    : args.store ? loadFromStore(args.store, args.collections)
      : await loadFromQdrant(args.collections);
  const result = replay(points, { interceptRows: loadInterceptRows(args.activity, args.sample), betaMinConfidence: args.betaMinConfidence, minEvidence: args.minEvidence });
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : renderReport(result) + '\n');
}

if (require.main === module) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}

module.exports = {
  loadFromFile, loadFromStore, loadInterceptRows,
  replayPoint, summarise, replayIntercepts, replay, renderReport, parseArgs, SWEEP,
};
