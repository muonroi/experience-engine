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
