#!/usr/bin/env node
'use strict';

/**
 * fusion.test.js — hybrid-recall RRF fusion + lexical ranking (src/fusion.js)
 * and the text_search builder (src/format.js). Pure functions; no Qdrant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { rrfFuse, lexicalRank, lexicalScore, hybridFuse, tokenize } = require('../.experience/src/fusion.js');
const { buildTextSearch } = require('../.experience/src/format.js');

const pt = (id, extra = {}) => ({ id, payload: { json: JSON.stringify({ solution: `s-${id}`, ...extra }) } });
const lexPt = (id, text, extra = {}) => ({ id, payload: { text_search: text, json: JSON.stringify({ solution: `s-${id}`, ...extra }) } });

test('rrfFuse: appearing in both lists outranks appearing in one', () => {
  const a = [pt('A'), pt('B'), pt('C')];   // ranks 1,2,3
  const b = [pt('B'), pt('D')];            // B again (rank 1), D (rank 2)
  const fused = rrfFuse([a, b]);
  // B is in both → highest fused score → first.
  assert.equal(fused[0].id, 'B');
  // All unique ids present, deduped.
  assert.deepEqual([...new Set(fused.map(p => p.id))].sort(), ['A', 'B', 'C', 'D']);
  assert.equal(fused.length, 4);
  // Every fused point carries _rrfScore, descending.
  for (let i = 1; i < fused.length; i++) assert.ok(fused[i - 1]._rrfScore >= fused[i]._rrfScore);
});

test('rrfFuse: a top-ranked item in only one list still rises', () => {
  const vector = [pt('V1'), pt('V2'), pt('V3'), pt('V4')];
  const lexical = [pt('L1')]; // rank 1 in lexical only
  const fused = rrfFuse([vector, lexical]);
  // L1 (rank1 in lexical) should beat V2/V3/V4 (ranks 2,3,4 in vector).
  const pos = id => fused.findIndex(p => p.id === id);
  assert.ok(pos('L1') < pos('V2'));
  assert.ok(pos('L1') < pos('V4'));
});

test('lexicalScore / lexicalRank: term overlap orders candidates, zero-score dropped', () => {
  const tokens = tokenize('restart the experience engine server');
  assert.ok(lexicalScore('how to restart the server process', tokens) > 0);
  assert.equal(lexicalScore('totally unrelated content here', tokens), 0);

  const ranked = lexicalRank([
    lexPt('hit2', 'restart the server and restart again'),     // 'restart' x2 + 'server'
    lexPt('hit1', 'server configuration notes'),               // 'server' x1
    lexPt('none', 'unrelated text about cats'),                // no overlap → dropped
  ], 'restart server');
  assert.deepEqual(ranked.map(p => p.id), ['hit2', 'hit1']);
  assert.ok(!ranked.find(p => p.id === 'none'));
});

test('hybridFuse: vector-origin keeps cosine score; lexical-only gets indicative score', () => {
  const vector = [
    { id: 'V', score: 0.82, payload: { json: JSON.stringify({ solution: 'vec' }) } },
  ];
  const lexical = [lexPt('Lonly', 'exact identifier MUONROI_CATALOG_API_KEY match')];
  const fused = hybridFuse(vector, lexical, 'MUONROI_CATALOG_API_KEY');

  const v = fused.find(p => p.id === 'V');
  const l = fused.find(p => p.id === 'Lonly');
  assert.equal(v.score, 0.82, 'vector-origin point keeps its real cosine for display');
  assert.ok(!v._lexicalOnly);
  assert.ok(l, 'lexical-only exact-term match surfaces (vector leg missed it)');
  assert.equal(l.score, 0.5, 'lexical-only point gets the indicative display score');
  assert.equal(l._lexicalOnly, true);
});

test('hybridFuse: empty lexical leg degrades to vector order', () => {
  const vector = [
    { id: 'A', score: 0.9, payload: { json: '{}' } },
    { id: 'B', score: 0.5, payload: { json: '{}' } },
  ];
  const fused = hybridFuse(vector, [], 'anything');
  assert.deepEqual(fused.map(p => p.id), ['A', 'B']);
});

test('hybridFuse preranked: native sparse leg used as-is (no app-side re-rank)', () => {
  // The sparse leg comes pre-scored + pre-ordered from Qdrant. With preranked,
  // hybridFuse must trust that order (S2 deliberately precedes the higher-id S1)
  // and NOT run lexicalRank (which needs payload.text_search these points lack).
  const vector = [{ id: 'V', score: 0.7, payload: { json: '{}' } }];
  const sparse = [
    { id: 'S2', score: 9.1, payload: { json: '{}' } }, // sparse rank 1
    { id: 'S1', score: 4.2, payload: { json: '{}' } }, // sparse rank 2
  ];
  const fused = hybridFuse(vector, sparse, 'qq', { preranked: true });
  // S2 (sparse rank 1) outranks S1 (sparse rank 2) in the fused result.
  const pos = id => fused.findIndex(p => p.id === id);
  assert.ok(pos('S2') < pos('S1'), 'pre-ranked sparse order preserved');
  // Lexical-only sparse points still surface (vector leg missed them).
  assert.ok(pos('S2') !== -1 && pos('S1') !== -1);
});

test('buildTextSearch: concatenates searchable fields, normalizes whitespace, caps length', () => {
  const data = {
    trigger: 'When  running   tests', question: 'how to fix flaky?',
    solution: 'use deterministic waits', judgment: 'prefer explicit sync',
    failureMode: 'race condition', principle: '', other: 'ignored',
  };
  const ts = buildTextSearch(data);
  assert.match(ts, /when running tests/);          // whitespace collapsed
  assert.match(ts, /deterministic waits/);
  assert.match(ts, /race condition/);
  assert.ok(!/ignored/.test(ts), 'only the searchable fields are included');
  assert.ok(buildTextSearch({}).length === 0);
  assert.ok(buildTextSearch(null) === '');
  // length cap
  const big = buildTextSearch({ solution: 'x'.repeat(5000) });
  assert.ok(big.length <= 2000);
});
