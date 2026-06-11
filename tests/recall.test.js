#!/usr/bin/env node
'use strict';

/**
 * recall.test.js — /api/recall (active agent self-query) + exp-recall helper.
 *
 * The endpoint is a thin wrapper over the already-tested interceptWithMeta
 * pipeline (which records SURFACE for returned entries). Here we cover the
 * wiring that is recall-specific: auth, request validation, graceful empty
 * (embedding/qdrant unavailable), response shape, and the CLI helper's
 * argument parsing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const { parseArgs } = require('../.experience/exp-recall.js');
const { formatPoints } = require('../.experience/src/format.js');
const { rerankByQuality, floatRunbooks, isRunbookPoint } = require('../.experience/src/scoring.js');
const { getMinSearchScore, getMinConfidence } = require('../.experience/src/config.js');

// Build a formatPoints-ready point. `eff` is the display/effective score the
// recall path would carry (raw cosine in recall mode). Confidence defaults high
// enough to clear GATE 1 regardless of host config (grace path floors at base).
function makePoint(id, eff, payloadOverrides = {}) {
  const data = Object.assign(
    { solution: `do thing ${id}`, confidence: 0.9, hitCount: 0, surfaceCount: 0 },
    payloadOverrides,
  );
  return { id, _effectiveScore: eff, _collection: 'experience-behavioral', score: eff, payload: { json: JSON.stringify(data) } };
}

// ----------------------------- helper unit tests -----------------------------

test('exp-recall parseArgs: joins query words, parses flags', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--json', '--project', 'experience-engine', 'how', 'to', 'restart']);
  assert.equal(r.ok, true);
  assert.equal(r.query, 'how to restart');
  assert.equal(r.opts.json, true);
  assert.equal(r.opts.project, 'experience-engine');
});

test('exp-recall parseArgs: no query → not ok', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--json']);
  assert.equal(r.ok, false);
  assert.ok(r.help.includes('Usage'));
});

test('exp-recall parseArgs: --help → ok=false code 0', () => {
  const r = parseArgs(['node', 'exp-recall.js', '--help']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 0);
});

// --------------------- semantic-search mode (recallMode) ----------------------

test('formatPoints: below-floor point dropped by default, kept with skipSearchScoreGate', () => {
  const below = getMinSearchScore() - 0.1;        // e.g. 0.30 vs 0.40 floor
  const pt = makePoint('aaaaaaaa', below);

  // Default (passive-hint path): GATE 2 drops it.
  assert.equal(formatPoints([pt]).length, 0);

  // Active recall: floor bypassed → surfaces.
  const kept = formatPoints([pt], { skipSearchScoreGate: true });
  assert.equal(kept.length, 1);
  assert.match(kept[0], /\[id:aaaaaaaa col:experience-behavioral\]/);
});

test('formatPoints: integrity gates still drop even with skipSearchScoreGate', () => {
  const above = getMinSearchScore() + 0.1;         // clearly above floor — only integrity can drop
  const opts = { skipSearchScoreGate: true };

  const superseded = makePoint('b0000000', above, { superseded: true });
  const permanentNoise = makePoint('b1000000', above, { ignoreCount: 25, hitCount: 0 });
  const irrelevant = makePoint('b2000000', above, { irrelevantCount: 3 });
  // Below min-confidence: surfaced before (surfaceCount>3) + negative signal → ageFactor decays effConf.
  const lowConf = makePoint('b3000000', above, { confidence: 0.1, surfaceCount: 5, hitCount: 0, ignoreCount: 2 });
  assert.ok(getMinConfidence() > 0.1 * (0.7 + 0 * 0.06)); // sanity: fixture really is below floor

  for (const pt of [superseded, permanentNoise, irrelevant, lowConf]) {
    assert.equal(formatPoints([pt], opts).length, 0, `expected ${pt.id} dropped by integrity gate`);
  }

  // Control: a clean above-floor point with the same opts DOES surface.
  assert.equal(formatPoints([makePoint('b4000000', above)], opts).length, 1);
});

test('floatRunbooks: floats a runbook above same/higher-cosine atomic siblings, stable otherwise', () => {
  // merged recall order is cosine-descending; the runbook sits BELOW two atomic
  // entries. After floating it must lead, and the atomic entries keep their order.
  const atomicHi = makePoint('a1111111', 0.71);
  const atomicMid = makePoint('a2222222', 0.55);
  const runbook = makePoint('rb000000', 0.50, { nodeKind: 'runbook', derivedFromId: ['a1111111', 'a2222222'] });
  const merged = [atomicHi, atomicMid, runbook];

  assert.equal(isRunbookPoint(runbook), true);
  assert.equal(isRunbookPoint(atomicHi), false);

  const ordered = floatRunbooks(merged);
  assert.deepEqual(ordered.map((p) => p.id), ['rb000000', 'a1111111', 'a2222222']);
});

test('floatRunbooks: no runbook present → identity (order untouched)', () => {
  const merged = [makePoint('a1111111', 0.71), makePoint('a2222222', 0.55)];
  assert.deepEqual(floatRunbooks(merged).map((p) => p.id), ['a1111111', 'a2222222']);
});

test('floatRunbooks: multiple runbooks keep their mutual (cosine) order at the front', () => {
  const rbHi = makePoint('rb111111', 0.62, { nodeKind: 'runbook' });
  const atomic = makePoint('a2222222', 0.60);
  const rbLo = makePoint('rb333333', 0.40, { nodeKind: 'runbook' });
  const ordered = floatRunbooks([rbHi, atomic, rbLo]);
  assert.deepEqual(ordered.map((p) => p.id), ['rb111111', 'rb333333', 'a2222222']);
});

test('rerankByQuality rawCosineRank: orders by raw cosine and differs from default', () => {
  // A: high cosine, low confidence. B: low cosine, high confidence.
  const pts = [
    { id: 'A', score: 0.80, payload: { json: JSON.stringify({ solution: 'a', confidence: 0.2, surfaceCount: 0, hitCount: 0 }) } },
    { id: 'B', score: 0.45, payload: { json: JSON.stringify({ solution: 'b', confidence: 0.95, surfaceCount: 0, hitCount: 0 }) } },
  ];

  const raw = rerankByQuality(pts, null, null, 'q', { rawCosineRank: true });
  assert.deepEqual(raw.map(p => p.id), ['A', 'B']);            // pure cosine order
  assert.equal(raw[0]._effectiveScore, 0.80);                 // effective == raw cosine
  assert.equal(raw[1]._effectiveScore, 0.45);

  // Default path applies confidence weighting / penalties → effective != raw cosine.
  const def = rerankByQuality(pts, null, null, 'q');
  assert.ok(def.some(p => p._effectiveScore !== (p.score)), 'default mode must reweight, not pass cosine through');
});

test('rerankByQuality preserveOrder: keeps input (RRF-fused) order, still sets _effectiveScore', () => {
  // Input order is the fused order; a lower-cosine item deliberately precedes a
  // higher-cosine one. preserveOrder must NOT re-sort.
  const pts = [
    { id: 'X', score: 0.30, payload: { json: JSON.stringify({ solution: 'x', confidence: 0.9 }) } },
    { id: 'Y', score: 0.90, payload: { json: JSON.stringify({ solution: 'y', confidence: 0.9 }) } },
  ];
  const out = rerankByQuality(pts, null, null, 'q', { preserveOrder: true });
  assert.deepEqual(out.map(p => p.id), ['X', 'Y'], 'fused order preserved (no re-sort)');
  assert.equal(out[0]._effectiveScore, 0.30);
  assert.equal(out[1]._effectiveScore, 0.90);
});

test('formatPoints footer: one compact line closes the loop with all three verdicts', () => {
  const lines = formatPoints([makePoint('cccccccc', getMinSearchScore() + 0.2)]);
  assert.equal(lines.length, 1);
  const out = lines[0];
  // Single compact feedback line lists followed|ignored|noise + id + collection.
  assert.match(out, /exp-feedback\.js followed\|ignored\|noise cccccccc experience-behavioral/);
  // Stays one line (multi-line footer overflowed budgetChars) — only the [id] +
  // feedback lines are appended after the body, so total newlines stay small.
  assert.ok((out.match(/exp-feedback\.js/g) || []).length === 1, 'exactly one feedback command line');
});

// --------------------------- server integration ------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 5000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server not healthy within ${timeoutMs}ms`);
}

async function startServer(config) {
  const port = await getFreePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, EXP_SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString('utf8'); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForHealth(baseUrl); }
  catch (e) { child.kill('SIGTERM'); throw new Error(`${e.message}\n${stderr}`.trim()); }
  return {
    baseUrl, child,
    async stop() { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); fs.rmSync(homeDir, { recursive: true, force: true }); },
  };
}

test('/api/recall: auth, validation, and graceful empty response', async () => {
  const token = 'recall-test-token';
  const rt = await startServer({
    server: { authToken: token },
    serverAuthToken: token,
    qdrantUrl: 'http://127.0.0.1:1', // unreachable → FileStore (empty) ; no embed provider → graceful empty
  });
  try {
    // No auth → 401
    const noAuth = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
    });
    assert.equal(noAuth.status, 401);

    // Authed, missing query → 400
    const noQuery = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({}),
    });
    assert.equal(noQuery.status, 400);
    assert.match((await noQuery.json()).error || '', /query is required/);

    // Authed, valid query, no embed/qdrant data → 200 with well-formed empty result
    const ok = await fetch(`${rt.baseUrl}/api/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'how do we restart the server', cwd: '/repo/experience-engine' }),
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.query, 'how do we restart the server');
    assert.ok(Array.isArray(payload.entries));
    assert.equal(typeof payload.count, 'number');
    assert.ok('text' in payload);
  } finally {
    await rt.stop();
  }
});
