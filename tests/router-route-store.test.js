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

let testHome, qdrantServer, qdrantPort, qdrantWrites, qdrantPayloadUpdates;

// Counts full reads of the routes FileStore. Size checks only prove nothing was
// WRITTEN; the 308MB incident was dominated by the read + JSON.parse, so the read
// itself is what must be asserted away.
function countRouteReads(fn) {
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.includes('experience-routes.json')) reads++;
    return realRead.call(this, p, ...rest);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { fs.readFileSync = realRead; })
    .then(() => reads);
}

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
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'PUT' && req.url.includes('/points')) qdrantWrites++;
      if (req.method === 'POST' && req.url.endsWith('/points/scroll')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          result: {
            points: [{ id: 'route-target', payload: { json: JSON.stringify({ taskHash: 'fb-hash', outcome: null }) } }],
            next_page_offset: null,
          },
        }));
      }
      if (req.method === 'POST' && req.url.endsWith('/points/payload')) {
        qdrantPayloadUpdates.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { status: 'ok' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { collections: [] }, status: 'ok' }));
    });
  });
  await new Promise(r => qdrantServer.listen(0, '127.0.0.1', r));
  qdrantPort = qdrantServer.address().port;
});

test.after(async () => {
  await new Promise(r => qdrantServer.close(r));
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test.beforeEach(() => { qdrantWrites = 0; qdrantPayloadUpdates = []; });

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

// ---------------------------------------------------------------------------
// routeFeedback carried the SAME read-modify-write defect as storeRouteDecision,
// undetected only because nothing calls it yet: activity.jsonl has 0 route-feedback
// rows across its whole history, while server.js:1520 exposes it as a live
// endpoint. Its FileStore scan was never gated on Qdrant, so the first client to
// POST feedback would read all 308MB and — on a hit — write all 308MB back.
// ---------------------------------------------------------------------------

test('Qdrant up: routeFeedback never touches the FileStore collection', async () => {
  writeConfig(`http://127.0.0.1:${qdrantPort}`);
  seedRoutes();
  const { routeFeedback } = loadRouter();
  assert.ok(routeFeedback, 'routeFeedback must be exported for testing');

  const before = fs.statSync(routesPath());
  const reads = await countRouteReads(() => routeFeedback('fb-hash', 'balanced', 'model-z', 'success', 0, 1200));
  const after = fs.statSync(routesPath());

  assert.equal(reads, 0, 'must not read the routes FileStore at all while Qdrant is up');
  assert.equal(after.size, before.size, 'must not rewrite the routes FileStore while Qdrant is up');
  assert.equal(qdrantPayloadUpdates.length, 1, 'the outcome must still be recorded, via Qdrant');
  assert.equal(JSON.parse(qdrantPayloadUpdates[0].payload.json).outcome, 'success');
});

test('Qdrant down: routeFeedback still records the outcome in the FileStore fallback', async () => {
  writeConfig('http://127.0.0.1:1'); // refused
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(routesPath(), JSON.stringify([
    { id: 'seed-1', vector: [1, 0, 0, 0, 0], payload: { json: '{"id":"seed-1","taskHash":"fb-hash"}' } },
  ], null, 2));
  const { routeFeedback } = loadRouter();

  const ok = await routeFeedback('fb-hash', 'balanced', 'model-z', 'fail', 2, 900);

  assert.equal(ok, true, 'offline fallback must still find and update the route');
  const entries = JSON.parse(fs.readFileSync(routesPath(), 'utf8'));
  const data = JSON.parse(entries[0].payload.json);
  assert.equal(data.outcome, 'fail');
  assert.equal(data.retryCount, 2);
});

test('Qdrant down: routeFeedback on an unknown hash reports miss without throwing', async () => {
  writeConfig('http://127.0.0.1:1');
  seedRoutes();
  const { routeFeedback } = loadRouter();

  const ok = await routeFeedback('no-such-hash', 'fast', 'model-q', 'success', 0, 100);
  assert.equal(ok, false, 'a miss must report false, not throw');
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
