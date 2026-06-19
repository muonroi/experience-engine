#!/usr/bin/env node
'use strict';

/**
 * profile-render.test.js — "Who Am I" v4.0 slice 2, pure renderer (T5).
 *
 * The unit under test is .experience/src/profile-render.js — a PURE module
 * (no fs, no wall-clock, no getPrivacyLevel inside) that turns a committed
 * profile model into the marker-delimited "## Developer Profile (live)" block
 * the SessionStart hook injects. Everything here is deterministic: profiles are
 * built as plain objects in the exact shape loadProfile() produces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const render = require('../.experience/src/profile-render');
const agentMd = require('../.experience/src/agent-md');

// --- helpers: build profiles in the loadProfile() shape -----------------
function dim(value, confidence, sampleCount = 20) {
  return { value, confidence, sampleCount, distribution: {}, evidence: null };
}
function profileOf(dimensions, updatedAt = null) {
  return { version: 1, updatedAt, dimensions };
}
// All 10 emitted dimensions committed at high confidence.
function fullProfile() {
  return profileOf({
    'communication.question_style': dim('directive', 0.8, 30),
    'communication.feedback_style': dim('implicit', 0.75, 22),
    'communication.brevity': dim('concise', 0.83, 12),
    'personality.conflict_style': dim('direct-constructive', 0.7, 18),
    'personality.risk_tolerance': dim('experimental', 0.72, 14),
    'personality.decision_speed': dim('fast-intuitive', 0.7, 15),
    'work_patterns.energy': dim('night-owl', 0.6, 40),
    'work_patterns.multitasking': dim('sequential-deep', 0.65, 25),
    'work_patterns.session_length': dim('long', 0.55, 16),
    'work_patterns.delegation_style': dim('autonomous', 0.68, 19),
  });
}

const MINIMAL_DIMS = ['work_patterns.energy', 'work_patterns.multitasking', 'work_patterns.session_length', 'personality.decision_speed'];
const TANG2_DIMS = ['communication.question_style', 'communication.feedback_style', 'communication.brevity', 'personality.conflict_style', 'personality.risk_tolerance', 'work_patterns.delegation_style'];

// signal-detector.js emits a CLOSED value set per dimension. Pinned here so the
// DIRECTIVES completeness test fails loudly if the detector grows a new value.
const VALUE_SETS = {
  'communication.question_style': ['comparison', 'debugging', 'exploratory', 'directive'],
  'communication.feedback_style': ['implicit', 'precise-correction'],
  'communication.brevity': ['concise', 'moderate', 'verbose'],
  'personality.conflict_style': ['direct-constructive', 'authoritative', 'cautious'],
  'personality.risk_tolerance': ['experimental'],
  'personality.decision_speed': ['fast-intuitive', 'measured', 'deliberate'],
  'work_patterns.energy': ['night-owl', 'daytime', 'mixed'],
  'work_patterns.multitasking': ['task-switcher', 'sequential-deep'],
  'work_patterns.session_length': ['short', 'medium', 'long'],
  'work_patterns.delegation_style': ['autonomous', 'collaborative'],
};

// --- privacy matrix -----------------------------------------------------

test('off → renders nothing (feature dark)', () => {
  assert.equal(render.renderProfileBlock(fullProfile(), { level: 'off' }), '');
  assert.deepEqual(render.selectInjectableDims(fullProfile(), 'off'), []);
});

test('minimal → only the 4 Tang-1 dims, Tang-2 stripped even when committed', () => {
  const names = render.selectInjectableDims(fullProfile(), 'minimal').map(d => d.name).sort();
  assert.deepEqual(names, [...MINIMAL_DIMS].sort());
  const block = render.renderProfileBlock(fullProfile(), { level: 'minimal' });
  // Load-bearing stale-downgrade leak guard: no Tang-2 directive may leak.
  for (const n of TANG2_DIMS) assert.ok(!block.includes(render.LABELS[n]), `minimal leaked ${n}`);
});

test('standard → all 10 committed dims; full is byte-identical to standard', () => {
  const std = render.renderProfileBlock(fullProfile(), { level: 'standard' });
  const full = render.renderProfileBlock(fullProfile(), { level: 'full' });
  assert.equal(std, full, 'full must equal standard (no Tang-3 dims exist)');
  assert.equal(render.selectInjectableDims(fullProfile(), 'standard').length, 10);
});

test('decision_speed namespace trap: personality.* but Tang-1, renders at minimal', () => {
  const p = profileOf({ 'personality.decision_speed': dim('measured', 0.7, 20) });
  const names = render.selectInjectableDims(p, 'minimal').map(d => d.name);
  assert.deepEqual(names, ['personality.decision_speed']);
});

test('pending (value==null) dims are skipped at every level', () => {
  const p = profileOf({
    'communication.brevity': dim(null, 0.9, 5),       // pending — under N>=10 gate
    'work_patterns.energy': dim(null, 0.9, 4),
  });
  assert.equal(render.selectInjectableDims(p, 'standard').length, 0);
  assert.equal(render.renderProfileBlock(p, { level: 'standard' }), '');
});

// --- confidence floors --------------------------------------------------

test('per-tier confidence floors: 0.55 Tang-2 drops at 0.6, 0.50 work survives at 0.45', () => {
  const p = profileOf({
    'communication.brevity': dim('concise', 0.55, 20),  // below Tang-2 floor 0.6
    'work_patterns.energy': dim('night-owl', 0.50, 20),  // above work floor 0.45
  });
  const names = render.selectInjectableDims(p, 'standard').map(d => d.name);
  assert.deepEqual(names, ['work_patterns.energy']);
});

test('confidence floors are tunable via opts', () => {
  const p = profileOf({ 'communication.brevity': dim('concise', 0.55, 20) });
  assert.equal(render.selectInjectableDims(p, 'standard').length, 0);
  assert.equal(render.selectInjectableDims(p, 'standard', { minConfidence: 0.5 }).length, 1);
});

// --- Tang-3 hard exclude -------------------------------------------------

test('Tang-3 emotional.* never renders at ANY level, including full', () => {
  const withMood = profileOf({
    'emotional.mood': dim('calm', 0.99, 99),
    'communication.brevity': dim('concise', 0.8, 20),
  });
  for (const level of ['minimal', 'standard', 'full']) {
    const block = render.renderProfileBlock(withMood, { level });
    assert.ok(!block.includes('emotional'), `emotional.* leaked at ${level}`);
    assert.ok(!block.includes('calm'), `emotional value leaked at ${level}`);
  }
  // emotional-only profile renders nothing even at full.
  assert.equal(render.renderProfileBlock(profileOf({ 'emotional.mood': dim('calm', 0.99, 99) }), { level: 'full' }), '');
});

// --- unmapped value (graceful skip, never "undefined") ------------------

test('committed value missing from DIRECTIVES is skipped, never injected as undefined', () => {
  const p = profileOf({ 'communication.brevity': dim('telegraphic', 0.9, 20) }); // not an enumerated value
  const block = render.renderProfileBlock(p, { level: 'standard' });
  assert.equal(block, '');
  assert.ok(!block.includes('undefined'));
});

// --- golden snapshot + purity -------------------------------------------

test('golden: exact rendered block for a fixed standard profile', () => {
  const p = profileOf({
    'communication.brevity': dim('concise', 0.83, 12),
    'personality.decision_speed': dim('fast-intuitive', 0.7, 15),
  });
  const expected = [
    '<!-- experience-profile:start -->',
    '## Developer Profile (live — Experience Engine)',
    '',
    'Live profile learned from your local sessions. These directives SUPERSEDE any static "## Developer Profile" block. Each line ends with (confidence, n=samples).',
    '',
    '**Communication**',
    '- **Brevity:** Keep responses concise and action-first; lead with the change, then a short rationale. (0.83, n=12)',
    '',
    '**Decision & personality**',
    '- **Decision speed:** Expect fast decisions — present a recommendation, not a menu. (0.70, n=15)',
    '<!-- experience-profile:end -->',
  ].join('\n');
  assert.equal(render.renderProfileBlock(p, { level: 'standard' }), expected);
});

test('render is pure: same inputs → byte-identical output across calls', () => {
  const p = fullProfile();
  assert.equal(render.renderProfileBlock(p, { level: 'standard' }), render.renderProfileBlock(p, { level: 'standard' }));
});

// --- updatedAt / staleness ----------------------------------------------

test('updatedAt: null omits the recency line', () => {
  const p = profileOf({ 'communication.brevity': dim('concise', 0.8, 20) }, null);
  assert.ok(!render.renderProfileBlock(p, { level: 'standard' }).includes('Profile last updated'));
});

test('updatedAt: fresh shows the line without a stale note; stale appends the note', () => {
  const updatedAt = '2026-06-01T00:00:00.000Z';
  const now = Date.parse('2026-06-10T00:00:00.000Z'); // 9 days → fresh under 60d
  const p = profileOf({ 'communication.brevity': dim('concise', 0.8, 20) }, updatedAt);
  const fresh = render.renderProfileBlock(p, { level: 'standard', now });
  assert.ok(fresh.includes('Profile last updated: ' + updatedAt));
  assert.ok(!fresh.includes('stale'));
  const staleNow = Date.parse('2026-09-01T00:00:00.000Z'); // ~92 days → stale
  const stale = render.renderProfileBlock(p, { level: 'standard', now: staleNow });
  assert.ok(stale.includes('stale'));
});

// --- marker coexistence with the agent-md EE block ----------------------

test('profile markers are distinct from the experience-engine block markers', () => {
  assert.notEqual(render.PROFILE_START, agentMd.START_MARKER);
  assert.notEqual(render.PROFILE_END, agentMd.END_MARKER);
});

test('agentMd.applyBlock refreshes the EE block without touching the profile block', () => {
  const profileBlock = render.renderProfileBlock(fullProfile(), { level: 'standard' });
  const combined = 'existing content\n\n' + profileBlock;
  const after = agentMd.applyBlock(combined); // refreshes/append the experience-engine block
  assert.ok(after.includes(render.PROFILE_START), 'applyBlock stripped the profile block');
  assert.ok(after.includes(agentMd.START_MARKER), 'applyBlock did not add the EE block');
});

// --- directives completeness --------------------------------------------

test('DIRECTIVES covers every enumerated value of every allowlisted dimension', () => {
  for (const name of render.TIER_ALLOWLIST.standard) {
    const values = VALUE_SETS[name];
    assert.ok(values, `no pinned value set for allowlisted dim ${name}`);
    assert.ok(render.DIRECTIVES[name], `DIRECTIVES missing dim ${name}`);
    for (const v of values) {
      assert.ok(render.DIRECTIVES[name][v], `DIRECTIVES[${name}] missing value "${v}"`);
    }
  }
});
