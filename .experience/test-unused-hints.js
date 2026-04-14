const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-unused-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.EXPERIENCE_QDRANT_URL = 'http://127.0.0.1:1';

const STORE_DIR = path.join(TEST_HOME, '.experience', 'store', process.env.EXP_USER || 'default');
const SESSION_DIR = path.join(os.tmpdir(), 'experience-session');

const {
  _assessHintUsage: assessHintUsage,
  _reconcilePendingHints: reconcilePendingHints,
} = require('./experience-core.js');

function makeTestEntry(id, data) {
  return { id, vector: [], payload: { json: JSON.stringify(data) } };
}

function writeTestStore(collection, entries) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORE_DIR, `${collection}.json`), JSON.stringify(entries, null, 2));
}

function readTestStore(collection) {
  return JSON.parse(fs.readFileSync(path.join(STORE_DIR, `${collection}.json`), 'utf8'));
}

function cleanSessionTrack() {
  try {
    for (const name of fs.readdirSync(SESSION_DIR)) {
      if (name.startsWith('session-')) fs.unlinkSync(path.join(SESSION_DIR, name));
    }
  } catch {}
}

function cleanup() {
  cleanSessionTrack();
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
}

describe('unused hint relevance checks', () => {
  beforeEach(() => cleanSessionTrack());

  it('marks cross-project actions as wrong_repo no-touch', () => {
    const result = assessHintUsage(
      { projectSlug: 'experience-engine', scope: { lang: 'JavaScript' }, domain: 'JavaScript' },
      'Edit',
      { file_path: '/mnt/d/sources/Core/other-repo/src/app.js' },
      { cwd: '/mnt/d/sources/Core' }
    );
    assert.strictEqual(result.touched, false);
    assert.strictEqual(result.reason, 'wrong_repo');
  });

  it('marks same-language code edits as touched', () => {
    const result = assessHintUsage(
      { projectSlug: 'experience-engine', scope: { lang: 'JavaScript' }, domain: 'JavaScript' },
      'Edit',
      { file_path: '/mnt/d/sources/Core/experience-engine/src/app.js' },
      { cwd: '/mnt/d/sources/Core/experience-engine' }
    );
    assert.strictEqual(result.touched, true);
    assert.strictEqual(result.reason, 'language_match');
  });
});

describe('unused hint reconciliation', () => {
  const coll = `unused-test-${Date.now()}`;
  const pointId = 'unused-point-001';
  const surface = {
    collection: coll,
    id: pointId,
    solution: 'Use the shared helper before editing JavaScript code.',
    scope: { lang: 'JavaScript' },
    domain: 'JavaScript',
    projectSlug: 'experience-engine',
    hitCount: 0,
  };

  beforeEach(() => {
    cleanSessionTrack();
    fs.mkdirSync(STORE_DIR, { recursive: true });
    writeTestStore(coll, [makeTestEntry(pointId, { hitCount: 0, ignoreCount: 0, unusedCount: 0 })]);
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(STORE_DIR, `${coll}.json`)); } catch {}
  });

  it('increments unusedCount after three repeated no-touch actions', async () => {
    const docsEdit = { file_path: '/mnt/d/sources/Core/experience-engine/README.md' };

    let result = await reconcilePendingHints([surface], 'Edit', docsEdit, { cwd: '/mnt/d/sources/Core/experience-engine' });
    assert.strictEqual(result.pending.length, 1, 'first no-touch should remain pending');
    assert.strictEqual(result.implicitUnused.length, 0);

    result = await reconcilePendingHints([], 'Edit', docsEdit, { cwd: '/mnt/d/sources/Core/experience-engine' });
    assert.strictEqual(result.pending.length, 1, 'second no-touch should still remain pending');
    assert.strictEqual(result.implicitUnused.length, 0);

    result = await reconcilePendingHints([], 'Edit', docsEdit, { cwd: '/mnt/d/sources/Core/experience-engine' });
    assert.strictEqual(result.pending.length, 0, 'third no-touch should consume the pending hint');
    assert.strictEqual(result.implicitUnused.length, 1, 'third no-touch should emit implicit unused');

    const stored = JSON.parse(readTestStore(coll)[0].payload.json);
    assert.strictEqual(stored.unusedCount, 1, 'unusedCount should increment in storage');
  });

  it('clears pending hint on later relevant touch', async () => {
    await reconcilePendingHints([surface], 'Edit', { file_path: '/mnt/d/sources/Core/experience-engine/README.md' }, { cwd: '/mnt/d/sources/Core/experience-engine' });
    const result = await reconcilePendingHints([], 'Edit', { file_path: '/mnt/d/sources/Core/experience-engine/src/app.js' }, { cwd: '/mnt/d/sources/Core/experience-engine' });
    assert.strictEqual(result.touched.length, 1, 'relevant edit should clear pending hint');
    const stored = JSON.parse(readTestStore(coll)[0].payload.json);
    assert.strictEqual(stored.unusedCount, 0, 'touch should not increment unusedCount');
  });
});

process.on('exit', cleanup);
