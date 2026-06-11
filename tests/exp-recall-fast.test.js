#!/usr/bin/env node
'use strict';

/**
 * exp-recall-fast.test.js — slice 2: fast recall flag wiring.
 *
 * The prompt risk gate auto-runs recall to push [id col] into context, but the
 * full recall (~10s, dominated by the brainRelevanceFilter LLM rerank) always
 * blew the synchronous hook budget. opts.fast → body.fast tells the server to
 * take the realtime fast path (skip the LLM rerank). This locks the client
 * wiring: --fast parses, and opts.fast puts fast:true on the POST body (omitted
 * otherwise).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, recall } = require('../.experience/exp-recall.js');

test('parseArgs: --fast sets opts.fast and is not a query word', () => {
  const parsed = parseArgs(['node', 'exp-recall.js', '--fast', 'deploy', 'migration']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.opts.fast, true);
  assert.equal(parsed.query, 'deploy migration');
});

test('parseArgs: fast defaults to false', () => {
  const parsed = parseArgs(['node', 'exp-recall.js', 'just', 'a', 'query']);
  assert.equal(parsed.opts.fast, false);
});

function withStubbedFetch(captured, fn) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    captured.url = url;
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: null, entries: [], count: 0 }) };
  };
  return Promise.resolve(fn()).finally(() => { global.fetch = orig; });
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recall-fast-'));
  fs.mkdirSync(path.join(home, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(home, '.experience', 'config.json'), JSON.stringify({ serverBaseUrl: 'http://localhost:8082', serverAuthToken: 't' }));
  return home;
}

test('recall: opts.fast=true puts fast:true on the request body', async () => {
  const home = tmpHome();
  const captured = {};
  await withStubbedFetch(captured, () => recall('deploy', { fast: true, cwd: '/x' }, home));
  assert.equal(captured.url, 'http://localhost:8082/api/recall');
  assert.equal(captured.body.fast, true);
});

test('recall: without fast, body carries no fast flag', async () => {
  const home = tmpHome();
  const captured = {};
  await withStubbedFetch(captured, () => recall('deploy', { cwd: '/x' }, home));
  assert.equal(captured.body.fast, undefined);
});

// Client-side op:'recall' logging — the data source for the session-end runbook
// nudge. Must land in the homeDir-relative activity.jsonl (test-isolated) and be
// suppressible for the risk-gate's internal auto-recall.
function readActivity(home) {
  const p = path.join(home, '.experience', 'activity.jsonl');
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('recall: logs a local op:recall row (homeDir-relative, isolated)', async () => {
  const home = tmpHome();
  const captured = {};
  // stub returns one entry so surfacedIds is non-empty
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: 't', entries: [{ id: 'X1', collection: 'c' }], count: 1 }) };
  };
  try {
    await recall('deploy migration', { cwd: '/x', session: 'sess-1' }, home);
  } finally { global.fetch = orig; }
  const rows = readActivity(home).filter((e) => e.op === 'recall');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceSession, 'sess-1');
  assert.deepEqual(rows[0].surfacedIds, ['X1']);
  assert.equal(rows[0].count, 1);
  assert.ok(rows[0].ts, 'row carries a ts');
});

test('recall: logLocal=false suppresses the local row (risk-gate path)', async () => {
  const home = tmpHome();
  const captured = {};
  await withStubbedFetch(captured, () => recall('deploy', { cwd: '/x', session: 'sess-2', logLocal: false }, home));
  assert.equal(readActivity(home).filter((e) => e.op === 'recall').length, 0);
});
