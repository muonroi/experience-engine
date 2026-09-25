#!/usr/bin/env node
'use strict';

// Session holdout on the server (spec §3 A3): /api/intercept, /api/posttool-batch
// and /api/project-brief return no passive output for a control session and carry
// the machine-readable marker; /api/posttool writes the outcome event for both arms.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_')) delete process.env[key];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-holdout-srv-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const CONFIG = path.join(HOME, '.experience', 'config.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
process.env.EXPERIENCE_CONFIG_PATH = CONFIG;
const LOG = path.join(HOME, 'exp', 'experiment.jsonl');

const ROOT = path.join(__dirname, '..', '..');
const config = require(path.join(ROOT, '.experience', 'src', 'config.js'));
const experiment = require(path.join(ROOT, '.experience', 'src', 'experiment.js'));
const apiConfig = require(path.join(ROOT, 'api', 'config.js'));
const hooks = require(path.join(ROOT, 'api', 'handlers', 'hooks.js'));
const observability = require(path.join(ROOT, 'api', 'handlers', 'observability.js'));
const core = apiConfig.loadExperienceCore();

function setConfig(obj) {
  fs.writeFileSync(CONFIG, JSON.stringify(obj));
  config.refreshConfig();
}

function sessionIn(arm, salt, share = 0.5) {
  for (let i = 0; i < 1000; i++) {
    const sid = `srv-${i}`;
    if (experiment.holdoutArm(sid, { share, salt }).arm === arm) return sid;
  }
  throw new Error('no session');
}

const req = (body) => Readable.from([Buffer.from(JSON.stringify(body))]);
function res() {
  const r = { status: null, body: null };
  r.writeHead = (s) => { r.status = s; };
  r.end = (t) => { r.body = JSON.parse(t); };
  return r;
}

const saved = {};
test.before(() => {
  for (const k of ['interceptWithMeta', 'buildProjectBrief', '_activityLog', '_reconcilePendingHints', '_stashSurfacedHints']) saved[k] = core[k];
  core._activityLog = () => {};
  core._reconcilePendingHints = async () => ({ touched: [], pending: [], implicitUnused: [], expired: [] });
  core._stashSurfacedHints = () => ({ stashed: 0 });
});
test.after(() => {
  Object.assign(core, saved);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
});
test.beforeEach(() => {
  fs.rmSync(path.dirname(LOG), { recursive: true, force: true });
  experiment._resetForTests();
  setConfig({ experimentHoldoutShare: 0.5, experimentSalt: 'srv', experimentLog: LOG });
});

test('/api/intercept: control marker → no suggestions, not even static-rule hints', async () => {
  const calls = [];
  core.interceptWithMeta = async (...args) => { calls.push(args); return { suggestions: null, surfacedIds: [], route: null, experiment: { arm: 'control' } }; };
  const r = res();
  const bigWrite = { file_path: '/repo/x.ts', content: 'x\n'.repeat(1500) };
  await hooks.handleIntercept(req({ toolName: 'Write', toolInput: bigWrite, sourceSession: 'c1', toolUseId: 'toolu_1' }), r);
  assert.deepEqual(r.body, { suggestions: null, hasSuggestions: false, surfacedIds: [], route: null, experiment: { arm: 'control' } });
  assert.equal(calls[0][4].toolUseId, 'toolu_1', 'toolUseId reaches the exposure event');
});

test('/api/intercept: treatment passes the marker through; no marker without an experiment', async () => {
  core.interceptWithMeta = async () => ({ suggestions: 'hint [id:aaaaaaaa col:experience-behavioral]', surfacedIds: [{ id: 'a', collection: 'experience-behavioral' }], route: null, experiment: { arm: 'treatment', interceptId: 'i-1' } });
  const r = res();
  await hooks.handleIntercept(req({ toolName: 'Edit', toolInput: { file_path: '/repo/x.ts' }, sourceSession: 't1' }), r);
  assert.equal(r.body.hasSuggestions, true);
  assert.deepEqual(r.body.experiment, { arm: 'treatment', interceptId: 'i-1' });

  core.interceptWithMeta = async () => ({ suggestions: null, surfacedIds: [], route: null });
  const r2 = res();
  await hooks.handleIntercept(req({ toolName: 'Edit', toolInput: { file_path: '/repo/x.ts' } }), r2);
  assert.deepEqual(Object.keys(r2.body), ['suggestions', 'hasSuggestions', 'surfacedIds', 'route'], 'default response shape unchanged');
});

