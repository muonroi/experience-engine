#!/usr/bin/env node
'use strict';

// Sprint-2 Part D — POST /api/workflow-event integration test.
// Boots the real server against a stub that impersonates BOTH Qdrant and the
// embedding provider, then asserts the write-during-execution channel embeds +
// upserts a new entry into the correct workflow_* collection, and is gated off
// by default.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const EMBED_DIM = 768;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

// Stub for Qdrant + embeddings. Records every upsert so the test can assert on
// which collection was written.
async function startStub() {
  const port = await getFreePort();
  const upserts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const json = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // Embedding provider (OpenAI-style)
      if (req.method === 'POST' && req.url.startsWith('/embeddings')) {
        return json({ data: [{ embedding: Array(EMBED_DIM).fill(0.01) }] });
      }
      // Qdrant: collection existence check → pretend all exist (skip creation)
      if (req.method === 'GET' && /^\/collections\/[^/]+$/.test(req.url)) {
        return json({ result: { status: 'green' } });
      }
      if (req.method === 'GET' && req.url === '/collections') {
        return json({ result: { collections: [] } });
      }
      // Qdrant: create/index → ok
      if (req.method === 'PUT' && /^\/collections\/[^/]+\/index/.test(req.url)) {
        return json({ result: { status: 'ok' } });
      }
      // Qdrant: point upsert → record + ok
      const up = req.url.match(/^\/collections\/([^/]+)\/points/);
      if (req.method === 'PUT' && up) {
        try {
          upserts.push({ collection: up[1], body: JSON.parse(raw) });
        } catch {
          upserts.push({ collection: up[1], body: null });
        }
        return json({ result: { status: 'completed' } });
      }
      json({ ok: true });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    upserts,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createTempHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-workflow-event-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(config, null, 2));
  return homeDir;
}

async function startServer(config, extraEnv = {}) {
  const port = await getFreePort();
  const homeDir = createTempHome(config);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, EXP_SERVER_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (err) {
    child.kill('SIGTERM');
    throw new Error(`${err.message}\n${stderr}`.trim());
  }
  return {
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function baseConfig(stubPort, token, enable) {
  return {
    qdrantUrl: `http://127.0.0.1:${stubPort}`,
    qdrantKey: 'test-key',
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${stubPort}/embeddings`,
    embedKey: 'test-embed-key',
    embedDim: EMBED_DIM,
    enableWorkflowEvent: enable,
    server: { authToken: token },
    serverAuthToken: token,
  };
}

test('POST /api/workflow-event embeds + upserts a decision into workflow_decision', async () => {
  const stub = await startStub();
  const token = 'wf-token';
  const runtime = await startServer(baseConfig(stub.port, token, true));
  try {
    const res = await fetch(`${runtime.baseUrl}/api/workflow-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'decision',
        phaseRef: 'runs/abc123',
        sessionId: 's1',
        payload: { summary: 'chose native store over SDK subprocess' },
      }),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.collection, 'workflow_decision');

    const decisionUpserts = stub.upserts.filter((u) => u.collection === 'workflow_decision');
    assert.equal(decisionUpserts.length, 1, 'exactly one upsert into workflow_decision');
    const point = decisionUpserts[0].body.points[0];
    assert.equal(point.vector.length, EMBED_DIM);
    assert.equal(point.payload.kind, 'decision');
    assert.equal(point.payload.phaseRef, 'runs/abc123');
    assert.equal(point.payload.tier, 'intra-session');
    assert.match(point.payload.text, /native store/);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/workflow-event rejects an unknown kind', async () => {
  const stub = await startStub();
  const token = 'wf-token';
  const runtime = await startServer(baseConfig(stub.port, token, true));
  try {
    const res = await fetch(`${runtime.baseUrl}/api/workflow-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'not-a-kind', phaseRef: 'runs/x' }),
    });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.match(out.error, /unknown workflow kind/);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/workflow-event is 404 when disabled (default)', async () => {
  const stub = await startStub();
  const token = 'wf-token';
  const runtime = await startServer(baseConfig(stub.port, token, false));
  try {
    const res = await fetch(`${runtime.baseUrl}/api/workflow-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'decision', phaseRef: 'runs/x' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});
