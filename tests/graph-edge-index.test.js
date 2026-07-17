#!/usr/bin/env node
'use strict';

/**
 * graph-edge-index.test.js
 *
 * Regression guard for the recall event-loop stall.
 *
 * `getEdgesForId` used to call `fileStoreRead(EDGE_COLLECTION)` on every
 * invocation — a full `readFileSync` + `JSON.parse` of the entire edge store,
 * followed by a `JSON.parse` of every edge payload. `experience-core.js` calls
 * it twice per surfaced point across ~45 points, i.e. ~90 full read+parse
 * cycles per recall. Measured against the production store (2.57MB / 6534
 * edges) that is ~28.8ms each = ~2.6s of uninterrupted synchronous blocking per
 * recall, which starved the event loop so hard that even the static
 * `GET /api/version` handler timed out for ~17s under 3 concurrent recalls.
 *
 * These tests pin the two properties that fix requires:
 *   1. Repeated lookups read the edge file at most once (index is cached).
 *   2. The cache still observes writes (no stale reads).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GRAPH_PATH = path.join(__dirname, '..', '.experience', 'src', 'graph.js');
const CONFIG_PATH = path.join(__dirname, '..', '.experience', 'src', 'config.js');
const QDRANT_PATH = path.join(__dirname, '..', '.experience', 'src', 'qdrant.js');

let testHome;

function storeDir() {
  return path.join(testHome, '.experience', 'store', 'default');
}

function writeEdges(edges) {
  fs.mkdirSync(storeDir(), { recursive: true });
  const entries = edges.map((e, i) => ({
    id: `edge-${i}`,
    vector: [],
    payload: { json: JSON.stringify(e) },
  }));
  fs.writeFileSync(path.join(storeDir(), 'experience-edges.json'), JSON.stringify(entries, null, 2));
}

/** Fresh module graph so cache state never leaks between tests. */
function loadGraph() {
  for (const p of [GRAPH_PATH, CONFIG_PATH, QDRANT_PATH]) delete require.cache[require.resolve(p)];
  return require(GRAPH_PATH);
}

/** Count readFileSync calls that touch the edge store. */
function countEdgeReads(fn) {
  const orig = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).includes('experience-edges')) count++;
    return orig.call(this, file, ...rest);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = orig;
  }
  return count;
}

test.before(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-graph-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
  fs.writeFileSync(
    path.join(testHome, '.experience', 'config.json'),
    JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1', embedDim: 5 }, null, 2),
  );
});

test.after(() => {
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test('getEdgesForId returns edges touching the id in either direction', () => {
  writeEdges([
    { source: 'a', target: 'b', type: 'supersedes' },
    { source: 'b', target: 'c', type: 'relates-to' },
    { source: 'x', target: 'y', type: 'contradicts' },
  ]);
  const { getEdgesForId } = loadGraph();

  const forB = getEdgesForId('b');
  assert.equal(forB.length, 2, 'b appears as target once and source once');
  assert.deepEqual(forB.map(e => e.type).sort(), ['relates-to', 'supersedes']);

  assert.equal(getEdgesForId('y').length, 1);
  assert.equal(getEdgesForId('nobody').length, 0);
});

test('repeated getEdgesForId reads the edge store at most once (no 90x re-parse)', () => {
  writeEdges(Array.from({ length: 500 }, (_, i) => ({
    source: `s${i}`, target: `t${i}`, type: 'relates-to',
  })));
  const { getEdgesForId } = loadGraph();

  // Mirrors the real hot path: experience-core.js calls this ~90x per recall.
  const reads = countEdgeReads(() => {
    for (let i = 0; i < 90; i++) getEdgesForId(`t${i % 500}`);
  });

  assert.ok(reads <= 1, `expected <=1 edge-store read across 90 lookups, got ${reads}`);
});

test('getEdgesOfType is likewise indexed, not re-read per call', () => {
  writeEdges(Array.from({ length: 200 }, (_, i) => ({
    source: `s${i}`, target: `t${i}`, type: i % 2 ? 'supersedes' : 'relates-to',
  })));
  const { getEdgesOfType } = loadGraph();

  const reads = countEdgeReads(() => {
    for (let i = 0; i < 50; i++) getEdgesOfType('supersedes');
  });

  assert.ok(reads <= 1, `expected <=1 edge-store read across 50 lookups, got ${reads}`);
  assert.equal(getEdgesOfType('supersedes').length, 100);
});

test('cache observes external writes (no stale reads)', () => {
  writeEdges([{ source: 'a', target: 'b', type: 'relates-to' }]);
  const { getEdgesForId } = loadGraph();
  assert.equal(getEdgesForId('b').length, 1);

  // Another process appends an edge. Size changes, so a stat-keyed cache must
  // notice even if mtime granularity is coarse.
  writeEdges([
    { source: 'a', target: 'b', type: 'relates-to' },
    { source: 'c', target: 'b', type: 'supersedes' },
  ]);

  assert.equal(getEdgesForId('b').length, 2, 'stale cache — write was not observed');
});

test('createEdge invalidates the index', () => {
  writeEdges([{ source: 'a', target: 'b', type: 'relates-to' }]);
  const { createEdge, getEdgesForId } = loadGraph();
  assert.equal(getEdgesForId('z').length, 0);

  createEdge('z', 'b', 'supersedes');

  const forZ = getEdgesForId('z');
  assert.equal(forZ.length, 1, 'index did not pick up the edge createEdge just wrote');
  assert.equal(forZ[0].type, 'supersedes');
});

test('missing edge store degrades to empty, not a throw', () => {
  try { fs.unlinkSync(path.join(storeDir(), 'experience-edges.json')); } catch {}
  const { getEdgesForId } = loadGraph();
  assert.deepEqual(getEdgesForId('anything'), []);
});
