#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  normalizeSuite,
  findTargetMatch,
  runHarness,
} = require('./exp-holdout-harness.js');

test('parseArgs reads fixture, apply flag, and threshold', () => {
  const args = parseArgs(['--fixture', 'suite.json', '--apply', '--threshold', '0.6', '--top-k', '7']);
  assert.equal(args.fixture, 'suite.json');
  assert.equal(args.apply, true);
  assert.equal(args.threshold, 0.6);
  assert.equal(args.topK, 7);
});

test('normalizeSuite requires principleId and both seed/holdout buckets', () => {
  const suite = normalizeSuite({
    name: 'rerun-loop',
    principleId: 'principle-1',
    seed: [{ text: 'seed text' }],
    holdout: [{ text: 'holdout text' }],
  }, ['experience-principles']);

  assert.equal(suite.name, 'rerun-loop');
  assert.equal(suite.principleId, 'principle-1');
  assert.equal(suite.seed.length, 1);
  assert.equal(suite.holdout.length, 1);
});

test('findTargetMatch checks both target id and score threshold', () => {
  const result = findTargetMatch([
    { id: 'principle-1', _collection: 'experience-principles', score: 0.72 },
  ], {
    principleId: 'principle-1',
    targetCollection: 'experience-principles',
  }, 0.5);

  assert.equal(result.matched, true);
  assert.equal(result.rank, 1);
  assert.equal(result.score, 0.72);
});

test('runHarness evaluates seed and holdout cases and records holdout outcomes when apply=true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-holdout-harness-'));
  const fixturePath = path.join(tmpDir, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    suites: [
      {
        name: 'rerun-loop',
        principleId: 'principle-1',
        targetCollection: 'experience-principles',
        seed: [
          { id: 'seed-1', text: 'seed rerun loop case' },
        ],
        holdout: [
          { id: 'holdout-1', text: 'holdout rerun loop case', projectSlug: 'experience-engine' },
          { id: 'holdout-2', text: 'miss case', projectSlug: 'experience-engine' },
        ],
      },
    ],
  }, null, 2));

  const recordCalls = [];
  const result = await runHarness({
    fixture: fixturePath,
    apply: true,
    topK: 5,
    threshold: 0.5,
    collections: ['experience-principles'],
  }, {
    getEmbeddingRaw: async () => [0.1, 0.2],
    searchCollection: async (_collection, _vector, _topK) => [
      {
        id: 'principle-1',
        score: recordCalls.length === 1 ? 0.2 : 0.81,
        payload: { json: JSON.stringify({ principle: 'When rerun loop hides root cause, inspect and change state first' }) },
      },
    ],
    rerankByQuality: (points) => points,
    recordHoldoutOutcome: async (collection, pointId, outcome) => {
      recordCalls.push({ collection, pointId, outcome });
    },
  });

  assert.equal(result.suites.length, 1);
  assert.equal(result.suites[0].seedSupport.matched, 1);
  assert.equal(result.suites[0].holdoutProof.matched, 1);
  assert.equal(result.suites[0].holdoutProof.tested, 2);
  assert.equal(recordCalls.length, 2);
  assert.equal(recordCalls[0].outcome.matched, true);
  assert.equal(recordCalls[1].outcome.matched, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
