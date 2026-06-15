#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTER = path.resolve(__dirname, '..', '.experience', 'register-hooks.js');

function runRegister(home, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // os.homedir() reads USERPROFILE on Windows
    EXP_INTERCEPTOR: '/x/interceptor.js',
    EXP_INTERCEPTOR_POST: '/x/interceptor-post.js',
    EXP_INTERCEPTOR_PROMPT: '/x/interceptor-prompt.js',
    EXP_INTERCEPTOR_SESSION: '/x/interceptor-session.js',
    EXP_STOP: '/x/stop-extractor.js',
    EXP_SELECTED_AGENTS: 'claude',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [REGISTER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `register-hooks exited ${r.status}: ${r.stderr}`);
}

function claudeHooks(home) {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  return cfg.hooks || {};
}

function hasCmd(list, needle) {
  return (list || []).some((e) => (e.hooks || []).some((h) => (h.command || '').includes(needle)));
}

test('wires PostToolBatch when EXP_INTERCEPTOR_BATCH is provided', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-batch-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // mark Claude installed
  runRegister(home, { EXP_INTERCEPTOR_BATCH: '/x/posttool-batch-hook.js' });

  const hooks = claudeHooks(home);
  assert.ok(hasCmd(hooks.PostToolBatch, 'posttool-batch-hook'), 'PostToolBatch wired');
  // Sanity: the normal hooks are still there.
  assert.ok(hasCmd(hooks.PreToolUse, 'interceptor'), 'PreToolUse wired');
});

test('PostToolBatch wiring is idempotent (no duplicate on re-run)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-idem-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  runRegister(home, { EXP_INTERCEPTOR_BATCH: '/x/posttool-batch-hook.js' });
  runRegister(home, { EXP_INTERCEPTOR_BATCH: '/x/posttool-batch-hook.js' });

  const hooks = claudeHooks(home);
  const count = (hooks.PostToolBatch || []).reduce(
    (n, e) => n + (e.hooks || []).filter((h) => (h.command || '').includes('posttool-batch-hook')).length,
    0
  );
  assert.equal(count, 1, 'exactly one PostToolBatch entry');
});

test('omits PostToolBatch when EXP_INTERCEPTOR_BATCH is absent (backward compatible)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-none-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  runRegister(home); // no EXP_INTERCEPTOR_BATCH

  const hooks = claudeHooks(home);
  assert.ok(!hooks.PostToolBatch || hooks.PostToolBatch.length === 0, 'no PostToolBatch wired');
  assert.ok(hasCmd(hooks.PreToolUse, 'interceptor'), 'other hooks still wired');
});
