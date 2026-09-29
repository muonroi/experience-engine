#!/usr/bin/env node
'use strict';

// Dashboard section X — ADR-004 experiment progress and health. Monitoring only:
// arm volumes, the sample-ratio-mismatch check and dropped errors on experiment
// paths; never an outcome comparison between arms.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { computeExperiment, sampleRatioMismatch } = require('../tools/dashboard/experiment');
const { renderExperiment } = require('../tools/dashboard/render-html');
const { readExperimentLog } = require('../.experience/src/experiment');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dash-x-'));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

let runs = 0;
function simulatedEvents(share) {
  const out = path.join(ROOT, `sim-${share}-${runs++}`);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('EXPERIENCE_')) delete env[k];
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'exp-simulate-experiment.js'), '--out', out, '--sessions', '600', '--share', String(share), '--points', '20', '--json'], { encoding: 'utf8', env: { ...env, HOME: ROOT, USERPROFILE: ROOT } });
  assert.equal(r.status, 0, r.stderr);
  return { events: readExperimentLog(path.join(out, 'experiment.jsonl')), sim: JSON.parse(r.stdout) };
}

test('SRM: chi-square p-value is right and flags only a real mismatch', () => {
  const edge = sampleRatioMismatch(80, 320, 0.2);
  assert.equal(edge.observedShare, 0.2);
  assert.ok(edge.pValue > 0.99 && !edge.mismatch);
  // chi2 = 3.84 at 1 dof ↔ p = 0.05
  const c = 100 + Math.sqrt(3.841459 * 100 * 0.5); // control count giving chi2 ≈ 3.84 for n=200, share 0.5
  const p05 = sampleRatioMismatch(c, 200 - c, 0.5);
  assert.ok(Math.abs(p05.pValue - 0.05) < 0.002, `p ${p05.pValue}`);
  assert.ok(sampleRatioMismatch(40, 360, 0.2).mismatch, '10% observed vs 20% expected on 400 sessions');
  assert.equal(sampleRatioMismatch(0, 0, 0.2).pValue, null);
  assert.equal(sampleRatioMismatch(5, 5, 0).mismatch, false, 'no holdout configured → no test');
});

test('computeExperiment: arm volumes from a simulated run, a healthy split, experiment-path errors only', () => {
  const { events, sim } = simulatedEvents(0.2);
  const activity = [
    { raw: { op: 'swallowed', where: 'interceptor.rememberExperimentArm' } },
    { raw: { op: 'swallowed', where: 'interceptor.rememberExperimentArm' } },
    { raw: { op: 'swallowed', where: 'remote-client.persistAttempts' } },
    { raw: { op: 'swallowed', where: 'bulk-extract.enrichSourceMeta' } },
    { raw: { op: 'intercept' } },
  ];
  const x = computeExperiment(events, activity, { holdoutShare: 0.2, confidenceModel: 'ab', abShare: 0.5, log: { path: '/x', files: 2 }, now: new Date('2026-10-22T00:00:00Z') });
  assert.equal(x.status, 'monitoring, not a decision');
  assert.equal(x.active, true);
  assert.equal(x.holdout.control.sessions, sim.sessions.control);
  assert.equal(x.holdout.treatment.sessions, sim.sessions.treatment);
  assert.ok(x.holdout.control.classifiedCalls > 0 && x.holdout.treatment.unclassifiedCalls > 0);
  assert.equal(x.holdout.srm.mismatch, false);
  assert.ok(x.model && x.model.srm.mismatch === false);
  assert.deepEqual(x.swallowed, { total: 3, bySite: { 'interceptor.rememberExperimentArm': 2, 'remote-client.persistAttempts': 1 } });
  assert.ok(x.daysRunning > 0 && x.sessionsPerWeek > 0);
  for (const key of ['failureRatio', 'failed', 'primary', 'ci95']) {
    assert.ok(!JSON.stringify(x).includes(`"${key}"`), `no outcome comparison field ${key}`);
  }
});

test('computeExperiment: losing control sessions shows up as a sample-ratio mismatch', () => {
  const { events } = simulatedEvents(0.2);
  const controls = new Set(events.filter((e) => e.event === 'session-arm' && e.arm === 'control').map((e) => e.sourceSession));
  const dropped = [...controls].filter((_, i) => i % 2 === 0);
  const lossy = events.filter((e) => !dropped.includes(e.sourceSession));
  const x = computeExperiment(lossy, [], { holdoutShare: 0.2 });
  assert.equal(x.holdout.srm.mismatch, true, `observed ${x.holdout.srm.observedShare}`);
});

test('renderExperiment: the section appears while an experiment runs, without outcome numbers', () => {
  const { events } = simulatedEvents(0.2);
  const experiment = computeExperiment(events, [], { holdoutShare: 0.2, confidenceModel: 'legacy', log: { path: '/logs/experiment.jsonl', files: 2 } });
  const html = renderExperiment(experiment);
  assert.match(html, /X\. Experiment \(ADR-004\) — monitoring, not a decision/);
  assert.match(html, /\/logs\/experiment\.jsonl — \d+ events in 2 file\(s\)/);
  assert.match(html, /Split: <span class="good">ok<\/span>/);
  assert.ok(!/failure ratio/i.test(html));
  assert.equal(renderExperiment(computeExperiment([], [], { holdoutShare: 0, confidenceModel: 'legacy' })), '', 'no section when no experiment ran');
  assert.equal(renderExperiment(undefined), '', 'an old snapshot without the section');
});
