#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const spawnProbe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
const CHILD_BLOCKED = !!spawnProbe.error;
const SHARED_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const listenProbe = CHILD_BLOCKED ? { status: 1 } : spawnSync(
  process.execPath,
  ['-e', "const http=require('http');const server=http.createServer(()=>{});server.once('error',()=>process.exit(1));server.listen(0,'127.0.0.1',()=>server.close(()=>process.exit(0)));"],
  { encoding: 'utf8' }
);
const SERVER_BLOCKED = CHILD_BLOCKED || listenProbe.status !== 0;
const REMOTE_POSITIVE_SKIP = SERVER_BLOCKED
  ? 'sandbox blocks local test server or child node processes'
  : SHARED_CI
    ? 'shared CI runner is too timing-sensitive for positive remote hook loopback checks'
    : false;

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-remote-hooks-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  return homeDir;
}

function copyRuntime(homeDir, files) {
  for (const file of files) {
    fs.copyFileSync(path.join(__dirname, file), path.join(homeDir, '.experience', file));
  }
}

function writeConfig(homeDir, config) {
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(config, null, 2));
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runHook(homeDir, scriptName, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = nowMs();
    const child = spawn(process.execPath, [path.join(homeDir, '.experience', scriptName)], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        EXPERIENCE_HOOK_DEBUG_LOG: path.join(homeDir, '.experience', 'tmp', 'debug.jsonl'),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hook ${scriptName} timed out`));
    }, 8000);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        durationMs: nowMs() - startedAt,
      });
    });

    child.stdin.end(JSON.stringify(input));
  });
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function parseHookJson(result) {
  return JSON.parse(result.stdout || '{}');
}

function extractHookText(payload) {
  return payload.systemMessage || payload.hookSpecificOutput?.additionalContext || '';
}

test('remote interceptor and posttool hooks proxy through VPS APIs', { skip: REMOTE_POSITIVE_SKIP }, async () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor.js', 'interceptor-post.js', 'remote-client.js']);

  const received = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/intercept') {
        res.end(JSON.stringify({
          suggestions: '⚠️ [Experience] Remote warning',
          hasSuggestions: true,
          surfacedIds: [{ collection: 'experience-behavioral', id: 'remote-1', solution: 'remote warning' }],
          route: { tier: 'balanced', model: 'gpt-test', confidence: 0.8, source: 'history' },
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, reconcile: { touched: [], pending: [], implicitUnused: [], expired: [] }, judgeQueued: true }));
    });
  });
  writeConfig(homeDir, {
    serverBaseUrl: `http://127.0.0.1:${port}`,
    serverHookTimeoutMs: 3000,
  });

  try {
    const pre = await runHook(homeDir, 'interceptor.js', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'dotnet test' },
      cwd: '/repo/storyflow',
    }, {
      EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS: '5000',
      EXPERIENCE_HOOK_HARD_EXIT_TIMEOUT_MS: '7000',
    });
    assert.equal(pre.status, 0);
    const preOut = parseHookJson(pre);
    assert.match(extractHookText(preOut), /Remote warning/);
    assert.equal(received[0].url, '/api/intercept');
    assert.equal(received[0].body.cwd, '/repo/storyflow');

    const statePath = path.join(homeDir, '.experience', 'tmp', 'last-suggestions.json');
    assert.equal(fs.existsSync(statePath), true);

    const post = await runHook(homeDir, 'interceptor-post.js', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'dotnet test' },
      tool_response: { output: 'ok' },
      cwd: '/repo/storyflow',
    });
    assert.equal(post.status, 0);
    assert.equal(received[1].url, '/api/posttool');
    assert.equal(received[1].body.surfacedIds.length, 1);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    server.close();
  }
});

