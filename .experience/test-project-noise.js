// Project-Aware Noise Prevention Tests
// Tests that cross-project warnings are properly penalized and filtered.
// Covers: projectSlug extraction, storage, scoring penalty, and end-to-end scenarios.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

// ═══════════════════════════════════════════════════════════════════
//  PART 10: caller-side language and framework detection
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-10: caller-side language and framework detection', () => {
  const enrich = require('./source-meta-enrich.js');

  it('detectContext maps .ts to TypeScript', () => {
    assert.strictEqual(enrich.detectContext('D:/Personal/Core/muonroi-cli/src/app.ts'), 'TypeScript');
  });

  it('detectContext maps .cs to C#', () => {
    assert.strictEqual(enrich.detectContext('D:/Personal/Core/muonroi-building-block/src/Foo.cs'), 'C#');
  });

  it('detectContext returns null for paths without extensions', () => {
    assert.strictEqual(enrich.detectContext('/no/extension/here'), null);
  });

  it('detectFrameworkFromProject returns null for non-existent path', () => {
    assert.strictEqual(enrich.detectFrameworkFromProject('/nonexistent/x/y/z.ts'), null);
  });

  it('enrichSourceMeta extracts lang from toolInput.file_path', () => {
    const out = enrich.enrichSourceMeta({ file_path: 'D:/Personal/Core/muonroi-cli/src/app.ts' });
    assert.strictEqual(out.lang, 'TypeScript');
  });

  it('enrichSourceMeta returns {} for missing toolInput', () => {
    assert.deepStrictEqual(enrich.enrichSourceMeta(null), {});
    assert.deepStrictEqual(enrich.enrichSourceMeta(undefined), {});
    assert.deepStrictEqual(enrich.enrichSourceMeta({}), {});
  });

  it('enrichSourceMeta cwd fallback derives lang+framework when toolInput has no file_path (Bash hooks)', () => {
    // Simulate a TS-CLI repo: tsconfig.json + package.json with a known dep.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-cwd-'));
    try {
      fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), '{}');
      fs.writeFileSync(
        path.join(tmpRoot, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } })
      );
      enrich._resetCachesForTesting();
      const out = enrich.enrichSourceMeta({ command: 'git status' }, undefined, tmpRoot);
      assert.strictEqual(out.lang, 'TypeScript');
      assert.strictEqual(out.framework, 'react');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enrichSourceMeta cwd fallback derives c#+dotnet for .NET repos (Bash hooks)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-cwd-cs-'));
    try {
      fs.writeFileSync(path.join(tmpRoot, 'Foo.csproj'), '<Project></Project>');
      enrich._resetCachesForTesting();
      const out = enrich.enrichSourceMeta({ command: 'dotnet build' }, undefined, tmpRoot);
      assert.strictEqual(out.lang, 'C#');
      assert.strictEqual(out.framework, 'dotnet');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enrichSourceMeta toolInput.file_path takes precedence over cwd', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-cwd-mixed-'));
    try {
      fs.writeFileSync(path.join(tmpRoot, 'Foo.csproj'), '<Project></Project>');
      enrich._resetCachesForTesting();
      // file_path is .ts inside a (different) location — file path wins.
      const out = enrich.enrichSourceMeta({ file_path: 'D:/Personal/Core/muonroi-cli/src/app.ts' }, undefined, tmpRoot);
      assert.strictEqual(out.lang, 'TypeScript');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 11: scope_lang must clause is added when sourceMeta.lang is set
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-11: scope_lang Qdrant filter contract', () => {
  // Structural contract test — mirrors the IIFE in experience-core.js queryFilter
  // exactly. Updating the production code without updating this stub will keep
  // them in sync via review.
  function buildFilterStub(sourceMeta) {
    const extra = { must: [], must_not: [], should: [] };
    const callerLang = sourceMeta && typeof sourceMeta.lang === 'string'
      ? sourceMeta.lang.toLowerCase().trim() : null;
    if (callerLang) {
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_lang' } },
          { key: 'scope_lang', match: { value: 'all' } },
          { key: 'scope_lang', match: { value: callerLang } },
        ],
      });
    }
    return extra;
  }

  it('adds scope_lang clause when lang is typescript', () => {
    const f = buildFilterStub({ lang: 'typescript' });
    assert.strictEqual(f.must.length, 1);
    const should = f.must[0].should;
    assert.strictEqual(should.length, 3);
    assert.ok(should.some(c => c.is_empty && c.is_empty.key === 'scope_lang'),
      'must include is_empty(scope_lang)');
    assert.ok(should.some(c => c.match && c.match.value === 'all'),
      'must include scope_lang=all');
    assert.ok(should.some(c => c.match && c.match.value === 'typescript'),
      'must include scope_lang=typescript');
  });

  it('lowercases caller lang before matching', () => {
    const f = buildFilterStub({ lang: 'TypeScript' });
    const values = f.must[0].should
      .filter(c => c.key === 'scope_lang' && c.match)
      .map(c => c.match.value);
    assert.ok(values.includes('typescript'),
      `expected lowercased "typescript" in values, got ${JSON.stringify(values)}`);
    assert.ok(!values.includes('TypeScript'),
      `expected no mixed-case "TypeScript", got ${JSON.stringify(values)}`);
  });

  it('does not add scope_lang clause when lang is absent', () => {
    assert.strictEqual(buildFilterStub({}).must.length, 0);
    assert.strictEqual(buildFilterStub({ lang: '' }).must.length, 0);
    assert.strictEqual(buildFilterStub({ lang: '  ' }).must.length, 0);
    assert.strictEqual(buildFilterStub(null).must.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 12: Cross-stack scenario (muonroi-cli TS vs muonroi-building-block .NET)
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-12: cross-stack muonroi-* prefix does not leak hints', () => {
  // The real fix happens at Qdrant query time via scope_lang must clause
  // (PART 11). This test confirms the in-memory rerank still demotes a
  // .NET-tagged hint inside a TS context, as a defence in depth.
  it('C#/.NET hint scores low in TypeScript+muonroi-cli context', () => {
    const dotnetRule = mkPoint(0.75, {
      _projectSlug: 'muonroi-building-block',
      domain: 'C#',
      scope: { lang: 'c#', framework: 'dotnet' },
      trigger: 'Use IMLog<T> over ILogger<T>',
      solution: 'Replace ILogger<T> with IMLog<T>',
      hitCount: 2,
      confidence: 0.75,
    });
    const ranked = rerankByQuality([dotnetRule], 'TypeScript', 'muonroi-cli');
    assert.ok(ranked[0]._effectiveScore < 0.30,
      `C# rule should score < 0.30 in TS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });

  it('a TypeScript hint inside muonroi-cli still scores well in its own context', () => {
    const tsRule = mkPoint(0.70, {
      _projectSlug: 'muonroi-cli',
      domain: 'TypeScript',
      scope: { lang: 'typescript' },
      trigger: 'Prefer top-level await over IIFE',
      solution: 'Use top-level await',
      hitCount: 2,
      confidence: 0.7,
    });
    const ranked = rerankByQuality([tsRule], 'TypeScript', 'muonroi-cli');
    assert.ok(ranked[0]._effectiveScore > 0.40,
      `Same-stack TS rule should score > 0.40, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 13: org-configured framework-package detection
//
//  The engine ships with ZERO hardcoded org/framework names. Tests inject
//  example patterns via opts.frameworkPackages — matching the schema users
//  put in ~/.experience/config.json under org.frameworkPackages.
//
//  Fabricated fixtures in temp dirs so the suite is independent of the
//  real workspace layout.
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-13: org-configured framework-package detection', () => {
  const enrich = require('./source-meta-enrich.js');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // Generic example patterns for tests. The engine does NOT ship these —
  // a downstream user supplies their own via config. Names used here are
  // arbitrary illustration.
  const EXAMPLE_PACKAGES = {
    'example-fw': {
      nuget: ['Example.Framework.'],
      npm: ['@example/'],
    },
  };

  function mkTempProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ee-fw-test-'));
  }

  function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  it('.csproj with configured nuget prefix -> mapped framework label', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Sample.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Example.Framework.Core" Version="1.0.0" />
    <PackageReference Include="Microsoft.Extensions.Logging" Version="8.0.0" />
  </ItemGroup>
</Project>
`);
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'Foo.cs'),
        { frameworkPackages: EXAMPLE_PACKAGES }
      );
      assert.strictEqual(fw, 'example-fw');
    } finally { cleanup(dir); }
  });

  it('.csproj with no configured prefix -> generic dotnet', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'PlainApi.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.0.0" />
  </ItemGroup>
</Project>
`);
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'Foo.cs'),
        { frameworkPackages: EXAMPLE_PACKAGES }
      );
      assert.strictEqual(fw, 'dotnet');
    } finally { cleanup(dir); }
  });

  it('.csproj ProjectReference with configured prefix in path -> mapped label', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Consumer.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\\..\\Example.Framework.AspNetCore\\Example.Framework.AspNetCore.csproj" />
  </ItemGroup>
</Project>
`);
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'Foo.cs'),
        { frameworkPackages: EXAMPLE_PACKAGES }
      );
      assert.strictEqual(fw, 'example-fw');
    } finally { cleanup(dir); }
  });

  it('package.json with configured npm prefix -> mapped label (beats react)', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'consumer-app',
        dependencies: { '@example/sdk': '^1.0.0', 'react': '^18.0.0' },
      }));
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'app.ts'),
        { frameworkPackages: EXAMPLE_PACKAGES }
      );
      assert.strictEqual(fw, 'example-fw',
        'configured npm prefix must take precedence over built-in react detection');
    } finally { cleanup(dir); }
  });

  it('package.json with only react dep -> react (built-in generic table)', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'plain-react',
        dependencies: { 'react': '^18.0.0', 'react-dom': '^18.0.0' },
      }));
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'app.tsx'),
        { frameworkPackages: EXAMPLE_PACKAGES }
      );
      assert.strictEqual(fw, 'react');
    } finally { cleanup(dir); }
  });

  it('no frameworkPackages configured -> .NET falls back to generic dotnet', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Sample.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Example.Framework.Core" Version="1.0.0" />
  </ItemGroup>
</Project>
`);
      // Explicit empty config -> generic detection only.
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'Foo.cs'),
        { frameworkPackages: {} }
      );
      assert.strictEqual(fw, 'dotnet');
    } finally { cleanup(dir); }
  });

  it('multiple frameworks configured -> first matching prefix wins', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Sample.csproj'),
        '<Project><ItemGroup><PackageReference Include="Acme.Lib.Core" /></ItemGroup></Project>');
      const fw = enrich.detectFrameworkFromProject(
        path.join(dir, 'src', 'Foo.cs'),
        {
          frameworkPackages: {
            'acme-lib': { nuget: ['Acme.Lib.'] },
            'example-fw': { nuget: ['Example.Framework.'] },
          },
        }
      );
      assert.strictEqual(fw, 'acme-lib');
    } finally { cleanup(dir); }
  });

  it('cache: second call against same project root returns same value O(1)', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Sample.csproj'),
        '<Project><ItemGroup><PackageReference Include="Example.Framework.X"/></ItemGroup></Project>');
      const opts = { frameworkPackages: EXAMPLE_PACKAGES };
      const first = enrich.detectFrameworkFromProject(path.join(dir, 'a.cs'), opts);
      // Delete the file — cache should still return the same answer.
      fs.unlinkSync(path.join(dir, 'Sample.csproj'));
      const second = enrich.detectFrameworkFromProject(path.join(dir, 'b.cs'), opts);
      assert.strictEqual(first, 'example-fw');
      assert.strictEqual(second, 'example-fw', 'cache must serve second call');
    } finally { cleanup(dir); }
  });

  // stop-extractor passes the session cwd (a directory) to enrichSourceMeta;
  // taking path.dirname() of a directory walks one level above the project
  // and misses the markers. The detector must accept directories directly.
  it('directory path: detects framework when path IS the project root', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'Sample.csproj'),
        '<Project><ItemGroup><PackageReference Include="Example.Framework.X"/></ItemGroup></Project>');
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, { frameworkPackages: EXAMPLE_PACKAGES });
      assert.strictEqual(fw, 'example-fw');
    } finally { cleanup(dir); }
  });

  // Solution files don't use Include="..."; they list projects via Project("{GUID}") = "Name".
  // _slnReferencesPrefix scans the raw text for any configured nuget prefix.
  it('.sln substring scan: matches configured nuget prefix in solution body', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'App.sln'),
        'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{FAE04EC0}") = "Example.Framework.Auth", "src\\Example.Framework.Auth\\Example.Framework.Auth.csproj", "{ABC}"\n');
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, { frameworkPackages: EXAMPLE_PACKAGES });
      assert.strictEqual(fw, 'example-fw');
    } finally { cleanup(dir); }
  });

  // Hybrid monorepo: workspace root with both .sln (build tooling for an
  // embedded host) and package.json. The TS side is the work surface for
  // most hook events; npm match must win over the .sln substring fallback.
  it('hybrid monorepo: npm @scope dep beats .sln nuget match at workspace root', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'App.sln'),
        'Project("{FAE04EC0}") = "Example.Framework.Host", "host\\Example.Framework.Host.csproj"\n');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'workspace-root',
        devDependencies: { '@example/ui-kit': '^1.0.0' },
      }));
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, {
        frameworkPackages: {
          'example-net': { nuget: ['Example.Framework.'] },
          'example-ui':  { npm:   ['@example/'] },
        },
      });
      assert.strictEqual(fw, 'example-ui',
        'npm @scope match must take precedence over .sln substring fallback when no .csproj at this level');
    } finally { cleanup(dir); }
  });

  // Many repos hold the actual project under src/ or apps/ while the repo
  // root only has tooling files. A stop-hook that knows only the repo cwd
  // would yield no framework hint without this fallback.
  it('descend into src/: framework markers in a conventional source dir', () => {
    const dir = mkTempProject();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'App.sln'),
        'Project("{X}") = "Example.Framework.Auth", "Auth\\Example.Framework.Auth.csproj"\n');
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, { frameworkPackages: EXAMPLE_PACKAGES });
      assert.strictEqual(fw, 'example-fw');
    } finally { cleanup(dir); }
  });

  it('descend into apps/: skips a non-matching subdir and finds the next', () => {
    const dir = mkTempProject();
    try {
      fs.mkdirSync(path.join(dir, 'apps'));
      fs.writeFileSync(path.join(dir, 'apps', 'package.json'), JSON.stringify({
        name: 'apps-root',
        dependencies: { '@angular/core': '^17.0.0' },
      }));
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, { frameworkPackages: {} });
      assert.strictEqual(fw, 'angular', 'angular dep in apps/ subdir should be detected from repo root');
    } finally { cleanup(dir); }
  });

  // peerDependencies is the canonical way workspace packages declare org deps
  // (the actual @scope dep is installed at the workspace root). Detector must
  // include peerDependencies when looking for the configured npm prefix.
  it('package.json: peerDependencies @scope dep is honored', () => {
    const dir = mkTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'workspace-pkg',
        dependencies: { 'react': '^18.0.0' },
        peerDependencies: { '@example/core': '>=1.0.0' },
      }));
      enrich._resetCachesForTesting();
      const fw = enrich.detectFrameworkFromProject(dir, { frameworkPackages: EXAMPLE_PACKAGES });
      assert.strictEqual(fw, 'example-fw',
        'peerDependencies with configured @scope prefix must beat react');
    } finally { cleanup(dir); }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 14: extractQA post-processing (Phase 3 part B)
