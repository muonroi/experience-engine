#!/usr/bin/env node
'use strict';

/**
 * risk-triggers.test.js — deterministic risk detection (.experience/src/risk-triggers.js).
 * Pure: cross-repo uses an injected repoRootOf so no filesystem is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../.experience/src/risk-triggers.js');

test('sensitive-keyword: matches in prompt text (en)', () => {
  const trig = rt.detectRiskTriggers({ promptText: 'please set up oauth token refresh' });
  assert.ok(trig.length > 0);
  assert.ok(trig.every((t) => t.kind === 'sensitive-keyword'));
  assert.ok(trig.some((t) => t.topic === 'oauth' || t.topic === 'token' || t.topic === 'auth'));
});

test('sensitive-keyword: matches in tool command, not just prompt', () => {
  const trig = rt.detectRiskTriggers({ toolName: 'Bash', toolInput: { command: 'npm run deploy' } });
  assert.ok(trig.some((t) => t.kind === 'sensitive-keyword' && t.topic === 'deploy'));
});

test('sensitive-keyword: Vietnamese prompt about migration', () => {
  const trig = rt.detectRiskTriggers({ promptText: 'chạy migration cho database production' });
  const topics = trig.map((t) => t.topic);
  assert.ok(topics.includes('migration'));
  assert.ok(topics.includes('production'));
});

test('no trigger on a benign prompt → empty', () => {
  assert.deepEqual(rt.detectRiskTriggers({ promptText: 'rename a local variable foo to bar' }), []);
});

test('config-driven keyword list overrides default', () => {
  const trig = rt.detectRiskTriggers({ promptText: 'this mentions foobar somewhere', keywords: ['foobar'] });
  assert.equal(trig.length, 1);
  assert.equal(trig[0].topic, 'foobar');
  // default keywords would NOT have flagged this prompt
  assert.deepEqual(rt.detectRiskTriggers({ promptText: 'this mentions foobar somewhere' }), []);
});

test('cross-repo: file path under a different repo root than cwd', () => {
  const repoRootOf = (p) => (p.includes('repoX') ? '/a/repoX' : p.includes('repoY') ? '/a/repoY' : null);
  const trig = rt.detectRiskTriggers({
    toolName: 'Edit',
    toolInput: { file_path: '/a/repoX/src/file.ts' },
    cwd: '/a/repoY',
    repoRootOf,
  });
  const xrepo = trig.find((t) => t.kind === 'cross-repo');
  assert.ok(xrepo, 'cross-repo trigger present');
  assert.equal(xrepo.topic, 'repoX');
});

test('cross-repo: same repo root → no cross-repo trigger', () => {
  const repoRootOf = () => '/a/repoY';
  const trig = rt.detectRiskTriggers({
    toolName: 'Edit',
    toolInput: { file_path: '/a/repoY/src/file.ts' },
    cwd: '/a/repoY',
    repoRootOf,
  });
  assert.equal(trig.find((t) => t.kind === 'cross-repo'), undefined);
});

test('caps at MAX_TRIGGERS', () => {
  const trig = rt.detectRiskTriggers({ promptText: 'auth oauth token secret migration deploy cors prod' });
  assert.ok(trig.length <= rt.MAX_TRIGGERS);
});

test('matchKeywords: dedups and is case-insensitive', () => {
  assert.deepEqual(rt.matchKeywords('Deploy the DEPLOY now', ['deploy']), ['deploy']);
  assert.deepEqual(rt.matchKeywords('', ['deploy']), []);
});
