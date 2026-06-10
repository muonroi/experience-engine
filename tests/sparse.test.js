#!/usr/bin/env node
'use strict';

/**
 * sparse.test.js — BM25 sparse-vector builder (src/sparse.js) + the Qdrant
 * sparse query/support wiring (src/qdrant.js) request shapes (mocked fetch).
 *
 * Qdrant supplies the idf weighting + scoring; we only emit {indices, values}
 * where values are raw term frequencies and indices are stable FNV-1a hashes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSparseVector, fnv1a32, rawTokens, SPARSE_VECTOR_NAME, MAX_TERMS } = require('../.experience/src/sparse.js');

test('fnv1a32: deterministic, unsigned 32-bit, distinct for distinct tokens', () => {
  const a = fnv1a32('restart');
  assert.equal(a, fnv1a32('restart'), 'stable for same input');
  assert.ok(a >= 0 && a <= 0xffffffff, 'unsigned 32-bit');
  assert.ok(Number.isInteger(a));
  assert.notEqual(fnv1a32('restart'), fnv1a32('server'));
});

test('buildSparseVector: counts term frequency into values, aligned arrays', () => {
  const v = buildSparseVector('restart server restart again restart');
  assert.equal(v.indices.length, v.values.length);
  // 3 distinct tokens: restart(3), server(1), again(1)
  assert.equal(v.indices.length, 3);
  const idxRestart = fnv1a32('restart');
  const pos = v.indices.indexOf(idxRestart);
  assert.ok(pos !== -1, 'restart present');
  assert.equal(v.values[pos], 3, 'tf for restart == 3');
  const total = v.values.reduce((a, b) => a + b, 0);
  assert.equal(total, 5, 'total tf == token count');
});

test('buildSparseVector: empty / token-less text → empty vector', () => {
  assert.deepEqual(buildSparseVector(''), { indices: [], values: [] });
  assert.deepEqual(buildSparseVector('  - / .. '), { indices: [], values: [] });
  assert.deepEqual(buildSparseVector(null), { indices: [], values: [] });
});

test('buildSparseVector: drops sub-2-char tokens (matches lexical tokenizer)', () => {
  const v = buildSparseVector('a bb ccc');
  // 'a' dropped; 'bb' + 'ccc' kept
  assert.equal(v.indices.length, 2);
  assert.ok(rawTokens('a bb ccc').every(t => t.length >= 2));
});

test('buildSparseVector: caps distinct terms at MAX_TERMS, keeping highest tf', () => {
  // Build text with MAX_TERMS+50 unique tokens; one token repeated heavily must survive the cap.
  const uniques = [];
  for (let i = 0; i < MAX_TERMS + 50; i++) uniques.push(`tok${i}`);
  const heavy = ('hot ').repeat(20); // tf=20, must be retained
  const v = buildSparseVector(heavy + uniques.join(' '));
  assert.ok(v.indices.length <= MAX_TERMS, 'capped');
  const hotPos = v.indices.indexOf(fnv1a32('hot'));
  assert.ok(hotPos !== -1, 'highest-tf term retained under cap');
  assert.equal(v.values[hotPos], 20);
});

test('SPARSE_VECTOR_NAME is the agreed name', () => {
  assert.equal(SPARSE_VECTOR_NAME, 'text_bm25');
});

// ---- Qdrant wiring (mocked fetch) ----

const path = require('path');
const QPATH = path.join(__dirname, '..', '.experience', 'src', 'qdrant.js');

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

test('searchCollectionSparse: builds {query:{indices,values}, using:text_bm25} sparse query', async () => {
  delete require.cache[require.resolve(QPATH)];
  const qdrant = require(QPATH);
  qdrant.setQdrantAvailable(true);
  qdrant.invalidateSparseSupport();

  let queryBody = null;
  await withMockFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/collections/experience-behavioral') && (!init || init.method === undefined || init.method === 'GET')) {
      // support probe → collection HAS sparse config
      return { ok: true, json: async () => ({ result: { config: { params: { sparse_vectors: { text_bm25: { modifier: 'idf' } } } } } }) };
    }
    if (u.includes('/points/query')) {
      queryBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ result: { points: [{ id: 'x', score: 7.7, payload: { json: '{}' } }] } }) };
    }
    return { ok: true, json: async () => ({ result: {} }) };
  }, async () => {
    const res = await qdrant.searchCollectionSparse('experience-behavioral', 'restart the server', 10);
    assert.equal(res.length, 1);
    assert.equal(res[0].score, 7.7);
    assert.equal(queryBody.using, 'text_bm25');
    assert.ok(Array.isArray(queryBody.query.indices) && Array.isArray(queryBody.query.values));
    assert.ok(queryBody.query.indices.length > 0);
  });
});

test('searchCollectionSparse: returns [] when collection lacks sparse config (pre-migration)', async () => {
  delete require.cache[require.resolve(QPATH)];
  const qdrant = require(QPATH);
  qdrant.setQdrantAvailable(true);
  qdrant.invalidateSparseSupport();

  let queriedPoints = false;
  await withMockFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/collections/experience-behavioral')) {
      // dense-only collection → no sparse_vectors
      return { ok: true, json: async () => ({ result: { config: { params: { vectors: { size: 1024 } } } } }) };
    }
    if (u.includes('/points/query')) { queriedPoints = true; return { ok: true, json: async () => ({ result: { points: [] } }) }; }
    return { ok: true, json: async () => ({ result: {} }) };
  }, async () => {
    const res = await qdrant.searchCollectionSparse('experience-behavioral', 'restart the server', 10);
    assert.deepEqual(res, []);
    assert.equal(queriedPoints, false, 'must not issue a sparse query when unsupported');
  });
});

test('searchCollectionSparse: returns [] for token-less query (no sparse dims)', async () => {
  delete require.cache[require.resolve(QPATH)];
  const qdrant = require(QPATH);
  qdrant.setQdrantAvailable(true);
  const res = await qdrant.searchCollectionSparse('experience-behavioral', '  -- // ', 10);
  assert.deepEqual(res, []);
});
