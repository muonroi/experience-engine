#!/usr/bin/env node
/**
 * exp-outcome-baseline.js — can the session-holdout experiment detect anything?
 *
 * Phase A0.3 of docs/specs/2026-09-25-hint-lift-and-bayesian-confidence.md. Before
 * any session is held out, measure from the logs we already have:
 *   - mutating tool calls and their failure rate by runtime × tool;
 *   - sessions per week and calls per session;
 *   - the between-session variance of the per-session failure ratio;
 * and print the minimum detectable effect (two arms, α=0.05, power 0.8) for a
 * holdout share and duration. Go/no-go (pre-registered in the spec): Phase A only
 * starts if the baseline failure rate is >= 2% of mutating calls AND the MDE for
 * the planned duration is <= 25% relative. Otherwise the report says so.
 *
 * Inputs (both posttool shapes, plus the experiment log once it exists):
 *   activity.jsonl(.1)  {op:'hook', hook:'interceptor-post', stage:'parsed', ...}  local mode
 *                       {op:'posttool', ...}                                        server
 *   experiment.jsonl*   {event:'outcome', ...}                                     A0.1+ / Phase A
 *
 * Basis: the strict `failure` field (src/tool-outcome.js) when enough records carry
 * it; otherwise the legacy keyword `toolOutcome`, labelled as an UPPER BOUND — the
 * keyword classifier calls any output mentioning "error" a failure.
 *
 * Usage:
 *   node tools/exp-outcome-baseline.js [--since 30d] [--holdout-share 0.15]
 *        [--weeks 3] [--min-calls 5] [--log-dir ~/.experience]
 *        [--experiment-log <path>] [--json]
 *
 * Zero dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { isMutatingTool } = require('../.experience/src/tool-outcome');

const DAY_MS = 86400000;
const GO_MIN_BASELINE_RATE = 0.02;
const GO_MAX_RELATIVE_MDE = 0.25;
// Below this many strictly-classified mutating calls the strict rate is noise;
// fall back to the (labelled) legacy classifier instead of reporting 0/12.
const MIN_STRICT_CALLS = 200;

// --- log reading -----------------------------------------------------------------

function readJsonl(filePath) {
  const out = [];
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * The live experiment log plus every rotated, date-stamped sibling
 * (`experiment.jsonl.<stamp>`), oldest first. Rotation never overwrites.
 */
