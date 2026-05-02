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

async function startBrainAndQdrantStub() {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/collections') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { collections: [] } }));
      }
      if (req.method === 'GET' && req.url === '/collections/experience-routes') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'missing' }));
      }
      if (req.method === 'PUT' && req.url === '/collections/experience-routes') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: { status: 'ok' } }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                route: 'qc-lock',
                confidence: 0.88,
                needs_disambiguation: false,
                reason: 'The task is already narrow and executable.',
                options: []
              })
            }
          }]
        }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: req.url, body: raw ? JSON.parse(raw) : null }));
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    server,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function createTempHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-server-route-task-'));
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

test('POST /api/route-task returns a real task route verdict for narrow execution requests', async () => {
  const stub = await startBrainAndQdrantStub();
  const token = 'test-server-token';
  const runtime = await startServer({
    qdrantUrl: `http://127.0.0.1:${stub.port}`,
    qdrantKey: 'test-key',
    brainProvider: 'custom',
    brainEndpoint: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
    brainKey: 'test-brain-key',
    server: { authToken: token },
    serverAuthToken: token,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/api/route-task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        task: 'fix a typo in README.md',
        runtime: 'codex',
        context: {
          localRoute: 'qc-lock',
          localReason: 'Task is narrow.'
        }
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-route-source'), 'keyword');

    const body = await res.json();
    assert.equal(body.route, 'qc-lock');
    assert.equal(body.source, 'keyword');
    assert.equal(body.needs_disambiguation, false);
    assert.equal(body.reason, 'The task is a narrow execution change with concrete implementation cues.');
  } finally {
    await runtime.stop();
    await stub.stop();
  }
});
