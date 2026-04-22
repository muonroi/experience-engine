#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _computeEffectiveScore,
} = require('./experience-core.js');

function makePoint(score = 0.8) {
  return { score };
}

test('condition-aware scoring rewards matching principle conditions and penalizes misses', () => {
  const point = makePoint();
  const baseData = {
    confidence: 0.8,
    hitCount: 4,
    validatedCount: 4,
    conditions: ['auth', 'jwt'],
    createdFrom: 'evolution-abstraction',
  };

  const matching = _computeEffectiveScore(point, baseData, 'code', 'repo-a', 'fix auth jwt middleware');
  const missing = _computeEffectiveScore(point, baseData, 'code', 'repo-a', 'update css layout');

  assert.ok(matching > missing, `expected matching score > missing score, got ${matching} <= ${missing}`);
});
