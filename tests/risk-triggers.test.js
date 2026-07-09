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

test('word-boundary: "auth" does NOT fire on the Co-Authored-By commit trailer', () => {
  // The regression that made the gate false-fire on every git commit.
  const msg = 'git commit -m "fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
  assert.deepEqual(rt.matchKeywords(msg, ['auth']), []);
  assert.deepEqual(rt.detectRiskTriggers({ toolInput: { command: msg } }), []);
});

test('word-boundary: "auth" fires as a whole word but not as a substring', () => {
  assert.deepEqual(rt.matchKeywords('please wire up auth for the api', ['auth']), ['auth']);
  assert.deepEqual(rt.matchKeywords('the authored authentication authorize handler', ['auth']), []);
});

test('word-boundary: short alpha keywords no longer over-match', () => {
  // 'prod' ⊄ "reproduce"/"product"; 'cors' ⊄ "scores"; 'token' ⊄ "tokenizer".
  assert.deepEqual(rt.matchKeywords('reproduce the product scores with the tokenizer', ['prod', 'cors', 'token']), []);
  // …but the standalone words still fire.
  assert.deepEqual(rt.matchKeywords('deploy to prod now', ['prod']), ['prod']);
});

test('symbol / multi-word keywords keep substring matching', () => {
  assert.deepEqual(rt.matchKeywords('run rm -rf /tmp/x', ['rm -rf']), ['rm -rf']);
  assert.deepEqual(rt.matchKeywords('please rate-limit the endpoint', ['rate-limit']), ['rate-limit']);
  assert.ok(rt.matchKeywords('git reset --hard HEAD~1', ['reset --hard']).includes('reset --hard'));
});
