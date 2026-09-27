#!/usr/bin/env node
'use strict';

/**
 * router-history.test.js — the routing learning loop, end to end on the FileStore.
 *
 * Measured 2026-09-27: experience-routes held 263 decisions and 0 outcomes. muonroi-cli
 * routes locally, so every route-feedback carried a taskHash EE had never stored and
 * updated nothing. routeFeedback now records such a decision with its outcome, and
 * routeHistory turns recorded outcomes into advice without an LLM call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '.experience', 'src');
const MODULES = ['router.js', 'qdrant.js', 'config.js', 'embedding.js'].map((f) => path.join(SRC, f));

// Tasks that should count as "similar" share a direction; unrelated ones do not.
const VECTORS = {
  migrate: [1, 0, 0, 0, 0],
  unrelated: [0, 0, 0, 0, 1],
};
function vectorFor(text) {
  return text.includes('migrate') ? VECTORS.migrate : VECTORS.unrelated;
}

let testHome;

function loadRouter() {
  for (const p of MODULES) delete require.cache[require.resolve(p)];
  const embedding = require(path.join(SRC, 'embedding.js'));
  // router.js destructures getEmbedding at load, so the stub must be in place first.
  embedding.getEmbedding = async (text) => vectorFor(String(text));
  return require(path.join(SRC, 'router.js'));
}

test.beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-router-history-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
  // Unreachable Qdrant: the FileStore is the store under test.
  fs.writeFileSync(path.join(testHome, '.experience', 'config.json'),
    JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1', embedDim: 5, routing: true }));
});

test.afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('feedback for a decision EE never stored is recorded when the task is sent', async () => {
  const router = loadRouter();
  const ok = await router.routeFeedback('hash-local-1', 'fast', 'm-fast', 'fail', 0, 1200, 'migrate the ledger to event sourcing');
  assert.equal(ok, true);
  const advice = await router.routeHistory('migrate the billing ledger');
  assert.equal(advice.matches, 1);
  assert.equal(advice.floorTier, 'balanced', 'a failure on fast must put the floor one tier up');
  assert.equal(advice.suggestedTier, null);
});

test('feedback without the task text still cannot invent a decision', async () => {
  const router = loadRouter();
  const ok = await router.routeFeedback('hash-local-2', 'fast', 'm-fast', 'success', 0, 900);
  assert.equal(ok, false);
  const advice = await router.routeHistory('migrate the billing ledger');
  assert.equal(advice.matches, 0);
});

test('history suggests the lowest tier that succeeded above every failure', async () => {
  const router = loadRouter();
  await router.routeFeedback('h-a', 'fast', 'm', 'fail', 0, 1, 'migrate schema A');
  await router.routeFeedback('h-b', 'balanced', 'm', 'success', 0, 1, 'migrate schema B');
  await router.routeFeedback('h-c', 'premium', 'm', 'success', 0, 1, 'migrate schema C');
  const advice = await router.routeHistory('migrate schema D');
  assert.equal(advice.matches, 3);
  assert.equal(advice.floorTier, 'balanced');
  assert.equal(advice.suggestedTier, 'balanced');
});

test('repeated retries count as a failure of that tier', async () => {
  const router = loadRouter();
  await router.routeFeedback('h-r', 'balanced', 'm', 'success', 2, 1, 'migrate schema R');
  const advice = await router.routeHistory('migrate schema S');
  assert.equal(advice.floorTier, 'premium');
});

test('unrelated tasks give no advice', async () => {
  const router = loadRouter();
  await router.routeFeedback('h-x', 'fast', 'm', 'fail', 0, 1, 'migrate schema X');
  const advice = await router.routeHistory('write a haiku about rain');
  assert.deepEqual({ floorTier: advice.floorTier, suggestedTier: advice.suggestedTier, matches: advice.matches },
    { floorTier: null, suggestedTier: null, matches: 0 });
});
