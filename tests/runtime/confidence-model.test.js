#!/usr/bin/env node
'use strict';

// betaConfidence / passesConfidenceGate and the confidenceModel modes (spec §3
// B3-B4, §5 "bayes" and "Modes"): low-evidence pass-through equals legacy, hard
// gates hold, the draw is deterministic and monotone in evidence, `ab` splits
// independently of the holdout, and beta never changes the brief or evolve.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-conf-model-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const CONFIG = path.join(HOME, '.experience', 'config.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
process.env.EXPERIENCE_CONFIG_PATH = CONFIG;
process.env.EXPERIENCE_ACTIVITY_LOG = path.join(HOME, 'activity.jsonl');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, '.experience', 'src');
const config = require(path.join(SRC, 'config.js'));
const scoring = require(path.join(SRC, 'scoring.js'));
const bayes = require(path.join(SRC, 'bayes.js'));
const experiment = require(path.join(SRC, 'experiment.js'));

function setConfig(obj) {
  fs.writeFileSync(CONFIG, JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1', ...obj }));
  config.refreshConfig();
}
test.beforeEach(() => setConfig({}));
test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const betaCtx = (extra = {}) => ({ ...scoring.buildConfidenceCtx({ model: 'beta', sessionId: 'sess-1', nowMs: NOW }), ...extra });
const withEvidence = (pos, neg, extra = {}) => ({
  solution: 's', createdFrom: 'session-extractor', confidence: 0.6, hitCount: 2, surfaceCount: 10, ignoreCount: 1,
  betaEvidence: { pos, neg, v: 1, sessions: [] }, ...extra,
});

test('no ctx, legacy ctx and recall ctx are exactly the legacy predicate and value', () => {
  const data = { solution: 's', confidence: 0.5, hitCount: 0, surfaceCount: 10, ignoreCount: 3 };
  const legacyValue = scoring.computeEffectiveConfidence(data);
  for (const ctx of [null, undefined, betaCtx({ model: 'legacy' }), betaCtx({ recallMode: true })]) {
    const d = scoring.betaConfidence(data, ctx, 'p');
    assert.equal(d.mode, 'legacy');
    assert.equal(d.value, legacyValue);
    assert.equal(d.pass, legacyValue >= 0.42);
  }
});

test('low-evidence pass-through equals legacy (pos + neg < betaMinEvidence)', () => {
  for (const [pos, neg] of [[0, 0], [2.9, 0], [1, 1.9], [0, 2.99]]) {
    for (const conf of [0.3, 0.5, 0.8]) {
      const data = withEvidence(pos, neg, { confidence: conf });
      const d = scoring.betaConfidence(data, betaCtx(), 'p');
      assert.equal(d.mode, 'legacy-low-evidence');
      assert.equal(d.value, scoring.computeEffectiveConfidence(data));
      assert.equal(d.pass, scoring.computeEffectiveConfidence(data) >= 0.42);
    }
  }
  // Evidence computed on read from counters counts too (not persisted).
  const counters = { solution: 's', confidence: 0.6, validatedCount: 8, hitCount: 8, surfaceCount: 20 };
  assert.equal(scoring.betaConfidence(counters, betaCtx(), 'p').mode, 'beta');
  assert.equal(counters.betaEvidence, undefined);
});

test('hard gates hold in beta mode: legacy confidence < 0.2 and narrow-scope demotion', () => {
  const killed = withEvidence(40, 0, { confidence: 0.15 });
  assert.equal(scoring.betaConfidence(killed, betaCtx(), 'p').mode, 'hard-gate');
  assert.equal(scoring.betaConfidence(killed, betaCtx(), 'p').pass, false);
  // A 0.7 seed demoted by narrow-scope lands at 0.21 — above 0.2, still a kill.
  const narrowed = withEvidence(40, 0, { createdFrom: 'seed-common-doc', confidence: 0.21, demoteReason: 'narrow-scope:too_vague' });
  assert.equal(scoring.betaConfidence(narrowed, betaCtx(), 'p').pass, false);
});

test('beta decision: posterior with provenance prior; theta from hash(session|point|UTC day)', () => {
  const data = withEvidence(6, 2);
  const d = scoring.betaConfidence(data, betaCtx(), 'point-9');
  const a = 0.5 * 4 + 6; const b = 0.5 * 4 + 2;
  assert.equal(d.mode, 'beta');
  assert.ok(Math.abs(d.mean - a / (a + b)) < 1e-12);
  assert.equal(d.value, d.mean, 'rank weight is the posterior mean');
  const u = bayes.unitHash('sess-1|point-9|2026-09-25');
  assert.ok(Math.abs(d.theta - bayes.betaQuantile(u, a, b)) < 1e-12);
  assert.equal(d.pass, d.theta >= 0.42);
  // Deterministic across calls; no session → posterior mean.
  assert.deepEqual(scoring.betaConfidence(data, betaCtx(), 'point-9'), d);
  const noSession = scoring.betaConfidence(data, betaCtx({ sessionId: null }), 'point-9');
  assert.equal(noSession.theta, noSession.mean);
  // Seed prior: mu 0.7, k 20.
  const seed = scoring.betaConfidence(withEvidence(3, 3, { createdFrom: 'seed-common-doc', confidence: 0.7 }), betaCtx({ sessionId: null }), 'x');
  assert.ok(Math.abs(seed.mean - (14 + 3) / (20 + 6)) < 1e-12);
});

test('the gate is monotone in evidence for a fixed (session, point, day)', () => {
  for (const point of ['a', 'b', 'c', 'd', 'e', 'f']) {
    let prevTheta = -Infinity;
    for (let pos = 0; pos <= 30; pos++) {
      const d = scoring.betaConfidence(withEvidence(3 + pos, 3), betaCtx(), point);
      assert.ok(d.theta >= prevTheta - 1e-12, `${point}: more positive evidence lowered theta`);
      prevTheta = d.theta;
    }
    let prevNeg = Infinity;
    for (let neg = 0; neg <= 30; neg++) {
      const d = scoring.betaConfidence(withEvidence(3, 3 + neg), betaCtx(), point);
      assert.ok(d.theta <= prevNeg + 1e-12, `${point}: more negative evidence raised theta`);
      prevNeg = d.theta;
    }
  }
});

test('passesConfidenceGate: probationary always passes; otherwise the betaConfidence decision', () => {
  const low = { solution: 's', confidence: 0.3, hitCount: 0, surfaceCount: 4 };
  assert.equal(scoring.passesConfidenceGate({ id: 'p', _probationaryT2: true }, low, null), true);
  assert.equal(scoring.passesConfidenceGate({ id: 'p' }, low, null), false);
  const strong = withEvidence(30, 0);
  assert.equal(scoring.passesConfidenceGate({ id: 'p' }, strong, betaCtx()), scoring.betaConfidence(strong, betaCtx(), 'p').pass);
});

test('computeEffectiveScore: beta ctx weights by the posterior mean, no ctx by legacy', () => {
  const data = withEvidence(20, 0, { confidence: 0.45 });
  const point = { id: 'p', score: 0.8 };
  const legacy = scoring.computeEffectiveScore(point, data, null, null, '');
  assert.equal(scoring.computeEffectiveScore(point, data, null, null, '', null), legacy);
  const beta = scoring.computeEffectiveScore(point, data, null, null, '', betaCtx());
  assert.ok(beta > legacy, 'strong positive evidence ranks higher than the legacy weight');
});

test('ab: beta share within ±0.01 over 100k sessions and independent of the holdout arm', () => {
  let beta = 0; let control = 0; let betaAndControl = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) {
    const sid = `ab-${i}`;
    const m = experiment.modelArm(sid, { share: 0.5, salt: 'v1' }).arm === 'beta';
    const c = experiment.holdoutArm(sid, { share: 0.2, salt: 'v1' }).arm === 'control';
    if (m) beta++;
    if (c) control++;
    if (m && c) betaAndControl++;
  }
  assert.ok(Math.abs(beta / n - 0.5) <= 0.01, `beta share ${beta / n}`);
  // Independence: P(control | beta) ≈ P(control).
  assert.ok(Math.abs(betaAndControl / beta - control / n) <= 0.01, `P(control|beta)=${betaAndControl / beta} vs ${control / n}`);
  assert.equal(experiment.modelArm(null, { share: 0.5, salt: 'v1' }), null);
});

