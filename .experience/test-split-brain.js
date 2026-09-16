#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We test the source-aware model picker. We can't easily isolate the real
// config.json loaded from $HOME, so we set EXPERIENCE_BRAIN_MODEL +
// EXPERIENCE_BRAIN_EXTRACT_MODEL env vars and assert that getBrainModel /
// getBrainExtractModel return them when there's no override key in config.
//
// cfgValue(key, envKey, fallback) order: config[key] → process.env[envKey] → fallback.
// On a dev machine with config.json present that already sets brainModel, the
// config value wins. So we only assert source-routing semantics: with both env
// vars set, extract+evolve must point to the extract model (or to brainModel
// if config overrides — either way they MUST differ from getBrainModel only
// when brainExtractModel is independently set).

const config = require('./src/config');

test('getBrainModelForSource: extract + evolve route through getBrainExtractModel', () => {
  // Set extract override via env; main brain stays whatever the loaded config says
  process.env.EXPERIENCE_BRAIN_EXTRACT_MODEL = 'split-brain-test-extract-model';
  config.refreshConfig();

  const fromConfig = require('./src/config');
  const extractModel = fromConfig.getBrainExtractModel();

  // The extract model must be the env override unless config.json has its own
  // brainExtractModel (which we assume the test harness does not).
  if (!fromConfig.getConfig().brainExtractModel) {
    assert.equal(extractModel, 'split-brain-test-extract-model');
    assert.equal(fromConfig.getBrainModelForSource('extract'), 'split-brain-test-extract-model');
    assert.equal(fromConfig.getBrainModelForSource('evolve'), 'split-brain-test-extract-model');
  }

  // Hot-path sources MUST NOT route through extract model
  assert.notEqual(fromConfig.getBrainModelForSource('general'), 'split-brain-test-extract-model');
  assert.notEqual(fromConfig.getBrainModelForSource('brain-filter'), 'split-brain-test-extract-model');
  assert.notEqual(fromConfig.getBrainModelForSource('route'), 'split-brain-test-extract-model');

  delete process.env.EXPERIENCE_BRAIN_EXTRACT_MODEL;
});

test('getBrainModelForSource: falls back to brainModel when brainExtractModel unset', () => {
  delete process.env.EXPERIENCE_BRAIN_EXTRACT_MODEL;
  config.refreshConfig();
  const fromConfig = require('./src/config');
  // No override → extract sources should equal default brain model
  if (!fromConfig.getConfig().brainExtractModel) {
    assert.equal(fromConfig.getBrainModelForSource('extract'), fromConfig.getBrainModel());
    assert.equal(fromConfig.getBrainModelForSource('evolve'), fromConfig.getBrainModel());
  }
});

test('getBrainModelForSource: unknown source defaults to brainModel', () => {
  const fromConfig = require('./src/config');
  assert.equal(fromConfig.getBrainModelForSource('weird-source'), fromConfig.getBrainModel());
  assert.equal(fromConfig.getBrainModelForSource(undefined), fromConfig.getBrainModel());
});

// --- Provider routing (regression) -------------------------------------------
// Measured 2026-09-16 on the operator's VPS: hot-path Qwen on SiliconFlow, extract on
// DeepSeek native. callBrainWithFallback routed only the MODEL NAME, so every extract
// call POSTed `deepseek-v4-flash` to SiliconFlow → 400 "Model does not exist" → 10/10
// brain_null → `stored: 0` on every session for as long as the journal goes back.
// These tests pin the whole routing contract: model AND endpoint AND key travel
// together, and a config that crosses an origin without its own key fails closed
// instead of lending the hot-path secret to the other provider.
//
// EXPERIENCE_CONFIG_PATH isolation, NOT a skip guard: the operator's own config.json
// pins brain* keys, and a guard that returns early there would report `ok` with the bug
// present on exactly the box the fix exists for.
const os = require('node:os');
const nodePath = require('node:path');

const NO_CONFIG = nodePath.join(os.tmpdir(), 'ee-nonexistent-config-split-brain-test.json');