function listLogFiles(basePath) {
  const dir = path.dirname(basePath);
  const base = path.basename(basePath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rotated = names.filter((n) => n.startsWith(base + '.')).sort();
  const files = rotated.map((n) => path.join(dir, n));
  if (names.includes(base)) files.push(basePath);
  return files;
}

function normalizeActivityRecord(rec) {
  const isHookShape = rec.op === 'hook' && rec.hook === 'interceptor-post' && rec.stage === 'parsed';
  const isServerShape = rec.op === 'posttool';
  if (!isHookShape && !isServerShape) return null;
  return {
    ts: rec.ts || null,
    session: rec.sourceSession || null,
    runtime: rec.runtime || rec.sourceRuntime || 'unknown',
    tool: rec.tool || '',
    failure: rec.failure || null,
    toolOutcome: rec.toolOutcome || null,
    toolUseId: rec.toolUseId || null,
    inputHash: rec.inputHash || null,
    source: 'activity',
  };
}

function normalizeExperimentOutcome(rec) {
  if (rec.event !== 'outcome') return null;
  return {
    ts: rec.ts || null,
    session: rec.sourceSession || null,
    runtime: rec.runtime || 'unknown',
    tool: rec.tool || '',
    failure: rec.failure || null,
    toolOutcome: rec.toolOutcome || null,
    toolUseId: rec.toolUseId || null,
    inputHash: rec.inputHash || null,
    source: 'experiment',
  };
}

function loadActivityRecords(logDir) {
  const out = [];
  for (const file of ['activity.jsonl.1', 'activity.jsonl']) {
    for (const rec of readJsonl(path.join(logDir, file))) {
      const n = normalizeActivityRecord(rec);
      if (n) out.push(n);
    }
  }
  return out;
}

function loadExperimentOutcomes(experimentLogPath) {
  const out = [];
  for (const file of listLogFiles(experimentLogPath)) {
    for (const rec of readJsonl(file)) {
      const n = normalizeExperimentOutcome(rec);
      if (n) out.push(n);
    }
  }
  return out;
}

/**
 * One record per tool call. The experiment log wins where both logs saw a call:
 * an activity record is dropped when its (session, toolUseId) is in the
 * experiment log, or — lacking a toolUseId — when its session has any
 * experiment-log outcome (the two logs cover the same calls for that session).
 */
function mergeRecords(activity, experiment) {
  const expKeys = new Set();
  const expSessions = new Set();
  for (const r of experiment) {
    if (r.session) expSessions.add(r.session);
    if (r.session && r.toolUseId) expKeys.add(`${r.session}|${r.toolUseId}`);
  }
  const kept = activity.filter((r) => {
    if (r.session && r.toolUseId && expKeys.has(`${r.session}|${r.toolUseId}`)) return false;
    if (r.session && expSessions.has(r.session) && !r.toolUseId) return false;
    return true;
  });
  return [...kept, ...experiment];
}

// --- statistics ------------------------------------------------------------------

// Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9).
function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  let q; let r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - plow) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function sampleVariance(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Minimum detectable absolute difference in the per-session failure ratio between
 * two arms of nControl and nTreatment sessions, each with between-session variance
 * `variance` (two-sided α, given power). Unit of analysis = session, as in A4.
 */
function minimumDetectableEffect({ variance, nControl, nTreatment, alpha = 0.05, power = 0.8 }) {
  if (!(nControl > 0 && nTreatment > 0) || !(variance >= 0)) return Infinity;
  const z = normInv(1 - alpha / 2) + normInv(power);
  return z * Math.sqrt(variance * (1 / nControl + 1 / nTreatment));
}

function computeBaseline(records, opts = {}) {
  const minCalls = Number.isFinite(opts.minCalls) ? opts.minCalls : 5;
  const holdoutShare = Number.isFinite(opts.holdoutShare) ? opts.holdoutShare : 0.15;
  const weeks = Number.isFinite(opts.weeks) ? opts.weeks : 3;
  const minStrict = Number.isFinite(opts.minStrictCalls) ? opts.minStrictCalls : MIN_STRICT_CALLS;
  const cutoff = opts.since instanceof Date ? opts.since.getTime() : null;

  const inWindow = records.filter((r) => cutoff === null || (r.ts && Date.parse(r.ts) >= cutoff));
  const mutating = inWindow.filter((r) => isMutatingTool(r.tool));
  const strictCount = mutating.filter((r) => r.failure === 'fail' || r.failure === 'ok').length;
  const basis = strictCount >= minStrict ? 'strict' : 'legacy-toolOutcome';
  const counted = basis === 'strict'
    ? (r) => r.failure === 'fail' || r.failure === 'ok'
    : (r) => r.toolOutcome === 'error' || r.toolOutcome === 'success';
  const failed = basis === 'strict' ? (r) => r.failure === 'fail' : (r) => r.toolOutcome === 'error';
  const calls = mutating.filter(counted);

  const byRuntimeTool = {};
  for (const r of calls) {
    const rt = byRuntimeTool[r.runtime] || (byRuntimeTool[r.runtime] = {});
    const t = rt[r.tool] || (rt[r.tool] = { calls: 0, failed: 0, rate: 0 });
    t.calls++;
    if (failed(r)) t.failed++;
  }
  for (const rt of Object.values(byRuntimeTool)) for (const t of Object.values(rt)) t.rate = t.calls ? t.failed / t.calls : 0;

  const sessions = new Map();
  for (const r of calls) {
    if (!r.session) continue;
    const s = sessions.get(r.session) || { calls: 0, failed: 0 };
    s.calls++;
    if (failed(r)) s.failed++;
    sessions.set(r.session, s);
  }
  const eligible = [...sessions.values()].filter((s) => s.calls >= minCalls);
  const excludedSessions = sessions.size - eligible.length;
  const eligibleCalls = eligible.reduce((a, s) => a + s.calls, 0);
  const eligibleFailed = eligible.reduce((a, s) => a + s.failed, 0);
  const baselineRate = eligibleCalls ? eligibleFailed / eligibleCalls : 0;
  const ratios = eligible.map((s) => s.failed / s.calls);
  const betweenSessionVariance = sampleVariance(ratios);

  const times = calls.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  // reduce, not Math.max(...times): a spread of a months-long log overflows the stack.
  const tMin = times.reduce((a, t) => Math.min(a, t), Infinity);
  const tMax = times.reduce((a, t) => Math.max(a, t), -Infinity);
  const spanDays = times.length ? Math.max(1, (tMax - tMin) / DAY_MS) : 0;
  const sessionsPerWeek = spanDays ? eligible.length / (spanDays / 7) : 0;
  const plannedSessions = sessionsPerWeek * weeks;
  const nControl = plannedSessions * holdoutShare;
  const nTreatment = plannedSessions * (1 - holdoutShare);
  const mdeAbsolute = minimumDetectableEffect({ variance: betweenSessionVariance, nControl, nTreatment });
  const mdeRelative = baselineRate > 0 ? mdeAbsolute / baselineRate : Infinity;

  const reasons = [];
  if (!(baselineRate >= GO_MIN_BASELINE_RATE)) reasons.push(`baseline failure rate ${(baselineRate * 100).toFixed(2)}% < ${GO_MIN_BASELINE_RATE * 100}%`);
  if (!(mdeRelative <= GO_MAX_RELATIVE_MDE)) reasons.push(`relative MDE ${Number.isFinite(mdeRelative) ? (mdeRelative * 100).toFixed(1) + '%' : 'undefined'} > ${GO_MAX_RELATIVE_MDE * 100}%`);
  if (basis !== 'strict') reasons.push(`only ${strictCount} strictly classified mutating calls (< ${minStrict}); rate is the legacy keyword classifier, an upper bound`);

  return {
    basis,
    strictCalls: strictCount,
    mutatingCalls: mutating.length,
    countedCalls: calls.length,
    unknownCalls: mutating.length - calls.length,
    byRuntimeTool,
    sessions: { total: sessions.size, eligible: eligible.length, excludedBelowMinCalls: excludedSessions, minCalls },
    callsPerSession: { mean: eligible.length ? eligibleCalls / eligible.length : 0, median: median(eligible.map((s) => s.calls)) },
    spanDays,
    sessionsPerWeek,
    baselineRate,
    betweenSessionVariance,
    plan: { holdoutShare, weeks, plannedSessions, nControl, nTreatment, alpha: 0.05, power: 0.8 },
    mdeAbsolute,
    mdeRelative,
    decision: reasons.length === 0 ? 'go' : 'no-go',
    reasons,
  };
}

// --- CLI -------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { since: null, holdoutShare: 0.15, weeks: 3, minCalls: 5, logDir: path.join(os.homedir(), '.experience'), experimentLog: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--since') { const m = String(next() || '').match(/^(\d+)d$/); args.since = m ? new Date(Date.now() - Number(m[1]) * DAY_MS) : null; }
    else if (k === '--holdout-share') args.holdoutShare = Number(next());
    else if (k === '--weeks') args.weeks = Number(next());
    else if (k === '--min-calls') args.minCalls = Number(next());
    else if (k === '--log-dir') args.logDir = next();
    else if (k === '--experiment-log') args.experimentLog = next();
    else if (k === '--json') args.json = true;
    else if (k === '--help' || k === '-h') args.help = true;
  }
  if (!args.experimentLog) args.experimentLog = process.env.EXPERIENCE_EXPERIMENT_LOG || path.join(args.logDir, 'experiment.jsonl');
  return args;
}

