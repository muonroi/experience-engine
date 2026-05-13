#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

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
  while ((Date.now() - started) < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

// Stub server that handles:
//   - Qdrant /collections (health), /collections/<name>/points/query (search)
//   - LLM /v1/chat/completions (classifier)
//   - OpenAI-style /v1/embeddings (embedding)
//
// Each route is overridable per-test via `overrides` so individual tests can
// shape the classifier response or principle/pattern payloads.
async function startStub(overrides = {}) {
  const port = await getFreePort();
  const samplePrinciple = {
    id: 'p1',
    score: 0.62,
    payload: { text: 'Always validate inputs before mutating state.' },
  };
  const samplePattern = {
    id: 'b1',
    score: 0.82,
    payload: { text: 'When stack trace shows NullReferenceException, dump locals first.' },
  };
  const samplePattern2 = {
    id: 'b2',
    score: 0.60,
    payload: { json: JSON.stringify({ solution: 'Add a regression test that reproduces the bug.' }) },
  };

  const defaultClassifier = 'debug, balanced';
  const classifierContent = overrides.classifierContent || defaultClassifier;
  const principlesPoints = overrides.principlesPoints || [samplePrinciple];
  const behavioralPoints = overrides.behavioralPoints || [samplePattern, samplePattern2];
  const embedding = overrides.embedding || new Array(8).fill(0).map((_, i) => i / 8);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      // Qdrant health
      if (req.method === 'GET' && req.url === '/collections') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { collections: [] } }));
      }
      // Qdrant search (points/query)
      if (req.method === 'POST' && /^\/collections\/[^/]+\/points\/query$/.test(req.url)) {
        const points = req.url.includes('experience-principles')
          ? principlesPoints
          : behavioralPoints;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { points } }));
      }
      // LLM classify
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { content: classifierContent } }],
        }));
      }
      // OpenAI-style embeddings
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          data: [{ embedding }],
        }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: req.url }));
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    server,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createTempHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-pil-context-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.experience', 'config.json'),
    JSON.stringify(config, null, 2)
  );
  return homeDir;
}

async function startServer(config) {
  const port = await getFreePort();
  const homeDir = createTempHome(config);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      EXP_SERVER_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${stderr}`.trim());
  }

  return {
    baseUrl,
    child,
    homeDir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function buildConfig(stubPort, token) {
  return {
    qdrantUrl: `http://127.0.0.1:${stubPort}`,
    qdrantKey: 'test-key',
    brainProvider: 'custom',
    brainEndpoint: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
    brainKey: 'test-brain-key',
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${stubPort}/v1/embeddings`,
    embedKey: 'test-embed-key',
    embedModel: 'test-embed-model',
    server: { authToken: token },
    serverAuthToken: token,
  };
}

test('POST /api/pil-context classifies a debug prompt and returns T2 patterns when retrieval succeeds', async () => {
  const token = 'test-server-token';
  const stub = await startStub({ classifierContent: 'debug, balanced' });
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'fix the null reference exception in payment handler' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema_version, '1.0');
    assert.equal(body.taskType, 'debug');
    assert.equal(body.intentKind, 'task');
    assert.ok(['concise', 'balanced', 'detailed'].includes(body.outputStyle));
    assert.ok(body.confidence > 0, `confidence should be > 0, got ${body.confidence}`);
    assert.ok(Array.isArray(body.t2_patterns));
    assert.ok(body.t2_patterns.length > 0, 't2_patterns should be non-empty when retrieval succeeds');
    // High-score pattern (0.82) should appear in t1_rules.
    assert.ok(Array.isArray(body.t1_rules));
    assert.ok(body.t1_rules.length > 0, 't1_rules should derive from >=0.75 patterns');
    assert.equal(body.cache_hit, false);
    assert.equal(body.gsd_route_source, 'none');
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context reports inference_ms > 0', async () => {
  const token = 'test-server-token';
  const stub = await startStub({ classifierContent: 'analyze, detailed' });
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'analyze the failure modes of this circuit breaker' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.inference_ms > 0, `inference_ms should be > 0, got ${body.inference_ms}`);
    assert.equal(body.taskType, 'analyze');
    assert.equal(body.outputStyle, 'detailed');
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context returns cache_hit=true on identical second request', async () => {
  const token = 'test-server-token';
  const stub = await startStub({ classifierContent: 'debug, balanced' });
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const doPost = () => fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'cache me: fix the null reference in payment handler' }),
    });

    const res1 = await doPost();
    assert.equal(res1.status, 200);
    const b1 = await res1.json();
    assert.equal(b1.cache_hit, false);

    const res2 = await doPost();
    assert.equal(res2.status, 200);
    const b2 = await res2.json();
    assert.equal(b2.cache_hit, true, 'second identical request should hit the cache');
    assert.ok(b2.inference_ms < 100, `cached inference_ms should be <100ms, got ${b2.inference_ms}`);
    // Cached payload preserves task classification
    assert.equal(b2.taskType, b1.taskType);
    assert.deepEqual(b2.t2_patterns, b1.t2_patterns);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context skips retrieval when classifier returns "none" (general/chitchat)', async () => {
  const token = 'test-server-token';
  const stub = await startStub({ classifierContent: 'none, concise' });
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'hi how are you' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taskType, 'general');
    assert.equal(body.intentKind, 'chitchat');
    assert.equal(body.outputStyle, 'concise');
    assert.equal(body.retrieval_skipped_reason, 'task_type:general');
    assert.deepEqual(body.t0_principles, []);
    assert.deepEqual(body.t1_rules, []);
    assert.deepEqual(body.t2_patterns, []);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context rejects missing prompt with 400', async () => {
  const token = 'test-server-token';
  const stub = await startStub();
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error, 'response should include error message');
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context rejects prompt > 10KB with 400', async () => {
  const token = 'test-server-token';
  const stub = await startStub();
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const huge = 'x'.repeat(11_000);
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: huge }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error, 'response should include error message');
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});

test('POST /api/pil-context rejects unauthenticated request', async () => {
  const token = 'test-server-token';
  const stub = await startStub();
  const runtime = await startServer(buildConfig(stub.port, token));

  try {
    const res = await fetch(`${runtime.baseUrl}/api/pil-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // no Authorization header
      },
      body: JSON.stringify({ prompt: 'x' }),
    });

    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});
