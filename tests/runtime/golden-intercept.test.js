#!/usr/bin/env node
'use strict';

/**
 * golden-intercept.test.js — byte-for-byte snapshot of the passive pipeline.
 *
 * Written BEFORE the session-holdout experiment and the Bayesian confidence work
 * (docs/specs/2026-09-25-hint-lift-and-bayesian-confidence.md §5). Both touch the
 * hottest path in the engine — rerank, the confidence gate, formatPoints, the
 * `surfaced` predicate that drives recordSurface — and the spec's hard constraint
 * is that with default config every surfaced hint, rank and payload decision is
 * identical to today. Unit tests of each gate cannot prove that; a snapshot of the
 * whole interceptWithMeta output for a fixed candidate set can.
 *
 * Determinism:
 *   - search, embedding, graph edges, point fetches and the brain filter are
 *     stubbed through the module-property seams experience-core already calls;
 *   - Date.now is pinned (recency penalties, noise suppression windows, session
 *     expiry all read it);
 *   - HOME, TMPDIR (session track dir), the activity log and the config path are
 *     isolated temp dirs, and every EXPERIENCE_* env var is cleared, so neither
 *     the operator's ~/.experience nor a CI env var can leak in.
 *
 * Captured per scenario: suggestions, surfacedIds, route, and the recordSurface /
 * incrementIgnoreCount side effects (the writers the control arm must skip).
 *
 * Regenerate ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test tests/runtime/golden-intercept.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Isolation: must run before any runtime module is required ---------------
for (const key of Object.keys(process.env)) {
  if (key.startsWith('EXPERIENCE_') || key === 'EXP_USER') delete process.env[key];
}
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-golden-'));
const TEST_TMP = path.join(TEST_HOME, 'tmp');
fs.mkdirSync(TEST_TMP, { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.TMPDIR = TEST_TMP;
process.env.TEMP = TEST_TMP;
process.env.TMP = TEST_TMP;
process.env.EXPERIENCE_ACTIVITY_LOG = path.join(TEST_HOME, 'activity.jsonl');
const CONFIG_PATH = path.join(TEST_HOME, '.experience', 'config.json');
process.env.EXPERIENCE_CONFIG_PATH = CONFIG_PATH;
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

const FIXED_NOW = Date.parse('2026-09-01T12:00:00.000Z');
const REAL_DATE_NOW = Date.now;
Date.now = () => FIXED_NOW;

const SRC = path.join(__dirname, '..', '..', '.experience', 'src');
const core = require(path.join(__dirname, '..', '..', '.experience', 'experience-core.js'));
const _config = require(path.join(SRC, 'config.js'));
const _embedding = require(path.join(SRC, 'embedding.js'));
const _qdrant = require(path.join(SRC, 'qdrant.js'));
const _graph = require(path.join(SRC, 'graph.js'));
const _hittrack = require(path.join(SRC, 'hittrack.js'));
const _brainllm = require(path.join(SRC, 'brain-llm.js'));
const _router = require(path.join(SRC, 'router.js'));

const SNAPSHOT_PATH = path.join(__dirname, 'golden', 'intercept.snapshot.json');
const SESSION_DIR = path.join(TEST_TMP, 'experience-session');

// --- Fixture corpus ------------------------------------------------------------
const iso = (daysAgo) => new Date(FIXED_NOW - daysAgo * 86400000).toISOString();

function point(id, score, data) {
  return {
    id,
    score,
    payload: {
      json: JSON.stringify({
        id,
        trigger: `trigger for ${id}`,
        question: `question for ${id}`,
        solution: `solution for ${id}`,
        confidence: 0.7,
        hitCount: 0,
        validatedCount: 0,
        surfaceCount: 0,
        ignoreCount: 0,
        signalVersion: 2,
        createdAt: iso(40),
        createdFrom: 'session-extractor',
        ...data,
      }),
    },
  };
}

// Ids are full UUID-shaped strings so the 8-char [id:] markers are unique.
const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const CORPUS = {
  'experience-principles': [
    point(ID(101), 0.82, { tier: 0, createdFrom: 'seed-common-doc', confidence: 0.8, scope: { lang: 'all' }, principle: 'Validate inputs at the boundary.' }),
    point(ID(102), 0.79, { tier: 0, confidence: 0.3, ignoreCount: 4, surfaceCount: 10 }),
    point(ID(103), 0.9, { tier: 0, confidence: 0.9, superseded: true }),
    point(ID(104), 0.61, { tier: 0, confidence: 0.75, hitCount: 3, validatedCount: 3, surfaceCount: 9, lastHitAt: iso(2), confirmedAt: [iso(2)] }),
  ],
  'experience-behavioral': [
    point(ID(201), 0.78, { tier: 1, confidence: 0.85, hitCount: 5, validatedCount: 5, surfaceCount: 12, lastHitAt: iso(3), confirmedAt: [iso(3)], scope: { lang: 'typescript', project_slug: 'golden-app' }, _projectSlug: 'golden-app', domain: 'TypeScript', conditions: { toolMatch: ['Edit'] }, why: 'Handlers crashed on undefined bodies.' }),
    point(ID(202), 0.83, { tier: 1, confidence: 0.9, scope: { lang: 'c#' }, domain: 'C#' }),
    point(ID(203), 0.88, { tier: 1, confidence: 0.7, ignoreCount: 25, hitCount: 0, surfaceCount: 30, scope: { lang: 'typescript' } }),
    point(ID(204), 0.86, { tier: 1, confidence: 0.7, irrelevantCount: 3, surfaceCount: 6, scope: { lang: 'typescript' } }),
    point(ID(205), 0.84, { tier: 1, confidence: 0.8, hitCount: 1, validatedCount: 1, lastHitAt: iso(60), noiseReasonCounts: { stale_rule: 1 }, scope: { lang: 'typescript' } }),
    point(ID(206), 0.35, { tier: 1, confidence: 0.8, hitCount: 2, validatedCount: 2, scope: { lang: 'typescript' }, _projectSlug: 'golden-app' }),
    point(ID(207), 0.74, { tier: 1, confidence: 0.7, hitCount: 2, validatedCount: 2, surfaceCount: 8, ignoreCount: 1, lastHitAt: iso(45), scope: { lang: 'typescript', project_slug: 'golden-app' }, _projectSlug: 'golden-app', solution: 'BRAIN-DROP solution for the brain filter stub' }),
    point(ID(208), 0.71, { tier: 1, createdFrom: 'bulk-seed', confidence: 0.65, scope: { lang: 'typescript' }, conditions: ['migration', 'config'] }),
  ],
  'experience-selfqa': [
    point(ID(301), 0.7, { tier: 2, confidence: 0.3, hitCount: 0, surfaceCount: 4, scope: { lang: 'typescript' } }),
    point(ID(302), 0.66, { tier: 2, confidence: 0.6, hitCount: 1, validatedCount: 1, surfaceCount: 3, scope: { lang: 'typescript', project_slug: 'golden-app' }, _projectSlug: 'golden-app' }),
    point(ID(303), 0.8, { tier: 2, confidence: 0.8, scope: { lang: 'typescript', project_slug: 'other-app' }, _projectSlug: 'other-app' }),
    point(ID(304), 0.64, { tier: 2, confidence: 0.55, ignoreCount: 2, surfaceCount: 4, hitCount: 0, scope: { lang: 'typescript' } }),
  ],
};

// Graph neighbour reachable from 201 via a relates-to edge; fetched by id.
const GRAPH_ONLY = point(ID(401), 0.5, { tier: 2, confidence: 0.8, hitCount: 2, validatedCount: 2, scope: { lang: 'typescript' } });
const EDGES = {
  [ID(201)]: [{ source: ID(201), target: ID(401), type: 'relates-to', weight: 0.9 }],
  [ID(104)]: [{ source: ID(104), target: ID(103), type: 'supersedes', weight: 1 }],
  [ID(103)]: [{ source: ID(104), target: ID(103), type: 'supersedes', weight: 1 }],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

// --- Scenarios -----------------------------------------------------------------
const TS_FILE = '/home/dev/golden-app/src/server.ts';
const TS_META = (session) => ({ sourceKind: 'claude-hook', sourceRuntime: 'claude-code', ...(session ? { sourceSession: session } : {}), lang: 'typescript', project_slug: 'golden-app', cwd: '/home/dev/golden-app' });

const SCENARIOS = [
  { name: 'edit-ts-first', tool: 'Edit', input: { file_path: TS_FILE, old_string: 'a', new_string: 'b' }, meta: TS_META('golden-s1') },
  { name: 'edit-ts-repeat', tool: 'Edit', input: { file_path: TS_FILE, old_string: 'a', new_string: 'b' }, meta: TS_META('golden-s1') },
  { name: 'edit-ts-third', tool: 'Edit', input: { file_path: TS_FILE, old_string: 'a', new_string: 'b' }, meta: TS_META('golden-s1') },
  { name: 'bash-npm-test', tool: 'Bash', input: { command: 'npm test -- server' }, meta: TS_META('golden-s2') },
  { name: 'codex-prompt', tool: 'UserPrompt', input: { command: 'plan the server config migration for golden-app', _promptHook: true }, meta: { sourceKind: 'codex-hook', sourceRuntime: 'codex-wsl', sourceSession: 'golden-s3', lang: 'typescript', project_slug: 'golden-app' } },
  { name: 'claude-prompt', tool: 'UserPrompt', input: { command: 'plan the server config migration for golden-app', _promptHook: true }, meta: TS_META('golden-s3b') },
  { name: 'posttool-batch', tool: 'PostToolBatch', input: { command: 'Edit: /home/dev/golden-app/src/server.ts | Bash: npm test', file_path: TS_FILE, batchSize: 2 }, meta: { sourceKind: 'hook-batch', sourceRuntime: 'claude-code', sourceSession: 'golden-s4', lang: 'typescript', project_slug: 'golden-app' }, options: { skipRoute: true } },
  { name: 'edit-no-session', tool: 'Edit', input: { file_path: TS_FILE, old_string: 'x', new_string: 'y' }, meta: TS_META(null) },
  { name: 'recall', tool: 'UserPrompt', input: { command: 'server config migration', _promptHook: true }, meta: { sourceKind: 'manual-api', sourceRuntime: 'api', sourceSession: 'golden-s5', lang: 'typescript', project_slug: 'golden-app' }, options: { recallMode: true } },
  { name: 'fast', tool: 'Edit', input: { file_path: TS_FILE, old_string: 'p', new_string: 'q' }, meta: TS_META('golden-s6'), options: { fast: true } },
  { name: 'read-only', tool: 'Bash', input: { command: 'ls -la' }, meta: TS_META('golden-s7') },
];

// --- Harness -------------------------------------------------------------------
let calls = null;

function installStubs() {
  _embedding.getEmbedding = async () => [0.1, 0.2, 0.3, 0.4];
  _qdrant.searchCollection = async (name) => clone(CORPUS[name] || []);
  _qdrant.searchCollectionSparse = async () => [];
  _qdrant.searchCollectionLexical = async () => [];
  _qdrant.fetchPointById = async (collection, id) => (collection === 'experience-selfqa' && id === ID(401) ? clone(GRAPH_ONLY) : null);
  _graph.getEdgesForId = (id) => clone(EDGES[id] || []);
  _router.isRouterEnabled = () => false;
  _hittrack.recordSurface = async (collection, id) => { calls.recordSurface.push([collection, id]); };
  _hittrack.incrementIgnoreCount = async (collection, id) => { calls.incrementIgnoreCount.push([collection, id]); };
  _brainllm.brainRelevanceFilter = async (_query, lines) => {
    calls.brainFilter++;
    const kept = lines.filter((line) => !line.includes('BRAIN-DROP'));
    return kept.length === lines.length ? null : kept;
  };
}

function resetState(configExtra) {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...configExtra }, null, 2));
  _config.refreshConfig();
}

/**
 * Run every scenario in order (session dedupe makes order significant) and
 * return a JSON-safe record. Exported shape is what the snapshot pins.
 */
