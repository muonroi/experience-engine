#!/usr/bin/env node
'use strict';

/**
 * memory-import.test.js — direct (non-LLM) curated-memory importer
 * (.experience/src/memory-import.js). Pure parse/map/id/scan logic + adapter-
 * registry extensibility. The store path (storeImportedExperience) hits
 * Qdrant/embeddings and is covered by the live dry-run/apply verification.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mi = require('../.experience/src/memory-import.js');

// --- parseFrontmatter ---

test('parseFrontmatter: full metadata block flattens type/node_type', () => {
  const raw = `---
name: feedback-test-gate
description: "User wants strict gate"
metadata:
  node_type: memory
  type: feedback
  originSessionId: abc-123
---

Body line one.
**Why:** because red is bad.`;
  const { frontmatter, body } = mi.parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'feedback-test-gate');
  assert.equal(frontmatter.description, 'User wants strict gate'); // quotes stripped
  assert.equal(frontmatter.type, 'feedback');
  assert.equal(frontmatter.node_type, 'memory');
  assert.match(body, /^Body line one\./);
});

test('parseFrontmatter: simplified top-level type', () => {
  const raw = `---
name: ref-x
type: reference
description: a pointer
---
See https://example.com`;
  const { frontmatter, body } = mi.parseFrontmatter(raw);
  assert.equal(frontmatter.type, 'reference');
  assert.equal(body, 'See https://example.com');
});

test('parseFrontmatter: no frontmatter → whole text is body', () => {
  const { frontmatter, body } = mi.parseFrontmatter('just text, no fm');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, 'just text, no fm');
});

test('extractWhy: pulls the **Why:** rationale', () => {
  assert.equal(mi.extractWhy('Do X.\n**Why:** it prevents Y.\n\nMore.'), 'it prevents Y.');
  assert.equal(mi.extractWhy('no why here'), null);
});

// --- stableId ---

test('stableId: deterministic + UUID-shaped + varies by inputs', () => {
  const a = mi.stableId('claude', 'muonroi-cli', 'feedback-x');
  const b = mi.stableId('claude', 'muonroi-cli', 'feedback-x');
  const c = mi.stableId('claude', 'muonroi-cli', 'feedback-y');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// --- mapMemoryToExperience routing ---

const rec = (over = {}) => ({ runtime: 'claude', name: 'n', type: 'feedback', description: 'desc', body: 'sol body', projectSlug: 'muonroi-cli', file: '/x.md', ...over });

test('map: feedback → T1 behavioral, conf 0.78, user-correction', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'feedback' }));
  assert.equal(m.tier, 1);
  assert.equal(m.collection, mi.BEHAVIORAL_COLLECTION);
  assert.equal(m.confidence, 0.78);
  assert.equal(m.qa.evidenceClass, 'user-correction');
  assert.equal(m.qa.trigger, 'desc');
  assert.equal(m.qa.solution, 'sol body');
  assert.deepEqual(m.qa.scope, { project_slug: 'muonroi-cli' });
});

test('map: project → T2 selfqa, conf 0.70', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'project' }));
  assert.equal(m.tier, 2);
  assert.equal(m.collection, mi.SELFQA_COLLECTION);
  assert.equal(m.confidence, 0.70);
});

test('map: user → skipped (null)', () => {
  assert.equal(mi.mapMemoryToExperience(rec({ type: 'user' })), null);
});

test('map: reference → skipped by default, imported with --include-reference', () => {
  assert.equal(mi.mapMemoryToExperience(rec({ type: 'reference' })), null);
  const m = mi.mapMemoryToExperience(rec({ type: 'reference' }), { includeReference: true });
  assert.equal(m.tier, 2);
  assert.equal(m.confidence, 0.55);
});

test('map: untyped note → treated as project-scoped lesson', () => {
  const m = mi.mapMemoryToExperience(rec({ type: null }));
  assert.equal(m.tier, 2);
});

test('map: same record → same stable id (upsert key)', () => {
  assert.equal(mi.mapMemoryToExperience(rec()).id, mi.mapMemoryToExperience(rec()).id);
});

// --- scanMemorySources over a temp Claude fixture ---

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-home-'));
  const mem = path.join(home, '.claude', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'feedback_a.md'), `---\nname: fb-a\ntype: feedback\ndescription: rule A\n---\nbody A`);
  fs.writeFileSync(path.join(mem, 'project_b.md'), `---\nname: pj-b\ntype: project\ndescription: ctx B\n---\nbody B`);
  fs.writeFileSync(path.join(mem, 'user_c.md'), `---\nname: us-c\ntype: user\ndescription: profile C\n---\nbody C`);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), `- index, must be excluded`);
  return home;
}

test('scan: claude adapter finds memory files, excludes MEMORY.md', () => {
  const home = makeFixture();
  try {
    const records = mi.scanMemorySources({ homeDir: home });
    const names = records.map((r) => r.name).sort();
    assert.deepEqual(names, ['fb-a', 'pj-b', 'us-c']); // MEMORY.md excluded
    const fb = records.find((r) => r.name === 'fb-a');
    assert.equal(fb.runtime, 'claude');
    assert.equal(fb.type, 'feedback');
    assert.equal(fb.body, 'body A');
    assert.equal(fb.projectSlug, 'testproj'); // fallback tail (no real dir on test host)
    assert.equal(typeof fb.mtimeMs, 'number');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan: end-to-end map skips user, keeps feedback+project', () => {
  const home = makeFixture();
  try {
    const records = mi.scanMemorySources({ homeDir: home });
    const mapped = records.map((r) => mi.mapMemoryToExperience(r)).filter(Boolean);
    const tiers = mapped.map((m) => m.tier).sort();
    assert.deepEqual(tiers, [1, 2]); // feedback→T1, project→T2, user dropped
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- adapter-registry extensibility ---

test('stub adapters (codex/gemini/antigravity) enumerate nothing', () => {
  for (const rt of ['codex', 'gemini', 'antigravity']) {
    const a = mi.ADAPTERS.find((x) => x.runtime === rt);
    assert.ok(a, `adapter registered: ${rt}`);
    assert.deepEqual(a.enumerate('/any'), []);
    assert.equal(a.parse('/any/file.md'), null);
  }
});

test('extensibility: a new adapter flows through scan + map unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-fake-'));
  const fakeDir = path.join(home, 'fakemem');
  fs.mkdirSync(fakeDir, { recursive: true });
  const f = path.join(fakeDir, 'note.md');
  fs.writeFileSync(f, 'irrelevant');
  const fakeAdapter = {
    runtime: 'fakerune',
    enumerate() { return [{ file: f, mtimeMs: 42 }]; },
    parse() { return { runtime: 'fakerune', name: 'fk', type: 'feedback', description: 'd', body: 'b', projectSlug: 'proj', file: f }; },
  };
  mi.ADAPTERS.push(fakeAdapter);
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['fakerune'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].runtime, 'fakerune');
    const m = mi.mapMemoryToExperience(records[0]);
    assert.equal(m.tier, 1); // runtime-agnostic mapping
    assert.equal(m.qa.solution, 'b');
  } finally {
    const idx = mi.ADAPTERS.indexOf(fakeAdapter);
    if (idx >= 0) mi.ADAPTERS.splice(idx, 1);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
