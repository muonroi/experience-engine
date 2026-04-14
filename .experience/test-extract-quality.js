#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _assessExtractedQaQuality } = require('./experience-core.js');

test('rejects placeholder trigger and solution from extractor output', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'when this fires',
    question: 'one line',
    solution: 'what to do',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'placeholder_trigger');
});

test('rejects short placeholder-like solution even with non-placeholder trigger', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'when serverBaseUrl is missing',
    question: 'missing remote config',
    solution: 'fix it',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'placeholder_solution');
});

test('rejects generic extractor output that only repeats session commentary', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'Session excerpt indicates issues with error handling and logging',
    question: 'generic debugging',
    solution: 'Implement standardized error handling and logging practices.',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic_trigger');
});

test('accepts concrete reusable lesson', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'when POST /api/posttool times out in remote thin-client mode',
    question: 'remote posttool blocks hook budget',
    solution: 'queue the posttool payload locally and return immediately so the hook stays non-blocking',
    why: 'remote hook budget is 5s',
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});
