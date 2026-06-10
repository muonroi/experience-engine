#!/usr/bin/env node
'use strict';

/**
 * register-hooks-session.test.js — SessionStart wiring across runtimes.
 *
 * The Project Brief is delivered via each runtime's native SessionStart hook
 * (Claude/Codex/Gemini all expose one + hookSpecificOutput.additionalContext).
 * This verifies register-hooks.js wires interceptor-session.js into each agent
 * settings file when EXP_INTERCEPTOR_SESSION is provided, and stays
 * backward-compatible (no SessionStart) when it is not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTER = path.join(__dirname, '..', '.experience', 'register-hooks.js');

function run(home, env = {}) {
  return spawnSync(process.execPath, [REGISTER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      EXP_INTERCEPTOR: '/x/interceptor.js',
      EXP_INTERCEPTOR_POST: '/x/interceptor-post.js',
      EXP_INTERCEPTOR_PROMPT: '/x/interceptor-prompt.js',
      EXP_STOP: '/x/stop-extractor.js',
      EXP_SELECTED_AGENTS: 'claude,codex,gemini,antigravity',
      EXP_REGISTER_MODE: 'full',
      ...env,
    },
  });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function sessionStartHasSessionHook(cfg) {
  const list = cfg?.hooks?.SessionStart || [];
  return list.some(h => (h.hooks || []).some(e => String(e.command || '').includes('interceptor-session')));
}

test('register-hooks wires SessionStart for claude/codex/gemini when session hook provided', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-reg-'));
  const res = run(home, { EXP_INTERCEPTOR_SESSION: '/x/interceptor-session.js' });
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const claude = readJson(path.join(home, '.claude', 'settings.json'));
  const codex = readJson(path.join(home, '.codex', 'hooks.json'));
  const gemini = readJson(path.join(home, '.gemini', 'settings.json'));
  const antigravity = readJson(path.join(home, '.antigravity', 'hooks.json'));

  assert.ok(sessionStartHasSessionHook(claude), 'claude SessionStart must wire interceptor-session');
  assert.ok(sessionStartHasSessionHook(codex), 'codex SessionStart must wire interceptor-session');
  assert.ok(sessionStartHasSessionHook(gemini), 'gemini SessionStart must wire interceptor-session');
  assert.ok(sessionStartHasSessionHook(antigravity), 'antigravity SessionStart must wire interceptor-session');
  // Antigravity tags runtime for consistent attribution.
  assert.ok(
    (antigravity.hooks.SessionStart || []).some(h => (h.hooks || []).some(e => String(e.command || '').includes('--runtime=antigravity'))),
    'antigravity SessionStart must carry --runtime=antigravity'
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test('register-hooks is idempotent — no duplicate SessionStart entries on re-run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-reg-'));
  run(home, { EXP_INTERCEPTOR_SESSION: '/x/interceptor-session.js' });
  run(home, { EXP_INTERCEPTOR_SESSION: '/x/interceptor-session.js' });
  const claude = readJson(path.join(home, '.claude', 'settings.json'));
  const count = (claude.hooks.SessionStart || [])
    .filter(h => (h.hooks || []).some(e => String(e.command || '').includes('interceptor-session'))).length;
  assert.equal(count, 1, 'SessionStart should wire exactly once');
  fs.rmSync(home, { recursive: true, force: true });
});

test('register-hooks stays backward-compatible — no SessionStart without the session hook env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-reg-'));
  const res = run(home); // no EXP_INTERCEPTOR_SESSION
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const claude = readJson(path.join(home, '.claude', 'settings.json'));
  assert.ok(!sessionStartHasSessionHook(claude), 'no SessionStart wiring expected when env is absent');
  fs.rmSync(home, { recursive: true, force: true });
});
