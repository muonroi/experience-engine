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

// --- Constants ---
const { COLLECTIONS, ROUTES_COLLECTION, SELFQA_COLLECTION, EDGE_COLLECTION, MAX_SESSION_UNIQUE } = _intercept;

const CODEX_ALLOWED_MODEL_REASONING = {
  'gpt-5.4': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.4-mini': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.3-codex': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.3-codex-spark': new Set(['low', 'medium', 'high', 'extra_high']),
};

const EXP_USER = _config.EXP_USER;
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);

// --- Embed providers (kept here for backward compat with embed* functions) ---
const EMBED_PROVIDERS = {
  ollama:       { get fn() { return embedOllama; } },
  openai:       { get fn() { return embedOpenAI; } },
  gemini:       { get fn() { return embedGemini; } },
  voyageai:     { get fn() { return embedVoyageAI; } },
  siliconflow:  { get fn() { return embedOpenAI; } },
  custom:       { get fn() { return embedOpenAI; } },
};

async function embedOllama(text, signal) {
  try {
    const res = await fetch(_config.getOllamaEmbedUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: _config.getEmbedModel(), input: text }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings?.[0] || null;
  } catch { return null; }
}

async function embedOpenAI(text, signal) {
  const endpoint = _config.getEmbedEndpoint() || 'https://api.openai.com/v1/embeddings';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_config.getEmbedKey()}` },
      body: JSON.stringify({ model: _config.getEmbedModel() || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

async function embedGemini(text, signal) {
  try {
    const model = _config.getEmbedModel() || 'text-embedding-004';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${_config.getEmbedKey()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).embedding?.values || null;
  } catch { return null; }
}

async function embedVoyageAI(text, signal) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_config.getEmbedKey()}` },
      body: JSON.stringify({ model: _config.getEmbedModel() || 'voyage-code-3', input: [text.slice(0, 8000)] }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

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

async function interceptWithMeta(toolName, toolInput, signal, meta) {
  const sourceMeta = _utils.normalizeSourceMeta(meta);
  const runtime = _utils.resolveRuntimeFromSourceMeta(sourceMeta, _utils.detectRuntime(toolName));
  const hookRealtimeFastPath = _intercept.isHookRealtimeFastPath(toolName, sourceMeta);
  if (_intercept.isReadOnlyCommand(toolName, toolInput)) return { suggestions: null, surfacedIds: [] };

  const uniquesSoFar = _session.sessionUniqueCount(sourceMeta);
  if (uniquesSoFar >= MAX_SESSION_UNIQUE) {
    _activity.activityLog({ op: 'intercept', stage: 'budget_capped', tool: toolName, query: '(budget-capped)', scores: [], result: null, hasResult: false, surfacedCount: 0, project: _utils.extractProjectPath(toolInput), ...sourceMeta });
    return { suggestions: null, surfacedIds: [] };
  }

  const query = _utils.buildQuery(toolName, toolInput);
  const filePath = toolInput?.file_path || toolInput?.path || _utils.extractProjectPath(toolInput) || '';
  const queryDomain = _utils.detectContext(filePath);
  const queryProjectSlug = _utils.extractProjectSlug(filePath);
  const actionKind = _intercept.classifyActionKind(toolName, toolInput || {}, filePath);
  const vector = await _embedding.getEmbedding(query, signal);
  if (!vector) return null;

  const routePromise = !hookRealtimeFastPath && _router.isRouterEnabled()
    ? _router.routeModel(query, { files: [filePath].filter(Boolean), domain: queryDomain }, runtime).catch(() => null)
    : Promise.resolve(null);

  const [t0, t1, t2, routeResult] = await Promise.all([
    _qdrant.searchCollection(COLLECTIONS[0].name, vector, COLLECTIONS[0].topK, signal),
    _qdrant.searchCollection(COLLECTIONS[1].name, vector, COLLECTIONS[1].topK, signal),
    _qdrant.searchCollection(COLLECTIONS[2].name, vector, COLLECTIONS[2].topK, signal),
    routePromise,
  ]);

  function applyScopeFilter(points) {
    if (!filePath) return points;
    const fileExt = filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() || '';
    const JS_FAMILY = new Set(['ts', 'tsx', 'js', 'jsx']);
    const CSS_FAMILY = new Set(['css', 'scss', 'less', 'sass']);
    const CS_FAMILY = new Set(['cs', 'fs']);
    function fileMatchesLang(scopeLang) {
      if (!scopeLang || scopeLang === 'all') return true;
      const sl = scopeLang.toLowerCase();
      if (sl === 'c#') return CS_FAMILY.has(fileExt);
      if (sl === 'javascript' || sl === 'typescript') return JS_FAMILY.has(fileExt);
      if (sl === 'css') return CSS_FAMILY.has(fileExt);
      const detected = (_utils.detectContext(filePath) || '').toLowerCase();
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

  let r0 = _utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t0), queryDomain, queryProjectSlug, query), COLLECTIONS[0].name);
  let r1 = _utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t1), queryDomain, queryProjectSlug, query), COLLECTIONS[1].name);
  let r2 = _scoring.selectProbationaryT2Points(_utils.dedupePointsBySource(_scoring.rerankByQuality(applyScopeFilter(t2), queryDomain, queryProjectSlug, query), COLLECTIONS[2].name));

  let promptPrecisionRemoved = 0;
  if (_intercept.isPromptHookPrecisionGate(toolName, sourceMeta)) {
    const g0 = _intercept.filterPromptHookPoints(r0, toolName, sourceMeta);
    const g1 = _intercept.filterPromptHookPoints(r1, toolName, sourceMeta);
    const g2 = _intercept.filterPromptHookPoints(r2, toolName, sourceMeta);
    r0 = g0.kept; r1 = g1.kept; r2 = g2.kept;
    promptPrecisionRemoved = g0.removed.length + g1.removed.length + g2.removed.length;
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

  const lines = [
    ..._format.applyBudget(_format.formatPoints(r0), COLLECTIONS[0].budgetChars),
    ..._format.applyBudget(_format.formatPoints(r1), COLLECTIONS[1].budgetChars),
    ..._format.applyBudget(_format.formatPoints(r2), COLLECTIONS[2].budgetChars),
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
            lines.push(..._format.applyBudget(_format.formatPoints(graphGate.kept), 600));
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
      const kept = await _brainllm.brainRelevanceFilter(query, lines, signal, queryProjectSlug);
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
