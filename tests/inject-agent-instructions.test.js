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

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-inject-')).replace(/\\/g, '/');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function runInjector(home, extraEnv = {}) {
  return execFileSync('bash', [SCRIPT], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    encoding: 'utf8',
  });
}

const countBlocks = (s) => (s.match(/experience-engine:start/g) || []).length;

test('creates the managed block in a missing CLAUDE.md (parent dir exists)', () => {
  const home = freshHome();
  runInjector(home);
  const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal(countBlocks(md), 1);
  assert.match(md, /exp-recall\.js/);
  assert.match(md, /exp-feedback\.js/);
});

test('replaces a stale raw-curl block (auto-migration), leaving exactly one block', () => {
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

test('idempotent: a second run produces byte-identical output', () => {
  const home = freshHome();
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  runInjector(home);
  const first = fs.readFileSync(claude, 'utf8');
  runInjector(home);
  const second = fs.readFileSync(claude, 'utf8');
  assert.equal(first, second);
  assert.equal(countBlocks(second), 1);
});

test('skips a target whose parent dir is absent', () => {
  const home = freshHome();
  // Only .claude exists; .gemini/.codex do not.
  runInjector(home);
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'GEMINI.md')));
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
});

test('EXPERIENCE_SKIP_MD_INJECT=1 leaves files untouched', () => {
  const home = freshHome();
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claude, '# untouched\n');
  runInjector(home, { EXPERIENCE_SKIP_MD_INJECT: '1' });
  assert.equal(fs.readFileSync(claude, 'utf8'), '# untouched\n');
});
