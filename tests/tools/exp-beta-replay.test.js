'use strict';

// tools/exp-beta-replay.js — offline B0 replay over a corpus file and intercept rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-beta-replay-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.EXPERIENCE_CONFIG_PATH = path.join(HOME, 'config.json');
fs.writeFileSync(process.env.EXPERIENCE_CONFIG_PATH, '{}');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'exp-beta-replay.js');
const R = require(TOOL);

const pt = (id, data, collection = 'experience-behavioral') => ({ id, collection, payload: { json: JSON.stringify({ id, solution: `s ${id}`, ...data }) } });

const CORPUS = [
  pt('aaaaaaaa-1', { createdFrom: 'session-extractor', tier: 1, confidence: 0.6, hitCount: 3, validatedCount: 3, surfaceCount: 9 }),
  pt('bbbbbbbb-2', { createdFrom: 'session-extractor', tier: 2, confidence: 0.8, hitCount: 2, surfaceCount: 30, ignoreCount: 8, betaEvidence: { pos: 1, neg: 30, v: 1, sessions: [] } }),
  pt('cccccccc-3', { createdFrom: 'session-extractor', tier: 2, confidence: 0.4, hitCount: 0, surfaceCount: 10, ignoreCount: 2, betaEvidence: { pos: 25, neg: 0, v: 1, sessions: [] } }),
  pt('dddddddd-4', { createdFrom: 'seed-common-doc', tier: 0, confidence: 0.7 }, 'experience-principles'),
  pt('eeeeeeee-5', { createdFrom: 'bulk-seed', tier: 1, confidence: 0.2 }),
  { id: 'broken', collection: 'x', payload: { json: '{not json' } },
];

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

test('replay: legacy vs beta pass rates, flips, groups and sweep', () => {
  const r = R.replay(CORPUS);
  assert.equal(r.overall.entries, 5, 'unparseable payloads are skipped');
  assert.equal(r.overall.flippedToFail, 1, 'strong negative evidence flips bbbbbbbb to fail');
  assert.equal(r.overall.flippedToPass, 1, 'strong positive evidence flips cccccccc to pass');
  assert.deepEqual(Object.keys(r.byCreatedFrom), ['bulk-seed', 'seed-common-doc', 'session-extractor']);
  assert.deepEqual(Object.keys(r.byTier), ['0', '1', '2']);
  assert.equal(r.byCreatedFrom['seed-common-doc'].lowEvidenceShare, 1);
  assert.equal(r.sweep.length, R.SWEEP.length);
  const rates = r.sweep.map((s) => s.betaPassRate);
  assert.ok(rates.every((v, i) => i === 0 || v <= rates[i - 1]), 'pass rate falls as the threshold rises');
  assert.equal(r.settings.betaMinConfidence, 0.42, 'defaults to minConfidence');
});

test('intercept replay is removal-side and resolves 8-char ids', () => {
  const rows = [
    { op: 'intercept', stage: 'search_done', surfaced: [{ collection: 'experience-behavioral', pointId: 'aaaaaaaa' }, { collection: 'experience-behavioral', pointId: 'bbbbbbbb' }] },
    { op: 'intercept', stage: 'search_done', surfaced: [{ collection: 'experience-behavioral', pointId: 'bbbbbbbb' }] },
    { op: 'intercept', stage: 'search_done', surfaced: [] },
    { op: 'intercept', stage: 'search_done', surfaced: [{ collection: 'x', pointId: 'zzzzzzzz' }] },
  ];
  const r = R.replay(CORPUS, { interceptRows: rows });
  assert.equal(r.intercepts.intercepts, 4);
  assert.equal(r.intercepts.legacyHintsPerIntercept, 4 / 4);
  assert.equal(r.intercepts.betaHintsPerIntercept, 2 / 4, 'bbbbbbbb dropped twice; unknown ids assumed unchanged');
  assert.equal(r.intercepts.legacyShareWithHint, 3 / 4);
  assert.equal(r.intercepts.betaShareWithHint, 2 / 4);
  assert.equal(r.intercepts.unresolvedIds, 1);
});

test('CLI: --from-file with an activity log, text and JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-beta-replay-cli-'));
  const corpus = path.join(dir, 'points.json');
  fs.writeFileSync(corpus, JSON.stringify(CORPUS));
  const activity = path.join(dir, 'activity.jsonl');
  fs.writeFileSync(activity, [
    JSON.stringify({ op: 'intercept', stage: 'search_done', surfaced: [{ pointId: 'bbbbbbbb' }] }),
    JSON.stringify({ op: 'feedback' }),
  ].join('\n') + '\n');
  const env = { ...process.env, HOME, USERPROFILE: HOME };
  const text = spawnSync(process.execPath, [TOOL, '--from-file', corpus, '--activity', activity], { encoding: 'utf8', env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Beta confidence replay/);
  assert.match(text.stdout, /removal-side only/);
  const json = JSON.parse(spawnSync(process.execPath, [TOOL, '--from-file', corpus, '--activity', activity, '--json', '--beta-min-confidence', '0.6'], { encoding: 'utf8', env }).stdout);
  assert.equal(json.settings.betaMinConfidence, 0.6);
  assert.equal(json.intercepts.intercepts, 1);
});

test('--store reads FileStore collections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-beta-replay-store-'));
  fs.writeFileSync(path.join(dir, 'experience-behavioral.json'), JSON.stringify(CORPUS.slice(0, 2).map((p) => ({ id: p.id, vector: [], payload: p.payload }))));
  const pts = R.loadFromStore(dir, ['experience-behavioral', 'experience-selfqa']);
  assert.deepEqual(pts.map((p) => p.id), ['aaaaaaaa-1', 'bbbbbbbb-2']);
});
