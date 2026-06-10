#!/usr/bin/env node
'use strict';

/**
 * project-brief.test.js — Project Brief builder (SessionStart breadth digest).
 *
 * Runs in FileStore mode (Qdrant unreachable) so it is hermetic and offline.
 * Covers: confidence×hits×recency ranking order, project-scope filtering,
 * universal (scope.lang='all') inclusion, 1-line [id col] format, and the
 * server-side TTL cache.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Env must be set BEFORE requiring the runtime modules (config reads it at load).
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-brief-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.EXPERIENCE_BRIEF_TTL_MS = '600000';
fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
fs.writeFileSync(
  path.join(testHome, '.experience', 'config.json'),
  JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1' }), // unreachable → FileStore
  'utf8'
);

const scoring = require('../.experience/src/scoring');
const qdrant = require('../.experience/src/qdrant');
const brief = require('../.experience/src/brief');

const NOW = new Date().toISOString();
function entry(id, data) {
  return { id, vector: [0.1, 0.2, 0.3], payload: { json: JSON.stringify(data) } };
}

// proj-a: A (high conf, many hits), B (low conf, few hits)
// proj-b: C (must be excluded for a proj-a brief)
// scope.lang='all': D (universal — must appear in every project's brief)
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';

qdrant.fileStoreWrite('experience-behavioral', [
  entry(A, { trigger: 'edit config', solution: 'restart the service', scope: { project_slug: 'proj-a' }, _projectSlug: 'proj-a', confidence: 0.9, hitCount: 10, surfaceCount: 20, lastHitAt: NOW, confirmedAt: [], createdAt: NOW }),
  entry(B, { trigger: 'run unit tests', solution: 'use vitest run', scope: { project_slug: 'proj-a' }, _projectSlug: 'proj-a', confidence: 0.6, hitCount: 1, surfaceCount: 20, lastHitAt: NOW, confirmedAt: [], createdAt: NOW }),
  entry(C, { trigger: 'cross repo fact', solution: 'should NOT appear', scope: { project_slug: 'proj-b' }, _projectSlug: 'proj-b', confidence: 0.95, hitCount: 50, surfaceCount: 20, lastHitAt: NOW, confirmedAt: [], createdAt: NOW }),
  entry(D, { trigger: 'always log caught errors', solution: 'never swallow', scope: { lang: 'all' }, confidence: 0.7, hitCount: 3, surfaceCount: 20, lastHitAt: NOW, confirmedAt: [], createdAt: NOW }),
]);
qdrant.fileStoreWrite('experience-principles', []);
qdrant.fileStoreWrite('experience-selfqa', []);

test('computeBriefScore ranks higher confidence + more hits above lower', () => {
  const a = scoring.computeBriefScore({ confidence: 0.9, hitCount: 10, surfaceCount: 20, lastHitAt: NOW });
  const b = scoring.computeBriefScore({ confidence: 0.6, hitCount: 1, surfaceCount: 20, lastHitAt: NOW });
  assert.ok(a > b, `expected A(${a}) > B(${b})`);
});

test('briefRecencyFactor rewards recent and discounts stale', () => {
  const recent = scoring.briefRecencyFactor({ lastHitAt: NOW });
  const stale = scoring.briefRecencyFactor({ lastHitAt: new Date(Date.now() - 200 * 86400000).toISOString() });
  assert.ok(recent > stale);
  assert.equal(recent, 1.10);
  assert.equal(stale, 0.70);
});

test('buildProjectBrief scopes to the project + universal rules, excludes other projects', async () => {
  brief._clearBriefCache();
  const res = await brief.buildProjectBrief('proj-a');
  const ids = res.entries.map(e => e.id);
  assert.equal(res.projectSlug, 'proj-a');
  assert.equal(res.count, 3, `expected 3 entries, got ${res.count}: ${ids}`);
  assert.ok(ids.includes(A) && ids.includes(B), 'proj-a entries must be present');
  assert.ok(ids.includes(D), 'universal scope.lang=all entry must be present');
  assert.ok(!ids.includes(C), 'cross-project entry must be excluded');
});

test('buildProjectBrief orders by confidence×hits×recency (A > D > B)', async () => {
  brief._clearBriefCache();
  const res = await brief.buildProjectBrief('proj-a');
  assert.deepEqual(res.entries.map(e => e.id), [A, D, B]);
});

test('brief text is a header + one [id col]-tagged line per entry', async () => {
  brief._clearBriefCache();
  const res = await brief.buildProjectBrief('proj-a');
  const lines = res.text.split('\n');
  assert.match(lines[0], /^\[Project Brief\] proj-a — top 3 learned facts/);
  const lineRe = /^- .+ \[id:[0-9a-f]{8} col:\S+\]$/;
  for (const line of lines.slice(1)) {
    assert.match(line, lineRe, `line did not match index format: ${line}`);
  }
});

test('empty/unknown slug returns null text, no throw', async () => {
  const res = await brief.buildProjectBrief('');
  assert.equal(res.text, null);
  assert.equal(res.count, 0);
});

test('server-side cache returns cached result within TTL, fresh bypasses it', async () => {
  brief._clearBriefCache();
  const first = await brief.buildProjectBrief('proj-a');
  assert.equal(first.cached, false);
  const second = await brief.buildProjectBrief('proj-a');
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  const fresh = await brief.buildProjectBrief('proj-a', { fresh: true });
  assert.equal(fresh.cached, false);
});

test.after(() => {
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});
