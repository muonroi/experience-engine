#!/usr/bin/env node
'use strict';

// betaEvidence bookkeeping (spec §3 B1, §5 "betaEvidence"): per-source weights,
// one outcome per (session, point) with priority replacement, the seed rule,
// initialisation before mutation, re-import preservation and the --beta reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-beta-ev-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const CONFIG = path.join(HOME, '.experience', 'config.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
process.env.EXPERIENCE_CONFIG_PATH = CONFIG;
process.env.EXPERIENCE_ACTIVITY_LOG = path.join(HOME, 'activity.jsonl');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, '.experience', 'src');
const config = require(path.join(SRC, 'config.js'));
const hittrack = require(path.join(SRC, 'hittrack.js'));
const session = require(path.join(SRC, 'session.js'));
const evolution = require(path.join(SRC, 'evolution.js'));
const betaEvidence = require(path.join(SRC, 'beta-evidence.js'));
const { resetPointData } = require(path.join(ROOT, 'tools', 'exp-reset-ignore-count.js'));

function setConfig(obj) {
  fs.writeFileSync(CONFIG, JSON.stringify(obj));
  config.refreshConfig();
}

const entry = (extra = {}) => ({ id: 'p1', solution: 's', createdFrom: 'session-extractor', confidence: 0.6, hitCount: 0, validatedCount: 0, ignoreCount: 0, ...extra });
const ev = (data) => data.betaEvidence;

test.beforeEach(() => setConfig({ qdrantUrl: 'http://127.0.0.1:1' }));
test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

test('per-source weights: manual 1.0, judge 0.7, implicit touch 0.2, implicit noise 0.3, organic 0.3', () => {
  const manual = hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: 'a' })(entry());
  assert.deepEqual([ev(manual).pos, ev(manual).neg], [1, 0]);

  const judge = hittrack.applyNoiseDispositionData('ignored', 'judge', null, { sessionId: 'a' })(entry());
  assert.deepEqual([ev(judge).pos, ev(judge).neg], [0, 0.7]);

  const touch = hittrack.applyHitUpdateWithContext({ sourceSession: 'a' })(entry());
  assert.deepEqual([ev(touch).pos, ev(touch).neg], [0.2, 0]);

  const noise = hittrack.applyNoiseDispositionData('unused', 'implicit-posttool', 'wrong_task', { countIrrelevant: true, sessionId: 'a' })(entry());
  assert.deepEqual([ev(noise).pos, ev(noise).neg], [0, 0.3]);

  const stale = hittrack.applyNoiseDispositionData('unused', 'prompt-stale', null, { sessionId: 'a' })(entry());
  assert.deepEqual([ev(stale).pos, ev(stale).neg], [0, 0.3]);

  const organic = evolution.applyOrganicSupportUpdate(entry(), { sourceSession: 'o1' }, 'support-1');
  assert.deepEqual([ev(organic).pos, ev(organic).neg], [0.3, 0]);
  assert.deepEqual(ev(organic).sessions, [{ s: 'o1', src: 'organic', w: 0.3, sign: 1 }]);
  const again = evolution.applyOrganicSupportUpdate(organic, { sourceSession: 'o1' }, 'support-2');
  assert.equal(ev(again).pos, 0.3, 'an already-confirmed session adds no organic evidence');
});

test('session-repeat flag records nothing (weight 0); tier moves never touch the field', () => {
  const repeated = session.incrementIgnoreCountData(entry());
  assert.equal(repeated.ignoreCount, 1);
  assert.equal(repeated.betaEvidence, undefined);
  const withEv = hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: 'x' })(entry({ ignoreCount: 2 }));
  const before = JSON.stringify(withEv.betaEvidence);
  evolution.resetPromotionProbation(withEv, 1);
  assert.equal(JSON.stringify(withEv.betaEvidence), before);
});

