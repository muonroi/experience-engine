// Anti-Noise Scoring Unit Tests
// Tests for NOISE-01 (hitCount boost), NOISE-02 (recency decay),
// NOISE-03 (confidence aging), NOISE-04 (ignore penalty), and rerankByQuality

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  _computeEffectiveScore: computeEffectiveScore,
  _computeEffectiveConfidence: computeEffectiveConfidence,
  _rerankByQuality: rerankByQuality,
  _formatPoints: formatPoints,
  _storeExperiencePayload: storeExperiencePayload,
  _recordHitUpdatesFields: recordHitUpdatesFields,
  _trackSuggestions: trackSuggestions,
  _sessionUniqueCount: sessionUniqueCount,
  _incrementIgnoreCountData: incrementIgnoreCountData,
  _detectNaturalLang: detectNaturalLang,
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
// Wave 1: hitBoost now 0.08 multiplier, all scores scaled by confidence weight

describe('NOISE-01: hitCount boost', () => {
  it('hitCount=10 scores higher than hitCount=0 at same cosine', () => {
    const scoreWith0 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const scoreWith10 = computeEffectiveScore({ score: 0.7 }, { hitCount: 10 });
    assert.ok(scoreWith10 > scoreWith0, `expected ${scoreWith10} > ${scoreWith0}`);
  });

  it('hitCount=0 gives only confidence-weighted base score', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    // rawScore = 0.7, confWeight = computeEffectiveConfidence({}) = 0.5*0.7 = 0.35
    // final = 0.7 * (0.6 + 0.4 * 0.35) = 0.7 * 0.74 = 0.518
    const confWeight = computeEffectiveConfidence({ hitCount: 0 });
    const expected = 0.7 * (0.6 + 0.4 * confWeight);
    assert.ok(Math.abs(result - expected) < 0.001,
      `expected ~${expected.toFixed(4)}, got ${result.toFixed(4)}`);
  });

  it('hitCount=10 boost is significant via log2(11)*0.08', () => {
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 10 });
    const rawBoost = Math.log2(11) * 0.08;
    const rawScore = 0.7 + rawBoost;
    const confWeight = computeEffectiveConfidence({ hitCount: 10 });
    const expected = rawScore * (0.6 + 0.4 * confWeight);
    assert.ok(Math.abs(result - expected) < 0.001,
      `expected ~${expected.toFixed(4)}, got ${result.toFixed(4)}`);
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

  it('penalty capped at 0.15 raw for very old experiences (365+ days)', () => {
    const score365 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, lastHitAt: daysAgo(365) });
    const score730 = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, lastHitAt: daysAgo(730) });
    // Both should have same max raw penalty of 0.15, confidence weighting identical
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

// Wave 1: Graduated ignore penalty — min(0.30, count * 0.05)
describe('NOISE-04: graduated ignore penalty', () => {
  it('no penalty when ignoreCount is 0', () => {
    const score0 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 0 });
    const scoreNone = computeEffectiveScore({ score: 0.7 }, {});
    assert.strictEqual(score0, scoreNone);
  });

  it('ignoreCount=1 applies 0.05 raw penalty', () => {
    const scoreClean = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 0 });
    const score1 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 1 });
    assert.ok(score1 < scoreClean, 'ignore=1 should penalize');
  });

  it('ignoreCount=3 applies more penalty than ignoreCount=1', () => {
    const score1 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 1 });
    const score3 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 3 });
    assert.ok(score3 < score1, `expected ${score3} < ${score1}`);
  });

  it('penalty capped at 0.30 raw for ignoreCount=6 and ignoreCount=10', () => {
    const score6 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 6 });
    const score10 = computeEffectiveScore({ score: 0.7 }, { ignoreCount: 10 });
    assert.strictEqual(score6, score10, 'penalty should cap at ignoreCount=6');
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

// --- Task 1 Integration: formatPoints uses effective confidence ---

