// Project-Aware Noise Prevention Tests
// Tests that cross-project warnings are properly penalized and filtered.
// Covers: projectSlug extraction, storage, scoring penalty, and end-to-end scenarios.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  _computeEffectiveScore: computeEffectiveScore,
  _rerankByQuality: rerankByQuality,
  _storeExperiencePayload: storeExperiencePayload,
  _extractProjectSlug: extractProjectSlug,
  _buildStorePayload: buildStorePayload,
  _shouldSuppressForNoise: shouldSuppressForNoise,
} = require('./experience-core.js');

// Helper: create a Qdrant-shaped point
function mkPoint(score, data) {
  return { id: `test-${Math.random().toString(36).slice(2, 8)}`, score, payload: { json: JSON.stringify(data) } };
}

// ═══════════════════════════════════════════════════════════════════
//  PART 1: extractProjectSlug — correct slug extraction from paths
// ═══════════════════════════════════════════════════════════════════

describe('extractProjectSlug', () => {
  it('extracts from /sources/org/project pattern', () => {
    assert.strictEqual(extractProjectSlug('D:\\sources\\CompanyLibs\\tcis.libraries\\src\\file.cs'), 'tcis.libraries');
  });

  it('extracts from /sources/org/project with forward slashes', () => {
    assert.strictEqual(extractProjectSlug('/d/sources/CompanyLibs/tcis.libraries/src/file.cs'), 'tcis.libraries');
  });

  it('extracts from /repos/project pattern', () => {
    assert.strictEqual(extractProjectSlug('/home/user/repos/my-app/src/index.ts'), 'my-app');
  });

  it('extracts from /projects/project pattern', () => {
    assert.strictEqual(extractProjectSlug('/opt/projects/backend-api/main.go'), 'backend-api');
  });

  it('extracts from /workspace/project pattern', () => {
    assert.strictEqual(extractProjectSlug('/workspace/web-frontend/src/App.tsx'), 'web-frontend');
  });

  it('returns lowercase slug', () => {
    assert.strictEqual(extractProjectSlug('D:\\sources\\Core\\Experience-Engine\\src\\file.js'), 'experience-engine');
  });

  it('extracts repo slug from Core workspace paths on Windows', () => {
    assert.strictEqual(extractProjectSlug('D:/Personal/Core/experience-engine/server.js'), 'experience-engine');
    assert.strictEqual(extractProjectSlug('D:/Personal/Core/muonroi-building-block/src/App.cs'), 'muonroi-building-block');
  });

  it('extracts repo slug from Core workspace paths on WSL mount paths', () => {
    assert.strictEqual(extractProjectSlug('/mnt/d/Personal/Core/experience-engine/.experience/experience-core.js'), 'experience-engine');
    assert.strictEqual(extractProjectSlug('/mnt/d/Personal/Core/storyflow_ui/src/App.tsx'), 'storyflow_ui');
  });

  it('returns null for null/undefined input', () => {
    assert.strictEqual(extractProjectSlug(null), null);
    assert.strictEqual(extractProjectSlug(undefined), null);
    assert.strictEqual(extractProjectSlug(''), null);
  });

  it('different orgs with same project name produce same slug', () => {
    const a = extractProjectSlug('/sources/OrgA/shared-lib/file.cs');
    const b = extractProjectSlug('/sources/OrgB/shared-lib/file.cs');
    assert.strictEqual(a, b, 'same project name = same slug regardless of org');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 2: buildStorePayload — projectSlug stored correctly
// ═══════════════════════════════════════════════════════════════════

describe('buildStorePayload stores projectSlug', () => {
  const qa = { trigger: 'test', question: 'q', solution: 's' };

  it('stores _projectSlug when provided', () => {
    const payload = buildStorePayload('id-1', qa, 'TypeScript', 'tcis.libraries');
    assert.strictEqual(payload._projectSlug, 'tcis.libraries');
  });

  it('stores _projectSlug as null when not provided', () => {
    const payload = buildStorePayload('id-2', qa, 'TypeScript');
    assert.strictEqual(payload._projectSlug, null);
  });

  it('stores _projectSlug as null for empty string', () => {
    const payload = buildStorePayload('id-3', qa, 'TypeScript', '');
    assert.strictEqual(payload._projectSlug, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 3: storeExperiencePayload — end-to-end payload creation
// ═══════════════════════════════════════════════════════════════════

describe('storeExperiencePayload with projectSlug', () => {
  const qa = { trigger: 'test', question: 'q', solution: 's' };

  it('includes projectSlug in payload when passed', () => {
    const payload = storeExperiencePayload(qa, 'C#', 'tcis.libraries');
    assert.strictEqual(payload._projectSlug, 'tcis.libraries');
  });

  it('includes domain in payload when passed', () => {
    const payload = storeExperiencePayload(qa, 'C#', 'tcis.libraries');
    assert.strictEqual(payload.domain, 'C#');
  });

  it('defaults projectSlug to null when omitted', () => {
    const payload = storeExperiencePayload(qa);
    assert.strictEqual(payload._projectSlug, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 4: computeEffectiveScore — cross-project penalty
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-05: cross-project penalty', () => {
  it('no penalty when both slugs match', () => {
    const sameProject = computeEffectiveScore(
      { score: 0.7 },
      { _projectSlug: 'tcis.libraries' },
      null,
      'tcis.libraries'
    );
    const noProject = computeEffectiveScore(
      { score: 0.7 },
      {},
      null,
      null
    );
    assert.strictEqual(sameProject, noProject, 'same project = no penalty');
  });

  it('applies heavy penalty when slugs differ', () => {
    const sameProject = computeEffectiveScore(
      { score: 0.7 },
      { _projectSlug: 'tcis.libraries' },
      null,
      'tcis.libraries'
    );
    const crossProject = computeEffectiveScore(
      { score: 0.7 },
      { _projectSlug: 'eport-frontend' },
      null,
      'tcis.libraries'
    );
    assert.ok(crossProject < sameProject,
      `cross-project (${crossProject.toFixed(4)}) should be < same-project (${sameProject.toFixed(4)})`);
  });

  it('penalty is exactly 0.85 raw for cross-project non-principle (before confidence weighting)', () => {
    const base = computeEffectiveScore({ score: 0.7 }, { _projectSlug: 'a' }, null, 'a');
    const penalized = computeEffectiveScore({ score: 0.7 }, { _projectSlug: 'b' }, null, 'a');
    // Raw penalty = 0.85, scaled by confidence weight
    const confWeight = 0.5 * 0.7; // default conf=0.5, hits=0, ageFactor=0.7
    const scale = 0.6 + 0.4 * confWeight;
    const expectedDiff = 0.85 * scale;
    const actualDiff = base - penalized;
    assert.ok(Math.abs(actualDiff - expectedDiff) < 0.001,
      `expected penalty diff ~${expectedDiff.toFixed(4)}, got ${actualDiff.toFixed(4)}`);
  });

  it('no penalty when rule has no projectSlug (legacy rule)', () => {
    const withSlug = computeEffectiveScore(
      { score: 0.7 }, { _projectSlug: null }, null, 'tcis.libraries'
    );
    const noSlug = computeEffectiveScore(
      { score: 0.7 }, {}, null, 'tcis.libraries'
    );
    assert.strictEqual(withSlug, noSlug, 'null/missing slug = no penalty (backward compat)');
  });

  it('no penalty when query has no projectSlug', () => {
    const result = computeEffectiveScore(
      { score: 0.7 }, { _projectSlug: 'eport-frontend' }, null, null
    );
    const baseline = computeEffectiveScore(
      { score: 0.7 }, { _projectSlug: 'eport-frontend' }, null, undefined
    );
    assert.strictEqual(result, baseline, 'no query slug = no penalty');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 5: Combined domain + project penalty
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-06: combined domain + project penalty', () => {
  it('wrong domain AND wrong project gets both penalties stacked', () => {
    const correct = computeEffectiveScore(
      { score: 0.7 },
      { domain: 'C#', _projectSlug: 'tcis.libraries' },
      'C#',
      'tcis.libraries'
    );
    const wrongBoth = computeEffectiveScore(
      { score: 0.7 },
      { domain: 'TypeScript', _projectSlug: 'eport-frontend' },
      'C#',
      'tcis.libraries'
    );
    // Should have both -0.20 domain + -0.50 project = -0.70 raw penalty
    assert.ok(wrongBoth < correct,
      `wrong both (${wrongBoth.toFixed(4)}) should be much less than correct (${correct.toFixed(4)})`);
    // Verify the penalty is substantial (at least 0.40 effective difference)
    assert.ok(correct - wrongBoth > 0.40,
      `combined penalty should create >0.40 difference, got ${(correct - wrongBoth).toFixed(4)}`);
  });

  it('wrong project alone is a heavier penalty than wrong domain alone', () => {
    const wrongDomain = computeEffectiveScore(
      { score: 0.7 },
      { domain: 'TypeScript', _projectSlug: 'tcis.libraries' },
      'C#',
      'tcis.libraries'
    );
    const wrongProject = computeEffectiveScore(
      { score: 0.7 },
      { domain: 'C#', _projectSlug: 'eport-frontend' },
      'C#',
      'tcis.libraries'
    );
    assert.ok(wrongProject < wrongDomain,
      `wrong project (${wrongProject.toFixed(4)}) should be < wrong domain only (${wrongDomain.toFixed(4)})`);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 6: rerankByQuality — cross-project rules ranked lower
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-07: rerankByQuality cross-project demotion', () => {
  it('same-project rule ranks above cross-project even with lower cosine', () => {
    const points = [
      mkPoint(0.80, { _projectSlug: 'eport-frontend', hitCount: 2, confidence: 0.8 }),
      mkPoint(0.65, { _projectSlug: 'tcis.libraries', hitCount: 2, confidence: 0.6 }),
    ];
    const ranked = rerankByQuality(points, null, 'tcis.libraries');
    const sameProjectIdx = ranked.findIndex(p =>
      JSON.parse(p.payload.json)._projectSlug === 'tcis.libraries');
    const crossProjectIdx = ranked.findIndex(p =>
      JSON.parse(p.payload.json)._projectSlug === 'eport-frontend');
    assert.ok(sameProjectIdx < crossProjectIdx,
      'same-project should rank higher despite lower cosine');
  });

  it('cross-project rule with high cosine gets substantially penalized', () => {
    const points = [
      mkPoint(0.85, { _projectSlug: 'eport-frontend', hitCount: 2, confidence: 0.7 }),
      mkPoint(0.70, { _projectSlug: 'tcis.libraries', hitCount: 2, confidence: 0.6 }),
    ];
    const ranked = rerankByQuality(points, null, 'tcis.libraries');
    const sameProjectScore = ranked.find(p =>
      JSON.parse(p.payload.json)._projectSlug === 'tcis.libraries')._effectiveScore;
    const crossProjectScore = ranked.find(p =>
      JSON.parse(p.payload.json)._projectSlug === 'eport-frontend')._effectiveScore;
    assert.ok(sameProjectScore > crossProjectScore,
      `same-project (${sameProjectScore.toFixed(3)}) should beat cross-project (${crossProjectScore.toFixed(3)}) with 0.70 penalty`);
  });

  it('legacy rules (no projectSlug) get moderate penalty vs same-project', () => {
    const points = [
      mkPoint(0.70, { hitCount: 2, confidence: 0.7 }),  // no _projectSlug
      mkPoint(0.70, { _projectSlug: 'tcis.libraries', hitCount: 2, confidence: 0.7 }),
    ];
    const ranked = rerankByQuality(points, null, 'tcis.libraries');
    const legacyScore = ranked.find(p => !JSON.parse(p.payload.json)._projectSlug)?._effectiveScore;
    const sameScore = ranked.find(p => JSON.parse(p.payload.json)._projectSlug === 'tcis.libraries')?._effectiveScore;
    assert.ok(sameScore > legacyScore,
      'same-project rule should score higher than unknown-origin legacy rule');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 7: Real-world TCIS session noise scenarios
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-08: real-world TCIS session noise prevention', () => {
  // Simulates the exact noise observed in the TCIS library session:
  // 6/7 warnings were from wrong projects (ePort, Muonroi, D:/sources/Core)

  it('Muonroi IMLog warning does NOT surface for TCIS library edit', () => {
    const muonroiRule = mkPoint(0.66, {
      _projectSlug: 'eport-be',
      domain: 'C#',
      trigger: 'Always use IMLog<T> from Muonroi.Logging.Abstractions',
      solution: 'Replace ILogger<T> with IMLog<T>',
      hitCount: 1,
      confidence: 0.66,
    });
    const ranked = rerankByQuality([muonroiRule], 'C#', 'tcis.libraries');
    // With -0.50 project penalty on 0.66 cosine, effective should be very low
    assert.ok(ranked[0]._effectiveScore < 0.30,
      `Muonroi rule should score < 0.30 in TCIS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });

  it('ePort consumer app warning does NOT surface for TCIS library edit', () => {
    const eportRule = mkPoint(0.82, {
      _projectSlug: 'eport-fe',
      domain: 'TypeScript',
      trigger: 'Never modify ePort consumer app code unless absolutely necessary',
      solution: 'Fix in library instead',
      hitCount: 2,
      confidence: 0.82,
    });
    const ranked = rerankByQuality([eportRule], 'C#', 'tcis.libraries');
    // Gets both domain penalty (-0.20 TS vs C#) and project penalty (-0.50)
    assert.ok(ranked[0]._effectiveScore < 0.25,
      `ePort rule should score < 0.25 in TCIS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });

  it('D:/sources/Core workspace warning does NOT surface for TCIS edit', () => {
    const coreRule = mkPoint(0.72, {
      _projectSlug: 'experience-engine',
      trigger: 'D:/sources/Core is a workspace folder, NOT the primary code repo',
      solution: 'Each sub-directory is its own independent git repo',
      hitCount: 2,
      confidence: 0.72,
    });
    const ranked = rerankByQuality([coreRule], 'C#', 'tcis.libraries');
    assert.ok(ranked[0]._effectiveScore < 0.30,
      `Core workspace rule should score < 0.30 in TCIS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });

  it('TCIS-specific rule DOES surface for TCIS library edit', () => {
    const tcisRule = mkPoint(0.75, {
      _projectSlug: 'tcis.libraries',
      domain: 'C#',
      trigger: 'Use ILogWriter<T> not ILogger<T> in TCIS',
      solution: 'TCIS uses ILogWriter abstraction',
      hitCount: 1,
      confidence: 0.7,
    });
    const ranked = rerankByQuality([tcisRule], 'C#', 'tcis.libraries');
    assert.ok(ranked[0]._effectiveScore > 0.50,
      `TCIS rule should score > 0.50 in TCIS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });

  it('in mixed results, TCIS rule ranks above all cross-project rules', () => {
    const points = [
      mkPoint(0.82, { _projectSlug: 'eport-fe', domain: 'TypeScript', confidence: 0.82, hitCount: 2,
        trigger: 'Never modify ePort consumer app code' }),
      mkPoint(0.66, { _projectSlug: 'eport-be', domain: 'C#', confidence: 0.66, hitCount: 1,
        trigger: 'Always use IMLog<T>' }),
      mkPoint(0.72, { _projectSlug: 'experience-engine', confidence: 0.72, hitCount: 1,
        trigger: 'D:/sources/Core is a workspace folder' }),
      mkPoint(0.58, { _projectSlug: 'tcis.libraries', domain: 'C#', confidence: 0.58, hitCount: 1,
        trigger: 'Use ILogWriter in TCIS' }),
    ];
    const ranked = rerankByQuality(points, 'C#', 'tcis.libraries');
    const tcisIdx = ranked.findIndex(p =>
      JSON.parse(p.payload.json)._projectSlug === 'tcis.libraries');
    assert.strictEqual(tcisIdx, 0,
      `TCIS rule should rank #1, but ranked #${tcisIdx + 1}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 8: Edge cases — penalty boundary conditions
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-09: penalty edge cases', () => {
  it('project penalty applies independently of ignore penalty', () => {
    const crossIgnored = computeEffectiveScore(
      { score: 0.7 },
      { _projectSlug: 'other-project', ignoreCount: 3 },
      null,
      'tcis.libraries'
    );
    const crossClean = computeEffectiveScore(
      { score: 0.7 },
      { _projectSlug: 'other-project', ignoreCount: 0 },
      null,
      'tcis.libraries'
    );
    assert.ok(crossIgnored < crossClean,
      'cross-project + ignored should be even lower than cross-project alone');
  });

  it('all penalties stack: domain + project + ignore + recency', () => {
    const worstCase = computeEffectiveScore(
      { score: 0.7 },
      {
        _projectSlug: 'other-project',
        domain: 'Python',
        ignoreCount: 6,
        lastHitAt: new Date(Date.now() - 200 * 86400000).toISOString(),
      },
      'C#',
      'tcis.libraries'
    );
    // domain: -0.20, project: -0.50, ignore: -0.30, recency: ~-0.10
    // rawScore ≈ 0.7 - 1.10 = negative → times confidence weight → very low
    assert.ok(worstCase < 0.0,
      `worst-case score should be negative, got ${worstCase.toFixed(4)}`);
  });

  it('case sensitivity: slug comparison is case-insensitive via extractProjectSlug', () => {
    // extractProjectSlug always returns lowercase
    const slugA = extractProjectSlug('/sources/Org/MyProject/file.cs');
    const slugB = extractProjectSlug('/sources/org/myproject/file.cs');
    assert.strictEqual(slugA, slugB, 'slugs should be case-insensitive');
  });
});

describe('balanced noise suppression gate', () => {
  it('suppresses repeated wrong_task docs/config noise for code-specific hints', () => {
    const decision = shouldSuppressForNoise({
      scope: { lang: 'TypeScript' },
      noiseReasonCounts: { wrong_task: 2 },
    }, {
      actionKind: 'docs',
      queryProjectSlug: 'experience-engine',
      queryDomain: null,
    });

    assert.strictEqual(decision.suppress, true);
    assert.strictEqual(decision.reason, 'wrong_task');
  });

  it('does not suppress a recently followed hint', () => {
    const decision = shouldSuppressForNoise({
      scope: { lang: 'TypeScript' },
      noiseReasonCounts: { wrong_task: 5, wrong_language: 5 },
      lastHitAt: new Date().toISOString(),
    }, {
      actionKind: 'docs',
      queryDomain: 'Python',
    });

    assert.strictEqual(decision.suppress, false);
  });

  it('suppresses wrong_repo only when current project still mismatches', () => {
    const data = {
      _projectSlug: 'storyflow',
      noiseReasonCounts: { wrong_repo: 2 },
    };

    assert.strictEqual(shouldSuppressForNoise(data, { queryProjectSlug: 'experience-engine' }).suppress, true);
    assert.strictEqual(shouldSuppressForNoise(data, { queryProjectSlug: 'storyflow' }).suppress, false);
  });

  it('suppresses wrong_language only when current language still mismatches', () => {
    const data = {
      scope: { lang: 'C#' },
      noiseReasonCounts: { wrong_language: 2 },
    };

    assert.strictEqual(shouldSuppressForNoise(data, { queryDomain: 'TypeScript' }).suppress, true);
    assert.strictEqual(shouldSuppressForNoise(data, { queryDomain: 'C#' }).suppress, false);
  });
});