test('remote prompt hook proxies prompt search to VPS', { skip: REMOTE_POSITIVE_SKIP }, async () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-prompt.js', 'remote-client.js']);

  const received = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        suggestions: '💡 [Suggestion] Remote prompt hint',
        hasSuggestions: true,
        surfacedIds: [],
        route: null,
      }));
    });
  });
  writeConfig(homeDir, {
    serverBaseUrl: `http://127.0.0.1:${port}`,
    serverHookTimeoutMs: 3000,
  });

  try {
    const result = await runHook(homeDir, 'interceptor-prompt.js', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-2',
      user_prompt: 'please fix the failing tests in storyflow',
      cwd: '/repo/storyflow',
    }, {
      EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS: '5000',
      EXPERIENCE_HOOK_HARD_EXIT_TIMEOUT_MS: '7000',
    });
    assert.equal(result.status, 0);
    const promptOut = parseHookJson(result);
    const promptText = extractHookText(promptOut);
    if (promptOut.hookSpecificOutput?.hookEventName) {
      assert.equal(promptOut.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    }
    assert.match(promptText, /Remote prompt hint/);
    assert.equal(received[0].url, '/api/intercept');
    assert.equal(received[0].body.toolName, 'UserPrompt');
  } finally {
    server.close();
  }
});

test('remote PreToolUse hook exits quickly when VPS intercept is slow', { skip: SERVER_BLOCKED ? 'sandbox blocks local test server or child node processes' : false }, async () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor.js', 'remote-client.js']);

  const { server, port } = await startServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        suggestions: 'late',
        hasSuggestions: true,
        surfacedIds: [],
        route: null,
      }));
    }, 4000);
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}`, serverTimeoutMs: 5000 });

  try {
    const result = await runHook(homeDir, 'interceptor.js', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-slow-pre',
      tool_name: 'Bash',
      tool_input: { command: 'dotnet test' },
      cwd: '/repo/storyflow',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.durationMs < 3500, `expected hook to exit quickly, got ${result.durationMs}ms`);
  } finally {
    server.close();
  }
});

test('remote PostToolUse hook queues when VPS posttool is slow', { skip: SERVER_BLOCKED ? 'sandbox blocks local test server or child node processes' : false }, async () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-post.js', 'remote-client.js']);

  const tmpDir = path.join(homeDir, '.experience', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'last-suggestions.json'), JSON.stringify({
    ts: new Date().toISOString(),
    tool: 'Bash',
    surfacedIds: [{ collection: 'experience-behavioral', id: 'slow-1' }],
  }));

  const { server, port } = await startServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 4000);
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}`, serverTimeoutMs: 5000 });

  try {
    const result = await runHook(homeDir, 'interceptor-post.js', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-slow-post',
      tool_name: 'Bash',
      tool_input: { command: 'dotnet test' },
      tool_response: { output: 'ok' },
      cwd: '/repo/storyflow',
    });
    assert.equal(result.status, 0);
    assert.ok(result.durationMs < 3500, `expected hook to exit quickly, got ${result.durationMs}ms`);
    const queueDir = path.join(homeDir, '.experience', 'offline-queue');
    const queued = fs.readdirSync(queueDir).filter((name) => name.endsWith('.json'));
    assert.equal(queued.length, 1);
  } finally {
    server.close();
  }
});

test('remote stop-extractor posts transcript to VPS instead of local core', { skip: SERVER_BLOCKED ? 'sandbox blocks local test server or child node processes' : false }, async () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['stop-extractor.js', 'remote-client.js', 'extract-compact.js']);
  const received = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stored: 3, success: true }));
    });
  });
  writeConfig(homeDir, { serverBaseUrl: `http://127.0.0.1:${port}` });

  const sessionPath = path.join(homeDir, '.codex', 'sessions', '2026', '04', '14', 'rollout-remote.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo/storyflow' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please fix tests' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"dotnet test /repo/storyflow/StoryFlow.sln"}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'Chunk ID: 1\\nOutput:\\nerror: build failed\\nFAIL StoryFlow.Tests' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'I will patch the failing file.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{"path":"/repo/storyflow/src/App.cs","patch":"*** Begin Patch"}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'Chunk ID: 2\\nOutput:\\nSuccess. Updated file' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'no, use the other file instead' } }),
  ].join('\n'));
  fs.utimesSync(sessionPath, Date.now() / 1000, Date.now() / 1000);

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(homeDir, '.experience', 'stop-extractor.js')], {
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('hook timeout: stop-extractor.js'));
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
    assert.equal(received[0].url, '/api/extract');
    assert.equal(received[0].body.projectPath, '/repo/storyflow');
    assert.match(received[0].body.transcript, /ToolCall Bash: dotnet test/);
    assert.equal(fs.existsSync(path.join(homeDir, '.experience', '.stop-marker.json')), true);
  } finally {
    server.close();
  }
});
