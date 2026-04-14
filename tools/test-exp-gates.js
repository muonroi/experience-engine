#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDedupAndHygiene,
  computeInterceptionPrecision,
  computeOrganicExtractionStats,
  computeRecurrenceReduction,
  computeCostStability,
} = require('./exp-gates.js');

function pointFrom(data) {
  return { payload: { json: JSON.stringify(data) } };
}

test('computeDedupAndHygiene counts exact duplicates and placeholder extractor entries separately', () => {
  const stats = computeDedupAndHygiene([
    pointFrom({ trigger: 'when this fires', solution: 'Use the right command' }),
    pointFrom({ trigger: 'when serverBaseUrl is missing', solution: 'Set serverBaseUrl in config' }),
    pointFrom({ trigger: 'when serverBaseUrl is missing', solution: 'Set serverBaseUrl in config' }),
    pointFrom({ trigger: 'when tests fail after auth rollout', solution: 'Update test fixtures and rerun the focused suite' }),
  ]);

  assert.equal(stats.duplicateCount, 1);
  assert.equal(stats.lowQualityCount, 1);
});

test('computeInterceptionPrecision measures surfaced-hint precision rather than raw intercept coverage', () => {
  const now = new Date('2026-04-14T06:00:00Z').getTime();
  const activity = [
    { ts: '2026-04-14T05:00:00Z', op: 'intercept', stage: 'budget_capped', result: null },
    { ts: '2026-04-14T05:01:00Z', op: 'intercept', stage: 'search_done', result: 'suggestion' },
    { ts: '2026-04-14T05:02:00Z', op: 'intercept', stage: 'search_done', result: 'suggestion' },
    { ts: '2026-04-14T05:03:00Z', op: 'judge-feedback', verdict: 'FOLLOWED' },
    { ts: '2026-04-14T05:04:00Z', op: 'judge-feedback', verdict: 'IRRELEVANT' },
    { ts: '2026-04-14T05:05:00Z', op: 'implicit-unused', reason: 'wrong_task' },
  ];

  const stats = computeInterceptionPrecision(activity, now);
  assert.equal(stats.interceptEvents.length, 3);
  assert.equal(stats.surfacedSuggestions.length, 2);
  assert.equal(stats.classified, 3);
  assert.equal(stats.relevant, 1);
  assert.equal(stats.irrelevant, 2);
  assert.equal(stats.precision, 33);
});

test('computeOrganicExtractionStats counts only quality organic session-extractor entries', () => {
  const stats = computeOrganicExtractionStats([
    pointFrom({ createdFrom: 'bulk-seed', trigger: 'bulk', solution: 'seeded' }),
    pointFrom({ createdFrom: 'session-extractor', trigger: 'when sed command fails due to missing file', solution: 'check file existence before inspection' }),
    pointFrom({ createdFrom: 'session-extractor', trigger: 'execution of commands', solution: 'review the incomplete command and ensure it is correctly formatted and complete' }),
  ], (data) => ({ ok: !/^execution of commands$/i.test(data.trigger) }));

  assert.equal(stats.totalOrganic, 2);
  assert.equal(stats.qualityOrganic, 1);
});

test('computeRecurrenceReduction compares recent mistakes against the prior week by project and type', () => {
  const now = new Date('2026-04-14T06:00:00Z').getTime();
  const activity = [
    { ts: '2026-04-03T10:00:00Z', op: 'mistake-seen', type: 'test_fail_fix', project: '/repo/a.ts', count: 4 },
    { ts: '2026-04-05T10:00:00Z', op: 'mistake-seen', type: 'user_correction', project: '/repo/a.ts', count: 2 },
    { ts: '2026-04-10T10:00:00Z', op: 'mistake-seen', type: 'test_fail_fix', project: '/repo/a.ts', count: 2 },
    { ts: '2026-04-11T10:00:00Z', op: 'mistake-seen', type: 'user_correction', project: '/repo/a.ts', count: 1 },
  ];

  const stats = computeRecurrenceReduction(activity, now);
  assert.equal(stats.sufficient, true);
  assert.equal(stats.baselineTotal, 6);
  assert.equal(stats.recentTotal, 3);
  assert.equal(stats.reductionPct, 50);
  assert.equal(stats.pass, true);
});

test('computeCostStability compares average daily cost units across active-day windows', () => {
  const now = new Date('2026-04-14T06:00:00Z').getTime();
  const activity = [
    { ts: '2026-04-02T10:00:00Z', op: 'cost-call', kind: 'embed', units: 100 },
    { ts: '2026-04-03T10:00:00Z', op: 'cost-call', kind: 'brain', units: 100 },
    { ts: '2026-04-05T10:00:00Z', op: 'cost-call', kind: 'judge', units: 100 },
    { ts: '2026-04-09T10:00:00Z', op: 'cost-call', kind: 'embed', units: 90 },
    { ts: '2026-04-10T10:00:00Z', op: 'cost-call', kind: 'brain', units: 100 },
    { ts: '2026-04-12T10:00:00Z', op: 'cost-call', kind: 'extract', units: 100 },
  ];

  const stats = computeCostStability(activity, now);
  assert.equal(stats.sufficient, true);
  assert.equal(stats.baselineAvg, 100);
  assert.equal(stats.recentAvg, 97);
  assert.equal(stats.deltaPct, -3);
  assert.equal(stats.pass, true);
});