async function withBrainEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  config.refreshConfig();
  const calls = [];
  const realFetch = global.fetch;
  const realTimeout = AbortSignal.timeout;
  const budgets = [];
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout.call(AbortSignal, ms); };
  calls.budgets = budgets;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: '{"ok":true}' } }],          // OpenAI / DeepSeek
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], // Gemini
          content: [{ text: '{"ok":true}' }],                           // Claude
        };
      },
      async text() { return ''; },
    };
  };
  try { return await fn(calls); }
  finally {
    global.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    config.refreshConfig();
  }
}

const SPLIT = {
  EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
  EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
  EXPERIENCE_BRAIN_KEY: 'sk-hot',
  EXPERIENCE_BRAIN_MODEL: 'hot-model',
  EXPERIENCE_BRAIN_FALLBACK: '',
};

test('callBrainWithFallback: extract routes endpoint + key + model together', async () => {
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://extract.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-extract',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'extract-model',
  }, async (calls) => {
    const brain = require('./src/brain-llm');

    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://extract.invalid/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-extract');
    assert.equal(JSON.parse(calls[0].init.body).model, 'extract-model');

    // evolve shares the extract route
    await brain.callBrainWithFallback('p', { source: 'evolve' });
    assert.equal(calls[1].url, 'https://extract.invalid/v1/chat/completions');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-extract');

    // hot path untouched
    await brain.callBrainWithFallback('p', { source: 'general' });
    assert.equal(calls[2].url, 'https://hot.invalid/v1/chat/completions');
    assert.equal(calls[2].init.headers.Authorization, 'Bearer sk-hot');
    assert.equal(JSON.parse(calls[2].init.body).model, 'hot-model');
  });
});

test('callBrainWithFallback: single-provider box routes extract exactly like the hot path', async () => {
  // Same host, key and model — the only deliberate difference is the pinned extract
  // time budget, asserted separately below.
  await withBrainEnv(SPLIT, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    await brain.callBrainWithFallback('p', { source: 'general' });
    assert.equal(calls[0].url, calls[1].url);
    assert.equal(calls[0].init.headers.Authorization, calls[1].init.headers.Authorization);
    assert.equal(JSON.parse(calls[0].init.body).model, JSON.parse(calls[1].init.body).model);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-hot');
  });
});

test('callBrainWithFallback: crossing an origin without its own key fails closed, never lends the hot key', async () => {
  // Gemini puts the credential in the URL, so a leak here is logged by every proxy.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'gemini',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gemini-2.0-flash',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.ok(calls[0].url.startsWith('https://generativelanguage.googleapis.com/'),
      `gemini must keep its own endpoint, got ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('sk-hot'), `hot-path key leaked to Google: ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('hot.invalid'), `hot-path endpoint leaked into the Gemini URL: ${calls[0].url}`);
  });

  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'claude',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'claude-haiku-4-5-20251001',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.notEqual(calls[0].init.headers['x-api-key'], 'sk-hot');
  });

  // Same rule for an OpenAI-shaped third party: endpoint moved, key forgotten.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://third-party.invalid/v1/chat/completions',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://third-party.invalid/v1/chat/completions');
    assert.notEqual(calls[0].init.headers.Authorization, 'Bearer sk-hot');
  });
});

test('callBrainWithFallback: the fallback leg uses hot-path model + credentials, not the extract ones', async () => {
  const envs = {
    ...SPLIT,
    EXPERIENCE_BRAIN_FALLBACK: 'custom',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://extract.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-extract',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'extract-model',
  };
  const saved = {};
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...envs };
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  config.refreshConfig();
  const calls = [];
  const realFetch = global.fetch;
  // Primary fails (502), fallback succeeds — exercises both legs in one call.
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const failing = calls.length === 1;
    return {
      ok: !failing,
      status: failing ? 502 : 200,
      async json() { return { choices: [{ message: { content: '{"ok":true}' } }] }; },
      async text() { return 'boom'; },
    };
  };
  try {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls.length, 2, 'primary + fallback');
    assert.equal(calls[0].url, 'https://extract.invalid/v1/chat/completions');
    const fb = calls[1];
    assert.equal(fb.url, 'https://hot.invalid/v1/chat/completions');
    assert.equal(fb.init.headers.Authorization, 'Bearer sk-hot', 'extract key must not reach the fallback host');
    assert.equal(JSON.parse(fb.init.body).model, 'hot-model',
      'the extract model on the hot-path endpoint is the original 400 "Model does not exist"');
  } finally {
    global.fetch = realFetch;
    for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    config.refreshConfig();
  }
});

