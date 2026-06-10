#!/usr/bin/env node
/**
 * experience-core.js — Thin facade for Experience Engine modules.
 * Used by Claude Code, Gemini CLI, and Codex CLI hooks.
 * Zero npm dependencies. Node.js 20 native fetch only.
 *
 * API:
 *   intercept(toolName, toolInput, signal) → string | null
 *   extractFromSession(sessionLog)        → void (stores to Qdrant)
 *   getEmbeddingRaw(text, signal)         → number[] | null
 *
 * All logic lives in src/ modules. This file re-exports the public API.
 */

'use strict';

const _config = require('./src/config');
const _embedding = require('./src/embedding');
const _utils = require('./src/utils');
const _qdrant = require('./src/qdrant');
const _session = require('./src/session');
const _context = require('./src/context');
const _scoring = require('./src/scoring');
const _noise = require('./src/noise');
const _brainllm = require('./src/brain-llm');
const _format = require('./src/format');
const _graph = require('./src/graph');
const _evolution = require('./src/evolution');
const _router = require('./src/router');
const _activity = require('./src/activity');
const _hittrack = require('./src/hittrack');
const _intercept = require('./src/intercept');
const _brief = require('./src/brief');
const _fusion = require('./src/fusion');

// Wire the config-level activityLog stub to the real file logger. config.js
// exposes activityLog as a setter-guarded no-op (to avoid a require cycle with
// activity.js); modules that log through ./config — notably src/embedding.js
// logCostCall('embed', …) — silently drop their events until this runs. Without
// it, no embed cost-calls are ever written and /health embed status is stuck at
// "unknown". experience-core is the shared entry the server loads, so wiring
// here covers every server-side embedding path.
_config.setActivityLog(_activity.activityLog);

// --- Constants ---
const { COLLECTIONS, EDGE_COLLECTION } = _intercept;

const EXP_USER = _config.EXP_USER;

// --- Brain fallback chain ---
const BRAIN_FNS = {
  ollama: _brainllm.brainOllama, openai: _brainllm.brainOpenAI, gemini: _brainllm.brainGemini,
  claude: _brainllm.brainClaude, deepseek: _brainllm.brainDeepSeek,
  siliconflow: _brainllm.brainOpenAI, custom: _brainllm.brainOpenAI,
};