test('one outcome per (session, point): higher-or-equal priority replaces, lower is dropped', () => {
  let data = entry();
  data = hittrack.applyHitUpdateWithContext({ sourceSession: 's1' })(data); // implicit +0.2
  assert.deepEqual([ev(data).pos, ev(data).neg], [0.2, 0]);
  data = hittrack.applyNoiseDispositionData('ignored', 'judge', null, { sessionId: 's1' })(data); // judge replaces
  assert.deepEqual([ev(data).pos, ev(data).neg], [0, 0.7]);
  data = hittrack.applyNoiseDispositionData('unused', 'implicit-posttool', null, { sessionId: 's1' })(data); // lower: dropped
  assert.deepEqual([ev(data).pos, ev(data).neg], [0, 0.7]);
  data = hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: 's1' })(data); // manual replaces
  assert.deepEqual([ev(data).pos, ev(data).neg], [1, 0]);
  data = hittrack.applyNoiseDispositionData('ignored', 'judge', null, { sessionId: 's1' })(data); // lower than manual: dropped
  assert.deepEqual([ev(data).pos, ev(data).neg], [1, 0]);
  assert.deepEqual(ev(data).sessions, [{ s: 's1', src: 'manual', w: 1, sign: 1 }]);
  // A different session adds, no session id always adds.
  data = hittrack.applyNoiseDispositionData('ignored', 'judge', null, { sessionId: 's2' })(data);
  data = hittrack.applyNoiseDispositionData('ignored', 'manual')(data);
  assert.deepEqual([ev(data).pos, ev(data).neg], [1, 1.7]);
});

test('recordFeedback / recordJudgeFeedback pass their source and session (FileStore)', async () => {
  const store = path.join(HOME, '.experience', 'store', 'default');
  fs.mkdirSync(store, { recursive: true });
  const coll = 'beta-feedback-test';
  fs.writeFileSync(path.join(store, `${coll}.json`), JSON.stringify([{ id: 'p1', vector: [], payload: { json: JSON.stringify(entry()) } }]));
  await hittrack.recordJudgeFeedback(coll, 'p1', 'FOLLOWED', null, { sessionId: 'j1' });
  await hittrack.recordFeedback(coll, 'p1', 'IGNORED', null, { sessionId: 'j1' }); // manual replaces judge in j1
  await hittrack.recordFeedback(coll, 'p1', 'FOLLOWED', null, { source: 'phase-outcome', sessionId: 'p9' }); // phase-outcome weighs as judge
  const data = JSON.parse(JSON.parse(fs.readFileSync(path.join(store, `${coll}.json`), 'utf8'))[0].payload.json);
  assert.deepEqual([data.betaEvidence.pos, data.betaEvidence.neg], [0.7, 1]);
  assert.deepEqual(data.betaEvidence.sessions.map((e) => [e.s, e.src]), [['j1', 'manual'], ['p9', 'judge']]);
});

test('seeds take manual and judge evidence only', () => {
  for (const createdFrom of ['seed-common-doc', 'seed-memory-import', 'doc-to-experience', 'evolution-abstraction']) {
    const touched = hittrack.applyHitUpdateWithContext({ sourceSession: 's' })(entry({ createdFrom }));
    assert.equal(touched.betaEvidence, undefined, `${createdFrom}: implicit touch ignored, field not even initialised`);
    const noise = hittrack.applyNoiseDispositionData('unused', 'implicit-posttool', null, { sessionId: 's' })(entry({ createdFrom }));
    assert.equal(noise.betaEvidence, undefined);
    const judged = hittrack.applyNoiseDispositionData('ignored', 'judge', null, { sessionId: 's' })(entry({ createdFrom }));
    assert.equal(judged.betaEvidence.neg, 0.7);
  }
  // bulk-seed is not seed provenance for the evidence rule.
  const bulk = hittrack.applyHitUpdateWithContext({ sourceSession: 's' })(entry({ createdFrom: 'bulk-seed' }));
  assert.equal(bulk.betaEvidence.pos, 0.2);
});

test('initialisation happens before mutation: first manual hit, 2 ignores, validatedCount v', () => {
  for (const v of [0, 3, 7]) {
    const data = hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: 'first' })(entry({ ignoreCount: 2, validatedCount: v, hitCount: v }));
    assert.equal(data.ignoreCount, 0, 'applyHitUpdate still zeroes ignoreCount');
    assert.equal(data.betaEvidence.neg, 1.0, 'neg = 0.5 * (2 ignores + 0 irrelevant), counted before the reset');
    assert.equal(data.betaEvidence.pos, 0.5 * v + 1.0);
    assert.equal(data.betaEvidence.v, 1);
  }
  // validatedCount ?? hitCount ?? 0
  const legacy = hittrack.applyHitUpdate({ solution: 's', hitCount: 4, ignoreCount: 1, irrelevantCount: 1 }, { source: 'manual' });
  assert.deepEqual([legacy.betaEvidence.pos, legacy.betaEvidence.neg], [0.5 * 4 + 1, 1]);
});