test('callBrainWithFallback: extract provider set WITHOUT its own endpoint uses that provider default, never the hot host', async () => {
  // The most natural way to write "extract on DeepSeek": name the provider and the key,
  // leave the endpoint alone. Falling back to the hot-path endpoint here is the original
  // 400 "Model does not exist" — and it would hand the DeepSeek key to SiliconFlow.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-extract',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'deepseek-chat',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.ok(!calls[0].url.includes('hot.invalid'), `extract call landed on the hot host: ${calls[0].url}`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-extract');
  });
});

test('callBrainWithFallback: one vendor, two routes, one key — the key is still inherited', async () => {
  // Same origin, different path (a gateway with a per-model route, two Azure deployments,
  // two vLLM routes). Suppressing the key here would 401 a config that has always worked.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'custom',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://gw.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-shared',
    EXPERIENCE_BRAIN_MODEL: 'small',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://gw.invalid/v1/big/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'big',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://gw.invalid/v1/big/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-shared');
    assert.equal(JSON.parse(calls[0].init.body).model, 'big');
  });

  // A trailing slash is not another vendor.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://hot.invalid/v1/chat/completions/',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-hot');
  });

  // A provider ALIAS for the same OpenAI-shaped client is not another vendor either.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'openai',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://api.openai.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-openai',
    EXPERIENCE_BRAIN_MODEL: 'gpt-small',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'custom',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gpt-big',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-openai');
    assert.equal(calls[0].url, 'https://api.openai.invalid/v1/chat/completions');
  });
});

test('callBrainWithFallback: an extract endpoint on an Ollama hot path reaches the remote, not localhost', async () => {
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'ollama',
    EXPERIENCE_BRAIN_MODEL: 'qwen2.5:3b',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://remote.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-remote',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'remote-model',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://remote.invalid/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-remote');
  });
});

test('callBrainWithFallback: the extract budget is one number, whatever provider it lands on', async () => {
  const budgetFor = async (extra) => {
    let seen;
    await withBrainEnv({ ...SPLIT, ...extra }, async (calls) => {
      const brain = require('./src/brain-llm');
      await brain.callBrainWithFallback('p', { source: 'extract' });
      seen = calls.budgets[0];
    });
    return seen;
  };
  const onDeepSeek = await budgetFor({
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://extract.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-extract',
  });
  const onHotProvider = await budgetFor({});
  assert.equal(onDeepSeek, 45000, 'routing must not shrink the extract budget to the provider default');
  assert.equal(onDeepSeek, onHotProvider, 'the extract budget must not depend on where the call is routed');

  // A caller-supplied budget still wins, including a deliberate 0 (= no abort).
  await withBrainEnv(SPLIT, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract', timeoutMs: 2500 });
    assert.equal(calls.budgets[0], 2500);
  });
});

