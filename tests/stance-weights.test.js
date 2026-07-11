#!/usr/bin/env node
'use strict';

/**
 * stance-weights.test.js — per-stance recall weighting (Sprint-2 item 3).
 *
 * The council debate opens by recalling once per stance; each stance weights the
 * recall COLLECTIONS [principles, behavioral, selfqa] toward the knowledge it
 * cares about. These specs pin the pure weighting contract: normalization,
 * alias resolution, the default no-op vector, and budget scaling.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  weightsForStance,
  normalizeStance,
  scaleBudget,
  DEFAULT_WEIGHTS,
  STANCE_WEIGHTS,
} = require('../.experience/src/stance-weights');

test('unknown / absent stance is a strict no-op ([1,1,1])', () => {
  assert.deepEqual(weightsForStance(undefined), [1, 1, 1]);
  assert.deepEqual(weightsForStance(null), [1, 1, 1]);
  assert.deepEqual(weightsForStance(''), [1, 1, 1]);
  assert.deepEqual(weightsForStance('nonsense-role'), [1, 1, 1]);
  assert.deepEqual(weightsForStance(42), [1, 1, 1]);
});

test('canonical stances weight their favored collection highest', () => {
  // researcher → principles (index 0) is the max
  const r = weightsForStance('researcher');
  assert.equal(Math.max(...r), r[0]);
  // implementer → behavioral (index 1) is the max
  const impl = weightsForStance('implementer');
  assert.equal(Math.max(...impl), impl[1]);
  // verifier → selfqa (index 2) is the max
  const v = weightsForStance('verifier');
  assert.equal(Math.max(...v), v[2]);
});

test('aliases resolve to canonical stances (case-insensitive, trimmed)', () => {
  assert.deepEqual(weightsForStance('  Research '), weightsForStance('researcher'));
  assert.deepEqual(weightsForStance('VERIFY'), weightsForStance('verifier'));
  assert.deepEqual(weightsForStance('review'), weightsForStance('reviewer'));
  assert.deepEqual(weightsForStance('build'), weightsForStance('implementer'));
  assert.equal(normalizeStance('qa'), 'verifier');
  assert.equal(normalizeStance('unknown'), null);
});

test('leader / synthesizer stay balanced', () => {
  assert.deepEqual(weightsForStance('leader'), [1, 1, 1]);
  assert.deepEqual(weightsForStance('synthesizer'), [1, 1, 1]);
});

test('built-in stances never blind a collection (min weight > 0)', () => {
  for (const [stance, vec] of Object.entries(STANCE_WEIGHTS)) {
    assert.ok(Math.min(...vec) > 0, `${stance} zeroes a collection`);
    assert.equal(vec.length, 3);
  }
});

test('weightsForStance returns a fresh array (no shared mutation)', () => {
  const a = weightsForStance('researcher');
  a[0] = 99;
  assert.notEqual(weightsForStance('researcher')[0], 99);
  assert.deepEqual(DEFAULT_WEIGHTS, [1, 1, 1]);
});

test('scaleBudget scales, floors at 0, and deselects at weight 0', () => {
  assert.equal(scaleBudget(1000, 1), 1000);
  assert.equal(scaleBudget(1000, 1.5), 1500);
  assert.equal(scaleBudget(1000, 0.6), 600);
  assert.equal(scaleBudget(1000, 0), 0); // explicit deselect
  assert.equal(scaleBudget(1000, -5), 0); // never negative
  assert.equal(scaleBudget(undefined, 1.4), 0);
});
