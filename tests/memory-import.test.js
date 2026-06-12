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

// --- runbook import (§7: nodeKind + derivedFromId threading) ---

test('parseIdList: tolerates [a, b] / a, b / a b / empty', () => {
  assert.deepEqual(mi.parseIdList('[4c81b5ca, 1e5f095f]'), ['4c81b5ca', '1e5f095f']);
  assert.deepEqual(mi.parseIdList('4c81b5ca, 1e5f095f'), ['4c81b5ca', '1e5f095f']);
  assert.deepEqual(mi.parseIdList('4c81b5ca 1e5f095f'), ['4c81b5ca', '1e5f095f']);
  assert.equal(mi.parseIdList(''), null);
  assert.equal(mi.parseIdList(undefined), null);
});

test('map: runbook record threads nodeKind + derivedFromId into qa', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'project', nodeKind: 'runbook', derivedFromId: ['4c81b5ca', '1e5f095f'] }));
  assert.equal(m.qa.nodeKind, 'runbook');
  assert.deepEqual(m.qa.derivedFromId, ['4c81b5ca', '1e5f095f']);
  // collection routing is unchanged — nodeKind is orthogonal to type→tier.
  assert.equal(m.collection, mi.SELFQA_COLLECTION);
});

test('map: ordinary record leaves nodeKind/derivedFromId null', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'project' }));
  assert.equal(m.qa.nodeKind, null);
  assert.equal(m.qa.derivedFromId, null);
});

test('claudeAdapter.parse: reads metadata.node_type=runbook + derivedFromId from frontmatter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-runbook-'));
  const memDir = path.join(dir, 'D--sources-Core-storyflow', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const file = path.join(memDir, 'post-donor-enrich-runbook.md');
  fs.writeFileSync(file, [
    '---',
    'name: post-donor-enrich-runbook',
    'description: storyflow post-donor enrich procedure',
    'metadata:',
    '  type: project',
    '  node_type: runbook',
    '  derivedFromId: [4c81b5ca, 1e5f095f]',
    '---',
    '',
    '1) enrich. 2) gap census. 3) relaunch container.',
  ].join('\n'));
  const r = mi.claudeAdapter.parse(file);
  assert.equal(r.nodeKind, 'runbook');
  assert.deepEqual(r.derivedFromId, ['4c81b5ca', '1e5f095f']);
  assert.equal(r.type, 'project');
  fs.rmSync(dir, { recursive: true, force: true });
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

// --- solution cap ---

test('map: oversized body → solution capped with truncation marker', () => {
  const big = 'x'.repeat(mi.MAX_SOLUTION_CHARS + 2000);
  const m = mi.mapMemoryToExperience(rec({ type: 'feedback', body: big }));
  assert.ok(m.qa.solution.length < big.length);
  assert.ok(m.qa.solution.startsWith('x'.repeat(mi.MAX_SOLUTION_CHARS)));
  assert.match(m.qa.solution, /truncated 2000 chars on import/);
});

test('map: short body → solution untouched (no marker)', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'feedback', body: 'short body' }));
  assert.equal(m.qa.solution, 'short body');
});

// --- status-dump guard ---

test('map: large project note, no Why/How-to → skipped as status dump', () => {
  const dump = 'status '.repeat(mi.REFERENCE_DUMP_CHARS); // >> threshold, no **Why:**
  assert.equal(mi.mapMemoryToExperience(rec({ type: 'project', body: dump })), null);
});

test('map: large project note WITH **Why:** → kept (capped, not skipped)', () => {
  const dump = `${'finding. '.repeat(mi.REFERENCE_DUMP_CHARS)}\n\n**Why:** real rationale`;
  const m = mi.mapMemoryToExperience(rec({ type: 'project', body: dump }));
  assert.ok(m, 'why-bearing note must be kept');
  assert.equal(m.tier, 2);
  assert.equal(m.qa.why, 'real rationale');
});

test('map: large project dump kept with --include-reference', () => {
  const dump = 'status '.repeat(mi.REFERENCE_DUMP_CHARS);
  const m = mi.mapMemoryToExperience(rec({ type: 'project', body: dump }), { includeReference: true });
  assert.ok(m);
});

// --- canonical slug / global scope ---

test('isCanonicalSlug: real slug yes, path-like / single-char no', () => {
  assert.equal(mi.isCanonicalSlug('muonroi-cli'), true);
  assert.equal(mi.isCanonicalSlug('storyflow'), true);
  assert.equal(mi.isCanonicalSlug('d:/sources'), false);
  assert.equal(mi.isCanonicalSlug('c:/users'), false);
  assert.equal(mi.isCanonicalSlug('a/b'), false);
  assert.equal(mi.isCanonicalSlug('d'), false);
  assert.equal(mi.isCanonicalSlug(null), false);
});

test('map: null projectSlug → no scope gate (global)', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'feedback', projectSlug: null }));
  assert.equal(m.qa.scope, undefined);
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

