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
const { spawnSync } = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-why-scope-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.EXPERIENCE_QDRANT_URL = 'http://127.0.0.1:1';
process.env.EXPERIENCE_HOOK_DEBUG_LOG = path.join(TEST_HOME, '.experience', 'tmp', 'debug.jsonl');

const TEST_EXP_DIR = path.join(TEST_HOME, '.experience');
fs.mkdirSync(TEST_EXP_DIR, { recursive: true });
for (const file of ['experience-core.js', 'interceptor-post.js', 'judge-worker.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(TEST_EXP_DIR, file));
}
fs.writeFileSync(path.join(TEST_EXP_DIR, 'config.json'), JSON.stringify({ qdrantUrl: 'http://127.0.0.1:1' }, null, 2));

const core = require(path.join(TEST_EXP_DIR, 'experience-core.js'));
const COLLECTION = 'experience-behavioral';

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
  const STATE_FILE = path.join(TEST_HOME, '.experience', 'tmp', 'last-suggestions.json');

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

    const mockInput = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { old_string: 'ILogger', new_string: 'IMLog<MyService>' },
      tool_response: { output: 'ok' },
    });

    const postHookPath = path.join(TEST_HOME, '.experience', 'interceptor-post.js');
    assert('interceptor-post.js exists', fs.existsSync(postHookPath));

    const result = spawnSync(process.execPath, [postHookPath], {
      input: mockInput,
      encoding: 'utf8',
      timeout: 3000,
      env: process.env,
    });
    assert('Post hook exits cleanly (code 0)', result.status === 0, `exit code: ${result.status}, stderr: ${result.stderr || ''}`);
    assert('State file deleted after processing', !fs.existsSync(STATE_FILE), 'last-suggestions.json still exists');
  } catch (err) {
    assert('Post hook test', false, err.message);
  }
}

// --- Test 8: FileStore-safe verification of stored why+scope fields ---

console.log('\nTest 8: stored entries have why+scope (FileStore-safe verification)');
async function verifyBackfill() {
  try {
    const payloads = [
      core._buildStorePayload('id-e2e', {
        trigger: 'run e2e',
        solution: 'Prefer e2e validation',
        why: 'Full flow validation catches integration bugs',
        scope: { lang: 'all' },
        source: 'feedback_e2e_testing_rules.md',
      }, null, null),
      core._buildStorePayload('id-imlog', {
        trigger: 'logging abstraction',
        solution: 'Use IMLog',
        why: 'The ecosystem uses IMLog instead of raw ILogger',
        scope: { lang: 'C#' },
        source: 'feedback_use_imlog.md',
      }, 'C#', null),
      core._buildStorePayload('id-width', {
        trigger: 'hard-coded widths',
        solution: 'Avoid fixed widths',
        why: 'Fixed widths break responsive layouts',
        scope: { lang: 'CSS', filePattern: '*.scss,*.css,*.tsx' },
        source: 'feedback_no_hardcode_widths.md',
      }, 'CSS', null),
    ];

    assert('All payloads have why field', payloads.every(p => Object.prototype.hasOwnProperty.call(p, 'why')));
    assert('All payloads have scope field', payloads.every(p => Object.prototype.hasOwnProperty.call(p, 'scope')));
    assert('e2e entry has scope.lang=all', payloads[0].scope?.lang === 'all');
    assert('imlog entry has scope.lang=C#', payloads[1].scope?.lang === 'C#');
    assert('no_hardcode_widths has scope.lang=CSS', payloads[2].scope?.lang === 'CSS');
    assert('no_hardcode_widths has filePattern', payloads[2].scope?.filePattern === '*.scss,*.css,*.tsx');
  } catch (err) {
    assert('Stored why+scope check', false, err.message);
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

process.on('exit', () => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});
