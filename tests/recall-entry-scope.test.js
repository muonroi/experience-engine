'use strict';

/**
 * recall-entry-scope.test.js — /api/recall forwards each hit's stored scope.
 *
 * Clients derive the noise reason host-side (muonroi-cli src/ee/noise-reason.ts
 * hintScopeOf reads entry.projectSlug, entry.scope.project_slug, entry.scope.lang)
 * so a noise verdict narrows a hint's scope (wrong_repo / wrong_language) instead
 * of deleting it (wrong_task). The core's surfaced meta already carries
 * projectSlug + scope; these tests pin that handleRecall forwards a whitelisted
 * {project_slug, lang} per entry, keeps {id, collection} unchanged, and never
 * forwards the rest of the stored payload or scope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

for (const key of Object.keys(process.env)) if (key.startsWith('EXPERIENCE_') || key === 'EXP_USER') delete process.env[key];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-recall-scope-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EXPERIENCE_ACTIVITY_LOG = path.join(home, 'activity.jsonl');
process.env.EXPERIENCE_CONFIG_PATH = path.join(home, '.experience', 'config.json');
fs.mkdirSync(path.join(home, '.experience'), { recursive: true });
fs.writeFileSync(process.env.EXPERIENCE_CONFIG_PATH, JSON.stringify({ server: { authToken: 'scope-test-token' } }));

const embedding = require('../.experience/src/embedding');
const qdrant = require('../.experience/src/qdrant');
const graph = require('../.experience/src/graph');
const router = require('../.experience/src/router');
const hittrack = require('../.experience/src/hittrack');
const { handleRecall, recallEntryOf } = require('../api/handlers/knowledge');

let points = [];
embedding.getEmbedding = async () => [0.1, 0.2, 0.3];
qdrant.searchCollection = async (collection) => (collection === 'experience-behavioral' ? structuredClone(points) : []);
qdrant.searchCollectionSparse = async () => [];
qdrant.searchCollectionLexical = async () => [];
qdrant.fetchPointById = async () => null;
graph.getEdgesForId = () => [];
router.isRouterEnabled = () => false;
hittrack.recordSurface = async () => {};

function point(n, data) {
  return {
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`,
    score: 0.95,
    _collection: 'experience-behavioral',
    payload: { json: JSON.stringify({ solution: `LESSON_${n}`, confidence: 0.99, hitCount: 10, ...data }) },
  };
}

async function recall(body, token = 'scope-test-token') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { authorization: `Bearer ${token}` };
  let status;
  let output;
  const res = { writeHead(code) { status = code; }, end(raw) { output = JSON.parse(raw); } };
  await handleRecall(req, res);
  return { status, body: output };
}

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('/api/recall entries carry projectSlug + whitelisted scope {project_slug, lang}', async () => {
  points = [
    point(1, {
      _projectSlug: 'legacy-slug',
      scope: {
        project_slug: 'storyflow', lang: 'csharp', framework: 'aspnet',
        lang_exclude: ['python'], project_exclude: ['other-repo'], filePattern: 'src/**',
      },
    }),
  ];
  const { status, body } = await recall({ query: 'runtime conventions', project_slug: 'muonroi-cli', fast: true });
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  const [entry] = body.entries;
  assert.equal(entry.id, points[0].id);
  assert.equal(entry.collection, 'experience-behavioral');
  // scope.project_slug is the source of truth (format.js buildStorePayload);
  // _projectSlug is only the legacy fallback.
  assert.equal(entry.projectSlug, 'storyflow');
  assert.deepEqual(entry.scope, { project_slug: 'storyflow', lang: 'csharp' });
  // Nothing else from the stored payload or scope leaks onto the wire.
  assert.deepEqual(Object.keys(entry).sort(), ['collection', 'id', 'projectSlug', 'scope']);
});

test('/api/recall entries fall back to legacy _projectSlug and null scope when unscoped', async () => {
  points = [point(2, { _projectSlug: 'experience-engine' }), point(3, {})];
  const { status, body } = await recall({ query: 'runtime conventions', fast: true });
  assert.equal(status, 200);
  const byId = Object.fromEntries(body.entries.map(e => [e.id, e]));
  assert.equal(byId[points[0].id].projectSlug, 'experience-engine');
  assert.deepEqual(byId[points[0].id].scope, { project_slug: 'experience-engine', lang: null });
  assert.equal(byId[points[1].id].projectSlug, null);
  assert.equal(byId[points[1].id].scope, null);
});

test('/api/recall response stays backward compatible: text/entries/count/query + id/collection', async () => {
  points = [point(4, { scope: { lang: 'typescript' } })];
  const { status, body } = await recall({ query: 'runtime conventions', fast: true });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['count', 'entries', 'query', 'text']);
  assert.equal(body.query, 'runtime conventions');
  assert.match(body.text, /LESSON_4/);
  assert.equal(body.count, body.entries.length);
  assert.equal(typeof body.entries[0].id, 'string');
  assert.equal(body.entries[0].collection, 'experience-behavioral');
  assert.deepEqual(body.entries[0].scope, { project_slug: null, lang: 'typescript' });
});

test('recallEntryOf: lang shapes — string, array, legacy joined string, non-string junk', () => {
  const base = { id: 'x', collection: 'experience-principles' };
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: 'python' } }).scope, { project_slug: null, lang: 'python' });
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: ['ts', 'js'] } }).scope, { project_slug: null, lang: ['ts', 'js'] });
  // Legacy comma/slash/pipe-joined seeds mean "any of" (experience-core fileMatchesLang).
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: 'typescript, javascript' } }).scope, { project_slug: null, lang: ['typescript', 'javascript'] });
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: 'c#/f#' } }).scope, { project_slug: null, lang: ['c#', 'f#'] });
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: 42, project_slug: { evil: true } } }), { ...base, projectSlug: null, scope: null });
  assert.deepEqual(recallEntryOf({ ...base, scope: { lang: ['go', 7, ''] } }).scope, { project_slug: null, lang: ['go'] });
});

test('recallEntryOf: tolerates malformed surface meta (core catch path has no scope)', () => {
  assert.deepEqual(recallEntryOf({ collection: 'experience-behavioral', id: 'abc', solution: null }),
    { id: 'abc', collection: 'experience-behavioral', projectSlug: null, scope: null });
  assert.deepEqual(recallEntryOf(null), { id: '', collection: null, projectSlug: null, scope: null });
  assert.deepEqual(recallEntryOf({ id: 7, collection: 'c', projectSlug: '  ', scope: 'nope' }),
    { id: '7', collection: 'c', projectSlug: null, scope: null });
});
