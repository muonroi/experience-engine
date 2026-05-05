#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SCRIPT_PATH = path.join(__dirname, 'health-check.sh');
const isWindows = process.platform === 'win32';

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-health-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  return homeDir;
}

function startServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    received.push({
      pathname: url.pathname,
      auth: req.headers.authorization || '',
    });
    if (url.pathname === '/collections' || url.pathname === '/health' || url.pathname === '/api/gates') {
      if (url.pathname === '/api/gates' && req.headers.authorization !== 'Bearer server-read-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.pathname === '/collections') {
        res.end(JSON.stringify({ result: { collections: [{ name: 'experience-behavioral' }] } }));
      } else if (url.pathname === '/api/gates') {
        res.end(JSON.stringify({ gate1: { checks: [] }, gate2: { checks: [] }, gate3: { checks: [] }, overall: { percent: 100 } }));
      } else {
        res.end(JSON.stringify({ status: 'ok' }));
      }
      return;
    }
    if (req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: [{ embedding: [0.1, 0.2, 0.3] }], choices: [{ message: { content: 'pong' } }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port, received }));
  });
}

test('health-check reports thin-client server state and remediation hints', { skip: isWindows ? 'bash health-check.sh not reliable on Windows' : false }, async () => {
  const homeDir = makeHome();
  const expDir = path.join(homeDir, '.experience');
  const { server, port, received } = await startServer();

  const config = {
    qdrantUrl: `http://127.0.0.1:${port}`,
    qdrantKey: '',
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${port}/embed`,
    embedKey: 'embed-secret',
    embedModel: 'embed-test',
    brainProvider: 'custom',
    brainEndpoint: `http://127.0.0.1:${port}/brain`,
    brainKey: 'brain-secret',
    brainModel: 'brain-test',
    serverBaseUrl: `http://127.0.0.1:${port}`,
    serverAuthToken: 'server-secret',
    serverReadAuthToken: 'server-read-secret',
  };
  fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(expDir, 'activity.jsonl'), JSON.stringify({ ts: new Date().toISOString(), op: 'intercept', result: 'suggestion' }) + '\n');
  fs.mkdirSync(path.join(expDir, 'offline-queue'), { recursive: true });
  fs.writeFileSync(path.join(expDir, 'offline-queue', 'queued.json'), '{}');

  for (const file of ['experience-core.js', 'interceptor.js', 'interceptor-post.js', 'interceptor-prompt.js', 'stop-extractor.js', 'remote-client.js', 'health-check.sh', 'exp-server-maintain.js', 'exp-portable-backup.js', 'exp-portable-restore.js']) {
    fs.writeFileSync(path.join(expDir, file), '# stub\n');
  }
  fs.writeFileSync(path.join(expDir, 'experience-core.js'), `
'use strict';
module.exports = {
  async getEmbeddingRaw() { return [0.1, 0.2, 0.3]; },
  async _callBrainWithFallback() { return { test: 'ok' }; },
};
`);

  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH, '--json'], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('health-check timeout'));
    }, 12000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });

  try {
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.equal(data.mode.status, 'ok');
    assert.match(data.mode.detail, /Thin client/);
    assert.equal(data.remote_server.status, 'ok');
    assert.equal(data.remote_gates.status, 'ok');
    assert.equal(data.server_auth.status, 'ok');
    assert.equal(data.offline_queue.status, 'warn');
    assert.match(data.offline_queue.fix, /flush the queue/);
    const gateRequest = received.find((entry) => entry.pathname === '/api/gates');
    assert.equal(gateRequest?.auth, 'Bearer server-read-secret');
  } finally {
    server.close();
  }
});

test('health-check treats local server nodes as healthy without client hooks', { skip: isWindows ? 'bash health-check.sh not reliable on Windows' : false }, async () => {
  const homeDir = makeHome();
  const expDir = path.join(homeDir, '.experience');
  const { server, port } = await startServer();

  const config = {
    qdrantUrl: `http://127.0.0.1:${port}`,
    qdrantKey: '',
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${port}/embed`,
    embedKey: 'embed-secret',
    embedModel: 'embed-test',
    brainProvider: 'custom',
    brainEndpoint: `http://127.0.0.1:${port}/brain`,
    brainKey: 'brain-secret',
    brainModel: 'brain-test',
    server: { port },
  };
  fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(expDir, 'activity.jsonl'), JSON.stringify({ ts: new Date().toISOString(), op: 'intercept', result: null }) + '\n');

  for (const file of ['experience-core.js', 'interceptor.js', 'interceptor-post.js', 'interceptor-prompt.js', 'stop-extractor.js', 'remote-client.js', 'health-check.sh', 'exp-server-maintain.js', 'exp-portable-backup.js', 'exp-portable-restore.js']) {
    fs.writeFileSync(path.join(expDir, file), '# stub\n');
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH, '--json'], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('health-check timeout'));
    }, 12000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });

  try {
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.equal(data.mode.status, 'ok');
    assert.match(data.mode.detail, /Server \/ brain node/);
    assert.equal(data.claude_code_hooks.status, 'ok');
    assert.match(data.claude_code_hooks.detail, /Not required on server node/);
    assert.equal(data.codex_cli_hooks.status, 'ok');
    assert.equal(data.gemini_cli_hooks.status, 'ok');
  } finally {
    server.close();
  }
});
