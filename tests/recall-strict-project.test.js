'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_') || key === 'EXP_USER') delete process.env[key];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-strict-recall-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EXPERIENCE_ACTIVITY_LOG = path.join(home, 'activity.jsonl');
process.env.EXPERIENCE_CONFIG_PATH = path.join(home, '.experience', 'config.json');
fs.mkdirSync(path.join(home, '.experience'), { recursive: true });
fs.writeFileSync(process.env.EXPERIENCE_CONFIG_PATH, JSON.stringify({
  server: { authToken: 'strict-test-token' }, org: { repoPatterns: ['repo-a', 'repo-b'] },
}));

const embedding = require('../.experience/src/embedding');
const qdrant = require('../.experience/src/qdrant');
const graph = require('../.experience/src/graph');
const router = require('../.experience/src/router');
const hittrack = require('../.experience/src/hittrack');
const core = require('../.experience/experience-core');
const { handleRecall } = require('../api/handlers/knowledge');
let points = [];
let graphPoints = [];
let surfaces = [];
let searches = [];
embedding.getEmbedding = async () => [0.1, 0.2, 0.3];
qdrant.searchCollection = async (collection, vector, topK, signal, filter) => {
  searches.push(filter);
  return collection === 'experience-behavioral' ? structuredClone(points) : [];
};
qdrant.searchCollectionSparse = async () => [];
qdrant.searchCollectionLexical = async () => [];
qdrant.fetchPointById = async (collection, id) => collection === 'experience-behavioral'
  ? structuredClone(graphPoints.find(p => p.id === id) || null) : null;
graph.getEdgesForId = id => id === points[0]?.id
  ? graphPoints.map(p => ({ source: id, target: p.id, weight: 1, type: 'related' })) : [];
router.isRouterEnabled = () => false;
hittrack.recordSurface = async (collection, id) => { surfaces.push(id); };

