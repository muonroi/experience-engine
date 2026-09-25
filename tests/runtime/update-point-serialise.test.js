#!/usr/bin/env node
'use strict';

// updatePointPayload is a read-modify-write of the whole payload json on the Qdrant
// path. Concurrent in-process updates to one point used to interleave as
// GET, GET, POST, POST and lose writes; they are now chained per (collection, id)
// (spec §3 B1). Different points still run concurrently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-upp-serial-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const CONFIG = path.join(HOME, 'config.json');
process.env.EXPERIENCE_CONFIG_PATH = CONFIG;

const SRC = path.join(__dirname, '..', '..', '.experience', 'src');
const config = require(path.join(SRC, 'config.js'));
const qdrant = require(path.join(SRC, 'qdrant.js'));

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

test('concurrent updates to one point all land; other points are not blocked', async () => {
  const store = new Map([['p1', { n: 0 }], ['p2', { n: 0 }]]);
  let inFlightGets = 0;
  let maxConcurrentGets = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/collections') return send({ result: { collections: [] } });
      const m = req.url.match(/^\/collections\/c\/points\/(p\d)$/);
      if (req.method === 'GET' && m) {
        inFlightGets++;
        maxConcurrentGets = Math.max(maxConcurrentGets, inFlightGets);
        const snapshot = JSON.stringify(store.get(m[1]));
        // Slow read: without serialisation every concurrent update reads n=0.
        return setTimeout(() => { inFlightGets--; send({ result: { id: m[1], payload: { json: snapshot } } }); }, 15);
      }
      if (req.method === 'POST' && req.url === '/collections/c/points/payload') {
        const body = JSON.parse(raw);
        store.set(body.points[0], JSON.parse(body.payload.json));
        return send({ result: { status: 'ok' } });
      }
      return send({});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ qdrantUrl: `http://127.0.0.1:${server.address().port}` }));
    config.refreshConfig();
    qdrant.resetQdrantCheck();
    const inc = (data) => { data.n += 1; return data; };
    await Promise.all([
      ...Array.from({ length: 10 }, () => qdrant.updatePointPayload('c', 'p1', inc)),
      ...Array.from({ length: 5 }, () => qdrant.updatePointPayload('c', 'p2', inc)),
    ]);
    assert.equal(store.get('p1').n, 10, 'no lost update on p1');
    assert.equal(store.get('p2').n, 5, 'no lost update on p2');
    assert.ok(maxConcurrentGets >= 2, 'different points still update concurrently');
  } finally {
    server.close();
    qdrant.resetQdrantCheck();
  }
});

test('a throwing update rejects its own caller and does not wedge the chain', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1' }));
  config.refreshConfig();
  qdrant.resetQdrantCheck();
  const storeDir = path.join(HOME, '.experience', 'store', 'default');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'c2.json'), JSON.stringify([{ id: 'x', vector: [], payload: { json: JSON.stringify({ n: 0 }) } }]));
  const boom = qdrant.updatePointPayload('c2', 'x', () => { throw new Error('boom'); });
  const after = qdrant.updatePointPayload('c2', 'x', (d) => { d.n = 7; return d; });
  await assert.rejects(boom, /boom/);
  await after;
  const data = JSON.parse(JSON.parse(fs.readFileSync(path.join(storeDir, 'c2.json'), 'utf8'))[0].payload.json);
  assert.equal(data.n, 7);
});
