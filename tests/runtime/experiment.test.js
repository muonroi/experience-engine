#!/usr/bin/env node
'use strict';

// Session-holdout assignment + experiment log (spec §3 A1/A2, §5 "Assignment").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-experiment-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const CONFIG = path.join(HOME, 'config.json');
process.env.EXPERIENCE_CONFIG_PATH = CONFIG;
const LOG = path.join(HOME, 'exp', 'experiment.jsonl');

const SRC = path.join(__dirname, '..', '..', '.experience', 'src');
const config = require(path.join(SRC, 'config.js'));
const bayes = require(path.join(SRC, 'bayes.js'));
const experiment = require(path.join(SRC, 'experiment.js'));

const rejected = [];
config.setActivityLog((e) => { if (e.op === 'config-rejected') rejected.push(e); });

function setConfig(obj) {
  fs.writeFileSync(CONFIG, JSON.stringify(obj));
  config.refreshConfig();
}

test.beforeEach(() => {
  rejected.length = 0;
  setConfig({});
  delete process.env.EXPERIENCE_EXPERIMENT_HOLDOUT_SHARE;
  fs.rmSync(path.join(HOME, 'exp'), { recursive: true, force: true });
  experiment._resetForTests();
});

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

test('fnv1a32 / fmix32 reference values', () => {
  assert.equal(bayes.fnv1a32(''), 0x811c9dc5);
  assert.equal(bayes.fnv1a32('a'), 0xe40c292c);
  assert.equal(bayes.fnv1a32('foobar'), 0xbf9cf968);
  assert.equal(bayes.fmix32(0), 0);
  const u = bayes.unitHash('v1|holdout|abc');
  assert.ok(u >= 0 && u < 1);
  assert.equal(u, bayes.unitHash('v1|holdout|abc'));
});

test('holdout share defaults to 0: no experiment, no arm', () => {
  assert.equal(config.getExperimentHoldoutShare(), 0);
  assert.equal(config.getExperimentSalt(), 'v1');
  assert.equal(experiment.isExperimentActive(), false);
  assert.equal(experiment.holdoutArm('session-1'), null);
  assert.equal(experiment.resolveInterceptExperiment({ sourceSession: 'session-1' }), null);
  assert.equal(rejected.length, 0);
});

test('no session id → not in the experiment', () => {
  for (const sid of [null, undefined, '', '  ', 'null', 'undefined']) {
    assert.equal(experiment.holdoutArm(sid, { share: 0.5, salt: 'v1' }), null, String(sid));
  }
});

test('assignment is deterministic and matches the documented hash', () => {
  const a = experiment.holdoutArm('sess-42', { share: 0.3, salt: 'v1' });
  const b = experiment.holdoutArm('sess-42', { share: 0.3, salt: 'v1' });
  assert.deepEqual(a, b);
  const u = bayes.fmix32(bayes.fnv1a32('v1|holdout|sess-42')) / 2 ** 32;
  assert.equal(a.u, u);
  assert.equal(a.arm, u < 0.3 ? 'control' : 'treatment');
  // A different salt re-randomises.
  const arms = new Set();
  for (let i = 0; i < 64; i++) arms.add(experiment.holdoutArm('sess-42', { share: 0.5, salt: `s${i}` }).arm);
  assert.equal(arms.size, 2);
});

for (const share of [0.1, 0.15, 0.5]) {
  test(`control share within ±0.01 of ${share} over 100k synthetic session ids`, () => {
    let control = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) {
      if (experiment.holdoutArm(`session-${i}-${(i * 2654435761) >>> 0}`, { share, salt: 'v1' }).arm === 'control') control++;
    }
    assert.ok(Math.abs(control / n - share) <= 0.01, `observed ${control / n}`);
  });
}

test('float getter: config number, env string, clamping and rejection logging', () => {
  setConfig({ experimentHoldoutShare: 0.2 });
  assert.equal(config.getExperimentHoldoutShare(), 0.2);
  assert.equal(rejected.length, 0);

  setConfig({});
  process.env.EXPERIENCE_EXPERIMENT_HOLDOUT_SHARE = '0.15';
  assert.equal(config.getExperimentHoldoutShare(), 0.15, 'env values arrive as strings');
  process.env.EXPERIENCE_EXPERIMENT_HOLDOUT_SHARE = '0.05';
  setConfig({ experimentHoldoutShare: 0.25 });
  assert.equal(config.getExperimentHoldoutShare(), 0.25, 'config file wins over env');
  delete process.env.EXPERIENCE_EXPERIMENT_HOLDOUT_SHARE;

  setConfig({ experimentHoldoutShare: 0.8 });
  assert.equal(config.getExperimentHoldoutShare(), 0.5, 'clamped to the upper bound');
  setConfig({ experimentHoldoutShare: -0.1 });
  assert.equal(config.getExperimentHoldoutShare(), 0, 'clamped to the lower bound');
  setConfig({ experimentHoldoutShare: 'ten percent' });
  assert.equal(config.getExperimentHoldoutShare(), 0, 'NaN → 0');
  setConfig({ experimentHoldoutShare: true });
  assert.equal(config.getExperimentHoldoutShare(), 0);
  setConfig({ experimentHoldoutShare: [0.1] });
  assert.equal(config.getExperimentHoldoutShare(), 0);
  assert.equal(rejected.length, 5);
  assert.deepEqual(rejected.map((e) => e.using), [0.5, 0, 0, 0, 0]);
  assert.ok(rejected.every((e) => e.key === 'experimentHoldoutShare'));
});