test('on read, evidence is computed but not persisted', () => {
  const data = entry({ validatedCount: 4, ignoreCount: 2, irrelevantCount: 2 });
  assert.deepEqual(betaEvidence.readBetaEvidence(data), { pos: 2, neg: 2, v: 1, sessions: [] });
  assert.equal(data.betaEvidence, undefined);
});

test('betaEvidenceEnabled=false writes nothing; applyHitUpdate without a source records nothing', () => {
  setConfig({ qdrantUrl: 'http://127.0.0.1:1', betaEvidenceEnabled: false });
  assert.equal(hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: 'a' })(entry()).betaEvidence, undefined);
  setConfig({ qdrantUrl: 'http://127.0.0.1:1' });
  assert.equal(hittrack.applyHitUpdate(entry()).betaEvidence, undefined);
});

test('the session log keeps the last 50 entries', () => {
  let data = entry();
  for (let i = 0; i < 60; i++) data = hittrack.applyNoiseDispositionData('followed', 'manual', null, { sessionId: `s${i}` })(data);
  assert.equal(data.betaEvidence.sessions.length, 50);
  assert.equal(data.betaEvidence.sessions[0].s, 's10');
  assert.equal(data.betaEvidence.pos, 60);
});

test('exp-reset-ignore-count --beta clears neg (and negative sessions); without it betaEvidence is untouched', () => {
  let data = entry({ ignoreCount: 4, noiseReasonCounts: { stale_rule: 1 } });
  data = hittrack.applyNoiseDispositionData('ignored', 'manual', null, { sessionId: 'n1' })(data);
  data = hittrack.applyNoiseDispositionData('followed', 'judge', null, { sessionId: 'p1' })(data);
  const plain = resetPointData(data);
  assert.equal(plain.ignoreCount, 0);
  assert.deepEqual(plain.noiseReasonCounts, {});
  assert.deepEqual(plain.betaEvidence, data.betaEvidence);
  const beta = resetPointData(data, { beta: true });
  assert.equal(beta.betaEvidence.neg, 0);
  assert.equal(beta.betaEvidence.pos, data.betaEvidence.pos);
  assert.deepEqual(beta.betaEvidence.sessions.map((e) => e.s), ['p1']);
  assert.ok(data.betaEvidence.neg > 0, 'the input is not mutated');
});

test('re-import (storeImportedExperience) preserves betaEvidence', async () => {
  const embedding = require(path.join(SRC, 'embedding.js'));
  const qdrant = require(path.join(SRC, 'qdrant.js'));
  const existing = { ...entry({ validatedCount: 3, hitCount: 3 }), betaEvidence: { pos: 4.5, neg: 1, v: 1, sessions: [{ s: 'x', src: 'manual', w: 1, sign: 1 }] } };
  const puts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/collections') return res.end(JSON.stringify({ result: { collections: [] } }));
      if (req.method === 'GET' && req.url === '/collections/experience-behavioral/points/imp-1') return res.end(JSON.stringify({ result: { id: 'imp-1', payload: { json: JSON.stringify(existing) } } }));
      if (req.method === 'GET') return res.end(JSON.stringify({ result: { config: { params: {} } } }));
      if (req.method === 'PUT') puts.push(JSON.parse(raw));
      return res.end(JSON.stringify({ result: { status: 'ok' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const savedEmbed = embedding.EMBED_PROVIDERS.ollama;
  try {
    setConfig({ qdrantUrl: `http://127.0.0.1:${server.address().port}`, embedProvider: 'ollama' });
    qdrant.resetQdrantCheck();
    embedding.EMBED_PROVIDERS.ollama = { fn: async () => ({ vector: [0.1, 0.2, 0.3, 0.4] }) };
    const r = await evolution.storeImportedExperience({ trigger: 't', question: 'q', solution: 'new text' }, { id: 'imp-1', collection: 'experience-behavioral', tier: 1, confidence: 0.6 });
    assert.equal(r.upserted, true);
    const written = JSON.parse(puts[0].points[0].payload.json);
    assert.equal(written.solution, 'new text');
    assert.deepEqual(written.betaEvidence, existing.betaEvidence);
  } finally {
    embedding.EMBED_PROVIDERS.ollama = savedEmbed;
    qdrant.resetQdrantCheck();
    server.close();
  }
});