function pct(v) { return Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a'; }

function renderReport(r) {
  const lines = [];
  lines.push('Experience Engine — outcome baseline (Phase A0.3)');
  lines.push(`basis: ${r.basis}${r.basis === 'strict' ? '' : '  (legacy keyword classifier — UPPER BOUND)'}`);
  lines.push(`mutating calls: ${r.mutatingCalls}  counted: ${r.countedCalls}  unclassified: ${r.unknownCalls}  strict: ${r.strictCalls}`);
  lines.push('');
  lines.push('failure rate by runtime × tool:');
  for (const [rt, tools] of Object.entries(r.byRuntimeTool)) {
    for (const [tool, t] of Object.entries(tools)) lines.push(`  ${rt.padEnd(16)} ${tool.padEnd(14)} ${String(t.failed).padStart(6)}/${String(t.calls).padEnd(6)} ${pct(t.rate)}`);
  }
  lines.push('');
  lines.push(`sessions: ${r.sessions.total} (eligible >= ${r.sessions.minCalls} calls: ${r.sessions.eligible}, excluded: ${r.sessions.excludedBelowMinCalls})`);
  lines.push(`sessions/week: ${r.sessionsPerWeek.toFixed(1)}  calls/session mean ${r.callsPerSession.mean.toFixed(1)} median ${r.callsPerSession.median}`);
  lines.push(`baseline failure rate (pooled, eligible sessions): ${pct(r.baselineRate)}`);
  lines.push(`between-session variance of per-session failure ratio: ${r.betweenSessionVariance.toFixed(6)}`);
  lines.push(`plan: holdout ${pct(r.plan.holdoutShare)} for ${r.plan.weeks} week(s) → ~${r.plan.plannedSessions.toFixed(0)} sessions (${r.plan.nControl.toFixed(0)} control / ${r.plan.nTreatment.toFixed(0)} treatment)`);
  lines.push(`MDE (α=0.05, power 0.8): ${pct(r.mdeAbsolute)} absolute, ${pct(r.mdeRelative)} relative`);
  lines.push('');
  lines.push(`decision: ${r.decision.toUpperCase()}`);
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: exp-outcome-baseline.js [--since 30d] [--holdout-share 0.15] [--weeks 3] [--min-calls 5] [--log-dir dir] [--experiment-log path] [--json]\n');
    return;
  }
  const records = mergeRecords(loadActivityRecords(args.logDir), loadExperimentOutcomes(args.experimentLog));
  const result = computeBaseline(records, args);
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : renderReport(result) + '\n');
}

if (require.main === module) main();

module.exports = {
  readJsonl, listLogFiles,
  normalizeActivityRecord, normalizeExperimentOutcome,
  loadActivityRecords, loadExperimentOutcomes, mergeRecords,
  normInv, sampleVariance, minimumDetectableEffect, computeBaseline, renderReport, parseArgs,
  GO_MIN_BASELINE_RATE, GO_MAX_RELATIVE_MDE, MIN_STRICT_CALLS,
};