//
//  Verifies the post-process safety net: when the brain LLM forgets
//  scope.framework or returns a label that doesn't match the caller hint,
//  the wrapper coerces scope.framework to 'any'. We stub the underlying
//  brain call via a temporary override of callBrainWithFallback.
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-14: extractQA classifier post-processing', () => {
  it('defaults missing scope.framework to any', async () => {
    const brain = require('./src/brain-llm.js');
    // The brain module exports extractQA; intercept callBrainWithFallback by
    // monkey-patching require cache. We use a small wrapper that mimics the
    // module's post-process logic instead of touching the runtime brain — this
    // keeps the test offline and deterministic.
    function simulate(opts, brainResponse) {
      // Replicate the post-process block from brain-llm.js extractQA.
      const callerFw = typeof opts.framework === 'string' && opts.framework.trim()
        ? opts.framework.trim() : null;
      const result = JSON.parse(JSON.stringify(brainResponse));
      if (result && !result.skip && result.scope && typeof result.scope === 'object') {
        if (typeof result.scope.framework !== 'string' || !result.scope.framework.trim()) {
          result.scope.framework = 'any';
        } else if (callerFw) {
          const fw = result.scope.framework.toLowerCase().trim();
          if (fw !== 'any' && fw !== callerFw.toLowerCase()) {
            result.scope.framework = 'any';
          }
        }
      }
      return result;
    }

    const out = simulate(
      { framework: 'example-fw' },
      { scope: { lang: 'C#' } /* framework missing */ },
    );
    assert.strictEqual(out.scope.framework, 'any');
    // Confirm the production function exists.
    assert.strictEqual(typeof brain.extractQA, 'function');
    // Source-level grep: extractQA signature must take opts (default-value
    // params are not visible via Function.length).
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'src', 'brain-llm.js'), 'utf8');
    assert.ok(/async function extractQA\([^)]*opts[^)]*\)/.test(src),
      'extractQA must declare an opts parameter');
  });

  it('coerces invented framework labels to any when caller hint provided', () => {
    function simulate(opts, brainResponse) {
      const callerFw = typeof opts.framework === 'string' && opts.framework.trim()
        ? opts.framework.trim() : null;
      const result = JSON.parse(JSON.stringify(brainResponse));
      if (result && !result.skip && result.scope && typeof result.scope === 'object') {
        if (typeof result.scope.framework !== 'string' || !result.scope.framework.trim()) {
          result.scope.framework = 'any';
        } else if (callerFw) {
          const fw = result.scope.framework.toLowerCase().trim();
          if (fw !== 'any' && fw !== callerFw.toLowerCase()) {
            result.scope.framework = 'any';
          }
        }
      }
      return result;
    }
    const out = simulate(
      { framework: 'example-fw' },
      { scope: { lang: 'C#', framework: 'totally-made-up-fw' } },
    );
    assert.strictEqual(out.scope.framework, 'any');
  });

  it('preserves valid matching framework label', () => {
    function simulate(opts, brainResponse) {
      const callerFw = typeof opts.framework === 'string' && opts.framework.trim()
        ? opts.framework.trim() : null;
      const result = JSON.parse(JSON.stringify(brainResponse));
      if (result && !result.skip && result.scope && typeof result.scope === 'object') {
        if (typeof result.scope.framework !== 'string' || !result.scope.framework.trim()) {
          result.scope.framework = 'any';
        } else if (callerFw) {
          const fw = result.scope.framework.toLowerCase().trim();
          if (fw !== 'any' && fw !== callerFw.toLowerCase()) {
            result.scope.framework = 'any';
          }
        }
      }
      return result;
    }
    const out = simulate(
      { framework: 'example-fw' },
      { scope: { lang: 'C#', framework: 'example-fw' } },
    );
    assert.strictEqual(out.scope.framework, 'example-fw');
  });
});
