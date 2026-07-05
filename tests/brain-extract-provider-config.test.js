#!/usr/bin/env node
'use strict';

/**
 * brain-extract-provider-config.test.js — the extract-path provider split.
 *
 * The extract/evolve jobs need a STRONGER model than the hot-path brain, and that model can
 * live on a DIFFERENT provider/key/endpoint (hot-path Qwen on SiliconFlow, extract on DeepSeek
 * native because SiliconFlow 429-rate-limits DeepSeek hard). These getters route the extract
 * call independently. Contract pinned here:
 *   • Unconfigured → each extract getter FALLS BACK to the hot-path brain getter (a
 *     single-provider box is byte-for-byte unchanged — backward compatible).
 *   • Configured → the extract override wins for the extract path only, leaving the hot-path
 *     getters untouched.
 * cfgValue reads process.env live per call, so env drives these under an isolated config path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const cfg = require('../.experience/src/config.js');

// Isolate from the operator's live ~/.experience/config.json (which really DOES configure a
// DeepSeek extract provider on the VPS and would otherwise win over env).
const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-brain-extract-test.json');

function withEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('extract getters fall back to the hot-path brain getters when unconfigured', () => {
  withEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://api.siliconflow.com/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-hotpath',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: '',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: '',
    EXPERIENCE_BRAIN_EXTRACT_KEY: '',
  }, () => {
    delete process.env.EXPERIENCE_BRAIN_EXTRACT_PROVIDER;
    delete process.env.EXPERIENCE_BRAIN_EXTRACT_ENDPOINT;
    delete process.env.EXPERIENCE_BRAIN_EXTRACT_KEY;
    assert.equal(cfg.getBrainExtractProvider(), 'siliconflow');
    assert.equal(cfg.getBrainExtractEndpoint(), 'https://api.siliconflow.com/v1/chat/completions');
    assert.equal(cfg.getBrainExtractKey(), 'sk-hotpath');
  });
});

test('extract getters win when configured, without disturbing the hot-path getters', () => {
  withEnv({
    EXPERIENCE_BRAIN_PROVIDER: 'siliconflow',
    EXPERIENCE_BRAIN_ENDPOINT: 'https://api.siliconflow.com/v1/chat/completions',
    EXPERIENCE_BRAIN_KEY: 'sk-hotpath',
    EXPERIENCE_BRAIN_EXTRACT_PROVIDER: 'deepseek',
    EXPERIENCE_BRAIN_EXTRACT_ENDPOINT: 'https://api.deepseek.com/v1/chat/completions',
    EXPERIENCE_BRAIN_EXTRACT_KEY: 'sk-deepseek',
    EXPERIENCE_BRAIN_EXTRACT_MODEL: 'deepseek-v4-flash',
  }, () => {
    // extract path routed to DeepSeek
    assert.equal(cfg.getBrainExtractProvider(), 'deepseek');
    assert.equal(cfg.getBrainExtractEndpoint(), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(cfg.getBrainExtractKey(), 'sk-deepseek');
    assert.equal(cfg.getBrainExtractModel(), 'deepseek-v4-flash');
    // hot-path getters untouched — Qwen on SiliconFlow keeps working
    assert.equal(cfg.getBrainProvider(), 'siliconflow');
    assert.equal(cfg.getBrainEndpoint(), 'https://api.siliconflow.com/v1/chat/completions');
    assert.equal(cfg.getBrainKey(), 'sk-hotpath');
  });
});
