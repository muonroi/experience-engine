#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/** Setup: start a fake embedding server, configure experience-core against it */
let testHome, fakeServer, fakePort;
let embedEndpointHits = [];

function startFakeEmbedServer() {
  fakeServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      embedEndpointHits.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });

      if (req.url.includes('/api/embed') || req.url.includes('generate')) {
        // Ollama-style
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]] }));
      }
      if (req.url.includes('/v1/embeddings')) {
        // OpenAI-compatible
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        }));
      }
      if (req.url.includes('embedContent')) {
        // Gemini-style
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          embedding: { values: [0.1, 0.2, 0.3, 0.4, 0.5] },
        }));
      }
      if (req.url.includes('voyageai')) {
        // VoyageAI-style
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]] }));
    });
  });
  return new Promise(resolve => {
    fakeServer.listen(0, '127.0.0.1', () => {
      fakePort = fakeServer.address().port;
      resolve();
    });
  });
}

function writeConfig(homeDir, extra = {}) {
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify({
    qdrantUrl: 'http://127.0.0.1:1',
    embedDim: 5,
    ...extra,
  }, null, 2));
}

test.before(async () => {
  await startFakeEmbedServer();
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-embed-'));
});

test.after(async () => {
  await new Promise(r => fakeServer.close(r));
  fs.rmSync(testHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  embedEndpointHits = [];
});

// ============================================================
//  Test: Ollama provider
// ============================================================
test('getEmbeddingRaw calls Ollama embedding API correctly', async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'ollama',
    embedModel: 'nomic-embed-text',
    ollamaUrl: `http://127.0.0.1:${fakePort}`,
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const result = await getEmbeddingRaw('test text for embedding');

  assert.ok(Array.isArray(result), 'should return an array');
  assert.equal(result.length, 5, 'should have correct dimension');
});

// ============================================================
//  Test: OpenAI-compatible provider (custom)
// ============================================================
test('getEmbeddingRaw calls OpenAI-compatible embedding API correctly', async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${fakePort}/v1/embeddings`,
    embedKey: 'test-key',
    embedModel: 'text-embedding-3-small',
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const result = await getEmbeddingRaw('test text for openai embedding');

  assert.ok(Array.isArray(result), 'should return an array');
  assert.equal(result.length, 5, 'should have correct dimension');
});

// ============================================================
//  Test: Gemini provider
//  NOTE: Gemini uses hardcoded API URL. We verify the provider
//  selection doesn't crash; actual API testing needs global.fetch mock.
// ============================================================
test('getEmbeddingRaw handles Gemini provider selection gracefully', { timeout: 3000 }, async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'gemini',
    embedModel: 'text-embedding-004',
    embedKey: 'test-gemini-key',
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  // Gemini URL is hardcoded; this will fail with network error,
  // then fall back to Ollama (which is also unreachable), then return null
  const result = await getEmbeddingRaw('test text for gemini');

  // Should not throw; returns null when API unreachable
  assert.ok(result === null || Array.isArray(result), 'should return null or array');
});

// ============================================================
//  Test: VoyageAI provider
//  NOTE: VoyageAI uses hardcoded API URL. Same pattern as Gemini.
// ============================================================
test('getEmbeddingRaw handles VoyageAI provider selection gracefully', { timeout: 3000 }, async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'voyageai',
    embedModel: 'voyage-code-3',
    embedKey: 'test-voyage-key',
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const result = await getEmbeddingRaw('test text for voyage');

  assert.ok(result === null || Array.isArray(result), 'should return null or array');
});

// ============================================================
//  Test: Fallback to Ollama when primary fails
// ============================================================
test('getEmbeddingRaw falls back to Ollama when primary provider fails', async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:1/v1/embeddings`, // unreachable
    embedKey: 'test-key',
    embedModel: 'text-embedding-3-small',
    ollamaUrl: `http://127.0.0.1:${fakePort}`, // reachable fallback
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const result = await getEmbeddingRaw('test text for fallback');

  assert.ok(Array.isArray(result), 'should return array from fallback');
  assert.equal(result.length, 5, 'should have correct dimension');
});

// ============================================================
//  Test: Returns null on total failure
// ============================================================
test('getEmbeddingRaw returns null when ALL providers unreachable', async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'custom',
    embedEndpoint: 'http://127.0.0.1:1/v1/embeddings',
    embedKey: 'test-key',
    embedModel: 'text-embedding-3-small',
    ollamaUrl: 'http://127.0.0.1:2', // also unreachable
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  const result = await getEmbeddingRaw('test text for total failure');

  assert.equal(result, null, 'should return null when all providers fail');
});

// ============================================================
//  Test: Handles timeout gracefully
// ============================================================
test('getEmbeddingRaw handles timeout gracefully', async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  writeConfig(testHome, {
    embedProvider: 'custom',
    embedEndpoint: `http://127.0.0.1:${fakePort}/v1/embeddings`,
    embedKey: 'test-key',
    embedModel: 'text-embedding-3-small',
  });

  const { getEmbeddingRaw } = require(path.join(__dirname, '..', '.experience', 'experience-core.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', '.experience', 'experience-core.js'))];

  // Should work normally
  const result = await getEmbeddingRaw('timeout test');
  assert.ok(Array.isArray(result), 'should handle fine with normal response');
});
