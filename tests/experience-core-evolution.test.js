#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-evolve-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.EXPERIENCE_QDRANT_URL = 'http://127.0.0.1:1';

const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
delete require.cache[require.resolve(CORE_PATH)];
const { evolve } = require(CORE_PATH);

const STORE_DIR = path.join(TEST_HOME, '.experience', 'store', process.env.EXP_USER || 'default');

function writeCollection(name, entries) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORE_DIR, `${name}.json`), JSON.stringify(entries, null, 2));
}

function readCollection(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STORE_DIR, `${name}.json`), 'utf8'));
  } catch {
    return [];
  }
}

function makeEntry(id, data) {
  return {
    id,
    vector: [0.2, 0.4, 0.6],
    payload: { json: JSON.stringify({ id, ...data }) },
  };
}

function resetStore(selfqaEntries) {
  writeCollection('experience-selfqa', selfqaEntries);
  writeCollection('experience-behavioral', []);
  writeCollection('experience-principles', []);
  writeCollection('experience-edges', []);
}

test.after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

test('evolve promotes validated T2 entries and clears stale demotion debt', async () => {
  resetStore([
    makeEntry('validated-t2', {
      trigger: 'Running the same failing test loop without changing code',
      question: 'test retry loop hides root cause',
      solution: 'Inspect the failure and change the code or fixture before rerunning the same test.',
      createdAt: '2026-04-08T00:00:00Z',
      createdFrom: 'session-extractor',
      confidence: 0.1,
      hitCount: 3,
      validatedCount: 3,
      ignoreCount: 7,
      irrelevantCount: 2,
      unusedCount: 1,
      confirmedAt: ['2026-04-09T00:00:00Z', '2026-04-10T00:00:00Z', '2026-04-11T00:00:00Z'],
    }),
  ]);

  const results = await evolve('test');
  assert.equal(results.promoted, 1);
  assert.equal(results.demoted, 0, 'freshly promoted validated entries should not demote in the same pass');

  const selfqa = readCollection('experience-selfqa');
  const t1 = readCollection('experience-behavioral');
  assert.equal(selfqa.length, 0, 'promoted entry should leave T2');
  assert.equal(t1.length, 1, 'promoted entry should appear in T1');

  const promoted = JSON.parse(t1[0].payload.json);
  assert.equal(promoted.tier, 1);
  assert.equal(promoted.hitCount, 3);
  assert.equal(promoted.validatedCount, 3);
  assert.equal(promoted.ignoreCount, 0);
  assert.equal(promoted.irrelevantCount, 0);
  assert.equal(promoted.unusedCount, 0);
  assert.ok(promoted.confidence >= 0.6, 'promotion should start T1 with a usable probation confidence floor');
});

test('evolve ignores legacy surfaced hitCount without validated evidence', async () => {
  resetStore([
    makeEntry('legacy-surfaced', {
      trigger: 'Legacy bulk seed surfaced many times',
      question: 'legacy surfacing inflated hits',
      solution: 'Do not treat pre-fix surfaced counts as validated promotion evidence.',
      createdAt: '2026-04-08T00:00:00Z',
      createdFrom: 'bulk-seed',
      confidence: 0.95,
      hitCount: 120,
      ignoreCount: 0,
      confirmedAt: [],
    }),
  ]);

  const results = await evolve('test');
  assert.equal(results.promoted, 0, 'legacy surfaced counts should not promote into T1');

  const selfqa = readCollection('experience-selfqa');
  const t1 = readCollection('experience-behavioral');
  assert.equal(selfqa.length, 1, 'legacy entry should remain in T2');
  assert.equal(t1.length, 0, 'no T1 entry should be created from legacy surfaced-only signal');
});
