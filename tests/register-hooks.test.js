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

test('existing-only repairs legacy Bun/Node commands without changing unrelated hooks or backfill', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-legacy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = (script, args = '') => `command -v bun >/dev/null 2>&1 && bun "${script}"${args} || command -v node >/dev/null 2>&1 && node "${script}"${args} || true`;
  const custom = { type: 'command', command: 'node "/other/interceptor-prompt.js"', timeout: 17 };
  const foreignLegacy = { type: 'command', command: legacy('/other/interceptor-prompt.js'), timeout: 9 };
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const target = path.join(home, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ theme: 'keep', hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacy('/x/interceptor-prompt.js'), timeout: 5, statusMessage: 'Keep status' }, custom, foreignLegacy] }],
      SessionStart: [{ hooks: [{ type: 'command', command: legacy('/x/stop-extractor.js', ' --backfill'), timeout: 60 }] }],
      Stop: [{ hooks: [{ type: 'command', command: legacy('/x/stop-extractor.js'), timeout: 90 }] }],
    } }));
  }
  const env = { EXP_SELECTED_AGENTS: 'claude,codex', EXP_REGISTER_MODE: 'existing-only' };
  runRegister(home, env);
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const target = path.join(home, file);
    const cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(cfg.theme, 'keep');
    assert.deepEqual(cfg.hooks.UserPromptSubmit[0].hooks, [
      { type: 'command', command: 'node "/x/interceptor-prompt.js"', timeout: 5, statusMessage: 'Keep status' }, custom, foreignLegacy,
    ]);
    assert.equal(cfg.hooks.SessionStart[0].hooks[0].command, 'node "/x/stop-extractor.js" --backfill');
    assert.equal(cfg.hooks.SessionStart[0].hooks[0].timeout, 60);
    assert.equal(cfg.hooks.Stop[0].hooks[0].command, 'node "/x/stop-extractor.js"');
    const before = fs.readFileSync(target, 'utf8');
    runRegister(home, env);
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'repair must be idempotent');
  }
  assert.equal(fs.existsSync(path.join(home, '.gemini/settings.json')), false);
});

for (const [name, before, expected] of [
  ['existing hooks enabled', '[features]\nhooks = true\nother = true\n', '[features]\nhooks = true\nother = true\n'],
  ['explicit hooks disabled', '[features]\nhooks = false # user choice\n', '[features]\nhooks = false # user choice\n'],
  ['existing feature table', '[features]\nother = true\n[profile]\nname = "keep"\n', '[features]\nhooks = true\nother = true\n[profile]\nname = "keep"\n'],
  ['legacy alias', '[features]\ncodex_hooks = true # old install\nother = true\n', '[features]\nhooks = true # old install\nother = true\n'],
  ['fresh config', '', '[features]\nhooks = true\n'],
  ['dotted hooks key', 'features.hooks = false\n[profile]\nname = "keep"\n', 'features.hooks = false\n[profile]\nname = "keep"\n'],
  ['modern key overrides legacy alias', '[features]\ncodex_hooks = true\nhooks = false\n', '[features]\nhooks = false\n'],
  ['CRLF feature table', '[features]\r\nhooks = true\r\n', '[features]\r\nhooks = true\r\n'],
]) {
  test(`Codex registration uses modern hooks feature without duplicate tables: ${name}`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-rh-toml-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, '.codex/config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, before);
    runRegister(home, { EXP_SELECTED_AGENTS: 'codex' });
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
    runRegister(home, { EXP_SELECTED_AGENTS: 'codex' });
    assert.equal(fs.readFileSync(file, 'utf8'), expected, 'feature update must be idempotent');
  });
}
