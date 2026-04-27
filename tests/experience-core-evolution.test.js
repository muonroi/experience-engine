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
const {
  evolve,
  _recordHitUpdatesFields: applyHitUpdate,
  _buildStorePayload: buildStorePayload,
  _applyHoldoutOutcome: applyHoldoutOutcome,
  _formatPoints: formatPoints,
  _selectProbationaryT2Points: selectProbationaryT2Points,
  _isProbationaryT2Candidate: isProbationaryT2Candidate,
  _reconcileStalePromptSuggestions: reconcileStalePromptSuggestions,
} = require(CORE_PATH);

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

function makeScoredPoint(collection, id, score, data) {
  return {
    id,
    score,
    _effectiveScore: score,
    _collection: collection,
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

test('fresh high-scoring T2 can surface as one probationary suggestion without becoming high confidence', () => {
  const freshT2 = makeScoredPoint('experience-selfqa', 'fresh-t2', 0.92, {
    trigger: 'prompt-time hook guidance',
    question: 'fast path misses relevant prompt guidance',
    solution: 'Surface one high-score fresh T2 as probationary so it can receive feedback.',
    confidence: 0.5,
    hitCount: 0,
    validatedCount: 0,
    surfaceCount: 0,
    signalVersion: 2,
    tier: 2,
  });
  const secondFreshT2 = makeScoredPoint('experience-selfqa', 'fresh-t2-second', 0.91, {
    trigger: 'second prompt-time hook guidance',
    question: 'second fresh hint',
    solution: 'Do not surface more than one probationary T2 in a single intercept.',
    confidence: 0.5,
    hitCount: 0,
    validatedCount: 0,
    surfaceCount: 0,
    signalVersion: 2,
    tier: 2,
  });

  const selected = selectProbationaryT2Points([freshT2, secondFreshT2]);
  assert.equal(isProbationaryT2Candidate(freshT2), true);
  assert.equal(selected.filter(point => point._probationaryT2).length, 1);

  const lines = formatPoints(selected);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Probationary Suggestion/);
  assert.doesNotMatch(lines[0], /Experience - High Confidence/);
  assert.match(lines[0], /\[id:fresh-t2 col:experience-selfqa\]/);
});

test('probationary T2 does not surface after surface limit, debt, or low raw score', () => {
  const base = {
    trigger: 'prompt-time hook guidance',
    question: 'fresh hint',
    solution: 'Only fresh high-score T2 entries with clean debt can surface probationarily.',
    confidence: 0.5,
    hitCount: 0,
    validatedCount: 0,
    surfaceCount: 0,
    signalVersion: 2,
    tier: 2,
  };

  const overLimit = makeScoredPoint('experience-selfqa', 'over-limit', 0.92, { ...base, surfaceCount: 2 });
  const ignored = makeScoredPoint('experience-selfqa', 'ignored', 0.92, { ...base, ignoreCount: 1 });
  const irrelevant = makeScoredPoint('experience-selfqa', 'irrelevant', 0.92, { ...base, irrelevantCount: 1 });
  const lowScore = makeScoredPoint('experience-selfqa', 'low-score', 0.77, base);

  for (const point of [overLimit, ignored, irrelevant, lowScore]) {
    assert.equal(isProbationaryT2Candidate(point), false, `${point.id} should not be probationary`);
  }
  assert.equal(formatPoints(selectProbationaryT2Points([overLimit, ignored, irrelevant, lowScore])).length, 0);
});

test('T1 and T0 keep normal confidence filtering and high-confidence formatting', () => {
  const lowConfidenceT1 = makeScoredPoint('experience-behavioral', 'low-t1', 0.95, {
    solution: 'Low-confidence T1 should not bypass the normal confidence floor.',
    confidence: 0.5,
    hitCount: 0,
    tier: 1,
  });
  const highConfidenceT0 = makeScoredPoint('experience-principles', 'high-t0', 0.9, {
    solution: 'High-confidence T0 still formats as a high-confidence warning.',
    confidence: 0.9,
    hitCount: 2,
    tier: 0,
  });

  assert.equal(formatPoints([lowConfidenceT1]).length, 0);
  const lines = formatPoints([highConfidenceT0]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Experience - High Confidence/);
  assert.doesNotMatch(lines[0], /Probationary Suggestion/);
});

test('stale prompt-only state increments unused without validated signal', async () => {
  resetStore([
    makeEntry('prompt-unused', {
      trigger: 'prompt-time hook guidance',
      question: 'prompt hint was not acted on',
      solution: 'Only keep prompt hints that lead to later action.',
      confidence: 0.5,
      hitCount: 0,
      validatedCount: 0,
      unusedCount: 0,
      irrelevantCount: 0,
      tier: 2,
    }),
  ]);

  const result = await reconcileStalePromptSuggestions({
    ts: new Date(Date.now() - 11_000).toISOString(),
    tool: 'UserPrompt',
    sourceHook: 'UserPromptSubmit',
    surfacedIds: [{ collection: 'experience-selfqa', id: 'prompt-unused' }],
    prompt: 'previous prompt',
    cwd: '/mnt/d/Personal/Core/experience-engine',
  }, {
    prompt: 'continue implementing the current task',
    cwd: '/mnt/d/Personal/Core/experience-engine',
    sourceKind: 'codex-hook',
    sourceRuntime: 'codex-wsl',
    sourceSession: 'prompt-unused-test',
  });

  assert.equal(result.unused.length, 1);
  assert.equal(result.irrelevant.length, 0);
  const stored = JSON.parse(readCollection('experience-selfqa')[0].payload.json);
  assert.equal(stored.unusedCount, 1);
  assert.equal(stored.validatedCount, 0);
});

test('stale prompt-only state records wrong_task as irrelevant reason when clear', async () => {
  resetStore([
    makeEntry('prompt-wrong-task', {
      trigger: 'when editing TypeScript component behavior',
      question: 'component implementation hint on docs task',
      solution: 'Use the component test harness before changing TypeScript behavior.',
      confidence: 0.5,
      hitCount: 0,
      validatedCount: 0,
      unusedCount: 0,
      irrelevantCount: 0,
      scope: { lang: 'typescript' },
      domain: 'typescript',
      tier: 2,
    }),
  ]);

  const result = await reconcileStalePromptSuggestions({
    ts: new Date(Date.now() - 11_000).toISOString(),
    tool: 'UserPrompt',
    sourceHook: 'UserPromptSubmit',
    surfacedIds: [{ collection: 'experience-selfqa', id: 'prompt-wrong-task', scope: { lang: 'typescript' }, domain: 'typescript' }],
    prompt: 'previous prompt',
    cwd: '/mnt/d/Personal/Core/experience-engine',
  }, {
    prompt: 'update README.md documentation only',
    cwd: '/mnt/d/Personal/Core/experience-engine',
    sourceKind: 'codex-hook',
    sourceRuntime: 'codex-wsl',
    sourceSession: 'prompt-wrong-task-test',
  });

  assert.equal(result.unused.length, 1);
  assert.equal(result.irrelevant.length, 1);
  assert.equal(result.irrelevant[0].reason, 'wrong_task');
  const stored = JSON.parse(readCollection('experience-selfqa')[0].payload.json);
  assert.equal(stored.unusedCount, 1);
  assert.equal(stored.irrelevantCount, 1);
  assert.equal(stored.noiseReasonCounts?.wrong_task, 1);
  assert.equal(stored.validatedCount, 0);
});

test('validated touch update still increments validatedCount', () => {
  const data = {
    hitCount: 0,
    validatedCount: 0,
    unusedCount: 1,
    confirmedAt: [],
  };

  applyHitUpdate(data);

  assert.equal(data.validatedCount, 1);
  assert.equal(data.hitCount, 1);
  assert.equal(data.unusedCount, 0);
  assert.equal(data.confirmedAt.length, 1);
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
  assert.ok(promoted.failureMode, 'promoted T1 should carry a failure mode');
  assert.ok(promoted.judgment, 'promoted T1 should carry a judgment');
  assert.ok(Array.isArray(promoted.conditions) && promoted.conditions.length > 0, 'promoted T1 should carry conditions');
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

test('evolve fast-promotes fresh organic T2 after repeated distinct session confirmations', async () => {
  resetStore([
    makeEntry('fresh-organic-dogfood', {
      trigger: 'when a repeated fix/test loop keeps hitting the same failure',
      question: 'retrying the same failing path without changing the cause',
      solution: 'pause and inspect the failure before rerunning so the next action changes the state',
      createdAt: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
      createdFrom: 'session-extractor',
      confidence: 0.5,
      hitCount: 2,
      validatedCount: 2,
      confirmedAt: ['2026-04-22T10:00:00Z', '2026-04-22T10:05:00Z'],
      confirmedSessions: ['dogfood-1', 'dogfood-2'],
    }),
  ]);

  const results = await evolve('dogfood');
  assert.equal(results.promoted, 1, 'distinct session confirmations should bypass the stale age gate for fresh organic entries');

  const selfqa = readCollection('experience-selfqa');
  const t1 = readCollection('experience-behavioral');
  assert.equal(selfqa.length, 0);
  assert.equal(t1.length, 1);

  const promoted = JSON.parse(t1[0].payload.json);
  assert.equal(promoted.promotedVia, 'dogfood-confirmation');
  assert.deepEqual(promoted.confirmedSessions, ['dogfood-1', 'dogfood-2']);
});

test('dogfood-confirmed organic behavioral entries can promote to principle with repeated session evidence', async () => {
  writeCollection('experience-selfqa', []);
  writeCollection('experience-principles', []);
  writeCollection('experience-edges', []);
  writeCollection('experience-behavioral', [
    makeEntry('dogfood-principle', {
      trigger: 'when the same failure repeats after a no-op rerun',
      question: 'rerun loop hides the real cause',
      solution: 'inspect the failure and change code, fixture, or command inputs before rerunning',
      createdAt: new Date(Date.now() - (6 * 60 * 60 * 1000)).toISOString(),
      createdFrom: 'session-extractor',
      tier: 1,
      confidence: 0.5,
      hitCount: 0,
      validatedCount: 0,
      confirmedAt: [],
      confirmedSessions: [],
    }),
  ]);

  const entries = readCollection('experience-behavioral');
  const data = JSON.parse(entries[0].payload.json);
  for (const sessionId of ['dogfood-a', 'dogfood-b', 'dogfood-c', 'dogfood-d']) {
    applyHitUpdate(data);
    data.confirmedSessions.push(sessionId);
  }
  writeCollection('experience-behavioral', [makeEntry('dogfood-principle', data)]);

  const results = await evolve('dogfood');
  assert.equal(results.promoted, 1, 'repeated dogfood-confirmed organic behavioral entries should promote to principle');

  const t1 = readCollection('experience-behavioral');
  const t0 = readCollection('experience-principles');
  assert.equal(t1.length, 0);
  assert.equal(t0.length, 1);

  const principle = JSON.parse(t0[0].payload.json);
  assert.equal(principle.tier, 0);
  assert.match(principle.principle, /\bwhen\b/i, 'promoted principle should be normalized into principle text');
  assert.ok(principle.failureMode, 'promoted principle should carry a failure mode');
  assert.ok(principle.judgment, 'promoted principle should carry a judgment');
  assert.ok(principle.novelCaseEvidence, 'promoted principle should keep novel-case evidence structure');
});

test('buildStorePayload seeds abstraction fields and empty novel-case evidence for T2 entries', () => {
  const payload = buildStorePayload('seed-1', {
    trigger: 'retry test failing with a 500 error',
    question: 'stale mock state causes the second request to fail',
    solution: 'reset the stale mock state before the second request',
    why: 'the test reused stale mock state across requests',
    conditions: ['retry', 'mock state'],
    evidenceClass: 'test',
  }, 'JavaScript', 'experience-engine');

  assert.equal(payload.failureMode, 'the test reused stale mock state across requests');
  assert.equal(payload.judgment, 'reset the stale mock state before the second request');
  assert.equal(payload.conditions.includes('retry'), true);
  assert.equal(payload.conditions.includes('mock state'), true);
  assert.equal(payload.evidenceClass, 'test');
  assert.equal(payload.provenance.kind, 'seed');
  assert.equal(payload.novelCaseEvidence.seedSupportCount, 1);
  assert.equal(payload.novelCaseEvidence.holdoutMatchedCount, 0);
});

test('applyHoldoutOutcome tracks tested and matched holdout evidence without double counting the same key', () => {
  const data = {
    principle: 'When rerun loops hide the cause, inspect and change state first',
    tier: 0,
    novelCaseEvidence: {
      seedSupportCount: 3,
      seedEntryIds: ['seed-1', 'seed-2', 'seed-3'],
      holdoutMatchedCount: 0,
      holdoutTestedCount: 0,
      holdoutSessions: [],
      holdoutProjects: [],
    },
  };

  applyHoldoutOutcome(data, {
    holdoutKey: 'suite-1:holdout-1',
    matched: false,
    projectSlug: 'experience-engine',
    sourceSession: 'holdout:suite-1:holdout-1',
  });
  applyHoldoutOutcome(data, {
    holdoutKey: 'suite-1:holdout-1',
    matched: true,
    projectSlug: 'experience-engine',
    sourceSession: 'holdout:suite-1:holdout-1',
  });
  applyHoldoutOutcome(data, {
    holdoutKey: 'suite-1:holdout-2',
    matched: true,
    projectSlug: 'muonroi-control-plane',
    sourceSession: 'holdout:suite-1:holdout-2',
  });

  assert.equal(data.novelCaseEvidence.holdoutTestedCount, 2);
  assert.equal(data.novelCaseEvidence.holdoutMatchedCount, 2);
  assert.deepEqual(data.novelCaseEvidence.holdoutProjects, ['experience-engine', 'muonroi-control-plane']);
  assert.deepEqual(data.novelCaseEvidence.holdoutMatchedKeys, ['suite-1:holdout-1', 'suite-1:holdout-2']);
});
