#!/usr/bin/env node
'use strict';

/**
 * runbook-nudge-wiring.test.js — slice 2 nudge wiring guards (proposal §3.4).
 *
 * stop-extractor.maybeNudgeRunbookCandidate is the session-end surface. The
 * happy-path detection is covered exhaustively by runbook-candidate.test.js
 * (pure). Here we lock the two wiring guards that do NOT depend on the live
 * activity-log path: the EXPERIENCE_RUNBOOK_NUDGE gate and the
 * "unattributed recall → skip" guard. homeDir points at the repo root so the
 * require()s for config.js + signal-detector.js resolve to the real modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const stop = require('../.experience/stop-extractor.js');

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('gate off (EXPERIENCE_RUNBOOK_NUDGE=0) returns null before any detection', () => {
  withEnv(
    { EXPERIENCE_RUNBOOK_NUDGE: '0', EXP_SESSION: 'sess-x', EXPERIENCE_CONFIG_PATH: path.join(repoRoot, '.no-such-config.json') },
    () => {
      assert.equal(stop.maybeNudgeRunbookCandidate(repoRoot, { file: '/x/sess-x.jsonl' }), null);
    },
  );
});

test('unattributed (no EXP_SESSION, no session file) returns null', () => {
  withEnv(
    { EXPERIENCE_RUNBOOK_NUDGE: '1', EXP_SESSION: undefined, EXPERIENCE_CONFIG_PATH: path.join(repoRoot, '.no-such-config.json') },
    () => {
      assert.equal(stop.maybeNudgeRunbookCandidate(repoRoot, null), null);
    },
  );
});

test('maybeNudgeRunbookCandidate is exported', () => {
  assert.equal(typeof stop.maybeNudgeRunbookCandidate, 'function');
});
