#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const {
  isRemoteEnabled,
  queueRequest,
  readQueue,
  flushQueue,
  requestJson,
  getQueueDir,
  getHookTimeoutMs,
  getExtractTimeoutMs,
} = require('./remote-client');

function withTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-remote-'));
  const expDir = path.join(homeDir, '.experience');
  fs.mkdirSync(expDir, { recursive: true });
  return { homeDir, expDir };
}

function writeConfig(homeDir, cfg) {
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(cfg, null, 2));
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('isRemoteEnabled follows serverBaseUrl presence', () => {
  assert.equal(isRemoteEnabled({}), false);
  assert.equal(isRemoteEnabled({ serverBaseUrl: 'http://127.0.0.1:8082' }), true);
});

test('getHookTimeoutMs defaults lower than general server timeout', () => {
  assert.equal(getHookTimeoutMs({}), 1200);
  assert.equal(getHookTimeoutMs({ serverTimeoutMs: 900 }), 900);
  assert.equal(getHookTimeoutMs({ serverTimeoutMs: 5000 }), 1200);
  assert.equal(getHookTimeoutMs({ serverHookTimeoutMs: 700, serverTimeoutMs: 5000 }), 700);
});

test('getExtractTimeoutMs defaults higher than general hook timeout', () => {
  assert.equal(getExtractTimeoutMs({}), 60000);
  assert.equal(getExtractTimeoutMs({ serverTimeoutMs: 8000 }), 60000);
  assert.equal(getExtractTimeoutMs({ serverExtractTimeoutMs: 9000 }), 9000);
  assert.equal(getExtractTimeoutMs({ serverTimeoutMs: 20000 }), 60000);
  assert.equal(getExtractTimeoutMs({ serverTimeoutMs: 120000 }), 120000);
});

test('requestJson sends auth header and parses JSON response', async () => {
  const { homeDir } = withTempHome();
  const received = [];
  const { server, port } = await startServer((req, res) => {
    received.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization || '',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  writeConfig(homeDir, {
    serverBaseUrl: `http://127.0.0.1:${port}`,
    serverAuthToken: 'secret-token',
  });

  try {
    const result = await requestJson('POST', '/api/posttool', { ping: true }, { homeDir });
    assert.equal(result.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/posttool');
    assert.equal(received[0].auth, 'Bearer secret-token');
  } finally {
    server.close();
  }
});

test('queueRequest and flushQueue replay deferred events in order', async () => {
  const { homeDir } = withTempHome();
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}` });

  try {
    queueRequest('POST', '/api/extract', { transcript: 'a'.repeat(120) }, { homeDir });
    queueRequest('POST', '/api/posttool', { toolName: 'Edit' }, { homeDir });
    assert.equal(readQueue(homeDir).length, 2);

    const flush = await flushQueue({ homeDir, limit: 10 });
    assert.equal(flush.sent, 2);
    assert.equal(flush.remaining, 0);
    assert.equal(readQueue(homeDir).length, 0);
    assert.deepEqual(seen.map((item) => item.url), ['/api/extract', '/api/posttool']);
  } finally {
    server.close();
  }
});

test('flushQueue leaves event on disk after failed delivery', async () => {
  const { homeDir } = withTempHome();
  writeConfig(homeDir, { serverBaseUrl: 'http://127.0.0.1:1', serverTimeoutMs: 200 });
  queueRequest('POST', '/api/posttool', { toolName: 'Edit' }, { homeDir });

  const flush = await flushQueue({ homeDir, limit: 10 });
  assert.equal(flush.sent, 0);
  assert.equal(readQueue(homeDir).length, 1);
  assert.equal(fs.existsSync(getQueueDir(homeDir)), true);
});

test('flushQueue can skip heavy paths during hook replay', async () => {
  const { homeDir } = withTempHome();
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}` });

  try {
    queueRequest('POST', '/api/extract', { transcript: 'heavy' }, { homeDir });
    queueRequest('POST', '/api/posttool', { toolName: 'Edit' }, { homeDir });

    const flush = await flushQueue({
      homeDir,
      limit: 1,
      allowedPaths: ['/api/posttool'],
    });
    assert.equal(flush.sent, 1);
    assert.deepEqual(seen.map((item) => item.url), ['/api/posttool']);
    assert.equal(readQueue(homeDir).length, 1);
    const remaining = JSON.parse(fs.readFileSync(readQueue(homeDir)[0], 'utf8'));
    assert.equal(remaining.path, '/api/extract');
  } finally {
    server.close();
  }
});

test('exp-client-drain flushes queued extract events', async () => {
  const { homeDir } = withTempHome();
  const expDir = path.join(homeDir, '.experience');
  fs.copyFileSync(path.join(__dirname, 'exp-client-drain.js'), path.join(expDir, 'exp-client-drain.js'));
  fs.copyFileSync(path.join(__dirname, 'remote-client.js'), path.join(expDir, 'remote-client.js'));
  fs.copyFileSync(path.join(__dirname, 'extract-compact.js'), path.join(expDir, 'extract-compact.js'));

  const seen = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: 1 }));
    });
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}` });
  queueRequest('POST', '/api/extract', { transcript: 'heavy-drain' }, { homeDir });

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(expDir, 'exp-client-drain.js'), '--extract-only'], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('exp-client-drain timeout'));
      }, 8000);
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
    assert.equal(result.status, 0);
    assert.deepEqual(seen.map((item) => item.url), ['/api/extract']);
    assert.equal(readQueue(homeDir).length, 0);
  } finally {
    server.close();
  }
});
