#!/usr/bin/env node
'use strict';

/**
 * search-hybrid.test.js — config gate + export contract for /api/search
 * hybridization (G3-a). Unlike passive hints, /api/search is a deliberate query,
 * so it fuses a lexical BM25 leg by DEFAULT (matching /api/recall). This getter is
 * the only switch, so pin its default + env overrides. The fusion correctness
 * itself is covered by fusion.test.js / sparse.test.js and proven end-to-end
 * against the live endpoint; here we only guard the new switch + that the core
 * facade exposes the hybrid building block server.js depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const cfg = require('../.experience/src/config.js');

// Point the config loader at a non-existent path so these tests assert CODE
// defaults + env overrides, isolated from the operator's live ~/.experience/
// config.json (which may set searchHybrid and would otherwise win over env,
// since cfgValue reads config before env).
const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-search-hybrid-test.json');

function withEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('getSearchHybrid: ON by default (deliberate query → fuse lexical leg like recall)', () => {
  withEnv({ EXPERIENCE_SEARCH_HYBRID: '' }, () => {
    delete process.env.EXPERIENCE_SEARCH_HYBRID;
    assert.equal(cfg.getSearchHybrid(), true);
  });
});

test('getSearchHybrid: env "false" reverts to dense-only', () => {
  withEnv({ EXPERIENCE_SEARCH_HYBRID: 'false' }, () => {
    assert.equal(cfg.getSearchHybrid(), false);
  });
});

test('getSearchHybrid: env "true" stays on', () => {
  withEnv({ EXPERIENCE_SEARCH_HYBRID: 'true' }, () => {
    assert.equal(cfg.getSearchHybrid(), true);
  });
});

test('getSearchHybrid: unrelated env value is truthy (only "false" disables)', () => {
  withEnv({ EXPERIENCE_SEARCH_HYBRID: '1' }, () => {
    assert.equal(cfg.getSearchHybrid(), true);
  });
});

test('experience-core exposes searchCollectionHybrid for server.js handleSearch', () => {
  const core = require('../.experience/experience-core.js');
  assert.equal(typeof core.searchCollectionHybrid, 'function');
  // Arity: (collection, queryText, vector, topK, signal, extraFilter)
  assert.ok(core.searchCollectionHybrid.length >= 4);
});
