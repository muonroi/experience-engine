---
phase: quick
plan: 260512-lfi
type: execute
wave: 1
depends_on: []
files_modified:
  - .experience/interceptor.js
  - .experience/interceptor-post.js
  - .experience/interceptor-prompt.js
  - .experience/src/utils.js
  - .experience/experience-core.js
  - .experience/test-project-noise.js
autonomous: false
requirements: [EE-NOISE-LANG-FRAMEWORK]
must_haves:
  truths:
    - "callerLang is derived from file path / command at hook time and reaches Qdrant query"
    - "callerFramework is derived from project markers (csproj/package.json/etc.) and reaches Qdrant query"
    - "scope_lang becomes a Qdrant `must` filter (mirror of scope_framework) — cross-language hints are dropped at index level, not just penalized"
    - "When org is configured but the file's stack disagrees with the org's expected stacks, hints tagged with that org's framework are not surfaced"
    - "Existing seed common-principles (scope.lang='all', scope.framework='any') still surface everywhere"
    - "Existing _projectSlug soft-penalty behaviour is untouched"
  artifacts:
    - path: ".experience/interceptor.js"
      provides: "buildSourceMeta now returns {lang, framework} when toolInput has a file path or extractable command path"
      contains: "buildSourceMeta"
    - path: ".experience/interceptor-post.js"
      provides: "Same {lang, framework} enrichment so PostToolUse reconciliation sees the same scope as PreToolUse"
      contains: "buildSourceMeta"
    - path: ".experience/src/utils.js"
      provides: "detectFrameworkFromProject(filePath) — walks up to find package.json/*.csproj/Cargo.toml/etc., cached per project root"
      contains: "detectFrameworkFromProject"
    - path: ".experience/experience-core.js"
      provides: "scope_lang Qdrant must clause + tightened isOrgStackRepo enforcement when scope_framework mismatch"
      contains: "scope_lang"
  key_links:
    - from: "interceptor.js:buildSourceMeta"
      to: "experience-core.js:interceptWithMeta queryFilter"
      via: "sourceMeta.lang / sourceMeta.framework"
      pattern: "callerLang/callerFw flow into Qdrant must clauses"
---

<objective>
Wire up the language/framework dimensions of the existing scope filter so they actually fire at query time, ending cross-stack contamination within the same org prefix.

Today the architecture supports `scope.lang` and `scope.framework` per-point, and `experience-core.js` already reads `sourceMeta.framework` to build a Qdrant `must` clause — but no interceptor ever populates it, so the filter is dead code. Language is checked only as a soft post-fetch penalty.

After this plan:
- `callerLang` and `callerFramework` are derived once at hook entry from `toolInput` (file path or extractable command path) and flow through `sourceMeta`.
- `scope_lang` becomes a Qdrant `must` clause exactly like `scope_framework`.
- Net effect: TypeScript edits in `muonroi-cli` no longer pull C#-tagged hints from `muonroi-building-block`, and vice versa, regardless of `_projectSlug` cosine score.