async function callBrainWithFallback(prompt, meta = {}) {
  const brainProvider = _config.getBrainProvider();
  const fallbackProvider = _brainllm.getBrainFallback();
  const primary = BRAIN_FNS[brainProvider] || BRAIN_FNS.ollama;
  const units = _activity.estimateTextUnits(prompt, 4000);
  const timeoutMs = Number(meta.timeoutMs ?? 0);
  const signal = meta.signal || (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

  let startedAt = Date.now();
  let result = await primary(prompt, { signal });
  _activity.logCostCall('brain', brainProvider, meta.source || 'general', units, { ok: !!result, phase: 'primary', durationMs: Date.now() - startedAt });
  if (result) return result;

  _activity.activityLog({ op: 'brain-failure', provider: brainProvider, phase: 'primary' });
  if (fallbackProvider && BRAIN_FNS[fallbackProvider]) {
    startedAt = Date.now();
    result = await BRAIN_FNS[fallbackProvider](prompt, { signal });
    _activity.logCostCall('brain', fallbackProvider, meta.source || 'general', units, { ok: !!result, phase: 'fallback', durationMs: Date.now() - startedAt });
    if (result) { _activity.activityLog({ op: 'brain-fallback', provider: fallbackProvider }); return result; }
    _activity.activityLog({ op: 'brain-failure', provider: fallbackProvider, phase: 'fallback' });
  }
  return null;
}

// --- interceptWithMeta: main entry point ---

async function interceptWithMeta(toolName, toolInput, signal, meta, options) {
  const sourceMeta = _utils.normalizeSourceMeta(meta);
  const runtime = _utils.resolveRuntimeFromSourceMeta(sourceMeta, _utils.detectRuntime(toolName));
  const hookRealtimeFastPath = _intercept.isHookRealtimeFastPath(toolName, sourceMeta);
  const skipRoute = !!(options && options.skipRoute);
  // Active recall (semantic-search mode): rank by raw cosine and drop the
  // passive-hint noise-control gates (positive scope filters + min-search-score
  // floor). Integrity gates (superseded / permanent-noise / irrelevant / learned
  // exclusions / min-confidence) remain in force. See /api/recall (server.js).
  const recallMode = !!(options && options.recallMode);
  if (_intercept.isReadOnlyCommand(toolName, toolInput)) return { suggestions: null, surfacedIds: [] };

  const query = _utils.buildQuery(toolName, toolInput);
  const filePath = toolInput?.file_path || toolInput?.path || _utils.extractProjectPath(toolInput) || '';
  const queryDomain = _utils.detectContext(filePath);
  const queryProjectSlug = (sourceMeta && typeof sourceMeta.project_slug === 'string' && sourceMeta.project_slug.trim() ? sourceMeta.project_slug.toLowerCase().trim() : null) || _utils.extractProjectSlug(filePath) || null;
  const actionKind = _intercept.classifyActionKind(toolName, toolInput || {}, filePath);
  const vector = await _embedding.getEmbedding(query, signal);
  if (!vector) return null;

  const routePromise = !hookRealtimeFastPath && !skipRoute && _router.isRouterEnabled()
    ? _router.routeModel(query, { files: [filePath].filter(Boolean), domain: queryDomain }, runtime).catch(() => null)
    : Promise.resolve(null);

  // Pre-filter at Qdrant index level so top-K isn't wasted on points the
  // post-filter would drop. Critical for foreign-repo intercepts where the
  // brain is org-doc-dominated — without this, top-2 principles can be 100%
  // org-doc, all dropped, leaving zero surfaces despite common-doc existing.
  // Active recall: no index-level scope pre-filter. The passive-hint pipeline
  // restricts the Qdrant search to matching scope_lang/scope_project_slug/
  // scope_framework BEFORE fetch — which would drop cross-repo / cross-language
  // lessons before the relaxed post-filter (applyScopeFilter recall branch) and
  // raw-cosine ranking ever see them. User isolation is still enforced inside
  // searchCollection (buildQdrantUserFilter), independent of this extraFilter.
  const queryFilter = recallMode ? undefined : (() => {
    const orgCfg = _config.getConfig().org;
    const orgName = orgCfg && typeof orgCfg.name === 'string' ? orgCfg.name.trim().toLowerCase() : '';
    const fileIsOrgStack = orgName ? _utils.isOrgStackRepo(filePath, orgCfg) : false;
    const extra = { must: [], must_not: [], should: [] };
    if (orgName && filePath && filePath.length > 1 && !fileIsOrgStack && !filePath.startsWith("/tmp")) {
      // org filter removed — single-org brain
    }
    const callerFw = sourceMeta && typeof sourceMeta.framework === 'string'
      ? sourceMeta.framework.toLowerCase().trim() : null;
    if (callerFw) {
      // Allow points without scope_framework, points tagged 'any', or matching framework.
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_framework' } },
          { key: 'scope_framework', match: { value: 'any' } },
          { key: 'scope_framework', match: { value: callerFw } },
        ],
      });
    }
    // Mirror scope_framework for scope_lang. Hard index-level filter eliminates
    // most cross-language hints up-front; the post-fetch fileMatchesLang()
    // remains the canonical alias-aware authority for legacy/comma-joined seeds.
    const callerLang = sourceMeta && typeof sourceMeta.lang === 'string'
      ? sourceMeta.lang.toLowerCase().trim() : null;
    if (callerLang) {
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_lang' } },
          { key: 'scope_lang', match: { value: 'all' } },
          ...(((lang) => { const fam = ["javascript", "typescript", "ts", "tsx", "js", "jsx", "node", "nodejs"]; const vals = fam.includes(lang) ? ["javascript", "typescript"] : [lang]; return [...new Set(vals)].map((v) => ({ key: "scope_lang", match: { value: v } })); })(callerLang)),
        ],
      });
    }
    // Mirror for project_slug. The flat `scope_project_slug` is written by
    // buildScopeFlatFields for new entries + entries with legacy _projectSlug
    // at root. Untagged points still surface (is_empty branch) until backfill
    // populates them — gate becomes strict once project_slug coverage is high.
    const callerProjectSlug = sourceMeta && typeof sourceMeta.project_slug === 'string'
      ? sourceMeta.project_slug.toLowerCase().trim() : null;
    if (callerProjectSlug) {
      extra.must.push({
        should: [
          { is_empty: { key: 'scope_project_slug' } },
          { key: 'scope_project_slug', match: { value: callerProjectSlug } },
        ],
      });
    }
    const hasAny = extra.must.length || extra.must_not.length || extra.should.length;
    return hasAny ? extra : undefined;
  })();

  // Active recall casts a wider net (recallTopK) than precision-tuned passive
  // hints (topK), because recall drops the score floor and fuses a lexical leg.
  const tkFor = (i) => (recallMode ? (COLLECTIONS[i].recallTopK || COLLECTIONS[i].topK) : COLLECTIONS[i].topK);

  const searchResults = await Promise.all([
    _qdrant.searchCollection(COLLECTIONS[0].name, vector, tkFor(0), signal, queryFilter),
    _qdrant.searchCollection(COLLECTIONS[1].name, vector, tkFor(1), signal, queryFilter),
    _qdrant.searchCollection(COLLECTIONS[2].name, vector, tkFor(2), signal, queryFilter),
    routePromise,
  ]);
  let t0 = searchResults[0], t1 = searchResults[1], t2 = searchResults[2];
  const routeResult = searchResults[3];

  // Hybrid recall (recall only): run a lexical full-text leg alongside the
  // dense-vector leg and fuse per collection with Reciprocal Rank Fusion, so an
  // experience that matches strongly on EITHER semantics OR exact terms
  // surfaces. Passive hints stay vector-only + precision-gated. The lexical leg
  // degrades to [] if the text index is missing, so this never breaks recall.
  if (recallMode) {
    const [lx0, lx1, lx2] = await Promise.all([
      _qdrant.searchCollectionLexical(COLLECTIONS[0].name, query, tkFor(0), signal, queryFilter),
      _qdrant.searchCollectionLexical(COLLECTIONS[1].name, query, tkFor(1), signal, queryFilter),
      _qdrant.searchCollectionLexical(COLLECTIONS[2].name, query, tkFor(2), signal, queryFilter),
    ]);
    t0 = _fusion.hybridFuse(t0, lx0, query);
    t1 = _fusion.hybridFuse(t1, lx1, query);
    t2 = _fusion.hybridFuse(t2, lx2, query);
  }

  // Collections whose seeds are language/framework-specific. For these we
  // enforce strict scope: unscoped hints, mismatched lang, mismatched
  // framework, or mismatched project_slug all get dropped. Without this,
  // 92% C# behavioral seeds (1337/1442) leaked into non-C# repos because
  // the legacy filter's `is_empty` pass let unscoped seeds + framework=any
  // surface for any caller. `experience-principles` is intentionally
  // generic — kept permissive.
  const STRICT_SCOPE_COLLECTIONS = new Set(['experience-behavioral', 'experience-selfqa']);

  function applyScopeFilter(points, collectionName) {
    const callerLang = sourceMeta && typeof sourceMeta.lang === 'string'
      ? sourceMeta.lang.toLowerCase().trim() : null;
    const callerProjectSlug = sourceMeta && typeof sourceMeta.project_slug === 'string'
      ? sourceMeta.project_slug.toLowerCase().trim() : null;
    // Bail entirely only when neither filePath nor callerLang is known —
    // otherwise foreign-language hints leak through for Bash/UserPromptSubmit
    // hooks (no filePath) and the Qdrant pre-filter cannot help because
    // scope_lang is stored nested inside payload.json, not as a flat key.
    // For STRICT collections (behavioral/selfqa), zero caller context is
    // worst case: every cross-language seed surfaces. Drop the entire
    // strict-collection batch and keep only the permissive principles
    // collection visible until the caller provides scope.
    if (!recallMode && !filePath && !callerLang) {
      return STRICT_SCOPE_COLLECTIONS.has(collectionName || '') ? [] : points;
    }
    const fileExt = filePath ? (filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() || '') : '';
    const JS_FAMILY = new Set(['ts', 'tsx', 'js', 'jsx']);
    const CSS_FAMILY = new Set(['css', 'scss', 'less', 'sass']);
    const CS_FAMILY = new Set(['cs', 'fs']);
    const LANG_ALIAS = {
      csharp: 'c#', 'c-sharp': 'c#', dotnet: 'c#', '.net': 'c#',
      fsharp: 'f#',
      ts: 'typescript', tsx: 'typescript',
      js: 'javascript', jsx: 'javascript', nodejs: 'javascript', node: 'javascript',
    };
    const callerLangNorm = callerLang ? (LANG_ALIAS[callerLang] || callerLang) : null;
    // Active recall: pure semantic mode. Skip the positive lang/framework/project
    // gates entirely; honor only learned exclusions (evolve Step 3d scope
    // narrowing from confirmed noise). Cross-repo / cross-language lessons are
    // allowed to surface and are ranked by raw cosine upstream. Superseded /
    // permanent-noise / irrelevant entries are still dropped by formatPoints.
    if (recallMode) {
      return points.filter(p => {
        try {
          const exp = JSON.parse(p.payload?.json || '{}');
          if (Array.isArray(exp.scope?.lang_exclude) && callerLang) {
            const ex = exp.scope.lang_exclude.map(x => String(x).toLowerCase().trim());
            if (ex.includes(callerLang) || ex.includes(callerLangNorm)) return false;
          }
          if (Array.isArray(exp.scope?.project_exclude) && callerProjectSlug) {
            const ex = exp.scope.project_exclude.map(x => String(x).toLowerCase().trim());
            if (ex.includes(callerProjectSlug)) return false;
          }
          return true;
        } catch (err) {
          // Fail-open: a malformed payload must not vanish from recall. Keep + log.
          _activity.activityLog({ op: 'recall-scope-parse-fail', id: p?.id, collection: collectionName, error: err?.message });
          return true;
        }
      });
    }
    function fileMatchesLang(scopeLang) {
      if (!scopeLang) return true;
      // Comma-joined seeds (legacy data) → match if ANY token matches.
      const raw = String(scopeLang).toLowerCase().trim();
      if (raw === 'all') return true;
      const tokens = raw.split(/[,/|]/).map(t => t.trim()).filter(Boolean);
      if (tokens.length > 1) return tokens.some(t => fileMatchesLang(t));
      let sl = tokens[0] || raw;
      if (LANG_ALIAS[sl]) sl = LANG_ALIAS[sl];
      // Caller-supplied lang takes precedence when no file extension is
      // available (Bash/UserPromptSubmit hooks). Direct string compare —
      // both sides already aliased.
      if (!filePath && callerLangNorm) {
        const JS_FAM = new Set(["javascript", "typescript"]);
        if (JS_FAM.has(sl) && JS_FAM.has(callerLangNorm)) return true;
        return sl === callerLangNorm;
      }
      if (sl === 'c#') return CS_FAMILY.has(fileExt);
      if (sl === 'javascript' || sl === 'typescript') return JS_FAMILY.has(fileExt);
      if (sl === 'css') return CSS_FAMILY.has(fileExt);
      if (filePath) {
        const detected = (_utils.detectContext(filePath) || '').toLowerCase();
        return detected === sl || detected.startsWith(sl);
      }
      return true;
    }
    // Caller-provided framework hint (e.g. PreToolUse hook that inspected csproj/package.json).
    // Filter is opt-in: when absent, framework dimension passes through. Avoids fragile
    // path-pattern detection inside the hot path while still letting future callers narrow.
    const callerFramework = sourceMeta && typeof sourceMeta.framework === 'string'
      ? sourceMeta.framework.toLowerCase().trim() : null;
    const isStrict = STRICT_SCOPE_COLLECTIONS.has(collectionName || '');
    return points.filter(p => {
      try {
        const exp = JSON.parse(p.payload?.json || '{}');
        // Framework gate (opt-in): when caller asserts a framework AND the hint is tagged
        // to a different specific framework, drop. 'any' / undefined on the hint passes.
        if (callerFramework && exp.scope?.framework) {
          const hintFw = String(exp.scope.framework).toLowerCase().trim();
          if (hintFw && hintFw !== 'any' && hintFw !== callerFramework) return false;
        }
        // Project gate: when both sides carry a project_slug AND they differ,
        // drop. Catches cross-repo leakage even when lang/framework agree
        // (e.g., two TypeScript Muonroi repos with different patterns).
        const pointProjectSlug = exp.scope?.project_slug || exp.scope?.projectSlug || null;
        if (callerProjectSlug && pointProjectSlug) {
          const hintSlug = String(pointProjectSlug).toLowerCase().trim();
          if (hintSlug && hintSlug !== callerProjectSlug) return false;
        }
        // Learned exclusion gates (populated by evolve Step 3d scope narrowing
        // from noiseContextHistory). Drop when caller lang/project appears in
        // the entry's exclusion list.
        if (Array.isArray(exp.scope?.lang_exclude) && callerLang) {
          const excludes = exp.scope.lang_exclude.map((x) => String(x).toLowerCase().trim());
          if (excludes.includes(callerLang) || excludes.includes(callerLangNorm)) return false;
        }
        if (Array.isArray(exp.scope?.project_exclude) && callerProjectSlug) {
          const excludes = exp.scope.project_exclude.map((x) => String(x).toLowerCase().trim());
          if (excludes.includes(callerProjectSlug)) return false;
        }
        // Lang gate. In STRICT collections (behavioral, selfqa) we require
        // an explicit lang scope: unscoped seeds in those collections are
        // legacy/cross-context bleed (1337/1442 behavioral seeds are C#,
        // unscoped seeds are statistically near-certain wrong_repo). In
        // permissive collections (principles) unscoped passes — they are
        // intentional cross-cutting principles.
        if (!exp.scope?.lang) {
          if (isStrict && callerLang) return false;
          return true;
        }
        return fileMatchesLang(exp.scope.lang);
      } catch { return true; }
    });
  }

  // Recall: preserve the RRF-fused order (hybridFuse already ranked); passive
  // hints use the penalty-weighted effective-score sort.
  const rankOpts = recallMode ? { preserveOrder: true } : {};
  let r0 = _utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t0, COLLECTIONS[0].name), queryDomain, queryProjectSlug, query, rankOpts), COLLECTIONS[0].name);
  let r1 = _utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t1, COLLECTIONS[1].name), queryDomain, queryProjectSlug, query, rankOpts), COLLECTIONS[1].name);
  let r2 = _scoring.selectProbationaryT2Points(_utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t2, COLLECTIONS[2].name), queryDomain, queryProjectSlug, query, rankOpts), COLLECTIONS[2].name));

  let promptPrecisionRemoved = 0;
  if (_intercept.isPromptHookPrecisionGate(toolName, sourceMeta)) {
    const g0 = _intercept.filterPromptHookPoints(r0, toolName, sourceMeta);
    const g1 = _intercept.filterPromptHookPoints(r1, toolName, sourceMeta);
    const g2 = _intercept.filterPromptHookPoints(r2, toolName, sourceMeta);
    r0 = g0.kept; r1 = g1.kept; r2 = g2.kept;
    promptPrecisionRemoved = g0.removed.length + g1.removed.length + g2.removed.length;
  }

  // Pre-surface relevance gate (PreToolUse only). Drop learned-tier candidates
  // the post-hoc reconciler would mark wrong_repo/wrong_language/wrong_task so
  // they never surface and never count against precision. Principles (r0) stay
  // permissive — they are intentionally cross-cutting. See intercept.js
  // filterByActionRelevance for the evidence trail (precision 57% drag).
  let relevanceRemoved = 0;
  if (_intercept.isActionKnownHook(toolName)) {
    const relMeta = { cwd: sourceMeta.cwd || filePath || '' };
    const a1 = _intercept.filterByActionRelevance(r1, COLLECTIONS[1].name, toolName, toolInput, relMeta);
    const a2 = _intercept.filterByActionRelevance(r2, COLLECTIONS[2].name, toolName, toolInput, relMeta);
    r1 = a1.kept; r2 = a2.kept;
    relevanceRemoved = a1.removed.length + a2.removed.length;
    if (relevanceRemoved > 0) {
      _activity.activityLog({ op: 'relevance-gate', removed: relevanceRemoved, tool: toolName, project: filePath || null, ...sourceMeta });
    }
  }

  const suppressionContext = { queryProjectSlug, queryDomain, actionKind };
  const s0 = _noise.filterNoiseSuppressedPoints(r0, suppressionContext);
  const s1 = _noise.filterNoiseSuppressedPoints(r1, suppressionContext);
  const s2 = _noise.filterNoiseSuppressedPoints(r2, suppressionContext);
  r0 = s0.kept; r1 = s1.kept; r2 = s2.kept;
  const noiseSuppressed = [...s0.suppressed, ...s1.suppressed, ...s2.suppressed];
  if (noiseSuppressed.length > 0) {
    for (const [reason, count] of Object.entries(noiseSuppressed.reduce((acc, item) => { acc[item.reason] = (acc[item.reason] || 0) + 1; return acc; }, {}))) {
      _activity.activityLog({ op: 'noise-suppressed', reason, count, actionKind, tool: toolName, project: filePath || null, ...sourceMeta });
    }
  }

  const fmtOpts = { skipSearchScoreGate: recallMode };
  const lines = [
    ..._format.applyBudget(_format.formatPoints(r0, fmtOpts), COLLECTIONS[0].budgetChars),
    ..._format.applyBudget(_format.formatPoints(r1, fmtOpts), COLLECTIONS[1].budgetChars),
    ..._format.applyBudget(_format.formatPoints(r2, fmtOpts), COLLECTIONS[2].budgetChars),

  ];

  try {
    const allIds = [...r0, ...r1, ...r2].map(p => p.id).filter(Boolean);
    const seenIds = new Set(allIds);
    for (const rid of allIds) {
      const edges = _graph.getEdgesForId(rid);
      for (const edge of edges) {
        const targetId = edge.source === rid ? edge.target : edge.source;
        if (seenIds.has(targetId)) continue;
        seenIds.add(targetId);
        for (const coll of COLLECTIONS) {
          const found = await _qdrant.fetchPointById(coll.name, targetId);
          if (found) {
            const graphPoint = { ...found, score: (found.score || 0.5) * edge.weight * 0.8, _collection: coll.name, _graphEdge: edge.type };
            const graphGate = _intercept.filterPromptHookPoints([graphPoint], toolName, sourceMeta);
            promptPrecisionRemoved += graphGate.removed.length;
            lines.push(..._format.applyBudget(_format.formatPoints(graphGate.kept, fmtOpts), 600));
            break;
          }
        }
      }
    }
  } catch { /* never block intercept on graph failures */ }

  const allReranked = _utils.dedupePointsBySource([...r0, ...r1, ...r2]);
  const surfaced = allReranked.filter(p => {
    try {
      const exp = JSON.parse(p.payload?.json || '{}');
      return exp.solution && (p._probationaryT2 || _scoring.computeEffectiveConfidence(exp) >= _config.getMinConfidence());
    } catch { return false; }
  });
  if (surfaced.length > 0) Promise.all(surfaced.map(p => _hittrack.recordSurface(p._collection, p.id))).catch(() => {});

  const surfacedMeta = surfaced.map(p => {
    try {
      const exp = JSON.parse(p.payload?.json || '{}');
      const superseded = _graph.getEdgesForId(p.id).some(edge => edge.type === 'supersedes' && edge.target === p.id);
      return { collection: p._collection, id: p.id, solution: exp.solution || null, domain: exp.domain || null, projectSlug: exp._projectSlug || null, scope: exp.scope || null, createdAt: exp.createdAt || null, lastHitAt: exp.lastHitAt || null, hitCount: exp.hitCount || 0, ignoreCount: exp.ignoreCount || 0, superseded };
    } catch { return { collection: p._collection, id: p.id, solution: null }; }
  });
  if (surfacedMeta.length > 0) {
    const { flagged, filtered } = _session.trackSuggestions(surfacedMeta, sourceMeta);
    if (filtered.length > 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        for (const fp of filtered) {
          try {
            const exp = JSON.parse(surfaced.find(s => s.id === fp.id)?.payload?.json || '{}');
            if (exp.solution && lines[i]?.includes(exp.solution)) { lines.splice(i, 1); break; }
          } catch {}
        }
      }
    }
    if (flagged.length > 0) Promise.all(flagged.map(f => _hittrack.incrementIgnoreCount(f.collection, f.id))).catch(() => {});
  }

  if (!hookRealtimeFastPath && lines.length > 0 && _config.getConfig().brainFilter !== false) {
    try {
      const brainQuery = rawAction.length > query.length ? rawAction.slice(0, 300) : query;
      const kept = await _brainllm.brainRelevanceFilter(brainQuery, lines, signal, queryProjectSlug);
      if (kept !== null) {
        const removed = lines.length - kept.length;
        lines.length = 0; lines.push(...kept);
        if (removed > 0) _activity.activityLog({ op: 'brain-filter', removed, kept: kept.length, ...sourceMeta });
      }
    } catch {}
  }

  if (lines.length > 1) {
    const uniqueLines = _session.dedupeSuggestionLines(lines);
    if (uniqueLines.length !== lines.length) {
      _activity.activityLog({ op: 'suggestion-dedup', removed: lines.length - uniqueLines.length, kept: uniqueLines.length, ...sourceMeta });
      lines.length = 0; lines.push(...uniqueLines);
    }
  }

  const shownIds = new Set(lines.map(line => line.match(/\[id:([^\s]+)\s+col:/)).map(match => match?.[1] || null).filter(Boolean));
  const shownSurfacedMeta = surfacedMeta.filter(surface => shownIds.has(_session.shortPointId(surface.id)));

  _activity.activityLog({
    op: 'intercept', stage: 'search_done', tool: toolName, query: query.slice(0, 120),
    scores: [...r0, ...r1, ...r2].map(p => p._effectiveScore ?? p.score).sort((a, b) => b - a).slice(0, 3),
    result: lines.length > 0 ? 'suggestion' : null, hasResult: lines.length > 0,
    surfacedCount: shownSurfacedMeta.length, surfaced: shownSurfacedMeta.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
    ...(promptPrecisionRemoved > 0 ? { promptPrecisionRemoved, promptMinScore: _intercept.promptHookScoreThreshold() } : {}),
    project: _utils.extractProjectPath(toolInput),
    ...(routeResult ? { route: routeResult.tier, routeModel: routeResult.model, routeSource: routeResult.source } : {}),
    ...sourceMeta,
  });

  let suggestions = null;
  if (lines.length > 0) {
    suggestions = lines.join('\n---\n');
    suggestions += '\n───\nFeedback reasons: wrong_repo | wrong_language | wrong_task | stale_rule — or verdict:"IGNORED" if you chose to skip.';
  }
  return { suggestions, surfacedIds: shownSurfacedMeta, route: routeResult || null };
}

