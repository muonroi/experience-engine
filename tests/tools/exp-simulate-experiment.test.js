'use strict';

// End-to-end rehearsal of the ADR-004 analysis: simulate a baseline and a
// session-holdout experiment through the real writers, then run the real
// baseline, lift and beta-replay tools on the result. A planted effect must be
// found, a null effect must not be, and the tools must read the log the writer
// resolves (config experimentLog), not a guessed default.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOLS = path.join(__dirname, '..', '..', 'tools');
const SIM = path.join(TOOLS, 'exp-simulate-experiment.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sim-'));
const CONFIG = path.join(ROOT, 'config.json');
fs.writeFileSync(CONFIG, '{}');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('EXPERIENCE_')) delete env[k];
  return { ...env, HOME: ROOT, USERPROFILE: ROOT, EXPERIENCE_CONFIG_PATH: CONFIG, ...extra };
}

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { encoding: 'utf8', env: cleanEnv(env), timeout: 120000 });
  assert.equal(r.status, 0, `${script} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function simulate(name, args) {
  const out = path.join(ROOT, name);
  return JSON.parse(run('exp-simulate-experiment.js', ['--out', out, '--json', ...args]));
}

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

test('simulator writes rotated experiment logs, activity and a corpus, and refuses a non-empty dir', () => {
  const sim = simulate('layout', ['--sessions', '60', '--points', '20']);
  assert.ok(sim.files.includes('experiment.jsonl'));
  assert.ok(sim.files.some((f) => /^experiment\.jsonl\.\d{8}T/.test(f)), 'a rotated sibling');
  assert.ok(sim.files.includes('activity.jsonl'));
  assert.ok(sim.files.includes('points.json'));
  assert.ok(!sim.files.includes('experiment-arms'), 'arm marker dir cleaned up');
  const r = spawnSync(process.execPath, [SIM, '--out', sim.out], { encoding: 'utf8', env: cleanEnv() });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not empty/);
});

test('a planted effect is found: the CI excludes 0 and covers the realised difference', () => {
  const sim = simulate('effect', ['--sessions', '1500', '--effect', '0.3', '--seed', '7']);
  const lift = JSON.parse(run('exp-engine-lift.js', ['--log', path.join(sim.out, 'experiment.jsonl'), '--end-date', '2000-01-01', '--resamples', '600', '--json']));
  assert.equal(lift.status, 'decision', 'past the end date the run is a decision');
  assert.equal(lift.salt, sim.salt);
  assert.ok(lift.input.files >= 2, 'reads the rotated siblings too');
  const [lo, hi] = lift.primary.ci95.relative;
  assert.ok(lo > 0, `effect detected: relative CI [${lo}, ${hi}]`);
  assert.ok(lo <= sim.realised.relativeDiff && sim.realised.relativeDiff <= hi, 'CI covers the realised difference');
  assert.equal(lift.sessions.assigned, sim.sessions.control + sim.sessions.treatment);
});

test('no effect: the CI covers 0; the model comparison applies the pre-registered rule', () => {
  const sim = simulate('null', ['--sessions', '1500', '--effect', '0', '--seed', '11']);
  const log = path.join(sim.out, 'experiment.jsonl');
  const lift = JSON.parse(run('exp-engine-lift.js', ['--log', log, '--resamples', '600', '--json']));
  assert.equal(lift.status, 'monitoring, not a decision');
  const [lo, hi] = lift.primary.ci95.relative;
  assert.ok(lo < 0 && hi > 0, `no effect: relative CI [${lo}, ${hi}]`);
  const model = JSON.parse(run('exp-engine-lift.js', ['--log', log, '--compare', 'model', '--resamples', '600', '--json']));
  assert.equal(typeof model.rule.keepBeta, 'boolean');
  assert.ok(model.guardrails.beta.intercepts > 0 && model.guardrails.legacy.intercepts > 0);
});

test('baseline reads the simulated weeks and reaches a go/no-go; beta replay runs on the corpus', () => {
  const sim = simulate('baseline', ['--sessions', '900', '--points', '120', '--seed', '3']);
  const base = JSON.parse(run('exp-outcome-baseline.js', ['--log-dir', sim.out, '--holdout-share', '0.2', '--weeks', '3', '--json']));
  assert.ok(['go', 'no-go'].includes(base.decision));
  assert.equal(base.basis, 'strict');
  assert.ok(Math.abs(base.baselineRate - sim.planted.baseRate) < 0.03, `baseline rate ${base.baselineRate}`);
  assert.equal(base.input.experimentLog, path.join(sim.out, 'experiment.jsonl'));
  const replay = JSON.parse(run('exp-beta-replay.js', ['--from-file', path.join(sim.out, 'points.json'), '--activity', path.join(sim.out, 'activity.jsonl'), '--json']));
  assert.equal(replay.overall.entries, 120);
  assert.ok(replay.intercepts.intercepts > 0);
});

test('without --log the tools read the log the writer resolves (config experimentLog)', () => {
  const sim = simulate('config', ['--sessions', '80', '--points', '10']);
  const cfg = path.join(ROOT, 'config-with-log.json');
  fs.writeFileSync(cfg, JSON.stringify({ experimentLog: path.join(sim.out, 'experiment.jsonl') }));
  const lift = JSON.parse(run('exp-engine-lift.js', ['--resamples', '50', '--json'], { EXPERIENCE_CONFIG_PATH: cfg }));
  assert.equal(lift.input.log, path.join(sim.out, 'experiment.jsonl'));
  assert.ok(lift.input.events > 0);
  const base = JSON.parse(run('exp-outcome-baseline.js', ['--json'], { EXPERIENCE_CONFIG_PATH: cfg }));
  assert.equal(base.input.experimentLog, path.join(sim.out, 'experiment.jsonl'));
  assert.ok(base.input.experimentOutcomes > 0);
});

test('a missing log is reported, not silently analysed as empty', () => {
  const text = run('exp-engine-lift.js', ['--log', path.join(ROOT, 'nope', 'experiment.jsonl')]);
  assert.match(text, /0 events from 0 file\(s\)/);
  assert.match(text, /WARNING: no experiment log there/);
});
