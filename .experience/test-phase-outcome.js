#!/usr/bin/env node
'use strict';

/**
 * test-phase-outcome.js — P1 Item 3 unit tests for applyPhaseOutcome helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPhaseOutcome,
  outcomeToVerdict,
  VALID_OUTCOMES,
  _resetDedup,
} = require('./src/phase-outcome.js');

function makeRecorder() {
  const calls = [];
  const recordFeedback = async (collection, pointId, verdict, reason, opts) => {
    calls.push({ collection, pointId, verdict, reason, opts });
    return true;
  };
  return { calls, recordFeedback };
}

test.beforeEach(() => _resetDedup());

// ─── outcomeToVerdict ─────────────────────────────────────────────────────────

test('outcomeToVerdict maps pass→FOLLOWED, fail→IGNORED, abandoned→IRRELEVANT', () => {
  assert.deepStrictEqual(outcomeToVerdict('pass'), { verdict: 'FOLLOWED', reason: null });
  assert.deepStrictEqual(outcomeToVerdict('fail'), { verdict: 'IGNORED', reason: null });
  assert.deepStrictEqual(outcomeToVerdict('abandoned'), { verdict: 'IRRELEVANT', reason: 'wrong_task' });
  assert.strictEqual(outcomeToVerdict('weird'), null);
});

test('VALID_OUTCOMES exposes the canonical set', () => {
  assert.ok(VALID_OUTCOMES.has('pass'));
  assert.ok(VALID_OUTCOMES.has('fail'));
  assert.ok(VALID_OUTCOMES.has('abandoned'));
  assert.strictEqual(VALID_OUTCOMES.size, 3);
});

// ─── applyPhaseOutcome happy path ─────────────────────────────────────────────

test('applyPhaseOutcome applies recordFeedback per principle on pass', async () => {
  const r = makeRecorder();
  const result = await applyPhaseOutcome({
    sessionId: 's1', phaseName: 'implement', outcome: 'pass',
    toolEventIds: [
      { collection: 'code', pointId: 'p1' },
      { collection: 'code', pointId: 'p2' },
    ],
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.applied, 2);
  assert.strictEqual(result.skipped, 0);
  assert.strictEqual(r.calls.length, 2);
  assert.strictEqual(r.calls[0].verdict, 'FOLLOWED');
  assert.strictEqual(r.calls[0].opts.source, 'phase-outcome');
});

test('applyPhaseOutcome handles fail → IGNORED', async () => {
  const r = makeRecorder();
  await applyPhaseOutcome({
    sessionId: 's1', phaseName: 'implement', outcome: 'fail',
    toolEventIds: [{ collection: 'code', pointId: 'p1' }],
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(r.calls[0].verdict, 'IGNORED');
});

test('applyPhaseOutcome handles abandoned → IRRELEVANT with wrong_task reason', async () => {
  const r = makeRecorder();
  await applyPhaseOutcome({
    sessionId: 's1', phaseName: 'implement', outcome: 'abandoned',
    toolEventIds: [{ collection: 'code', pointId: 'p1' }],
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(r.calls[0].verdict, 'IRRELEVANT');
  assert.strictEqual(r.calls[0].reason, 'wrong_task');
});

// ─── validation ───────────────────────────────────────────────────────────────

test('applyPhaseOutcome rejects missing sessionId', async () => {
  const r = makeRecorder();
  const result = await applyPhaseOutcome({
    phaseName: 'p', outcome: 'pass',
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /sessionId/);
});

test('applyPhaseOutcome rejects missing phaseName', async () => {
  const r = makeRecorder();
  const result = await applyPhaseOutcome({
    sessionId: 's', outcome: 'pass',
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /phaseName/);
});

test('applyPhaseOutcome rejects unknown outcome', async () => {
  const r = makeRecorder();
  const result = await applyPhaseOutcome({
    sessionId: 's', phaseName: 'p', outcome: 'whatever',
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /outcome/);
});

test('applyPhaseOutcome skips invalid principle refs', async () => {
  const r = makeRecorder();
  const result = await applyPhaseOutcome({
    sessionId: 's', phaseName: 'p', outcome: 'pass',
    toolEventIds: [{ pointId: 'no-coll' }, null, { collection: 'code', pointId: 'ok' }],
  }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(result.applied, 1);
  assert.strictEqual(result.skipped, 2);
});

// ─── dedup ────────────────────────────────────────────────────────────────────

test('applyPhaseOutcome dedups same (sessionId, phaseName) within window', async () => {
  const r = makeRecorder();
  const refs = [{ collection: 'code', pointId: 'p1' }];
  const a = await applyPhaseOutcome({ sessionId: 's', phaseName: 'p', outcome: 'pass', toolEventIds: refs }, { recordFeedback: r.recordFeedback });
  const b = await applyPhaseOutcome({ sessionId: 's', phaseName: 'p', outcome: 'pass', toolEventIds: refs }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(a.applied, 1);
  assert.strictEqual(b.cached, true);
  assert.strictEqual(b.applied, 1, 'cached result returns same applied count');
  assert.strictEqual(r.calls.length, 1, 'recordFeedback called only once');
});

test('applyPhaseOutcome does not dedup different phaseName', async () => {
  const r = makeRecorder();
  const refs = [{ collection: 'code', pointId: 'p1' }];
  await applyPhaseOutcome({ sessionId: 's', phaseName: 'phase-a', outcome: 'pass', toolEventIds: refs }, { recordFeedback: r.recordFeedback });
  await applyPhaseOutcome({ sessionId: 's', phaseName: 'phase-b', outcome: 'pass', toolEventIds: refs }, { recordFeedback: r.recordFeedback });
  assert.strictEqual(r.calls.length, 2);
});

// ─── activity log ─────────────────────────────────────────────────────────────

test('applyPhaseOutcome calls activityLog when provided', async () => {
  const r = makeRecorder();
  const logs = [];
  await applyPhaseOutcome({
    sessionId: 's', phaseName: 'p', outcome: 'pass',
    toolEventIds: [{ collection: 'code', pointId: 'p1' }],
  }, { recordFeedback: r.recordFeedback, activityLog: (e) => logs.push(e) });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].op, 'phase-outcome');
  assert.strictEqual(logs[0].outcome, 'pass');
  assert.strictEqual(logs[0].applied, 1);
});

test('applyPhaseOutcome counts skip when recordFeedback throws', async () => {
  const recordFeedback = async () => { throw new Error('boom'); };
  const result = await applyPhaseOutcome({
    sessionId: 's', phaseName: 'p', outcome: 'pass',
    toolEventIds: [{ collection: 'code', pointId: 'p1' }],
  }, { recordFeedback });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.applied, 0);
  assert.strictEqual(result.skipped, 1);
});
