'use strict';

// tools/exp-outcome-baseline.js — Phase A0.3 go/no-go from existing logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const B = require(path.join(__dirname, '..', '..', 'tools', 'exp-outcome-baseline.js'));

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const ts = (hours) => new Date(T0 + hours * 3600000).toISOString();

function hookRec(session, tool, failure, toolOutcome, h, extra = {}) {
  return { ts: ts(h), op: 'hook', hook: 'interceptor-post', stage: 'parsed', tool, sourceSession: session, sourceRuntime: 'codex-wsl', ...(failure ? { failure } : {}), toolOutcome, ...extra };
}
function serverRec(session, tool, failure, toolOutcome, h, extra = {}) {
  return { ts: ts(h), op: 'posttool', tool, sourceSession: session, sourceRuntime: 'claude-code', ...(failure ? { failure } : {}), toolOutcome, ...extra };
}

test('both posttool shapes parse; other ops and stages are ignored', () => {
  assert.ok(B.normalizeActivityRecord(hookRec('s', 'Bash', 'ok', 'success', 0)));
  assert.ok(B.normalizeActivityRecord(serverRec('s', 'Bash', 'fail', 'error', 0)));
  assert.equal(B.normalizeActivityRecord({ op: 'hook', hook: 'interceptor-post', stage: 'done', tool: 'Bash' }), null);
  assert.equal(B.normalizeActivityRecord({ op: 'intercept', tool: 'Bash' }), null);
  const n = B.normalizeActivityRecord(serverRec('s', 'Edit', 'fail', 'error', 0, { runtime: 'claude-code', toolUseId: 't1' }));
  assert.equal(n.runtime, 'claude-code');
  assert.equal(n.toolUseId, 't1');
});

test('reads activity.jsonl and its .1 rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-base-'));
  fs.writeFileSync(path.join(dir, 'activity.jsonl.1'), JSON.stringify(hookRec('a', 'Bash', 'ok', 'success', 0)) + '\nnot json\n');
  fs.writeFileSync(path.join(dir, 'activity.jsonl'), JSON.stringify(serverRec('b', 'Edit', 'fail', 'error', 1)) + '\n');
  const recs = B.loadActivityRecords(dir);
  assert.deepEqual(recs.map((r) => r.session), ['a', 'b']);
});

test('experiment log records win over activity duplicates', () => {
  const activity = [
    B.normalizeActivityRecord(serverRec('s1', 'Bash', 'fail', 'error', 0, { toolUseId: 'x' })),
    B.normalizeActivityRecord(serverRec('s1', 'Bash', 'ok', 'success', 1, { toolUseId: 'y' })),
    B.normalizeActivityRecord(serverRec('s2', 'Bash', 'ok', 'success', 1)),
  ];
  const experiment = [B.normalizeExperimentOutcome({ event: 'outcome', ts: ts(0), sourceSession: 's1', tool: 'Bash', toolUseId: 'x', failure: 'fail' })];
  const merged = B.mergeRecords(activity, experiment);
  assert.equal(merged.length, 3, 's1/x deduped, s1/y and s2 kept, plus the experiment record');
  assert.equal(merged.filter((r) => r.toolUseId === 'x').length, 1);
});

test('normInv and MDE formula', () => {
  assert.ok(Math.abs(B.normInv(0.975) - 1.959963985) < 1e-6);
  assert.ok(Math.abs(B.normInv(0.8) - 0.841621234) < 1e-6);
  const mde = B.minimumDetectableEffect({ variance: 0.01, nControl: 100, nTreatment: 100 });
  assert.ok(Math.abs(mde - (1.959963985 + 0.841621234) * Math.sqrt(0.01 * (2 / 100))) < 1e-6);
  assert.equal(B.minimumDetectableEffect({ variance: 0.01, nControl: 0, nTreatment: 10 }), Infinity);
});

function syntheticLog({ sessions, callsPerSession, failEvery, days, strict = true }) {
  const recs = [];
  for (let s = 0; s < sessions; s++) {
    const hour = (s / sessions) * days * 24;
    for (let c = 0; c < callsPerSession; c++) {
      const fail = (s * callsPerSession + c) % failEvery === 0;
      recs.push(B.normalizeActivityRecord(serverRec(`s${s}`, c % 2 ? 'Bash' : 'Edit', strict ? (fail ? 'fail' : 'ok') : null, fail ? 'error' : 'success', hour)));
    }
  }
  return recs;
}

test('computeBaseline: rates, session exclusion and go decision on a healthy baseline', () => {
  const recs = syntheticLog({ sessions: 700, callsPerSession: 20, failEvery: 10, days: 7 });
  // Plus a few short sessions that must be excluded and counted.
  for (let i = 0; i < 3; i++) recs.push(B.normalizeActivityRecord(serverRec(`short${i}`, 'Bash', 'fail', 'error', 1)));
  // And a read-only tool that is not a mutating call.
  recs.push(B.normalizeActivityRecord(serverRec('s0', 'Read', 'fail', 'error', 1)));
  const r = B.computeBaseline(recs, { holdoutShare: 0.2, weeks: 4, minCalls: 5 });
  assert.equal(r.basis, 'strict');
  assert.equal(r.sessions.eligible, 700);
  assert.equal(r.sessions.excludedBelowMinCalls, 3);
  assert.ok(Math.abs(r.baselineRate - 0.1) < 1e-9);
  assert.ok(r.byRuntimeTool['claude-code'].Edit.calls > 0);
  assert.ok(r.sessionsPerWeek > 690 && r.sessionsPerWeek < 710, String(r.sessionsPerWeek));
  assert.ok(r.mdeRelative <= 0.25, String(r.mdeRelative));
  assert.equal(r.decision, 'go');
});

test('computeBaseline: a rare-failure baseline is no-go with the reason spelled out', () => {
  const recs = syntheticLog({ sessions: 300, callsPerSession: 20, failEvery: 100, days: 7 });
  const r = B.computeBaseline(recs, {});
  assert.equal(r.decision, 'no-go');
  assert.ok(r.reasons.some((x) => /baseline failure rate/.test(x)));
});

test('computeBaseline falls back to the legacy classifier, labelled, when strict data is thin', () => {
  const recs = syntheticLog({ sessions: 50, callsPerSession: 10, failEvery: 5, days: 7, strict: false });
  const r = B.computeBaseline(recs, {});
  assert.equal(r.basis, 'legacy-toolOutcome');
  assert.ok(Math.abs(r.baselineRate - 0.2) < 1e-9);
  assert.ok(r.reasons.some((x) => /upper bound/.test(x)));
  assert.equal(r.decision, 'no-go');
  assert.match(B.renderReport(r), /UPPER BOUND/);
});

test('rotated experiment logs are listed oldest first, live file last', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-base-rot-'));
  const base = path.join(dir, 'experiment.jsonl');
  fs.writeFileSync(base, '');
  fs.writeFileSync(base + '.20260902T000000000Z', '');
  fs.writeFileSync(base + '.20260901T000000000Z', '');
  fs.writeFileSync(path.join(dir, 'other.jsonl'), '');
  assert.deepEqual(B.listLogFiles(base).map((f) => path.basename(f)), ['experiment.jsonl.20260901T000000000Z', 'experiment.jsonl.20260902T000000000Z', 'experiment.jsonl']);
});
