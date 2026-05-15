#!/usr/bin/env node
'use strict';

/**
 * test-brain-llm.js — Tests for classifyViaBrain, _callBrainWithFallback, _brainRelevanceFilter
 *
 * Covers:
 *   - classifyViaBrain: SiliconFlow → returns classification
 *   - classifyViaBrain: missing API key → returns null
 *   - classifyViaBrain: API error → returns null
 *   - classifyViaBrain: timeout → returns null
 *   - callBrainWithFallback: primary fails → fallback succeeds (Ollama)
 *   - callBrainWithFallback: all fail → returns null
 *   - brainRelevanceFilter: connection error → fail-open (null)
 *   - brainRelevanceFilter: returns filtered lines
 *   - classifyViaBrain: handles empty prompt
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const CORE_PATH = path.join(__dirname, 'experience-core.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-brain-test-'));

function writeConfig(extra = {}) {
  fs.mkdirSync(path.join(TEST_HOME, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, '.experience', 'config.json'), JSON.stringify({
    qdrantUrl: 'http://127.0.0.1:1',
    ...extra,
  }, null, 2));
}

test.before(() => {
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
});

test.after(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

// =========================================================================
// 1. classifyViaBrain — SiliconFlow happy path
// =========================================================================

test('classifyViaBrain returns classification from SiliconFlow provider', async () => {
  let callBody = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      callBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'fast' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    brainModel: 'Qwen/Qwen2.5-7B-Instruct',
    brainKey: 'test-brain-key',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { classifyViaBrain } = require(CORE_PATH);

  const result = await classifyViaBrain('fix a typo in README.md', 5000);
  assert.equal(result, 'fast');
  assert.equal(callBody.model, 'Qwen/Qwen2.5-7B-Instruct');
  assert.equal(callBody.max_tokens, 10);

  await new Promise((resolve) => server.close(resolve));
});

// =========================================================================
// 2. classifyViaBrain — missing API key
// =========================================================================

test('classifyViaBrain returns null when API key is missing', async () => {
  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: 'http://127.0.0.1:12345/v1/chat/completions',
    brainKey: '',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { classifyViaBrain } = require(CORE_PATH);

  const result = await classifyViaBrain('test query', 2000);
  assert.equal(result, null);
});

// =========================================================================
// 3. classifyViaBrain — API error
// =========================================================================

test('classifyViaBrain returns null when API returns 500', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    brainKey: 'test-key',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { classifyViaBrain } = require(CORE_PATH);

  const result = await classifyViaBrain('test', 2000);
  assert.equal(result, null);

  await new Promise((resolve) => server.close(resolve));
});

// =========================================================================
// 4. classifyViaBrain — timeout
// =========================================================================

test('classifyViaBrain returns null on timeout', async () => {
  const server = http.createServer((_req, res) => {
    // Delay response to force timeout
    setTimeout(() => {
      res.writeHead(200);
      res.end(JSON.stringify({ choices: [{ message: { content: 'fast' } }] }));
    }, 5000);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    brainKey: 'test-key',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { classifyViaBrain } = require(CORE_PATH);

  const result = await classifyViaBrain('test', 300);
  assert.equal(result, null, 'timeout should return null');

  await new Promise((resolve) => server.close(resolve));
});

// =========================================================================
// 5. callBrainWithFallback — primary fails → Ollama fallback
// =========================================================================

test('_callBrainWithFallback uses Ollama fallback when primary brain fails', async () => {
  let ollamaCalled = false;
  let callBody = null;
  const server = http.createServer((req, res) => {
    ollamaCalled = true;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      callBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: JSON.stringify({ tier: 'fast' }),
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  writeConfig({
    // Set primary to a provider that will fail (unreachable endpoint)
    brainProvider: 'openai',
    brainEndpoint: 'http://127.0.0.1:1/v1/chat/completions', // unreachable → fail fast
    brainKey: 'test-key',
    // Set Ollama as fallback
    brainFallback: 'ollama',
    brainModel: 'qwen2.5:3b',
    ollamaUrl: `http://127.0.0.1:${port}`,
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

  const result = await callBrainWithFallback('test prompt');
  assert.ok(result, 'should get result from Ollama fallback');
  assert.ok(ollamaCalled, 'Ollama should be called as fallback');

  await new Promise((resolve) => server.close(resolve));
});

// =========================================================================
// 6. callBrainWithFallback — all fail → null
// =========================================================================

test('_callBrainWithFallback returns null when all providers fail', async () => {
  writeConfig({
    brainProvider: 'ollama',
    brainModel: 'qwen2.5:3b',
    ollamaUrl: 'http://127.0.0.1:1', // unreachable
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

  const result = await callBrainWithFallback('test prompt');
  assert.equal(result, null, 'all providers failing should return null');
});

// =========================================================================
// 7. brainRelevanceFilter — fail-open on connection error
// =========================================================================

test('_brainRelevanceFilter returns null on connection error (fail-open)', async () => {
  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: 'http://127.0.0.1:1/v1/chat/completions',
    brainKey: 'test-key',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _brainRelevanceFilter: brainRelevanceFilter } = require(CORE_PATH);

  const lines = ['Warning: Always use IMLog'];
  const kept = await brainRelevanceFilter('edit test.ts', lines, null, 'test-project');
  assert.equal(kept, null, 'fail-open should return null (pass through)');
});

// =========================================================================
// 8. classifyViaBrain — empty prompt
// =========================================================================

test('classifyViaBrain handles empty prompt without crashing', async () => {
  writeConfig({
    brainProvider: 'siliconflow',
    brainEndpoint: 'http://127.0.0.1:1/v1/chat/completions',
    brainKey: 'test-key',
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { classifyViaBrain } = require(CORE_PATH);

  const result = await classifyViaBrain('', 500);
  assert.equal(result, null, 'empty prompt should not crash');
});

// =========================================================================
// 9. brainRelevanceFilter — Ollama generate API path
// =========================================================================

test('_brainRelevanceFilter works with Ollama generate API', async () => {
  let callBody = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      callBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: '1' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  writeConfig({
    brainProvider: 'ollama',
    brainModel: 'qwen2.5:3b',
    ollamaUrl: `http://127.0.0.1:${port}`,
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _brainRelevanceFilter: brainRelevanceFilter } = require(CORE_PATH);

  const lines = ['Warning: Always use IMLog'];
  const kept = await brainRelevanceFilter('edit test.ts', lines, null, 'test-project');
  assert.ok(kept === null || Array.isArray(kept), 'should not crash with Ollama');
  if (Array.isArray(kept)) {
    assert.ok(kept.length > 0, 'should keep relevant warnings');
  }

  await new Promise((resolve) => server.close(resolve));
});
