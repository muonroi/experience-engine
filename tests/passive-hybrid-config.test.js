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
const path = require('node:path');
const os = require('node:os');

const cfg = require('../.experience/src/config.js');

// Point the config loader at a path that does not exist so these unit tests
// assert the CODE defaults + env overrides, isolated from the operator's live
// ~/.experience/config.json (which may legitimately enable passiveHybrid and
// would otherwise win over env, since cfgValue reads config before env).
const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-passive-hybrid-test.json');

function withEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
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
