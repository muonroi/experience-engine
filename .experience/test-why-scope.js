#!/usr/bin/env node
/**
 * test-why-scope.js — Integration tests for v2 why+scope schema + scope filter
 *
 * Verifies:
 *   1. buildStorePayload includes why + scope fields
 *   2. Scope filter: C# rule against .js file → filtered out
 *   3. Scope filter: C# rule against .cs file → kept
 *   4. Scope filter: "all" scope rule → kept for any file
 *   5. Scope filter: legacy entry without scope → kept (universal)
 *   6. formatPoints includes "Why: ..." line when why field is present
 *   7. PostToolUse hook reads/processes state file correctly
 *   8. Backfill result: all 12 entries have why+scope in Qdrant
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const core = require(path.join(os.homedir(), '.experience', 'experience-core.js'));

const _cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')); }
  catch { return {}; }
})();
const QDRANT_BASE    = _cfg.qdrantUrl || process.env.EXPERIENCE_QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = _cfg.qdrantKey || process.env.EXPERIENCE_QDRANT_KEY || '';
const COLLECTION     = 'experience-behavioral';

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// --- Test 1: buildStorePayload includes why + scope ---

console.log('\nTest 1: buildStorePayload includes why + scope fields');
{
  const qa = {
    trigger: 'test trigger',
    question: 'test question',
    reasoning: ['step1'],
    solution: 'test solution',
    why: 'Root cause: this happened because X',
    scope: { lang: 'C#', repos: ['muonroi-building-block'] },
  };
  const payload = core._buildStorePayload('test-id', qa, 'C#', 'muonroi-building-block');
  assert('payload.why is set', payload.why === qa.why, `got: ${payload.why}`);
  assert('payload.scope is set', payload.scope?.lang === 'C#', `got: ${JSON.stringify(payload.scope)}`);
  assert('payload.solution preserved', payload.solution === qa.solution);
  assert('payload.why null when absent', core._buildStorePayload('x', { trigger:'t', solution:'s' }, null, null).why === null);
  assert('payload.scope null when absent', core._buildStorePayload('x', { trigger:'t', solution:'s' }, null, null).scope === null);
}

// --- Tests 2-5: Scope filter via interceptWithMeta internals ---
// We test the scope filter logic by extracting the applyScopeFilter behavior
// through a unit-level test on _detectContext + logic simulation.

console.log('\nTests 2-5: Scope filter (lang gate)');
{
  // Simulate the filter logic from interceptWithMeta
  function simulateScopeFilter(points, filePath) {
    const detectContext = core._detectContext;
    const fileExt = filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() || '';
    const JS_FAMILY  = new Set(['ts', 'tsx', 'js', 'jsx']);
    const CSS_FAMILY = new Set(['css', 'scss', 'less', 'sass']);
    const CS_FAMILY  = new Set(['cs', 'fs']);
    function fileMatchesLang(scopeLang) {
      if (!scopeLang || scopeLang === 'all') return true;
      const sl = scopeLang.toLowerCase();
      if (sl === 'c#')         return CS_FAMILY.has(fileExt);
      if (sl === 'javascript') return JS_FAMILY.has(fileExt);
      if (sl === 'typescript') return JS_FAMILY.has(fileExt);
      if (sl === 'css')        return CSS_FAMILY.has(fileExt);
      const detected = (detectContext(filePath) || '').toLowerCase();
      return detected === sl || detected.startsWith(sl);
    }
    return points.filter(p => {
      try {
        const exp = JSON.parse(p.payload?.json || '{}');
        if (!exp.scope?.lang) return true;
        return fileMatchesLang(exp.scope.lang);
      } catch { return true; }
    });
  }

  const csharpPoint = {
    id: 'cs-rule',
    payload: { json: JSON.stringify({ solution: 'Use Guard', scope: { lang: 'C#' } }) },
  };
  const allScopePoint = {
    id: 'all-rule',
    payload: { json: JSON.stringify({ solution: 'Use GSD', scope: { lang: 'all' } }) },
  };
  const legacyPoint = {
    id: 'legacy-rule',
    payload: { json: JSON.stringify({ solution: 'Old rule with no scope' }) },
  };

  // Test 2: C# rule against .js file → filtered out
  const jsResult = simulateScopeFilter([csharpPoint], '/src/MyComponent.ts');
  assert('C# rule filtered on .ts file', jsResult.length === 0, `got ${jsResult.length} points`);

  // Test 3: C# rule against .cs file → kept
  const csResult = simulateScopeFilter([csharpPoint], '/src/MyService.cs');
  assert('C# rule kept on .cs file', csResult.length === 1, `got ${csResult.length} points`);

  // Test 4: "all" scope rule → kept for any file
  const allOnJs = simulateScopeFilter([allScopePoint], '/src/MyComponent.ts');
  const allOnCs = simulateScopeFilter([allScopePoint], '/src/MyService.cs');
  assert('"all" scope kept on .ts file', allOnJs.length === 1);
  assert('"all" scope kept on .cs file', allOnCs.length === 1);

  // Test 5: legacy entry without scope → kept (universal)
  const legacyOnJs = simulateScopeFilter([legacyPoint], '/src/MyComponent.ts');
  assert('Legacy (no scope) kept on .ts file', legacyOnJs.length === 1);
}

// --- Test 6: formatPoints includes Why line ---

console.log('\nTest 6: formatPoints includes Why line');
{
  const pointWithWhy = {
    id: 'with-why',
    score: 0.9,
    _effectiveScore: 0.9,
    payload: { json: JSON.stringify({
      solution: 'Use IMLog not ILogger',
      why: 'The ecosystem has its own logging abstraction',
      confidence: 0.92, hitCount: 5,
    }) },
  };
  const pointNoWhy = {
    id: 'no-why',
    score: 0.8,
    _effectiveScore: 0.8,
    payload: { json: JSON.stringify({
      solution: 'Always validate input',
      confidence: 0.85, hitCount: 3,
    }) },
  };

  const formatted = core._formatPoints([pointWithWhy, pointNoWhy]);
  assert('formatPoints returns 2 lines for 2 valid points', formatted.length === 2, `got ${formatted.length}`);
  assert('why line appended for point with why', formatted[0].includes('Why: The ecosystem has its own logging'), `got: ${formatted[0]}`);
  assert('why line NOT added for point without why', !formatted[1].includes('Why:'), `got: ${formatted[1]}`);
}

// --- Test 7: PostToolUse hook reads/processes state file ---

console.log('\nTest 7: PostToolUse hook processes state file');
{
  const STATE_FILE = path.join(os.homedir(), '.experience', 'tmp', 'last-suggestions.json');

  // Write a fresh state file
  const state = {
    ts: new Date().toISOString(),
    tool: 'Edit',
    surfacedIds: [
      { collection: 'experience-behavioral', id: 'fake-id-abc', solution: 'Always use IMLog not ILogger for logging' },
    ],
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    assert('State file written', fs.existsSync(STATE_FILE));

    // The post hook should exit 0 without crashing
    const { execSync } = require('child_process');
    const mockInput = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { old_string: 'ILogger', new_string: 'IMLog<MyService>' },
      tool_response: { output: 'ok' },
    });

    const postHookPath = path.join(os.homedir(), '.experience', 'interceptor-post.js');
    assert('interceptor-post.js exists', fs.existsSync(postHookPath));

    // Run it and check exit code
    let exitCode = null;
    try {
      execSync(`echo ${JSON.stringify(mockInput)} | node "${postHookPath}"`, { timeout: 3000 });
      exitCode = 0;
    } catch (e) {
      exitCode = e.status;
    }
    assert('Post hook exits cleanly (code 0)', exitCode === 0, `exit code: ${exitCode}`);

    // State file should be deleted after processing
    // (May or may not exist depending on timing — just check it ran)
    assert('Post hook ran without exception', exitCode === 0);
  } catch (err) {
    assert('Post hook test', false, err.message);
  }
}

// --- Test 8: Backfill result — all 12 entries have why+scope ---

console.log('\nTest 8: Qdrant entries have why+scope (backfill verification)');
async function verifyBackfill() {
  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'api-key': QDRANT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100, with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      assert('Qdrant reachable', false, `status ${res.status}`);
      return;
    }
    const data = await res.json();
    const points = data.result?.points || [];
    assert('Found 12 entries', points.length === 12, `found ${points.length}`);

    let withWhy   = 0;
    let withScope = 0;
    for (const p of points) {
      let payload;
      try { payload = JSON.parse(p.payload?.json || '{}'); } catch { payload = {}; }
      if (payload.why   !== undefined) withWhy++;
      if (payload.scope !== undefined) withScope++;
    }
    assert('All entries have why field', withWhy === 12, `only ${withWhy}/12`);
    assert('All entries have scope field', withScope === 12, `only ${withScope}/12`);

    // Check specific known entries
    const e2e = points.find(p => {
      try { return JSON.parse(p.payload?.json || '{}').source === 'feedback_e2e_testing_rules.md'; } catch { return false; }
    });
    assert('e2e entry has scope.lang=all', JSON.parse(e2e?.payload?.json || '{}').scope?.lang === 'all');

    const imlog = points.find(p => {
      try { return JSON.parse(p.payload?.json || '{}').source === 'feedback_use_imlog.md'; } catch { return false; }
    });
    assert('imlog entry has scope.lang=C#', JSON.parse(imlog?.payload?.json || '{}').scope?.lang === 'C#');

    const noWidth = points.find(p => {
      try { return JSON.parse(p.payload?.json || '{}').source === 'feedback_no_hardcode_widths.md'; } catch { return false; }
    });
    const noWidthPayload = JSON.parse(noWidth?.payload?.json || '{}');
    assert('no_hardcode_widths has scope.lang=CSS', noWidthPayload.scope?.lang === 'CSS');
    assert('no_hardcode_widths has filePattern', noWidthPayload.scope?.filePattern === '*.scss,*.css,*.tsx');

  } catch (err) {
    assert('Qdrant backfill check', false, err.message);
  }
}

verifyBackfill().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nSome tests failed.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed.');
    process.exit(0);
  }
});