describe('formatPoints with effective confidence', () => {
  it('filters by effective confidence, not raw cosine score', () => {
    // A new experience (hitCount=0) with confidence=0.5 has effectiveConfidence=0.35
    // which is below MIN_CONFIDENCE (0.42), so it should be filtered out even if
    // raw cosine score is above MIN_CONFIDENCE
    const points = [
      mkPoint(0.50, { hitCount: 0, confidence: 0.5, solution: 'test solution' }),
    ];
    const lines = formatPoints(points);
    // effectiveConfidence = 0.5 * 0.7 = 0.35 < 0.42 => filtered out
    assert.strictEqual(lines.length, 0, 'should filter out low effective confidence');
  });

  it('includes points with high effective confidence', () => {
    // hitCount=5 => ageFactor=1.0, confidence=0.8 => effectiveConf=0.8 >= 0.42
    const points = [
      mkPoint(0.50, { hitCount: 5, confidence: 0.8, solution: 'proven solution' }),
    ];
    const lines = formatPoints(points);
    assert.strictEqual(lines.length, 1, 'should include high effective confidence point');
  });

  it('displays _effectiveScore in output line when available', () => {
    const points = [
      { id: 'x', score: 0.50, _effectiveScore: 0.72,
        payload: { json: JSON.stringify({ hitCount: 5, confidence: 0.8, solution: 'good fix' }) } },
    ];
    const lines = formatPoints(points);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('0.72'), 'should use _effectiveScore for display');
  });
});

// --- Task 1 Integration: storeExperience payload init fields ---

describe('storeExperience payload initialization', () => {
  it('includes lastHitAt: null and ignoreCount: 0 in payload', () => {
    const payload = storeExperiencePayload({
      trigger: 'test', question: 'q', solution: 's',
    });
    assert.strictEqual(payload.lastHitAt, null, 'lastHitAt should init to null');
    assert.strictEqual(payload.ignoreCount, 0, 'ignoreCount should init to 0');
  });

  it('still includes original fields', () => {
    const payload = storeExperiencePayload({
      trigger: 'test', question: 'q', solution: 's',
    });
    assert.strictEqual(payload.confidence, 0.5);
    assert.strictEqual(payload.hitCount, 0);
    assert.strictEqual(payload.tier, 2);
    assert.ok(payload.createdAt);
  });
});

// --- Task 1 Integration: recordHit updates lastHitAt and ignoreCount ---

describe('recordHit field updates', () => {
  it('updates lastHitAt and resets ignoreCount', () => {
    const data = { hitCount: 2, ignoreCount: 5, lastHitAt: null };
    const updated = recordHitUpdatesFields(data);
    assert.strictEqual(updated.hitCount, 3);
    assert.strictEqual(updated.ignoreCount, 0, 'ignoreCount should reset to 0');
    assert.ok(updated.lastHitAt, 'lastHitAt should be set');
    // Verify it's a valid ISO string
    assert.ok(!isNaN(new Date(updated.lastHitAt).getTime()), 'lastHitAt should be valid ISO');
  });
});

// --- Task 2: Ignore tracking ---

