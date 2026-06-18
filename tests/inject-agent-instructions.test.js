#!/usr/bin/env node
'use strict';

/**
 * inject-agent-instructions.test.js — managed agent-instruction block injector.
 *
 * Drives .experience/inject-agent-instructions.sh against a throwaway HOME and
 * pins the contract that install/upgrade rely on: create, stale-block migration,
 * idempotency, skip-when-uninstalled, and the EXPERIENCE_SKIP_MD_INJECT opt-out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '.experience', 'inject-agent-instructions.sh').replace(/\\/g, '/');

// Resolve a POSIX bash able to run the installer. On Windows, the `bash` on PATH
// is frequently WSL (C:\Windows\System32\bash.exe), which cannot resolve a
// Windows-style script path like D:/repo/script.sh (it expects /mnt/d/...), so it
// exits 127. Git Bash (MSYS2) translates Windows drive paths transparently, so we
// point at it explicitly rather than trusting PATH order. Returns the bash to use,
// or null when none is usable (→ the bash-dependent cases skip with a clear reason;
// the .sh is a POSIX installer never executed on Windows in production anyway).
// On non-Windows this is always plain `bash`, so Linux/CI behaviour is unchanged.
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  const roots = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, 'Git', 'bin', 'bash.exe'),
    path.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ]);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const BASH = resolveBash();
const bashOpts = BASH
  ? {}
  : { skip: 'no POSIX bash that resolves Windows paths (Git Bash not found; WSL bash cannot run D:/ paths)' };

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-inject-')).replace(/\\/g, '/');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function runInjector(home, extraEnv = {}) {
  return execFileSync(BASH, [SCRIPT], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    encoding: 'utf8',
  });
}

const countBlocks = (s) => (s.match(/experience-engine:start/g) || []).length;

test('creates the managed block in a missing CLAUDE.md (parent dir exists)', bashOpts, () => {
  const home = freshHome();
  runInjector(home);
  const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal(countBlocks(md), 1);
  assert.match(md, /exp-recall\.js/);
  assert.match(md, /exp-feedback\.js/);
});

test('replaces a stale raw-curl block (auto-migration), leaving exactly one block', bashOpts, () => {
  const home = freshHome();
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  // Seed user content + an OLD block that taught the forbidden raw curl call.
  fs.writeFileSync(claude, [
    '# My notes',
    'keep me',
    '<!-- experience-engine:start -->',
    '## Experience Engine Hooks',
    "report it: curl -s -X POST http://localhost:8082/api/feedback -d '{}'",
    '<!-- experience-engine:end -->',
    'tail content',
    '',
  ].join('\n'));

  runInjector(home);
  const md = fs.readFileSync(claude, 'utf8');
  assert.equal(countBlocks(md), 1, 'must not duplicate the managed block');
  assert.ok(md.includes('# My notes') && md.includes('keep me') && md.includes('tail content'),
    'surrounding user content is preserved');
  assert.match(md, /exp-feedback\.js/, 'migrated to the helper-based command');
  // The new block mentions the URL only in a "NOT raw curl" warning; what must be
  // gone is the stale ACTIONABLE command that told the agent to POST to it.
  assert.doesNotMatch(md, /curl -s -X POST/, 'stale actionable raw-curl command is gone');
});

test('idempotent: a second run produces byte-identical output', bashOpts, () => {
  const home = freshHome();
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  runInjector(home);
  const first = fs.readFileSync(claude, 'utf8');
  runInjector(home);
  const second = fs.readFileSync(claude, 'utf8');
  assert.equal(first, second);
  assert.equal(countBlocks(second), 1);
});

test('skips a target whose parent dir is absent', bashOpts, () => {
  const home = freshHome();
  // Only .claude exists; .gemini/.codex do not.
  runInjector(home);
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'GEMINI.md')));
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
});

test('EXPERIENCE_SKIP_MD_INJECT=1 leaves files untouched', bashOpts, () => {
  const home = freshHome();
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claude, '# untouched\n');
  runInjector(home, { EXPERIENCE_SKIP_MD_INJECT: '1' });
  assert.equal(fs.readFileSync(claude, 'utf8'), '# untouched\n');
});
