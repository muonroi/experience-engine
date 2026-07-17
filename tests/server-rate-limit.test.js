#!/usr/bin/env node
'use strict';

/**
 * server-rate-limit.test.js — identity-keyed rate limiting.
 *
 * The old limiter keyed every bucket on req.socket.remoteAddress with a flat
 * 120/min. In production that is actively wrong: Apache reverse-proxies
 * experience.muonroi.com to 127.0.0.1:8082, so EVERY agent on EVERY machine
 * arrived as 127.0.0.1 and shared ONE 120/min bucket. EE tools are a query-first
 * SOT that agents hit before every step, so the shared cap is a global throughput
 * ceiling on authenticated, trusted callers — while an anonymous attacker got the
 * exact same 120.
 *
 * The model here: identity first, then the bucket.
 *   - valid token  → per-token bucket, high cap (a runaway guard, not a quota)
 *   - no token     → per-IP bucket, low cap (the actual abuse surface)
 * and X-Forwarded-For is honoured ONLY from a loopback peer, because from
 * anywhere else it is caller-controlled and would mint unlimited buckets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server not healthy within ${timeoutMs}ms`);
}

async function startServer(config) {
  const port = await getFreePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rl-'));
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
    async stop() {
      child.kill('SIGTERM');
      await new Promise(r => child.once('exit', r));
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

const TOKEN = 'rl-test-token';
// Unreachable Qdrant keeps handlers fast + deterministic; we only assert status codes.
const baseConfig = (extra) => ({
  server: { authToken: TOKEN, ...extra },
  serverAuthToken: TOKEN,
  qdrantUrl: 'http://127.0.0.1:1',
});

function post(baseUrl, headers = {}) {
  return fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({}),
  });
}

test('anonymous callers get the low per-IP bucket; authed callers are NOT charged to it', async () => {
  const rt = await startServer(baseConfig({ rateLimit: 50, rateLimitAnon: 2 }));
  try {
    // Two anonymous requests fit the anon bucket — rejected by AUTH (401), not by rate limit.
    assert.equal((await post(rt.baseUrl)).status, 401);
    assert.equal((await post(rt.baseUrl)).status, 401);
    // Third exceeds the anon bucket.
    assert.equal((await post(rt.baseUrl)).status, 429, 'anon bucket must be enforced');

    // The authed caller must be on a DIFFERENT bucket — the anon flood must not
    // starve it. This is the whole point of authenticating before limiting.
    const authed = await post(rt.baseUrl, { Authorization: `Bearer ${TOKEN}` });
    assert.notEqual(authed.status, 429, 'authed caller must not inherit the anon bucket');
  } finally {
    await rt.stop();
  }
});

test('the authed bucket has its own (high) cap and still backstops a runaway', async () => {
  const rt = await startServer(baseConfig({ rateLimit: 3, rateLimitAnon: 100 }));
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (let i = 0; i < 3; i++) {
      assert.notEqual((await post(rt.baseUrl, auth)).status, 429, `request ${i + 1} must fit the authed cap`);
    }
    assert.equal((await post(rt.baseUrl, auth)).status, 429, 'authed cap is a real backstop, not unlimited');
  } finally {
    await rt.stop();
  }
});

test('rateLimit: 0 disables the limit (regression: `|| 120` silently resurrected it)', async () => {
  // `_cfg.server?.rateLimit || 120` turned an explicit 0 into 120. Anyone who set
  // 0 to disable the limiter got a 120/min limiter instead — the opposite.
  const rt = await startServer(baseConfig({ rateLimit: 0, rateLimitAnon: 500 }));
  try {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    // Must exceed the old silent fallback of 120 — anything less passes either way.
    for (let i = 0; i < 130; i++) {
      assert.notEqual((await post(rt.baseUrl, auth)).status, 429, `request ${i + 1} must not be limited when disabled`);
    }
  } finally {
    await rt.stop();
  }
});

test('X-Forwarded-For separates callers behind the reverse proxy', async () => {
  // Without this, Apache's 127.0.0.1 peer address collapses every agent in the
  // fleet into one bucket.
  const rt = await startServer(baseConfig({ rateLimit: 50, rateLimitAnon: 1 }));
  try {
    assert.equal((await post(rt.baseUrl, { 'X-Forwarded-For': '203.0.113.1' })).status, 401);
    assert.equal((await post(rt.baseUrl, { 'X-Forwarded-For': '203.0.113.1' })).status, 429, 'same client, same bucket');
    assert.equal(
      (await post(rt.baseUrl, { 'X-Forwarded-For': '203.0.113.2' })).status, 401,
      'a different client must have its own bucket, not inherit the first one',
    );
  } finally {
    await rt.stop();
  }
});

test('clientIp trusts X-Forwarded-For only from a loopback peer', () => {
  const { _clientIp } = require(path.join(REPO_ROOT, 'server.js'));
  assert.ok(typeof _clientIp === 'function', '_clientIp must be exported for testing');

  const mk = (remoteAddress, xff) => ({
    socket: { remoteAddress },
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });

  // Loopback peer = our own Apache → the header is trustworthy.
  assert.equal(_clientIp(mk('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(_clientIp(mk('::1', '203.0.113.9')), '203.0.113.9');
  assert.equal(_clientIp(mk('::ffff:127.0.0.1', '203.0.113.9')), '203.0.113.9');
  // Proxy chains list the origin client first.
  assert.equal(_clientIp(mk('127.0.0.1', '203.0.113.9, 10.0.0.1')), '203.0.113.9');

  // Direct (non-loopback) peer: the header is caller-controlled. Trusting it would
  // let one attacker mint a fresh bucket per request and bypass the limit entirely.
  assert.equal(_clientIp(mk('198.51.100.7', '203.0.113.9')), '198.51.100.7');
  assert.equal(_clientIp(mk('198.51.100.7')), '198.51.100.7');
});
