'use strict';

// tools/exp-engine-lift.js — synthetic experiment logs with a planted effect must
// recover its sign and cover it with the bootstrap CI (spec §5 "Analyzers").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require(path.join(__dirname, '..', '..', 'tools', 'exp-engine-lift.js'));

const TS = '2026-09-10T00:00:00.000Z';

/**
 * Build a log: `sessions` per arm, each with `calls` mutating calls whose failure
 * probability is rates[arm]; deterministic via the tool's own PRNG.
 */
function synth({ perArm = 300, calls = 20, rates = { control: 0.10, treatment: 0.07 }, experiment = 'holdout', seed = 7, runtime = 'claude-code', extra = [] }) {
  const rand = L.mulberry32(seed);
  const events = [];
  let n = 0;
  for (const [arm, p] of Object.entries(rates)) {
    for (let i = 0; i < perArm; i++) {
      const sid = `${arm}-${i}`;
      events.push({ ts: TS, event: 'session-arm', sourceSession: sid, experiment, arm, salt: 'v1', runtime });
      for (let c = 0; c < calls; c++) {
        events.push({ ts: TS, event: 'outcome', sourceSession: sid, toolUseId: `u${n++}`, tool: c % 2 ? 'Bash' : 'Edit', inputHash: `h${c}`, failure: rand() < p ? 'fail' : 'ok', runtime });
      }
    }
  }
  return events.concat(extra);
}

test('planted effect: sign recovered, CI covers the truth and excludes 0', () => {
  const r = L.analyze(synth({ perArm: 400 }), {});
  assert.equal(r.compare, 'holdout');
  assert.ok(r.primary.difference > 0, `control − treatment should be positive, got ${r.primary.difference}`);
  const [lo, hi] = r.primary.ci95.diff;
  assert.ok(lo <= 0.03 && 0.03 <= hi, `CI [${lo}, ${hi}] should cover 0.03`);
  assert.ok(lo > 0, 'a 3-point effect over 16k calls per arm is detectable');
  assert.equal(r.primary.ci95.resamples, 2000);
  assert.equal(r.status, 'monitoring, not a decision');
});

test('null effect: CI covers 0 in most replications (coverage sanity)', () => {
  let covered = 0;
  const reps = 20;
  for (let seed = 1; seed <= reps; seed++) {
    const r = L.analyze(synth({ perArm: 150, calls: 10, rates: { control: 0.08, treatment: 0.08 }, seed }), { resamples: 500, seed });
    const [lo, hi] = r.primary.ci95.diff;
    if (lo <= 0 && 0 <= hi) covered++;
  }
  assert.ok(covered >= 16, `95% CI covered 0 in ${covered}/${reps} null replications`);
});

test('bootstrap is deterministic for a fixed seed', () => {
  const ev = synth({ perArm: 50 });
  assert.deepEqual(L.analyze(ev, { seed: 3 }).primary.ci95, L.analyze(ev, { seed: 3 }).primary.ci95);
});

test('sessions below the call minimum are excluded and counted; unknown calls are not counted', () => {
  const extra = [
    { event: 'session-arm', sourceSession: 'short', experiment: 'holdout', arm: 'control', salt: 'v1' },
    ...[1, 2, 3].map((i) => ({ event: 'outcome', sourceSession: 'short', toolUseId: `s${i}`, tool: 'Bash', failure: 'fail' })),
    { event: 'outcome', sourceSession: 'control-0', toolUseId: 'unk', tool: 'Bash', failure: 'unknown' },
    { event: 'outcome', sourceSession: 'control-0', toolUseId: 'u0', tool: 'Bash', failure: 'fail' }, // duplicate delivery
    { event: 'outcome', sourceSession: 'control-0', toolUseId: 'rd', tool: 'Read', failure: 'fail' }, // not mutating
  ];
  const r = L.analyze(synth({ perArm: 20, extra }), {});
  assert.equal(r.sessions.excludedBelowMinCalls, 1);
  assert.equal(r.sessions.eligible, 40);
  assert.equal(r.unknownCalls, 1);
  assert.equal(r.primary.a.calls, 20 * 20, 'duplicates, unknowns and non-mutating tools are not counted');
});

