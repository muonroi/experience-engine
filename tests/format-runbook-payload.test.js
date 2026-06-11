#!/usr/bin/env node
'use strict';

/**
 * format-runbook-payload.test.js — runbook convention (slice 1, step 3).
 *
 * A runbook is a thin procedure-index entry imported via the memory path, so
 * its provenance is createdFrom='seed-memory-import' (set downstream in
 * storeImportedExperience). The runbook MARKER and its stitch links therefore
 * live in dedicated payload fields: nodeKind + derivedFromId. buildStorePayload
 * is the shared payload builder — this locks that it threads those optional
 * fields through (default null) without disturbing the existing shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStorePayload } = require('../.experience/src/format.js');

const baseQa = {
  trigger: 'after donor sync completes',
  question: 'what next?',
  solution: 'gap-census then backfill biggest-first',
};

test('buildStorePayload: preserves nodeKind and derivedFromId when present', () => {
  const qa = { ...baseQa, nodeKind: 'runbook', derivedFromId: ['4c81b5ca', '1e5f095f'] };
  const p = buildStorePayload('id-1', qa, null, 'storyflow');
  assert.equal(p.nodeKind, 'runbook');
  assert.deepEqual(p.derivedFromId, ['4c81b5ca', '1e5f095f']);
  // Scope still threaded so the runbook is project-scoped (avoids cross-repo noise).
  assert.equal(p.scope.project_slug, 'storyflow');
});

test('buildStorePayload: nodeKind/derivedFromId default to null for ordinary entries', () => {
  const p = buildStorePayload('id-2', baseQa, null, 'storyflow');
  assert.equal(p.nodeKind, null);
  assert.equal(p.derivedFromId, null);
});

test('buildStorePayload: non-array derivedFromId is normalized to null', () => {
  const qa = { ...baseQa, nodeKind: 'runbook', derivedFromId: 'not-an-array' };
  const p = buildStorePayload('id-3', qa, null, null);
  assert.equal(p.derivedFromId, null);
  assert.equal(p.nodeKind, 'runbook');
});

test('buildStorePayload: runbook fields do not disturb the core entry shape', () => {
  const qa = { ...baseQa, nodeKind: 'runbook', derivedFromId: ['x'] };
  const p = buildStorePayload('id-4', qa, null, 'storyflow');
  assert.equal(p.id, 'id-4');
  assert.equal(p.trigger, baseQa.trigger);
  assert.equal(p.solution, baseQa.solution);
  // Default provenance is still session-extractor here; storeImportedExperience
  // overrides it to seed-memory-import for the actual import path.
  assert.equal(p.createdFrom, 'session-extractor');
  assert.equal(p.tier, 2);
});
