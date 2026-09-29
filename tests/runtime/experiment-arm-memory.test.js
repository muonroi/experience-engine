#!/usr/bin/env node
'use strict';

// Thin-client arm memory (remote-client.js): a session's arm is remembered from
// the server's marker, and a NEW session whose first hook times out gets its arm
// computed from the last marker's salt and share — the same hash the server uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const remote = require('../../.experience/remote-client');
const experiment = require('../../.experience/src/experiment');

const HOUR = 60 * 60 * 1000;

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-arm-memory-'));
  fs.mkdirSync(path.join(home, '.experience'), { recursive: true });
  return home;
}

function armFile(home) {
  return path.join(home, '.experience', 'tmp', 'experiment-arms.json');
}

function withNow(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}

test('a new session gets the same arm the server would assign', () => {
  const home = tempHome();
  const salt = 'salt-1';
  const share = 0.3;
  remote.rememberExperimentArm('seen-1', { arm: 'treatment', salt, share }, home);
  const arms = { control: 0, treatment: 0 };
  for (let i = 0; i < 400; i++) {
    const sid = `new-session-${i}`;
    const expected = experiment.holdoutArm(sid, { salt, share }).arm;
    assert.equal(remote.recallExperimentArm(sid, home), expected, sid);
    arms[expected]++;
  }
  assert.ok(arms.control > 0 && arms.treatment > 0, 'both arms exercised');
});

test('the arm remembered for a session wins over the computed one', () => {
  const home = tempHome();
  remote.rememberExperimentArm('s', { arm: 'control', salt: 'x', share: 0 }, home);
  assert.equal(remote.recallExperimentArm('s', home), 'control');
});

test('no params, share 0, or a missing session id computes nothing', () => {
  const home = tempHome();
  assert.equal(remote.recallExperimentArm('s', home), null, 'no marker seen yet');
  remote.rememberExperimentArm('a', { arm: 'treatment' }, home); // model-only / legacy marker: no params
  assert.equal(remote.recallExperimentArm('b', home), null);
  remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 0 }, home);
  assert.equal(remote.recallExperimentArm('b', home), null, 'share 0 = no holdout');
  remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 1 }, home);
  assert.equal(remote.recallExperimentArm('b', home), 'control');
  for (const sid of ['', 'null', 'undefined', null, undefined]) {
    assert.equal(remote.recallExperimentArm(sid, home), null, String(sid));
  }
});

test('params expire after two hours so an ended experiment stops holding sessions out', () => {
  const home = tempHome();
  const t0 = Date.UTC(2026, 8, 29, 0, 0, 0);
  withNow(t0, () => remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 1 }, home));
  assert.equal(withNow(t0 + 2 * HOUR - 1, () => remote.recallExperimentArm('b', home)), 'control');
  assert.equal(withNow(t0 + 2 * HOUR + 1, () => remote.recallExperimentArm('b', home)), null);
  // The session that did see a marker keeps its arm for a day.
  assert.equal(withNow(t0 + 2 * HOUR + 1, () => remote.recallExperimentArm('a', home)), 'treatment');
});

test('params are refreshed by later markers and follow a changed share', () => {
  const home = tempHome();
  const t0 = Date.UTC(2026, 8, 29, 0, 0, 0);
  withNow(t0, () => remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 1 }, home));
  // Same session, same arm, same params 90 minutes later: params get a fresh ts.
  withNow(t0 + 90 * 60 * 1000, () => remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 1 }, home));
  assert.equal(withNow(t0 + 3 * HOUR, () => remote.recallExperimentArm('b', home)), 'control');
  // A new share replaces the old one immediately.
  withNow(t0 + 3 * HOUR, () => remote.rememberExperimentArm('a', { arm: 'treatment', salt: 'x', share: 0 }, home));
  assert.equal(withNow(t0 + 3 * HOUR, () => remote.recallExperimentArm('b', home)), null);
});

test('a failed write surfaces to the caller instead of being dropped here', () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(armFile(home)), { recursive: true });
  fs.mkdirSync(armFile(home) + '.' + process.pid + '.tmp'); // the temp path is a directory → write fails
  assert.throws(() => remote.rememberExperimentArm('s', { arm: 'control', salt: 'x', share: 0.5 }, home));
});
