// Unit tests for the pre-surface relevance gate (intercept.filterByActionRelevance).
// Verifies the gate drops candidate hints a PreToolUse action would later
// classify wrong_repo / wrong_language / wrong_task, keeps genuine matches,
// is a no-op for UserPromptSubmit (action unknown), and fails open on a
// malformed payload. This is the fix for the 57% interception-precision drag:
// 87% of irrelevant surfaces came from PreToolUse hooks where the action was
// already known but the relevance check ran only post-hoc.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const intercept = require('./src/intercept.js');

// Build a Qdrant-shaped point whose payload.json carries the given scope.
function point(id, scope) {
  return { id, payload: { json: JSON.stringify({ scope }) }, score: 0.55 };
}

const MUONROI_TS = 'D:/sources/Core/muonroi-cli/src/app/a.ts';

describe('relevance-gate: isActionKnownHook', () => {
  it('true for concrete tool actions, false for UserPrompt / empty', () => {
    assert.strictEqual(intercept.isActionKnownHook('Edit'), true);
    assert.strictEqual(intercept.isActionKnownHook('Write'), true);
    assert.strictEqual(intercept.isActionKnownHook('Bash'), true);
    assert.strictEqual(intercept.isActionKnownHook('UserPrompt'), false);
    assert.strictEqual(intercept.isActionKnownHook(''), false);
    assert.strictEqual(intercept.isActionKnownHook(null), false);
  });
});

describe('relevance-gate: PreToolUse drops mismatches', () => {
  it('drops a hint scoped to a different project (wrong_repo)', () => {
    const pts = [point('p-wrongrepo', { project_slug: 'eberth', lang: 'TypeScript' })];
    const { kept, removed } = intercept.filterByActionRelevance(
      pts, 'experience-selfqa', 'Edit', { file_path: MUONROI_TS }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 0, 'cross-repo hint must not surface');
    assert.strictEqual(removed.length, 1);
    assert.strictEqual(removed[0].reason, 'wrong_repo');
  });

  it('drops a hint scoped to a different language (wrong_language/wrong_task)', () => {
    const pts = [point('p-wronglang', { lang: 'C#' })];
    const { kept, removed } = intercept.filterByActionRelevance(
      pts, 'experience-behavioral', 'Edit', { file_path: MUONROI_TS }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 0, 'foreign-language hint must not surface on a .ts edit');
    assert.ok(['wrong_language', 'wrong_task'].includes(removed[0].reason), `unexpected reason ${removed[0].reason}`);
  });

  it('drops a scoped hint on a Bash command that does not suggest its domain (wrong_task)', () => {
    const pts = [point('p-wrongtask', { lang: 'C#' })];
    const { kept, removed } = intercept.filterByActionRelevance(
      pts, 'experience-selfqa', 'Bash', { command: 'git status' }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 0, 'off-domain hint must not surface on an unrelated bash command');
    assert.strictEqual(removed.length, 1);
  });
});

describe('relevance-gate: keeps genuine matches', () => {
  it('keeps a same-project same-language hint', () => {
    const pts = [point('p-match', { project_slug: 'muonroi-cli', lang: 'TypeScript' })];
    const { kept, removed } = intercept.filterByActionRelevance(
      pts, 'experience-behavioral', 'Edit', { file_path: MUONROI_TS }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 1, 'matching hint must surface');
    assert.strictEqual(removed.length, 0);
  });

  it('keeps an unscoped hint on an in-project Bash command (path_match)', () => {
    // Unscoped lessons (no lang / no project_slug) are not language- or
    // repo-specific, so they still surface on any in-project action. The gate
    // only drops SCOPED mismatches — it must not over-suppress generic hints.
    const pts = [point('p-unscoped', {})];
    const { kept } = intercept.filterByActionRelevance(
      pts, 'experience-selfqa', 'Bash', { command: 'npm run build' }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 1, 'unscoped hint must still surface on an in-project action');
  });
});

describe('relevance-gate: guards', () => {
  it('is a no-op for UserPrompt (action unknown) — keeps everything', () => {
    const pts = [point('p1', { project_slug: 'eberth', lang: 'C#' }), point('p2', { lang: 'Python' })];
    const { kept, removed } = intercept.filterByActionRelevance(
      pts, 'experience-selfqa', 'UserPrompt', {}, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 2, 'prompt-time surfacing must be unaffected');
    assert.strictEqual(removed.length, 0);
  });

  it('fails open on a malformed payload (keeps + does not throw)', () => {
    const bad = { id: 'p-bad', payload: { json: '{not valid json' }, score: 0.5 };
    const { kept } = intercept.filterByActionRelevance(
      [bad], 'experience-selfqa', 'Edit', { file_path: MUONROI_TS }, { cwd: 'D:/sources/Core/muonroi-cli' },
    );
    assert.strictEqual(kept.length, 1, 'malformed payload must fail open, not vanish');
  });

  it('handles empty/undefined point arrays', () => {
    assert.deepStrictEqual(intercept.filterByActionRelevance([], 'experience-selfqa', 'Edit', {}, {}), { kept: [], removed: [] });
    assert.deepStrictEqual(intercept.filterByActionRelevance(undefined, 'experience-selfqa', 'Edit', {}, {}), { kept: [], removed: [] });
  });
});
