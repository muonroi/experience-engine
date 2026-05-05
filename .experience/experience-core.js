#!/usr/bin/env node
/**
 * experience-core.js — Shared Experience Engine logic
 * Used by Claude Code, Gemini CLI, and Codex CLI hooks.
 * Zero npm dependencies. Node.js 20 native fetch only.
 *
 * API:
 *   intercept(toolName, toolInput, signal) → string | null
 *   extractFromSession(sessionLog)        → void (stores to Qdrant)
 *   getEmbeddingRaw(text, signal)         → number[] | null
 *
 * Config via ~/.experience/config.json (set by setup.sh). Fallback: EXPERIENCE_* env vars.
 */

'use strict';

const fs = require('fs');
const pathMod = require('path');
const os = require('os');

// --- Extracted modules (Phase 1 refactoring) ---
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

// Config delegated to src/config.js — inline delegates for early-init functions
const cfgValue = _config.cfgValue;
const getConfig = _config.getConfig;
const getExpUser = _config.getExpUser;
const getFileStoreDir = _config.getStoreDir;
const getEmbedProvider = _config.getEmbedProvider;
const getEmbedModel = _config.getEmbedModel;
const getEmbedEndpoint = _config.getEmbedEndpoint;
const getEmbedKey = _config.getEmbedKey;
const getEmbedDim = _config.getEmbedDim;
const getBrainProvider = _config.getBrainProvider;
const getBrainModel = _config.getBrainModel;
const getBrainEndpoint = _config.getBrainEndpoint;
const getBrainKey = _config.getBrainKey;
const getMinConfidence = _config.getMinConfidence;
const getHighConfidence = _config.getHighConfidence;
const getQdrantBase = _config.getQdrantBase;
const getQdrantApiKey = _config.getQdrantApiKey;
const getOllamaBase = _config.getOllamaBase;
const refreshConfig = _config.refreshConfig;
const getOllamaEmbedUrl = _config.getOllamaEmbedUrl;
const getOllamaGenerateUrl = _config.getOllamaGenerateUrl;
const getPromptHookMinScore = () => _config.cfgValue('promptHookMinScore', 'EXPERIENCE_PROMPT_HOOK_MIN_SCORE', _config.getHighConfidence() ? String(_config.getHighConfidence()) : '0.6');

let isRouterEnabled, getRouterHistoryThreshold, getModelTiers, getReasoningEffortTiers, normalizeReasoningEffort, validateCodexModel, validateCodexReasoning, sanitizeSessionToken, getSessionTrackFile, readSessionTrack, writeSessionTrack, trackSuggestions, sessionUniqueCount, incrementIgnoreCountData, incrementIrrelevantData, incrementUnusedData, normalizeNoiseDisposition, normalizeNoiseSource, normalizeFeedbackVerdict, normalizeNoiseReason, shortPointId, pointSourceKey, dedupePointsBySource, dedupeSuggestionLines, normalizeTechLabel, commandSuggestsDomain, hasRecentValidatedConfirmation, isCodeSpecificHint, shouldSuppressForNoise, filterNoiseSuppressedPoints, inferLanguageMismatch, ensureNoiseReasonCounts, ensureNoiseSourceCounts, recordNoiseMetadataData, updatePointPayload, checkQdrant, normalizeSourceMeta, resolveRuntimeFromSourceMeta, extractProjectPath, extractProjectSlug, fileStorePath, fileStoreRead, acquireLock, releaseLock, fileStoreWrite, cosineSimilarity, fileStoreSearch, fileStoreUpsert, detectRuntime, detectTranscriptDomain, normalizeExtractText, isPlaceholderExtractField, isMetaWorkflowExtract, assessExtractedQaQuality, detectContext, detectNaturalLang, buildQuery, parseTranscriptToolCall, isTranscriptReadOnlyToolCall, isMutatingTranscriptToolCall, extractRetryTarget, isTranscriptErrorSignal, detectMistakes, getBrainFallback, brainRelevanceFilter, extractQA, brainOllama, brainOpenAI, brainGemini, brainClaude, brainDeepSeek, tokenizeOrganicSupportText, organicSupportText, tokenOverlapRatio, conditionOverlapCount, buildOrganicSupportKey, isOrganicSupportCandidate, findOrganicSupportCandidate, applyOrganicSupportUpdate, buildStorePayload, storeExperience, getEmbedding, fetchPointById, buildQdrantUserFilter, searchCollection, computeEffectiveConfidence, computeEffectiveScore, rerankByQuality, getSurfaceCountForProbation, hasProbationaryT2Debt, isProbationaryT2Candidate, selectProbationaryT2Points, formatPoints, applyBudget, ensureSignalMetrics, normalizeEvidenceClass, normalizeConditions, normalizeFailureMode, normalizeJudgment, ensureAbstractionFields, ensureNovelCaseEvidence, isPrincipleLikeEntry, syncToQdrant, createEdge, getEdgesForId, getEdgesOfType, uniqueConfirmationCount, hasRepeatedSessionConfirmations, resetPromotionProbation, shouldPromoteBehavioralToPrinciple, buildPrincipleText, evolve, parsePayload, clusterByCosine, deleteEntry, sharePrinciple, importPrinciple, preFilterComplexity, isQcFlowFrontHalfContext, maybeCapTierForCost, printRouteDecision, classifyViaBrain, normalizeTierResponse, normalizeTaskRoute, foldClassifierText, preFilterTaskRoute, parseJsonObjectFromText, defaultTaskRouteOptions, normalizeTaskRoutePayload, buildTaskRoutePrompt, resolveTierModel, resolveTierReasoningEffort, buildModelRoutePrompt, shouldSkipKeywordModelPrefilter, storeRouteDecision, routeTask, routeFeedback;
// --- Model Router config ---


function getRouterDefaultTier() {
  return getConfig().routerDefaultTier ?? 'balanced';
}



const CODEX_ALLOWED_MODEL_REASONING = {
  'gpt-5.4': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.4-mini': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.3-codex': new Set(['low', 'medium', 'high', 'extra_high']),
  'gpt-5.3-codex-spark': new Set(['low', 'medium', 'high', 'extra_high']),
};




const COLLECTIONS = [
  { name: 'experience-principles', topK: 2, budgetChars: 800 },
  { name: 'experience-behavioral', topK: 3, budgetChars: 1200 },
  { name: 'experience-selfqa',     topK: 2, budgetChars: 1000 },
];

const ROUTES_COLLECTION = 'experience-routes';
const SELFQA_COLLECTION = 'experience-selfqa';
const EDGE_COLLECTION = 'experience-edges';
const DEDUP_THRESHOLD = 0.85;
const RELATES_TO_THRESHOLD = 0.70;
const QUERY_MAX_CHARS = 500;
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);
const VALID_NOISE_DISPOSITIONS = new Set(['unused', 'irrelevant', 'ignored', 'followed']);
const VALID_NOISE_SOURCES = new Set(['manual', 'judge', 'implicit-posttool', 'prompt-stale']);
const UNUSED_NO_TOUCH_THRESHOLD = 3;
const PENDING_HINT_TTL_MS = 20 * 60 * 1000;
const PROMPT_STALE_RECONCILE_MS = 10 * 1000;
const PROBATIONARY_T2_RAW_SCORE_THRESHOLD = 0.78;
const PROBATIONARY_T2_SURFACE_LIMIT = 2;
const ORGANIC_SUPPORT_SEMANTIC_THRESHOLD = 0.58;
const ORGANIC_SUPPORT_TOKEN_OVERLAP_THRESHOLD = 0.34;
const ORGANIC_SUPPORT_MAX_CANDIDATES = 8;
const NOISE_SUPPRESSION_THRESHOLD = 1; // Suppress after first noise signal to improve precision
const RECENT_VALIDATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// --- Session-persistent tracking (file-based, survives process restarts) ---
// Each hook invocation is a NEW process, so in-memory arrays are useless.
// Key by date + CWD hash — PPID is unreliable on Windows (changes every hook call).

const SESSION_TRACK_DIR = require('path').join(require('os').tmpdir(), 'experience-session');
const MAX_SESSION_UNIQUE = 8; // P2: max unique experiences surfaced per session





/**
 * Track surfaced suggestions in persistent session file.
 * Returns: { filtered: ids to skip (already shown), flagged: ids with 3+ repeats }
 */

/**
 * P2: Check if session budget is exhausted (max unique experiences).
 * Returns number of unique experiences already shown.
 */













const DOMAIN_KEYWORDS = {
  javascript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  typescript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  python: ['python', 'pip', 'pytest', 'poetry', 'uv', 'ruff'],
  'c#': ['dotnet', 'nuget', 'msbuild', 'csc'],
  java: ['java', 'javac', 'mvn', 'gradle'],
  rust: ['cargo', 'rustc'],
  go: ['go test', 'go build', 'gofmt'],
  ruby: ['bundle', 'bundler', 'rspec', 'ruby'],
  shell: ['bash', 'sh ', 'zsh'],
};


function classifyActionKind(toolName, toolInput, actionPath) {
  const raw = `${toolName || ''} ${toolInput?.command || toolInput?.cmd || ''} ${toolInput?.file_path || toolInput?.path || ''}`.toLowerCase();
  const pathText = String(actionPath || '').toLowerCase();
  if (/(^|\/)(readme|session_start|repo_deep_map|plan|state|agents)\.md$/.test(pathText) || /(^|\/)docs?\//.test(pathText) || /\.md\b/.test(raw)) {
    return 'docs';
  }
  if (/\.(json|ya?ml|toml|ini|env|lock)\b/.test(pathText) || /\b(docker-compose|package-lock|pnpm-lock|poetry\.lock)\b/.test(raw)) {
    return 'config';
  }
  if (/\.(sh|ps1|bat)\b/.test(pathText) || /\b(deploy|docker|kubectl|helm|systemctl)\b/.test(raw)) {
    return 'ops';
  }
  if (detectContext(actionPath || '')) return 'code';
  return 'unknown';
}






