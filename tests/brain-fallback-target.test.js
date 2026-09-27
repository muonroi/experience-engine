#!/usr/bin/env node
'use strict';

/**
 * brain-fallback-target.test.js — the fallback brain is a whole target, not a provider name.
 *
 * The old fallback carried only `brainFallback` (a provider id), so the client re-read the
 * hot endpoint, key and model and re-sent the same request to the same vendor. Against a
 * provider-side concurrency cap (StepFun: 5, answered with 429) that retry cannot succeed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const cfg = require('../.experience/src/config.js');
const router = require('../.experience/src/router.js');

const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-brain-fallback-test.json');
const STEPFUN = 'https://api.stepfun.ai/v1/chat/completions';
const SILICON = 'https://api.siliconflow.com/v1/chat/completions';
const FALLBACK_VARS = ['EXPERIENCE_BRAIN_FALLBACK', 'EXPERIENCE_BRAIN_FALLBACK_ENDPOINT', 'EXPERIENCE_BRAIN_FALLBACK_KEY', 'EXPERIENCE_BRAIN_FALLBACK_MODEL'];

async function withEnv(vars, fn) {
  const merged = {
    EXPERIENCE_CONFIG_PATH: NO_CONFIG,
    EXPERIENCE_BRAIN_PROVIDER: 'custom',
    EXPERIENCE_BRAIN_ENDPOINT: STEPFUN,
    EXPERIENCE_BRAIN_KEY: 'sk-stepfun',
    EXPERIENCE_BRAIN_MODEL: 'step-5-preview',
    ...vars,
  };
  const keys = [...new Set([...Object.keys(merged), ...FALLBACK_VARS])];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of FALLBACK_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(merged)) process.env[k] = v;
  try { return await fn(); }
  finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), auth: init.headers.Authorization, model: body.model });
    return handler(String(url));
  };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}

const ok = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const limited = () => ({ ok: false, status: 429, text: async () => 'request limited concurrency reached' });

test('fallback target carries its own endpoint, key and model', () => withEnv({
  EXPERIENCE_BRAIN_FALLBACK: 'siliconflow',
  EXPERIENCE_BRAIN_FALLBACK_ENDPOINT: SILICON,
  EXPERIENCE_BRAIN_FALLBACK_KEY: 'sk-silicon',
  EXPERIENCE_BRAIN_FALLBACK_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
}, () => {
  assert.deepEqual(cfg.resolveBrainFallbackTarget(), {
    provider: 'siliconflow', endpoint: SILICON, key: 'sk-silicon', model: 'Qwen/Qwen2.5-7B-Instruct', keySuppressed: false,
  });
}));

test('a fallback on another origin never borrows the hot key', () => withEnv({
  EXPERIENCE_BRAIN_FALLBACK: 'siliconflow',
  EXPERIENCE_BRAIN_FALLBACK_ENDPOINT: SILICON,
}, () => {
  const t = cfg.resolveBrainFallbackTarget();
  assert.equal(t.key, '');
  assert.equal(t.keySuppressed, true);
}));

test('an explicitly empty brainFallback means no fallback', () => withEnv({ EXPERIENCE_BRAIN_FALLBACK: '' }, () => {
  assert.equal(cfg.resolveBrainFallbackTarget(), null);
}));

test('classify retries a 429 on the fallback target with its own credentials', () => withEnv({
  EXPERIENCE_BRAIN_FALLBACK: 'siliconflow',
  EXPERIENCE_BRAIN_FALLBACK_ENDPOINT: SILICON,
  EXPERIENCE_BRAIN_FALLBACK_KEY: 'sk-silicon',
  EXPERIENCE_BRAIN_FALLBACK_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
}, () => withFetch((url) => (url === STEPFUN ? limited() : ok('balanced')), async (calls) => {
  const result = await router.classifyViaBrain('refactor two files', 5000);
  assert.equal(result, 'balanced');
  assert.deepEqual(calls, [
    { url: STEPFUN, auth: 'Bearer sk-stepfun', model: 'step-5-preview' },
    { url: SILICON, auth: 'Bearer sk-silicon', model: 'Qwen/Qwen2.5-7B-Instruct' },
  ]);
})));

test('classify does not swap the model of a caller that pinned its own target', () => withEnv({
  EXPERIENCE_BRAIN_FALLBACK: 'siliconflow',
  EXPERIENCE_BRAIN_FALLBACK_ENDPOINT: SILICON,
  EXPERIENCE_BRAIN_FALLBACK_KEY: 'sk-silicon',
}, () => withFetch(() => limited(), async (calls) => {
  const result = await router.classifyViaBrain('judge this', 5000, { model: 'step-5-preview' });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
})));
