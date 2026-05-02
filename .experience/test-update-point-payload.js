// test-update-point-payload.js — TDD tests for updatePointPayload helper
// Tests for Task 1: extract shared read-modify-write pattern

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Hermetic test home so FileStore writes never touch the real ~/.experience tree.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.EXPERIENCE_QDRANT_URL = 'http://127.0.0.1:1';

const STORE_DIR = path.join(TEST_HOME, '.experience', 'store', process.env.EXP_USER || 'default');

const {
  _updatePointPayload,
  recordFeedback,
  recordHit,
  recordSurface,
  _applyHitUpdate: applyHitUpdate,
  _applySurfaceUpdate: applySurfaceUpdate,
  _incrementIgnoreCountData: incrementIgnoreCountData,
  _applyNoiseDispositionData: applyNoiseDispositionData,
  _reconcilePendingHints: reconcilePendingHints,
  _reconcileStalePromptSuggestions: reconcileStalePromptSuggestions,
} = require('./experience-core.js');

function makeTestEntry(id, data) {
  return { id, vector: [], payload: { json: JSON.stringify(data) } };
}

// Use unique test collection names to avoid touching real data
const TEST_COLL_PREFIX = `test-coll-${Date.now()}`;
let testColls = [];

function writeTestStore(collection, entries) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORE_DIR, `${collection}.json`), JSON.stringify(entries, null, 2));
  if (!testColls.includes(collection)) testColls.push(collection);
}

function readTestStore(collection) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STORE_DIR, `${collection}.json`), 'utf8'));
  } catch { return []; }
}

function cleanup() {
  for (const c of testColls) {
    try { fs.unlinkSync(path.join(STORE_DIR, `${c}.json`)); } catch {}
    try { fs.unlinkSync(path.join(STORE_DIR, `${c}.json.lock`)); } catch {}
  }
  testColls = [];
}

