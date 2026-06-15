#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../bin/sync');

test('parseArgs defaults match upgrade.sh (max 30, max-age 365d)', () => {
  const o = sync.parseArgs([]);
  assert.equal(o.max, 30);
  assert.equal(o.maxAge, '365d');
  assert.equal(o.sessionsOnly, false);
  assert.equal(o.memoryOnly, false);
  assert.equal(o.dryRun, false);
});

test('parseArgs reads all flags', () => {
  const o = sync.parseArgs([
    '--max', '50', '--max-age', '90d', '--runtime', 'claude,codex',
    '--project', 'acme', '--include-reference', '--reset-marker',
    '--upgrade', '--dry-run', '-v',
  ]);
  assert.equal(o.max, 50);
  assert.equal(o.maxAge, '90d');
  assert.equal(o.runtime, 'claude,codex');
  assert.equal(o.project, 'acme');
  assert.equal(o.includeReference, true);
  assert.equal(o.resetMarker, true);
  assert.equal(o.upgrade, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.verbose, true);
});

test('parseArgs rejects sessions-only + memory-only together', () => {
  assert.throws(() => sync.parseArgs(['--sessions-only', '--memory-only']), /mutually exclusive/);
});

test('parseArgs rejects bad --max and unknown flags', () => {
  assert.throws(() => sync.parseArgs(['--max', '0']), /positive integer/);
  assert.throws(() => sync.parseArgs(['--nope']), /Unknown option/);
});

test('buildBulkArgs maps to bulk-extract.js tokens', () => {
  const a = sync.buildBulkArgs(sync.parseArgs([
    '--max', '12', '--max-age', '30d', '--runtime', 'gemini',
    '--project', 'x', '--reset-marker', '--dry-run', '-v',
  ]));
  assert.deepEqual(a, [
    '--max', '12', '--max-age', '30d', '--runtime', 'gemini',
    '--project', 'x', '--reset-marker', '--dry-run', '-v',
  ]);
});

test('buildMemoryArgs maps to import-memory.js tokens (no --max/--max-age)', () => {
  const a = sync.buildMemoryArgs(sync.parseArgs([
    '--max', '99', '--runtime', 'codex', '--project', 'y',
    '--include-reference', '--reset-marker', '--dry-run', '-v',
  ]));
  assert.deepEqual(a, [
    '--runtime', 'codex', '--project', 'y',
    '--include-reference', '--reset-marker', '--dry-run', '-v',
  ]);
  assert.ok(!a.includes('--max'), 'import-memory takes no --max');
  assert.ok(!a.includes('--max-age'), 'import-memory takes no --max-age');
});

test('resolveToolPath prefers installed copy over packaged', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-sync-rt-'));
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-sync-pkg-'));
  fs.mkdirSync(path.join(installDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, '.experience', 'tools'), { recursive: true });

  // Only packaged exists → packaged.
  fs.writeFileSync(path.join(pkgRoot, '.experience', 'tools', 'bulk-extract.js'), '//x');
  assert.equal(
    sync.resolveToolPath('bulk-extract.js', installDir, pkgRoot),
    path.join(pkgRoot, '.experience', 'tools', 'bulk-extract.js')
  );

  // Installed exists too → installed wins.
  fs.writeFileSync(path.join(installDir, 'tools', 'bulk-extract.js'), '//y');
  assert.equal(
    sync.resolveToolPath('bulk-extract.js', installDir, pkgRoot),
    path.join(installDir, 'tools', 'bulk-extract.js')
  );

  // Neither → ''.
  assert.equal(sync.resolveToolPath('missing.js', installDir, pkgRoot), '');
});

test('run errors out when no config.json present', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-sync-noconfig-'));
  const realHome = os.homedir;
  os.homedir = () => home; // no ~/.experience/config.json under temp home
  try {
    let stderr = '';
    const code = await sync.run([], {
      stdout: { write() {} },
      stderr: { write(c) { stderr += c; } },
    });
    assert.equal(code, 1);
    assert.match(stderr, /No ~\/\.experience\/config\.json/);
  } finally {
    os.homedir = realHome;
  }
});

test('run --help prints usage and exits 0', async () => {
  let out = '';
  const code = await sync.run(['--help'], {
    stdout: { write(c) { out += c; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.match(out, /Experience Engine — sync/);
  assert.match(out, /--sessions-only/);
});
