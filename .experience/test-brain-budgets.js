#!/usr/bin/env node
'use strict';

/**
 * test-brain-budgets.js — the answer/time budgets the brain path spends per call.
 *
 * These four budgets used to be literals. They are properties of the MODEL, not of this
 * code: an instruct model answers a one-word classification in 1 token, while a reasoning
 * model spends its whole budget thinking first and then emits nothing. Measured 2026-09-17
 * against StepFun on the real EE prompts: step-3.5-flash needed 880 tokens (11.7s) to emit
 * "balanced" and returned '' at every smaller budget, and step-3.7-flash took 36-52s per
 * extract call at EXTRACT_CONCURRENCY=4 — the hardcoded 45s cut it off and the extraction
 * was lost with only a warn in the journal.
 *
 * Contract pinned here: every budget is config-driven, each call site keeps its previous
 * value as the default (so an unconfigured box is unchanged), and a junk value falls back
 * to that default instead of producing NaN.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const config = require('./src/config');

// Isolate from the operator's live ~/.experience/config.json, which pins these keys on a
// real box and would otherwise win over env (cfgValue order: config → env → default).
const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-brain-budgets-test.json');

async function withEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  config.refreshConfig();
  // awaited: a sync finally would restore the env before an async body ever ran, so the
  // assertions would measure the RESTORED config instead of the one under test.
  try { return await fn(); }
  finally {
    for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    config.refreshConfig();
  }
}

test('extract brain timeout: default preserved, configurable, junk ignored', async () => {
  const brain = require('./src/brain-llm');
  await withEnv({}, () => assert.equal(brain.getExtractBrainTimeoutMs(), 45000));
  await withEnv({ EXPERIENCE_BRAIN_EXTRACT_TIMEOUT_MS: '120000' }, () => assert.equal(brain.getExtractBrainTimeoutMs(), 120000));
  for (const junk of ['abc', '0', '-5', '']) {
    await withEnv({ EXPERIENCE_BRAIN_EXTRACT_TIMEOUT_MS: junk }, () => assert.equal(
      brain.getExtractBrainTimeoutMs(), 45000, `junk ${JSON.stringify(junk)} must fall back, never NaN`));
  }
});

test('relevance filter answer budget: per-branch default preserved, configurable, junk ignored', async () => {
  const brain = require('./src/brain-llm');
  // Two call sites with two historical literals — HTTP 120, Ollama 20 — and ONE knob. The
  // Ollama branch is the default provider, so a knob that skipped it would be ignored on a
  // stock box with no warning.
  await withEnv({}, () => {
    assert.equal(brain.getRelevanceMaxTokens(120), 120);
    assert.equal(brain.getRelevanceMaxTokens(20), 20);
  });
  await withEnv({ EXPERIENCE_BRAIN_RELEVANCE_MAX_TOKENS: '512' }, () => {
    assert.equal(brain.getRelevanceMaxTokens(120), 512, 'HTTP branch honours the knob');
    assert.equal(brain.getRelevanceMaxTokens(20), 512, 'Ollama branch honours the same knob');
  });
  await withEnv({ EXPERIENCE_BRAIN_RELEVANCE_MAX_TOKENS: 'nope' }, () => assert.equal(brain.getRelevanceMaxTokens(120), 120));
});

// A config FILE, because the shapes that broke these budgets are JSON-typed (true, [999],
// 45.5) and cannot be expressed through the environment at all.
async function withConfigFile(obj, fn) {
  const fs = require('node:fs');
  const file = path.join(os.tmpdir(), `ee-budget-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  const saved = process.env.EXPERIENCE_CONFIG_PATH;
  process.env.EXPERIENCE_CONFIG_PATH = file;
  config.refreshConfig();
  // awaited: a sync finally would restore the config path before an async body ran.
  try { return await fn(); }
  finally {
    if (saved === undefined) delete process.env.EXPERIENCE_CONFIG_PATH; else process.env.EXPERIENCE_CONFIG_PATH = saved;
    config.refreshConfig();
    try { fs.unlinkSync(file); } catch {}
  }
}

test('budgets that are not budgets fall back instead of breaking the call', async () => {
  const brain = require('./src/brain-llm');
  // Every value here passed a `Number.isFinite(n) && n > 0` check and broke a live path:
  // 45.5 and 99999999999 made AbortSignal.timeout THROW after /api/extract had already
  // ACKed the client, 2147483648 was silently clamped by Node to 1ms, true coerced to 1,
  // and 120 is a seconds/milliseconds mix-up that aborts every call.
  for (const bad of [45.5, 99999999999, 2147483648, true, false, [999], { ms: 60000 }, null, '45.5', '12e99', 120, 999]) {
    await withConfigFile({ brainExtractTimeoutMs: bad }, () => {
      const ms = brain.getExtractBrainTimeoutMs();
      assert.equal(ms, 45000, `brainExtractTimeoutMs=${JSON.stringify(bad)} must fall back`);
      assert.doesNotThrow(() => AbortSignal.timeout(ms), 'the budget must always be a legal timer value');
    });
  }
  // …and a sane value is honoured, truncated to an integer.
  await withConfigFile({ brainExtractTimeoutMs: 120000 }, () => assert.equal(brain.getExtractBrainTimeoutMs(), 120000));
  await withConfigFile({ brainExtractTimeoutMs: '90000.7' }, () => assert.equal(brain.getExtractBrainTimeoutMs(), 90000));
  await withConfigFile({ brainRelevanceMaxTokens: 512 }, () => assert.equal(brain.getRelevanceMaxTokens(120), 512));
  await withConfigFile({ brainRelevanceMaxTokens: '512.9' }, () => assert.equal(brain.getRelevanceMaxTokens(120), 512));
  // exported and callable with no argument: must still be a usable number, never undefined
  assert.equal(brain.getRelevanceMaxTokens(), 120);
});

test('extract budget reaches the actual request, and a caller still overrides it', async () => {
  const realFetch = global.fetch;
  const realTimeout = AbortSignal.timeout;
  const budgets = [];
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout.call(AbortSignal, ms); };
  global.fetch = async () => ({
    ok: true, status: 200,
    async json() { return { choices: [{ message: { content: '{"ok":true}' } }] }; },
    async text() { return ''; },
  });
  try {
    const brain = require('./src/brain-llm');
    const env = {
      EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
      EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
      EXPERIENCE_BRAIN_KEY: 'sk-hot',
      EXPERIENCE_BRAIN_MODEL: 'hot-model',
      EXPERIENCE_BRAIN_FALLBACK: '',
    };
    await withEnv({ ...env, EXPERIENCE_BRAIN_EXTRACT_TIMEOUT_MS: '120000' }, async () => {
      budgets.length = 0;
      await brain.callBrainWithFallback('p', { source: 'extract' });
      assert.equal(budgets[0], 120000, 'the configured extract budget must reach the request');
      budgets.length = 0;
      await brain.callBrainWithFallback('p', { source: 'evolve' });
      assert.equal(budgets[0], 120000, 'evolve shares the extract budget');
      budgets.length = 0;
      await brain.callBrainWithFallback('p', { source: 'general' });
      assert.equal(budgets[0], 30000, 'the hot path keeps the provider client default, not the extract budget');
      budgets.length = 0;
      await brain.callBrainWithFallback('p', { source: 'extract', timeoutMs: 2500 });
      assert.equal(budgets[0], 2500, 'a caller-supplied budget still wins');
    });
  } finally {
    global.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('classifier answer budget: default 10 preserved, configurable, and it reaches the body', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content: 'fast' } }] }; },
      async text() { return ''; },
    };
  };
  try {
    const { classifyViaBrain } = require('./src/router');
    const env = {
      EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
      EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
      EXPERIENCE_BRAIN_KEY: 'sk-hot',
      EXPERIENCE_BRAIN_MODEL: 'hot-model',
    };
    const bodyOf = (i) => JSON.parse(calls[i].init.body);

    await withEnv(env, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.equal(bodyOf(0).max_tokens, 10, 'unconfigured boxes keep the historical 10');
    });

    await withEnv({ ...env, EXPERIENCE_BRAIN_CLASSIFY_MAX_TOKENS: '1024' }, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.equal(bodyOf(0).max_tokens, 1024, 'the configured budget must reach the request body');
      calls.length = 0;
      await classifyViaBrain('p', 5000, { maxTokens: 7 });
      assert.equal(bodyOf(0).max_tokens, 7, 'an explicit caller value still wins over config');
    });

    await withEnv({ ...env, EXPERIENCE_BRAIN_CLASSIFY_MAX_TOKENS: 'junk' }, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.equal(bodyOf(0).max_tokens, 10, 'junk must fall back to the default, never NaN');
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('the classify budgets reject junk at the request body and the timer', async () => {
  // Pinned separately from the getters: a weak guard on these two keys used to survive the
  // whole suite green, because the junk test asserted a DIFFERENT key's getter.
  const realFetch = global.fetch;
  const realTimeout = AbortSignal.timeout;
  const calls = [];
  const budgets = [];
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout.call(AbortSignal, ms); };
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'fast' } }] }; }, async text() { return ''; } };
  };
  try {
    const { classifyViaBrain } = require('./src/router');
    const base = {
      brainProvider: 'siliconflow',
      brainEndpoint: 'https://hot.invalid/v1/chat/completions',
      brainKey: 'sk-hot',
      brainModel: 'hot-model',
    };
    // Out of band or not a number at all -> the call site's own default.
    // The two budgets carry DIFFERENT bands on purpose: 32769 is beyond any answer length
    // but an ordinary 32.7s timeout, and 45 is a fine token count but no provider answers
    // in 45 ms. So each list is the junk for ITS budget.
    for (const bad of [99999999999, 2147483648, true, [999], { n: 1 }, null, 'abc', 0, -1, 32769]) {
      await withConfigFile({ ...base, brainClassifyMaxTokens: bad }, async () => {
        calls.length = 0;
        await classifyViaBrain('p', 5000, {});
        assert.equal(JSON.parse(calls[0].init.body).max_tokens, 10,
          `brainClassifyMaxTokens=${JSON.stringify(bad)} must fall back to 10`);
      });
    }
    for (const bad of [99999999999, 2147483648, true, [999], { n: 1 }, null, 'abc', 0, -1, 999, 600001]) {
      await withConfigFile({ ...base, brainClassifyTimeoutMs: bad }, async () => {
        budgets.length = 0;
        await classifyViaBrain('p', undefined, {});
        assert.equal(budgets[0], 10000, `brainClassifyTimeoutMs=${JSON.stringify(bad)} must fall back to 10000`);
        assert.doesNotThrow(() => AbortSignal.timeout(budgets[0]), 'the timer value must be legal');
      });
    }
    // A fractional value INSIDE the band is a budget, not junk: it is truncated to an
    // integer the provider accepts, never forwarded as 12.7 for the provider to 400 on.
    for (const [raw, want] of [[45.5, 45], ['12.7', 12], ['1e3', 1000], [' 64 ', 64]]) {
      await withConfigFile({ ...base, brainClassifyMaxTokens: raw }, async () => {
        calls.length = 0;
        await classifyViaBrain('p', 5000, {});
        const mt = JSON.parse(calls[0].init.body).max_tokens;
        assert.equal(mt, want, `brainClassifyMaxTokens=${JSON.stringify(raw)}`);
        assert.ok(Number.isInteger(mt), 'max_tokens must always be an integer');
      });
    }
    // The same fractional value is junk for a TIMEOUT, because 45 ms is below any floor a
    // provider can answer within — that asymmetry is the point of per-budget bands.
    await withConfigFile({ ...base, brainClassifyTimeoutMs: 45.5 }, async () => {
      budgets.length = 0;
      await classifyViaBrain('p', undefined, {});
      assert.equal(budgets[0], 10000);
    });
    // …and sane values are honoured, truncated.
    await withConfigFile({ ...base, brainClassifyMaxTokens: '1024.9' }, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.equal(JSON.parse(calls[0].init.body).max_tokens, 1024);
    });
    await withConfigFile({ ...base, brainClassifyTimeoutMs: 20000 }, async () => {
      budgets.length = 0;
      await classifyViaBrain('p', undefined, {});
      assert.equal(budgets[0], 20000);
    });
  } finally { global.fetch = realFetch; AbortSignal.timeout = realTimeout; }
});

test('the Ollama classify branch honours the same knob and keeps its own default', async () => {
  // The default brainProvider is ollama, so this branch is the one a stock box runs — a
  // knob wired only into the HTTP branch would be silently ignored where it matters most.
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return { response: 'fast' }; }, async text() { return ''; } };
  };
  try {
    const { classifyViaBrain } = require('./src/router');
    const env = { EXPERIENCE_BRAIN_PROVIDER: 'ollama', EXPERIENCE_BRAIN_MODEL: 'qwen2.5:3b' };
    await withEnv(env, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.match(calls[0].url, /11434/, 'ollama branch');
      assert.equal(JSON.parse(calls[0].init.body).options.num_predict, 5, 'historical Ollama default');
    });
    await withEnv({ ...env, EXPERIENCE_BRAIN_CLASSIFY_MAX_TOKENS: '1024' }, async () => {
      calls.length = 0;
      await classifyViaBrain('p', 5000, {});
      assert.equal(JSON.parse(calls[0].init.body).options.num_predict, 1024, 'knob reaches the Ollama body');
    });
  } finally { global.fetch = realFetch; }
});

test('the relevance filter answer budget reaches the request body on both branches', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true, status: 200,
      async json() { return { response: '1', choices: [{ message: { content: '1' } }] }; },
      async text() { return ''; },
    };
  };
  try {
    const brain = require('./src/brain-llm');
    const lines = ['💡 [Suggestion (0.6)]: always read the config before editing it'];
    await withEnv({
      EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
      EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
      EXPERIENCE_BRAIN_KEY: 'sk-hot',
      EXPERIENCE_BRAIN_MODEL: 'hot-model',
      EXPERIENCE_BRAIN_RELEVANCE_MAX_TOKENS: '777',
    }, async () => {
      calls.length = 0;
      await brain.brainRelevanceFilter('edit config.json', lines, undefined, null);
      assert.equal(JSON.parse(calls[0].init.body).max_tokens, 777, 'HTTP relevance body');
    });
    await withEnv({
      EXPERIENCE_BRAIN_PROVIDER: 'ollama',
      EXPERIENCE_BRAIN_MODEL: 'qwen2.5:3b',
      EXPERIENCE_BRAIN_RELEVANCE_MAX_TOKENS: '777',
    }, async () => {
      calls.length = 0;
      await brain.brainRelevanceFilter('edit config.json', lines, undefined, null);
      assert.equal(JSON.parse(calls[0].init.body).options.num_predict, 777, 'Ollama relevance body');
    });
  } finally { global.fetch = realFetch; }
});

test('classify TIME budget: caller value wins, default is configurable', async () => {
  // Tokens alone do not make a reasoning model usable — the same measured call needed
  // 11.7s against a 10s hardcoded default.
  const realFetch = global.fetch;
  const realTimeout = AbortSignal.timeout;
  const budgets = [];
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout.call(AbortSignal, ms); };
  global.fetch = async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: 'fast' } }] }; }, async text() { return ''; } });
  try {
    const { classifyViaBrain } = require('./src/router');
    const env = {
      EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
      EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
      EXPERIENCE_BRAIN_KEY: 'sk-hot',
      EXPERIENCE_BRAIN_MODEL: 'hot-model',
    };
    await withEnv(env, async () => {
      budgets.length = 0;
      await classifyViaBrain('p');
      assert.equal(budgets[0], 10000, 'historical default preserved');
      budgets.length = 0;
      await classifyViaBrain('p', 3500, {});
      assert.equal(budgets[0], 3500, 'a caller budget is not overridden');
    });
    await withEnv({ ...env, EXPERIENCE_BRAIN_CLASSIFY_TIMEOUT_MS: '20000' }, async () => {
      budgets.length = 0;
      await classifyViaBrain('p');
      assert.equal(budgets[0], 20000, 'the configured default applies when the caller passes none');
      budgets.length = 0;
      await classifyViaBrain('p', 3500, {});
      assert.equal(budgets[0], 3500, 'an explicit caller budget still wins over config');
    });
  } finally { global.fetch = realFetch; AbortSignal.timeout = realTimeout; }
});
