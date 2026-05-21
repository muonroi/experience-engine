#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildPrompt, parseLlmJson, validateAndNormalize } = require('./doc-to-experience');

const seedDoc = {
  principle: 'Use the LoggingHook<TContext> instead of raw logging calls.',
  trigger: 'When implementing logging for rule execution in the rule engine.',
  why: 'The LoggingHook auto-dispatches structured logs with context and decision data.',
  alternativesToAvoid: ['raw logging calls without structured context'],
  scope: { lang: 'C#', framework: 'rule-engine', org: 'muonroi' },
};

test('buildPrompt includes pattern fields and demands concrete failureMode', () => {
  const prompt = buildPrompt(seedDoc);
  assert.match(prompt, /LoggingHook<TContext>/);
  assert.match(prompt, /Lang\/Framework: C# \/ rule-engine/);
  assert.match(prompt, /NEVER "misapplied_pattern"/);
  assert.match(prompt, /missing_validation/);
});

test('parseLlmJson extracts JSON object even when surrounded by prose', () => {
  const wrapped = 'Sure, here is the result:\n```json\n{"trigger":"x","skip":false}\n```';
  const parsed = parseLlmJson(wrapped);
  assert.equal(parsed.trigger, 'x');
});

test('parseLlmJson passes through already-object inputs', () => {
  const obj = { trigger: 'x' };
  assert.equal(parseLlmJson(obj).trigger, 'x');
});

test('validateAndNormalize rejects generic failureMode', () => {
  const out = {
    trigger: 'rule engine logs without context',
    question: 'why is this bad',
    solution: 'wrap with LoggingHook',
    why: 'context loss in debug',
    failureMode: 'misapplied_pattern',
    judgment: 'always use LoggingHook',
  };
  const r = validateAndNormalize(out, seedDoc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'still_generic_failuremode');
});

test('validateAndNormalize accepts well-formed output and inherits scope', () => {
  const out = {
    trigger: 'rule engine logs are emitted without structured context',
    question: 'debug context lost in rule execution',
    solution: 'replace raw logger.LogInfo with LoggingHook.OnDecision',
    why: 'raw logger drops the per-decision context payload',
    failureMode: 'missing_observability',
    judgment: 'every rule must log via LoggingHook because raw calls drop context',
    conditions: ['rule-engine', 'logging', 'observability'],
    evidenceClass: 'review',
    category: 'code',
    scope: { lang: 'C#', framework: 'rule-engine' },
    alternativesToAvoid: ['logger.LogInfo(...) directly'],
  };
  const r = validateAndNormalize(out, seedDoc);
  assert.equal(r.ok, true);
  assert.equal(r.entry.failureMode, 'missing_observability');
  assert.equal(r.entry.scope.lang, 'C#');
  assert.equal(r.entry.scope.framework, 'rule-engine');
  assert.equal(r.entry.scope.org, 'muonroi');
});

test('validateAndNormalize honors LLM skip signal', () => {
  const out = { skip: true, reason: 'too_abstract' };
  const r = validateAndNormalize(out, seedDoc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_abstract');
});

test('validateAndNormalize rejects missing required fields', () => {
  const r = validateAndNormalize({ trigger: 'x' }, seedDoc);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^missing_/);
});
