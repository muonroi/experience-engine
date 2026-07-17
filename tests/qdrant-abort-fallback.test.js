#!/usr/bin/env node
'use strict';

/**
 * qdrant-abort-fallback.test.js
 *
 * searchCollection used to `catch { return fileStoreSearch(...) }`, which
 * swallowed the caller's AbortSignal timeout along with real connection errors.
 * That made a slow brain strictly worse: once handleRecall's AbortSignal fired,
 * every collection degraded into a whole-file read + in-JS cosine scan over
 * every entry (experience-routes.json is ~306MB in production) — blocking the
 * event loop far longer than the request that had just run out of budget.
 *
 * Contract pinned here:
 *   - abort/timeout  → return [] (budget is spent; do not start heavier work)
 *   - Qdrant down    → FileStore fallback still applies (resilience preserved)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const QDRANT_PATH = path.join(__dirname, '..', '.experience', 'src', 'qdrant.js');
const CONFIG_PATH = path.join(__dirname, '..', '.experience', 'src', 'config.js');

let testHome, slowServer, slowPort;

function storeDir() {
  return path.join(testHome, '.experience', 'store', 'default');
}

function writeConfig(qdrantUrl) {
  fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
  fs.writeFileSync(
    path.join(testHome, '.experience', 'config.json'),
    JSON.stringify({ qdrantUrl, embedDim: 5 }, null, 2),
  );
}

/** A collection whose FileStore fallback is observable (non-empty result). */
function writeCollection(name) {
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(path.join(storeDir(), `${name}.json`), JSON.stringify([
    { id: 'p1', vector: [1, 0, 0, 0, 0], payload: { json: '{"id":"p1"}' } },
    { id: 'p2', vector: [0, 1, 0, 0, 0], payload: { json: '{"id":"p2"}' } },
  ], null, 2));
}

function loadQdrant() {
  for (const p of [QDRANT_PATH, CONFIG_PATH]) delete require.cache[require.resolve(p)];
  return require(QDRANT_PATH);
}

test.before(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-abort-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  // Reachable (so checkQdrant passes) but never answers a query in time.
  slowServer = http.createServer((req, res) => {
    if (req.url.includes('/points/query')) return; // hang forever
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { collections: [] } }));
  });
  await new Promise(r => slowServer.listen(0, '127.0.0.1', r));
  slowPort = slowServer.address().port;
});

test.after(async () => {
  await new Promise(r => slowServer.close(r));
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test('aborted search returns empty instead of a brute-force FileStore scan', async () => {
  writeConfig(`http://127.0.0.1:${slowPort}`);
  writeCollection('experience-behavioral');
  const { searchCollection } = loadQdrant();

  const t0 = Date.now();
  const out = await searchCollection(
    'experience-behavioral', [1, 0, 0, 0, 0], 5, AbortSignal.timeout(300),
  );
  const elapsed = Date.now() - t0;

  assert.deepEqual(out, [], 'abort must degrade to empty, not fall back to a full scan');
  assert.ok(elapsed < 3000, `should give up promptly, took ${elapsed}ms`);
});

test('Qdrant unreachable still falls back to FileStore', async () => {
  writeConfig('http://127.0.0.1:1'); // connection refused
  writeCollection('experience-behavioral');
  const { searchCollection } = loadQdrant();

  const out = await searchCollection('experience-behavioral', [1, 0, 0, 0, 0], 5);

  assert.ok(out.length > 0, 'FileStore resilience path must survive');
  assert.equal(out[0].id, 'p1', 'nearest vector first');
});
