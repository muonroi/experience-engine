#!/usr/bin/env node
'use strict';

/**
 * router-route-store.test.js
 *
 * storeRouteDecision did a "dual-write: FileStore always, Qdrant when
 * available". Because fileStoreUpsert is a read-modify-write of the WHOLE
 * collection (qdrant.js:124-132: fileStoreRead -> push -> JSON.stringify(...,
 * null, 2) -> write), and because every call mints a fresh randomUUID so the
 * findIndex never matches and the entry is always pushed, the routes file grew
 * by one 1024-dim vector per recall forever, and every recall paid O(filesize).
 *
 * Measured in production before the fix: experience-routes.json had reached
 * 307MB / 10937 entries, so ONE normal recall read 310MB and wrote 307MB —
 * a ~3.1s uninterrupted event-loop block (readFileSync + JSON.parse alone
 * timed at 3121ms on the VPS), stalling every concurrent request. A `fast`
 * recall, which skips the router, read 0MB.
 *
 * The rest of the codebase treats FileStore as the OFFLINE FALLBACK only —
 * see updatePointPayload / searchCollection / fetchPointById, which all start
 * with `if (!(await checkQdrant()))`. This pins storeRouteDecision to that
 * same contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROUTER_PATH = path.join(__dirname, '..', '.experience', 'src', 'router.js');
const QDRANT_PATH = path.join(__dirname, '..', '.experience', 'src', 'qdrant.js');
const CONFIG_PATH = path.join(__dirname, '..', '.experience', 'src', 'config.js');

let testHome, qdrantServer, qdrantPort, qdrantWrites;

function storeDir() {
  return path.join(testHome, '.experience', 'store', 'default');
}

function routesPath() {
  return path.join(storeDir(), 'experience-routes.json');
}

function writeConfig(qdrantUrl) {
  fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
  fs.writeFileSync(
    path.join(testHome, '.experience', 'config.json'),
    JSON.stringify({ qdrantUrl, embedDim: 5, routing: true }, null, 2),
  );
}

function seedRoutes() {
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(routesPath(), JSON.stringify([
    { id: 'seed-1', vector: [1, 0, 0, 0, 0], payload: { json: '{"id":"seed-1","taskHash":"h1"}' } },
  ], null, 2));
}

function loadRouter() {
  for (const p of [ROUTER_PATH, QDRANT_PATH, CONFIG_PATH]) delete require.cache[require.resolve(p)];
  return require(ROUTER_PATH);
}

test.before(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-router-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  qdrantServer = http.createServer((req, res) => {
    if (req.method === 'PUT' && req.url.includes('/points')) qdrantWrites++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { collections: [] }, status: 'ok' }));
  });
  await new Promise(r => qdrantServer.listen(0, '127.0.0.1', r));
  qdrantPort = qdrantServer.address().port;
});

test.after(async () => {
  await new Promise(r => qdrantServer.close(r));
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test.beforeEach(() => { qdrantWrites = 0; });

test('Qdrant up: route decision does NOT rewrite the FileStore collection', async () => {
  writeConfig(`http://127.0.0.1:${qdrantPort}`);
  seedRoutes();
  const { storeRouteDecision } = loadRouter();
  assert.ok(storeRouteDecision, 'storeRouteDecision must be exported for testing');

  const before = fs.statSync(routesPath());
  await storeRouteDecision('do a thing', 'hash-1', 'tier1', 'model-x', 'cli', {}, [1, 0, 0, 0, 0]);
  const after = fs.statSync(routesPath());

  assert.equal(after.size, before.size, 'FileStore must not be rewritten while Qdrant is up');
  assert.equal(qdrantWrites, 1, 'the route must still be persisted to Qdrant');

  const entries = JSON.parse(fs.readFileSync(routesPath(), 'utf8'));
  assert.equal(entries.length, 1, 'no entry appended to the FileStore fallback');
});

test('Qdrant write failure is logged, not thrown (catch arm is reachable)', async () => {
  // Guards the catch arms themselves: they reference log/serializeError, so a
  // missing import would only surface here — never on the happy path.
  writeConfig(`http://127.0.0.1:${qdrantPort}`);
  seedRoutes();
  const { storeRouteDecision } = loadRouter();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PUT') throw new Error('simulated qdrant write failure');
    return realFetch(url, init);
  };
  try {
    await assert.doesNotReject(
      storeRouteDecision('t', 'hash-err', 'tier1', 'm', 'cli', {}, [1, 0, 0, 0, 0]),
      'a failed Qdrant write must degrade, not throw',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Qdrant down: route decision still lands in the FileStore fallback', async () => {
  writeConfig('http://127.0.0.1:1'); // refused
  seedRoutes();
  const { storeRouteDecision } = loadRouter();

  await storeRouteDecision('do a thing', 'hash-2', 'tier2', 'model-y', 'cli', {}, [0, 1, 0, 0, 0]);

  const entries = JSON.parse(fs.readFileSync(routesPath(), 'utf8'));
  assert.equal(entries.length, 2, 'offline fallback must still record the route');
  const added = entries.find(e => e.id !== 'seed-1');
  assert.ok(added, 'new route entry present');
  assert.equal(JSON.parse(added.payload.json).taskHash, 'hash-2');
});