test('experiment log: append with ts + sourceSession, read back across rotation', () => {
  setConfig({ experimentHoldoutShare: 0.2, experimentLog: LOG });
  assert.equal(experiment.isExperimentActive(), true);
  experiment.logOutcome({ sessionId: 's1', tool: 'Bash', failure: 'fail', toolOutcome: 'error', inputHash: 'h', toolUseId: 't1', runtime: 'claude-code', clientTs: 'c', hookEvent: 'PostToolUseFailure' });
  experiment.logExposure({ sessionId: 's1', interceptId: 'i1', tool: 'UserPrompt', shown: ['a'], graphShown: [], runtime: 'claude-code', arm: 'treatment' });
  assert.equal(experiment.logOutcome({ sessionId: null, tool: 'Bash' }), false, 'no session → not logged');
  const events = experiment.readExperimentLog(LOG);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'outcome');
  assert.equal(events[0].sourceSession, 's1');
  assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(events[1].event, 'exposure');
  assert.equal(events[1].hookEvent, 'UserPromptSubmit');
  assert.deepEqual(events[1].shown, ['a']);
});

test('experiment log rotates into date-stamped files that are never overwritten', () => {
  setConfig({ experimentHoldoutShare: 0.2, experimentLog: LOG });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-09-25T10:11:12.345Z');
  try {
    const big = Buffer.alloc(experiment.MAX_EXPERIMENT_LOG_BYTES, 0x20);
    fs.writeFileSync(LOG, big);
    experiment.appendExperimentEvent({ event: 'probe', n: 1 });
    fs.writeFileSync(LOG, big); // same stamp again → must not clobber the first rotation
    experiment.appendExperimentEvent({ event: 'probe', n: 2 });
  } finally {
    Date.now = realNow;
  }
  const names = fs.readdirSync(path.dirname(LOG)).filter((n) => n.startsWith('experiment.jsonl')).sort();
  assert.deepEqual(names, ['experiment.jsonl', 'experiment.jsonl.20260925T101112345Z', 'experiment.jsonl.20260925T101112345Z-1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(LOG, 'utf8')), { ts: '2026-09-25T10:11:12.345Z', event: 'probe', n: 2 });
  assert.equal(fs.statSync(LOG + '.20260925T101112345Z').size, experiment.MAX_EXPERIMENT_LOG_BYTES, 'first rotation intact');
  const files = experiment.listLogFiles(LOG).map((f) => path.basename(f));
  assert.deepEqual(files, ['experiment.jsonl.20260925T101112345Z', 'experiment.jsonl.20260925T101112345Z-1', 'experiment.jsonl']);
});

test('session-arm is logged once per (session, experiment), across processes', () => {
  setConfig({ experimentHoldoutShare: 0.2, experimentLog: LOG });
  const arm = { sessionId: 'sess-a', experiment: 'holdout', arm: 'treatment', salt: 'v1', runtime: 'claude-code' };
  assert.equal(experiment.noteSessionArm(arm), true);
  assert.equal(experiment.noteSessionArm(arm), false, 'same process');
  experiment._resetForTests(); // a new hook process
  assert.equal(experiment.noteSessionArm(arm), false, 'marker file survives the process');
  assert.equal(experiment.noteSessionArm({ ...arm, sessionId: 'sess-b' }), true);
  const arms = experiment.readExperimentLog(LOG).filter((e) => e.event === 'session-arm');
  assert.deepEqual(arms.map((e) => e.sourceSession), ['sess-a', 'sess-b']);
  assert.equal(arms[0].salt, 'v1');
  assert.equal(arms[0].runtime, 'claude-code');
});

test('nothing is written while no experiment is active', () => {
  setConfig({ experimentLog: LOG });
  assert.equal(experiment.noteHoldoutFor('sess-x', 'claude-code'), null);
  assert.equal(fs.existsSync(LOG), false);
});
