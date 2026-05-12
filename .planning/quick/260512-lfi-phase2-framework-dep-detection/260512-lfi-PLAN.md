---
phase: quick
plan: 260512-lfi-p2
type: execute
wave: 2
depends_on: [260512-lfi-language-isolation-hard-filter]
files_modified:
  - .experience/source-meta-enrich.js
  - .experience/test-project-noise.js
autonomous: true
requirements: [EE-NOISE-FRAMEWORK-DEPENDENCY]
must_haves:
  truths:
    - "A .NET project depending on any Muonroi.* NuGet package is detected as framework='muonroi-building-block', not generic 'dotnet'"
    - "A .NET project with NO Muonroi.* reference is still detected as 'dotnet'"
    - "A JS/TS project depending on any @muonroi/* npm package is detected as framework='muonroi-building-block'"
    - "Detection is cached per project root (same LRU as Phase 1)"
    - "Plain language hints (framework:'any') still surface in all .NET projects"
  artifacts:
    - path: ".experience/source-meta-enrich.js"
      provides: "Two-step framework detection: marker (.csproj/.sln/package.json) THEN dependency content scan"
      contains: "muonroi-building-block"
---

<objective>
Distinguish `dotnet` (generic .NET) from `muonroi-building-block` (.NET project that consumes Muonroi.* NuGet packages). Same for JS/TS via `@muonroi/*` npm scope.

After this plan, a hint tagged `scope.framework: muonroi-building-block` on the VPS brain will only surface in projects that actually depend on a Muonroi.* package. A vanilla `dotnet` project (no Muonroi deps) sees only `scope.framework ∈ {any, dotnet}` hints.

This closes the second leak: even after Phase 1 cut cross-language noise, all .NET projects were still receiving BB-specific hints because the framework filter only distinguished by language family.
</objective>

<context>
Brain data caveat: existing hints on VPS are mostly tagged `scope.framework: 'any'` and will keep surfacing in BB consumer projects (correct) and plain .NET projects (incorrect). This plan only fixes the CLIENT-side detection.

Part B (extractor classifier so future hints get the right framework tag) and Part C (LLM-assisted backfill of existing hints) are deferred to Phase 3 — they touch shared VPS state and need explicit confirmation before execution.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Two-step .NET framework detection in source-meta-enrich.js</name>
  <files>.experience/source-meta-enrich.js</files>
  <action>
Refactor `scanDirForFramework` so the .NET case parses .csproj content for Muonroi.* package references. If found, return `'muonroi-building-block'`; otherwise return generic `'dotnet'`.

Apply the same disambiguation for package.json: when any dep name starts with `@muonroi/`, return `'muonroi-building-block'` before the next/nest/etc. checks (so a Muonroi.* consumer that also has react in deps still classifies as BB consumer).

Add small constants near the existing marker arrays:

```js
const MUONROI_NUGET_PREFIX = 'Muonroi.';
const MUONROI_NPM_SCOPE = '@muonroi/';
const MUONROI_FRAMEWORK = 'muonroi-building-block';
```

Replace `scanDirForFramework`. Key changes:

1. When a `.csproj`/`.fsproj`/`.sln` is found, read each one and scan for `Include="Muonroi.*"` package references. Bound the read to a reasonable size cap (e.g. 64KB) to keep hot path fast.
2. When `package.json` is found, check `@muonroi/*` deps FIRST, before the existing `PKG_DEP_FW` list.

Caching: keep the existing `FW_CACHE` keyed by dir, but cache the refined result (`muonroi-building-block` vs `dotnet`) so the disk scan happens once per project.

Commit message: `feat(enrich): detect muonroi-building-block via NuGet/npm dep scan`
  </action>
  <verify>
- `node -e "const e=require('./.experience/source-meta-enrich.js'); console.log('BB lib:', e.detectFrameworkFromProject('D:/Personal/Core/muonroi-building-block/src/Foo.cs'));"` → prints `BB lib: muonroi-building-block` (the BB repo itself depends on its own packages, or at minimum has Muonroi.* csproj names).
- Same call against a plain .NET test project (any non-Muonroi .csproj) prints `dotnet`.
- Repeated calls hit the cache (no second disk scan).
  </verify>
</task>

<task type="auto">
  <name>Task 2: Add tests for framework-dependency detection</name>
  <files>.experience/test-project-noise.js</files>
  <action>
Append a new PART 13 covering:

- `.csproj` referencing `Muonroi.BuildingBlock` (or any Muonroi.*) → `'muonroi-building-block'`
- `.csproj` with only Microsoft.* deps → `'dotnet'`
- `package.json` with `@muonroi/cli` dep → `'muonroi-building-block'` (BB consumer beats next/react)
- `package.json` with only `react` → `'react'` (unchanged from Phase 1)
- Cache works: second call same project root is fast and consistent

Use temp directories + `fs.writeFileSync` to fabricate fixtures so tests don't depend on the real workspace layout.

Commit message: `test(noise): cover muonroi-building-block detection via dep scan`
  </action>
  <verify>
- `node --test .experience/test-project-noise.js` — all tests (PART 1-13) pass.
  </verify>
</task>

</tasks>

<acceptance_criteria>
- BB consumer projects (muonroi-building-block, muonroi-control-plane, muonroi-ui-engine, muonroi-license-server) detect as `framework='muonroi-building-block'`.
- Plain .NET test projects detect as `framework='dotnet'`.
- All Phase 1 tests still pass; PART 13 added.
- Cache hot-path performance unchanged.
</acceptance_criteria>

<out_of_scope>
- Part B (extractor classifier) — Phase 3. Brain prompt change.
- Part C (VPS backfill of existing hints) — Phase 3. Touches shared state.
- Adding more framework detections (Spring Boot, Django, etc.) — not requested.
</out_of_scope>