function point(n, project, extra = {}) {
  return { id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`, score: 0.95,
    _collection: 'experience-behavioral', payload: { json: JSON.stringify({
      solution: `LESSON_${n}`, confidence: 0.99, hitCount: 10,
      ...(project !== undefined ? { scope: { project_slug: project } } : {}), ...extra,
    }) } };
}
function reset() { points = []; graphPoints = []; surfaces = []; searches = []; }
async function recall(project, strictProject = true) {
  return core.interceptWithMeta('UserPrompt', { command: 'runtime conventions', _promptHook: true }, undefined,
    { project_slug: project }, { recallMode: true, strictProject, fast: true });
}
async function http(body, token = 'strict-test-token') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { authorization: `Bearer ${token}` };
  let status, output;
  const res = { writeHead(code) { status = code; }, end(raw) { output = JSON.parse(raw); } };
  await handleRecall(req, res);
  return { status, body: output };
}

test('strict recall filters foreign, global, missing, conflicting and malformed projects before formatting/surfacing', async () => {
  reset();
  points = [point(1, 'repo-a'), point(2, 'repo-b'), point(3, 'any'), point(4, undefined),
    point(5, 'repo-a'), point(6, undefined, { _projectSlug: 'repo-a' }), point(7, undefined)];
  points[4].payload.scope_project_slug = 'repo-b';
  points[6].payload.json = '{broken';
  const result = await recall('repo-a');
  assert.match(result.suggestions || '', /LESSON_1/);
  assert.match(result.suggestions || '', /LESSON_6/);
  for (const n of [2, 3, 4, 5, 7]) assert.doesNotMatch(result.suggestions || '', new RegExp(`LESSON_${n}`));
  assert.deepEqual(new Set(surfaces), new Set([points[0].id, points[5].id]));
  assert.deepEqual(new Set(result.surfacedIds.map(p => p.id)), new Set(surfaces));
});

test('strict recall protects graph expansion and contrast project queries', async () => {
  reset(); points = [point(10, 'repo-a'), point(11, 'repo-b')];
  graphPoints = [point(12, 'repo-b'), point(13, 'repo-a')];
  const a = await recall('repo-a');
  assert.match(a.suggestions || '', /LESSON_10/);
  assert.match(a.suggestions || '', /LESSON_13/);
  assert.doesNotMatch(a.suggestions || '', /LESSON_11|LESSON_12/);
  const b = await recall('repo-b');
  assert.match(b.suggestions || '', /LESSON_11/);
  assert.doesNotMatch(b.suggestions || '', /LESSON_10|LESSON_13/);
});

test('legacy broad recall is unchanged; strict recall without a project fails closed', async () => {
  reset(); points = [point(20, 'repo-a'), point(21, 'repo-b'), point(22, undefined)];
  const broad = await recall('repo-a', false);
  assert.match(broad.suggestions || '', /LESSON_21/);
  assert.match(broad.suggestions || '', /LESSON_22/);
  const strict = await recall(undefined);
  assert.equal(strict.suggestions, null);
  assert.deepEqual(strict.surfacedIds, []);
});

test('strict HTTP recall validates scope and returns proof only for enforced project filtering', async () => {
  reset(); points = [point(30, 'repo-a'), point(31, 'repo-b')];
  const a = await http({ query: 'conventions', project_slug: 'repo-a', strict_project: true });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.scope, { strict: true, project: 'repo-a', policy: 'project-only' });
  assert.match(a.body.text || '', /LESSON_30/);
  assert.doesNotMatch(a.body.text || '', /LESSON_31/);
  const cwd = 'D:\\sources\\repo-a\\';
  const byCwd = await http({ query: 'conventions', cwd, strict_project: true });
  assert.equal(byCwd.status, 200);
  assert.equal(byCwd.body.scope.cwd, cwd);
  assert.equal(byCwd.body.scope.project, 'repo-a');
  for (const body of [
    { strict_project: 'true', project_slug: 'repo-a' }, { strict_project: true },
    { strict_project: true, project_slug: 'any' }, { strict_project: true, project_slug: '*' },
    { strict_project: true, project_slug: [] }, { strict_project: true, cwd: 42 },
    { strict_project: true, cwd: '/unresolved' },
  ]) {
    const invalid = await http({ query: 'conventions', ...body });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.scope, undefined);
  }
  const broad = await http({ query: 'conventions' });
  assert.equal(broad.body.scope, undefined);
  assert.match(broad.body.text || '', /LESSON_31/);
  assert.equal((await http({ query: 'conventions', strict_project: true, project_slug: 'repo-a' }, 'wrong')).status, 401);
});

test('strict HTTP recall resolves an unregistered client repository and isolates it from registered parents', async () => {
  reset(); points = [point(70, 'new-repository'), point(71, 'repo-a'), point(72, undefined)];
  const body = { query: 'conventions', strict_project: true, cwd: 'D:/repo-a/new-repository/src', repository: { root: 'D:/repo-a/new-repository', project: 'new-repository' } };
  const result = await http(body);
  assert.equal(result.status, 200);
  assert.equal(result.body.scope.project, 'new-repository');
  assert.deepEqual(result.body.scope.repository,{root:'D:/repo-a/new-repository',project:'new-repository'});
  assert.match(result.body.text || '', /LESSON_70/);
  assert.doesNotMatch(result.body.text || '', /LESSON_71|LESSON_72/);
  const empty = await http({ ...body, repository: { ...body.repository, project: 'never-registered-empty' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.count, 0);
  assert.equal(empty.body.scope.project, 'never-registered-empty');
  const explicit = await http({ ...body, project_slug:'repo-a' });
  assert.equal(explicit.body.scope.project,'repo-a');
  assert.match(explicit.body.text || '',/LESSON_71/);
  assert.doesNotMatch(explicit.body.text || '',/LESSON_70/);
  for (const repository of [null,{}, {root:'D:/other',project:'new-repository'}, {root:'relative',project:'new-repository'}]) {
    const rejected=await http({ ...body,repository });
    assert.equal(rejected.status,400);
    assert.equal(rejected.body.scope,undefined);
  }
});
