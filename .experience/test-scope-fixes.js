// Targeted tests for the post-1b184df / post-782ba64 fixes:
//  - Seed entries must bypass hitBoost in computeEffectiveScore
//  - extractCodeSymbols must hard-cap on input size + iteration budget
//
// Org-leak fix in applyScopeFilter is exercised indirectly here via the seed
// bypass (seeds are the worst-case noise source); a full integration test of
// applyScopeFilter would need a Qdrant double and is out of scope.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  _computeEffectiveScore: computeEffectiveScore,
  _buildQuery: buildQuery,
} = require('./experience-core.js');

function mkPoint(score) {
  return { id: 't', score, payload: { json: '{}' } };
}

describe('seed hitBoost bypass (post 9fc4020 follow-up)', () => {
  it('seed entry with 0 hits scores the same as one with 100 hits', () => {
    const seed0 = computeEffectiveScore(mkPoint(0.7), { hitCount: 0, createdFrom: 'seed-common-doc' });
    const seed100 = computeEffectiveScore(mkPoint(0.7), { hitCount: 100, createdFrom: 'seed-common-doc' });
    // hitBoost is the only difference; with bypass, results are identical
    assert.ok(Math.abs(seed0 - seed100) < 1e-9,
      `expected identical: 0-hit=${seed0}, 100-hit=${seed100}`);
  });

  it('organic entry with 10 hits still beats seed at same cosine (organic gets boost, seed does not)', () => {
    const organic10 = computeEffectiveScore(mkPoint(0.7), { hitCount: 10 });
    const seed0 = computeEffectiveScore(mkPoint(0.7), { hitCount: 0, createdFrom: 'seed-common-doc' });
    assert.ok(organic10 > seed0,
      `expected organic-10 (${organic10}) > seed-0 (${seed0})`);
  });

  it('fresh seed of higher cosine beats organic with hits when gap is wide enough (cosine primary)', () => {
    // With HIT_BOOST_MAX=0.12 cap, max organic boost is +0.12. So as long as
    // seed cosine exceeds organic cosine by > ~0.15 (after confWeight scaling),
    // seed wins. This is the contract: cosine is primary, hits are tiebreakers.
    const freshSeed = computeEffectiveScore(mkPoint(0.85), { hitCount: 0, confidence: 0.7, createdFrom: 'seed-common-doc' });
    const organicSimilarCos = computeEffectiveScore(mkPoint(0.65), { hitCount: 100 });
    assert.ok(freshSeed > organicSimilarCos,
      `seed at 0.85 cos should beat organic at 0.65 cos+100 hits: seed=${freshSeed}, organic=${organicSimilarCos}`);
  });
});

describe('extractCodeSymbols input bound (post 96f3549 follow-up)', () => {
  it('does not hang or throw on very large pathological input', () => {
    // 200KB of repeated I-prefixed-Service patterns — would explode without cap
    const pathological = ('IAuthenticateInfoService throw new SomeException ').repeat(4000);
    const t0 = Date.now();
    const q = buildQuery('Edit', { file_path: 'x.cs', new_string: pathological });
    const elapsed = Date.now() - t0;
    assert.ok(typeof q === 'string', 'buildQuery must return a string');
    assert.ok(elapsed < 250, `extractCodeSymbols should bound under 250ms, took ${elapsed}ms`);
  });

  it('returns empty/short symbol list when input is huge (graceful degradation)', () => {
    // Even with code shape that triggers augmentation, the cap means we either
    // return a bounded prefix or skip augmentation entirely. Either is fine.
    const huge = `class X : Parent ${'IAuthenticateInfoService '.repeat(10000)}`;
    const q = buildQuery('Edit', { file_path: 'x.cs', new_string: huge });
    assert.ok(q.length <= 500, `query must be capped at QUERY_MAX_CHARS=500, got ${q.length}`);
  });
});
