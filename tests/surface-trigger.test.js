#!/usr/bin/env node
'use strict';

/**
 * surface-trigger.test.js — §4 shared trigger→targeted-recall layer.
 *
 * detectTopTrigger and runTargetedRecall are the plumbing both the prompt hook
 * and the tool hook used to duplicate. Deps are injectable so this stays pure
 * (no real risk-triggers/config/exp-recall, no network).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const st = require('../.experience/src/surface-trigger.js');

const fakeRisk = (triggers) => ({
  detectRiskTriggers: () => triggers,
  gitRepoRootOf: () => null,
});
const cfgOn = { getRiskGateEnabled: () => true, getRiskKeywords: () => ['deploy'] };
const cfgOff = { getRiskGateEnabled: () => false, getRiskKeywords: () => ['deploy'] };

test('detectTopTrigger: unavailable when risk-triggers module missing', () => {
  const r = st.detectTopTrigger({ promptText: 'deploy prod' }, { riskTriggers: null, cfg: cfgOn });
  assert.deepEqual(r, { unavailable: true });
});

test('detectTopTrigger: disabled when gate flag is off', () => {
  const r = st.detectTopTrigger({ promptText: 'deploy prod' }, {
    riskTriggers: fakeRisk([{ kind: 'sensitive-keyword', topic: 'deploy', evidence: 'deploy prod' }]),
    cfg: cfgOff,
  });
  assert.deepEqual(r, { disabled: true });
});

test('detectTopTrigger: returns top trigger when one fires', () => {
  const triggers = [
    { kind: 'sensitive-keyword', topic: 'deploy', evidence: 'deploy prod' },
    { kind: 'cross-repo', topic: 'other', evidence: 'x' },
  ];
  const r = st.detectTopTrigger({ promptText: 'deploy prod' }, { riskTriggers: fakeRisk(triggers), cfg: cfgOn });
  assert.equal(r.top.topic, 'deploy');
  assert.equal(r.triggers.length, 2);
});

test('detectTopTrigger: null when no trigger fires', () => {
  const r = st.detectTopTrigger({ promptText: 'rename a variable' }, { riskTriggers: fakeRisk([]), cfg: cfgOn });
  assert.equal(r, null);
});

test('detectTopTrigger: error object when detectRiskTriggers throws (logged, not thrown)', () => {
  const throwing = { detectRiskTriggers: () => { throw new Error('boom'); }, gitRepoRootOf: () => null };
  const r = st.detectTopTrigger({ promptText: 'deploy' }, { riskTriggers: throwing, cfg: cfgOn });
  assert.deepEqual(r, { error: true });
});

test('runTargetedRecall: passes fast:true + logLocal:false and returns the recall result', async () => {
  let seen = null;
  const expRecall = { recall: async (topic, opts) => { seen = { topic, opts }; return { count: 2, text: 'hits [id:x col:c]' }; } };
  const res = await st.runTargetedRecall('deploy', '/cwd', { timeoutMs: 1000 }, { expRecall });
  assert.equal(res.count, 2);
  assert.equal(seen.topic, 'deploy');
  assert.equal(seen.opts.fast, true);
  assert.equal(seen.opts.logLocal, false);
  assert.equal(seen.opts.cwd, '/cwd');
});

test('runTargetedRecall: null when exp-recall module missing', async () => {
  assert.equal(await st.runTargetedRecall('deploy', '/cwd', {}, { expRecall: null }), null);
});

test('runTargetedRecall: null on recall throw (logged, not thrown)', async () => {
  const expRecall = { recall: async () => { throw new Error('net down'); } };
  assert.equal(await st.runTargetedRecall('deploy', '/cwd', { timeoutMs: 500 }, { expRecall }), null);
});

test('runTargetedRecall: null on timeout (recall hangs past budget)', async () => {
  // recall never settles, so the timeout inside _withTimeout must win -> null.
  // That timeout timer is unref'd (correct for the real hook), so it alone does
  // NOT keep the event loop alive: with nothing else pending, node drains the
  // loop before the timer fires and node:test cancels the still-pending test
  // ("Promise resolution is still pending but the event loop has already
  // resolved" — node 22 reds CI). A ref'd keep-alive timer holds the loop open
  // until the unref'd timeout fires; settle the recall promise on the way out.
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  const expRecall = { recall: () => slow };
  const keepAlive = setTimeout(() => {}, 200);
  try {
    assert.equal(await st.runTargetedRecall('deploy', '/cwd', { timeoutMs: 30 }, { expRecall }), null);
  } finally {
    clearTimeout(keepAlive);
    resolveSlow();
    await slow;
  }
});
