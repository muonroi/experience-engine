#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function createTempHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-server-auth-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
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

function makeJsonRequest(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  return req;
}

function makeJsonResponse() {
  let statusCode = null;
  let payload = '';
  return {
    writeHead(status) {
      statusCode = status;
    },
    end(chunk) {
      payload += chunk || '';
    },
    get statusCode() {
      return statusCode;
    },
    json() {
      return JSON.parse(payload || '{}');
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
  assert.equal(serverModule.isReadOnlyApiPath('/api/stats'), true);
  assert.equal(serverModule.isReadOnlyApiPath('/api/user'), false);
  const core = serverModule.loadExperienceCore();
  assert.equal(typeof core.intercept, 'function');
});

test('POST /api/intercept reuses loaded core and returns hook-mode route null', async () => {
  const serverModule = require(path.join(REPO_ROOT, 'server.js'));
  const corePath = path.join(REPO_ROOT, '.experience', 'experience-core.js');
  const core = serverModule.loadExperienceCore();
  const originalInterceptWithMeta = core.interceptWithMeta;
  let called = 0;
  core.interceptWithMeta = async (toolName, toolInput, _signal, meta) => {
    called += 1;
    assert.equal(toolName, 'UserPrompt');
    assert.equal(toolInput.command, 'fix hook fast path');
    assert.equal(meta.sourceKind, 'codex-hook');
    return {
      suggestions: '💡 [Suggestion] cached core response',
      surfacedIds: [{ collection: 'experience-selfqa', id: 'cached-1' }],
      route: null,
    };
  };

  try {
    const req = makeJsonRequest({
      toolName: 'UserPrompt',
      toolInput: { command: 'fix hook fast path' },
      sourceKind: 'codex-hook',
      sourceRuntime: 'codex-wsl',
      sourceSession: 'server-intercept-test',
      cwd: '/repo/experience-engine',
    });
    const res = makeJsonResponse();
    const started = Date.now();
    await serverModule.handleIntercept(req, res);
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(called, 1, 'handleIntercept should use the already loaded module instance');
    assert.ok(Date.now() - started < 1000, 'hook-mode server intercept should not block on a fresh module load');
    assert.equal(body.suggestions, '💡 [Suggestion] cached core response');
    assert.equal(body.hasSuggestions, true);
    assert.deepEqual(body.surfacedIds, [{ collection: 'experience-selfqa', id: 'cached-1' }]);
    assert.equal(body.route, null);
    assert.equal(require.cache[require.resolve(corePath)]?.exports.interceptWithMeta, core.interceptWithMeta);
  } finally {
    core.interceptWithMeta = originalInterceptWithMeta;
  }
});

test('POST /api/prompt-stale calls loaded core helper and returns bounded result', async () => {
  const serverModule = require(path.join(REPO_ROOT, 'server.js'));
  const core = serverModule.loadExperienceCore();
  const originalHelper = core._reconcileStalePromptSuggestions;
  let called = 0;
  core._reconcileStalePromptSuggestions = async (state, nextPromptMeta) => {
    called += 1;
    assert.equal(state.tool, 'UserPrompt');
    assert.equal(nextPromptMeta.prompt, 'next prompt');
    return {
      ok: true,
      unused: [{ collection: 'experience-selfqa', id: 'prompt-stale-1', reason: 'unused' }],
      irrelevant: [],
      expired: [],
      extraIgnored: true,
    };
  };

  try {
    const req = makeJsonRequest({
      state: {
        ts: new Date(Date.now() - 11_000).toISOString(),
        tool: 'UserPrompt',
        sourceHook: 'UserPromptSubmit',
        surfacedIds: [{ collection: 'experience-selfqa', id: 'prompt-stale-1' }],
      },
      nextPromptMeta: {
        prompt: 'next prompt',
        cwd: '/repo/experience-engine',
        sourceKind: 'codex-hook',
      },
    });
    const res = makeJsonResponse();
    await serverModule.handlePromptStale(req, res);
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(called, 1);
    assert.deepEqual(body, {
      ok: true,
      unused: [{ collection: 'experience-selfqa', id: 'prompt-stale-1', reason: 'unused' }],
      irrelevant: [],
      expired: [],
    });
  } finally {
    core._reconcileStalePromptSuggestions = originalHelper;
  }
});

test('POST /api/extract forwards source metadata to core extraction', async () => {
  const serverModule = require(path.join(REPO_ROOT, 'server.js'));
  const core = serverModule.loadExperienceCore();
  const originalExtract = core.extractFromSession;
  let called = 0;
  core.extractFromSession = async (transcript, projectPath, meta) => {
    called += 1;
    assert.equal(transcript, 'ToolOutput: permission denied\nToolCall Bash: chmod 600 /tmp/key');
    assert.equal(projectPath, '/repo/experience-engine');
    assert.deepEqual(meta, {
      sourceKind: 'stop-hook',
      sourceRuntime: 'codex-wsl',
      sourceSession: 'session-extract-1',
    });
    return 1;
  };

  try {
    const req = makeJsonRequest({
      transcript: 'ToolOutput: permission denied\nToolCall Bash: chmod 600 /tmp/key',
      projectPath: '/repo/experience-engine',
      sourceKind: 'stop-hook',
      sourceRuntime: 'codex-wsl',
      sourceSession: 'session-extract-1',
    });
    const res = makeJsonResponse();
    await serverModule.handleExtract(req, res);
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(called, 1);
    assert.deepEqual(body, { stored: 1, success: true });
  } finally {
    core.extractFromSession = originalExtract;
  }
});

test('read auth token only unlocks observability endpoints', async () => {
  const token = 'test-server-token';
  const readToken = 'test-read-token';
  const runtime = await startServer({
    server: { authToken: token, readAuthToken: readToken },
    serverAuthToken: token,
    serverReadAuthToken: readToken,
  });

  try {
    const statsRead = await fetch(`${runtime.baseUrl}/api/stats`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    assert.equal(statsRead.status, 200);

    const userRead = await fetch(`${runtime.baseUrl}/api/user`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    assert.equal(userRead.status, 401);

    const timelineRead = await fetch(`${runtime.baseUrl}/api/timeline?topic=test`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    assert.equal(timelineRead.status, 401);
  } finally {
    await runtime.stop();
  }
});
