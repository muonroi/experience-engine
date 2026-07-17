#!/usr/bin/env node
'use strict';

/**
 * server-projects.test.js — GET /api/projects, the slug directory.
 *
 * An agent calling ee_query/ee_write has to put SOMETHING in `project`, and
 * until this endpoint existed it could only guess. Guessing is not harmless:
 * the live brain holds 30 distinct slugs of which a third are canonicalization
 * debris from a bad cwd (`.gemini`, `e:/tiennv`, `c:/users`, `tmp`, `any`), so
 * "the obvious slug" and "a slug that matches stored entries" are different
 * strings. A wrong guess silently drops the project-scoped entries — the most
 * specific ones — and looks identical to "the brain knows nothing".
 *
 * The load-bearing detail these tests pin: the filterable field is the FLAT
 * top-level `scope_project_slug`. The nested experience.scope.project_slug lives
 * inside the `json` payload STRING and is invisible to Qdrant filters. Aggregate
 * the nested one and the endpoint reports zero slugs against a brain that has 30.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { collectProjectSlugs, _resetProjectsCache } = require(path.join(__dirname, '..', 'server.js'));

function pt(slug) {
  const payload = { json: '{}', text_search: 'x' };
  if (slug !== null) payload.scope_project_slug = slug;
  return { id: `id-${Math.random()}`, payload };
}

/** Stand in for qdrant.scrollCollection: collection name -> points. */
function scroller(byCollection) {
  return async (name) => byCollection[name] || [];
}

test('collectProjectSlugs: counts the FLAT scope_project_slug, per collection and total', async () => {
  const scroll = scroller({
    'experience-behavioral': [pt('muonroi-cli'), pt('muonroi-cli'), pt('experience-engine')],
    'experience-principles': [pt('experience-engine')],
    'experience-selfqa': [pt('storyflow')],
  });
  const out = await collectProjectSlugs({ scroll });

  assert.equal(out.total, 5);
  assert.equal(out.unscoped, 0);
  // Sorted by count desc, so the agent reads the most-populated slug first.
  assert.deepEqual(out.projects.map((p) => p.slug), ['experience-engine', 'muonroi-cli', 'storyflow']);
  const ee = out.projects.find((p) => p.slug === 'experience-engine');
  assert.equal(ee.count, 2);
  assert.deepEqual(ee.collections, { 'experience-behavioral': 1, 'experience-principles': 1 });
});

test('collectProjectSlugs: unscoped points are counted apart, never as a slug', async () => {
  // 147 of the live brain's 557 points carry no slug. They are recallable from
  // every project, so reporting them as a project named "(unscoped)" would invite
  // an agent to pass that as a real value.
  const scroll = scroller({
    'experience-behavioral': [pt(null), pt(null), pt('muonroi-cli')],
    'experience-principles': [pt(null)],
    'experience-selfqa': [],
  });
  const out = await collectProjectSlugs({ scroll });

  assert.equal(out.unscoped, 3);
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].slug, 'muonroi-cli');
});

test('collectProjectSlugs: ignores the nested scope.project_slug inside the json string', async () => {
  // The regression that nearly shipped: aggregating experience.scope.project_slug
  // reports 0 slugs for a brain full of them, because that field is a substring
  // of an opaque payload string, not a payload field.
  const nestedOnly = {
    id: 'nested',
    payload: { json: JSON.stringify({ scope: { project_slug: 'muonroi-cli' } }), text_search: 'x' },
  };
  const out = await collectProjectSlugs({ scroll: scroller({ 'experience-behavioral': [nestedOnly] }) });

  assert.equal(out.projects.length, 0, 'a nested-only slug is not filterable and must not be advertised');
  assert.equal(out.unscoped, 1);
});

test('collectProjectSlugs: a blank or non-string slug is unscoped, not a slug', async () => {
  const scroll = scroller({
    'experience-behavioral': [pt(''), pt('   '), pt(42), pt('ok')],
  });
  const out = await collectProjectSlugs({ scroll });
  assert.deepEqual(out.projects.map((p) => p.slug), ['ok']);
  assert.equal(out.unscoped, 3);
});

test('collectProjectSlugs: hitting the scroll limit is reported, not silently truncated', async () => {
  // scrollCollection does not paginate. Under-reporting counts while looking
  // complete is the failure this endpoint exists to prevent.
  const many = Array.from({ length: 5 }, () => pt('muonroi-cli'));
  const out = await collectProjectSlugs({ scroll: scroller({ 'experience-behavioral': many }), limit: 5 });
  assert.equal(out.truncated, true);

  const out2 = await collectProjectSlugs({ scroll: scroller({ 'experience-behavioral': many }), limit: 50 });
  assert.equal(out2.truncated, false);
});

test('collectProjectSlugs: one dead collection cannot take down the directory', async () => {
  const scroll = async (name) => {
    if (name === 'experience-selfqa') throw new Error('qdrant timeout');
    return [pt('muonroi-cli')];
  };
  const out = await collectProjectSlugs({ scroll });
  assert.equal(out.projects[0].slug, 'muonroi-cli');
  assert.deepEqual(out.failed, ['experience-selfqa'], 'a partial answer must say which collection is missing');
});

test('_resetProjectsCache is exported so tests never inherit a warm cache', () => {
  assert.equal(typeof _resetProjectsCache, 'function');
  _resetProjectsCache();
});
