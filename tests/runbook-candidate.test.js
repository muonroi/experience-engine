#!/usr/bin/env node
'use strict';

/**
 * runbook-candidate.test.js — slice 2 detection (proposal §3.3).
 *
 * Pure unit coverage of signal-detector.detectRunbookCandidates: it reads
 * recorded op:'recall' activity rows and proposes "crystallize a runbook?" only
 * when the agent stitched >= minStitch distinct recalls over >= 2 recurring
 * atomic entries with no runbook among them. No LLM, no Qdrant, no filesystem.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sd = require('../.experience/src/signal-detector.js');

const SID = 'sess-abc';

// Three distinct recalls, ids A+B recur across all of them, no runbook present.
function stitchRows(sessionId = SID) {
  return [
    { op: 'recall', sourceSession: sessionId, project_slug: 'storyflow', query: 'post donor enrich', surfacedIds: ['A', 'B', 'C'] },
    { op: 'recall', sourceSession: sessionId, project_slug: 'storyflow', query: 'gap census crawl', surfacedIds: ['A', 'B', 'D'] },
    { op: 'recall', sourceSession: sessionId, project_slug: 'storyflow', query: 'relaunch container proxy', surfacedIds: ['A', 'E'] },
  ];
}

test('emits a candidate for 3 recalls reusing >=2 atomic ids, no runbook', () => {
  const c = sd.detectRunbookCandidates(stitchRows(), { sessionId: SID });
  assert.ok(c, 'expected a candidate');
  assert.equal(c.sessionId, SID);
  assert.equal(c.recallCount, 3);
  assert.equal(c.project_slug, 'storyflow');
  assert.equal(c.topic, 'storyflow');
  assert.deepEqual(c.recurringIds.sort(), ['A', 'B']);
  assert.deepEqual(c.queries, ['post donor enrich', 'gap census crawl', 'relaunch container proxy']);
});

test('no candidate when fewer than minStitch recalls', () => {
  const rows = stitchRows().slice(0, 2);
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID }), null);
});

test('no candidate when no atomic id recurs across >=2 recalls', () => {
  const rows = [
    { op: 'recall', sourceSession: SID, query: 'q1', surfacedIds: ['A'] },
    { op: 'recall', sourceSession: SID, query: 'q2', surfacedIds: ['B'] },
    { op: 'recall', sourceSession: SID, query: 'q3', surfacedIds: ['C'] },
  ];
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID }), null);
});

test('only ONE id recurs -> below the >=2 recurring floor -> no candidate', () => {
  const rows = [
    { op: 'recall', sourceSession: SID, query: 'q1', surfacedIds: ['A', 'X'] },
    { op: 'recall', sourceSession: SID, query: 'q2', surfacedIds: ['A', 'Y'] },
    { op: 'recall', sourceSession: SID, query: 'q3', surfacedIds: ['A', 'Z'] },
  ];
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID }), null);
});

test('no candidate when a runbook is already among the surfaced ids', () => {
  const c = sd.detectRunbookCandidates(stitchRows(), {
    sessionId: SID,
    isRunbookId: (id) => id === 'B',
  });
  assert.equal(c, null);
});

test('sessionId filter isolates rows from other sessions', () => {
  const rows = [
    ...stitchRows('other-1'),
    { op: 'recall', sourceSession: SID, query: 'q', surfacedIds: ['A', 'B'] },
  ];
  // Only one row belongs to SID -> below minStitch.
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID }), null);
  // The other session DOES stitch.
  assert.ok(sd.detectRunbookCandidates(rows, { sessionId: 'other-1' }));
});

test('exact-duplicate recalls collapse to one distinct stitch', () => {
  const dup = { op: 'recall', sourceSession: SID, query: 'same', surfacedIds: ['A', 'B'] };
  const rows = [dup, { ...dup }, { ...dup }];
  // 3 rows but 1 distinct recall -> no stitch.
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID }), null);
});

test('ignores non-recall activity rows', () => {
  const rows = [
    { op: 'hook', hook: 'interceptor-prompt', sourceSession: SID },
    { op: 'cost-call', sourceSession: SID },
    ...stitchRows(),
  ];
  const c = sd.detectRunbookCandidates(rows, { sessionId: SID });
  assert.ok(c);
  assert.equal(c.recallCount, 3);
});

test('without sessionId, groups across all rows (topic falls back to first query when no project)', () => {
  const rows = [
    { op: 'recall', query: 'alpha', surfacedIds: ['A', 'B'] },
    { op: 'recall', query: 'beta', surfacedIds: ['A', 'B'] },
    { op: 'recall', query: 'gamma', surfacedIds: ['A', 'C'] },
  ];
  const c = sd.detectRunbookCandidates(rows, {});
  assert.ok(c);
  assert.equal(c.project_slug, null);
  assert.equal(c.topic, 'alpha');
});

test('minStitch below 2 is clamped (cannot satisfy the >=2 recurring rule anyway)', () => {
  // minStitch=1 is clamped to the default 3; a single recall never stitches.
  const rows = [{ op: 'recall', sourceSession: SID, query: 'q', surfacedIds: ['A', 'B'] }];
  assert.equal(sd.detectRunbookCandidates(rows, { sessionId: SID, minStitch: 1 }), null);
});

test('default minStitch constant is exported and equals 3', () => {
  assert.equal(sd.RUNBOOK_STITCH_MIN_DEFAULT, 3);
});
