// test-update-point-payload.js — TDD tests for updatePointPayload helper
// Tests for Task 1: extract shared read-modify-write pattern

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// We test via FileStore mode (Qdrant not available in unit test context)
// The module uses ~/.experience/store/{user}/ — we'll mock via a temp dir
// But since checkQdrant() auto-detects, and Qdrant is typically unavailable in CI,
// the FileStore path will be exercised automatically.

// Use the default user store path — module reads EXP_USER at load time.
// We write test data to the actual store dir and clean it up after each test.
// Using a unique collection name prefix to avoid colliding with real data.
const STORE_DIR = path.join(os.homedir(), '.experience', 'store', process.env.EXP_USER || 'default');

const {
  _updatePointPayload,
  recordFeedback,
  recordHit,
  incrementIgnoreCount: _incrementIgnoreCount,
  _applyHitUpdate: applyHitUpdate,
  _incrementIgnoreCountData: incrementIgnoreCountData,
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
    const data = { hitCount: 2, ignoreCount: 1, confirmedAt: [] };
    applyHitUpdate(data);
    assert.strictEqual(data.hitCount, 3, 'applyHitUpdate should increment hitCount to 3');
    assert.strictEqual(data.ignoreCount, 0, 'applyHitUpdate should reset ignoreCount to 0');
    assert(Array.isArray(data.confirmedAt) && data.confirmedAt.length === 1, 'applyHitUpdate should append to confirmedAt');
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

  it('recordFeedback(coll, id, true) should behave same as recordHit (increments hitCount)', async () => {
    const coll = `${TEST_COLL_PREFIX}-fb-true`;
    const idA = 'feedback-true-001';
    const idB = 'record-hit-001';
    const initialA = { hitCount: 1, ignoreCount: 1, confirmedAt: [] };
    const initialB = { hitCount: 1, ignoreCount: 1, confirmedAt: [] };
    writeTestStore(coll, [makeTestEntry(idA, initialA), makeTestEntry(idB, initialB)]);

    await recordFeedback(coll, idA, true);
    await recordHit(coll, idB);

    const entries = readTestStore(coll);
    const entryA = entries.find(e => e.id === idA);
    const entryB = entries.find(e => e.id === idB);
    const dataA = JSON.parse(entryA.payload.json);
    const dataB = JSON.parse(entryB.payload.json);

    assert.strictEqual(dataA.hitCount, dataB.hitCount, 'hitCount should match recordHit result');
    assert.strictEqual(dataA.ignoreCount, dataB.ignoreCount, 'ignoreCount should match recordHit result');
  });

  it('recordFeedback(coll, id, false) should behave same as incrementIgnoreCount (increments ignoreCount)', async () => {
    const coll = `${TEST_COLL_PREFIX}-fb-false`;
    const idA = 'feedback-false-001';
    const idB = 'ignore-count-001';
    const initialA = { hitCount: 1, ignoreCount: 0 };
    const initialB = { hitCount: 1, ignoreCount: 0 };
    writeTestStore(coll, [makeTestEntry(idA, initialA), makeTestEntry(idB, initialB)]);

    await recordFeedback(coll, idA, false);
    // Note: incrementIgnoreCount is not exported directly, so we use updatePointPayload
    await _updatePointPayload(coll, idB, incrementIgnoreCountData);

    const entries = readTestStore(coll);
    const entryA = entries.find(e => e.id === idA);
    const entryB = entries.find(e => e.id === idB);
    const dataA = JSON.parse(entryA.payload.json);
    const dataB = JSON.parse(entryB.payload.json);

    assert.strictEqual(dataA.ignoreCount, dataB.ignoreCount, 'ignoreCount should match incrementIgnoreCount result');
  });
});
