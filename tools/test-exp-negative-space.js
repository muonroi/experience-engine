#!/usr/bin/env node
/**
 * test-exp-negative-space.js — unit tests for the negative-space search tool.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  parseSinceCutoff,
  readEvents,
  findVetoPairs,
  buildQueryString,
  searchNearMisses,
} = require('./exp-negative-space.js');

// ─── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs threshold/top/collection options', () => {
  const a = parseArgs(['--threshold', '0.5', '--top', '10', '--collection', 'a,b']);
  assert.strictEqual(a.threshold, 0.5);
  assert.strictEqual(a.topK, 10);
  assert.deepStrictEqual(a.collections, ['a', 'b']);
});

test('parseArgs since + out + paths', () => {
  const a = parseArgs(['/tmp/s.jsonl', '--since', '7d', '--out', 'g.json']);
  assert.deepStrictEqual(a.paths, ['/tmp/s.jsonl']);
  assert.strictEqual(a.since, '7d');
  assert.strictEqual(a.out, 'g.json');
});

// ─── parseSinceCutoff ─────────────────────────────────────────────────────────

test('parseSinceCutoff returns ms cutoff', () => {
  const ms = parseSinceCutoff('30d');
  assert.ok(Math.abs(ms - (Date.now() - 30 * 86400000)) < 2000);
});

test('parseSinceCutoff null/invalid', () => {
  assert.strictEqual(parseSinceCutoff(null), null);
  assert.strictEqual(parseSinceCutoff('xx'), null);
});

// ─── readEvents ───────────────────────────────────────────────────────────────

test('readEvents parses valid lines and skips malformed', () => {
  const tmp = path.join(os.tmpdir(), `ns-test-${process.pid}.jsonl`);
  fs.writeFileSync(tmp,
    JSON.stringify({ kind: 'intercept', toolName: 'Edit' }) + '\n' +
    'malformed\n' +
    JSON.stringify({ kind: 'posttool', mistakeKind: 'user-veto' }) + '\n',
    'utf8',
  );
  try {
    const evs = readEvents(tmp);
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[1].mistakeKind, 'user-veto');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readEvents on missing file returns empty', () => {
  assert.deepStrictEqual(readEvents('/no/such/file'), []);
});

// ─── findVetoPairs ────────────────────────────────────────────────────────────

test('findVetoPairs pairs veto posttool with upstream intercept of same tool', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit', matchIds: ['x'] },
    { ts: '2026-05-07T00:00:01.000Z', kind: 'posttool', toolName: 'Edit', mistakeKind: 'user-veto' },
  ];
  const pairs = findVetoPairs(events);
  assert.strictEqual(pairs.length, 1);
  assert.deepStrictEqual(pairs[0].intercept.matchIds, ['x']);
});

test('findVetoPairs returns null intercept when out of window', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit' },
    { ts: '2026-05-07T00:02:00.000Z', kind: 'posttool', toolName: 'Edit', mistakeKind: 'user-veto' }, // 120s
  ];
  const pairs = findVetoPairs(events);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].intercept, null);
});

test('findVetoPairs ignores non-veto posttool', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit' },
    { ts: '2026-05-07T00:00:01.000Z', kind: 'posttool', toolName: 'Edit', success: true },
  ];
  assert.strictEqual(findVetoPairs(events).length, 0);
});

// ─── buildQueryString ─────────────────────────────────────────────────────────

test('buildQueryString concatenates toolName + JSON.stringify(toolInput)', () => {
  const q = buildQueryString('Edit', { file_path: 'src/foo.ts' });
  assert.ok(q.startsWith('Edit:'));
  assert.ok(q.includes('src/foo.ts'));
});

test('buildQueryString handles string toolInput', () => {
  const q = buildQueryString('Bash', 'ls -la');
  assert.strictEqual(q, 'Bash: ls -la');
});

test('buildQueryString caps at 2000 chars', () => {
  const long = 'x'.repeat(5000);
  const q = buildQueryString('Bash', long);
  assert.ok(q.length <= 2000);
});

// ─── searchNearMisses ─────────────────────────────────────────────────────────

test('searchNearMisses excludes already-fired IDs and applies threshold', async () => {
  const stubCore = {
    getEmbeddingRaw: async () => [0.1, 0.2, 0.3],
    searchCollection: async (col) => {
      // Three points: above, below threshold, and one already fired.
      return [
        { id: 'kept-id', score: 0.6, payload: { json: JSON.stringify({ solution: 'do X', confidence: 0.8 }) } },
        { id: 'below-id', score: 0.2, payload: { json: JSON.stringify({ solution: 'low' }) } },
        { id: 'fired-id', score: 0.7, payload: { json: JSON.stringify({ solution: 'already shown' }) } },
      ];
    },
  };
  const results = await searchNearMisses({
    core: stubCore,
    query: 'q',
    alreadyFired: ['fired-id'],
    collections: ['code'],
    threshold: 0.4,
    topK: 5,
  });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].id, 'kept-id');
  assert.strictEqual(results[0].score, 0.6);
  assert.strictEqual(results[0].confidence, 0.8);
});

test('searchNearMisses returns [] when embedding unavailable', async () => {
  const stubCore = { getEmbeddingRaw: async () => null, searchCollection: async () => [] };
  const r = await searchNearMisses({
    core: stubCore, query: 'q', alreadyFired: [],
    collections: ['code'], threshold: 0.4, topK: 5,
  });
  assert.deepStrictEqual(r, []);
});

test('searchNearMisses sorts results by score desc and respects topK', async () => {
  const stubCore = {
    getEmbeddingRaw: async () => [0.1],
    searchCollection: async () => [
      { id: 'a', score: 0.5, payload: { json: '{}' } },
      { id: 'b', score: 0.9, payload: { json: '{}' } },
      { id: 'c', score: 0.7, payload: { json: '{}' } },
    ],
  };
  const r = await searchNearMisses({
    core: stubCore, query: 'q', alreadyFired: [],
    collections: ['code'], threshold: 0.4, topK: 2,
  });
  assert.deepStrictEqual(r.map(x => x.id), ['b', 'c']);
});

test('searchNearMisses survives a collection that throws', async () => {
  const stubCore = {
    getEmbeddingRaw: async () => [0.1],
    searchCollection: async (col) => {
      if (col === 'broken') throw new Error('qdrant down');
      return [{ id: 'x', score: 0.6, payload: { json: '{}' } }];
    },
  };
  const r = await searchNearMisses({
    core: stubCore, query: 'q', alreadyFired: [],
    collections: ['broken', 'ok'], threshold: 0.4, topK: 5,
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 'x');
});
