#!/usr/bin/env node
'use strict';

// PostToolUse fires only on success in Claude Code; failed calls arrive on
// PostToolUseFailure. register-hooks.js wires interceptor-post.js to it (with
// --event=failure) for Claude only — no other runtime has that event.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTER = path.resolve(__dirname, '..', '.experience', 'register-hooks.js');

function runRegister(home, agents) {
  const r = spawnSync(process.execPath, [REGISTER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      EXP_INTERCEPTOR: '/x/interceptor.js',
      EXP_INTERCEPTOR_POST: '/x/interceptor-post.js',
      EXP_INTERCEPTOR_PROMPT: '/x/interceptor-prompt.js',
      EXP_STOP: '/x/stop-extractor.js',
      EXP_SELECTED_AGENTS: agents,
      EXP_REGISTER_MODE: 'full',
    },
  });
  assert.equal(r.status, 0, r.stderr);
}

function readHooks(home, rel) {
  return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')).hooks || {};
}

function commands(list) {
  return (list || []).flatMap((e) => (e.hooks || []).map((h) => h.command || ''));
}

test('Claude: PostToolUseFailure is wired to interceptor-post with --event=failure, same matcher', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-fail-'));
  runRegister(home, 'claude');
  const hooks = readHooks(home, path.join('.claude', 'settings.json'));
  const entries = hooks.PostToolUseFailure || [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, 'Edit|Write|Bash');
  assert.deepEqual(commands(entries), ['node "/x/interceptor-post.js" --event=failure']);
  // The success hook is untouched.
  assert.deepEqual(commands(hooks.PostToolUse), ['node "/x/interceptor-post.js"']);
});

test('Claude: failure wiring is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-fail-idem-'));
  runRegister(home, 'claude');
  runRegister(home, 'claude');
  const hooks = readHooks(home, path.join('.claude', 'settings.json'));
  assert.equal(commands(hooks.PostToolUseFailure).length, 1);
  assert.equal(commands(hooks.PostToolUse).length, 1);
});

test('Codex has no failure event and gets none', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-fail-codex-'));
  runRegister(home, 'codex');
  const hooks = readHooks(home, path.join('.codex', 'hooks.json'));
  assert.equal(hooks.PostToolUseFailure, undefined);
});
