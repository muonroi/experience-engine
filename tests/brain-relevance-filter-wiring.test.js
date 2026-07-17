#!/usr/bin/env node
'use strict';

/**
 * brain-relevance-filter-wiring.test.js
 *
 * brainRelevanceFilter was DEAD IN PRODUCTION for ~8 weeks and nothing caught it.
 *
 * Commit 442dcd6 introduced the raw-action query on the same physical line as a
 * debug log:
 *
 *   console.error("[INTERCEPT] calling brainFilter with " + ...); const rawAction = toolInput?.command || ...;
 *   const brainQuery = rawAction.length > query.length ? rawAction.slice(0, 300) : query;
 *
 * Commit 3ba9b33 ("Removed all debug logs ... from production code") deleted that
 * line — taking the `const rawAction` declaration with it and leaving the
 * reference on the next line. Every call then threw
 * `ReferenceError: rawAction is not defined`, which the bare `catch {}` wrapping
 * the block swallowed whole. Recall kept returning results, so it looked healthy.
 *
 * Verified on the production VPS (2026-07-17) by instrumenting that catch:
 *   [PROBE] fastPath=false lines=28 brainFilter=true recallMode=true
 *   [PROBE-OUTER] CAUGHT: ReferenceError: rawAction is not defined
 *       at interceptWithMeta (.experience/experience-core.js:524:26)
 * and corroborated by activity.jsonl: across its ENTIRE history there is not one
 * `cost-call kind=brain source=brain-filter` row, though brain-llm.js logs one
 * unconditionally on every completed call.
 *
 * These tests pin the WIRING (the filter is actually reached and fed a real
 * query), which is what a bare catch can hide. The filter's own ranking
 * behaviour is brain-llm.js's business, not this file's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-brf-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
fs.mkdirSync(path.join(testHome, '.experience'), { recursive: true });
fs.writeFileSync(
  path.join(testHome, '.experience', 'config.json'),
  JSON.stringify({ brainFilter: true, embedDim: 4, qdrantUrl: 'http://127.0.0.1:1' }, null, 2),
);

const CORE = path.join(__dirname, '..', '.experience', 'experience-core.js');
const core = require(CORE);
const _embedding = require(path.join(__dirname, '..', '.experience', 'src', 'embedding.js'));
const _qdrant = require(path.join(__dirname, '..', '.experience', 'src', 'qdrant.js'));
const _brainllm = require(path.join(__dirname, '..', '.experience', 'src', 'brain-llm.js'));
const _format = require(path.join(__dirname, '..', '.experience', 'src', 'format.js'));
const _router = require(path.join(__dirname, '..', '.experience', 'src', 'router.js'));

// experience-core.js calls every collaborator as a module property
// (`_brainllm.brainRelevanceFilter(...)`), so the lookup happens at call time and
// swapping the export is a real seam — no loader tricks needed.
const real = {
  getEmbedding: _embedding.getEmbedding,
  searchCollection: _qdrant.searchCollection,
  brainRelevanceFilter: _brainllm.brainRelevanceFilter,
  formatPoints: _format.formatPoints,
  applyBudget: _format.applyBudget,
  isRouterEnabled: _router.isRouterEnabled,
};

let brainCalls = [];

test.beforeEach(() => {
  brainCalls = [];
  _embedding.getEmbedding = async () => [0.1, 0.2, 0.3, 0.4];
  _qdrant.searchCollection = async () => [];
  _router.isRouterEnabled = () => false;               // router I/O is not under test
  _format.formatPoints = () => ['do the thing [id:aaaaaaaa col:experience-behavioral]'];
  _format.applyBudget = (lines) => lines;
  _brainllm.brainRelevanceFilter = async (actionQuery, suggestionLines, signal, projectSlug) => {
    brainCalls.push({ actionQuery, suggestionLines, projectSlug });
    return null;                                        // null = keep all (fail-open)
  };
});

test.after(() => {
  Object.assign(_embedding, { getEmbedding: real.getEmbedding });
  Object.assign(_qdrant, { searchCollection: real.searchCollection });
  Object.assign(_brainllm, { brainRelevanceFilter: real.brainRelevanceFilter });
  Object.assign(_format, { formatPoints: real.formatPoints, applyBudget: real.applyBudget });
  Object.assign(_router, { isRouterEnabled: real.isRouterEnabled });
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* temp dir */ }
});

test('brainRelevanceFilter is actually reached when hints exist (regression: rawAction ReferenceError)', async () => {
  await core.interceptWithMeta('Bash', { command: 'git push --force origin main' }, undefined, {}, {});

  assert.equal(brainCalls.length, 1, 'the brain relevance filter must be invoked, not silently skipped');
  assert.equal(typeof brainCalls[0].actionQuery, 'string');
  assert.ok(brainCalls[0].actionQuery.length > 0, 'filter must receive a non-empty action query');
  assert.equal(brainCalls[0].suggestionLines.length, 1, 'filter must receive the formatted hint lines');
});

test('the raw command is preferred over the decorated query when it carries more detail', async () => {
  // buildQuery() decorates the action ("[tool:Bash] running command …"), which can
  // TRUNCATE a long command. rawAction exists so the filter judges relevance
  // against what the agent is really about to run.
  const longCommand = 'ssh deploy@host "cd /opt/app && ' + 'x'.repeat(400) + ' && systemctl restart app"';
  await core.interceptWithMeta('Bash', { command: longCommand }, undefined, {}, {});

  assert.equal(brainCalls.length, 1);
  const sent = brainCalls[0].actionQuery;
  assert.ok(sent.length <= 300, `raw action must be capped at 300 chars, got ${sent.length}`);
  assert.ok(longCommand.startsWith(sent), 'the capped query must be a prefix of the real command');
});

test('project slug is forwarded so the filter can reject other-project hints', async () => {
  await core.interceptWithMeta(
    'Bash',
    { command: 'git push --force origin main' },
    undefined,
    { project_slug: 'experience-engine' },
    {},
  );

  assert.equal(brainCalls.length, 1);
  assert.equal(brainCalls[0].projectSlug, 'experience-engine');
});

test('a throwing filter degrades to keeping all hints — it must never break intercept', async () => {
  _brainllm.brainRelevanceFilter = async () => { throw new Error('brain exploded'); };

  const result = await core.interceptWithMeta('Bash', { command: 'git push --force origin main' }, undefined, {}, {});

  assert.ok(result, 'intercept must still return a result when the filter throws');
  assert.match(
    String(result.suggestions || ''),
    /id:aaaaaaaa/,
    'hints must survive a failed filter (fail-open), not be dropped',
  );
});

test('fast path skips the filter entirely (latency-bound callers opt out)', async () => {
  await core.interceptWithMeta('Bash', { command: 'git push --force origin main' }, undefined, {}, { fast: true });
  assert.equal(brainCalls.length, 0, 'options.fast must skip the ~2s LLM rerank');
});
