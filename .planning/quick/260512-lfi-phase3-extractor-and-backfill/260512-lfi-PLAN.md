---
phase: quick
plan: 260512-lfi-p3
type: execute
wave: 3
depends_on: [260512-lfi-phase2-framework-dep-detection]
files_modified:
  - .experience/stop-extractor.js
  - .experience/src/intercept.js
  - .experience/src/brain-llm.js
  - .experience/src/format.js
  - server.js
  - tools/exp-backfill-scope.js (new)
  - .experience/test-project-noise.js
autonomous: true
---

<objective>
Make NEW hints get correctly tagged with scope.framework + scope.lang at extraction time, and provide a tool to backfill EXISTING brain hints (LLM-classified, dry-run by default).

Phase 1+2 fixed the query side. Hints already on the VPS brain are still mostly tagged scope.framework='any' so they keep surfacing in unrelated projects. Two halves are needed to close the loop:
  - Part B (this plan): future hints carry the right scope from the moment they are extracted
  - Part C (this plan): a tool that LLM-classifies existing hints and updates their scope tags, with --dry-run as the default safety net
</objective>

<tasks>

<task type="auto">
  <name>Task 1: Plumb framework/lang from client through /api/extract</name>
  <files>.experience/stop-extractor.js, server.js, .experience/src/intercept.js</files>
  <action>
- stop-extractor.js: enrich the /api/extract body with `framework` and `lang` derived from projectPath via source-meta-enrich.enrichSourceMeta({ file_path: projectPath }). Best-effort: if enrichment fails, omit fields (server already tolerates missing).
- server.js handleExtract: forward `framework` and `lang` into the meta object passed to extractFromSession.
- intercept.js extractFromSession: thread meta.framework / meta.lang to extractQA via a new opts arg.

Keep meta optional — passing nothing must keep current behavior.

Commit: `feat(extract): plumb framework/lang context from client to extractor`
  </action>
</task>

<task type="auto">
  <name>Task 2: Update extractQA prompt to classify scope.framework</name>
  <files>.experience/src/brain-llm.js, .experience/src/format.js</files>
  <action>
- brain-llm.js extractQA: accept opts { framework, lang, projectSlug }. Inject project context into the prompt and require scope.framework in the response. Allowed values: 'any' (default) or a framework label provided in opts.framework. Add explicit rule:
  "Use scope.framework='any' unless the lesson references identifiers/types/packages specific to a framework. If opts.framework is provided AND the lesson is about that framework's API, set scope.framework=<opts.framework>."
- format.js buildStorePayload: ensure qa.scope.framework round-trips into the stored payload (already does via qa.scope spread); also ensure evolution.js indexing picks up the new field (already does at evolution.js:646).

Commit: `feat(extract): classify scope.framework using project context`
  </action>
</task>

<task type="auto">
  <name>Task 3: Backfill tool tools/exp-backfill-scope.js</name>
  <files>tools/exp-backfill-scope.js (new)</files>
  <action>
Standalone Node script that:
- Scans all points in COLLECTIONS via Qdrant scroll API (config from ~/.experience/config.json)
- For each point missing scope.framework or with scope.framework='any', sends trigger+solution+_projectSlug to brain LLM with a classification prompt
- LLM returns one of: 'any' or a specific framework label drawn from a `--known-frameworks` list provided at runtime (no hardcoded labels in the tool)
- Default mode: DRY-RUN. Prints proposed changes; writes nothing.
- With `--apply`: updates point payload via Qdrant set-payload API
- `--limit N`, `--collection X`, `--rate-ms N` flags
- Logs every decision to a JSONL audit file

Commit: `feat(tools): exp-backfill-scope.js to LLM-tag existing hints (dry-run default)`
  </action>
</task>

<task type="auto">
  <name>Task 4: Tests for opts pass-through</name>
  <files>.experience/test-project-noise.js</files>
  <action>
Add PART 14: extract opts wiring contract — verify extractQA accepts opts and stores scope.framework when provided.

Commit: `test(noise): cover scope.framework extractor classifier`
  </action>
</task>

</tasks>

<acceptance_criteria>
- /api/extract body accepts optional framework/lang; old clients without those fields still work.
- New hints extracted after deploy carry scope.framework based on project context.
- Backfill tool runs DRY-RUN by default. --apply is gated behind explicit flag.
- All tests pass.
</acceptance_criteria>

<out_of_scope>
- Running --apply against live VPS brain. User must confirm before that.
- Migrating older bulk-imported seeds with no projectSlug.
</out_of_scope>