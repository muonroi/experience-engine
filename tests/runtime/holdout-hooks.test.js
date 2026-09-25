#!/usr/bin/env node
'use strict';

// Session holdout in the hooks (spec §3 A3): a hook that sees the server's
// `experiment: {arm:'control'}` marker adds none of its own passive output — no
// PreToolUse risk-gate nudge, no prompt risk gate / auto-recall, no SessionStart
// brief. A treatment session behaves exactly as before. Remote mode, loopback
// server; the hook scripts run from the repo, remote-client.js is copied into the
// temp HOME like an install.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const EXP_SRC = path.join(__dirname, '..', '..', '.experience');
const probe = spawnSync(process.execPath, ['-e', "require('http').createServer().listen(0,'127.0.0.1',function(){this.close(()=>process.exit(0))})"], { encoding: 'utf8' });
// Same policy as remote-hooks.test.js: hook subprocesses racing loopback timeouts
// are too timing-sensitive for shared CI runners.
const SHARED_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const SKIP = probe.error || probe.status !== 0
  ? 'sandbox blocks child processes or loopback listen'
  : SHARED_CI ? 'shared CI runner is too timing-sensitive for remote hook loopback checks' : false;

function makeHome(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-holdout-hooks-'));
  fs.mkdirSync(path.join(home, '.experience', 'tmp'), { recursive: true });
  fs.copyFileSync(path.join(EXP_SRC, 'remote-client.js'), path.join(home, '.experience', 'remote-client.js'));
  fs.writeFileSync(path.join(home, '.experience', 'config.json'), JSON.stringify({ serverBaseUrl: `http://127.0.0.1:${port}`, serverHookTimeoutMs: 1500 }));
  return home;
}

function makeRepo(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-holdout-repo-')), name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
  return dir;
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX|GEMINI|EXPERIENCE_)/.test(k)) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, EXPERIENCE_HOOK_DEBUG_LOG: path.join(home, 'debug.jsonl'), ...extra };
}

function runHook(home, script, payload, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(EXP_SRC, script)], { env: cleanEnv(home, extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} timed out`)); }, 10000);
    child.once('error', reject);
    child.once('close', () => { clearTimeout(timer); resolve(stdout); });
    child.stdin.end(JSON.stringify(payload));
  });
}

// Loopback server: the session id decides the arm, like the real server would.
async function startServer({ hangIntercept = false } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ url: req.url, body });
      const session = body.sourceSession || '';
      const arm = session.startsWith('ctl') ? 'control' : 'treatment';
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/intercept') {
        if (hangIntercept) return; // never answers → hook times out
        return arm === 'control'
          ? send({ suggestions: null, hasSuggestions: false, surfacedIds: [], route: null, experiment: { arm } })
          : send({ suggestions: null, hasSuggestions: false, surfacedIds: [], route: null, experiment: { arm, interceptId: 'i' } });
      }
      if (req.url === '/api/recall') return send({ text: null, entries: [], count: 0 });
      if (req.url === '/api/project-brief') {
        return arm === 'control'
          ? send({ text: null, entries: [], projectSlug: body.project, count: 0, cached: false, experiment: { arm } })
          : send({ text: `[Project Brief] ${body.project}`, entries: [], projectSlug: body.project, count: 1, cached: false, experiment: { arm } });
      }
      return send({ ok: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, received };
}

test('PreToolUse: control marker suppresses the risk-gate nudge; treatment keeps it', { skip: SKIP }, async () => {
  const { server, port, received } = await startServer();
  try {
    const home = makeHome(port);
    const cwd = makeRepo('golden-app');
    const payload = (session) => ({ hook_event_name: 'PreToolUse', session_id: session, tool_use_id: `toolu-${session}`, tool_name: 'Bash', tool_input: { command: 'npm run deploy -- --prod' }, cwd });
    const control = await runHook(home, 'interceptor.js', payload('ctl-1'));
    const treatment = await runHook(home, 'interceptor.js', payload('trt-1'));
    assert.ok(!/risk gate/.test(control), `control got a nudge: ${control}`);
    assert.match(treatment, /risk gate/, 'treatment behaves as before');
    const intercepts = received.filter((r) => r.url === '/api/intercept');
    assert.equal(intercepts[0].body.toolUseId, 'toolu-ctl-1', 'tool_use_id forwarded for the exposure event');
    const remembered = JSON.parse(fs.readFileSync(path.join(home, '.experience', 'tmp', 'experiment-arms.json'), 'utf8'));
    assert.equal(remembered['ctl-1'].arm, 'control');
  } finally { server.close(); }
});

test('UserPromptSubmit: control marker skips the risk gate and its auto-recall', { skip: SKIP }, async () => {
  const { server, port, received } = await startServer();
  try {
    const home = makeHome(port);
    const cwd = makeRepo('golden-app');
    const payload = (session) => ({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'please run the production deploy migration now', cwd });
    const control = await runHook(home, 'interceptor-prompt.js', payload('ctl-2'));
    assert.equal(control, '', 'control session: no output at all');
    assert.equal(received.filter((r) => r.url === '/api/recall').length, 0, 'no auto-recall for control');
    assert.equal(received.find((r) => r.url === '/api/intercept').body.hookEvent, 'UserPromptSubmit');
    const treatment = await runHook(home, 'interceptor-prompt.js', payload('trt-2'));
    assert.match(treatment, /risk gate/);
  } finally { server.close(); }
});

test('UserPromptSubmit: on a timed-out search the remembered control arm still applies', { skip: SKIP }, async () => {
  const { server, port, received } = await startServer({ hangIntercept: true });
  try {
    const home = makeHome(port);
    fs.writeFileSync(path.join(home, '.experience', 'tmp', 'experiment-arms.json'), JSON.stringify({ 'ctl-3': { arm: 'control', ts: Date.now() } }));
    const cwd = makeRepo('golden-app');
    const out = await runHook(home, 'interceptor-prompt.js', { hook_event_name: 'UserPromptSubmit', session_id: 'ctl-3', prompt: 'please run the production deploy migration now', cwd }, { EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS: '300' });
    assert.equal(out, '');
    assert.equal(received.filter((r) => r.url === '/api/recall').length, 0);
  } finally { server.close(); }
});

test('SessionStart: control session gets no brief; the session id reaches the server; marked briefs are not replayed from cache', { skip: SKIP }, async () => {
  const { server, port, received } = await startServer();
  try {
    const home = makeHome(port);
    const cwd = makeRepo('golden-app');
    const control = await runHook(home, 'interceptor-session.js', { hook_event_name: 'SessionStart', session_id: 'ctl-4', cwd });
    assert.equal(control, '');
    const briefReq = received.find((r) => r.url === '/api/project-brief');
    assert.equal(briefReq.body.sourceSession, 'ctl-4');

    const treatment = await runHook(home, 'interceptor-session.js', { hook_event_name: 'SessionStart', session_id: 'trt-4', cwd });
    assert.match(treatment, /\[Project Brief\] golden-app/);
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.experience', 'tmp', 'brief-golden-app.json'), 'utf8'));
    assert.equal(cache.experimentActive, true);

    // A later control session must ask the server, not replay the cached brief.
    const control2 = await runHook(home, 'interceptor-session.js', { hook_event_name: 'SessionStart', session_id: 'ctl-5', cwd });
    assert.equal(control2, '');
    assert.equal(received.filter((r) => r.url === '/api/project-brief').length, 3);
  } finally { server.close(); }
});
