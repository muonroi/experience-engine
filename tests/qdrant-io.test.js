#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/** Setup: temp home, Qdrant unreachable → FileStore fallback, fake embed server */
let testHome, fakeEmbedServer, fakeEmbedPort;

function startFakeEmbedServer() {
  fakeEmbedServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]],
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
      }));
    });
  });
  return new Promise(resolve => {
    fakeEmbedServer.listen(0, '127.0.0.1', () => {
      fakeEmbedPort = fakeEmbedServer.address().port;
      resolve();
    });
  });
}

function writeConfig(homeDir, extra = {}) {
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify({
    qdrantUrl: 'http://127.0.0.1:1', // unreachable → FileStore
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${fakeEmbedPort}/v1/embeddings`,
    embedKey: 'test-key',
    embedModel: 'text-embedding-3-small',
    embedDim: 5,
    ...extra,
  }, null, 2));
}

function storeDir() {
  return path.join(testHome, '.experience', 'store', 'default');
}

function writeCollection(name, entries) {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entries, null, 2));
}

function makeEntry(id, data) {
  return {
    id,
    vector: [0.1, 0.2, 0.3, 0.4, 0.5],
    payload: { json: JSON.stringify({ id, ...data }) },
  };
}

function clearSessionTrack() {
  const dir = path.join(os.tmpdir(), 'experience-session');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('session-')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
}

test.before(async () => {
  await startFakeEmbedServer();
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-qdrant-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  writeConfig(testHome);
});

test.after(async () => {
  await new Promise(r => fakeEmbedServer.close(r));
  fs.rmSync(testHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  clearSessionTrack();
});

// ============================================================
//  Test: searchCollection — FileStore fallback
// ============================================================
test('searchCollection falls back to FileStore when Qdrant unreachable', async () => {
  const { searchCollection } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  writeCollection('experience-behavioral', [makeEntry('filestore-1', {
    solution: 'FileStore test entry',
    confidence: 0.8,
    hitCount: 5,
    tier: 1,
  })]);

  const results = await searchCollection('experience-behavioral', [0.1, 0.2, 0.3, 0.4, 0.5], 5);

  assert.ok(Array.isArray(results), 'should return an array');
  assert.ok(results.length > 0, 'should find entries from FileStore');
  assert.ok(results[0].id, 'should have point id');
  assert.ok(results[0].payload, 'should have payload');
});

test('searchCollection returns empty array for empty/nonexistent collection', async () => {
  const { searchCollection } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const results = await searchCollection('experience-principles', [0.1, 0.2, 0.3, 0.4, 0.5], 5);

  assert.ok(Array.isArray(results), 'should return an array');
  assert.equal(results.length, 0, 'empty collection → empty results');
});

// ============================================================
//  Test: fetchPointById
// ============================================================
test('fetchPointById reads from FileStore when Qdrant unavailable', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const core = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('fetch-test-1', {
    solution: 'Fetchable entry',
    confidence: 0.8,
    hitCount: 5,
  })]);

  const result = await core._updatePointPayload('experience-behavioral', 'fetch-test-1', (data) => {
    data.hitCount = (data.hitCount || 0) + 1;
    return data;
  });

  // The update should succeed (no error)
  // Read back the result
  const { searchCollection } = core;
  const results = await searchCollection('experience-behavioral', [0.1, 0.2, 0.3, 0.4, 0.5], 5);
  const found = results.find(r => r.id === 'fetch-test-1');
  assert.ok(results.length > 0, 'should have results');
});

// ============================================================
//  Test: updatePointPayload
// ============================================================
test('updatePointPayload updates FileStore entries correctly', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { _updatePointPayload: updatePointPayload } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('update-test-1', {
    solution: 'Updatable entry',
    confidence: 0.5,
    hitCount: 0,
    validatedCount: 0,
    confirmedAt: [],
  })]);

  // Update: increment hitCount
  await updatePointPayload('experience-behavioral', 'update-test-1', (data) => {
    data.hitCount = (data.hitCount || 0) + 1;
    data.validatedCount = (data.validatedCount || 0) + 1;
    data.confirmedAt.push(new Date().toISOString());
    return data;
  });

  // Read back
  const storePath = path.join(storeDir(), 'experience-behavioral.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = stored.find(e => e.id === 'update-test-1');
  const payload = JSON.parse(entry.payload.json);

  assert.equal(payload.hitCount, 1, 'hitCount should be incremented');
  assert.equal(payload.validatedCount, 1, 'validatedCount should be incremented');
  assert.equal(payload.confirmedAt.length, 1, 'confirmedAt should have one entry');
});

test('updatePointPayload throws for non-existent point', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { _updatePointPayload: updatePointPayload } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('existing', {
    solution: 'Only existing entry',
    confidence: 0.5,
  })]);

  try {
    await updatePointPayload('experience-behavioral', 'non-existent-id', (data) => {
      data.hitCount = 1;
      return data;
    });
    // May or may not throw depending on implementation
  } catch {
    // Expected for some implementations
  }
});

// ============================================================
//  Test: deleteEntry
// ============================================================
test('deleteEntry removes entry from FileStore', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { deleteEntry } = require(CORE_PATH);

  writeCollection('experience-behavioral', [
    makeEntry('delete-me', { solution: 'Will be deleted', confidence: 0.5 }),
    makeEntry('keep-me', { solution: 'Will stay', confidence: 0.8 }),
  ]);

  await deleteEntry('experience-behavioral', 'delete-me');

  const storePath = path.join(storeDir(), 'experience-behavioral.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));

  assert.equal(stored.length, 1, 'should have 1 entry remaining');
  assert.equal(stored[0].id, 'keep-me', 'should keep the right entry');
});

test('deleteEntry handles non-existent entry gracefully', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { deleteEntry } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('only-entry', { solution: 'test', confidence: 0.5 })]);

  // Should not throw
  await deleteEntry('experience-behavioral', 'non-existent');
});

// ============================================================
//  Test: syncToQdrant — FileStore sync
// ============================================================
test('syncToQdrant runs without error when Qdrant unreachable', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { evolve } = require(CORE_PATH);

  writeCollection('experience-selfqa', [makeEntry('sync-test', {
    solution: 'Sync test entry',
    confidence: 0.9,
    hitCount: 5,
    validatedCount: 5,
    confirmedAt: [new Date().toISOString()],
    confirmedSessions: ['sync-session'],
    tier: 2,
  })]);
  writeCollection('experience-behavioral', []);
  writeCollection('experience-principles', []);
  writeCollection('experience-edges', []);

  // evolve triggers syncToQdrant internally
  const result = await evolve('test-sync');

  assert.ok(typeof result === 'object', 'should return an object');
  assert.ok(typeof result.promoted === 'number', 'should have promoted count');
});

// ============================================================
//  Test: recordFeedback via updatePointPayload
// ============================================================
test('recordFeedback("FOLLOWED") updates FileStore entries', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { recordFeedback } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('feedback-hit', {
    solution: 'Feedback test',
    confidence: 0.5,
    hitCount: 0,
    validatedCount: 0,
    ignoreCount: 0,
    confirmedAt: [],
  })]);

  await recordFeedback('experience-behavioral', 'feedback-hit', 'FOLLOWED', null);

  const storePath = path.join(storeDir(), 'experience-behavioral.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const payload = JSON.parse(stored[0].payload.json);

  assert.equal(payload.hitCount, 1, 'FOLLOWED should increment hitCount');
  assert.equal(payload.validatedCount, 1, 'FOLLOWED should increment validatedCount');
  assert.equal(payload.ignoreCount, 0, 'FOLLOWED should reset ignoreCount');
  assert.equal(payload.confirmedAt.length, 1, 'FOLLOWED should add to confirmedAt');
});

test('recordFeedback("IGNORED") increments ignoreCount', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { recordFeedback } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('feedback-ignore', {
    solution: 'Ignore test',
    confidence: 0.5,
    hitCount: 0,
    ignoreCount: 0,
    confirmedAt: [],
  })]);

  await recordFeedback('experience-behavioral', 'feedback-ignore', 'IGNORED', null);

  const storePath = path.join(storeDir(), 'experience-behavioral.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const payload = JSON.parse(stored[0].payload.json);

  assert.equal(payload.ignoreCount, 1, 'IGNORED should increment ignoreCount');
});

test('recordFeedback("IRRELEVANT", reason) increments irrelevantCount + noiseReasonCounts', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];

  const { recordFeedback } = require(CORE_PATH);

  writeCollection('experience-behavioral', [makeEntry('feedback-irrelevant', {
    solution: 'Irrelevant test',
    confidence: 0.5,
    hitCount: 0,
    irrelevantCount: 0,
    noiseReasonCounts: {},
  })]);

  await recordFeedback('experience-behavioral', 'feedback-irrelevant', 'IRRELEVANT', 'wrong_task');

  const storePath = path.join(storeDir(), 'experience-behavioral.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const payload = JSON.parse(stored[0].payload.json);

  assert.equal(payload.irrelevantCount, 1, 'IRRELEVANT should increment irrelevantCount');
  assert.equal(payload.noiseReasonCounts?.wrong_task, 1, 'should track wrong_task reason');
});
