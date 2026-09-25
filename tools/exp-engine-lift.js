#!/usr/bin/env node
/**
 * exp-engine-lift.js — does passive engine output make agents fail less?
 *
 * Phase A4 of docs/specs/2026-09-25-hint-lift-and-bayesian-confidence.md. Reads the
 * experiment log (experiment.jsonl + rotated siblings) and compares arms with the
 * SESSION as the unit of analysis:
 *
 *   primary     pooled failure ratio = failed mutating calls / mutating calls, per
 *               arm; difference with a 95% session-cluster bootstrap CI (2,000
 *               resamples, fixed seed, resampling sessions within each arm);
 *   secondary   share of sessions with a retry loop (>= 2 failures with the same
 *               inputHash); failures per 100 calls by runtime;
 *   guardrails  hints per intercept, share of intercepts with >= 1 hint, distinct
 *               entries shown (arms that receive engine output only);
 *   strata      every metric again per runtime.
 *
 * Two comparisons:
 *   --compare holdout (default)  control − treatment. The estimand is the effect of
 *                                PASSIVE engine output (active recall is not held out).
 *   --compare model              beta − legacy among non-control sessions (Phase B
 *                                `confidenceModel: ab`). Pre-registered rule: keep beta
 *                                iff the upper bound of the 95% CI of the RELATIVE
 *                                difference is < +10% AND hints per intercept and the
 *                                share of intercepts with a hint each drop <= 20%.
 *
 * Sessions with fewer than --min-calls (default 5) classified mutating calls are
 * excluded and counted. Calls whose strict `failure` is 'unknown' are excluded and
 * counted. The analysis is a decision only on/after the pre-registered --end-date;
 * any earlier run is labelled "monitoring, not a decision". No per-point lift in v1.
 *
 * Usage:
 *   node tools/exp-engine-lift.js [--log <experiment.jsonl>] [--compare holdout|model]
 *        [--end-date YYYY-MM-DD] [--salt v1] [--min-calls 5] [--resamples 2000]
 *        [--seed 20260925] [--json]
 *
 * Zero dependencies.
 */
'use strict';

const path = require('path');
const os = require('os');

const { isMutatingTool } = require('../.experience/src/tool-outcome');
const { readExperimentLog } = require('../.experience/src/experiment');

const COMPARISONS = {
  holdout: { experiment: 'holdout', a: 'control', b: 'treatment', label: 'control − treatment' },
  model: { experiment: 'confidence-model', a: 'beta', b: 'legacy', label: 'beta − legacy' },
};
const NON_INFERIORITY_MARGIN = 0.10;
const GUARDRAIL_MAX_DROP = 0.20;

// --- deterministic PRNG ------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- session assembly --------------------------------------------------------------

/**
 * Build per-session records for one comparison.
 * @returns {{sessions: Map<string, object>, salt: string|null, ignoredOtherSalt: number}}
 */
function assembleSessions(events, opts = {}) {
  const cmp = COMPARISONS[opts.compare || 'holdout'];
  const armEvents = events.filter((e) => e.event === 'session-arm');
  const saltOf = (exp) => {
    const own = armEvents.filter((e) => e.experiment === exp);
    return own.length ? own[own.length - 1].salt ?? null : null;
  };
  const salt = opts.salt !== undefined && opts.salt !== null ? opts.salt : saltOf(cmp.experiment);

  const armBySession = new Map();
  const holdoutArmBySession = new Map();
  const runtimeBySession = new Map();
  const otherSalt = new Set();
  for (const e of armEvents) {
    if (!e.sourceSession) continue;
    if (e.runtime && !runtimeBySession.has(e.sourceSession)) runtimeBySession.set(e.sourceSession, e.runtime);
    if (e.experiment === 'holdout') holdoutArmBySession.set(e.sourceSession, e.arm);
    if (e.experiment !== cmp.experiment) continue;
    if ((e.salt ?? null) !== salt) { otherSalt.add(e.sourceSession); continue; }
    if (!armBySession.has(e.sourceSession)) armBySession.set(e.sourceSession, e.arm);
  }

  const sessions = new Map();
  for (const [sid, arm] of armBySession) {
    // The model comparison is among sessions that receive engine output at all.
    if (opts.compare === 'model' && holdoutArmBySession.get(sid) === 'control') continue;
    if (arm !== cmp.a && arm !== cmp.b) continue;
    sessions.set(sid, {
      id: sid, arm, runtime: runtimeBySession.get(sid) || 'unknown',
      calls: 0, failed: 0, unknown: 0, failuresByInput: new Map(), seenToolUse: new Set(),
      intercepts: 0, hintsShown: 0, interceptsWithHint: 0, entriesShown: new Set(),
    });
  }

  for (const e of events) {
    const s = e.sourceSession ? sessions.get(e.sourceSession) : null;
    if (!s) continue;
    if (e.event === 'outcome') {
      if (!isMutatingTool(e.tool)) continue;
      if (e.toolUseId) {
        if (s.seenToolUse.has(e.toolUseId)) continue; // replayed / duplicated delivery
        s.seenToolUse.add(e.toolUseId);
      }
      if (e.runtime && s.runtime === 'unknown') s.runtime = e.runtime;
      if (e.failure === 'fail') {
        s.calls++; s.failed++;
        const key = e.inputHash || `nohash:${s.calls}`;
        s.failuresByInput.set(key, (s.failuresByInput.get(key) || 0) + 1);
      } else if (e.failure === 'ok') {
        s.calls++;
      } else {
        s.unknown++;
      }
    } else if (e.event === 'exposure') {
      const shown = (Array.isArray(e.shown) ? e.shown.length : 0) + (Array.isArray(e.graphShown) ? e.graphShown.length : 0);
      s.intercepts++;
      s.hintsShown += shown;
      if (shown > 0) s.interceptsWithHint++;
      for (const id of [...(e.shown || []), ...(e.graphShown || [])]) s.entriesShown.add(String(id));
    }
  }
  return { sessions, salt, ignoredOtherSalt: otherSalt.size };
}

