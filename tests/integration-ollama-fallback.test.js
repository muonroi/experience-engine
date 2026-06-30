#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE_PATH = path.join(__dirname, '..', '.experience', 'experience-core.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ollama-fallback-test-'));

let ollamaBehavior = 'success'; // 'success' | 'timeout' | 'error'
let geminiCalled = false;
let ollamaCalled = false;

// Mock the global fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const urlString = typeof url === 'string' ? url : url.href || String(url);

  if (urlString.includes('11434') || urlString.includes('ollama')) {
    ollamaCalled = true;
    if (ollamaBehavior === 'timeout') {
      // Simulate timeout by throwing AbortError
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (ollamaBehavior === 'error') {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Internal Server Error'
      };
    }
    return {
      ok: true,
      json: async () => ({ response: '{"tier": "ollama-success"}' })
    };
  }

  if (urlString.includes('generativelanguage.googleapis.com')) {
    geminiCalled = true;
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '{"tier": "gemini-fallback-success"}' }] }
        }]
      })
    };
  }

  return originalFetch(url, options);
};

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
  globalThis.fetch = originalFetch;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

test.beforeEach(() => {
  ollamaBehavior = 'success';
  geminiCalled = false;
  ollamaCalled = false;
});

// =========================================================================
// 1. Ollama Happy Path
// =========================================================================
test('Ollama primary call succeeds and does not invoke Gemini fallback', async () => {
  writeConfig({
    brainProvider: 'ollama',
    brainFallback: 'gemini',
    ollamaUrl: 'http://localhost:11434',
    brainKey: 'test-gemini-key'
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

  const result = await callBrainWithFallback('test prompt');
  assert.deepEqual(result, { tier: 'ollama-success' });
  assert.ok(ollamaCalled, 'Ollama should be called');
  assert.ok(!geminiCalled, 'Gemini fallback should NOT be called');
});

// =========================================================================
// 2. Ollama Timeout → Gemini Fallback
// =========================================================================
test('Ollama timeout triggers Gemini fallback transition', async () => {
  ollamaBehavior = 'timeout';

  writeConfig({
    brainProvider: 'ollama',
    brainFallback: 'gemini',
    ollamaUrl: 'http://localhost:11434',
    brainKey: 'test-gemini-key'
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

  const result = await callBrainWithFallback('test prompt');
  assert.deepEqual(result, { tier: 'gemini-fallback-success' });
  assert.ok(ollamaCalled, 'Ollama should have been attempted');
  assert.ok(geminiCalled, 'Gemini fallback should have been triggered');
});

// =========================================================================
// 3. Ollama Error → Gemini Fallback
// =========================================================================
test('Ollama connection/HTTP error triggers Gemini fallback transition', async () => {
  ollamaBehavior = 'error';

  writeConfig({
    brainProvider: 'ollama',
    brainFallback: 'gemini',
    ollamaUrl: 'http://localhost:11434',
    brainKey: 'test-gemini-key'
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

  const result = await callBrainWithFallback('test prompt');
  assert.deepEqual(result, { tier: 'gemini-fallback-success' });
  assert.ok(ollamaCalled, 'Ollama should have been attempted');
  assert.ok(geminiCalled, 'Gemini fallback should have been triggered');
});

// =========================================================================
// 4. Relevance Filter Ollama Failure → Fallback to raw Qdrant search (Fail-open)
// =========================================================================
test('Ollama relevance filter failure fails-open to Qdrant search results', async () => {
  ollamaBehavior = 'timeout';

  writeConfig({
    brainProvider: 'ollama',
    ollamaUrl: 'http://localhost:11434'
  });

  delete require.cache[require.resolve(CORE_PATH)];
  const { _brainRelevanceFilter: brainRelevanceFilter } = require(CORE_PATH);

  const warnings = [
    '💡 [Suggestion]: Always use AddScoped for DbContext [id:1 col:experience-behavioral]'
  ];
  
  const kept = await brainRelevanceFilter('add DbContext to DI', warnings, null, 'test-project');
  assert.equal(kept, null, 'Relevance filter should return null (fail-open) on error');
  assert.ok(ollamaCalled, 'Ollama relevance filter should be attempted');
});

// =========================================================================
// 5. Complete Fallback Failure → Returns null
// =========================================================================
test('Returns null when both primary and fallback brains fail', async () => {
  ollamaBehavior = 'error';
  // Mock fetch to fail for Gemini too
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return {
      ok: false,
      status: 500,
      text: async () => 'Error'
    };
  };

  try {
    writeConfig({
      brainProvider: 'ollama',
      brainFallback: 'gemini',
      ollamaUrl: 'http://localhost:11434',
      brainKey: 'test-gemini-key'
    });

    delete require.cache[require.resolve(CORE_PATH)];
    const { _callBrainWithFallback: callBrainWithFallback } = require(CORE_PATH);

    const result = await callBrainWithFallback('test prompt');
    assert.equal(result, null, 'Should return null when fallback also fails');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