test('/api/posttool-batch: control → no hint, marker present', async () => {
  core.interceptWithMeta = async () => ({ suggestions: null, surfacedIds: [], route: null, experiment: { arm: 'control' } });
  const r = res();
  await hooks.handlePostToolBatch(req({ tools: [{ tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts' } }], sessionId: 'c1' }), r);
  assert.deepEqual(r.body, { hint: null, surfacedIds: [], batchSize: 1, experiment: { arm: 'control' } });
});

test('/api/project-brief: control session gets no brief; treatment gets it with the marker', async () => {
  let built = 0;
  core.buildProjectBrief = async (slug) => { built++; return { text: `[Project Brief] ${slug}`, entries: [{ id: 'e1' }], projectSlug: slug, count: 1, cached: false }; };
  const control = sessionIn('control', 'srv');
  const treatment = sessionIn('treatment', 'srv');

  const rc = res();
  await observability.handleProjectBrief(Object.assign(req({ project: 'golden-app', sourceSession: control, sourceRuntime: 'claude-code' }), { method: 'POST' }), rc, new URL('http://x/api/project-brief'));
  assert.deepEqual(rc.body, { text: null, entries: [], projectSlug: 'golden-app', count: 0, cached: false, experiment: { arm: 'control' } });
  assert.equal(built, 0);

  const rt = res();
  await observability.handleProjectBrief(Object.assign(req({ project: 'golden-app', sourceSession: treatment }), { method: 'POST' }), rt, new URL('http://x/api/project-brief'));
  assert.equal(rt.body.text, '[Project Brief] golden-app');
  assert.deepEqual(rt.body.experiment, { arm: 'treatment' });

  // Dashboard GET: no session, never in the experiment, response unchanged.
  const rg = res();
  await observability.handleProjectBrief({ method: 'GET' }, rg, new URL('http://x/api/project-brief?project=golden-app'));
  assert.equal(rg.body.experiment, undefined);

  const arms = experiment.readExperimentLog(LOG).filter((e) => e.event === 'session-arm');
  assert.deepEqual(arms.map((e) => [e.sourceSession, e.arm]), [[control, 'control'], [treatment, 'treatment']]);
});

test('/api/project-brief: no experiment → byte-identical legacy response', async () => {
  setConfig({ experimentLog: LOG });
  core.buildProjectBrief = async (slug) => ({ text: 'b', entries: [], projectSlug: slug, count: 0, cached: false });
  const r = res();
  await observability.handleProjectBrief(Object.assign(req({ project: 'p', sourceSession: 's' }), { method: 'POST' }), r, new URL('http://x/api/project-brief'));
  assert.deepEqual(r.body, { text: 'b', entries: [], projectSlug: 'p', count: 0, cached: false });
  assert.equal(fs.existsSync(LOG), false, 'no experiment log without an experiment');
});

test('/api/posttool: outcome event for both arms, with the strict failure field', async () => {
  const control = sessionIn('control', 'srv');
  for (const [sid, body] of [
    [control, { toolName: 'Bash', toolInput: { command: 'npm test' }, toolOutput: { exit_code: 1 }, hookEvent: 'PostToolUse', toolUseId: 'u1', runtime: 'claude-code', clientTs: 'c1' }],
    ['t-x', { toolName: 'Edit', toolInput: { file_path: '/a.ts' }, toolOutput: {}, hookEvent: 'PostToolUse', toolUseId: 'u2', runtime: 'claude-code' }],
  ]) {
    const r = res();
    await hooks.handlePostTool(req({ ...body, sourceSession: sid, sourceRuntime: 'codex-wsl', surfacedIds: [] }), r);
    assert.equal(r.body.ok, true);
  }
  const outcomes = experiment.readExperimentLog(LOG).filter((e) => e.event === 'outcome');
  assert.equal(outcomes.length, 2);
  assert.deepEqual(
    { s: outcomes[0].sourceSession, f: outcomes[0].failure, o: outcomes[0].toolOutcome, u: outcomes[0].toolUseId, rt: outcomes[0].runtime, c: outcomes[0].clientTs },
    { s: control, f: 'fail', o: 'error', u: 'u1', rt: 'claude-code', c: 'c1' },
  );
  assert.equal(outcomes[1].failure, 'ok');
  assert.match(outcomes[0].inputHash, /^[0-9a-f]{16}$/);
});