// --- metrics -------------------------------------------------------------------------

function pooledRatio(sessions) {
  let calls = 0; let failed = 0;
  for (const s of sessions) { calls += s.calls; failed += s.failed; }
  return calls ? failed / calls : NaN;
}

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Session-cluster bootstrap of the pooled-ratio difference (a − b) and of the
 * relative difference (a − b) / b. Resamples sessions with replacement within
 * each arm, so arm sizes stay fixed.
 */
function bootstrapDifference(armA, armB, { resamples = 2000, seed = 20260925 } = {}) {
  const rand = mulberry32(seed);
  const diffs = [];
  const rels = [];
  if (armA.length === 0 || armB.length === 0) return { diff: [NaN, NaN], relative: [NaN, NaN], resamples: 0 };
  const draw = (arm) => {
    let calls = 0; let failed = 0;
    for (let i = 0; i < arm.length; i++) {
      const s = arm[Math.floor(rand() * arm.length)];
      calls += s.calls; failed += s.failed;
    }
    return calls ? failed / calls : NaN;
  };
  for (let r = 0; r < resamples; r++) {
    const a = draw(armA);
    const b = draw(armB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    diffs.push(a - b);
    if (b > 0) rels.push((a - b) / b);
  }
  diffs.sort((x, y) => x - y);
  rels.sort((x, y) => x - y);
  return {
    diff: [percentile(diffs, 0.025), percentile(diffs, 0.975)],
    relative: [percentile(rels, 0.025), percentile(rels, 0.975)],
    resamples: diffs.length,
  };
}

function hasRetryLoop(s) {
  for (const n of s.failuresByInput.values()) if (n >= 2) return true;
  return false;
}

function guardrails(sessions) {
  let intercepts = 0; let hints = 0; let withHint = 0;
  const entries = new Set();
  for (const s of sessions) {
    intercepts += s.intercepts; hints += s.hintsShown; withHint += s.interceptsWithHint;
    for (const id of s.entriesShown) entries.add(id);
  }
  return {
    intercepts,
    hintsPerIntercept: intercepts ? hints / intercepts : NaN,
    shareInterceptsWithHint: intercepts ? withHint / intercepts : NaN,
    distinctEntriesShown: entries.size,
  };
}

function armSummary(sessions) {
  const calls = sessions.reduce((a, s) => a + s.calls, 0);
  const failed = sessions.reduce((a, s) => a + s.failed, 0);
  const byRuntime = {};
  for (const s of sessions) {
    const r = byRuntime[s.runtime] || (byRuntime[s.runtime] = { sessions: 0, calls: 0, failed: 0 });
    r.sessions++; r.calls += s.calls; r.failed += s.failed;
  }
  for (const r of Object.values(byRuntime)) r.failuresPer100Calls = r.calls ? (100 * r.failed) / r.calls : NaN;
  return {
    sessions: sessions.length,
    calls,
    failed,
    failureRatio: calls ? failed / calls : NaN,
    retryLoopSessionShare: sessions.length ? sessions.filter(hasRetryLoop).length / sessions.length : NaN,
    byRuntime,
  };
}

function compareArms(armA, armB, opts) {
  const a = armSummary(armA);
  const b = armSummary(armB);
  return {
    a, b,
    difference: a.failureRatio - b.failureRatio,
    relativeDifference: b.failureRatio > 0 ? (a.failureRatio - b.failureRatio) / b.failureRatio : NaN,
    ci95: bootstrapDifference(armA, armB, opts),
  };
}

/**
 * Full analysis of an event list. Pure: no I/O, `now` injectable.
 */
function analyze(events, opts = {}) {
  const compare = opts.compare || 'holdout';
  const cmp = COMPARISONS[compare];
  if (!cmp) throw new Error(`unknown --compare ${compare}`);
  const minCalls = Number.isFinite(opts.minCalls) ? opts.minCalls : 5;
  const bootOpts = { resamples: Number.isFinite(opts.resamples) ? opts.resamples : 2000, seed: Number.isFinite(opts.seed) ? opts.seed : 20260925 };
  const { sessions, salt, ignoredOtherSalt } = assembleSessions(events, { compare, salt: opts.salt });

  const all = [...sessions.values()];
  const eligible = all.filter((s) => s.calls >= minCalls);
  const excluded = all.length - eligible.length;
  const armA = eligible.filter((s) => s.arm === cmp.a);
  const armB = eligible.filter((s) => s.arm === cmp.b);

  const primary = compareArms(armA, armB, bootOpts);
  const strata = {};
  for (const runtime of [...new Set(eligible.map((s) => s.runtime))].sort()) {
    strata[runtime] = compareArms(armA.filter((s) => s.runtime === runtime), armB.filter((s) => s.runtime === runtime), bootOpts);
  }

  // Guardrails only where engine output is shown: treatment for the holdout,
  // both arms for the model comparison.
  const guard = compare === 'holdout'
    ? { [cmp.b]: guardrails(armB) }
    : { [cmp.a]: guardrails(armA), [cmp.b]: guardrails(armB) };

  const now = opts.now instanceof Date ? opts.now : new Date();
  const endDate = opts.endDate ? new Date(`${opts.endDate}T00:00:00.000Z`) : null;
  const isDecision = !!(endDate && Number.isFinite(endDate.getTime()) && now >= endDate);

  let rule = null;
  if (compare === 'model') {
    const ga = guard[cmp.a]; const gb = guard[cmp.b];
    const drop = (x, y) => (Number.isFinite(x) && Number.isFinite(y) && y > 0 ? (y - x) / y : NaN);
    const hintsDrop = drop(ga.hintsPerIntercept, gb.hintsPerIntercept);
    const shareDrop = drop(ga.shareInterceptsWithHint, gb.shareInterceptsWithHint);
    const upper = primary.ci95.relative[1];
    const nonInferior = Number.isFinite(upper) && upper < NON_INFERIORITY_MARGIN;
    const guardOk = !(hintsDrop > GUARDRAIL_MAX_DROP) && !(shareDrop > GUARDRAIL_MAX_DROP) && Number.isFinite(hintsDrop) && Number.isFinite(shareDrop);
    rule = {
      margin: NON_INFERIORITY_MARGIN, guardrailMaxDrop: GUARDRAIL_MAX_DROP,
      relativeCiUpper: upper, hintsPerInterceptDrop: hintsDrop, shareWithHintDrop: shareDrop,
      nonInferior, guardrailsOk: guardOk, keepBeta: nonInferior && guardOk,
    };
  }

  return {
    compare, label: cmp.label, arms: { a: cmp.a, b: cmp.b }, salt,
    status: isDecision ? 'decision' : 'monitoring, not a decision',
    endDate: opts.endDate || null,
    sessions: { assigned: all.length, eligible: eligible.length, excludedBelowMinCalls: excluded, minCalls, ignoredOtherSalt },
    unknownCalls: eligible.reduce((a, s) => a + s.unknown, 0),
    primary,
    strata,
    guardrails: guard,
    rule,
  };
}

// --- CLI -------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { log: null, compare: 'holdout', endDate: null, salt: undefined, minCalls: 5, resamples: 2000, seed: 20260925, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--log') args.log = next();
    else if (k === '--compare') args.compare = next();
    else if (k === '--end-date') args.endDate = next();
    else if (k === '--salt') args.salt = next();
    else if (k === '--min-calls') args.minCalls = Number(next());
    else if (k === '--resamples') args.resamples = Number(next());
    else if (k === '--seed') args.seed = Number(next());
    else if (k === '--json') args.json = true;
    else if (k === '--help' || k === '-h') args.help = true;
  }
  if (!args.log) args.log = process.env.EXPERIENCE_EXPERIMENT_LOG || path.join(os.homedir(), '.experience', 'experiment.jsonl');
  return args;
}

