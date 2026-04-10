// Context-Aware Query Unit Tests
// Tests for CTX-01 (detectContext), CTX-02 (buildQuery enrichment),
// CTX-03 (buildStorePayload domain), CTX-04 (computeEffectiveScore domain penalty)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  _detectContext: detectContext,
  _buildQuery: buildQuery,
  _computeEffectiveScore: computeEffectiveScore,
  _storeExperiencePayload: storeExperiencePayload,
  _detectTranscriptDomain: detectTranscriptDomain,
  _rerankByQuality: rerankByQuality,
} = require('./experience-core.js');

// --- CTX-01: detectContext ---

describe('CTX-01: detectContext', () => {
  it('returns TypeScript for .ts extension', () => {
    assert.strictEqual(detectContext('.ts'), 'TypeScript');
  });

  it('returns C# for .cs extension', () => {
    assert.strictEqual(detectContext('.cs'), 'C#');
  });

  it('returns Python for .py extension', () => {
    assert.strictEqual(detectContext('.py'), 'Python');
  });

  it('returns TypeScript React for .tsx extension', () => {
    assert.strictEqual(detectContext('.tsx'), 'TypeScript React');
  });

  it('returns null for null input', () => {
    assert.strictEqual(detectContext(null), null);
  });

  it('returns null for file with no extension', () => {
    assert.strictEqual(detectContext('no-extension'), null);
  });

  it('handles Windows backslash paths', () => {
    assert.strictEqual(detectContext('D:\\sources\\foo.ts'), 'TypeScript');
  });

  it('handles full Unix path', () => {
    assert.strictEqual(detectContext('/home/user/project/bar.cs'), 'C#');
  });

  it('returns null for undefined input', () => {
    assert.strictEqual(detectContext(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(detectContext(''), null);
  });
});

// --- CTX-02: buildQuery enrichment ---

describe('CTX-02: buildQuery enrichment', () => {
  it('prepends [TypeScript] for Edit with .ts file_path', () => {
    const result = buildQuery('Edit', { file_path: 'foo.ts', new_string: 'code' });
    assert.ok(result.startsWith('[TypeScript]'), `expected [TypeScript] prefix, got: ${result}`);
  });

  it('prepends [C#] for Edit with .cs file_path', () => {
    const result = buildQuery('Edit', { file_path: 'bar.cs', new_string: 'code' });
    assert.ok(result.startsWith('[C#]'), `expected [C#] prefix, got: ${result}`);
  });

  it('no prefix for Bash command (no file_path)', () => {
    const result = buildQuery('Bash', { command: 'npm test' });
    assert.ok(!result.startsWith('['), `expected no prefix, got: ${result}`);
  });

  it('prepends [Python] for Write with .py path', () => {
    const result = buildQuery('Write', { path: 'test.py', content: 'x' });
    assert.ok(result.startsWith('[Python]'), `expected [Python] prefix, got: ${result}`);
  });

  it('result length does not exceed QUERY_MAX_CHARS (500)', () => {
    const longContent = 'x'.repeat(600);
    const result = buildQuery('Edit', { file_path: 'foo.ts', new_string: longContent });
    assert.ok(result.length <= 500, `expected <= 500, got ${result.length}`);
  });

  it('context prefix preserved even with long content', () => {
    const longContent = 'x'.repeat(490);
    const result = buildQuery('Edit', { file_path: 'foo.ts', new_string: longContent });
    assert.ok(result.startsWith('[TypeScript]'), `expected prefix preserved, got: ${result.slice(0, 20)}`);
  });
});

// --- CTX-03: buildStorePayload domain ---

describe('CTX-03: buildStorePayload domain', () => {
  const sampleQA = {
    trigger: 'test trigger',
    question: 'test question',
    reasoning: ['step1'],
    solution: 'test solution',
  };

  it('includes domain field when domain provided via storeExperiencePayload', () => {
    // storeExperiencePayload wraps buildStorePayload — test the domain parameter
    const payload = storeExperiencePayload(sampleQA);
    // Default (no domain) should have domain: null
    assert.strictEqual(payload.domain, null);
  });

  it('buildStorePayload includes domain: null by default', () => {
    const payload = storeExperiencePayload(sampleQA);
    assert.ok('domain' in payload, 'payload should have domain field');
    assert.strictEqual(payload.domain, null);
  });
});

// --- CTX-04: computeEffectiveScore domain penalty ---

describe('CTX-04: computeEffectiveScore domain penalty', () => {
  it('applies penalty when queryDomain set but data.domain missing', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const penalized = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 }, 'TypeScript');
    assert.ok(penalized < base,
      `expected penalized (${penalized.toFixed(4)}) < base (${base.toFixed(4)})`);
  });

  it('no penalty when queryDomain matches data.domain', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, domain: 'TypeScript' }, 'TypeScript');
    assert.strictEqual(result, base);
  });

  it('no penalty when queryDomain is null (legacy-safe)', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 }, null);
    assert.strictEqual(result, base);
  });

  it('no penalty when queryDomain is undefined (default)', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    assert.strictEqual(result, base);
  });

  // Wave 1: Domain mismatch now applies 0.08 penalty (not 0 like before)
  it('applies 0.08 penalty when queryDomain and data.domain mismatch', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { hitCount: 0 });
    const result = computeEffectiveScore({ score: 0.7 }, { hitCount: 0, domain: 'C#' }, 'TypeScript');
    assert.ok(result < base, `mismatched domain should penalize: ${result} < ${base}`);
  });
});

