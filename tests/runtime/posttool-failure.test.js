#!/usr/bin/env node
'use strict';

// Phase A0.1/A0.2: the failure event is recorded (strict `failure`, inputHash,
// tool_use_id) next to the unchanged legacy toolOutcome, and it must NOT run the
// verdict pipeline (reconcile / judge / state cleanup) — before it was registered
// it never reached the engine, so doing so would change hint evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', '.experience', 'interceptor-post.js');

// A stand-in experience-core.js in the temp HOME: records what the hook calls.
const STUB_CORE = `
const fs = require('fs');
const out = process.env.STUB_CORE_LOG;
function rec(kind, payload) { fs.appendFileSync(out, JSON.stringify({ kind, payload }) + '\\n'); }
module.exports = {
  _activityLog: (e) => rec('activity', e),
  _reconcilePendingHints: async (surfaced, tool) => { rec('reconcile', { tool, surfaced: surfaced.length }); return { touched: [], pending: [], implicitUnused: [] }; },
};
`;

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|GEMINI|EXPERIENCE_)/.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ptf-'));
  fs.mkdirSync(path.join(home, '.experience', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(home, '.experience', 'experience-core.js'), STUB_CORE);
  return home;
}

function runHook(home, args, payload, extraEnv = {}) {
  const log = path.join(home, 'core-calls.jsonl');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: cleanEnv({ HOME: home, USERPROFILE: home, STUB_CORE_LOG: log, EXPERIENCE_HOOK_DEBUG_LOG: path.join(home, 'debug.jsonl'), ...extraEnv }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook timed out')); }, 8000);
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      let calls = [];
      try { calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      resolve(calls);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function writeState(home) {
  const file = path.join(home, '.experience', 'tmp', 'last-suggestions.json');
  fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tool: 'Bash', surfacedIds: [{ collection: 'experience-behavioral', id: 'abc' }] }));
  return file;
}

test('local hook: PostToolUseFailure records failure=fail and skips reconcile + state cleanup', async () => {
  const home = makeHome();
  const stateFile = writeState(home);
  const calls = await runHook(home, ['--event=failure'], {
    hook_event_name: 'PostToolUseFailure', session_id: 's-1', tool_use_id: 'toolu_1',
    tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Command failed with exit code 1',
  }, { CLAUDE_PROJECT_DIR: home });
  const parsed = calls.find((c) => c.kind === 'activity' && c.payload.stage === 'parsed');
  assert.ok(parsed, 'parsed stage logged');
  assert.equal(parsed.payload.failure, 'fail');
  assert.equal(parsed.payload.hookEvent, 'PostToolUseFailure');
  assert.equal(parsed.payload.toolUseId, 'toolu_1');
  assert.equal(parsed.payload.runtime, 'claude-code');
  assert.match(parsed.payload.inputHash, /^[0-9a-f]{16}$/);
  assert.equal(parsed.payload.toolOutcome, 'error', 'legacy classifier still reads the failure as error');
  assert.ok(!calls.some((c) => c.kind === 'reconcile'), 'no reconcile on the failure event');
  assert.ok(fs.existsSync(stateFile), 'last-suggestions.json left for the PostToolUse that owns it');
});

test('local hook: the flag alone (no hook_event_name) marks the failure event', async () => {
  const home = makeHome();
  const calls = await runHook(home, ['--event=failure'], { tool_name: 'Edit', tool_input: { file_path: '/x.ts' } });
  const parsed = calls.find((c) => c.kind === 'activity' && c.payload.stage === 'parsed');
  assert.equal(parsed.payload.failure, 'fail');
  assert.ok(!calls.some((c) => c.kind === 'reconcile'));
});

test('local hook: Claude PostToolUse success is failure=ok and still reconciles', async () => {
  const home = makeHome();
  const calls = await runHook(home, [], {
    hook_event_name: 'PostToolUse', session_id: 's-1', tool_use_id: 'toolu_2',
    tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', stderr: '', exit_code: 0 },
  }, { CLAUDE_PROJECT_DIR: home });
  const parsed = calls.find((c) => c.kind === 'activity' && c.payload.stage === 'parsed');
  assert.equal(parsed.payload.failure, 'ok');
  assert.equal(parsed.payload.toolOutcome, 'success');
  assert.ok(calls.some((c) => c.kind === 'reconcile'), 'the success path is unchanged');
});

// --- server handler ------------------------------------------------------------

function fakeReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  return req;
}

function fakeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (text) => { res.body = JSON.parse(text); };
  return res;
}

test('server /api/posttool: failure event logs outcome fields and skips reconcile + judge', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ptf-srv-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cfg = require(path.join(__dirname, '..', '..', 'api', 'config.js'));
    const core = cfg.loadExperienceCore();
    const hooks = require(path.join(__dirname, '..', '..', 'api', 'handlers', 'hooks.js'));
    const logged = [];
    let reconciled = 0;
    const saved = { log: core._activityLog, rec: core._reconcilePendingHints };
    core._activityLog = (e) => logged.push(e);
    core._reconcilePendingHints = async () => { reconciled++; return { touched: [], pending: [], implicitUnused: [], expired: [] }; };
    try {
      const res = fakeRes();
      await hooks.handlePostTool(fakeReq({
        toolName: 'Bash', toolInput: { command: 'npm test' }, toolOutput: { error: 'boom', is_error: true },
        surfacedIds: [], sourceSession: 's-9', sourceRuntime: 'codex-wsl',
        hookEvent: 'PostToolUseFailure', toolUseId: 'toolu_9', clientTs: '2026-09-25T00:00:00.000Z', runtime: 'claude-code',
      }), res);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, reconcile: { touched: [], pending: [], implicitUnused: [], expired: [] }, judgeQueued: false, toolOutcome: 'error' });
      assert.equal(reconciled, 0);
      const ev = logged.find((e) => e.op === 'posttool');
      assert.equal(ev.failure, 'fail');
      assert.equal(ev.toolOutcome, 'error');
      assert.equal(ev.toolUseId, 'toolu_9');
      assert.equal(ev.runtime, 'claude-code');
      assert.equal(ev.clientTs, '2026-09-25T00:00:00.000Z');

      // An old client (no hookEvent/runtime) keeps the legacy path and response.
      const res2 = fakeRes();
      await hooks.handlePostTool(fakeReq({ toolName: 'Edit', toolInput: { file_path: 'README.md' }, toolOutput: { output: 'ok' }, surfacedIds: [], sourceSession: 's-9', sourceRuntime: 'codex-test' }), res2);
      assert.deepEqual(res2.body, { ok: true, reconcile: { touched: [], pending: [], implicitUnused: [], expired: [] }, judgeQueued: false, toolOutcome: 'success' });
      assert.equal(reconciled, 1);
      const ev2 = logged.filter((e) => e.op === 'posttool')[1];
      assert.equal(ev2.failure, 'unknown', 'keyword-free output from a non-Claude runtime is unknown');
      assert.equal(ev2.hookEvent, 'PostToolUse');
    } finally {
      core._activityLog = saved.log;
      core._reconcilePendingHints = saved.rec;
    }
  } finally {
    process.env.HOME = prevHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

test('local hook: with an experiment active, both events write an outcome to the experiment log', async () => {
  const home = makeHome();
  const log = path.join(home, 'exp', 'experiment.jsonl');
  fs.writeFileSync(path.join(home, '.experience', 'config.json'), JSON.stringify({ experimentHoldoutShare: 0.5, experimentLog: log }));
  await runHook(home, ['--event=failure'], { hook_event_name: 'PostToolUseFailure', session_id: 'sx', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'exit 2' }, { CLAUDE_PROJECT_DIR: home });
  await runHook(home, [], { hook_event_name: 'PostToolUse', session_id: 'sx', tool_use_id: 'u2', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { exit_code: 0 } }, { CLAUDE_PROJECT_DIR: home });
  const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const outcomes = events.filter((e) => e.event === 'outcome');
  assert.deepEqual(outcomes.map((e) => [e.toolUseId, e.failure, e.hookEvent]), [['u1', 'fail', 'PostToolUseFailure'], ['u2', 'ok', 'PostToolUse']]);
  assert.equal(outcomes[0].inputHash, outcomes[1].inputHash, 'same command → same inputHash');
  assert.equal(events.filter((e) => e.event === 'session-arm').length, 1);
});

test('local hook: no experiment → no experiment log', async () => {
  const home = makeHome();
  const log = path.join(home, 'exp', 'experiment.jsonl');
  fs.writeFileSync(path.join(home, '.experience', 'config.json'), JSON.stringify({ experimentLog: log }));
  await runHook(home, ['--event=failure'], { hook_event_name: 'PostToolUseFailure', session_id: 'sx', tool_name: 'Bash', tool_input: { command: 'make' } });
  assert.equal(fs.existsSync(log), false);
});