test('resolveModel: legacy/shadow decide legacy, beta decides beta, ab by session', () => {
  setConfig({ confidenceModel: 'shadow' });
  assert.deepEqual(experiment.resolveModel('s'), { mode: 'shadow', arm: 'legacy', assigned: null });
  setConfig({ confidenceModel: 'beta' });
  assert.equal(experiment.resolveModel('s').arm, 'beta');
  setConfig({ confidenceModel: 'ab', confidenceAbShare: 1 });
  assert.equal(experiment.resolveModel('s').arm, 'beta');
  assert.equal(experiment.resolveModel(null).arm, 'legacy');
  setConfig({ confidenceModel: 'nonsense' });
  assert.equal(config.getConfidenceModel(), 'legacy');
  assert.equal(experiment.isExperimentActive(), false);
});

test('beta never changes the brief', async () => {
  const { buildProjectBrief, _clearBriefCache } = require(path.join(SRC, 'brief.js'));
  const store = path.join(HOME, '.experience', 'store', 'default');
  fs.mkdirSync(store, { recursive: true });
  const e = (id, extra) => ({ id, vector: [0.1], payload: { json: JSON.stringify({ id, solution: `sol ${id}`, trigger: `t ${id}`, scope: { project_slug: 'brief-app' }, _projectSlug: 'brief-app', createdAt: new Date(NOW).toISOString(), ...extra }) } });
  fs.writeFileSync(path.join(store, 'experience-behavioral.json'), JSON.stringify([
    e('b1', { confidence: 0.45, hitCount: 0, surfaceCount: 12, ignoreCount: 3, betaEvidence: { pos: 40, neg: 0, v: 1, sessions: [] } }),
    e('b2', { confidence: 0.8, hitCount: 4, validatedCount: 4, betaEvidence: { pos: 0, neg: 40, v: 1, sessions: [] } }),
  ]));
  setConfig({});
  _clearBriefCache();
  const legacy = await buildProjectBrief('brief-app', { fresh: true });
  setConfig({ confidenceModel: 'beta' });
  _clearBriefCache();
  const beta = await buildProjectBrief('brief-app', { fresh: true });
  assert.deepEqual(beta, legacy);
});