test('retry loops, runtime strata and treatment-only guardrails', () => {
  const events = synth({ perArm: 10, calls: 6, rates: { control: 0, treatment: 0 } });
  // control-0: two failures with the same inputHash → retry loop.
  events.push({ event: 'outcome', sourceSession: 'control-0', toolUseId: 'r1', tool: 'Bash', inputHash: 'same', failure: 'fail' });
  events.push({ event: 'outcome', sourceSession: 'control-0', toolUseId: 'r2', tool: 'Bash', inputHash: 'same', failure: 'fail' });
  // Exposures for two treatment sessions.
  events.push({ event: 'exposure', sourceSession: 'treatment-0', interceptId: 'a', shown: ['e1', 'e2'], graphShown: ['g1'] });
  events.push({ event: 'exposure', sourceSession: 'treatment-0', interceptId: 'b', shown: [], graphShown: [] });
  events.push({ event: 'exposure', sourceSession: 'treatment-1', interceptId: 'c', shown: ['e1'], graphShown: [] });
  const r = L.analyze(events, {});
  assert.equal(r.primary.a.retryLoopSessionShare, 1 / 10);
  assert.equal(r.primary.b.retryLoopSessionShare, 0);
  assert.deepEqual(Object.keys(r.strata), ['claude-code']);
  assert.deepEqual(Object.keys(r.guardrails), ['treatment']);
  const g = r.guardrails.treatment;
  assert.equal(g.intercepts, 3);
  assert.equal(g.hintsPerIntercept, 4 / 3);
  assert.equal(g.shareInterceptsWithHint, 2 / 3);
  assert.equal(g.distinctEntriesShown, 3);
});

test('decision label only on/after the pre-registered end date', () => {
  const ev = synth({ perArm: 20 });
  assert.equal(L.analyze(ev, { endDate: '2026-10-15', now: new Date('2026-10-01T00:00:00Z') }).status, 'monitoring, not a decision');
  assert.equal(L.analyze(ev, { endDate: '2026-10-15', now: new Date('2026-10-15T00:00:00Z') }).status, 'decision');
});

test('only the latest salt is analysed unless --salt picks one', () => {
  const ev = [
    ...synth({ perArm: 10 }).map((e) => (e.event === 'session-arm' ? { ...e, salt: 'old' } : e)),
    ...synth({ perArm: 10 }).map((e) => (e.sourceSession ? { ...e, sourceSession: `n-${e.sourceSession}` } : e)),
  ];
  const r = L.analyze(ev, {});
  assert.equal(r.salt, 'v1');
  assert.equal(r.sessions.assigned, 20);
  assert.equal(r.sessions.ignoredOtherSalt, 20);
  assert.equal(L.analyze(ev, { salt: 'old' }).sessions.assigned, 20);
});

test('model comparison: beta vs legacy among non-control sessions, with the pre-registered rule', () => {
  const events = synth({ perArm: 300, rates: { beta: 0.06, legacy: 0.07 }, experiment: 'confidence-model', seed: 11 });
  // A holdout-control session in the model log must be excluded from the comparison.
  events.push({ event: 'session-arm', sourceSession: 'beta-0', experiment: 'holdout', arm: 'control', salt: 'v1' });
  for (let i = 0; i < 300; i++) {
    for (const arm of ['beta', 'legacy']) {
      events.push({ event: 'exposure', sourceSession: `${arm}-${i}`, interceptId: `${arm}${i}`, shown: ['x'], graphShown: [] });
    }
  }
  const r = L.analyze(events, { compare: 'model' });
  assert.equal(r.primary.a.sessions, 299, 'held-out control session excluded');
  assert.ok(r.primary.difference < 0);
  assert.ok(r.rule.relativeCiUpper < 0.10);
  assert.equal(r.rule.guardrailsOk, true);
  assert.equal(r.rule.keepBeta, true);

  // Beta that suppresses hints fails the guardrail even with a good failure rate.
  const starved = events.map((e) => (e.event === 'exposure' && e.sourceSession.startsWith('beta') ? { ...e, shown: [] } : e));
  const r2 = L.analyze(starved, { compare: 'model' });
  assert.equal(r2.rule.guardrailsOk, false);
  assert.equal(r2.rule.keepBeta, false);
});

test('CLI renders a report from an experiment log on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-lift-'));
  const log = path.join(dir, 'experiment.jsonl');
  const ev = synth({ perArm: 30 });
  fs.writeFileSync(log + '.20260901T000000000Z', ev.slice(0, 500).map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(log, ev.slice(500).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { spawnSync } = require('node:child_process');
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'exp-engine-lift.js'), '--log', log], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /MONITORING, NOT A DECISION/);
  assert.match(out.stdout, /control − treatment/);
  const json = JSON.parse(spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'exp-engine-lift.js'), '--log', log, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(json.sessions.assigned, 60, 'rotated + live files both read');
});
