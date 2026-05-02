#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadFixture, runHarness } = require('./exp-holdout-harness.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'holdout');

test('curated holdout fixtures load as non-empty suites with seed and holdout buckets', () => {
  const loaded = loadFixture(FIXTURE_DIR);
  assert.equal(loaded.files.length >= 3, true);
  assert.equal(loaded.suites.length >= 3, true);

  for (const suite of loaded.suites) {
    assert.ok(suite.name);
    assert.ok(suite.family);
    assert.ok(suite.principleId);
    assert.ok(Array.isArray(suite.seed) && suite.seed.length >= 2);
    assert.ok(Array.isArray(suite.holdout) && suite.holdout.length >= 2);
  }
});

test('runHarness can execute the curated fixture directory with mock retrieval deps', async () => {
  const result = await runHarness({
    fixture: FIXTURE_DIR,
    apply: false,
    topK: 5,
    threshold: 0.5,
    collections: ['experience-principles', 'experience-behavioral'],
  }, {
    getEmbeddingRaw: async () => [0.1, 0.2],
    searchCollection: async (_collection, _vector, _topK) => [
      {
        id: 'family-rerun-loop',
        score: 0.82,
        payload: { json: JSON.stringify({ principle: 'Synthetic rerun-loop principle' }) },
      },
      {
        id: 'family-stale-mock-state',
        score: 0.79,
        payload: { json: JSON.stringify({ principle: 'Synthetic stale state principle' }) },
      },
      {
        id: 'family-natural-bootstrap',
        score: 0.77,
        payload: { json: JSON.stringify({ principle: 'Synthetic natural bootstrap principle' }) },
      },
    ],
    rerankByQuality: (points) => points,
    recordHoldoutOutcome: async () => {},
  });

  assert.equal(result.fixtureFiles.length >= 3, true);
  assert.equal(result.suites.length >= 3, true);
});
