#!/usr/bin/env node
'use strict';

/**
 * search-rerank.test.js — /api/search effective-score rerank (flooding fix).
 *
 * /api/search is the PASSIVE PIL-injection path (muonroi-cli bridge.searchByText),
 * NOT the deliberate /api/recall. It historically returned raw cosine, so the
 * precision penalty stack in scoring.computeEffectiveScore — which exists "to
 * suppress passive-hint noise" — never applied, and a generic, over-ignored
 * principle at ~0.48 cosine dominated injection (top-3 points = 32% of all slots
 * in the live muonroi.db). server.handleSearch now reranks by effective score and
 * returns it as `score`, so the client floor drops the penalized entries.
 *
 * Here we pin the new config switch + its export contract, and prove the behaviour
 * the fix relies on: the penalty stack demotes an over-ignored point below a clean
 * one even when the over-ignored point has the higher raw cosine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const cfg = require('../.experience/src/config.js');

// Isolate from the operator's live ~/.experience/config.json (cfgValue reads config
// before env, so it would otherwise win over these env overrides).
const NO_CONFIG = path.join(os.tmpdir(), 'ee-nonexistent-config-search-rerank-test.json');

function withEnv(vars, fn) {
  const merged = { EXPERIENCE_CONFIG_PATH: NO_CONFIG, ...vars };
  const saved = {};
  for (const k of Object.keys(merged)) { saved[k] = process.env[k]; process.env[k] = merged[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(merged)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('getSearchRerank: ON by default (passive path applies the precision penalty stack)', () => {
  withEnv({ EXPERIENCE_SEARCH_RERANK: '' }, () => {
    delete process.env.EXPERIENCE_SEARCH_RERANK;
    assert.equal(cfg.getSearchRerank(), true);
  });
});

test('getSearchRerank: env "false" reverts /api/search to raw cosine', () => {
  withEnv({ EXPERIENCE_SEARCH_RERANK: 'false' }, () => {
    assert.equal(cfg.getSearchRerank(), false);
  });
});

test('getSearchRerank: env "true" stays on', () => {
  withEnv({ EXPERIENCE_SEARCH_RERANK: 'true' }, () => {
    assert.equal(cfg.getSearchRerank(), true);
  });
});

test('getSearchRerank: unrelated env value is truthy (only "false" disables)', () => {
  withEnv({ EXPERIENCE_SEARCH_RERANK: '1' }, () => {
    assert.equal(cfg.getSearchRerank(), true);
  });
});

test('experience-core exposes _rerankByQuality for server.js handleSearch', () => {
  const core = require('../.experience/experience-core.js');
  assert.equal(typeof core._rerankByQuality, 'function');
});

test('rerank demotes an over-ignored generic principle below a clean task-specific hit', () => {
  const core = require('../.experience/experience-core.js');
  const mkPoint = (id, cosine, data) => ({ id, score: cosine, payload: { json: JSON.stringify(data) } });

  // A: generic principle, HIGHER raw cosine, but heavily ignored + judged irrelevant
  //    (the flooding case — clears the floor on any query yet rarely helps).
  const overIgnored = mkPoint('generic-flooder', 0.55, {
    principle: 'Version API from day one',
    hitCount: 0, ignoreCount: 10, irrelevantCount: 6,
  });
  // B: task-specific pattern, LOWER raw cosine, clean history.
  const cleanSpecific = mkPoint('task-specific', 0.50, {
    solution: 'Send caller cwd with EE feedback so noise scope-narrows',
    hitCount: 2, ignoreCount: 0, irrelevantCount: 0,
  });

  const ranked = core._rerankByQuality([overIgnored, cleanSpecific], undefined, undefined, 'some unrelated task query');

  // The clean, lower-cosine point now ranks first — penalty stack overrode cosine.
  assert.equal(ranked[0].id, 'task-specific', 'clean point should outrank the over-ignored flooder');
  const floodEff = ranked.find((p) => p.id === 'generic-flooder')._effectiveScore;
  const cleanEff = ranked.find((p) => p.id === 'task-specific')._effectiveScore;
  // The flooder's effective score is dragged well below its 0.55 cosine…
  assert.ok(floodEff < 0.55, `flooder effective (${floodEff}) should be penalized below its cosine`);
  // …and below the clean point, which is why the client floor can now drop it.
  assert.ok(cleanEff > floodEff, `clean (${cleanEff}) should exceed flooder (${floodEff})`);
});