test('/api/brain extract route: a suppressed key is never replaced by the hot-path key', async () => {
  // server.js passes resolveBrainTarget('extract') into classifyViaBrain. A `||` on the
  // key there turned "no key for this vendor" back into the hot-path secret, so the leak
  // survived in the proxy even after the direct brain path was fixed.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://extract.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'extract-model',
  }, async (calls) => {
    const { classifyViaBrain } = require('./src/router');
    const target = config.resolveBrainTarget('extract');
    assert.equal(target.key, '', 'cross-vendor without its own key must resolve to no key');

    const options = {};
    if (options.model === undefined) options.model = target.model;
    if (options.provider === undefined) options.provider = target.provider;
    if (options.endpoint === undefined) options.endpoint = target.endpoint;
    if (options.key === undefined) options.key = target.key;

    const result = await classifyViaBrain('p', 5000, options);
    assert.equal(result, null, 'no key → refuse the call');
    // (requiring the router module pings Qdrant on load; only brain traffic matters here)
    const brainCalls = calls.filter((c) => c.url.includes('invalid'));
    assert.deepEqual(brainCalls.map((c) => c.url), [], 'no brain request may go out without a key');
    const leaked = calls.filter((c) => JSON.stringify(c.init || {}).includes('sk-hot'));
    assert.deepEqual(leaked.map((c) => c.url), [], 'the hot-path key must not reach the extract vendor');
  });

  // With its own key the same route works and carries that key, not the hot one.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://extract.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-extract',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'extract-model',
  }, async (calls) => {
    const { classifyViaBrain } = require('./src/router');
    const target = config.resolveBrainTarget('extract');
    await classifyViaBrain('p', 5000, { model: target.model, provider: target.provider, endpoint: target.endpoint, key: target.key });
    const brainCalls = calls.filter((c) => c.url.includes('invalid'));
    assert.equal(brainCalls.length, 1);
    assert.equal(brainCalls[0].url, 'https://extract.invalid/v1/chat/completions');
    assert.equal(brainCalls[0].init.headers.Authorization, 'Bearer sk-extract');
  });
});

test('hot path on Gemini/Claude never receives a chat/completions endpoint', async () => {
  // A brainEndpoint left over from a previous provider must not be spliced into a client
  // that speaks another protocol — Gemini carries its key in the URL, so that would put
  // the Google key on whatever host the stale field names, on EVERY hot-path call.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'gemini',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://stale.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-google',
    EXPERIENCE_BRAIN_MODEL: 'gemini-2.0-flash',
    EXPERIENCE_BRAIN_FALLBACK: '',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'general' });
    assert.ok(calls[0].url.startsWith('https://generativelanguage.googleapis.com/'), `got ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('stale.invalid'), `stale endpoint reached the Gemini client: ${calls[0].url}`);
  });

  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'claude',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://stale.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-anthropic',
    EXPERIENCE_BRAIN_MODEL: 'claude-haiku-4-5-20251001',
    EXPERIENCE_BRAIN_FALLBACK: '',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'general' });
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const leaked = calls.filter((c) => c.url.includes('stale.invalid'));
    assert.deepEqual(leaked.map((c) => c.url), []);
  });
});

test('same vendor named two ways keeps its key (deepseek is not a different host)', async () => {
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'custom',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://api.deepseek.com/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-ds-shared',
    EXPERIENCE_BRAIN_MODEL: 'deepseek-chat',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'deepseek-reasoner',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-ds-shared');
    assert.equal(JSON.parse(calls[0].init.body).model, 'deepseek-reasoner');
  });

  // The negative half, so "inherit always" cannot satisfy this test: a genuinely
  // different vendor must NOT receive the hot-path key.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'deepseek-chat',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.notEqual(calls[0].init.headers.Authorization, 'Bearer sk-hot',
      'the SiliconFlow key must not travel to DeepSeek');
  });
});

test('an unset hot endpoint still matches the host the client defaults to', async () => {
  // The operator spelled out the host the hot path already reaches implicitly. That is
  // the same origin, so the key must still be inherited.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'openai',
    EXPERIENCE_BRAIN_KEY: 'sk-openai',
    EXPERIENCE_BRAIN_MODEL: 'gpt-small',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://api.openai.com/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gpt-big',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-openai');
  });

  // Negative half: spelling out a DIFFERENT host must not inherit the key.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'openai',
    EXPERIENCE_BRAIN_KEY: 'sk-openai',
    EXPERIENCE_BRAIN_MODEL: 'gpt-small',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://someone-else.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gpt-big',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://someone-else.invalid/v1/chat/completions');
    assert.notEqual(calls[0].init.headers.Authorization, 'Bearer sk-openai',
      'the OpenAI key must not travel to an unrelated host');
  });
});

test('with no endpoint configured, each provider reaches ITS OWN default host', async () => {
  // Measured behaviour, not a source-text grep: a table keyed by family collapsed
  // siliconflow into the OpenAI default and POSTed a SiliconFlow key to api.openai.com.
  const cases = [
    ['siliconflow', 'sk-sf', 'https://api.siliconflow.com/v1/chat/completions'],
    ['openai', 'sk-oa', 'https://api.openai.com/v1/chat/completions'],
    ['custom', 'sk-cu', 'https://api.openai.com/v1/chat/completions'],
    ['deepseek', 'sk-ds', 'https://api.deepseek.com/chat/completions'],
    ['claude', 'sk-an', 'https://api.anthropic.com/v1/messages'],
  ];
  for (const [provider, key, expected] of cases) {
    await withBrainEnv({
      EXPERIENCE_BRAIN_PROVIDER: provider,
      EXPERIENCE_BRAIN_KEY: key,
      EXPERIENCE_BRAIN_MODEL: 'm',
      EXPERIENCE_BRAIN_FALLBACK: '',
    }, async (calls) => {
      const brain = require('./src/brain-llm');
      await brain.callBrainWithFallback('p', { source: 'general' });
      assert.equal(calls[0].url, expected, `${provider} default host`);
    });
  }
  // Gemini puts the model in the path, so assert the base rather than the whole URL.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'gemini',
    EXPERIENCE_BRAIN_KEY: 'sk-go',
    EXPERIENCE_BRAIN_MODEL: 'gemini-2.0-flash',
    EXPERIENCE_BRAIN_FALLBACK: '',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'general' });
    assert.ok(calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'), calls[0].url);
  });

  // Same rule inside classifyViaBrain, which has its own default-host lookup.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_KEY: 'sk-sf',
    EXPERIENCE_BRAIN_MODEL: 'm',
    EXPERIENCE_BRAIN_FALLBACK: '',
  }, async (calls) => {
    const { classifyViaBrain } = require('./src/router');
    await classifyViaBrain('p', 5000, {});
    const brainCalls = calls.filter((c) => c.url.includes('chat/completions'));
    assert.equal(brainCalls[0].url, 'https://api.siliconflow.com/v1/chat/completions');
  });
});

test('an endpoint configured FOR a Gemini/Anthropic target is honoured, key included', async () => {
  // A private gateway (LiteLLM, Vertex, a corporate proxy) speaks that client's own
  // protocol. Dropping the endpoint while keeping its key sends a gateway-only
  // credential to Google/Anthropic.
  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'gemini',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://gemini-proxy.invalid/v1beta/models',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-proxy-only',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gemini-2.0-flash',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.ok(calls[0].url.startsWith('https://gemini-proxy.invalid/'), `got ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('googleapis.com'), `proxy key sent to Google: ${calls[0].url}`);
  });

  await withBrainEnv({
    ...SPLIT,
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'claude',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://claude-proxy.invalid/v1/messages',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-proxy-only',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'claude-haiku-4-5-20251001',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://claude-proxy.invalid/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-proxy-only');
  });
});

