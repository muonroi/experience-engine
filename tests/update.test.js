#!/usr/bin/env node
'use strict';

/**
 * update.test.js — `experience-engine check-update` / `update` plumbing.
 *
 * Pins the version-comparison logic, the registry-backed check (with fetch
 * stubbed), install-mode detection, and the check-update exit-code contract
 * (0 up-to-date / 10 behind / 1 check failed). Network is never hit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const update = require('../bin/update');
const cli = require('../bin/cli');

// ── compareVersions ─────────────────────────────────────────────────────────
test('compareVersions: ordering, equality, padding, prerelease, v-prefix', () => {
  const c = update.compareVersions;
  assert.equal(c('0.5.0', '0.5.1'), -1);
  assert.equal(c('0.5.1', '0.5.0'), 1);
  assert.equal(c('0.5.1', '0.5.1'), 0);
  assert.equal(c('1.0.0', '0.9.9'), 1);
  assert.equal(c('0.6', '0.6.0'), 0); // missing patch padded to 0
  assert.equal(c('v0.5.1', '0.5.1'), 0); // leading v tolerated
  assert.equal(c('1.0.0-rc1', '1.0.0'), -1); // prerelease sorts below release
  assert.equal(c('1.0.0', '1.0.0-rc1'), 1);
});

// ── checkUpdate (fetch stubbed) ─────────────────────────────────────────────
function withStubbedFetch(latest, fn) {
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest } }),
  });
  return Promise.resolve(fn()).finally(() => { global.fetch = orig; });
}

test('checkUpdate: behind when installed < latest', async () => {
  await withStubbedFetch('0.6.0', async () => {
    const r = await update.checkUpdate({ installed: '0.5.1' });
    assert.equal(r.installed, '0.5.1');
    assert.equal(r.latest, '0.6.0');
    assert.equal(r.behind, true);
    assert.equal(r.upToDate, false);
  });
});

test('checkUpdate: up to date when installed == latest', async () => {
  await withStubbedFetch('0.5.1', async () => {
    const r = await update.checkUpdate({ installed: '0.5.1' });
    assert.equal(r.behind, false);
    assert.equal(r.upToDate, true);
  });
});

test('fetchLatest: throws on non-200', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    await assert.rejects(() => update.fetchLatest('https://x', 200), /HTTP 503/);
  } finally {
    global.fetch = orig;
  }
});

test('fetchLatest: throws when dist-tags.latest missing', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ name: 'x' }) });
  try {
    await assert.rejects(() => update.fetchLatest('https://x', 200), /dist-tags\.latest/);
  } finally {
    global.fetch = orig;
  }
});

// ── detectMode ──────────────────────────────────────────────────────────────
test('detectMode: git checkout → git, otherwise npm', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-upd-'));
  assert.equal(update.detectMode(tmp), 'npm');
  fs.mkdirSync(path.join(tmp, '.git'));
  assert.equal(update.detectMode(tmp), 'git');
});

// ── installedVersion ────────────────────────────────────────────────────────
test('installedVersion: reads package.json version next to the code', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-upd-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal(update.installedVersion(tmp), '9.9.9');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-upd-'));
  assert.throws(() => update.installedVersion(empty), /cannot read installed version/);
});

// ── main: check-update exit codes ───────────────────────────────────────────
function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}

test('main check-update: exit 10 + advisory when behind', async () => {
  const { io, out } = capture();
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '99.0.0' } }) });
  try {
    const code = await update.main(['check-update'], io);
    assert.equal(code, 10);
    assert.match(out.join(''), /Update available/);
  } finally {
    global.fetch = orig;
  }
});

test('main check-update: exit 0 when current', async () => {
  const { io, out } = capture();
  const orig = global.fetch;
  // Latest == this package's own installed version → never behind.
  global.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: update.installedVersion() } }) });
  try {
    const code = await update.main(['check-update'], io);
    assert.equal(code, 0);
    assert.match(out.join(''), /Up to date/);
  } finally {
    global.fetch = orig;
  }
});

test('main check-update: exit 1 when the registry check fails', async () => {
  const { io, err } = capture();
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const code = await update.main(['check-update'], io);
    assert.equal(code, 1);
    assert.match(err.join(''), /update check failed/);
  } finally {
    global.fetch = orig;
  }
});

// ── cli dispatch ────────────────────────────────────────────────────────────
test('cli resolveCommand routes update/check-update to update.js with the subcommand', () => {
  for (const cmd of ['update', 'check-update']) {
    const spec = cli.resolveCommand(cmd, ['--force']);
    assert.equal(spec.cmd, process.execPath);
    assert.match(spec.args[0], /bin[\\/]update\.js$/);
    assert.equal(spec.args[1], cmd, 'subcommand is forwarded as argv[0] to update.js');
    assert.equal(spec.args[2], '--force');
  }
});

test('cli usage lists the update commands', () => {
  let text = '';
  cli.usage({ write: (s) => { text += s; } });
  assert.match(text, /check-update/);
  assert.match(text, /update \[--force\]/);
});
