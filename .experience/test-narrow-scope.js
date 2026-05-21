#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildPrompt, parseLlmJson, validateVerdict, applyVerdict } = require('./narrow-scope');

const sample = {
  trigger: 'agent runs grep in a loop without checking previous results',
  solution: 'check exit code from previous grep before retrying',
  failureMode: 'redundant_tool_calls',
  why: 'agent lacks state tracking between tool calls',
};

test('buildPrompt includes entry fields and verdict options', () => {
  const p = buildPrompt(sample);
  assert.match(p, /trigger: agent runs grep/);
  assert.match(p, /keep_universal/);
  assert.match(p, /narrow_lang/);
  assert.match(p, /narrow_tool/);
  assert.match(p, /demote/);
});

test('parseLlmJson extracts JSON from a prose-wrapped response', () => {
  const wrapped = 'Here: ```json\n{"verdict":"demote","reason":"too vague"}\n```';
  assert.equal(parseLlmJson(wrapped).verdict, 'demote');
});

test('validateVerdict rejects unknown verdict', () => {
  const r = validateVerdict({ verdict: 'nuke_it', reason: 'why' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_verdict');
});

test('validateVerdict rejects narrow_lang without a valid lang', () => {
  assert.equal(validateVerdict({ verdict: 'narrow_lang', lang: 'cobol' }).ok, false);
  assert.equal(validateVerdict({ verdict: 'narrow_lang', lang: 'TypeScript' }).ok, true);
});

test('validateVerdict rejects narrow_framework with framework=any', () => {
  assert.equal(validateVerdict({ verdict: 'narrow_framework', framework: 'any' }).ok, false);
  assert.equal(validateVerdict({ verdict: 'narrow_framework', framework: 'react' }).ok, true);
});

test('validateVerdict rejects narrow_tool without appliesToTools', () => {
  assert.equal(validateVerdict({ verdict: 'narrow_tool' }).ok, false);
  assert.equal(validateVerdict({ verdict: 'narrow_tool', appliesToTools: '^Bash$' }).ok, true);
});

test('applyVerdict on narrow_tool sets scope.appliesToTools', () => {
  const entry = { data: { scope: { lang: 'all', framework: 'any' }, confidence: 0.7 } };
  const out = applyVerdict(entry, { verdict: 'narrow_tool', appliesToTools: '^(Bash|Edit)$', reason: 'r' });
  assert.equal(out.scope.appliesToTools, '^(Bash|Edit)$');
  assert.equal(out.scope.lang, 'all'); // unchanged
});

test('applyVerdict on demote drops confidence and tier', () => {
  const entry = { data: { confidence: 0.7, tier: 0, scope: {} } };
  const out = applyVerdict(entry, { verdict: 'demote', reason: 'too vague' });
  assert.ok(out.confidence < 0.4);
  assert.equal(out.tier, 2);
  assert.equal(out.demoteReason, 'too vague');
});

test('applyVerdict on keep_universal marks reviewed without changing scope', () => {
  const entry = { data: { scope: { lang: 'all', framework: 'any' } } };
  const out = applyVerdict(entry, { verdict: 'keep_universal', reason: 'truly cross-stack' });
  assert.equal(out.scope.universalReviewed, true);
  assert.equal(out.scope.lang, 'all');
});
