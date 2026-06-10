#!/usr/bin/env node
'use strict';

/**
 * profile-model.test.js — signal aggregation + poisoning defenses + YAML round-trip
 * (.experience/src/profile-model.js). Pure logic; loadProfile/saveProfile over a tmp file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pm = require('../.experience/src/profile-model.js');

const sig = (dimension, value, n = 1) => Array.from({ length: n }, () => ({ dimension, value, weight: 1, evidence: `${value} ev` }));

test('aggregateProfile: below minSamples → value pending (null)', () => {
  const p = pm.aggregateProfile(pm.emptyProfile(), sig('communication.question_style', 'directive', 9));
  const d = p.dimensions['communication.question_style'];
  assert.equal(d.value, null);
  assert.equal(d.sampleCount, 9);
});

test('aggregateProfile: at minSamples consistent → value committed with confidence', () => {
  const p = pm.aggregateProfile(pm.emptyProfile(), sig('communication.question_style', 'directive', 10));
  const d = p.dimensions['communication.question_style'];
  assert.equal(d.value, 'directive');
  assert.equal(d.confidence, 1); // 10/10
});

test('aggregateProfile: cumulative counts dwarf a 5-vote poisoning burst', () => {
  let p = pm.aggregateProfile(pm.emptyProfile(), sig('personality.decision_speed', 'fast-intuitive', 50));
  p = pm.aggregateProfile(p, sig('personality.decision_speed', 'deliberate', 5));
  const d = p.dimensions['personality.decision_speed'];
  assert.equal(d.value, 'fast-intuitive');
  assert.equal(d.distribution['deliberate'], 5);
  assert.ok(d.confidence > 0.9); // 50/55
});

test('aggregateProfile: confidence decay applied when committed value flips', () => {
  let p = pm.aggregateProfile(pm.emptyProfile(), sig('personality.conflict_style', 'cautious', 10));
  assert.equal(p.dimensions['personality.conflict_style'].value, 'cautious');
  // add enough of a new value to flip the winner
  p = pm.aggregateProfile(p, sig('personality.conflict_style', 'direct-constructive', 11));
  const d = p.dimensions['personality.conflict_style'];
  assert.equal(d.value, 'direct-constructive');
  const rawConf = 11 / 21;
  assert.ok(d.confidence < rawConf, `shift decay should lower confidence (${d.confidence} < ${rawConf})`);
});

test('aggregateProfile: does not mutate the input profile', () => {
  const base = pm.aggregateProfile(pm.emptyProfile(), sig('work_patterns.energy', 'night-owl', 10));
  const snapshot = JSON.stringify(base);
  pm.aggregateProfile(base, sig('work_patterns.energy', 'daytime', 5));
  assert.equal(JSON.stringify(base), snapshot);
});

test('serialize → parse round-trip preserves value/confidence/samples/distribution', () => {
  let p = pm.aggregateProfile(pm.emptyProfile(), sig('communication.question_style', 'directive', 12), { now: Date.parse('2026-06-10T10:00:00Z') });
  p = pm.aggregateProfile(p, sig('communication.question_style', 'debugging', 3));
  const yaml = pm.serializeProfile(p);
  const parsed = pm.parseProfile(yaml);
  const a = p.dimensions['communication.question_style'];
  const b = parsed.dimensions['communication.question_style'];
  assert.equal(b.value, a.value);
  assert.equal(b.confidence, a.confidence);
  assert.equal(b.sampleCount, a.sampleCount);
  assert.deepEqual(b.distribution, a.distribution);
  assert.equal(parsed.updatedAt, '2026-06-10T10:00:00.000Z');
});

test('saveProfile / loadProfile round-trip over a tmp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const file = path.join(dir, 'profile.yaml');
  try {
    const p = pm.aggregateProfile(pm.emptyProfile(), sig('personality.decision_speed', 'fast-intuitive', 15));
    assert.equal(pm.saveProfile(p, file), true);
    const loaded = pm.loadProfile(file);
    assert.equal(loaded.dimensions['personality.decision_speed'].value, 'fast-intuitive');
    assert.equal(loaded.dimensions['personality.decision_speed'].sampleCount, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProfile: missing file → empty profile (no throw)', () => {
  const loaded = pm.loadProfile(path.join(os.tmpdir(), 'definitely-missing-profile-xyz.yaml'));
  assert.deepEqual(loaded, pm.emptyProfile());
});
