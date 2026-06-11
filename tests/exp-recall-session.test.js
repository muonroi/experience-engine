#!/usr/bin/env node
'use strict';

/**
 * exp-recall-session.test.js — P2: session-id resolution for active recall.
 *
 * Recall must be attributable to a session so the engine can later detect
 * "agent ran N recalls in one session and stitched them" (runbook-candidate
 * signal). resolveSessionId precedence: --session > $EXP_SESSION > newest
 * transcript *.jsonl under the cwd's Claude project dir > null. The transcript
 * probe is best-effort and must never throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSessionId, encodeProjectDir, parseArgs } = require('../.experience/exp-recall.js');

function mkProjectsHome(cwd, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-sess-'));
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  let t = Date.now() - files.length * 10_000;
  for (const name of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{}\n');
    // Force deterministic mtime ordering (array order == oldest -> newest).
    t += 10_000;
    fs.utimesSync(p, new Date(t), new Date(t));
  }
  return home;
}

test('encodeProjectDir collapses drive colon and separators to dashes', () => {
  assert.equal(encodeProjectDir('D:\\sources\\Core\\muonroi-cli'), 'D--sources-Core-muonroi-cli');
  assert.equal(encodeProjectDir('/home/phila/muonroi-cli'), '-home-phila-muonroi-cli');
});

test('resolveSessionId: --session wins over env and transcript', () => {
  const cwd = '/tmp/projA';
  const home = mkProjectsHome(cwd, ['aaaa.jsonl', 'bbbb.jsonl']);
  const got = resolveSessionId({ session: 'explicit-id', cwd }, { EXP_SESSION: 'env-id' }, home);
  assert.equal(got, 'explicit-id');
});

test('resolveSessionId: $EXP_SESSION used when no --session', () => {
  const cwd = '/tmp/projB';
  const home = mkProjectsHome(cwd, ['aaaa.jsonl']);
  const got = resolveSessionId({ cwd }, { EXP_SESSION: 'env-id' }, home);
  assert.equal(got, 'env-id');
});

test('resolveSessionId: transcript fallback picks newest *.jsonl basename', () => {
  const cwd = '/tmp/projC';
  // array order is oldest -> newest, so "newest" is the last entry.
  const home = mkProjectsHome(cwd, ['old-session.jsonl', 'mid-session.jsonl', 'newest-session.jsonl']);
  const got = resolveSessionId({ cwd }, {}, home);
  assert.equal(got, 'newest-session');
});

test('resolveSessionId: ignores non-jsonl files in the project dir', () => {
  const cwd = '/tmp/projD';
  const home = mkProjectsHome(cwd, ['real.jsonl']);
  // Drop a newer non-transcript file; it must not be chosen.
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  const stray = path.join(dir, 'summary.md');
  fs.writeFileSync(stray, 'x');
  fs.utimesSync(stray, new Date(), new Date());
  const got = resolveSessionId({ cwd }, {}, home);
  assert.equal(got, 'real');
});

test('resolveSessionId: returns null when project dir is missing (no throw)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-empty-'));
  const got = resolveSessionId({ cwd: '/tmp/does-not-exist' }, {}, home);
  assert.equal(got, null);
});

test('parseArgs: --session flag is parsed and not treated as a query word', () => {
  const parsed = parseArgs(['node', 'exp-recall.js', '--session', 'sess-123', 'how', 'to', 'deploy']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.opts.session, 'sess-123');
  assert.equal(parsed.query, 'how to deploy');
});