function assessHintUsage(surface, toolName, toolInput, runtimeMeta = {}) {
  const cwdPath = runtimeMeta.cwd || process.cwd() || '';
  const actionPath = extractProjectPath(toolInput || {}) || cwdPath || '';
  const actionProject = extractProjectSlug(actionPath || '') || extractProjectSlug(cwdPath || '');
  const actionDomain = detectContext(actionPath || '') || null;
  const actionKind = classifyActionKind(toolName, toolInput || {}, actionPath || cwdPath);
  const actionText = buildQuery(toolName || '', toolInput || {}).toLowerCase();
  const projectSlug = surface?.projectSlug || null;
  const scopeLang = normalizeTechLabel(surface?.scope?.lang);

  if (projectSlug && actionProject && projectSlug !== actionProject) {
    return { touched: false, reason: 'wrong_repo', actionProject, actionDomain, actionKind };
  }
  if (inferLanguageMismatch(surface, actionDomain)) {
    return { touched: false, reason: 'wrong_language', actionProject, actionDomain, actionKind };
  }
  if (scopeLang && scopeLang !== 'all') {
    if (actionDomain && normalizeTechLabel(actionDomain) === scopeLang) {
      return { touched: true, reason: 'language_match', actionProject, actionDomain, actionKind };
    }
    if (commandSuggestsDomain(actionText, scopeLang)) {
      return { touched: true, reason: 'domain_command_match', actionProject, actionDomain, actionKind };
    }
    if (actionKind !== 'code') {
      return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
    }
    return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
  }
  if (actionKind === 'docs' || actionKind === 'config' || actionKind === 'ops') {
    return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
  }
  if (projectSlug && actionProject && projectSlug === actionProject) {
    return { touched: true, reason: 'project_match', actionProject, actionDomain, actionKind };
  }
  if (actionProject || actionPath) {
    return { touched: true, reason: 'path_match', actionProject, actionDomain, actionKind };
  }
  return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
}

async function reconcilePendingHints(surfacedPoints, toolName, toolInput, meta = {}) {
  const track = readSessionTrack(meta);
  if (!track.pending || typeof track.pending !== 'object' || Array.isArray(track.pending)) track.pending = {};
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const incoming = Array.isArray(surfacedPoints) ? surfacedPoints : [];
  const results = { touched: [], pending: [], implicitUnused: [], expired: [] };

  for (const surface of incoming) {
    if (!surface?.id || !surface?.collection) continue;
    const key = `${surface.collection}:${surface.id}`;
    if (!track.pending[key]) {
      track.pending[key] = {
        ...surface,
        surfacedAt: nowIso,
        noTouchCount: 0,
      };
    }
  }

  for (const [key, pending] of Object.entries(track.pending)) {
    const surfacedAtMs = pending?.surfacedAt ? new Date(pending.surfacedAt).getTime() : 0;
    if (surfacedAtMs && (nowMs - surfacedAtMs) > PENDING_HINT_TTL_MS) {
      delete track.pending[key];
      results.expired.push({ collection: pending.collection, id: pending.id });
      continue;
    }

    const assessment = assessHintUsage(pending, toolName, toolInput, meta);
    if (assessment.touched) {
      await updatePointPayload(
        pending.collection,
        pending.id,
        applyHitUpdateWithContext({
          projectSlug: assessment.actionProject || null,
          sourceSession: meta.sourceSession || null,
          sourceKind: meta.sourceKind || null,
        })
      );
      activityLog({
        op: 'implicit-touch',
        collection: pending.collection,
        pointId: shortPointId(pending.id),
        reason: assessment.reason,
        tool: toolName,
        ...normalizeSourceMeta(meta),
      });
      delete track.pending[key];
      results.touched.push({ collection: pending.collection, id: pending.id, reason: assessment.reason });
      continue;
    }

    pending.noTouchCount = (pending.noTouchCount || 0) + 1;
    pending.lastNoTouchAt = nowIso;
    pending.lastNoTouchReason = assessment.reason;
    pending.lastToolName = toolName || '';
    track.pending[key] = pending;

    if (pending.noTouchCount >= UNUSED_NO_TOUCH_THRESHOLD) {
      const deterministicNoise = assessment.reason === 'wrong_repo'
        || assessment.reason === 'wrong_language'
        || assessment.reason === 'wrong_task';
      await updatePointPayload(
        pending.collection,
        pending.id,
        applyNoiseDispositionData('unused', 'implicit-posttool', assessment.reason, {
          countIrrelevant: deterministicNoise,
        })
      );
      activityLog({
        op: 'noise-disposition',
        collection: pending.collection,
        pointId: shortPointId(pending.id),
        disposition: 'unused',
        source: 'implicit-posttool',
        noTouchCount: pending.noTouchCount,
        reason: assessment.reason,
        tool: toolName,
        ...normalizeSourceMeta(meta),
      });
      activityLog({
        op: 'implicit-unused',
        collection: pending.collection,
        pointId: shortPointId(pending.id),
        count: pending.noTouchCount,
        reason: assessment.reason,
        tool: toolName,
        ...normalizeSourceMeta(meta),
      });
      delete track.pending[key];
      results.implicitUnused.push({ collection: pending.collection, id: pending.id, reason: assessment.reason });
      continue;
    }

    results.pending.push({
      collection: pending.collection,
      id: pending.id,
      count: pending.noTouchCount,
      reason: assessment.reason,
    });
  }

  writeSessionTrack(track, meta);
  return results;
}

function promptStateSurfacedIds(state) {
  return Array.isArray(state?.surfacedIds)
    ? state.surfacedIds.filter(surface => surface?.collection && surface?.id)
    : [];
}

function isPromptOnlySuggestionState(state) {
  if (!state || typeof state !== 'object') return false;
  return state.sourceHook === 'UserPromptSubmit' || state.tool === 'UserPrompt';
}

async function reconcileStalePromptSuggestions(state, nextPromptMeta = {}) {
  const surfacedIds = promptStateSurfacedIds(state);
  const result = { ok: true, unused: [], irrelevant: [], expired: [] };
  if (!isPromptOnlySuggestionState(state) || surfacedIds.length === 0) return result;

  const surfacedAtMs = state?.ts ? new Date(state.ts).getTime() : 0;
  const ageMs = surfacedAtMs ? Date.now() - surfacedAtMs : Number.POSITIVE_INFINITY;
  if (Number.isFinite(ageMs) && ageMs < PROMPT_STALE_RECONCILE_MS) return result;

  if (Number.isFinite(ageMs) && ageMs > PENDING_HINT_TTL_MS) {
    result.expired.push(...surfacedIds.map(surface => ({ collection: surface.collection, id: surface.id })));
    activityLog({
      op: 'prompt-stale-expired',
      surfacedCount: surfacedIds.length,
      ageMs,
      ...normalizeSourceMeta(nextPromptMeta),
    });
    return result;
  }

  const meta = {
    ...normalizeSourceMeta({
      sourceKind: nextPromptMeta.sourceKind || state.sourceKind || 'codex-hook',
      sourceRuntime: nextPromptMeta.sourceRuntime || state.sourceRuntime || null,
      sourceSession: nextPromptMeta.sourceSession || state.sourceSession || null,
    }),
    cwd: nextPromptMeta.cwd || state.cwd || null,
  };
  const prompt = String(nextPromptMeta.prompt || nextPromptMeta.userPrompt || nextPromptMeta.user_prompt || '');
  const toolInput = { command: prompt, _promptHook: true };

  for (const surface of surfacedIds) {
    let assessment = { touched: false, reason: 'unused' };
    try {
      assessment = assessHintUsage(surface, 'UserPrompt', toolInput, meta);
    } catch {}
    const normalizedReason = normalizeNoiseReason(assessment?.reason);
    await updatePointPayload(surface.collection, surface.id, (data) => {
      applyNoiseDispositionData('unused', 'prompt-stale', normalizedReason, {
        countIrrelevant: !!normalizedReason,
      })(data);
      return data;
    });
    result.unused.push({ collection: surface.collection, id: surface.id, reason: assessment?.reason || 'unused' });
    if (normalizedReason) {
      result.irrelevant.push({ collection: surface.collection, id: surface.id, reason: normalizedReason });
    }
  }

  activityLog({
    op: 'noise-disposition',
    disposition: 'unused',
    source: 'prompt-stale',
    unused: result.unused.length,
    irrelevant: result.irrelevant.length,
    expired: result.expired.length,
    ...meta,
  });
  activityLog({
    op: 'prompt-stale-reconcile',
    unused: result.unused.length,
    irrelevant: result.irrelevant.length,
    expired: result.expired.length,
    ...meta,
  });
  return result;
}




function applyNoiseDispositionData(disposition, source = 'manual', reason = null, options = {}) {
  return function applyNoiseDisposition(data) {
    const normalizedDisposition = normalizeNoiseDisposition(disposition);
    if (!normalizedDisposition) return data;
    if (normalizedDisposition === 'followed') {
      applyHitUpdate(data);
      return data;
    }
    if (normalizedDisposition === 'ignored') incrementIgnoreCountData(data);
    if (normalizedDisposition === 'irrelevant') incrementIrrelevantData(data);
    if (normalizedDisposition === 'unused') {
      incrementUnusedData(data);
      if (options.countIrrelevant) incrementIrrelevantData(data);
    }
    recordNoiseMetadataData(data, source, reason);
    return data;
  };
}

function incrementIrrelevantWithReasonData(reason) {
  return applyNoiseDispositionData('irrelevant', 'manual', reason);
}

/**
 * Shared read-modify-write helper for FileStore and Qdrant.
 * Fetches the point payload, calls updateFn(data) to mutate in-place, then writes back.
 * @param {string} collection - Collection name
 * @param {string} pointId    - Point UUID
 * @param {Function} updateFn - Mutates data object in-place (e.g. applyHitUpdate, incrementIgnoreCountData)
 */

async function incrementIgnoreCount(collection, pointId) {
  await updatePointPayload(collection, pointId, incrementIgnoreCountData);
}

// --- Qdrant availability (per D-14) ---
let qdrantAvailable = null; // null = unchecked, true/false = checked
// EXP_USER from config module for backward compat
const EXP_USER = _config.EXP_USER;

// FileStore dir from config module


