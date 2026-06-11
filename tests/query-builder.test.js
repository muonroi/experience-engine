#!/usr/bin/env node
'use strict';

/**
 * query-builder.test.js — buildSemanticQuery / buildQuery intent extraction.
 *
 * Regression for the recall-blackhole bug (2026-06-11): prompt hooks
 * (UserPromptSubmit passive hints AND /api/recall active recall) pass the
 * user's natural-language query in `toolInput.command` with `_promptHook:true`.
 * The non-Bash branch only read new_string/content/old_string, so `command`
 * was discarded and EVERY prompt collapsed to the constant
 * "[tool:UserPrompt] using UserPrompt" — embedding noise instead of the query.
 * Evidence: ~/.experience/activity.jsonl op:intercept tool:UserPrompt rows all
 * logged query="[tool:UserPrompt] using UserPrompt" with surfaced generic
 * principles at ~0.63 cosine, never the queried-for content.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSemanticQuery } = require('../.experience/src/query-builder.js');
const { buildQuery } = require('../.experience/src/utils.js');

const PLACEHOLDER = '[tool:UserPrompt] using UserPrompt';

test('buildSemanticQuery: prompt-hook command is embedded as raw NL query', () => {
  const q = buildSemanticQuery('UserPrompt', {
    command: 'storyflow chapter list pagination rate limit lazy loading best practice',
    _promptHook: true,
  });
  assert.notEqual(q, PLACEHOLDER, 'must not collapse to the placeholder');
  assert.match(q, /storyflow/);
  assert.match(q, /pagination/);
  assert.match(q, /lazy loading/);
});

test('buildQuery (full path): prompt-hook command reaches the embedded query', () => {
  const q = buildQuery('UserPrompt', {
    command: 'Angular component infinite scroll IntersectionObserver',
    _promptHook: true,
  });
  assert.notEqual(q, PLACEHOLDER);
  assert.match(q, /IntersectionObserver/);
  assert.match(q, /infinite scroll/);
});

test('buildSemanticQuery: prompt query is trimmed/collapsed and length-capped', () => {
  const long = 'word '.repeat(300).trim();
  const q = buildSemanticQuery('UserPrompt', { command: '  multi   space\n\nquery  ', _promptHook: true });
  assert.equal(q, 'multi space query');
  const capped = buildSemanticQuery('UserPrompt', { command: long, _promptHook: true });
  assert.ok(capped.length <= 500, `expected <=500 chars, got ${capped.length}`);
});

test('buildSemanticQuery: empty prompt command falls through, never throws', () => {
  const q = buildSemanticQuery('UserPrompt', { command: '   ', _promptHook: true });
  // Falls through to the intent path → placeholder is acceptable here (no query
  // text to embed); the contract is only "do not crash, do not invent content".
  assert.equal(typeof q, 'string');
  assert.equal(q, PLACEHOLDER);
});

// --- controls: non-prompt tools keep the intent-extraction behavior unchanged ---

test('control: Bash command still produces a [tool:Bash] intent query', () => {
  const q = buildSemanticQuery('Bash', { command: 'git rebase -i main && npm test' });
  assert.ok(q.startsWith('[tool:Bash]'), q);
  assert.ok(!/_promptHook/.test(q));
});

test('control: Edit code is NOT treated as a prompt (no _promptHook)', () => {
  const q = buildSemanticQuery('Edit', {
    file_path: 'src/foo.ts',
    new_string: 'export function handleAuthToken() { return 1; }',
  });
  assert.ok(q.startsWith('[tool:Edit]'), q);
});

test('control: a non-prompt tool carrying a command field is unaffected', () => {
  // Without _promptHook, command must go through the normal (non-Bash) branch,
  // which ignores `command` — i.e. we did not widen the bug to all tools.
  const q = buildSemanticQuery('Read', { command: 'should be ignored', file_path: 'x.md' });
  assert.ok(!/should be ignored/.test(q));
});
