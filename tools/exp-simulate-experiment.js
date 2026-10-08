#!/usr/bin/env node
/**
 * exp-simulate-experiment.js — rehearse the ADR-004 analysis on synthetic logs.
 *
 * Writes, into an EMPTY directory, the logs a server would have after a baseline
 * period and a session-holdout experiment, with an effect planted at a known size:
 *   activity.jsonl      op:'posttool' rows from the weeks BEFORE the experiment (the
 *                       input of exp-outcome-baseline.js) and op:'intercept'
 *                       search_done rows (the input of exp-beta-replay.js);
 *   experiment.jsonl*   session-arm / exposure / outcome events, written through the
 *                       real writers in src/experiment.js, part of them rotated into
 *                       a date-stamped sibling;
 *   points.json         a corpus for exp-beta-replay.js --from-file.
 * Then run the real tools against that directory and check they recover the effect:
 *   node tools/exp-outcome-baseline.js --log-dir <dir> --experiment-log <dir>/experiment.jsonl
 *   node tools/exp-engine-lift.js --log <dir>/experiment.jsonl --end-date <date>
 *   node tools/exp-beta-replay.js --from-file <dir>/points.json --activity <dir>/activity.jsonl
 *
 * The model: each session has its own failure rate (logit-normal around
 * --base-rate, so sessions differ as real ones do); a treatment session's rate is
 * multiplied by (1 − --effect), a beta session's by (1 − --beta-effect). Failures
 * are sometimes retried with the same input; a few deliveries are duplicated and a
 * few calls are unclassifiable. Arms come from the real holdoutArm / modelArm hash.
 *
 * Usage:
 *   node tools/exp-simulate-experiment.js --out <empty dir> [--sessions 600] [--weeks 3]
 *        [--baseline-weeks 2] [--share 0.2] [--effect 0.2] [--model-share 0.5]
 *        [--beta-effect 0] [--base-rate 0.08] [--points 400] [--seed 1] [--salt sim-v1]
 *        [--json]
 *
 * Zero dependencies. Never touches ~/.experience: the directory must be empty, and
 * the writers are pointed at it with an empty config before they load.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY_MS = 86400000;
const START = Date.UTC(2026, 9, 1); // experiment start; the baseline precedes it
const MUTATING = ['Bash', 'Edit', 'Write'];
const RUNTIMES = [['claude-code', 0.7], ['codex', 0.2], ['gemini', 0.1]];
const CREATED_FROM = [['session-extractor', 0.6], ['seed-common-doc', 0.15], ['bulk-seed', 0.1], ['imported', 0.15]];

function parseArgs(argv) {
  const args = {
    out: null, sessions: 600, weeks: 3, baselineWeeks: 2, share: 0.2, effect: 0.2, modelShare: 0.5,
    betaEffect: 0, baseRate: 0.08, points: 400, seed: 1, salt: 'sim-v1', json: false,
  };
  const num = { '--sessions': 'sessions', '--weeks': 'weeks', '--baseline-weeks': 'baselineWeeks', '--share': 'share', '--effect': 'effect', '--model-share': 'modelShare', '--beta-effect': 'betaEffect', '--base-rate': 'baseRate', '--points': 'points', '--seed': 'seed' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (num[k]) args[num[k]] = Number(argv[++i]);
    else if (k === '--out') args.out = argv[++i];
    else if (k === '--salt') args.salt = argv[++i];
    else if (k === '--json') args.json = true;
    else if (k === '--help' || k === '-h') args.help = true;
  }
  return args;
}

// --- randomness (deterministic) ------------------------------------------------------

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

function makeRng(seed) {
  const u = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const pick = (weighted) => {
    let r = u();
    for (const [v, w] of weighted) { if ((r -= w) < 0) return v; }
    return weighted[weighted.length - 1][0];
  };
  const int = (lo, hi) => lo + Math.floor(u() * (hi - lo + 1));
  return { u, normal, pick, int };
}

const logit = (p) => Math.log(p / (1 - p));
const expit = (x) => 1 / (1 + Math.exp(-x));

// --- the simulated world -------------------------------------------------------------

function buildCorpus(rng, n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const id = `${(0x10000000 + i * 7919).toString(16).slice(-8)}-sim-${i}`;
    const createdFrom = rng.pick(CREATED_FROM);
    const surfaceCount = rng.int(0, 40);
    const hitCount = Math.min(surfaceCount, rng.int(0, 10));
    const ignoreCount = Math.max(0, surfaceCount - hitCount - rng.int(0, 10));
    const data = {
      id, solution: `simulated lesson ${i}`, createdFrom, tier: rng.int(0, 2),
      confidence: Number((0.3 + rng.u() * 0.6).toFixed(2)), surfaceCount, hitCount,
      validatedCount: Math.min(hitCount, rng.int(0, 5)), ignoreCount,
      ...(rng.u() < 0.6 ? { betaEvidence: { pos: Number((hitCount * 0.7).toFixed(2)), neg: Number((ignoreCount * 0.3).toFixed(2)), v: 1, sessions: [] } } : {}),
    };
    points.push({ id, collection: data.tier === 0 ? 'experience-principles' : 'experience-behavioral', payload: { json: JSON.stringify(data) } });
  }
  return points;
}

function simulateCalls(rng, rate, n) {
  const calls = [];
  let pendingRetry = null;
  for (let i = 0; i < n; i++) {
    const tool = pendingRetry ? pendingRetry.tool : rng.u() < 0.2 ? 'Read' : MUTATING[rng.int(0, 2)];
    const inputHash = pendingRetry ? pendingRetry.inputHash : `h${Math.floor(rng.u() * 1e9).toString(16)}`;
    pendingRetry = null;
    const roll = rng.u();
    const failure = roll < 0.03 ? 'unknown' : rng.u() < rate ? 'fail' : 'ok';
    calls.push({ tool, inputHash, failure });
    if (failure === 'fail' && rng.u() < 0.3) pendingRetry = { tool, inputHash };
  }
  return calls;
}

function run(args) {
  const out = path.resolve(args.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`--out ${out} is not empty`);
  if (out === path.join(os.homedir(), '.experience')) throw new Error('refusing to write into ~/.experience');
  fs.mkdirSync(out, { recursive: true });

  // Point the real writers at this directory, with an empty config, before they load:
  // a config.json key would otherwise win over the env var and aim at the live log.
  const configPath = path.join(out, 'config.json');
  fs.writeFileSync(configPath, '{}');
  process.env.EXPERIENCE_CONFIG_PATH = configPath;
  process.env.EXPERIENCE_EXPERIMENT_LOG = path.join(out, 'experiment.jsonl');
  const experiment = require('../.experience/src/experiment');

  const rng = makeRng(args.seed);
  const corpus = buildCorpus(rng, args.points);
  fs.writeFileSync(path.join(out, 'points.json'), JSON.stringify(corpus));

  const activity = [];
  const realNow = Date.now;
  const truth = { control: { calls: 0, failed: 0 }, treatment: { calls: 0, failed: 0 }, sessions: { control: 0, treatment: 0 } };
  try {
    // Baseline weeks: no experiment, server-shape posttool rows only.
    const baselineSessions = Math.round(args.sessions * args.baselineWeeks / Math.max(args.weeks, 1));
    for (let s = 0; s < baselineSessions; s++) {
      const sid = `base-${s}`;
      const runtime = rng.pick(RUNTIMES);
      const t0 = START - args.baselineWeeks * 7 * DAY_MS + rng.u() * args.baselineWeeks * 7 * DAY_MS;
      const rate = expit(logit(args.baseRate) + 0.6 * rng.normal());
      simulateCalls(rng, rate, 5 + Math.floor(-Math.log(1 - rng.u()) * 20)).forEach((c, i) => {
        activity.push({ ts: new Date(t0 + i * 30000).toISOString(), op: 'posttool', tool: c.tool, failure: c.failure, toolOutcome: c.failure === 'fail' ? 'error' : 'success', inputHash: c.inputHash, toolUseId: `${sid}-t${i}`, hookEvent: c.failure === 'fail' ? 'PostToolUseFailure' : 'PostToolUse', runtime, sourceRuntime: runtime, sourceSession: sid });
      });
    }

    // Experiment weeks, through the real writers.
    for (let s = 0; s < args.sessions; s++) {
      const sid = `sim-${args.seed}-${s}`;
      const runtime = rng.pick(RUNTIMES);
      const t0 = START + rng.u() * args.weeks * 7 * DAY_MS;
      let clock = t0;
      Date.now = () => clock;
      const holdout = experiment.holdoutArm(sid, { salt: args.salt, share: args.share });
      const model = holdout.arm === 'control' ? null : experiment.modelArm(sid, { salt: args.salt, share: args.modelShare });
      experiment.noteSessionArm({ sessionId: sid, experiment: holdout.experiment, arm: holdout.arm, salt: args.salt, runtime });
      if (model) experiment.noteSessionArm({ sessionId: sid, experiment: model.experiment, arm: model.arm, salt: args.salt, runtime });

      let rate = expit(logit(args.baseRate) + 0.6 * rng.normal());
      if (holdout.arm === 'treatment') rate *= 1 - args.effect;
      if (model && model.arm === 'beta') rate *= 1 - args.betaEffect;
      truth.sessions[holdout.arm]++;

      simulateCalls(rng, rate, 5 + Math.floor(-Math.log(1 - rng.u()) * 20)).forEach((c, i) => {
        clock += 30000;
        const toolUseId = `${sid}-t${i}`;
        if (holdout.arm === 'treatment') {
          const n = rng.u() < 0.55 ? rng.int(1, model && model.arm === 'beta' ? 2 : 3) : 0;
          const shown = Array.from({ length: n }, () => corpus[rng.int(0, corpus.length - 1)].id);
          experiment.logExposure({ sessionId: sid, interceptId: `${toolUseId}-i`, tool: c.tool, toolUseId, shown, runtime, arm: holdout.arm, extra: model ? { model: model.arm, confidenceMode: 'ab' } : undefined });
          activity.push({ ts: new Date(clock).toISOString(), op: 'intercept', stage: 'search_done', tool: c.tool, surfacedCount: n, surfaced: shown.map((id) => ({ collection: 'experience-behavioral', pointId: id.slice(0, 8) })), sourceSession: sid });
        }
        const outcome = { sessionId: sid, toolUseId, tool: c.tool, inputHash: c.inputHash, failure: c.failure, toolOutcome: c.failure === 'fail' ? 'error' : 'success', clientTs: new Date(clock).toISOString(), runtime, hookEvent: c.failure === 'fail' ? 'PostToolUseFailure' : 'PostToolUse' };
        experiment.logOutcome(outcome);
        if (rng.u() < 0.01) experiment.logOutcome(outcome); // duplicated delivery
        if (MUTATING.includes(c.tool) && c.failure !== 'unknown') {
          truth[holdout.arm].calls++;
          if (c.failure === 'fail') truth[holdout.arm].failed++;
        }
      });
    }
  } finally {
    Date.now = realNow;
  }

  // Rotate the first half of the live log into a date-stamped sibling, as a long run
  // would (a big run has already rotated at 10 MB on its own). Stamped like the
  // writer, after the last event it holds, so the siblings stay in time order.
  const log = path.join(out, 'experiment.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const half = Math.floor(lines.length / 2);
  if (half > 0) {
    const stamp = String(JSON.parse(lines[half - 1]).ts).replace(/[-:.]/g, '');
    fs.writeFileSync(`${log}.${stamp}`, lines.slice(0, half).join('\n') + '\n');
    fs.writeFileSync(log, lines.slice(half).join('\n') + '\n');
  }
  fs.rmSync(path.join(out, 'experiment-arms'), { recursive: true, force: true });

  activity.sort((a, b) => a.ts.localeCompare(b.ts));
  fs.writeFileSync(path.join(out, 'activity.jsonl'), activity.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const ratio = (a) => (a.calls ? a.failed / a.calls : NaN);
  const realised = { control: ratio(truth.control), treatment: ratio(truth.treatment) };
  return {
    out,
    salt: args.salt,
    endDate: new Date(START + args.weeks * 7 * DAY_MS).toISOString().slice(0, 10),
    planted: { effect: args.effect, betaEffect: args.betaEffect, baseRate: args.baseRate, share: args.share },
    sessions: truth.sessions,
    realised: { ...realised, relativeDiff: (realised.control - realised.treatment) / realised.treatment },
    files: fs.readdirSync(out).sort(),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.out) {
    process.stdout.write('Usage: node tools/exp-simulate-experiment.js --out <empty dir> [--sessions 600] [--weeks 3] [--share 0.2] [--effect 0.2] [--json]\n');
    return args.help ? 0 : 1;
  }
  const r = run(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    const pct = (v) => `${(v * 100).toFixed(2)}%`;
    process.stdout.write([
      `Simulated experiment in ${r.out}`,
      `sessions: control ${r.sessions.control}, treatment ${r.sessions.treatment}  (share ${r.planted.share}, salt ${r.salt})`,
      `planted effect: treatment failure rate × ${(1 - r.planted.effect).toFixed(2)}`,
      `realised failure ratio: control ${pct(r.realised.control)}, treatment ${pct(r.realised.treatment)}, (control − treatment) / treatment ${pct(r.realised.relativeDiff)}`,
      `analyse with: node tools/exp-engine-lift.js --log ${path.join(r.out, 'experiment.jsonl')} --end-date ${r.endDate}`,
    ].join('\n') + '\n');
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { run, parseArgs };