test('beta never changes evolve: a legacy-decayed T1 is demoted even with strong beta evidence', async () => {
  const store = path.join(HOME, '.experience', 'store', 'default');
  const core = require(path.join(ROOT, '.experience', 'experience-core.js'));
  const t1 = { id: 'evo-1', vector: [0.2, 0.4, 0.6], payload: { json: JSON.stringify({ id: 'evo-1', solution: 'decayed', trigger: 't', tier: 1, createdFrom: 'session-extractor', confidence: 0.4, hitCount: 0, surfaceCount: 10, ignoreCount: 1, createdAt: new Date(NOW - 40 * 86400000).toISOString(), betaEvidence: { pos: 60, neg: 0, v: 1, sessions: [] } }) } };
  for (const model of ['legacy', 'beta']) {
    fs.rmSync(store, { recursive: true, force: true });
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'experience-behavioral.json'), JSON.stringify([t1]));
    setConfig({ confidenceModel: model, brainFilter: false });
    await core.evolve('beta-mode-test');
    const selfqa = JSON.parse(fs.readFileSync(path.join(store, 'experience-selfqa.json'), 'utf8'));
    const moved = selfqa.find((x) => x.id === 'evo-1');
    assert.ok(moved, `${model}: demoted to selfqa`);
    const data = JSON.parse(moved.payload.json);
    assert.equal(data.demoteReason, 'confidence_decay', model);
    assert.deepEqual(data.betaEvidence, { pos: 60, neg: 0, v: 1, sessions: [] }, `${model}: demotion does not touch betaEvidence`);
  }
});