test('a key never lands on a host it does not belong to when no endpoint is configured', async () => {
  // The resolver decided the key for the TARGET provider while the client filled the empty
  // endpoint from the HOT provider — so an OpenAI key went to SiliconFlow and back.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_KEY: 'sk-sf',
    EXPERIENCE_BRAIN_MODEL: 'qwen',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'openai',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-openai-own',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gpt-4o',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-openai-own');
  });

  // Mirror: a SiliconFlow key must not reach OpenAI's live API.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'openai',
    EXPERIENCE_BRAIN_KEY: 'sk-oa',
    EXPERIENCE_BRAIN_MODEL: 'gpt-4o',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-sf-own',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'qwen',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.siliconflow.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-sf-own');
  });

  // …and the reverse of the same disagreement: the call DOES land on the host the hot key
  // authenticates against, so the key must not be suppressed.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_KEY: 'sk-ds',
    EXPERIENCE_BRAIN_MODEL: 'deepseek-chat',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'deepseek-reasoner',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-ds');
  });
});

test('a stale brainEndpoint on a Gemini/Claude hot path does not strip the extract key', async () => {
  // Single-provider box, no extract settings — just one leftover field. Comparing that
  // field against the client default made the resolver call it a vendor change and blank
  // the only key on the box, so every extraction 401'd.
  for (const [provider, keyEnv, header] of [['claude', 'sk-anthropic', 'x-api-key'], ['gemini', 'sk-google', null]]) {
    await withBrainEnv({
      EXPERIENCE_BRAIN_PROVIDER: provider,
      EXPERIENCE_BRAIN_KEY: keyEnv,
      EXPERIENCE_BRAIN_MODEL: 'm',
      EXPERIENCE_BRAIN_ENDPOINT: 'https://stale.invalid/v1/chat/completions',
      EXPERIENCE_BRAIN_FALLBACK: '',
    }, async (calls) => {
      const brain = require('./src/brain-llm');
      await brain.callBrainWithFallback('p', { source: 'extract' });
      if (header) assert.equal(calls[0].init.headers[header], keyEnv, `${provider}: extract lost the only key on the box`);
      else assert.ok(calls[0].url.includes(`key=${keyEnv}`), `${provider}: extract lost the only key on the box, got ${calls[0].url}`);
      assert.ok(!calls[0].url.includes('stale.invalid'), `${provider}: stale endpoint used`);
    });
  }

  // Negative half: the same stale field must still not let a SiliconFlow key reach Google.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://hot.invalid/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-hot',
    EXPERIENCE_BRAIN_MODEL: 'hot-model',
    EXPERIENCE_BRAIN_FALLBACK: '',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'gemini',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'gemini-2.0-flash',
  }, async (calls) => {
    const brain = require('./src/brain-llm');
    await brain.callBrainWithFallback('p', { source: 'extract' });
    assert.ok(!calls[0].url.includes('sk-hot'), `hot key reached Google: ${calls[0].url}`);
    assert.notEqual(calls[0].init.headers?.Authorization, 'Bearer sk-hot', 'hot key sent as a bearer header');
  });
});

