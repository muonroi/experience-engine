#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_EXP = path.join(__dirname, '..', '..', '.experience');
const SWALLOW = path.join(REPO_EXP, 'src', 'swallow.js');
const { swallow, safeUnlink, isMissing } = require(SWALLOW);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withActivityLog(fn) {
  const dir = tmpDir('ee-swallow-');
  const log = path.join(dir, 'activity.jsonl');
  const prev = process.env.EXPERIENCE_ACTIVITY_LOG;
  process.env.EXPERIENCE_ACTIVITY_LOG = log;
  try {
    fn(dir, log);
  } finally {
    if (prev === undefined) delete process.env.EXPERIENCE_ACTIVITY_LOG;
    else process.env.EXPERIENCE_ACTIVITY_LOG = prev;
  }
}

function readEntries(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('swallow appends one swallowed entry with where, code and message', () => {
  withActivityLog((_dir, log) => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    swallow('test.site', err);
    const entries = readEntries(log);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].op, 'swallowed');
    assert.equal(entries[0].where, 'test.site');
    assert.equal(entries[0].code, 'EACCES');
    assert.equal(entries[0].msg, 'boom');
    assert.ok(entries[0].ts);
  });
});

test('swallow truncates long messages and accepts non-Error values', () => {
  withActivityLog((_dir, log) => {
    swallow('test.long', new Error('x'.repeat(1000)));
    swallow('test.string', 'plain reason');
    const [long, str] = readEntries(log);
    assert.equal(long.msg.length, 300);
    assert.equal(str.msg, 'plain reason');
    assert.equal(str.code, null);
  });
});

test('swallow never throws when the activity log is unwritable', () => {
  const prev = process.env.EXPERIENCE_ACTIVITY_LOG;
  process.env.EXPERIENCE_ACTIVITY_LOG = path.join(tmpDir('ee-swallow-'), 'missing-dir', 'activity.jsonl');
  try {
    assert.doesNotThrow(() => swallow('test.unwritable', new Error('x')));
  } finally {
    if (prev === undefined) delete process.env.EXPERIENCE_ACTIVITY_LOG;
    else process.env.EXPERIENCE_ACTIVITY_LOG = prev;
  }
});

test('swallow writes nothing to stdout or stderr (hook stdout is the agent protocol)', () => {
  const dir = tmpDir('ee-swallow-');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SWALLOW)}).swallow('test.stdout', new Error('x'))`], {
    env: { ...process.env, EXPERIENCE_ACTIVITY_LOG: path.join(dir, 'activity.jsonl') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(readEntries(path.join(dir, 'activity.jsonl')).length, 1);
});

test('safeUnlink removes a file and treats an already-missing file as not an error', () => {
  withActivityLog((dir, log) => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{}');
    assert.equal(safeUnlink(file, 'test.unlink'), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(safeUnlink(file, 'test.unlink'), false);
    assert.deepEqual(readEntries(log), [], 'ENOENT is not recorded');
  });
});

test('safeUnlink records a failure that is not ENOENT', () => {
  withActivityLog((dir, log) => {
    const sub = path.join(dir, 'a-directory');
    fs.mkdirSync(sub);
    assert.equal(safeUnlink(sub, 'test.unlinkDir'), false);
    const entries = readEntries(log);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].where, 'test.unlinkDir');
    assert.notEqual(entries[0].code, 'ENOENT');
  });
});

test('isMissing is true only for ENOENT', () => {
  assert.equal(isMissing(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(isMissing(Object.assign(new Error('x'), { code: 'EACCES' })), false);
  assert.equal(isMissing(null), false);
});

test('a hook copied without src/swallow.js (older install) still loads', () => {
  const home = tmpDir('ee-swallow-hook-');
  const expDir = path.join(home, '.experience');
  fs.mkdirSync(expDir, { recursive: true });
  const hooks = ['interceptor.js', 'interceptor-post.js', 'interceptor-prompt.js'];
  for (const f of hooks.concat('remote-client.js')) fs.copyFileSync(path.join(REPO_EXP, f), path.join(expDir, f));
  // A required module: the fallback must not throw at require time.
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(expDir, 'remote-client.js'))})`], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  // Entry-point hooks: an empty stdin payload must still exit 0.
  for (const hook of hooks) {
    const h = spawnSync(process.execPath, [path.join(expDir, hook)], {
      input: '{}',
      env: { ...process.env, HOME: home, USERPROFILE: home, EXPERIENCE_DEPTH: '0' },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(h.status, 0, `${hook} exited ${h.status}: ${h.stderr}`);
  }
});
