#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COLLECTIONS,
  parseArgs,
  resolveCollections,
  buildTextHaystack,
  scoreTextMatch,
  sortAndTrim,
  summarizePoint,
  formatHuman,
} = require('./qdrant-find.js');

function pointFrom(id, data, score = 0) {
  return {
    id,
    score,
    payload: {
      json: JSON.stringify(data),
    },
  };
}

test('parseArgs collects query text, mode, collections, and flags', () => {
  const args = parseArgs(['experience', 'formation', '--mode', 'scroll', '--collection', 'experience-principles', '--limit', '7', '--json']);
  assert.equal(args.query, 'experience formation');
  assert.equal(args.mode, 'scroll');
  assert.deepEqual(args.collections, ['experience-principles']);
  assert.equal(args.limit, 7);
  assert.equal(args.json, true);
});

test('resolveCollections falls back to default collections', () => {
  assert.deepEqual(resolveCollections([]), DEFAULT_COLLECTIONS);
  assert.deepEqual(resolveCollections(['experience-principles']), ['experience-principles']);
});

test('scoreTextMatch uses principle, failure mode, and conditions content', () => {
  const point = pointFrom('p1', {
    principle: 'When a failure family repeats with different wording, abstract to the judgment level',
    failureMode: 'literal trigger overfitting',
    conditions: ['novel case', 'experience formation'],
  });
  assert.equal(scoreTextMatch('experience formation novel case', point, JSON.parse(point.payload.json)) > 0.6, true);
  assert.equal(scoreTextMatch('unrelated words', point, JSON.parse(point.payload.json)), 0);
});

test('sortAndTrim orders by score descending and respects minimum score', () => {
  const result = sortAndTrim([
    { id: 'low', score: 0.2 },
    { id: 'high', score: 0.9 },
    { id: 'mid', score: 0.5 },
  ], 2, 0.3);
  assert.deepEqual(result.map((item) => item.id), ['high', 'mid']);
});

test('summarizePoint extracts stable human-facing fields', () => {
  const summary = summarizePoint(pointFrom('abc', {
    tier: 0,
    principle: 'When bootstrap is natural, reuse can emerge without forcing',
    solution: 'Prefer natural bootstrap',
    failureMode: 'forced targeting dependency',
    judgment: 'favor natural retrieval',
    createdFrom: 'evolution-abstraction',
    _projectSlug: 'experience-engine',
    confirmedProjects: ['experience-engine', 'muonroi-control-plane'],
  }, 0.88), 'experience-principles');

  assert.equal(summary.collection, 'experience-principles');
  assert.equal(summary.tier, 0);
  assert.equal(summary.failureMode, 'forced targeting dependency');
  assert.deepEqual(summary.confirmedProjects, ['experience-engine', 'muonroi-control-plane']);
});

test('formatHuman prints numbered result blocks', () => {
  const text = formatHuman({
    mode: 'semantic',
    results: [
      {
        id: 'abc',
        collection: 'experience-principles',
        score: 0.91,
        tier: 0,
        failureMode: 'literal overfitting',
        projectSlug: 'experience-engine',
        createdFrom: 'evolution-abstraction',
        principle: 'When wording changes but the failure mode is the same, abstract by judgment.',
      },
    ],
  });

  assert.match(text, /1\. \[experience-principles\] abc/);
  assert.match(text, /tier=T0/);
  assert.match(text, /abstract by judgment/);
});