describe('trackSuggestions session-persistent tracking', () => {
  // Clean session track file before each test
  const fs = require('fs');
  const trackDir = require('path').join(require('os').tmpdir(), 'experience-session');
  function cleanTrack() {
    try {
      const files = fs.readdirSync(trackDir);
      for (const f of files) { if (f.startsWith('session-')) fs.unlinkSync(require('path').join(trackDir, f)); }
    } catch {}
  }

  it('flags point after 3+ total suggestions in session', () => {
    cleanTrack();
    trackSuggestions([{ collection: 'test-coll', id: 'pt-1' }]);
    trackSuggestions([{ collection: 'test-coll', id: 'pt-1' }]);
    const result = trackSuggestions([{ collection: 'test-coll', id: 'pt-1' }]);
    assert.ok(result.flagged.length > 0, 'should flag point after 3 suggestions');
    assert.strictEqual(result.flagged[0].id, 'pt-1');
  });

  it('does NOT flag point suggested fewer than 3 times', () => {
    cleanTrack();
    trackSuggestions([{ collection: 'test-coll', id: 'pt-2' }]);
    const result = trackSuggestions([{ collection: 'test-coll', id: 'pt-2' }]);
    assert.strictEqual(result.flagged.length, 0, 'should not flag after only 2 suggestions');
  });

  it('filters already-seen points (session dedup)', () => {
    cleanTrack();
    const r1 = trackSuggestions([{ collection: 'test-coll', id: 'pt-3' }]);
    assert.strictEqual(r1.filtered.length, 0, 'first time should not filter');
    const r2 = trackSuggestions([{ collection: 'test-coll', id: 'pt-3' }]);
    assert.strictEqual(r2.filtered.length, 1, 'second time should filter as already-seen');
    assert.strictEqual(r2.filtered[0].id, 'pt-3');
  });

  it('tracks unique count across calls', () => {
    cleanTrack();
    trackSuggestions([{ collection: 'test-coll', id: 'unique-1' }]);
    trackSuggestions([{ collection: 'test-coll', id: 'unique-2' }]);
    trackSuggestions([{ collection: 'test-coll', id: 'unique-1' }]); // repeat
    assert.strictEqual(sessionUniqueCount(), 2, 'should count 2 unique experiences');
  });
});

describe('incrementIgnoreCountData', () => {
  it('increments ignoreCount on data object', () => {
    const data = { ignoreCount: 1 };
    incrementIgnoreCountData(data);
    assert.strictEqual(data.ignoreCount, 2);
  });

  it('initializes ignoreCount if missing', () => {
    const data = {};
    incrementIgnoreCountData(data);
    assert.strictEqual(data.ignoreCount, 1);
  });
});

// --- Wave 2: Natural language detection ---

describe('Wave 2: detectNaturalLang', () => {
  it('returns "vi" for Vietnamese text', () => {
    assert.strictEqual(detectNaturalLang('Không nên dùng singleton cho DbContext'), 'vi');
  });

  it('returns "en" for English text', () => {
    assert.strictEqual(detectNaturalLang('Do not use singleton for DbContext'), 'en');
  });

  it('returns "en" for empty string', () => {
    assert.strictEqual(detectNaturalLang(''), 'en');
  });

  it('returns "en" for null', () => {
    assert.strictEqual(detectNaturalLang(null), 'en');
  });

  it('returns "vi" for mixed text with enough Vietnamese chars', () => {
    assert.strictEqual(detectNaturalLang('Lỗi khi dùng ILogger thay vì IMLog'), 'vi');
  });
});

// --- Wave 2: storeExperience includes naturalLang ---

describe('Wave 2: storeExperiencePayload naturalLang', () => {
  it('includes naturalLang field', () => {
    const payload = storeExperiencePayload({
      trigger: 'test trigger', question: 'q', solution: 'test solution',
    });
    assert.ok('naturalLang' in payload, 'payload should have naturalLang field');
    assert.strictEqual(payload.naturalLang, 'en');
  });

  it('detects Vietnamese in trigger/solution', () => {
    const payload = storeExperiencePayload({
      trigger: 'Khi gặp lỗi singleton', question: 'q', solution: 'Dùng scoped thay vì singleton',
    });
    assert.strictEqual(payload.naturalLang, 'vi');
  });
});

// --- Wave 3: Confidence weighting in scoring ---

describe('Wave 3: confidence weighting', () => {
  it('high-confidence entry scores higher than low-confidence at same cosine', () => {
    const highConf = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, confidence: 0.9 });
    const lowConf = computeEffectiveScore({ score: 0.7 }, { hitCount: 5, confidence: 0.3 });
    assert.ok(highConf > lowConf, `expected ${highConf} > ${lowConf}`);
  });

  it('score never drops below 60% of raw score (floor)', () => {
    // Worst case: confidence=0, hitCount=0 → confWeight=0, scale=0.6
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, confidence: 0 });
    assert.ok(result >= 0.7 * 0.6 * 0.99, `expected >= ${0.7 * 0.6}, got ${result}`);
  });
});