// --- Activity logging (Phase 102) ---
const ACTIVITY_LOG = process.env.EXPERIENCE_ACTIVITY_LOG || pathMod.join(os.homedir(), '.experience', 'activity.jsonl');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function activityLog(event) {
  try {
    try {
      const stat = fs.statSync(ACTIVITY_LOG);
      if (stat.size >= MAX_LOG_SIZE) {
        try { fs.renameSync(ACTIVITY_LOG, ACTIVITY_LOG + '.1'); } catch { /* race-safe */ }
      }
    } catch { /* file may not exist yet — fine */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(ACTIVITY_LOG, line + '\n');
  } catch { /* never crash the engine */ }
}

function estimateTextUnits(text, cap = 12000) {
  return Math.min(String(text || '').length, cap);
}

function logCostCall(kind, provider, source, units, extra = {}) {
  activityLog({
    op: 'cost-call',
    kind,
    provider: provider || 'unknown',
    source: source || 'unknown',
    units: Math.max(0, Math.round(Number(units) || 0)),
    ...extra,
  });
}

function logMistakeSeen(mistakes, projectPath) {
  if (!Array.isArray(mistakes) || mistakes.length === 0) return;
  const counts = new Map();
  for (const mistake of mistakes) {
    const type = String(mistake?.type || 'unknown');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  for (const [type, count] of counts.entries()) {
    activityLog({ op: 'mistake-seen', type, count, project: projectPath || null });
  }
}



function isHookRealtimeFastPath(toolName, sourceMeta) {
  const runtime = String(sourceMeta?.sourceRuntime || '').trim().toLowerCase();
  return sourceMeta?.sourceKind === 'codex-hook'
    || (String(toolName || '') === 'UserPrompt' && runtime.startsWith('codex'));
}

function isPromptHookPrecisionGate(toolName, sourceMeta) {
  return String(toolName || '') === 'UserPrompt' && sourceMeta?.sourceKind === 'codex-hook';
}

function promptHookScoreThreshold() {
  const configured = Number(getPromptHookMinScore());
  const fallback = Number(getHighConfidence()) || 0.60;
  return Number.isFinite(configured) && configured > 0 ? Math.max(configured, Number(getMinConfidence()) || 0) : fallback;
}

function filterPromptHookPoints(points, toolName, sourceMeta) {
  if (!isPromptHookPrecisionGate(toolName, sourceMeta)) return { kept: points || [], removed: [] };
  const threshold = promptHookScoreThreshold();
  const kept = [];
  const removed = [];
  for (const point of points || []) {
    const score = Number(point?._effectiveScore ?? point?.score ?? 0);
    if (Number.isFinite(score) && score >= threshold) kept.push(point);
    else removed.push(point);
  }
  return { kept, removed };
}


/**
 * Extract a meaningful project path from a shell command string.
 * Handles: cd targets, explicit file paths in arguments.
 * Supports: Windows (D:\path), Unix (/path), mixed (D:/path), MSYS (/d/path).
 * Returns first valid absolute path found, or null.
 */
function extractPathFromCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;

  // Strategy 1: Look for "cd <path>" — strongest project signal
  // Matches: cd "path", cd 'path', cd path (with &&, ||, ; terminators)
  const cdMatch = cmd.match(/\bcd\s+["']?([^"';&|$\n]+?)["']?\s*(?:[;&|]|\s*$)/);
  if (cdMatch) {
    const p = cdMatch[1].trim();
    if (isAbsolutePath(p)) return p;
  }

  // Strategy 2: Scan for absolute paths in the command
  // Collects all candidate paths and picks the best (longest, most specific)
  const candidates = [];

  // Windows: D:\path or D:/path (drive letter)
  const winMatches = cmd.matchAll(/[A-Za-z]:[\\/][^\s"';&|$*?<>]+/g);
  for (const m of winMatches) candidates.push(m[0]);

  // Unix absolute: /path/to/something (at least 2 segments to avoid bare /)
  const unixMatches = cmd.matchAll(/(?:^|\s|["'=])(\/{1}(?!dev\/null)[A-Za-z][^\s"';&|$*?<>]*\/[^\s"';&|$*?<>]*)/g);
  for (const m of unixMatches) candidates.push(m[1]);

  // MSYS: /d/Personal/... (single lowercase letter after /)
  const msysMatches = cmd.matchAll(/\/([a-z])\/[^\s"';&|$*?<>]+/g);
  for (const m of msysMatches) candidates.push(m[0]);

  if (candidates.length === 0) return null;

  // Pick the longest candidate (most specific path = best project signal)
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * Check if a path string looks like an absolute path (any OS).
 */
function isAbsolutePath(p) {
  if (!p) return false;
  // Windows: C:\ or C:/
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // Unix/MSYS: starts with /
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * Extract a project slug from a file path for project-aware filtering.
 * Detects common patterns: /sources/{org}/{project}/, /repos/{project}/, etc.
 * Returns lowercase slug or null.
 */



// File-level locking to prevent concurrent hook processes from clobbering data.
// Uses exclusive open (wx) on a .lock file with a stale timeout of 5s.
const LOCK_STALE_MS = 5000;







// --- Intercept: query experience before tool call ---

// P5: Read-only command detection — fast-path skip, no embedding/search cost
const READ_ONLY_CMD = /^(ls|dir|cat|head|tail|wc|file|stat|find|tree|which|where|echo|printf|pwd|whoami|hostname|date|uptime|type|less|more|sort|uniq|tee|realpath|basename|dirname|env|printenv|id|groups|df|du|free|top|htop|lsof|ps|pgrep|mount|uname)\b|^git\s+(log|status|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|shortlog|blame|reflog|ls-files|ls-tree|name-rev|cherry)\b|^(grep|rg|ag|ack)\b|^diff\b|^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why)\b|^(dotnet)\s+(--list-sdks|--list-runtimes|--info)\b|^(docker|podman)\s+(ps|images|inspect|logs|stats|top|port|volume\s+ls|network\s+ls)\b|^(get-content|select-string|measure-object|get-childitem|get-item|get-location|resolve-path|test-path|get-command)\b/i;

/**
 * Detect the agent runtime from tool name patterns and env vars.
 * Returns 'claude' | 'gemini' | 'codex' | 'opencode' | null.
 */

function isReadOnlyCommand(toolName, toolInput) {
  const tool = (toolName || '').toLowerCase();
  if (tool !== 'bash' && tool !== 'shell' && tool !== 'execute_command') return false;
  const cmd = (toolInput?.command || toolInput?.cmd || '').trim();
  // Multi-command chains: only skip if ALL parts are read-only
  // Split on && and || and ; — if any part is NOT read-only, treat whole thing as mutating
  const parts = cmd.split(/\s*(?:&&|\|\||;)\s*/);
  return parts.every(p => READ_ONLY_CMD.test(p.trim()));
}

async function interceptWithMeta(toolName, toolInput, signal, meta) {
  const sourceMeta = normalizeSourceMeta(meta);
  const runtime = resolveRuntimeFromSourceMeta(sourceMeta, detectRuntime(toolName));
  const hookRealtimeFastPath = isHookRealtimeFastPath(toolName, sourceMeta);
  // P5: Skip read-only commands — no code mutation = no risk = no warning needed
  if (isReadOnlyCommand(toolName, toolInput)) {
    return { suggestions: null, surfacedIds: [] };
  }

  // P2: Session budget cap — stop surfacing after N unique experiences
  const uniquesSoFar = sessionUniqueCount(sourceMeta);
  if (uniquesSoFar >= MAX_SESSION_UNIQUE) {
    activityLog({
      op: 'intercept',
      stage: 'budget_capped',
      tool: toolName,
      query: '(budget-capped)',
      scores: [],
      result: null,
      hasResult: false,
      surfacedCount: 0,
      project: extractProjectPath(toolInput),
      ...sourceMeta
    });
    return { suggestions: null, surfacedIds: [] };
  }

  const query = buildQuery(toolName, toolInput);
  const filePath = toolInput?.file_path || toolInput?.path || extractProjectPath(toolInput) || '';
  const queryDomain = detectContext(filePath);
  // P0: Extract project slug for cross-project penalty
  const queryProjectSlug = extractProjectSlug(filePath);
  const actionKind = classifyActionKind(toolName, toolInput || {}, filePath);
  const vector = await getEmbedding(query, signal);
  if (!vector) return null;

  // Route model in parallel with searches for non-hook callers. Realtime hooks
  // must not block on routing before the agent sees prompt-time guidance.
  const routePromise = !hookRealtimeFastPath && isRouterEnabled()
    ? routeModel(query, { files: [filePath].filter(Boolean), domain: queryDomain }, runtime).catch(() => null)
    : Promise.resolve(null);

  const [t0, t1, t2, routeResult] = await Promise.all([
    searchCollection(COLLECTIONS[0].name, vector, COLLECTIONS[0].topK, signal),
    searchCollection(COLLECTIONS[1].name, vector, COLLECTIONS[1].topK, signal),
    searchCollection(COLLECTIONS[2].name, vector, COLLECTIONS[2].topK, signal),
    routePromise,
  ]);

  // v2: Hard scope filter — binary gate before rerank. If scope.lang set and current
  // file's language doesn't match → eliminate entirely (not a penalty, full exclusion).
  // Legacy entries without scope pass through unchanged.
  function applyScopeFilter(points) {
    if (!filePath) return points; // no file context — can't filter
    const fileExt = filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() || '';
    // Normalize file extension to a language family for matching
    const JS_FAMILY = new Set(['ts', 'tsx', 'js', 'jsx']);
    const CSS_FAMILY = new Set(['css', 'scss', 'less', 'sass']);
    const CS_FAMILY  = new Set(['cs', 'fs']);
    function fileMatchesLang(scopeLang) {
      if (!scopeLang || scopeLang === 'all') return true;
      const sl = scopeLang.toLowerCase();
      if (sl === 'c#')         return CS_FAMILY.has(fileExt);
      if (sl === 'javascript') return JS_FAMILY.has(fileExt);
      if (sl === 'typescript') return JS_FAMILY.has(fileExt);
      if (sl === 'css')        return CSS_FAMILY.has(fileExt);
      // Generic: compare lowercase scope.lang against detected context
      const detected = (detectContext(filePath) || '').toLowerCase();
      return detected === sl || detected.startsWith(sl);
    }
    return points.filter(p => {
      try {
        const exp = JSON.parse(p.payload?.json || '{}');
        if (!exp.scope?.lang) return true; // legacy — always surface
        return fileMatchesLang(exp.scope.lang);
      } catch { return true; }
    });
  }

  // Rerank by quality score before formatting (Phase 103, 104)
  let r0 = dedupePointsBySource(rerankByQuality(applyScopeFilter(t0), queryDomain, queryProjectSlug, query), COLLECTIONS[0].name);
  let r1 = dedupePointsBySource(rerankByQuality(applyScopeFilter(t1), queryDomain, queryProjectSlug, query), COLLECTIONS[1].name);
  let r2 = selectProbationaryT2Points(
    dedupePointsBySource(rerankByQuality(applyScopeFilter(t2), queryDomain, queryProjectSlug, query), COLLECTIONS[2].name)
  );

  let promptPrecisionRemoved = 0;
  if (isPromptHookPrecisionGate(toolName, sourceMeta)) {
    const g0 = filterPromptHookPoints(r0, toolName, sourceMeta);
    const g1 = filterPromptHookPoints(r1, toolName, sourceMeta);
    const g2 = filterPromptHookPoints(r2, toolName, sourceMeta);
    r0 = g0.kept;
    r1 = g1.kept;
    r2 = g2.kept;
    promptPrecisionRemoved = g0.removed.length + g1.removed.length + g2.removed.length;
  }

  const suppressionContext = { queryProjectSlug, queryDomain, actionKind };
  const s0 = filterNoiseSuppressedPoints(r0, suppressionContext);
  const s1 = filterNoiseSuppressedPoints(r1, suppressionContext);
  const s2 = filterNoiseSuppressedPoints(r2, suppressionContext);
  r0 = s0.kept;
  r1 = s1.kept;
  r2 = s2.kept;
  const noiseSuppressed = [...s0.suppressed, ...s1.suppressed, ...s2.suppressed];
  if (noiseSuppressed.length > 0) {
    for (const [reason, count] of Object.entries(noiseSuppressed.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1;
      return acc;
    }, {}))) {
      activityLog({
        op: 'noise-suppressed',
        reason,
        count,
        actionKind,
        tool: toolName,
        project: filePath || null,
        ...sourceMeta,
      });
    }
  }

  const lines = [
    ...applyBudget(formatPoints(r0), COLLECTIONS[0].budgetChars),
    ...applyBudget(formatPoints(r1), COLLECTIONS[1].budgetChars),
    ...applyBudget(formatPoints(r2), COLLECTIONS[2].budgetChars),
  ];

  // Phase 107: 1-hop graph-augmented retrieval
  try {
    const allIds = [...r0, ...r1, ...r2].map(p => p.id).filter(Boolean);
    const seenIds = new Set(allIds);
    for (const rid of allIds) {
      const edges = getEdgesForId(rid);
      for (const edge of edges) {
        const targetId = edge.source === rid ? edge.target : edge.source;
        if (seenIds.has(targetId)) continue;
        seenIds.add(targetId);
        for (const coll of COLLECTIONS) {
          const found = await fetchPointById(coll.name, targetId);
          if (found) {
            const graphPoint = { ...found, score: (found.score || 0.5) * edge.weight * 0.8, _collection: coll.name, _graphEdge: edge.type };
            const graphGate = filterPromptHookPoints([graphPoint], toolName, sourceMeta);
            promptPrecisionRemoved += graphGate.removed.length;
            const graphFormatted = formatPoints(graphGate.kept);
            const graphBudgeted = applyBudget(graphFormatted, 600);
            lines.push(...graphBudgeted);
            break;
          }
        }
      }
    }
  } catch { /* never block intercept on graph failures */ }

  // Fire-and-forget recordHit for each surfaced point (Phase 103)
  const allReranked = dedupePointsBySource([
    ...r0,
    ...r1,
    ...r2,
  ]);
  const surfaced = allReranked.filter(p => {
    try {
      const exp = JSON.parse(p.payload?.json || '{}');
      return exp.solution && (p._probationaryT2 || computeEffectiveConfidence(exp) >= getMinConfidence());
    } catch { return false; }
  });
  if (surfaced.length > 0) {
    Promise.all(surfaced.map(p => recordSurface(p._collection, p.id))).catch(() => {});
  }

  // Track suggestions: session dedup + ignore detection (NOISE-04, P4)
  const surfacedMeta = surfaced.map(p => {
    try {
      const exp = JSON.parse(p.payload?.json || '{}');
      const superseded = getEdgesForId(p.id).some(edge => edge.type === 'supersedes' && edge.target === p.id);
      return {
        collection: p._collection,
        id: p.id,
        solution: exp.solution || null,
        domain: exp.domain || null,
        projectSlug: exp._projectSlug || null,
        scope: exp.scope || null,
        createdAt: exp.createdAt || null,
        lastHitAt: exp.lastHitAt || null,
        hitCount: exp.hitCount || 0,
        ignoreCount: exp.ignoreCount || 0,
        superseded,
      };
    } catch {
      return { collection: p._collection, id: p.id, solution: null };
    }
  });
  if (surfacedMeta.length > 0) {
    const { flagged, filtered } = trackSuggestions(surfacedMeta, sourceMeta);
    // P4: Remove already-shown suggestions from output
    if (filtered.length > 0) {
      const filteredIds = new Set(filtered.map(f => f.id));
      // Remove lines corresponding to filtered points
      for (let i = lines.length - 1; i >= 0; i--) {
        // Match by checking if any filtered point's solution is in the line
        for (const fp of filtered) {
          try {
            const exp = JSON.parse(surfaced.find(s => s.id === fp.id)?.payload?.json || '{}');
            if (exp.solution && lines[i]?.includes(exp.solution)) {
              lines.splice(i, 1);
              break;
            }
          } catch {}
        }
      }
    }
    if (flagged.length > 0) {
      Promise.all(flagged.map(f => incrementIgnoreCount(f.collection, f.id))).catch(() => {});
    }
  }

  // P6: Brain relevance filter — ask brain if remaining suggestions are relevant
  // to THIS action. Realtime hooks skip this blocking brain call.
  if (!hookRealtimeFastPath && lines.length > 0 && getConfig().brainFilter !== false) {
    try {
      const kept = await brainRelevanceFilter(query, lines, signal, queryProjectSlug);
      if (kept !== null) {
        const removed = lines.length - kept.length;
        lines.length = 0;
        lines.push(...kept);
        if (removed > 0) activityLog({ op: 'brain-filter', removed, kept: kept.length, ...sourceMeta });
      }
    } catch { /* never block intercept on brain filter failure */ }
  }

  if (lines.length > 1) {
    const uniqueLines = dedupeSuggestionLines(lines);
    if (uniqueLines.length !== lines.length) {
      activityLog({ op: 'suggestion-dedup', removed: lines.length - uniqueLines.length, kept: uniqueLines.length, ...sourceMeta });
      lines.length = 0;
      lines.push(...uniqueLines);
    }
  }

  const shownIds = new Set(
    lines
      .map(line => line.match(/\[id:([^\s]+)\s+col:/))
      .map(match => match?.[1] || null)
      .filter(Boolean)
  );
  const shownSurfacedMeta = surfacedMeta.filter(surface => shownIds.has(shortPointId(surface.id)));

  activityLog({
    op: 'intercept',
    stage: 'search_done',
    tool: toolName,
    query: query.slice(0, 120),
    scores: [...r0, ...r1, ...r2].map(p => p._effectiveScore ?? p.score).sort((a, b) => b - a).slice(0, 3),
    result: lines.length > 0 ? 'suggestion' : null,
    hasResult: lines.length > 0,
    surfacedCount: shownSurfacedMeta.length,
    surfaced: shownSurfacedMeta.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
    ...(promptPrecisionRemoved > 0 ? { promptPrecisionRemoved, promptMinScore: promptHookScoreThreshold() } : {}),
    project: extractProjectPath(toolInput),
    ...(routeResult ? { route: routeResult.tier, routeModel: routeResult.model, routeSource: routeResult.source } : {}),
    ...sourceMeta
  });

  let suggestions = null;
  if (lines.length > 0) {
    suggestions = lines.join('\n---\n');
    suggestions += '\n───\nFeedback reasons: wrong_repo | wrong_language | wrong_task | stale_rule — or verdict:"IGNORED" if you chose to skip.';
  }
  return { suggestions, surfacedIds: shownSurfacedMeta, route: routeResult || null };
}

// --- intercept: backward-compatible wrapper returning string|null ---

async function intercept(toolName, toolInput, signal, meta) {
  const result = await interceptWithMeta(toolName, toolInput, signal, meta);
  return result ? result.suggestions : null;
}

// --- Extract: detect mistakes and store lessons ---


const PLACEHOLDER_EXTRACT_FIELDS = {
  trigger: new Set([
    'when this fires',
    'when this happens',
    'if this happens',
    'when it fires',
    'when it happens',
  ]),
  question: new Set([
    'one line',
    'one-line',
    'one line question',
  ]),
  solution: new Set([
    'what to do',
    'fix it',
    'do the fix',
    'apply a fix',
  ]),
};





async function extractFromSession(transcript, projectPath, meta = {}) {
  if (!transcript || transcript.length < 100) return 0;

  const domain = detectTranscriptDomain(transcript);

  const mistakes = detectMistakes(transcript);
  logCostCall('extract', 'local', 'session-extract', estimateTextUnits(transcript, 12000), {
    project: projectPath || null,
    mistakes: mistakes.length,
  });
  if (mistakes.length === 0) {
    activityLog({ op: 'extract', mistakes: 0, stored: 0, project: projectPath || null });
    return 0;
  }

  logMistakeSeen(mistakes, projectPath);

  let stored = 0;
  for (const mistake of mistakes.slice(0, 5)) {
    try {
      const qa = await extractQA(mistake);
      if (!qa) {
        activityLog({ op: 'extract-skip', reason: 'brain_null', type: mistake.type, project: projectPath || null });
        continue;
      }
      if (qa.skip) {
        activityLog({ op: 'extract-skip', reason: qa.reason || 'brain_skip', type: mistake.type, project: projectPath || null });
        continue;
      }
      if (meta?.sourceSession && !qa.sourceSession) qa.sourceSession = meta.sourceSession;
      const quality = assessExtractedQaQuality(qa);
      if (!quality.ok) {
        activityLog({ op: 'extract-skip', reason: quality.reason, type: mistake.type, project: projectPath || null });
        continue;
      }
      const projectSlug = extractProjectSlug(projectPath);
      const result = await storeExperience(qa, domain, projectSlug);
      if (result?.stored || result?.merged) stored++;
    } catch { /* skip */ }
  }
  activityLog({ op: 'extract', mistakes: mistakes.length, stored, project: projectPath || null });
  return stored;
}

// --- Language/context detection ---

const LANG_MAP = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.cs': 'C#', '.fs': 'F#',
  '.py': 'Python', '.rb': 'Ruby',
  '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.cpp': 'C++', '.c': 'C',
  '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
  '.xml': 'XML', '.proto': 'Protobuf',
  '.dockerfile': 'Docker', '.tf': 'Terraform',
};


// Wave 2: Natural language detection for cross-lingual matching

// --- Query construction ---


// --- Mistake detection ---







// --- Brain extraction ---

// --- Brain fallback chain (Wave 1) ---
const BRAIN_FNS = {
  ollama:      brainOllama,
  openai:      brainOpenAI,
  gemini:      brainGemini,
  claude:      brainClaude,
  deepseek:    brainDeepSeek,
  siliconflow: brainOpenAI,   // OpenAI-compatible API
  custom:      brainOpenAI,   // OpenAI-compatible API
};

// Fallback config: primary provider → fallback provider

async function callBrainWithFallback(prompt, meta = {}) {
  const brainProvider = getBrainProvider();
  const fallbackProvider = getBrainFallback();
  const primary = BRAIN_FNS[brainProvider] || BRAIN_FNS.ollama;
  const units = estimateTextUnits(prompt, 4000);

  // Allow callers (e.g. route-task) to enforce tighter time budgets than the default 15s.
  const timeoutMs = Number(meta.timeoutMs ?? 0);
  const signal = meta.signal || (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

  let startedAt = Date.now();
  let result = await primary(prompt, { signal });
  logCostCall('brain', brainProvider, meta.source || 'general', units, {
    ok: !!result,
    phase: 'primary',
    durationMs: Date.now() - startedAt,
  });
  if (result) return result;

  activityLog({ op: 'brain-failure', provider: brainProvider, phase: 'primary' });
  if (fallbackProvider && BRAIN_FNS[fallbackProvider]) {
    startedAt = Date.now();
    result = await BRAIN_FNS[fallbackProvider](prompt, { signal });
    logCostCall('brain', fallbackProvider, meta.source || 'general', units, {
      ok: !!result,
      phase: 'fallback',
      durationMs: Date.now() - startedAt,
    });
    if (result) {
      activityLog({ op: 'brain-fallback', provider: fallbackProvider });
      return result;
    }
    activityLog({ op: 'brain-failure', provider: fallbackProvider, phase: 'fallback' });
  }
  return null;
}

// P6: Brain relevance filter — lightweight brain call to check if suggestions match the action
// Input: the action query + numbered warnings. Output: which numbers are relevant.
// Timeout: 3s (tight — fail-open if brain is slow). Cost: ~80 tokens input, ~5 tokens output.







// --- Organic support consolidation ---

const ORGANIC_SUPPORT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'before', 'after', 'ensure', 'always', 'should', 'must', 'have', 'has', 'are',
  'was', 'were', 'will', 'using', 'used', 'file', 'files', 'command',
]);









// --- Store ---



// --- Provider abstraction (D-08, D-09, D-10) ---
// EMBED_PROVIDER / BRAIN_PROVIDER come from config.json (set by setup.sh).
// Dim is ALWAYS read from config.json via getEmbedDim() — never hardcoded here.
// siliconflow and custom are first-class providers (reuse OpenAI-compatible fn).

// Lazy getters — embed functions assigned by delegation after module load
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
    const res = await fetch(getOllamaEmbedUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getEmbedModel(), input: text }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings?.[0] || null;
  } catch { return null; }
}

async function embedOpenAI(text, signal) {
  // Supports OpenAI, SiliconFlow, custom, and any OpenAI-compatible embedding API
  const endpoint = getEmbedEndpoint() || 'https://api.openai.com/v1/embeddings';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
      body: JSON.stringify({ model: getEmbedModel() || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

async function embedGemini(text, signal) {
  try {
    const model = getEmbedModel() || 'text-embedding-004';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${getEmbedKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
      body: JSON.stringify({ model: getEmbedModel() || 'voyage-code-3', input: [text.slice(0, 8000)] }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

// --- Qdrant search ---


// Qdrant user filter — only return entries owned by current user (or untagged legacy entries)


// --- Anti-Noise Scoring (Phase 103) ---








// --- Formatting ---



function getValidatedHitCount(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.validatedCount === 'number') return data.validatedCount;
  // Legacy entries used hitCount as "surfaced count". Do not treat that as validated signal.
  return 0;
}









function recordNovelCaseEvidence(data, context = {}) {
  if (!isPrincipleLikeEntry(data)) return data;
  ensureNovelCaseEvidence(data);
  const evidence = data.novelCaseEvidence;
  const sourceSession = String(context.sourceSession || '').trim();
  const projectSlug = String(context.projectSlug || '').trim();
  const dedupeKey = sourceSession || `${projectSlug || 'unknown-project'}:${data.lastHitAt || new Date().toISOString()}`;
  recordHoldoutOutcomeOnData(data, { holdoutKey: dedupeKey, matched: true, projectSlug, sourceSession });
  if (projectSlug && !evidence.holdoutProjects.includes(projectSlug)) {
    evidence.holdoutProjects.push(projectSlug);
    if (evidence.holdoutProjects.length > 20) evidence.holdoutProjects = evidence.holdoutProjects.slice(-20);
  }
  return data;
}

function recordHoldoutOutcomeOnData(data, outcome = {}) {
  if (!isPrincipleLikeEntry(data)) return data;
  ensureNovelCaseEvidence(data);
  const evidence = data.novelCaseEvidence;
  const holdoutKey = String(outcome.holdoutKey || outcome.sourceSession || '').trim()
    || `${String(outcome.projectSlug || 'unknown-project').trim()}:${String(outcome.label || 'holdout').trim()}`;
  const projectSlug = String(outcome.projectSlug || '').trim();
  const sourceSession = String(outcome.sourceSession || '').trim();
  const matched = outcome.matched === true;

  if (!evidence.holdoutTestedKeys.includes(holdoutKey)) {
    evidence.holdoutTestedKeys.push(holdoutKey);
    if (evidence.holdoutTestedKeys.length > 100) evidence.holdoutTestedKeys = evidence.holdoutTestedKeys.slice(-100);
    evidence.holdoutTestedCount += 1;
  }
  if (matched && !evidence.holdoutMatchedKeys.includes(holdoutKey)) {
    evidence.holdoutMatchedKeys.push(holdoutKey);
    if (evidence.holdoutMatchedKeys.length > 100) evidence.holdoutMatchedKeys = evidence.holdoutMatchedKeys.slice(-100);
    evidence.holdoutMatchedCount += 1;
    evidence.lastMatchedAt = data.lastHitAt || new Date().toISOString();
  }
  if (sourceSession && !evidence.holdoutSessions.includes(sourceSession)) {
    evidence.holdoutSessions.push(sourceSession);
    if (evidence.holdoutSessions.length > 50) evidence.holdoutSessions = evidence.holdoutSessions.slice(-50);
  }
  if (projectSlug && !evidence.holdoutProjects.includes(projectSlug)) {
    evidence.holdoutProjects.push(projectSlug);
    if (evidence.holdoutProjects.length > 20) evidence.holdoutProjects = evidence.holdoutProjects.slice(-20);
  }
  return data;
}

function applySurfaceUpdate(data) {
  ensureSignalMetrics(data);
  data.surfaceCount = (data.surfaceCount || 0) + 1;
  data.lastSurfacedAt = new Date().toISOString();
  return data;
}

// --- recordHit: increment hitCount on experience entries ---

function applyHitUpdate(data) {
  ensureSignalMetrics(data);
  data.validatedCount = (data.validatedCount || 0) + 1;
  data.hitCount = data.validatedCount;
  data.lastHitAt = new Date().toISOString();
  data.ignoreCount = 0;
  data.unusedCount = 0;
  // Phase 108: temporal trace — append to confirmedAt (cap at 50)
  data.confirmedAt.push(data.lastHitAt);
  if (data.confirmedAt.length > 50) data.confirmedAt = data.confirmedAt.slice(-50);
  const confidenceFloor = 0.50 + Math.min(0.18, (data.validatedCount || 0) * 0.04);
  data.confidence = Math.max(Number(data.confidence || 0), confidenceFloor);
  return data;
}

function applyHitUpdateWithContext(context = {}) {
  return function applyHitWithContext(data) {
    applyHitUpdate(data);
    const projectSlug = String(context.projectSlug || '').trim();
    if (projectSlug) {
      if (!Array.isArray(data.confirmedProjects)) data.confirmedProjects = [];
      if (!data.confirmedProjects.includes(projectSlug)) data.confirmedProjects.push(projectSlug);
      if (data.confirmedProjects.length > 20) data.confirmedProjects = data.confirmedProjects.slice(-20);
      data.lastConfirmedProject = projectSlug;
    }
    const sourceSession = String(context.sourceSession || '').trim();
    if (sourceSession) {
      if (!Array.isArray(data.confirmedSessions)) data.confirmedSessions = [];
      if (!data.confirmedSessions.includes(sourceSession)) data.confirmedSessions.push(sourceSession);
      if (data.confirmedSessions.length > 20) data.confirmedSessions = data.confirmedSessions.slice(-20);
      data.lastConfirmedSession = sourceSession;
    }
    const sourceKind = String(context.sourceKind || '').trim();
    if (sourceKind) {
      if (!Array.isArray(data.confirmedSourceKinds)) data.confirmedSourceKinds = [];
      if (!data.confirmedSourceKinds.includes(sourceKind)) data.confirmedSourceKinds.push(sourceKind);
      if (data.confirmedSourceKinds.length > 20) data.confirmedSourceKinds = data.confirmedSourceKinds.slice(-20);
      data.lastConfirmedSourceKind = sourceKind;
    }
    recordNovelCaseEvidence(data, context);
    return data;
  };
}

async function recordHit(collection, pointId) {
  await updatePointPayload(collection, pointId, applyHitUpdate);
}

async function recordSurface(collection, pointId) {
  await updatePointPayload(collection, pointId, applySurfaceUpdate);
}

async function recordHoldoutOutcome(collection, pointId, outcome = {}) {
  await updatePointPayload(collection, pointId, (data) => recordHoldoutOutcomeOnData(data, outcome));
}

// --- recordFeedback: explicit agent feedback on surfaced suggestions ---

async function recordFeedback(collection, pointId, verdictOrFollowed, reason = null, options = {}) {
  const verdict = normalizeFeedbackVerdict(verdictOrFollowed);
  if (!verdict) return false;

  const normalizedReason = verdict === 'IRRELEVANT' ? normalizeNoiseReason(reason) : null;
  const source = options.source === 'judge' ? 'judge' : 'manual';
  const updateFn = verdict === 'FOLLOWED'
    ? applyNoiseDispositionData('followed', source, null)
    : verdict === 'IGNORED'
      ? applyNoiseDispositionData('ignored', source, null)
      : applyNoiseDispositionData('irrelevant', source, normalizedReason);

  await updatePointPayload(collection, pointId, updateFn);
  activityLog({
    op: 'noise-disposition',
    collection,
    pointId: pointId.slice(0, 8),
    disposition: verdict.toLowerCase(),
    source,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
  activityLog({
    op: options.source === 'judge' ? 'judge-feedback' : 'feedback',
    collection,
    pointId: pointId.slice(0, 8),
    verdict,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
  return true;
}

// --- recordJudgeFeedback: LLM judge verdict with IRRELEVANT separation ---

async function recordJudgeFeedback(collection, pointId, verdict, reason = null) {
  const normalized = normalizeFeedbackVerdict(verdict);
  if (!normalized) return false; // UNCLEAR → no feedback
  return recordFeedback(collection, pointId, normalized, reason, { source: 'judge' });
}

// --- syncToQdrant: migrate FileStore data to Qdrant (per D-17) ---


// --- Edge graph (Phase 107) ---




// --- Evolution Engine (per D-03) ---

const T2_TO_T1_HIT_THRESHOLD = 2;
const T2_TO_T1_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PROBATIONARY_PRINCIPLE_HIT_THRESHOLD = 2;
const BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 8;
const BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.78;
const BEHAVIORAL_TO_PRINCIPLE_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.72;
const DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 4;
const DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.64;
const PROMOTE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48h cooldown after demotion before re-promotion







// --- Evolution helpers ---



async function getAllEntries(collection) {
  if (!(await checkQdrant())) {
    return fileStoreRead(collection);
  }
  // Qdrant: scroll all points (filtered by user namespace)
  const points = [];
  let offset = null;
  do {
    try {
      const body = { limit: 100, with_payload: true, with_vector: true, filter: { must: [buildQdrantUserFilter()] } };
      if (offset) body.offset = offset;
      const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.result?.points || [];
      points.push(...batch);
      offset = data.result?.next_page_offset || null;
    } catch { break; }
  } while (offset);
  return points;
}

async function upsertEntry(collection, id, vector, data) {
  const payload = { json: JSON.stringify(data), user: getExpUser() };
  if (!(await checkQdrant())) {
    fileStoreUpsert(collection, id, vector, payload);
    return;
  }
  await fetch(`${getQdrantBase()}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
    signal: AbortSignal.timeout(5000),
  });
}


// --- Phase 109: Share/Import principles ---



// --- getEmbeddingRaw: exported for external callers (e.g. bulk-seed.js) (D-16) ---

async function getEmbeddingRaw(text, signal) {}

// --- Qdrant multi-user migration: tag untagged entries with current user ---
// Runs once per process, best-effort. Tags existing points that lack a `user` field.

async function migrateQdrantUserTags() {
  // Bypass checkQdrant() cache — migration runs early, cache may not be warm yet.
  // Direct probe instead.
  try {
    const apiKey = getQdrantApiKey();
    const probe = await fetch(`${getQdrantBase()}/collections`, {
      headers: apiKey ? { 'api-key': apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!probe.ok) return;
    // Warm the cache for subsequent calls
    qdrantAvailable = true;
  } catch { return; }
  for (const coll of COLLECTIONS) {
    try {
      // Find points without user field
      const res = await fetch(`${getQdrantBase()}/collections/${coll.name}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ limit: 100, with_payload: true, with_vector: false, filter: { must: [{ is_empty: { key: 'user' } }] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const points = (await res.json()).result?.points || [];
      if (points.length === 0) continue;
      // Batch-set user field
      await fetch(`${getQdrantBase()}/collections/${coll.name}/points/payload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ points: points.map(p => p.id), payload: { user: getExpUser() } }),
        signal: AbortSignal.timeout(10000),
      });
      activityLog({ op: 'migrate-user-tags', collection: coll.name, tagged: points.length });
    } catch { /* best-effort */ }
  }
}

// Fire once on load (non-blocking)
migrateQdrantUserTags().catch(() => {});

// --- Model Router (route-model spec) ---

const CLASSIFY_PROMPT_TEMPLATE = `Classify this coding task. Reply with ONLY one word: fast, balanced, or premium.

fast = single file, simple fix, greeting, explanation, read-only
balanced = multi-file, feature, refactor across modules
premium = system redesign, architecture, security audit

If Context has local_tier with confidence >= 0.6, use it unless Task clearly contradicts.

Context: {CONTEXT}
Task: {TASK}
Complexity:`;

const TASK_ROUTE_PROMPT = `Route this coding task. Return ONLY valid JSON, no markdown.

Routes: qc-flow (broad/ambiguous, needs planning), qc-lock (narrow, ready to execute), direct (read-only explanation).
If ambiguous, set needs_disambiguation=true with route=null.

Examples:
- "explain how auth works" -> {"route":"direct","confidence":0.9,"needs_disambiguation":false,"reason":"explanation request"}
- "fix the login bug" -> {"route":"qc-lock","confidence":0.8,"needs_disambiguation":false,"reason":"narrow fix"}
- "improve the API performance" -> {"route":"qc-flow","confidence":0.7,"needs_disambiguation":false,"reason":"broad scope needs planning"}
- "do something with auth" -> {"route":null,"confidence":0.3,"needs_disambiguation":true,"reason":"ambiguous intent"}

Task: "{TASK}"
Context: {CONTEXT_JSON}
JSON:`;

/**
 * Context-based pre-filter — uses structural signals only (file count, file types).
 * Text classification is delegated to brain for language-agnostic detection.
 * Returns 'premium' | null (null = let brain decide).
 */



/**
 * Emit a structured routing decision line to stdout for GSD/user visibility.
 * Format: [Model Router] -> {tier} ({model}) — {reason} [{source}]
 */

// Bootstrap routes collection once on module load (fire-and-forget, like migrateQdrantUserTags)
let _routesCollectionReady = false;
async function ensureRoutesCollection() {
  if (_routesCollectionReady) return;
  if (!(await checkQdrant())) { _routesCollectionReady = true; return; } // FileStore needs no setup
  try {
    const check = await fetch(`${getQdrantBase()}/collections/${ROUTES_COLLECTION}`, {
      headers: { 'api-key': getQdrantApiKey() }, signal: AbortSignal.timeout(3000),
    });
    if (check.ok) { _routesCollectionReady = true; return; }
    await fetch(`${getQdrantBase()}/collections/${ROUTES_COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ vectors: { size: getEmbedDim(), distance: 'Cosine' } }),
      signal: AbortSignal.timeout(5000),
    });
    _routesCollectionReady = true;
  } catch { _routesCollectionReady = true; /* fall through to FileStore */ }
}

// Fire once on module load — removes per-call overhead from routeModel()
ensureRoutesCollection().catch(() => {});

/**
 * Call brain API for plain-text classification response.
 * Deliberately separate from callBrainWithFallback() which expects JSON.
 * Supports siliconflow (OpenAI-compatible) and ollama providers.
 * @param {string} prompt
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<string|null>} raw text response or null on failure
 */




// Task route pre-filter removed — brain handles all text classification.
// preFilterTaskRoute always returns null so brain is always consulted.









/**
 * Store a new route decision to both FileStore and Qdrant (dual-write).
 * Non-blocking — errors are swallowed so routing always returns quickly.
 */

/**
 * Route a task to the optimal model tier.
 *
 * Layer 0: Keyword pre-filter (free, ~0ms) — catches obvious cases
 * Layer 1: History check (semantic search, ~50ms) — reuse/upgrade past decisions
 * Layer 2: Brain classify (LLM call, ~200ms) — only when layers 0+1 miss
 * Fallback: getRouterDefaultTier()
 *
 * @param {string} task - Task description (any language)
 * @param {object|null} context - { files, domain, phase } optional context
 * @param {string|null} runtime - 'claude' | 'gemini' | 'codex' | 'opencode' | null
 * @returns {Promise<{tier, model, reasoningEffort, confidence, source, reason, taskHash}>}
 */
async function routeModel(task, context, runtime) {
  const taskText = (task || '').slice(0, 500);
  if (!taskText) {
    const tier = getRouterDefaultTier();
    const model = resolveTierModel(tier, runtime);
    const reasoningEffort = resolveTierReasoningEffort(tier, runtime);
    printRouteDecision(tier, model, 'empty task', 'default');
    activityLog({ op: 'route', task: '', tier, model, source: 'default', confidence: 0 });
    return { tier, model, reasoningEffort, confidence: 0, source: 'default', reason: 'empty task', taskHash: null };
  }

  const taskHash = require('crypto').createHash('sha256').update(taskText).digest('hex').slice(0, 16);

  // Layer 0: Keyword pre-filter (no API call)
  const preFilterTier = shouldSkipKeywordModelPrefilter(runtime)
    ? null
    : preFilterComplexity(taskText, context);
  if (preFilterTier) {
    const model = resolveTierModel(preFilterTier, runtime);
    const reasoningEffort = resolveTierReasoningEffort(preFilterTier, runtime);
    const reason = `${preFilterTier} complexity detected`;
    printRouteDecision(preFilterTier, model, reason, 'keyword');
    activityLog({ op: 'route', task: taskText.slice(0, 100), tier: preFilterTier, model, source: 'keyword', confidence: 0.70 });

    // Store for future history (async, non-blocking)
    getEmbedding(taskText).then(vector => {
      if (vector) storeRouteDecision(taskText, taskHash, preFilterTier, model, runtime, context, vector);
    }).catch(() => {});

    return { tier: preFilterTier, model, reasoningEffort, confidence: 0.70, source: 'keyword', reason, taskHash };
  }

  // Layer 1: History check (semantic search)
  try {
    const vector = await getEmbedding(taskText);
    if (vector) {
      const hits = await searchCollection(ROUTES_COLLECTION, vector, 3);
      const bestHit = hits.find(h => (h.score || 0) >= getRouterHistoryThreshold());
      if (bestHit) {
        const data = (() => { try { return JSON.parse(bestHit.payload?.json || '{}'); } catch { return {}; } })();
        if (data.outcome) {
          let tier = data.tier || getRouterDefaultTier();
          let source = 'history';
          const tiers = ['fast', 'balanced', 'premium'];
          const isNegative = data.outcome === 'fail' || data.outcome === 'cancelled' || (data.retryCount || 0) >= 2;
          if (isNegative) {
            const idx = tiers.indexOf(tier);
            if (idx < tiers.length - 1) tier = tiers[idx + 1];
            source = 'history-upgrade';
          }
          const model = resolveTierModel(tier, runtime);
          const reasoningEffort = resolveTierReasoningEffort(tier, runtime);
          const reason = source === 'history-upgrade'
            ? `similar task ${data.outcome === 'cancelled' ? 'was cancelled' : 'failed'} on ${data.tier || 'lower tier'}`
            : 'similar task succeeded before';
          const result = { tier, model, reasoningEffort, confidence: bestHit.score, source, reason, taskHash };
          printRouteDecision(tier, model, reason, source);
          activityLog({ op: 'route', task: taskText.slice(0, 100), tier, model, source, confidence: bestHit.score });
          return result;
        }
      }
    }
  } catch { /* Layer 1 failure — proceed to Layer 2 */ }

  // Layer 2: Brain classify (plain text — separate from callBrainWithFallback which expects JSON)
  try {
    const prompt = buildModelRoutePrompt(taskText, context);
    const brainResult = await classifyViaBrain(prompt);
    if (brainResult) {
      const normalizedTier = normalizeTierResponse(brainResult);
      const rawTier = normalizedTier || getRouterDefaultTier();
      const tierAdjustment = maybeCapTierForCost(rawTier, taskText, context, runtime);
      const tier = tierAdjustment.tier;
      const model = resolveTierModel(tier, runtime);
      const reasoningEffort = resolveTierReasoningEffort(tier, runtime);
      const confidence = normalizedTier ? 0.75 : 0.50;
      const reason = tierAdjustment.adjusted
        ? `${rawTier} complexity task; ${tierAdjustment.reason}`
        : `${tier} complexity task`;
      const result = { tier, model, reasoningEffort, confidence, source: 'brain', reason, taskHash };
      printRouteDecision(tier, model, reason, 'brain');
      activityLog({ op: 'route', task: taskText.slice(0, 100), tier, model, source: 'brain', confidence });

      // Dual-write: store route decision for future history
      try {
        const vector = await getEmbedding(taskText);
        if (vector) await storeRouteDecision(taskText, taskHash, tier, model, runtime, context, vector);
      } catch { /* non-blocking */ }

      return result;
    }
  } catch { /* Layer 2 failure — fall through to default */ }

  // Fallback: safe default
  const fallbackTier = getRouterDefaultTier();
  const model = resolveTierModel(fallbackTier, runtime);
  const reasoningEffort = resolveTierReasoningEffort(fallbackTier, runtime);
  printRouteDecision(fallbackTier, model, 'classification unavailable', 'default');
  activityLog({ op: 'route', task: taskText.slice(0, 100), tier: fallbackTier, model, source: 'default', confidence: 0 });
  return { tier: fallbackTier, model, reasoningEffort, confidence: 0, source: 'default', reason: 'fallback — classification unavailable', taskHash };
}

/**
 * Route a raw task to qc-flow, qc-lock, or direct.
 * Uses the configured brain provider for the primary classification path and
 * returns a disambiguation verdict when user intent is still unclear.
 *
 * @param {string} task
 * @param {object|null} context
 * @param {string|null} runtime
 * @returns {Promise<{route:string|null, confidence:number, source:string, reason:string, needs_disambiguation:boolean, options:Array, taskHash:string|null}>}
 */

/**
 * Record agent outcome for a past routing decision.
 * Dual-writes update to both FileStore and Qdrant.
 * ESC/interrupt → outcome='cancelled' → treated as negative → tier upgrade next time.
 *
 * @param {string} taskHash - Hash from routeModel response
 * @param {string|null} tier - Tier used (for orphan records when taskHash not found)
 * @param {string|null} model - Model used
 * @param {string} outcome - 'success' | 'fail' | 'retry' | 'cancelled'
 * @param {number} [retryCount=0]
 * @param {number|null} [duration=null] - Duration in ms
 * @returns {Promise<boolean>} true if record was found and updated
 */

// --- Exports ---

// --- Module delegate overrides (Phase 1 refactoring) ---
// Functions already delegated via const at top of file.
// Remaining late-init overrides:


function _delegateQdrant() {
  checkQdrant = _qdrant.checkQdrant;
  fileStorePath = _qdrant.fileStorePath;
  fileStoreRead = _qdrant.fileStoreRead;
  acquireLock = _qdrant.acquireLock;
  releaseLock = _qdrant.releaseLock;
  fileStoreWrite = _qdrant.fileStoreWrite;
  fileStoreUpsert = _qdrant.fileStoreUpsert;
  cosineSimilarity = _qdrant.cosineSimilarity;
  fileStoreSearch = _qdrant.fileStoreSearch;
  buildQdrantUserFilter = _qdrant.buildQdrantUserFilter;
  fetchPointById = _qdrant.fetchPointById;
  searchCollection = _qdrant.searchCollection;
  updatePointPayload = _qdrant.updatePointPayload;
  deleteEntry = _qdrant.deleteEntry;
  syncToQdrant = _qdrant.syncToQdrant;
}

function _delegateBrain() {
  getBrainFallback = _brainllm.getBrainFallback;
  callBrainWithFallback = _brainllm.callBrainWithFallback;
  brainRelevanceFilter = _brainllm.brainRelevanceFilter;
  extractQA = _brainllm.extractQA;
  brainOllama = _brainllm.brainOllama;
  brainOpenAI = _brainllm.brainOpenAI;
  brainGemini = _brainllm.brainGemini;
  brainClaude = _brainllm.brainClaude;
  brainDeepSeek = _brainllm.brainDeepSeek;
}

function _delegateFormat() {
  buildStorePayload = _format.buildStorePayload;
  formatPoints = _format.formatPoints;
  applyBudget = _format.applyBudget;
  ensureSignalMetrics = _format.ensureSignalMetrics;
  normalizeEvidenceClass = _format.normalizeEvidenceClass;
  normalizeConditions = _format.normalizeConditions;
  normalizeFailureMode = _format.normalizeFailureMode;
  normalizeJudgment = _format.normalizeJudgment;
  ensureAbstractionFields = _format.ensureAbstractionFields;
  ensureNovelCaseEvidence = _format.ensureNovelCaseEvidence;
  isPrincipleLikeEntry = _format.isPrincipleLikeEntry;
  buildPrincipleText = _format.buildPrincipleText;
  normalizeTechLabel = _format.normalizeTechLabel;
}

function _delegateGraph() {
  createEdge = _graph.createEdge;
  getEdgesForId = _graph.getEdgesForId;
  getEdgesOfType = _graph.getEdgesOfType;
}

function _delegateEvolution() {
  tokenizeOrganicSupportText = _evolution.tokenizeOrganicSupportText;
  organicSupportText = _evolution.organicSupportText;
  tokenOverlapRatio = _evolution.tokenOverlapRatio;
  conditionOverlapCount = _evolution.conditionOverlapCount;
  buildOrganicSupportKey = _evolution.buildOrganicSupportKey;
  isOrganicSupportCandidate = _evolution.isOrganicSupportCandidate;
  findOrganicSupportCandidate = _evolution.findOrganicSupportCandidate;
  applyOrganicSupportUpdate = _evolution.applyOrganicSupportUpdate;
  uniqueConfirmationCount = _evolution.uniqueConfirmationCount;
  hasRepeatedSessionConfirmations = _evolution.hasRepeatedSessionConfirmations;
  resetPromotionProbation = _evolution.resetPromotionProbation;
  shouldPromoteBehavioralToPrinciple = _evolution.shouldPromoteBehavioralToPrinciple;
  parsePayload = _evolution.parsePayload;
  clusterByCosine = _evolution.clusterByCosine;
  sharePrinciple = _evolution.sharePrinciple;
  importPrinciple = _evolution.importPrinciple;
  migrateQdrantUserTags = _evolution.migrateQdrantUserTags;
  storeExperience = _evolution.storeExperience;
  evolve = _evolution.evolve;
}

function _delegateRouter() {
  isRouterEnabled = _router.isRouterEnabled;
  getRouterHistoryThreshold = _router.getRouterHistoryThreshold;
  getRouterDefaultTier = _router.getRouterDefaultTier;
  getModelTiers = _router.getModelTiers;
  getReasoningEffortTiers = _router.getReasoningEffortTiers;
  normalizeReasoningEffort = _router.normalizeReasoningEffort;
  validateCodexModel = _router.validateCodexModel;
  validateCodexReasoning = _router.validateCodexReasoning;
  preFilterComplexity = _router.preFilterComplexity;
  isQcFlowFrontHalfContext = _router.isQcFlowFrontHalfContext;
  maybeCapTierForCost = _router.maybeCapTierForCost;
  printRouteDecision = _router.printRouteDecision;
  ensureRoutesCollection = _router.ensureRoutesCollection;
  classifyViaBrain = _router.classifyViaBrain;
  normalizeTierResponse = _router.normalizeTierResponse;
  normalizeTaskRoute = _router.normalizeTaskRoute;
  foldClassifierText = _router.foldClassifierText;
  preFilterTaskRoute = _router.preFilterTaskRoute;
  parseJsonObjectFromText = _router.parseJsonObjectFromText;
  defaultTaskRouteOptions = _router.defaultTaskRouteOptions;
  normalizeTaskRoutePayload = _router.normalizeTaskRoutePayload;
  buildTaskRoutePrompt = _router.buildTaskRoutePrompt;
  resolveTierModel = _router.resolveTierModel;
  resolveTierReasoningEffort = _router.resolveTierReasoningEffort;
  buildModelRoutePrompt = _router.buildModelRoutePrompt;
  shouldSkipKeywordModelPrefilter = _router.shouldSkipKeywordModelPrefilter;
  storeRouteDecision = _router.storeRouteDecision;
  routeModel = _router.routeModel;
  routeTask = _router.routeTask;
  routeFeedback = _router.routeFeedback;
  detectRuntime = _router.detectRuntime;
  resolveRuntimeFromSourceMeta = _router.resolveRuntimeFromSourceMeta;
}

function _delegateLate() {
  // Nothing left to delegate — all config functions are const at top
}

// Embedding delegates (not hoist-safe at top)
function _delegateEmbedding() {
  getEmbedding = _embedding.getEmbedding;
  getEmbeddingRaw = _embedding.getEmbeddingRaw;
}

// Utils module
function _delegateNoise() {
  hasRecentValidatedConfirmation = _noise.hasRecentValidatedConfirmation;
  isCodeSpecificHint = _noise.isCodeSpecificHint;
  shouldSuppressForNoise = _noise.shouldSuppressForNoise;
  filterNoiseSuppressedPoints = _noise.filterNoiseSuppressedPoints;
  inferLanguageMismatch = _noise.inferLanguageMismatch;
  ensureNoiseReasonCounts = _noise.ensureNoiseReasonCounts;
  ensureNoiseSourceCounts = _noise.ensureNoiseSourceCounts;
  recordNoiseMetadataData = _noise.recordNoiseMetadataData;
}

function _delegateScoring() {
  computeEffectiveConfidence = _scoring.computeEffectiveConfidence;
  computeEffectiveScore = _scoring.computeEffectiveScore;
  rerankByQuality = _scoring.rerankByQuality;
  getSurfaceCountForProbation = _scoring.getSurfaceCountForProbation;
  hasProbationaryT2Debt = _scoring.hasProbationaryT2Debt;
  isProbationaryT2Candidate = _scoring.isProbationaryT2Candidate;
  selectProbationaryT2Points = _scoring.selectProbationaryT2Points;
}

function _delegateContext() {
  detectTranscriptDomain = _context.detectTranscriptDomain;
  normalizeExtractText = _context.normalizeExtractText;
  isPlaceholderExtractField = _context.isPlaceholderExtractField;
  isMetaWorkflowExtract = _context.isMetaWorkflowExtract;
  assessExtractedQaQuality = _context.assessExtractedQaQuality;
  detectNaturalLang = _context.detectNaturalLang;
  parseTranscriptToolCall = _context.parseTranscriptToolCall;
  isTranscriptReadOnlyToolCall = _context.isTranscriptReadOnlyToolCall;
  isMutatingTranscriptToolCall = _context.isMutatingTranscriptToolCall;
  extractRetryTarget = _context.extractRetryTarget;
  isTranscriptErrorSignal = _context.isTranscriptErrorSignal;
  detectMistakes = _context.detectMistakes;
}

function _delegateSession() {
  sanitizeSessionToken = _session.sanitizeSessionToken;
  getSessionTrackFile = _session.getSessionTrackFile;
  readSessionTrack = _session.readSessionTrack;
  writeSessionTrack = _session.writeSessionTrack;
  trackSuggestions = _session.trackSuggestions;
  sessionUniqueCount = _session.sessionUniqueCount;
  incrementIgnoreCountData = _session.incrementIgnoreCountData;
  incrementIrrelevantData = _session.incrementIrrelevantData;
  incrementUnusedData = _session.incrementUnusedData;
  normalizeNoiseDisposition = _session.normalizeNoiseDisposition;
  normalizeNoiseSource = _session.normalizeNoiseSource;
  normalizeFeedbackVerdict = _session.normalizeFeedbackVerdict;
  normalizeNoiseReason = _session.normalizeNoiseReason;
  shortPointId = _session.shortPointId;
  dedupeSuggestionLines = _session.dedupeSuggestionLines;
}

function _delegateUtils() {
  // Only delegate functions unique to utils — scoring/format/noise already delegated by their own modules
  detectContext = _utils.detectContext;
  normalizeTechLabel = _utils.normalizeTechLabel;
  commandSuggestsDomain = _utils.commandSuggestsDomain;
  extractProjectPath = _utils.extractProjectPath;
  extractProjectSlug = _utils.extractProjectSlug;
  buildQuery = _utils.buildQuery;
  dedupePointsBySource = _utils.dedupePointsBySource;
  pointSourceKey = _utils.pointSourceKey;
  applyBudget = _utils.applyBudget;
  inferLanguageMismatch = _utils.inferLanguageMismatch;
  hasRecentValidatedConfirmation = _utils.hasRecentValidatedConfirmation;
  isCodeSpecificHint = _utils.isCodeSpecificHint;
  normalizeSourceMeta = _utils.normalizeSourceMeta;
  resolveRuntimeFromSourceMeta = _utils.resolveRuntimeFromSourceMeta;
  detectRuntime = _utils.detectRuntime;
}

function _delegateAll() {
  _delegateQdrant();
  _delegateBrain();
  _delegateFormat();
  _delegateGraph();
  _delegateEvolution();
  _delegateRouter();
  _delegateNoise();
  _delegateScoring();
  _delegateContext();
  _delegateSession();
  _delegateLate();
  _delegateEmbedding();
  _delegateUtils();
}
_delegateAll();

module.exports = { intercept, interceptWithMeta, recordFeedback, recordJudgeFeedback, classifyViaBrain, extractFromSession, recordHit, recordSurface, recordHoldoutOutcome, incrementIgnoreCount, syncToQdrant, evolve, getEmbeddingRaw, searchCollection, deleteEntry, createEdge, getEdgesForId, getEdgesOfType, EDGE_COLLECTION, sharePrinciple, importPrinciple, EXP_USER, extractProjectSlug, migrateQdrantUserTags, routeTask, routeModel, routeFeedback, _updatePointPayload: updatePointPayload, _applyHitUpdate: applyHitUpdate, _applySurfaceUpdate: applySurfaceUpdate, _applyHoldoutOutcome: recordHoldoutOutcomeOnData, _activityLog: activityLog, _detectContext: detectContext, _buildQuery: buildQuery, _computeEffectiveScore: computeEffectiveScore, _computeEffectiveConfidence: computeEffectiveConfidence, _rerankByQuality: rerankByQuality, _formatPoints: formatPoints, _isProbationaryT2Candidate: isProbationaryT2Candidate, _selectProbationaryT2Points: selectProbationaryT2Points, _isHookRealtimeFastPath: isHookRealtimeFastPath, _isPromptHookPrecisionGate: isPromptHookPrecisionGate, _filterPromptHookPoints: filterPromptHookPoints, _storeExperiencePayload: (qa, domain, projectSlug) => buildStorePayload(require('crypto').randomUUID(), qa, domain || null, projectSlug || null), _extractProjectSlug: extractProjectSlug, _buildStorePayload: buildStorePayload, _recordHitUpdatesFields: applyHitUpdate, _recordSurfaceUpdatesFields: applySurfaceUpdate, _applyOrganicSupportUpdate: applyOrganicSupportUpdate, _isOrganicSupportCandidate: isOrganicSupportCandidate, _trackSuggestions: trackSuggestions, _sessionUniqueCount: sessionUniqueCount, _incrementIgnoreCountData: incrementIgnoreCountData, _incrementUnusedData: incrementUnusedData, _applyNoiseDispositionData: applyNoiseDispositionData, _shouldSuppressForNoise: shouldSuppressForNoise, _filterNoiseSuppressedPoints: filterNoiseSuppressedPoints, _reconcilePendingHints: reconcilePendingHints, _reconcileStalePromptSuggestions: reconcileStalePromptSuggestions, _assessHintUsage: assessHintUsage, _detectTranscriptDomain: detectTranscriptDomain, _detectNaturalLang: detectNaturalLang, _callBrainWithFallback: callBrainWithFallback, _isReadOnlyCommand: isReadOnlyCommand, _brainRelevanceFilter: brainRelevanceFilter, _extractProjectPath: extractProjectPath, _extractPathFromCommand: extractPathFromCommand, _detectRuntime: detectRuntime, _resolveRuntimeFromSourceMeta: resolveRuntimeFromSourceMeta, _isRouterEnabled: isRouterEnabled, _assessExtractedQaQuality: assessExtractedQaQuality, _normalizeExtractText: normalizeExtractText, _detectMistakes: detectMistakes, _shouldPromoteBehavioralToPrinciple: shouldPromoteBehavioralToPrinciple, _buildPrincipleText: buildPrincipleText, _getValidatedHitCount: getValidatedHitCount };
