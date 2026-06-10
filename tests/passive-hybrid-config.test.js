#!/usr/bin/env node
'use strict';

/**
 * passive-hybrid-config.test.js — config gates for opt-in passive-hint
 * hybridization. The feature MUST default OFF (passive hints are precision-tuned
 * for dashboard Gate 4); these getters are the only switch, so pin their
 * defaults + env overrides. cfgValue reads process.env live per call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cfg = require('../.experience/src/config.js');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('getPassiveHybrid: OFF by default', () => {
  withEnv({ EXPERIENCE_PASSIVE_HYBRID: '' }, () => {
    delete process.env.EXPERIENCE_PASSIVE_HYBRID;
    assert.equal(cfg.getPassiveHybrid(), false);
  });
});

test('getPassiveHybrid: enabled by env "true"', () => {
  withEnv({ EXPERIENCE_PASSIVE_HYBRID: 'true' }, () => {
    assert.equal(cfg.getPassiveHybrid(), true);
  });
  withEnv({ EXPERIENCE_PASSIVE_HYBRID: 'false' }, () => {
    assert.equal(cfg.getPassiveHybrid(), false);
  });
});

test('getPassiveLexicalMaxAdds: default 1, env override, never negative', () => {
  withEnv({ EXPERIENCE_PASSIVE_LEXICAL_MAX_ADDS: '' }, () => {
    delete process.env.EXPERIENCE_PASSIVE_LEXICAL_MAX_ADDS;
    assert.equal(cfg.getPassiveLexicalMaxAdds(), 1);
  });
  withEnv({ EXPERIENCE_PASSIVE_LEXICAL_MAX_ADDS: '3' }, () => assert.equal(cfg.getPassiveLexicalMaxAdds(), 3));
  withEnv({ EXPERIENCE_PASSIVE_LEXICAL_MAX_ADDS: '-5' }, () => assert.equal(cfg.getPassiveLexicalMaxAdds(), 0));
});

test('getPassiveLexicalDisplayScore: defaults to floor + 0.10', () => {
  withEnv({ EXPERIENCE_PASSIVE_LEXICAL_DISPLAY_SCORE: '' }, () => {
    delete process.env.EXPERIENCE_PASSIVE_LEXICAL_DISPLAY_SCORE;
    const expected = cfg.getMinSearchScore() + 0.10;
    assert.ok(Math.abs(cfg.getPassiveLexicalDisplayScore() - expected) < 1e-9);
  });
  withEnv({ EXPERIENCE_PASSIVE_LEXICAL_DISPLAY_SCORE: '0.65' }, () => {
    assert.equal(cfg.getPassiveLexicalDisplayScore(), 0.65);
  });
});
