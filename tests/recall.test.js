#!/usr/bin/env node
'use strict';

/**
 * recall.test.js — /api/recall (active agent self-query) + exp-recall helper.
 *
 * The endpoint is a thin wrapper over the already-tested interceptWithMeta
 * pipeline (which records SURFACE for returned entries). Here we cover the
 * wiring that is recall-specific: auth, request validation, graceful empty
 * (embedding/qdrant unavailable), response shape, and the CLI helper's
 * argument parsing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const { parseArgs } = require('../.experience/exp-recall.js');

// ----------------------------- helper unit tests -----------------------------

test('exp-recall parseArgs: joins query words, parses flags', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--json', '--project', 'experience-engine', 'how', 'to', 'restart']);
  assert.equal(r.ok, true);
  assert.equal(r.query, 'how to restart');
  assert.equal(r.opts.json, true);
  assert.equal(r.opts.project, 'experience-engine');
});

test('exp-recall parseArgs: no query → not ok', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--json']);
  assert.equal(r.ok, false);
  assert.ok(r.help.includes('Usage'));
});

test('exp-recall parseArgs: --help → ok=false code 0', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--help']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 0);
});

// --------------------------- server integration ------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 5000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server not healthy within ${timeoutMs}ms`);
}

async function startServer(config) {
  const port = await getFreePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, EXP_SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString('utf8'); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForHealth(baseUrl); }
  catch (e) { child.kill('SIGTERM'); throw new Error(`${e.message}\n${stderr}`.trim()); }
  return {
    baseUrl, child,
    async stop() { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); fs.rmSync(homeDir, { recursive: true, force: true }); },
  };
}

test('/api/recall: auth, validation, and graceful empty response', async () => {
  const token = 'recall-test-token';
  const rt = await startServer({
    server: { authToken: token },
    serverAuthToken: token,
    qdrantUrl: 'http://127.0.0.1:1', // unreachable → FileStore (empty) ; no embed provider → graceful empty
  });
  try {
    // No auth → 401
    const noAuth = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
    });
    assert.equal(noAuth.status, 401);

    // Authed, missing query → 400
    const noQuery = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({}),
    });
    assert.equal(noQuery.status, 400);
    assert.match((await noQuery.json()).error || '', /query is required/);

    // Authed, valid query, no embed/qdrant data → 200 with well-formed empty result
    const ok = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'how do we restart the server', cwd: '/repo/experience-engine' }),
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.query, 'how do we restart the server');
    assert.ok(Array.isArray(payload.entries));
    assert.equal(typeof payload.count, 'number');
    assert.ok('text' in payload);
  } finally {
    await rt.stop();
  }
});