test('classifyViaBrain refuses a named provider whose protocol it cannot speak', async () => {
  // Making the resolver always emit a concrete endpoint turned the `|| endpoint` condition
  // into always-true, so /api/brain sent an OpenAI-shaped body with a Bearer header to
  // Google and Anthropic — the right vendor, an auth scheme it cannot parse.
  // Mixed case included: every other lookup in the chain is case-insensitive, so a
  // capital letter must not be a way past the guard.
  for (const [provider, model] of [['gemini', 'gemini-2.0-flash'], ['claude', 'claude-haiku-4-5-20251001'], ['Gemini', 'gemini-2.0-flash'], ['CLAUDE', 'claude-haiku-4-5-20251001']]) {
    await withBrainEnv({
      EXPERIENCE_BRAIN_PROVIDER: provider,
      EXPERIENCE_BRAIN_KEY: 'sk-vendor',
      EXPERIENCE_BRAIN_MODEL: model,
      EXPERIENCE_BRAIN_FALLBACK: '',
    }, async (calls) => {
      const { classifyViaBrain } = require('./src/router');
      const target = config.resolveBrainTarget('extract');
      const result = await classifyViaBrain('p', 5000, {
        model: target.model, provider: target.provider, endpoint: target.endpoint, key: target.key,
      });
      assert.equal(result, null, `${provider}: must not be routed through the chat/completions branch`);
      const bearer = calls.filter((c) => (c.init?.headers?.Authorization || '').startsWith('Bearer sk-vendor'));
      assert.deepEqual(bearer.map((c) => c.url), [], `${provider}: credential put on the wire in the wrong scheme`);
    });
  }

  // An endpoint with no recognised provider keeps its legacy meaning: OpenAI-shaped.
  await withBrainEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'some-gateway',
    EXPERIENCE_BRAIN_KEY: 'sk-gw',
    EXPERIENCE_BRAIN_MODEL: 'm',
    EXPERIENCE_BRAIN_FALLBACK: '',
  }, async (calls) => {
    const { classifyViaBrain } = require('./src/router');
    await classifyViaBrain('p', 5000, { provider: 'some-gateway', endpoint: 'https://gw.invalid/v1/chat/completions', key: 'sk-gw', model: 'm' });
    const brainCalls = calls.filter((c) => c.url.includes('gw.invalid'));
    assert.equal(brainCalls.length, 1, 'an unrecognised provider with an endpoint stays OpenAI-shaped');
  });
});