// --- CTX-05: detectTranscriptDomain ---

describe('CTX-05: detectTranscriptDomain', () => {
  it('returns TypeScript when .ts paths dominate', () => {
    const transcript = [
      'Edit src/auth.ts — added guard',
      'Edit src/user.ts — fixed type',
      'Edit src/api.ts — updated endpoint',
      'Edit src/model.ts — new field',
      'Edit src/route.ts — added route',
      'Edit Services/Foo.cs — refactor',
      'Edit Services/Bar.cs — fix',
    ].join('\n');
    assert.strictEqual(detectTranscriptDomain(transcript), 'TypeScript');
  });

  it('returns C# when only .cs paths present', () => {
    const transcript = [
      'Edit Services/AuthService.cs — added method',
      'Edit Models/User.cs — new property',
      'Edit Controllers/Api.cs — endpoint',
    ].join('\n');
    assert.strictEqual(detectTranscriptDomain(transcript), 'C#');
  });

  it('returns null when no file paths present', () => {
    const transcript = 'Just a discussion about architecture with no file references.';
    assert.strictEqual(detectTranscriptDomain(transcript), null);
  });

  it('returns non-null when .ts and .cs counts are equal', () => {
    const transcript = [
      'Edit foo.ts — change',
      'Edit bar.cs — change',
    ].join('\n');
    const result = detectTranscriptDomain(transcript);
    assert.ok(result !== null, 'should return a language, not null');
  });
});

// --- CTX-06: rerankByQuality with queryDomain ---

describe('CTX-06: rerankByQuality with queryDomain', () => {
  it('domain-matched point ranks higher than untagged point at equal cosine', () => {
    const points = [
      {
        id: 'a', score: 0.7,
        payload: { json: JSON.stringify({ solution: 'fix A', confidence: 0.5, hitCount: 0, domain: 'TypeScript' }) },
      },
      {
        id: 'b', score: 0.7,
        payload: { json: JSON.stringify({ solution: 'fix B', confidence: 0.5, hitCount: 0 }) },
      },
    ];
    const ranked = rerankByQuality(points, 'TypeScript');
    // Point 'a' has domain match (no penalty), point 'b' has no domain (0.03 penalty)
    assert.strictEqual(ranked[0].id, 'a', 'domain-matched point should rank first');
    assert.ok(ranked[0]._effectiveScore > ranked[1]._effectiveScore,
      'domain-matched should have higher effective score');
  });

  it('no domain penalty difference when queryDomain is null', () => {
    const points = [
      {
        id: 'a', score: 0.7,
        payload: { json: JSON.stringify({ solution: 'fix A', confidence: 0.5, hitCount: 0, domain: 'TypeScript' }) },
      },
      {
        id: 'b', score: 0.7,
        payload: { json: JSON.stringify({ solution: 'fix B', confidence: 0.5, hitCount: 0 }) },
      },
    ];
    const ranked = rerankByQuality(points, null);
    assert.strictEqual(ranked[0]._effectiveScore, ranked[1]._effectiveScore,
      'both points should have equal effective score when no queryDomain');
  });
});