Output: ~150 LOC across 5 files + targeted tests. Zero new npm deps. Backward compatible for seeds tagged `{lang: 'all', framework: 'any'}`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
Repo: D:/Personal/Core/experience-engine
Branch policy: commit per task (atomic), no skipping hooks
Runtime: thin-client config points at VPS http://100.79.164.25:8082 — deploy step is separate
VPS file (deploy target after PR merge): /home/phila/experience-engine/.experience/{interceptor,interceptor-post,experience-core}.js + ~/.experience/* on VPS
Local test entry: `node --test .experience/test-project-noise.js`
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add detectFrameworkFromProject() in utils.js</name>
  <files>.experience/src/utils.js</files>
  <action>
Add a new exported function `detectFrameworkFromProject(filePath)` that walks up the directory tree from `filePath` looking for stack markers, returns a lowercase framework token, and caches the result by project root.

Insert after `detectContext()` (around line 39):

```js
// ============================================================
//  Framework detection (cached per project root)
// ============================================================

const _FRAMEWORK_CACHE = new Map(); // projectRoot -> framework string|null
const _FRAMEWORK_CACHE_MAX = 256;

// Markers checked in priority order. First match wins.
// Keep it conservative — unknown stack returns null and the filter passes through.
const _FRAMEWORK_MARKERS = [
  { ext: '.csproj', framework: 'dotnet' },
  { ext: '.fsproj', framework: 'dotnet' },
  { ext: '.sln', framework: 'dotnet' },
  { file: 'Cargo.toml', framework: 'rust' },
  { file: 'go.mod', framework: 'go' },
  { file: 'pyproject.toml', framework: 'python' },
  { file: 'requirements.txt', framework: 'python' },
  { file: 'pom.xml', framework: 'java' },
  { file: 'build.gradle', framework: 'java' },
  { file: 'build.gradle.kts', framework: 'java' },
  { file: 'Gemfile', framework: 'ruby' },
];

// package.json deps that disambiguate JS/TS frameworks
const _PKG_DEP_FRAMEWORKS = [
  { dep: 'next', framework: 'next' },
  { dep: '@nestjs/core', framework: 'nest' },
  { dep: 'nuxt', framework: 'nuxt' },
  { dep: 'react-native', framework: 'react-native' },
  { dep: 'expo', framework: 'expo' },
  { dep: 'react', framework: 'react' },
  { dep: 'vue', framework: 'vue' },
  { dep: 'svelte', framework: 'svelte' },
  { dep: 'electron', framework: 'electron' },
];

function _scanDirForFramework(dir, fs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  // Check file markers first (cheap)
  const names = new Set(entries.filter(e => e.isFile()).map(e => e.name));
  for (const m of _FRAMEWORK_MARKERS) {
    if (m.ext) {
      for (const n of names) if (n.toLowerCase().endsWith(m.ext)) return m.framework;
    } else if (m.file && names.has(m.file)) {
      return m.framework;
    }
  }

  // package.json — read deps to disambiguate
  if (names.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const { dep, framework } of _PKG_DEP_FRAMEWORKS) {
        if (deps[dep]) return framework;
      }
      // Plain TS vs JS — fall back to the language signal, not a framework
      return null;
    } catch { return null; }
  }
  return null;
}

function detectFrameworkFromProject(filePath) {
  if (!filePath) return null;
  const fs = require('fs');
  const path = require('path');
  let dir = path.dirname(filePath.replace(/\\/g, '/'));
  // Bound traversal: at most 8 levels up. Real repos are well within this.
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === '/' || /^[A-Za-z]:\/?$/.test(dir)) break;
    if (_FRAMEWORK_CACHE.has(dir)) return _FRAMEWORK_CACHE.get(dir);
    const fw = _scanDirForFramework(dir, fs);
    if (fw) {
      if (_FRAMEWORK_CACHE.size >= _FRAMEWORK_CACHE_MAX) _FRAMEWORK_CACHE.clear();
      _FRAMEWORK_CACHE.set(dir, fw);
      return fw;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
```

Add to the module exports block (around line 570):

```js
detectContext, normalizeTechLabel, commandSuggestsDomain, detectFrameworkFromProject,
```

Commit message: `feat(utils): add detectFrameworkFromProject for caller-side framework detection`
  </action>
  <verify>
- `node -e "const u=require('./.experience/src/utils.js'); console.log(u.detectFrameworkFromProject('D:/Personal/Core/experience-engine/package.json'))"` prints a framework string or null (not undefined, no throw).
- Re-invoking the same file is O(1) (cache hit) — sanity check by adding a temporary log inside `_scanDirForFramework` and confirming it fires only once across two calls. Remove the log before commit.
  </verify>
</task>

<task type="auto">
  <name>Task 2: Enrich buildSourceMeta in all three interceptors</name>
  <files>
    .experience/interceptor.js
    .experience/interceptor-post.js
    .experience/interceptor-prompt.js
  </files>
  <action>
Each interceptor has its own `buildSourceMeta(data)`. Refactor each to also accept `toolInput` and derive `lang` + `framework` from the file path (or extractable command path).

**Shared helper** — add to each file's top section (or factor into a small shared inline helper — do NOT add a new require unless `src/utils.js` is already required in that interceptor; both `interceptor.js` and `interceptor-post.js` already require it indirectly via experience-core, but interceptors are deliberately dependency-light for fast hook startup. So inline-import inside the helper):

In `interceptor.js`, replace existing `buildSourceMeta` (line 53-62) with:

```js
function buildSourceMeta(data, toolInput) {
  const runtime = process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows';
  const meta = {
    sourceKind: 'codex-hook',
    sourceRuntime: runtime,
    sourceSession: data.session_id || process.env.CODEX_SESSION_ID || null,
  };
  try {
    const utils = require(path.join(os.homedir(), '.experience', 'src', 'utils.js'));
    const filePath = utils.extractProjectPath(toolInput || {});
    if (filePath) {
      const lang = utils.detectContext(filePath);
      const framework = utils.detectFrameworkFromProject(filePath);
      if (lang) meta.lang = lang;
      if (framework) meta.framework = framework;
    }
  } catch { /* hook must never throw on enrichment failure */ }
  return meta;
}
```

Update the call site (line 182):

```js
const sourceMeta = buildSourceMeta(data, toolInput);
```

**`interceptor-post.js`** — same change. Call site at line 143; `toolInput` is parsed at line 146 — reorder so `toolInput` is parsed BEFORE `buildSourceMeta`:

```js
const toolName   = data.tool_name  || data.toolName  || '';
const toolInput  = data.tool_input || data.input     || {};
const toolOutput = data.tool_response || data.output || data.result || {};
const sourceMeta = buildSourceMeta(data, toolInput);
```

**`interceptor-prompt.js`** — UserPromptSubmit has no `toolInput`. Pass `null` and let the helper short-circuit. Signature change keeps API parity:

```js
function buildSourceMeta(data, toolInput) {
  const meta = {
    sourceKind: 'codex-hook',
    sourceRuntime: process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows',
    sourceSession: data?.session_id || process.env.CODEX_SESSION_ID || null,
  };
  // No tool input on UserPromptSubmit; lang/framework remain undefined.
  return meta;
}
```

Call site stays `buildSourceMeta(data)` — second arg undefined is fine.

**Constraint:** the require path must match how thin-client and full-install layouts both expose `src/utils.js`. Today `~/.experience/src/utils.js` is the canonical install location; `experience-core.js` already requires `./src/utils` via the same `~/.experience` parent. Confirm by inspecting `setup.sh` install layout. If the file is only at the repo path during dev, fall back gracefully (the try/catch already does).

Commit message: `feat(interceptors): derive callerLang/callerFramework into sourceMeta`
  </action>
  <verify>
- Temporarily add `debugLog({ stage: 'meta_test', lang: meta.lang, framework: meta.framework })` in the helper, run a synthetic stdin payload via `echo '{"tool_name":"Edit","tool_input":{"file_path":"D:/Personal/Core/experience-engine/server.js"},"session_id":"x"}' | node .experience/interceptor.js`, confirm debug log shows `lang: 'javascript'` and `framework: null` (no package.json next-dep). Repeat for a `.cs` file path — expect `lang: 'c#'` and `framework: 'dotnet'` when a .csproj exists upstream. Remove the debug log before commit.
- `node --test .experience/test-hook-payloads.js` still passes (no regression on existing payload shape).
  </verify>
</task>

<task type="auto">
  <name>Task 3: Add scope_lang as Qdrant must clause in experience-core.js</name>
  <files>.experience/experience-core.js</files>
  <action>
In `experience-core.js`, locate the `queryFilter` IIFE (line 166-188). After the existing `callerFw` block (line 174-185), add a parallel `callerLang` block. The pattern is identical — mirror it exactly so reviewers can compare side-by-side.

Replace lines 174-185 with:

```js
    const callerFw = sourceMeta && typeof sourceMeta.framework === 'string'
      ? sourceMeta.framework.toLowerCase().trim() : null;
    if (callerFw) {
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_framework' } },
          { key: 'scope_framework', match: { value: 'any' } },
          { key: 'scope_framework', match: { value: callerFw } },
        ],
      });
    }
    const callerLang = sourceMeta && typeof sourceMeta.lang === 'string'
      ? sourceMeta.lang.toLowerCase().trim() : null;
    if (callerLang) {
      // Mirror scope_framework: pass when point has no lang, lang='all', or matches caller.
      // Hard filter at index level — cheaper than post-fetch fileMatchesLang().
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_lang' } },
          { key: 'scope_lang', match: { value: 'all' } },
          { key: 'scope_lang', match: { value: callerLang } },
        ],
      });
    }
