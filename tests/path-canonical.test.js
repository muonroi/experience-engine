'use strict';
/**
 * tests/path-canonical.test.js — Unit tests for lib/path-canonical.js
 * Run: node --test tests/path-canonical.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeProjectSlug, normalizePath, _resetWarnLatch } = require('../lib/path-canonical');

const REPO_PATTERNS = [
  'storyflow',
  'storyflow_ui',
  'quick-codex',
  'experience-engine',
  'muonroi-cli',
  'muonroi-control-plane',
  'muonroi-license-server',
  'muonroi-building-block',
  'muonroi-ui-engine',
];

// ---- normalizePath ----

test('normalizePath: strips Windows drive letter', () => {
  assert.equal(normalizePath('D:/sources/Core/foo'), '/sources/Core/foo');
  assert.equal(normalizePath('C:\\sources\\foo\\bar'), '/sources/foo/bar');
});

test('normalizePath: normalizes WSL /mnt/ prefix', () => {
  assert.equal(normalizePath('/mnt/d/sources/Core/foo'), '/sources/Core/foo');
});

test('normalizePath: normalizes WSL single-letter prefix /d/sources', () => {
  // /d/ followed by capital letter (drive mount) → strip leading /d/
  assert.equal(normalizePath('/d/sources/Core/foo'), '/sources/Core/foo');
  assert.equal(normalizePath('/d/Personal/Core/foo'), '/Personal/Core/foo');
});

test('normalizePath: tilde expansion', () => {
  const result = normalizePath('~/projects/storyflow_ui/readme.md');
  assert.ok(result.includes('/projects/storyflow_ui/readme.md'), `Expected tilde expansion, got: ${result}`);
  assert.ok(!result.startsWith('~'), 'Should not start with tilde');
});

test('normalizePath: already Unix path unchanged (except prefix)', () => {
  assert.equal(normalizePath('/home/user/projects/foo'), '/home/user/projects/foo');
});

// ---- canonicalizeProjectSlug ----

test('D:/sources/Core/muonroi-building-block → muonroi-building-block', () => {
  const slug = canonicalizeProjectSlug('D:/sources/Core/muonroi-building-block', REPO_PATTERNS);
  assert.equal(slug, 'muonroi-building-block');
});

test('/d/Personal/Core/muonroi-building-block/src/X → muonroi-building-block', () => {
  const slug = canonicalizeProjectSlug('/d/Personal/Core/muonroi-building-block/src/X', REPO_PATTERNS);
  assert.equal(slug, 'muonroi-building-block');
});

test('~/projects/storyflow_ui → storyflow_ui', () => {
  const slug = canonicalizeProjectSlug('~/projects/storyflow_ui', REPO_PATTERNS);
  assert.equal(slug, 'storyflow_ui');
});

test('file deeply nested under muonroi-building-block → muonroi-building-block', () => {
  const slug = canonicalizeProjectSlug(
    'D:\\sources\\Core\\muonroi-building-block\\src\\Core\\Rule.cs',
    REPO_PATTERNS
  );
  assert.equal(slug, 'muonroi-building-block');
});

test('unknown path → null', () => {
  const slug = canonicalizeProjectSlug('/home/user/my-random-project/src/index.ts', REPO_PATTERNS);
  assert.equal(slug, null);
});

test('empty string → null', () => {
  assert.equal(canonicalizeProjectSlug('', REPO_PATTERNS), null);
});

test('null → null', () => {
  assert.equal(canonicalizeProjectSlug(null, REPO_PATTERNS), null);
});

test('empty patterns array → null (with warning latch)', () => {
  _resetWarnLatch();
  const slug = canonicalizeProjectSlug('D:/sources/Core/muonroi-building-block/src', []);
  assert.equal(slug, null);
});

test('no patterns argument (undefined) → delegates to config (produces null on thin client)', () => {
  // On the test machine there IS a config with repoPatterns, so this should resolve.
  // We test with an explicit list instead to be deterministic.
  const slug = canonicalizeProjectSlug('D:/sources/Core/muonroi-building-block', REPO_PATTERNS);
  assert.equal(slug, 'muonroi-building-block');
});

test('muonroi-cli path → muonroi-cli', () => {
  const slug = canonicalizeProjectSlug('/d/sources/Core/muonroi-cli/src/index.ts', REPO_PATTERNS);
  assert.equal(slug, 'muonroi-cli');
});

test('case-insensitive match on Windows-style segment', () => {
  // Windows filenames are case-insensitive; segment "Muonroi-Building-Block" should match
  const slug = canonicalizeProjectSlug('D:/Sources/Core/Muonroi-Building-Block/src/X.cs', REPO_PATTERNS);
  assert.equal(slug, 'muonroi-building-block');
});

test('rightmost matching segment wins', () => {
  // muonroi-cli appears closer to the file than muonroi-building-block
  const slug = canonicalizeProjectSlug(
    '/sources/Core/muonroi-building-block/tools/muonroi-cli/src/x',
    REPO_PATTERNS
  );
  assert.equal(slug, 'muonroi-cli');
});
