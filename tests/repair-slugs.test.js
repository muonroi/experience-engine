#!/usr/bin/env node
'use strict';

/**
 * repair-slugs.test.js — the slug re-labeller's decision + patch logic.
 *
 * The scroll/patch transport is exercised by the live dry-run; what must be
 * pinned here is that this tool can never DELETE knowledge and never invents a
 * pin. The entries behind the bogus slugs are good lessons (docker compose,
 * WSL git, SQL Server truncation) — only the label was wrong, so "unscope" is
 * the floor and deletion is not an option the tool has.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { classify, patchFor } = require(path.join(__dirname, '..', 'tools', 'exp-repair-slugs.js'));

test('classify: path-like slugs are unscoped, never deleted, never guessed', () => {
  for (const s of ['c:/users', 'd:/personal', 'e:/tiennv', 'home/muonroi', 'e:/rcms']) {
    const v = classify(s);
    assert.equal(v.action, 'unscope', `${s} must unscope`);
    assert.equal(v.to, null);
  }
});

test('classify: a runtime config dir is unscoped', () => {
  assert.equal(classify('.gemini').action, 'unscope');
  assert.equal(classify('.codex').action, 'unscope');
});

test('classify: only the explicitly-reviewed slugs are remapped', () => {
  assert.deepEqual(
    { action: classify('new').action, to: classify('new').to },
    { action: 'remap', to: 'eberth-planner' },
  );
  assert.equal(classify('core').to, 'muonroi');
});

test('classify: a real slug is left alone, and a global entry is skipped', () => {
  assert.equal(classify('muonroi-cli').action, 'keep');
  assert.equal(classify('experience-engine').action, 'keep');
  assert.equal(classify('storyflow_ui').action, 'keep');
  assert.equal(classify(null).action, 'skip');
});

test('classify: an unknown non-canonical slug unscopes rather than being guessed at', () => {
  // Guessing a pin is exactly what created this mess.
  assert.equal(classify('some/unseen/path').action, 'unscope');
});

function pointWith(scope, extra = {}) {
  return { id: 'p1', payload: { json: JSON.stringify({ scope, ...extra }), scope_project_slug: scope.project_slug } };
}

test('patchFor: writes the flat field AND the nested copy, and records the old label', () => {
  const patch = patchFor(pointWith({ project_slug: 'new', lang: 'typescript' }), 'eberth-planner');
  assert.equal(patch.scope_project_slug, 'eberth-planner');
  const exp = JSON.parse(patch.json);
  assert.equal(exp.scope.project_slug, 'eberth-planner');
  assert.equal(exp.scope.project_repaired_from, 'new', 'a repair that erases its input cannot be re-judged');
  assert.equal(exp.scope.lang, 'typescript', 'unrelated scope must survive');
});

test('patchFor: unscoping REMOVES project_slug rather than writing null', () => {
  // applyScopeFilter tests `exp.scope?.project_slug` for presence; a literal
  // null is falsy so it would work, but leaving the key invites a later reader
  // to treat "null" as a value. Remove it.
  const patch = patchFor(pointWith({ project_slug: 'c:/users' }), null);
  assert.equal(patch.scope_project_slug, null);
  const exp = JSON.parse(patch.json);
  assert.equal('project_slug' in exp.scope, false);
  assert.equal(exp.scope.project_repaired_from, 'c:/users');
});

test('patchFor: drops the legacy projectSlug alias that would out-vote the repair', () => {
  // applyScopeFilter reads `exp.scope?.project_slug || exp.scope?.projectSlug`,
  // so a stale alias left behind would silently win after we cleared the real one.
  const patch = patchFor(pointWith({ project_slug: 'c:/users', projectSlug: 'c:/users' }), null);
  const exp = JSON.parse(patch.json);
  assert.equal('projectSlug' in exp.scope, false);
});

test('patchFor: syncs the legacy root-level _projectSlug when present', () => {
  const p = pointWith({ project_slug: 'new' }, { _projectSlug: 'new' });
  const exp = JSON.parse(patchFor(p, 'eberth-planner').json);
  assert.equal(exp._projectSlug, 'eberth-planner');
});

test('patchFor: a malformed payload.json does not throw or lose the repair', () => {
  const broken = { id: 'p2', payload: { json: '{not json', scope_project_slug: 'c:/users' } };
  const patch = patchFor(broken, null);
  assert.equal(patch.scope_project_slug, null);
  assert.equal('project_slug' in JSON.parse(patch.json).scope, false);
});