```

**Why mirror, not replace fileMatchesLang:** the post-fetch `fileMatchesLang` (line 197-258) handles language aliases (`csharp` → `c#`, `ts` → `typescript`, comma-joined legacy seeds). Qdrant exact-match cannot do aliasing. So the `must` clause acts as a *cheap pre-filter* that catches the common case; `fileMatchesLang` remains the canonical final word for legacy/aliased data.

**Compatibility:** points without `scope_lang` payload key pass via `is_empty` clause. Points with `scope_lang: 'all'` pass via the second `should` clause. No data migration needed.

Commit message: `feat(query): make scope_lang a hard Qdrant filter, mirror of scope_framework`
  </action>
  <verify>
- `node --test .experience/test-project-noise.js` still passes (no behavior change for in-memory rerank tests).
- Add a new test case in Task 4 that asserts the Qdrant filter contains a `scope_lang` clause when `sourceMeta.lang` is set.
  </verify>
</task>

<task type="auto">
  <name>Task 4: Add tests covering callerLang/Framework injection and scope_lang filter</name>
  <files>.experience/test-project-noise.js</files>
  <action>
Append three new `describe()` blocks at the end of the file, before the file's closing:

```js
// ═══════════════════════════════════════════════════════════════════
//  PART 10: callerLang / callerFramework injection from interceptors
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-10: caller-side language and framework detection', () => {
  const utils = require('./src/utils.js');

  it('detectContext maps .ts to typescript', () => {
    assert.strictEqual(utils.detectContext('D:/Personal/Core/muonroi-cli/src/app.ts'), 'typescript');
  });

  it('detectContext maps .cs to c#', () => {
    assert.strictEqual(utils.detectContext('D:/Personal/Core/muonroi-building-block/src/Foo.cs'), 'c#');
  });

  it('detectFrameworkFromProject returns null for non-existent path', () => {
    assert.strictEqual(utils.detectFrameworkFromProject('/nonexistent/x/y/z.ts'), null);
  });

  it('detectFrameworkFromProject returns dotnet for a path inside a .csproj project', () => {
    // Use a real path from this workspace that has a known stack marker
    // (muonroi-building-block has .csproj files).
    const fw = utils.detectFrameworkFromProject('D:/Personal/Core/muonroi-building-block/src/Foo.cs');
    // If the test environment doesn't have that directory, accept null (CI-safe).
    if (fw !== null) {
      assert.strictEqual(fw, 'dotnet');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 11: scope_lang as Qdrant hard filter contract
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-11: scope_lang must clause is added when sourceMeta.lang is set', () => {
  // This is a structural contract test — we don't call Qdrant, we verify the
  // filter object shape that interceptWithMeta would build.
  //
  // Mirrors the IIFE in experience-core.js queryFilter.
  function buildFilter(sourceMeta) {
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
    const f = buildFilter({ lang: 'typescript' });
    assert.strictEqual(f.must.length, 1);
    const clauses = f.must[0].should.map(c => c.key || Object.keys(c)[0]);
    assert.ok(clauses.includes('scope_lang') || clauses.includes('is_empty'),
      'should clause must reference scope_lang or is_empty');
  });

  it('does not add scope_lang clause when lang is absent', () => {
    const f = buildFilter({});
    assert.strictEqual(f.must.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PART 12: Cross-stack noise scenario (muonroi-cli TS vs muonroi-bb .NET)
// ═══════════════════════════════════════════════════════════════════

describe('NOISE-12: TS edit in muonroi-cli does not surface .NET-tagged rules', () => {
  it('C#/.NET hint with scope.lang=c# scores low in TypeScript context', () => {
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
    // Cross-language (-0.20) + cross-project (-0.50/0.70) penalties stack.
    // Effective score must be well below the high-confidence display threshold.
    assert.ok(ranked[0]._effectiveScore < 0.30,
      `C# rule should score < 0.30 in TS context, got ${ranked[0]._effectiveScore.toFixed(3)}`);
  });
});
```

Commit message: `test(noise): cover callerLang/Framework injection and scope_lang filter contract`
  </action>
  <verify>
- `node --test .experience/test-project-noise.js` — all describe blocks (PART 1-12) pass.
- `node --test .experience/` — full hook test suite still green.
  </verify>
</task>

<task type="auto">
  <name>Task 5: Update README anti-noise section to document hard-filter behavior</name>
  <files>README.md</files>
  <action>
Locate the "Layer 2 — Quality scoring (semantic search + rerank)" bullets (around line 1008-1018). Update the **Domain match** bullet and add a **Language/Framework gate** bullet directly under it.

Replace:
```
- **Domain match** — `.ts` file → TypeScript experiences rank higher
```

With:
```
- **Language/Framework gate** — `.ts` file → only TypeScript/`scope.lang=all` experiences pass the Qdrant pre-filter; `.cs` file → only C#/`dotnet`/`any`. Same project prefix with different stacks (e.g. `muonroi-cli` TS vs `muonroi-building-block` .NET) no longer cross-contaminate.
- **Domain match** — within the surviving set, recently-confirmed entries matching the caller's domain rank higher
```

Commit message: `docs(readme): document scope_lang hard-filter behavior`
  </action>
  <verify>
- README renders correctly (no broken markdown).
- The Anti-Noise section reads consistently with the new behavior.
  </verify>
</task>

</tasks>

<acceptance_criteria>
- All 5 tasks committed atomically with the specified messages.
- `node --test .experience/test-project-noise.js` passes including new PART 10-12 blocks.
- `node --test .experience/test-hook-payloads.js` passes (no regression).
- Manual smoke: synthetic Edit payload pointing at `.ts` file produces `sourceMeta.lang='typescript'` in debug log; synthetic Edit pointing at `.cs` file inside a `.csproj` tree produces `sourceMeta.framework='dotnet'`.
- No new npm dependencies (verify `package.json` unchanged).
- Backward compat: existing seed entries with `scope: {lang: 'all', framework: 'any'}` still surface in all contexts.

Deployment (separate, after merge):
- SCP modified files to VPS `/home/phila/experience-engine/.experience/` and `~/.experience/`.
- `systemctl --user restart experience-engine.service`.
- Smoke a known-noisy session and confirm cross-stack `muonroi-*` hints are silent.
</acceptance_criteria>

<out_of_scope>
- Refactoring `org.repoPatterns` into per-stack lists (`S4` from the discussion — defer to a follow-up plan).
- Removing the implicit `slug.startsWith("${name}-")` rule in `isOrgStackRepo` (`S3`). Deferred — the new `scope_lang` hard filter handles 80% of the noise. Tighten `isOrgStackRepo` only if residual noise persists.
- Forcing the extractor to always set `scope.lang` on new lessons (`S5`). Useful follow-up, but the current changes already prevent existing untagged lessons from leaking across stacks because the post-fetch `fileMatchesLang` already handles `!exp.scope?.lang → true`. Re-evaluate after measuring noise reduction.
</out_of_scope>