async function runScenarios(configExtra = {}) {
  resetState(configExtra);
  const out = {};
  for (const sc of SCENARIOS) {
    calls = { recordSurface: [], incrementIgnoreCount: [], brainFilter: 0 };
    const result = await core.interceptWithMeta(sc.tool, clone(sc.input), undefined, clone(sc.meta), sc.options ? { ...sc.options } : undefined);
    // Let the fire-and-forget Promise.all side effects settle.
    await new Promise((resolve) => setImmediate(resolve));
    out[sc.name] = {
      result: result === null ? null : clone(result),
      recordSurface: calls.recordSurface,
      incrementIgnoreCount: calls.incrementIgnoreCount,
      brainFilterCalls: calls.brainFilter,
    };
  }
  return out;
}

test.before(() => { installStubs(); });

test.after(() => {
  Date.now = REAL_DATE_NOW;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* temp dir */ }
});

test('golden: interceptWithMeta output with default config matches the snapshot', async () => {
  const actual = await runScenarios({});
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + '\n');
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.deepStrictEqual(actual, expected);
});

test('golden: the fixture exercises the gates it is meant to pin', () => {
  // Guards the snapshot against silently degenerating (e.g. a stub that stops
  // matching and every scenario returning null would still be "identical").
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const first = snap['edit-ts-first'];
  assert.ok(first.result && typeof first.result.suggestions === 'string', 'first edit surfaces hints');
  assert.ok(first.result.surfacedIds.length >= 2, 'several entries surface');
  assert.ok(first.recordSurface.length >= 2, 'recordSurface fires');
  assert.ok(snap['edit-ts-third'].incrementIgnoreCount.length > 0, 'session-repeat flag fires by the third repeat');
  assert.equal(snap['read-only'].result.suggestions, null);
  assert.ok(snap.recall.result.surfacedIds.length > 0, 'recall path surfaces');
  assert.ok(/Probationary Suggestion/.test(JSON.stringify(snap)), 'a probationary T2 entry surfaces somewhere');
  assert.ok(!JSON.stringify(snap).includes(ID(103).slice(0, 8) + ' col'), 'superseded entry never shown');
});

