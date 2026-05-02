const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDeterministicAssessment,
  resolveUnclearFallback,
} = require('./judge-worker.js');

describe('judge-worker deterministic fallback', () => {
  it('does not mark UNCLEAR + error as IGNORED when deterministic assessment is irrelevant', () => {
    const verdict = resolveUnclearFallback('UNCLEAR', 'error', {
      touched: false,
      reason: 'wrong_task',
    });

    assert.strictEqual(verdict, 'IRRELEVANT');
  });

  it('marks UNCLEAR + error as IGNORED only when deterministic assessment is relevant', () => {
    const verdict = resolveUnclearFallback('UNCLEAR', 'error', {
      touched: true,
      reason: 'project_match',
    });

    assert.strictEqual(verdict, 'IGNORED');
  });

  it('marks UNCLEAR + success as FOLLOWED when deterministic assessment is touched', () => {
    const verdict = applyDeterministicAssessment('UNCLEAR', 'success', {
      touched: true,
      reason: 'language_match',
    });

    assert.strictEqual(verdict, 'FOLLOWED');
  });

  it('leaves UNCLEAR neutral when deterministic assessment is unavailable', () => {
    assert.strictEqual(resolveUnclearFallback('UNCLEAR', 'error', null), 'UNCLEAR');
  });
});
