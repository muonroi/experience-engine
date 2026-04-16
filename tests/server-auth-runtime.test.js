#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function createTempHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-server-auth-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.experience', 'config.json'),
    JSON.stringify(config, null, 2)
  );
  return homeDir;
}

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

test('protected GET endpoints require auth when token is configured', async () => {
  const token = 'test-server-token';
  const runtime = await startServer({
    server: { authToken: token },
    serverAuthToken: token,
  });

  try {
    const healthRes = await fetch(`${runtime.baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    const statsUnauthorized = await fetch(`${runtime.baseUrl}/api/stats`);
    assert.equal(statsUnauthorized.status, 401);
    assert.deepEqual(await statsUnauthorized.json(), { error: 'Unauthorized' });

    const statsAuthorized = await fetch(`${runtime.baseUrl}/api/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(statsAuthorized.status, 200);

    const userUnauthorized = await fetch(`${runtime.baseUrl}/api/user`);
    assert.equal(userUnauthorized.status, 401);

    const userAuthorized = await fetch(`${runtime.baseUrl}/api/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(userAuthorized.status, 200);
  } finally {
    await runtime.stop();
  }
});

test('server resolves runtime helpers from the repo .experience directory', () => {
  const serverModule = require(path.join(REPO_ROOT, 'server.js'));
  assert.equal(serverModule.RUNTIME_DIR, path.join(REPO_ROOT, '.experience'));
  assert.equal(serverModule.isProtectedGetPath('/health'), false);
  assert.equal(serverModule.isProtectedGetPath('/api/stats'), true);
  const core = serverModule.loadExperienceCore();
  assert.equal(typeof core.intercept, 'function');
});
