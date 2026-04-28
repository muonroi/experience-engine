#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'setup.sh');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-setup-'));
}

function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/api/gates') {
      if (req.headers.authorization !== 'Bearer read-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ overall: { percent: 100 } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function runSetup(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('setup.sh timeout'));
    }, 20000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('setup.sh skips local Qdrant and embed checks in thin-client mode', async () => {
  const homeDir = makeHome();
  const { server, port, requests } = await startServer();

  try {
    const result = await runSetup({
      HOME: homeDir,
      USERPROFILE: homeDir,
      EXP_QDRANT_URL: 'http://127.0.0.1:6333',
      EXP_EMBED_PROVIDER: 'ollama',
      EXP_BRAIN_PROVIDER: 'ollama',
      EXP_EMBED_MODEL: 'nomic-embed-text',
      EXP_BRAIN_MODEL: 'qwen2.5:3b',
      EXP_EMBED_DIM: '768',
      EXP_AGENTS: 'codex',
      EXP_SERVER_BASE_URL: `http://127.0.0.1:${port}`,
      EXP_SERVER_READ_AUTH_TOKEN: 'read-secret',
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Thin-client mode detected/);
    assert.match(result.stdout, /Embed API \(ollama\)\.\.\. OK \(thin-client: server handles embeddings\)/);
    assert.match(result.stdout, /Qdrant\.\.\. OK \(thin-client server reachable\)/);
    assert.match(result.stdout, /Collections\.\.\. OK \(thin-client: server gates reachable\)/);
    assert.doesNotMatch(result.stdout, /\[WARN\] Could not create collection/);
    assert.doesNotMatch(result.stdout, /3 check\(s\) failed/);

    const gatesRequest = requests.find((entry) => entry.url === '/api/gates');
    assert.equal(gatesRequest?.auth, 'Bearer read-secret');
  } finally {
    server.close();
  }
});
