#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let testHome;
let fakeServer;
let fakePort;
let brainResponses = [];

function writeConfig(extra = {}) {
  fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(testHome, '.experience', 'config.json'), JSON.stringify({
    qdrantUrl: `http://127.0.0.1:${fakePort}`,
    qdrantKey: 'test-key',
    user: 'default',
    brainProvider: 'custom',
    brainEndpoint: `http://127.0.0.1:${fakePort}/v1/chat/completions`,
    brainKey: 'test-brain-key',
    ...extra,
  }, null, 2));
}

function startFakeServer() {
  fakeServer = http.createServer((req, res) => {
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
        const next = brainResponses.shift() || { route: 'qc-flow', confidence: 0.61, needs_disambiguation: false, reason: 'default fake brain', options: [] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }],
        }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: req.url, body: raw ? JSON.parse(raw) : null }));
    });
  });

  return new Promise((resolve) => {
    fakeServer.listen(0, '127.0.0.1', () => {
      fakePort = fakeServer.address().port;
      resolve();
    });
  });
}

test.before(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-route-task-home-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  await startFakeServer();
  writeConfig();
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('routeTask returns normalized brain verdict with disambiguation options', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeTask } = require(CORE_PATH);

  brainResponses.push({
    route: null,
    confidence: 0.32,
    needs_disambiguation: true,
    reason: 'The task intent is ambiguous.',
    options: [
      { id: 'plan-research', label: 'Plan and research first', route: 'qc-flow', description: 'Clarify and inspect before coding.' },
      { id: 'implement-now', label: 'Implement a narrow change', route: 'qc-lock', description: 'Treat as a bounded implementation.' },
      { id: 'explain-only', label: 'Explain or analyze', route: 'direct', description: 'Answer directly without workflow state.' },
      { id: 'free-text', label: 'Enter a different task', route: 'free-text', description: 'Provide a clearer task.' }
    ]
  });

  const result = await routeTask('làm phần này cho ổn nhé', {
    localRoute: 'qc-flow',
    localReason: 'Task is ambiguous.',
  }, 'codex');

  assert.equal(result.source, 'brain');
  assert.equal(result.route, null);
  assert.equal(result.needs_disambiguation, true);
  assert.equal(result.options.length, 4);
  assert.equal(result.options[0].route, 'qc-flow');
  assert.equal(result.options[1].route, 'qc-lock');
});

test('routeTask prefilters Vietnamese narrow execution requests to qc-lock without waiting for brain classification', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeTask } = require(CORE_PATH);

  const result = await routeTask('sửa lỗi chính tả trong README.md', null, 'codex');
  assert.equal(result.route, 'qc-lock');
  assert.equal(result.source, 'keyword');
  assert.equal(result.needs_disambiguation, false);
});

test('routeTask prefilters Vietnamese read-only questions to direct', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeTask } = require(CORE_PATH);

  const result = await routeTask('giải thích kiến trúc hiện tại của wrapper', null, 'codex');
  assert.equal(result.route, 'direct');
  assert.equal(result.source, 'keyword');
  assert.equal(result.needs_disambiguation, false);
});

test('routeModel uses Codex-supported fast tier model mapping', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeModel } = require(CORE_PATH);

  brainResponses.push('fast');
  const result = await routeModel('fix a typo in README.md', null, 'codex');
  assert.equal(result.tier, 'fast');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.reasoningEffort, 'medium');
  assert.equal(result.source, 'brain');
});

test('sourceRuntime codex-wsl resolves to codex runtime for remote hook requests', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { _resolveRuntimeFromSourceMeta } = require(CORE_PATH);

  assert.equal(
    _resolveRuntimeFromSourceMeta({ sourceRuntime: 'codex-wsl' }, 'claude'),
    'codex'
  );
  assert.equal(
    _resolveRuntimeFromSourceMeta({ sourceRuntime: 'codex-windows' }, 'claude'),
    'codex'
  );
  assert.equal(
    _resolveRuntimeFromSourceMeta({ sourceRuntime: 'claude-code' }, 'codex'),
    'claude'
  );
});

test('routeModel caps qc-flow clarify tasks to balanced for codex when brain overcalls premium', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeModel } = require(CORE_PATH);

  brainResponses.push('premium');
  const result = await routeModel(
    'I have a repository called Storyflow. Please explore it and review its anti-bot feature. I also have two Strong Crawler repositories—use them as a basis for evaluation.',
    { gate: 'clarify', domain: 'qc-flow', phase: 'P1 / W0', projectSlug: 'Core' },
    'codex'
  );

  assert.equal(result.tier, 'balanced');
  assert.equal(result.model, 'gpt-5.3-codex');
  assert.equal(result.reasoningEffort, 'medium');
  assert.equal(result.source, 'brain');
  assert.match(result.reason, /cost cap applied/);
});

test('routeModel keeps premium for qc-flow clarify tasks when explicit premium signals exist', async () => {
  const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
  delete require.cache[require.resolve(CORE_PATH)];
  const { routeModel } = require(CORE_PATH);

  brainResponses.push('premium');
  const result = await routeModel(
    'Perform a multi-file security audit for a breaking migration across the authentication architecture.',
    { gate: 'clarify', domain: 'qc-flow', phase: 'P1 / W0', projectSlug: 'Core' },
    'codex'
  );

  assert.equal(result.tier, 'premium');
  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.reasoningEffort, 'high');
  assert.equal(result.source, 'brain');
});
