#!/usr/bin/env node
'use strict';

/**
 * runbook-reconfirm.test.js — proposal §3.6 (flag only).
 *
 * Pure unit coverage of evolution.computeRunbookReconfirm: given a runbook
 * payload (nodeKind:'runbook' + derivedFromId) and the set of currently
 * superseded 8-char id prefixes, it decides whether the runbook should be
 * flagged needsReconfirm. It never auto-edits the body and is idempotent —
 * it only (re)flags when a NEW superseded id enters the trigger set.
 * No LLM, no Qdrant, no filesystem.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRunbookReconfirm } = require('../.experience/src/evolution.js');

function runbook(extra = {}) {
  return {
    nodeKind: 'runbook',
    trigger: 'post donor enrich',
    solution: 'ordered steps',
    derivedFromId: ['4c81b5ca', 'd1934712', '1e5f095f'],
    ...extra,
  };
}

test('non-runbook payload → null', () => {
  assert.equal(computeRunbookReconfirm({ nodeKind: null, derivedFromId: ['4c81b5ca'] }, new Set(['4c81b5ca'])), null);
});

test('runbook without derivedFromId → null', () => {
  assert.equal(computeRunbookReconfirm(runbook({ derivedFromId: null }), new Set(['4c81b5ca'])), null);
  assert.equal(computeRunbookReconfirm(runbook({ derivedFromId: [] }), new Set(['4c81b5ca'])), null);
});

test('runbook with no superseded derived ids → null', () => {
  assert.equal(computeRunbookReconfirm(runbook(), new Set(['ffffffff'])), null);
});

test('one derived id superseded → flags that id', () => {
  const res = computeRunbookReconfirm(runbook(), new Set(['d1934712']));
  assert.ok(res);
  assert.deepEqual(res.matched, ['d1934712']);
  assert.deepEqual(res.merged, ['d1934712']);
});

test('full-length derived id matches short superseded prefix', () => {
  // derivedFromId authored as a full UUID; superseded set carries the 8-char prefix.
  const res = computeRunbookReconfirm(runbook({ derivedFromId: ['4c81b5ca-1111-2222-3333-444455556666'] }), new Set(['4c81b5ca']));
  assert.ok(res);
  assert.deepEqual(res.matched, ['4c81b5ca']);
});

test('accepts a plain array for supersededShortIds (not only Set)', () => {
  const res = computeRunbookReconfirm(runbook(), ['1e5f095f']);
  assert.ok(res);
  assert.deepEqual(res.matched, ['1e5f095f']);
});

test('idempotent: already flagged for the same id set → null', () => {
  const r = runbook({ needsReconfirm: true, reconfirmTriggeredBy: ['d1934712'] });
  assert.equal(computeRunbookReconfirm(r, new Set(['d1934712'])), null);
});

test('re-flags when a NEW superseded id appears, merging with prior triggers', () => {
  const r = runbook({ needsReconfirm: true, reconfirmTriggeredBy: ['d1934712'] });
  const res = computeRunbookReconfirm(r, new Set(['d1934712', '4c81b5ca']));
  assert.ok(res);
  assert.deepEqual(res.merged.sort(), ['4c81b5ca', 'd1934712']);
});

test('an already-superseded runbook is itself exempt → null', () => {
  assert.equal(computeRunbookReconfirm(runbook({ superseded: true }), new Set(['d1934712'])), null);
});

test('empty/missing superseded set → null', () => {
  assert.equal(computeRunbookReconfirm(runbook(), new Set()), null);
  assert.equal(computeRunbookReconfirm(runbook(), undefined), null);
});
