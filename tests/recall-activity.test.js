#!/usr/bin/env node
'use strict';

/**
 * recall-activity.test.js — P1: op:'recall' activity row shape.
 *
 * handleRecall emits activityLog(buildRecallEvent(query, meta, entries)) so a
 * recall becomes observable per session. buildRecallEvent is pure; this locks
 * its shape (op, truncated query, sourceSession, project_slug, surfacedIds,
 * count) independent of the server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRecallEvent } = require('../.experience/src/activity.js');

test('buildRecallEvent: full shape with session + project + entries', () => {
  const ev = buildRecallEvent(
    'how do we restart the api server',
    { sourceSession: 'sess-1', project_slug: 'experience-engine' },
    [{ id: 'aaa', collection: 'experience-selfqa' }, { id: 'bbb', collection: 'experience-behavioral' }],
  );
  assert.equal(ev.op, 'recall');
  assert.equal(ev.query, 'how do we restart the api server');
  assert.equal(ev.sourceSession, 'sess-1');
  assert.equal(ev.project_slug, 'experience-engine');
  assert.deepEqual(ev.surfacedIds, ['aaa', 'bbb']);
  assert.equal(ev.count, 2);
});

test('buildRecallEvent: null session/project when meta is empty', () => {
  const ev = buildRecallEvent('q', {}, []);
  assert.equal(ev.sourceSession, null);
  assert.equal(ev.project_slug, null);
  assert.deepEqual(ev.surfacedIds, []);
  assert.equal(ev.count, 0);
});

test('buildRecallEvent: query is truncated to 200 chars', () => {
  const long = 'x'.repeat(500);
  const ev = buildRecallEvent(long, {}, []);
  assert.equal(ev.query.length, 200);
});

test('buildRecallEvent: drops entries without an id and counts the rest', () => {
  const ev = buildRecallEvent('q', { sourceSession: 's' }, [
    { id: 'keep1' },
    { collection: 'x' }, // no id -> dropped
    { id: 0 },           // id 0 is non-null -> "0" kept
    null,                // skipped
  ]);
  assert.deepEqual(ev.surfacedIds, ['keep1', '0']);
  assert.equal(ev.count, 2);
});

test('buildRecallEvent: tolerates missing meta and entries args', () => {
  const ev = buildRecallEvent('only-query');
  assert.equal(ev.op, 'recall');
  assert.equal(ev.sourceSession, null);
  assert.deepEqual(ev.surfacedIds, []);
});
