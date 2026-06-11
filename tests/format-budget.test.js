#!/usr/bin/env node
'use strict';

/**
 * format-budget.test.js — applyBudget line-packing + recall budget sizing.
 *
 * Recall-blackhole bug, layer 2 (2026-06-11): recall-format lines are ~2000
 * chars each (full solution + evidence). applyBudget used `break` on the first
 * line that overflowed maxChars, discarding that line AND every line after it.
 * With recallBudgetChars=3500 and ~2000-char lines, line 1 fit and line 2
 * overflowed → break → only 1 entry ever surfaced per collection, and a single
 * oversized first line zeroed the whole leg. Evidence (live VPS): selfqa
 * formatPoints returned 23 lines [2006,2024,2024,...], applyBudget(.,3500)
 * kept 1. Fix: skip (continue) oversized lines so smaller ones still pack in,
 * and raise recallBudgetChars so recall delivers the depth it advertises.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyBudget } = require('../.experience/src/format.js');

test('applyBudget: an oversized line is skipped, not a hard stop (continue, not break)', () => {
  const lines = ['x'.repeat(5000), 'short one', 'short two'];
  const kept = applyBudget(lines, 3500);
  // `break` would have returned [] (first line overflows). `continue` keeps the
  // two short lines that fit.
  assert.deepEqual(kept, ['short one', 'short two']);
});

test('applyBudget: packs multiple lines that fit instead of stopping at first overflow', () => {
  // Real measured selfqa line lengths against the 3500 recall budget.
  const lengths = [2006, 2024, 694, 677, 770];
  const lines = lengths.map((n, i) => String.fromCharCode(97 + i).repeat(n));
  const kept = applyBudget(lines, 3500);
  // break → only [2006]. continue → 2006 + 694 + 677 = 3377 ≤ 3500 → 3 lines.
  assert.ok(kept.length >= 3, `expected >=3 packed lines, got ${kept.length}`);
  const total = kept.reduce((s, l) => s + l.length, 0);
  assert.ok(total <= 3500, `budget bound violated: ${total}`);
});

test('applyBudget: never exceeds the char budget', () => {
  const lines = Array.from({ length: 20 }, () => 'a'.repeat(300));
  const kept = applyBudget(lines, 1000);
  const total = kept.reduce((s, l) => s + l.length, 0);
  assert.ok(total <= 1000, `total ${total} > 1000`);
});

test('applyBudget: preserves original order among kept lines', () => {
  const lines = ['aaa', 'b'.repeat(9999), 'ccc', 'ddd'];
  const kept = applyBudget(lines, 100);
  assert.deepEqual(kept, ['aaa', 'ccc', 'ddd']);
});

test('COLLECTIONS: recall budgets are larger than passive and fit multiple ~2000-char lines', () => {
  // MUST assert on intercept.js's COLLECTIONS — that is the array
  // experience-core.js destructures for the live recall path. config.js has a
  // separate divergent copy that core never reads (the original bug).
  const { COLLECTIONS } = require('../.experience/src/intercept.js');
  for (const c of COLLECTIONS) {
    assert.ok(Number.isFinite(c.recallBudgetChars), `${c.name}: recallBudgetChars must be set`);
    assert.ok(Number.isFinite(c.recallTopK), `${c.name}: recallTopK must be set`);
    assert.ok(c.recallBudgetChars > c.budgetChars, `${c.name}: recall budget must exceed passive`);
  }
  const byName = Object.fromEntries(COLLECTIONS.map((c) => [c.name, c]));
  // Behavioral + selfqa carry the verbose seeds; depth requires room for >=3
  // of the ~2000-char lines observed in production.
  assert.ok(byName['experience-behavioral'].recallBudgetChars >= 6000);
  assert.ok(byName['experience-selfqa'].recallBudgetChars >= 6000);
});
