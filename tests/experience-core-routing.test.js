#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-route-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

let server;
let port;
let payloadUpdates = [];
let scrollCalls = 0;

function writeConfig() {
  fs.mkdirSync(path.join(TEST_HOME, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, '.experience', 'config.json'), JSON.stringify({
    qdrantUrl: `http://127.0.0.1:${port}`,
    qdrantKey: 'test-key',
    user: 'default',
  }, null, 2));
}

function startServer() {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'GET' && req.url === '/collections') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { collections: [] } }));
      }
      if (req.method === 'POST' && req.url === '/collections/experience-routes/points/scroll') {
        scrollCalls += 1;
        const offset = body.offset || null;
        const firstPage = Array.from({ length: 100 }, (_, i) => ({
          id: `route-${i}`,
          payload: { json: JSON.stringify({ taskHash: `other-${i}`, outcome: null }) },
        }));
        const secondPage = [{
          id: 'route-target',
          payload: { json: JSON.stringify({ taskHash: 'target-hash', outcome: null, tier: 'fast' }) },
        }];
        const response = offset
          ? { result: { points: secondPage, next_page_offset: null } }
          : { result: { points: firstPage, next_page_offset: 'page-2' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(response));
      }
      if (req.method === 'POST' && req.url === '/collections/experience-routes/points/payload') {
        payloadUpdates.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { status: 'ok' } }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      writeConfig();
      resolve();
    });
  });
}

test.before(async () => {
  await startServer();
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

test('routeFeedback paginates Qdrant scroll results until it finds the matching task hash', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeFeedback } = require(CORE_PATH);

  const ok = await routeFeedback('target-hash', 'balanced', 'gpt-5.4-mini', 'success', 0, 1200);
  assert.equal(ok, true, 'routeFeedback should find the task hash after page 100');
  assert.ok(scrollCalls >= 2, 'routeFeedback should fetch the next Qdrant page when the first page misses');
  assert.equal(payloadUpdates.length, 1, 'routeFeedback should update the matched route payload');
  assert.deepEqual(payloadUpdates[0].points, ['route-target']);
  const updated = JSON.parse(payloadUpdates[0].payload.json);
  assert.equal(updated.outcome, 'success');
  assert.equal(updated.tier, 'balanced');
  assert.equal(updated.model, 'gpt-5.4-mini');
});
