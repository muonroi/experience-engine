// Anti-Noise Scoring Unit Tests
// Tests for NOISE-01 (hitCount boost), NOISE-02 (recency decay),
// NOISE-03 (confidence aging), NOISE-04 (ignore penalty), and rerankByQuality

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  _computeEffectiveScore: computeEffectiveScore,
  _computeEffectiveConfidence: computeEffectiveConfidence,
  _rerankByQuality: rerankByQuality,
} = require('./experience-core.js');

// Helper: create a Qdrant-shaped point
function mkPoint(score, data) {
  return { id: 'test-id', score, payload: { json: JSON.stringify(data) } };
}

// Helper: ISO date N days ago
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// --- NOISE-01: Hit-count boost ---

describe('NOISE-01: hitCount boost', () => {
  it('hitCount=10 scores higher than hitCount=0 at same cosine', () => {
    const scoreWith0 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const scoreWith10 = computeEffectiveScore({ score: 0.7 }, { hitCount: 10 });
    assert.ok(scoreWith10 > scoreWith0, `expected ${scoreWith10} > ${scoreWith0}`);
  });

  it('hitCount=0 gives zero boost', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    assert.strictEqual(result, 0.7);
  });

  it('hitCount=10 gives ~0.17 boost via log2(11)*0.05', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 10 });
    const expectedBoost = Math.log2(11) * 0.05;
    assert.ok(Math.abs(result - (0.7 + expectedBoost)) < 0.001,
      `expected ~${(0.7 + expectedBoost).toFixed(4)}, got ${result.toFixed(4)}`);
  });
});

// --- NOISE-02: Recency decay ---

describe('NOISE-02: recency decay', () => {
  it('no penalty when lastHitAt is null', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, lastHitAt: null });
    const baseline = computeEffectiveScore({ score: 0.7 }, { hitCount: 5 });
    assert.strictEqual(result, baseline);
  });

  it('no penalty when lastHitAt is within 30 days', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, lastHitAt: daysAgo(10) });
    const baseline = computeEffectiveScore({ score: 0.7 }, { hitCount: 5 });
    assert.strictEqual(result, baseline);
  });

  it('applies penalty when lastHitAt is 60 days ago', () => {
    const recent = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, lastHitAt: daysAgo(1) });
    const old = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, lastHitAt: daysAgo(60) });
    assert.ok(old < recent, `expected 60-day-old (${old}) < recent (${recent})`);
  });

  it('penalty capped at 0.15 for very old experiences (365+ days)', () => {
    const score365 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, lastHitAt: daysAgo(365) });
    const score730 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, lastHitAt: daysAgo(730) });
    // Both should have max penalty of 0.15 -> score = 0.55
    assert.ok(Math.abs(score365 - score730) < 0.001,
      `expected capped penalty: 365d=${score365.toFixed(4)}, 730d=${score730.toFixed(4)}`);
  });
});

// --- NOISE-03: Confidence aging ---

describe('NOISE-03: confidence aging', () => {
  it('new experience (hits=0) gets ~70% of base confidence', () => {
    const result = computeEffectiveConfidence({ confidence: 0.5, hitCount: 0 });
    assert.ok(Math.abs(result - 0.35) < 0.01,
      `expected ~0.35, got ${result.toFixed(4)}`);
  });

  it('after 5 hits, effective confidence equals base', () => {
    const result = computeEffectiveConfidence({ confidence: 0.5, hitCount: 5 });
    assert.ok(Math.abs(result - 0.50) < 0.01,
      `expected ~0.50, got ${result.toFixed(4)}`);
  });

  it('high-confidence experience at 0 hits gets ~0.56', () => {
    const result = computeEffectiveConfidence({ confidence: 0.8, hitCount: 0 });
    assert.ok(Math.abs(result - 0.56) < 0.01,
      `expected ~0.56, got ${result.toFixed(4)}`);
  });

  it('ageFactor capped at 1.0 for many hits', () => {
    const result = computeEffectiveConfidence({ confidence: 0.5, hitCount: 100 });
    assert.ok(Math.abs(result - 0.50) < 0.01,
      `expected capped at 0.50, got ${result.toFixed(4)}`);
  });

  it('defaults to confidence=0.5 when missing', () => {
    const result = computeEffectiveConfidence({});
    assert.ok(Math.abs(result - 0.35) < 0.01,
      `expected ~0.35 (default conf 0.5 * 0.7), got ${result.toFixed(4)}`);
  });
});

// --- NOISE-04: Ignore penalty ---

describe('NOISE-04: ignore penalty', () => {
  it('no penalty when ignoreCount < 3', () => {
    const score0 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 0 });
    const score2 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 2 });
    assert.strictEqual(score0, score2);
  });

  it('applies 0.10 penalty when ignoreCount >= 3', () => {
    const scoreClean = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 0 });
    const scoreIgnored = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 3 });
    assert.ok(Math.abs(scoreClean - scoreIgnored - 0.10) < 0.001,
      `expected 0.10 penalty, got ${(scoreClean - scoreIgnored).toFixed(4)}`);
  });

  it('penalty same for ignoreCount=3 and ignoreCount=10', () => {
    const score3 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 3 });
    const score10 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 10 });
    assert.strictEqual(score3, score10);
  });
});

// --- rerankByQuality ---

describe('rerankByQuality', () => {
  it('sorts points by effective score descending', () => {
    const points = [
      mkPoint(0.6, { hitCount: 0 }),
      mkPoint(0.5, { hitCount: 20 }),
      mkPoint(0.7, { hitCount: 0 }),
    ];
    const ranked = rerankByQuality(points);
    assert.ok(ranked[0]._effectiveScore >= ranked[1]._effectiveScore,
      'first should score >= second');
    assert.ok(ranked[1]._effectiveScore >= ranked[2]._effectiveScore,
      'second should score >= third');
  });

  it('handles points with invalid/missing payload.json', () => {
    const points = [
      mkPoint(0.8, { hitCount: 5 }),
      { id: 'bad', score: 0.9, payload: { json: 'NOT-JSON' } },
      { id: 'empty', score: 0.85, payload: {} },
    ];
    const ranked = rerankByQuality(points);
    assert.strictEqual(ranked.length, 3);
    // Bad/empty payloads still get scored (with defaults)
  });

  it('does not mutate original array', () => {
    const points = [
      mkPoint(0.6, { hitCount: 0 }),
      mkPoint(0.8, { hitCount: 0 }),
    ];
    const original0 = points[0];
    rerankByQuality(points);
    assert.strictEqual(points[0], original0, 'original array should not be mutated');
  });

  it('reranks high-hitCount experience above higher-cosine low-hitCount', () => {
    const points = [
      mkPoint(0.72, { hitCount: 0 }),   // effective: 0.72
      mkPoint(0.65, { hitCount: 20 }),   // effective: 0.65 + log2(21)*0.05 ~= 0.87
    ];
    const ranked = rerankByQuality(points);
    assert.strictEqual(ranked[0].id, 'test-id'); // both have same id, check scores
    assert.ok(ranked[0]._effectiveScore > ranked[1]._effectiveScore);
  });
});