test('toWireExperience: shapes the /api/import-memory payload', () => {
  const m = mi.mapMemoryToExperience(rec({ type: 'feedback' }));
  const wire = mi.toWireExperience(m, rec({ type: 'feedback' }));
  assert.deepEqual(Object.keys(wire).sort(), ['collection', 'confidence', 'id', 'qa', 'runtime', 'tier']);
  assert.equal(wire.runtime, 'claude');
  assert.equal(wire.collection, mi.BEHAVIORAL_COLLECTION);
  assert.equal(wire.qa.solution, 'sol body');
});

// --- adapter-registry extensibility ---

test('stubAdapter enumerates nothing and parses to null', () => {
  const a = mi.stubAdapter('future-runtime');
  assert.equal(a.runtime, 'future-runtime');
  assert.deepEqual(a.enumerate('/any'), []);
  assert.equal(a.parse('/any/file.md'), null);
});

test('scan: codex adapter finds memory files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-codex-'));
  const mem = path.join(home, '.codex', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'feedback_a.md'), `---\nname: fb-a\ntype: feedback\ndescription: rule A\n---\nbody A`);
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['codex'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].runtime, 'codex');
    assert.equal(records[0].body, 'body A');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan: gemini adapter finds memory files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-gemini-'));
  const mem = path.join(home, '.gemini', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'feedback_a.md'), `---\nname: fb-a\ntype: feedback\ndescription: rule A\n---\nbody A`);
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['gemini'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].runtime, 'gemini');
    assert.equal(records[0].body, 'body A');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan: antigravity adapter finds memory files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-antigravity-'));
  const mem = path.join(home, '.gemini', 'antigravity', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'feedback_a.md'), `---\nname: fb-a\ntype: feedback\ndescription: rule A\n---\nbody A`);
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['antigravity'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].runtime, 'antigravity');
    assert.equal(records[0].body, 'body A');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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

test('scan: gemini adapter parses MEMORY.md file correctly', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-gemini-mem-'));
  const mem = path.join(home, '.gemini', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  const mdContent = `# eBerth Planner Workspace Memory

## Core Architectural & Domain Decisions
- **Tech Stack**: Angular 21, PixiJS (for 60fps Gantt rendering).
- **Port Area Isolation**: Tab-based Port Area viewing.

## Specialized UI/UX Workflows
- **Coordinate System (UI vs Store)**:
  - **Store (Absolute)**: fromMeterMark and toMeterMark.
  - **Gantt UI (Relative)**: relative X coordinates.
`;
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), mdContent);
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['gemini'] });
    assert.equal(records.length, 3);
    
    assert.equal(records[0].name, 'Tech Stack');
    assert.equal(records[0].description, 'Core Architectural & Domain Decisions - Angular 21, PixiJS (for 60fps Gantt rendering).');
    assert.equal(records[0].body, '- **Tech Stack**: Angular 21, PixiJS (for 60fps Gantt rendering).');
    
    assert.equal(records[1].name, 'Port Area Isolation');
    
    assert.equal(records[2].name, 'Coordinate System (UI vs Store)');
    assert.ok(records[2].body.includes('Store (Absolute)'));
    assert.ok(records[2].body.includes('Gantt UI (Relative)'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('parseMemoryMd: inline [type] marker overrides the default project tier', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-mem-type-'));
  const mem = path.join(home, '.codex', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(
    path.join(mem, 'MEMORY.md'),
    `## Rules\n- **[feedback] Library-first**: prefer the shared lib over a local copy.\n- **Plain Lesson**: a project-scoped note.\n- [user] runs on Windows/PowerShell.\n`,
  );
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['codex'] });
    assert.equal(records.length, 3);
    // [feedback] marker stripped from name, type promoted to feedback.
    assert.equal(records[0].name, 'Library-first');
    assert.equal(records[0].type, 'feedback');
    // No marker → default project.
    assert.equal(records[1].name, 'Plain Lesson');
    assert.equal(records[1].type, 'project');
    // Non-bold [user] marker stripped from name AND description.
    assert.equal(records[2].type, 'user');
    assert.ok(!records[2].name.startsWith('[user]'));
    assert.ok(!records[2].description.includes('[user]'));
    // The feedback bullet maps to the T1 behavioral collection; user is skipped.
    const fb = mi.mapMemoryToExperience(records[0]);
    assert.equal(fb.tier, 1);
    assert.equal(fb.collection, mi.BEHAVIORAL_COLLECTION);
    assert.equal(mi.mapMemoryToExperience(records[2]), null); // type=user → skipped
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('parseMemoryMd: numbered bullets are parsed and duplicate names de-duped', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-mem-num-'));
  const mem = path.join(home, '.codex', 'projects', 'testproj', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(
    path.join(mem, 'MEMORY.md'),
    `## Steps\n1. **Build**: run the build.\n2) **Build**: run it again.\n`,
  );
  try {
    const records = mi.scanMemorySources({ homeDir: home, runtimes: ['codex'] });
    assert.equal(records.length, 2); // numbered `1.` and `2)` both parsed
    assert.equal(records[0].name, 'Build');
    assert.equal(records[1].name, 'Build #2'); // collision de-duped, not clobbered
    // Distinct names → distinct stableIds → no upsert clobber.
    const id0 = mi.stableId(records[0].runtime, records[0].projectSlug, records[0].name);
    const id1 = mi.stableId(records[1].runtime, records[1].projectSlug, records[1].name);
    assert.notEqual(id0, id1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