async function intercept(toolName, toolInput, signal, meta) {
  const result = await interceptWithMeta(toolName, toolInput, signal, meta);
  return result ? result.suggestions : null;
}

// --- Exports ---
module.exports = {
  intercept,
  interceptWithMeta,
  recordFeedback: _hittrack.recordFeedback,
  recordJudgeFeedback: _hittrack.recordJudgeFeedback,
  classifyViaBrain: _router.classifyViaBrain,
  extractFromSession: _intercept.extractFromSession,
  recordHit: _hittrack.recordHit,
  recordSurface: _hittrack.recordSurface,
  recordHoldoutOutcome: _hittrack.recordHoldoutOutcome,
  incrementIgnoreCount: _hittrack.incrementIgnoreCount,
  syncToQdrant: _qdrant.syncToQdrant,
  evolve: _evolution.evolve,
  getEmbeddingRaw: _embedding.getEmbeddingRaw,
  searchCollection: _qdrant.searchCollection,
  buildProjectBrief: _brief.buildProjectBrief,
  deleteEntry: _qdrant.deleteEntry,
  createEdge: _graph.createEdge,
  getEdgesForId: _graph.getEdgesForId,
  getEdgesOfType: _graph.getEdgesOfType,
  EDGE_COLLECTION,
  sharePrinciple: _evolution.sharePrinciple,
  importPrinciple: _evolution.importPrinciple,
  EXP_USER,
  extractProjectSlug: _utils.extractProjectSlug,
  migrateQdrantUserTags: _evolution.migrateQdrantUserTags,
  routeTask: _router.routeTask,
  routeModel: _router.routeModel,
  routeFeedback: _router.routeFeedback,
  _updatePointPayload: _qdrant.updatePointPayload,
  _applyHitUpdate: _hittrack.applyHitUpdate,
  _applySurfaceUpdate: _hittrack.applySurfaceUpdate,
  _applyHoldoutOutcome: _hittrack.recordHoldoutOutcomeOnData,
  _activityLog: _activity.activityLog,
  _detectContext: _utils.detectContext,
  _buildQuery: _utils.buildQuery,
  _computeEffectiveScore: _scoring.computeEffectiveScore,
  _computeEffectiveConfidence: _scoring.computeEffectiveConfidence,
  _rerankByQuality: _scoring.rerankByQuality,
  _formatPoints: _format.formatPoints,
  _isProbationaryT2Candidate: _scoring.isProbationaryT2Candidate,
  _selectProbationaryT2Points: _scoring.selectProbationaryT2Points,
  _isHookRealtimeFastPath: _intercept.isHookRealtimeFastPath,
  _isPromptHookPrecisionGate: _intercept.isPromptHookPrecisionGate,
  _filterPromptHookPoints: _intercept.filterPromptHookPoints,
  _storeExperiencePayload: (qa, domain, projectSlug) => _format.buildStorePayload(require('crypto').randomUUID(), qa, domain || null, projectSlug || null),
  _extractProjectSlug: _utils.extractProjectSlug,
  _buildStorePayload: _format.buildStorePayload,
  _recordHitUpdatesFields: _hittrack.applyHitUpdate,
  _recordSurfaceUpdatesFields: _hittrack.applySurfaceUpdate,
  _applyOrganicSupportUpdate: _evolution.applyOrganicSupportUpdate,
  _isOrganicSupportCandidate: _evolution.isOrganicSupportCandidate,
  _trackSuggestions: _session.trackSuggestions,
  _sessionUniqueCount: _session.sessionUniqueCount,
  _incrementIgnoreCountData: _session.incrementIgnoreCountData,
  _incrementUnusedData: _session.incrementUnusedData,
  _applyNoiseDispositionData: _hittrack.applyNoiseDispositionData,
  _shouldSuppressForNoise: _noise.shouldSuppressForNoise,
  _filterNoiseSuppressedPoints: _noise.filterNoiseSuppressedPoints,
  _reconcilePendingHints: _intercept.reconcilePendingHints,
  _reconcileStalePromptSuggestions: _intercept.reconcileStalePromptSuggestions,
  _assessHintUsage: _intercept.assessHintUsage,
  _stashSurfacedHints: _intercept.stashSurfacedHints,
  _detectTranscriptDomain: _context.detectTranscriptDomain,
  _detectNaturalLang: _context.detectNaturalLang,
  _callBrainWithFallback: callBrainWithFallback,
  _isReadOnlyCommand: _intercept.isReadOnlyCommand,
  _brainRelevanceFilter: _brainllm.brainRelevanceFilter,
  _extractProjectPath: _utils.extractProjectPath,
  _extractPathFromCommand: _intercept.extractPathFromCommand,
  _detectRuntime: _utils.detectRuntime,
  _resolveRuntimeFromSourceMeta: _utils.resolveRuntimeFromSourceMeta,
  _isRouterEnabled: _router.isRouterEnabled,
  _assessExtractedQaQuality: _context.assessExtractedQaQuality,
  _normalizeExtractText: _context.normalizeExtractText,
  _detectMistakes: _context.detectMistakes,
  _shouldPromoteBehavioralToPrinciple: _evolution.shouldPromoteBehavioralToPrinciple,
  _buildPrincipleText: _format.buildPrincipleText,
  _getValidatedHitCount: _hittrack.getValidatedHitCount,
};
