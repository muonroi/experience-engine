#!/usr/bin/env node
'use strict';

/**
 * dashboard-aggregators.test.js — topOffenders seed exclusion + createdFrom capture.
 *
 * Seeds (imported memory / evolution-abstraction) surface broadly as orienting
 * context and almost never convert to a FOLLOWED hit, so their ignoreRatio sits
 * at ~1.0 and they pin to the top of the ignoreRatio-sorted offenders list. That
 * is a diagnostic false positive: an "offender" is an ORGANIC entry that surfaces
 * and gets rejected, not a seed doing its context job. These tests lock in that
 * indexQdrantPoints carries createdFrom and computeTopOffenders drops seeds while
 * keeping genuinely-noisy organic entries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { indexQdrantPoints, computeTopOffenders } = require('../tools/dashboard/aggregators.js');

const pt = (id, json) => ({ id, payload: { json: JSON.stringify(json) } });

test('indexQdrantPoints captures createdFrom (null when absent)', () => {
  const payloads = new Map([['experience-selfqa', [
    pt('11111111-aaaa-bbbb-cccc-000000000001', { createdFrom: 'seed-memory-import', hitCount: 0, ignoreCount: 9 }),
    pt('22222222-aaaa-bbbb-cccc-000000000002', { hitCount: 1, ignoreCount: 2 }),
  ]]]);
  const idx = indexQdrantPoints(payloads);
  assert.equal(idx.get('11111111-aaaa-bbbb-cccc-000000000001').createdFrom, 'seed-memory-import');
  assert.equal(idx.get('22222222-aaaa-bbbb-cccc-000000000002').createdFrom, null);
});

test('computeTopOffenders excludes seeds but keeps organic high-ignore entries', () => {
  const mk = (id, createdFrom, hitCount, ignoreCount) => [id, {
    id, collection: 'experience-selfqa', tier: 2, confidence: 0.7,
    hitCount, ignoreCount, createdFrom, framework: null, lang: null,
    principle: 'x', noiseHistory: [],
  }];
  const idx = new Map([
    mk('seedA', 'seed-memory-import', 0, 800),    // seed: ignoreRatio 1.0 — excluded by design
    mk('evoB', 'evolution-abstraction', 0, 500),  // abstraction seed — excluded
    mk('orgC', 'extract', 0, 40),                 // organic non-converter, ratio 1.0 — included
    mk('orgD', null, 5, 10),                       // organic with some hits — included
    mk('smallE', 'extract', 0, 2),                 // below minSurface(5) — excluded by floor
  ]);

  const top = computeTopOffenders(idx, { minSurfaceCount: 5, limit: 20 });
  const ids = top.map(o => o.id);

  assert.ok(!ids.includes('seedA'), 'seed-memory-import must be excluded');
  assert.ok(!ids.includes('evoB'), 'evolution-abstraction must be excluded');
  assert.ok(ids.includes('orgC'), 'organic non-converter must be included');
  assert.ok(ids.includes('orgD'), 'organic with partial hits must be included');
  assert.ok(!ids.includes('smallE'), 'below-minSurface must be excluded');
  // ignoreRatio-desc sort: organic non-converter (1.0) ranks above partial-hit (0.67)
  assert.equal(top[0].id, 'orgC');
});
