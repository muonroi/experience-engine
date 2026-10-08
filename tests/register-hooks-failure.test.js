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

function runRegister(home, agents, mode = 'full') {
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
      EXP_REGISTER_MODE: mode,
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

// The upgrade path (upgrade.sh → sync-install.sh, and `update` → `init --yes`)
// runs register-hooks in existing-only mode. An install from before the failure
// hook existed must gain it there, or ADR-004 never sees a failed call from it.
test('upgrade (existing-only): an install wired before the failure hook gains it, user settings kept', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-upgrade-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = {
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node "/old/interceptor.js"', timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node "/old/interceptor-post.js"', timeout: 5 }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  runRegister(home, 'claude', 'existing-only');

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(commands(after.hooks.PostToolUseFailure), ['node "/x/interceptor-post.js" --event=failure']);
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.hooks.Notification, before.hooks.Notification);
  assert.deepEqual(commands(after.hooks.PreToolUse), ['node "/old/interceptor.js"'], 'existing entries are not duplicated');
});

test('upgrade (existing-only): an agent never wired is left alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-upgrade-none-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = JSON.stringify({ model: 'opus' }, null, 2);
  fs.writeFileSync(file, before);
  runRegister(home, 'claude', 'existing-only');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