const pct = (v, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : 'n/a');

function renderArmLine(name, s) {
  return `  ${name.padEnd(10)} sessions ${String(s.sessions).padStart(5)}  calls ${String(s.calls).padStart(7)}  failed ${String(s.failed).padStart(6)}  ratio ${pct(s.failureRatio)}  retry-loop sessions ${pct(s.retryLoopSessionShare, 1)}`;
}

function renderReport(r) {
  const lines = [];
  lines.push(`Experience Engine — engine lift (${r.compare}: ${r.label})`);
  lines.push(`STATUS: ${r.status.toUpperCase()}${r.endDate ? ` (pre-registered end date ${r.endDate})` : ''}`);
  lines.push(`salt: ${r.salt ?? 'n/a'}  sessions assigned ${r.sessions.assigned}, eligible ${r.sessions.eligible}, excluded (< ${r.sessions.minCalls} calls) ${r.sessions.excludedBelowMinCalls}, other salt ${r.sessions.ignoredOtherSalt}  unclassified calls ${r.unknownCalls}`);
  if (r.compare === 'holdout') lines.push('estimand: effect of PASSIVE engine output (hints, nudges, auto-recall, brief); active recall is not held out');
  lines.push('');
  lines.push('primary — pooled failure ratio:');
  lines.push(renderArmLine(r.arms.a, r.primary.a));
  lines.push(renderArmLine(r.arms.b, r.primary.b));
  lines.push(`  difference ${r.label}: ${pct(r.primary.difference, 3)}  95% CI [${pct(r.primary.ci95.diff[0], 3)}, ${pct(r.primary.ci95.diff[1], 3)}]  relative ${pct(r.primary.relativeDifference, 1)} [${pct(r.primary.ci95.relative[0], 1)}, ${pct(r.primary.ci95.relative[1], 1)}]`);
  lines.push('');
  lines.push('by runtime:');
  for (const [rt, c] of Object.entries(r.strata)) {
    lines.push(`  ${rt}: ${r.arms.a} ${pct(c.a.failureRatio)} (n=${c.a.sessions}) vs ${r.arms.b} ${pct(c.b.failureRatio)} (n=${c.b.sessions}); diff ${pct(c.difference, 3)} [${pct(c.ci95.diff[0], 3)}, ${pct(c.ci95.diff[1], 3)}]`);
  }
  lines.push('');
  lines.push('guardrails:');
  for (const [arm, g] of Object.entries(r.guardrails)) {
    lines.push(`  ${arm.padEnd(10)} intercepts ${g.intercepts}  hints/intercept ${Number.isFinite(g.hintsPerIntercept) ? g.hintsPerIntercept.toFixed(2) : 'n/a'}  with >=1 hint ${pct(g.shareInterceptsWithHint, 1)}  distinct entries ${g.distinctEntriesShown}`);
  }
  if (r.rule) {
    lines.push('');
    lines.push(`rule: relative CI upper ${pct(r.rule.relativeCiUpper, 1)} < +${r.rule.margin * 100}% → ${r.rule.nonInferior ? 'non-inferior' : 'NOT shown non-inferior'}; guardrail drops hints/intercept ${pct(r.rule.hintsPerInterceptDrop, 1)}, share-with-hint ${pct(r.rule.shareWithHintDrop, 1)} (max ${r.rule.guardrailMaxDrop * 100}%) → ${r.rule.guardrailsOk ? 'ok' : 'FAILED'}`);
    lines.push(`  → ${r.rule.keepBeta ? 'keep beta' : 'keep legacy'}${r.status === 'decision' ? '' : ' (monitoring only)'}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: exp-engine-lift.js [--log path] [--compare holdout|model] [--end-date YYYY-MM-DD] [--salt v1] [--min-calls 5] [--resamples 2000] [--seed N] [--json]\n');
    return;
  }
  const result = analyze(readExperimentLog(args.log), args);
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : renderReport(result) + '\n');
}

if (require.main === module) main();

module.exports = {
  COMPARISONS, NON_INFERIORITY_MARGIN, GUARDRAIL_MAX_DROP,
  mulberry32, assembleSessions, pooledRatio, bootstrapDifference, hasRetryLoop,
  guardrails, armSummary, analyze, renderReport, parseArgs,
};