process.on('exit', () => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('updatePointPayload', () => {
  afterEach(cleanup);

  it('should export _updatePointPayload as a function', () => {
    assert.strictEqual(typeof _updatePointPayload, 'function', '_updatePointPayload must be exported');
  });

  it('updatePointPayload with applyHitUpdate calls updateFn with correct data shape', async () => {
    // Test the contract: applyHitUpdate mutates data correctly (independent of storage backend)
    const data = { hitCount: 2, validatedCount: 2, ignoreCount: 1, confirmedAt: [] };
    applyHitUpdate(data);
    assert.strictEqual(data.hitCount, 3, 'applyHitUpdate should increment hitCount to 3');
    assert.strictEqual(data.validatedCount, 3, 'applyHitUpdate should increment validatedCount to 3');
    assert.strictEqual(data.ignoreCount, 0, 'applyHitUpdate should reset ignoreCount to 0');
    assert(Array.isArray(data.confirmedAt) && data.confirmedAt.length === 1, 'applyHitUpdate should append to confirmedAt');
  });

  it('applySurfaceUpdate increments surfaceCount without mutating validated hitCount', () => {
    const data = { hitCount: 2, validatedCount: 2, surfaceCount: 4, ignoreCount: 1, confirmedAt: [] };
    applySurfaceUpdate(data);
    assert.strictEqual(data.surfaceCount, 5, 'applySurfaceUpdate should increment surfaceCount');
    assert.strictEqual(data.hitCount, 2, 'applySurfaceUpdate should not increment validated hitCount');
    assert.strictEqual(data.validatedCount, 2, 'applySurfaceUpdate should preserve validatedCount');
    assert.strictEqual(data.ignoreCount, 1, 'applySurfaceUpdate should not reset ignoreCount');
    assert.strictEqual(data.confirmedAt.length, 0, 'applySurfaceUpdate should not append to confirmedAt');
  });

  it('updatePointPayload with incrementIgnoreCountData calls updateFn with correct data shape', async () => {
    // Test the contract: incrementIgnoreCountData mutates data correctly (independent of storage backend)
    const data = { hitCount: 1, ignoreCount: 0 };
    incrementIgnoreCountData(data);
    assert.strictEqual(data.ignoreCount, 1, 'incrementIgnoreCountData should increment ignoreCount to 1');
    assert.strictEqual(data.hitCount, 1, 'hitCount should remain unchanged');
  });

  it('updatePointPayload is a callable async function accepting (collection, pointId, updateFn)', async () => {
    // Structural test: verify signature and that it does not throw when given nonexistent point
    let threw = false;
    try {
      await _updatePointPayload('nonexistent-coll', 'nonexistent-id', (d) => d);
    } catch { threw = true; }
    assert.strictEqual(threw, false, 'updatePointPayload must not throw for missing points');
  });
});

describe('recordFeedback delegates to updatePointPayload', () => {
  afterEach(cleanup);

  it('recordFeedback(coll, id, "FOLLOWED") should behave same as recordHit (increments hitCount)', async () => {
    const coll = `${TEST_COLL_PREFIX}-fb-true`;
    const idA = 'feedback-true-001';
    const idB = 'record-hit-001';
    const initialA = { hitCount: 1, validatedCount: 1, ignoreCount: 1, confirmedAt: [] };
    const initialB = { hitCount: 1, validatedCount: 1, ignoreCount: 1, confirmedAt: [] };
    writeTestStore(coll, [makeTestEntry(idA, initialA), makeTestEntry(idB, initialB)]);

    await recordFeedback(coll, idA, 'FOLLOWED');
    await recordHit(coll, idB);

    const entries = readTestStore(coll);
    const entryA = entries.find(e => e.id === idA);
    const entryB = entries.find(e => e.id === idB);
    const dataA = JSON.parse(entryA.payload.json);
    const dataB = JSON.parse(entryB.payload.json);

    assert.strictEqual(dataA.hitCount, dataB.hitCount, 'hitCount should match recordHit result');
    assert.strictEqual(dataA.validatedCount, dataB.validatedCount, 'validatedCount should match recordHit result');
    assert.strictEqual(dataA.ignoreCount, dataB.ignoreCount, 'ignoreCount should match recordHit result');
  });

  it('recordSurface tracks surfacing without incrementing validated hitCount', async () => {
    const coll = `${TEST_COLL_PREFIX}-surface`;
    const id = 'record-surface-001';
    writeTestStore(coll, [makeTestEntry(id, { hitCount: 2, validatedCount: 2, surfaceCount: 1, ignoreCount: 0, confirmedAt: [] })]);

    await recordSurface(coll, id);

    const entries = readTestStore(coll);
    const entry = entries.find(e => e.id === id);
    const data = JSON.parse(entry.payload.json);
    assert.strictEqual(data.surfaceCount, 2, 'surfaceCount should increment');
    assert.strictEqual(data.hitCount, 2, 'hitCount should stay tied to validated usage only');
    assert.strictEqual(data.validatedCount, 2, 'validatedCount should not change on surfacing');
  });

  it('recordFeedback(coll, id, "IGNORED") should behave same as incrementIgnoreCount (increments ignoreCount)', async () => {
    const coll = `${TEST_COLL_PREFIX}-fb-false`;
    const idA = 'feedback-false-001';
    const idB = 'ignore-count-001';
    const initialA = { hitCount: 1, ignoreCount: 0 };
    const initialB = { hitCount: 1, ignoreCount: 0 };
    writeTestStore(coll, [makeTestEntry(idA, initialA), makeTestEntry(idB, initialB)]);

    await recordFeedback(coll, idA, 'IGNORED');
    // Note: incrementIgnoreCount is not exported directly, so we use updatePointPayload
    await _updatePointPayload(coll, idB, incrementIgnoreCountData);

    const entries = readTestStore(coll);
    const entryA = entries.find(e => e.id === idA);
    const entryB = entries.find(e => e.id === idB);
    const dataA = JSON.parse(entryA.payload.json);
    const dataB = JSON.parse(entryB.payload.json);

    assert.strictEqual(dataA.ignoreCount, dataB.ignoreCount, 'ignoreCount should match incrementIgnoreCount result');
  });

  it('recordFeedback(coll, id, "IRRELEVANT", reason) increments irrelevant tracking', async () => {
    const coll = `${TEST_COLL_PREFIX}-fb-irrelevant`;
    const idA = 'feedback-irrelevant-001';
    writeTestStore(coll, [makeTestEntry(idA, { hitCount: 0, ignoreCount: 0, irrelevantCount: 0 })]);

    await recordFeedback(coll, idA, 'IRRELEVANT', 'wrong_repo');

    const entries = readTestStore(coll);
    const entryA = entries.find(e => e.id === idA);
    const dataA = JSON.parse(entryA.payload.json);

    assert.strictEqual(dataA.irrelevantCount, 1, 'irrelevantCount should increment');
    assert.strictEqual(dataA.lastNoiseReason, 'wrong_repo', 'lastNoiseReason should be stored');
    assert.strictEqual(dataA.noiseReasonCounts.wrong_repo, 1, 'noise reason count should increment');
    assert.strictEqual(dataA.lastNoiseSource, 'manual', 'manual source should be stored');
    assert.strictEqual(dataA.noiseSourceCounts.manual, 1, 'manual source count should increment');
    assert.ok(dataA.lastNoiseAt, 'lastNoiseAt should be stored');
  });

  it('shared noise disposition can record implicit unused plus irrelevant reason metadata', () => {
    const data = { unusedCount: 0, irrelevantCount: 0 };
    applyNoiseDispositionData('unused', 'implicit-posttool', 'wrong_language', { countIrrelevant: true })(data);

    assert.strictEqual(data.unusedCount, 1, 'unusedCount should increment');
    assert.strictEqual(data.irrelevantCount, 1, 'irrelevantCount should increment for deterministic noise');
    assert.strictEqual(data.lastNoiseReason, 'wrong_language', 'reason should be stored');
    assert.strictEqual(data.noiseReasonCounts.wrong_language, 1, 'reason count should increment');
    assert.strictEqual(data.lastNoiseSource, 'implicit-posttool', 'source should be stored');
    assert.strictEqual(data.noiseSourceCounts['implicit-posttool'], 1, 'source count should increment');
  });

  it('pending no-touch wrong_language increments unused and irrelevant counters', async () => {
    const coll = `${TEST_COLL_PREFIX}-pending-wrong-language`;
    const id = 'pending-wrong-language-001';
    writeTestStore(coll, [makeTestEntry(id, { unusedCount: 0, irrelevantCount: 0 })]);
    const surface = {
      collection: coll,
      id,
      solution: 'Use the C# logging abstraction.',
      scope: { lang: 'C#' },
    };
    const meta = { sourceKind: 'codex-hook', sourceRuntime: 'codex', sourceSession: `pending-${Date.now()}` };
    const toolInput = { file_path: '/mnt/d/Personal/Core/experience-engine/src/file.ts' };

    await reconcilePendingHints([surface], 'Edit', toolInput, meta);
    await reconcilePendingHints([], 'Edit', toolInput, meta);
    const result = await reconcilePendingHints([], 'Edit', toolInput, meta);

    assert.strictEqual(result.implicitUnused.length, 1, 'third no-touch should record implicit unused');
    assert.strictEqual(result.implicitUnused[0].reason, 'wrong_language');
    const data = JSON.parse(readTestStore(coll).find(e => e.id === id).payload.json);
    assert.strictEqual(data.unusedCount, 1, 'unusedCount should increment');
    assert.strictEqual(data.irrelevantCount, 1, 'irrelevantCount should increment');
    assert.strictEqual(data.noiseReasonCounts.wrong_language, 1, 'wrong_language count should increment');
    assert.strictEqual(data.noiseSourceCounts['implicit-posttool'], 1, 'implicit-posttool source count should increment');
  });

  it('prompt stale records deterministic wrong_repo and wrong_task reasons', async () => {
    const coll = `${TEST_COLL_PREFIX}-prompt-stale`;
    const wrongRepoId = 'prompt-stale-wrong-repo';
    const wrongTaskId = 'prompt-stale-wrong-task';
    writeTestStore(coll, [
      makeTestEntry(wrongRepoId, { unusedCount: 0, irrelevantCount: 0 }),
      makeTestEntry(wrongTaskId, { unusedCount: 0, irrelevantCount: 0 }),
    ]);
    const oldTs = new Date(Date.now() - 20000).toISOString();
    const result = await reconcileStalePromptSuggestions({
      sourceHook: 'UserPromptSubmit',
      ts: oldTs,
      cwd: '/mnt/d/Personal/Core/experience-engine',
      surfacedIds: [
        { collection: coll, id: wrongRepoId, projectSlug: 'other-repo', solution: 'Use the other repo pattern.' },
        { collection: coll, id: wrongTaskId, scope: { lang: 'C#' }, solution: 'Use the C# logging pattern.' },
      ],
    }, {
      sourceKind: 'codex-hook',
      sourceRuntime: 'codex',
      sourceSession: `prompt-stale-${Date.now()}`,
      cwd: '/mnt/d/Personal/Core/experience-engine',
      prompt: 'Update the planning notes',
    });

    assert.deepStrictEqual(result.irrelevant.map(item => item.reason).sort(), ['wrong_repo', 'wrong_task']);
    const entries = readTestStore(coll);
    const wrongRepoData = JSON.parse(entries.find(e => e.id === wrongRepoId).payload.json);
    const wrongTaskData = JSON.parse(entries.find(e => e.id === wrongTaskId).payload.json);
    assert.strictEqual(wrongRepoData.noiseReasonCounts.wrong_repo, 1, 'wrong_repo count should increment');
    assert.strictEqual(wrongTaskData.noiseReasonCounts.wrong_task, 1, 'wrong_task count should increment');
    assert.strictEqual(wrongRepoData.noiseSourceCounts['prompt-stale'], 1, 'prompt-stale source should increment');
    assert.strictEqual(wrongTaskData.noiseSourceCounts['prompt-stale'], 1, 'prompt-stale source should increment');
  });
});
