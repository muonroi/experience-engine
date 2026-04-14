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

// --- Native config loader (D-06) ---
// Reads ~/.experience/config.json BEFORE any other config.
// setup.sh writes this file. No injection, no env auto-detect.
// Singleton loader: one cache per process, but refreshes automatically when the file changes.
const CONFIG_PATH = pathMod.join(os.homedir(), '.experience', 'config.json');
const configState = { mtimeMs: null, value: {} };

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig(force = false) {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!force && configState.mtimeMs === stat.mtimeMs) return configState.value;
    configState.mtimeMs = stat.mtimeMs;
    configState.value = readConfigFile();
    return configState.value;
  } catch {
    configState.mtimeMs = null;
    configState.value = {};
    return configState.value;
  }
}

function getConfig() {
  return loadConfig(false);
}

function refreshConfig() {
  return loadConfig(true);
}

function cfgValue(key, envKey, fallback) {
  const cfg = getConfig();
  return cfg[key] ?? process.env[envKey] ?? fallback;
}

// --- Config (D-07, D-11) ---
// Priority: config.json > EXPERIENCE_* env vars > defaults
// NEVER fall back to ambient env (OPENAI_API_KEY, GEMINI_API_KEY, etc.)

function getQdrantBase()     { return cfgValue('qdrantUrl', 'EXPERIENCE_QDRANT_URL', 'http://localhost:6333'); }
function getQdrantApiKey()   { return cfgValue('qdrantKey', 'EXPERIENCE_QDRANT_KEY', ''); }
function getOllamaBase()     { return cfgValue('ollamaUrl', 'EXPERIENCE_OLLAMA_URL', 'http://localhost:11434'); }
function getEmbedProvider()  { return cfgValue('embedProvider', 'EXPERIENCE_EMBED_PROVIDER', 'ollama'); }
function getBrainProvider()  { return cfgValue('brainProvider', 'EXPERIENCE_BRAIN_PROVIDER', 'ollama'); }
function getEmbedModel()     { return cfgValue('embedModel', 'EXPERIENCE_EMBED_MODEL', 'nomic-embed-text'); }
function getBrainModel()     { return cfgValue('brainModel', 'EXPERIENCE_BRAIN_MODEL', 'qwen2.5:3b'); }
function getEmbedEndpoint()  { return cfgValue('embedEndpoint', 'EXPERIENCE_EMBED_ENDPOINT', ''); }
function getEmbedKey()       { return cfgValue('embedKey', 'EXPERIENCE_EMBED_KEY', ''); }
function getBrainEndpoint()  { return cfgValue('brainEndpoint', 'EXPERIENCE_BRAIN_ENDPOINT', ''); }
function getBrainKey()       { return cfgValue('brainKey', 'EXPERIENCE_BRAIN_KEY', ''); }
function getEmbedDim()       { return cfgValue('embedDim', 'EXPERIENCE_EMBED_DIM', 768); }
function getMinConfidence()  { return cfgValue('minConfidence', 'EXPERIENCE_MIN_CONFIDENCE', 0.42); }
function getHighConfidence() { return cfgValue('highConfidence', 'EXPERIENCE_HIGH_CONFIDENCE', 0.60); }

// --- Model Router config ---
function isRouterEnabled() {
  return getConfig().routing === true;
}

function getRouterHistoryThreshold() {
  return getConfig().routerHistoryThreshold ?? 0.80;
}

function getRouterDefaultTier() {
  return getConfig().routerDefaultTier ?? 'balanced';
}

function getModelTiers() {
  return getConfig().modelTiers || {
    claude:   { fast: 'claude-haiku-4-5',  balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' },
    gemini:   { fast: 'gemini-3-flash',    balanced: 'gemini-3-pro',      premium: 'gemini-3.1-pro' },
    codex:    { fast: 'o4-mini',           balanced: 'gpt-5.2',           premium: 'gpt-5.4' },
    opencode: { fast: 'claude-haiku-4-5',  balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' },
  };
}

function getOllamaEmbedUrl() {
  return `${getOllamaBase()}/api/embed`;
}

function getOllamaGenerateUrl() {
  return `${getOllamaBase()}/api/generate`;
}

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
const UNUSED_NO_TOUCH_THRESHOLD = 3;
const PENDING_HINT_TTL_MS = 20 * 60 * 1000;

// --- Session-persistent tracking (file-based, survives process restarts) ---
// Each hook invocation is a NEW process, so in-memory arrays are useless.
// Key by date + CWD hash — PPID is unreliable on Windows (changes every hook call).

const SESSION_TRACK_DIR = require('path').join(require('os').tmpdir(), 'experience-session');
const MAX_SESSION_UNIQUE = 8; // P2: max unique experiences surfaced per session

function sanitizeSessionToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function getSessionTrackFile(meta) {
  try { fs.mkdirSync(SESSION_TRACK_DIR, { recursive: true }); } catch {}
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sessionToken = sanitizeSessionToken(
    meta?.sourceSession
    || process.env.CODEX_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.GEMINI_SESSION_ID
  );
  if (sessionToken) {
    return pathMod.join(SESSION_TRACK_DIR, `session-${today}-${sessionToken}.json`);
  }
  // Fallback: YYYYMMDD + CWD hash when no runtime session id is available.
  const cwd = process.cwd() || '';
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) { hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0; }
  const sessionKey = `${today}-${(hash >>> 0).toString(36)}`;
  return pathMod.join(SESSION_TRACK_DIR, `session-${sessionKey}.json`);
}

function readSessionTrack(meta) {
  try {
    const raw = fs.readFileSync(getSessionTrackFile(meta), 'utf8');
    const data = JSON.parse(raw);
    // Expire after 2 hours (session likely ended)
    if (Date.now() - (data.startedAt || 0) > 2 * 60 * 60 * 1000) return { startedAt: Date.now(), seen: {}, counts: {}, pending: {} };
    if (!data.pending || typeof data.pending !== 'object' || Array.isArray(data.pending)) data.pending = {};
    return data;
  } catch {
    return { startedAt: Date.now(), seen: {}, counts: {}, pending: {} };
  }
}

function writeSessionTrack(track, meta) {
  try { fs.writeFileSync(getSessionTrackFile(meta), JSON.stringify(track)); } catch {}
}

/**
 * Track surfaced suggestions in persistent session file.
 * Returns: { filtered: ids to skip (already shown), flagged: ids with 3+ repeats }
 */
function trackSuggestions(surfacedPoints, meta) {
  const track = readSessionTrack(meta);
  const flagged = [];
  const filtered = [];

  for (const sp of surfacedPoints) {
    const key = sp.id;
    track.counts[key] = (track.counts[key] || 0) + 1;

    // NOISE-04: flag for ignore-count increment after 3+ repeats
    if (track.counts[key] >= 3) {
      flagged.push({ id: sp.id, collection: sp.collection, consecutive: track.counts[key] });
    }

    // P4: Dedup — skip if already shown in this session
    if (track.seen[key]) {
      filtered.push(sp);
      continue;
    }
    track.seen[key] = Date.now();
  }

  writeSessionTrack(track, meta);
  return { flagged, filtered };
}

/**
 * P2: Check if session budget is exhausted (max unique experiences).
 * Returns number of unique experiences already shown.
 */
function sessionUniqueCount(meta) {
  const track = readSessionTrack(meta);
  return Object.keys(track.seen).length;
}

function incrementIgnoreCountData(data) {
  data.ignoreCount = (data.ignoreCount || 0) + 1;
  return data;
}

function incrementIrrelevantData(data) {
  data.irrelevantCount = (data.irrelevantCount || 0) + 1;
  data.lastIrrelevantAt = new Date().toISOString();
  return data;
}

function incrementUnusedData(data) {
  data.unusedCount = (data.unusedCount || 0) + 1;
  data.lastUnusedAt = new Date().toISOString();
  return data;
}

function normalizeFeedbackVerdict(verdictOrFollowed) {
  if (typeof verdictOrFollowed === 'boolean') {
    return verdictOrFollowed ? 'FOLLOWED' : 'IGNORED';
  }
  const verdict = String(verdictOrFollowed || '').trim().toUpperCase();
  return VALID_FEEDBACK_VERDICTS.has(verdict) ? verdict : null;
}

function normalizeNoiseReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return VALID_NOISE_REASONS.has(normalized) ? normalized : null;
}

function shortPointId(pointId) {
  return String(pointId || '').slice(0, 8);
}

function pointSourceKey(point, fallbackCollection = null) {
  const collection = point?._collection || fallbackCollection || '';
  const pointId = String(point?.id || '');
  return pointId ? `${collection}:${pointId}` : null;
}

function dedupePointsBySource(points, fallbackCollection = null) {
  const seen = new Set();
  const unique = [];
  for (const point of points || []) {
    if (!point) continue;
    const key = pointSourceKey(point, fallbackCollection);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    if (fallbackCollection && !point._collection) {
      unique.push({ ...point, _collection: fallbackCollection });
    } else {
      unique.push(point);
    }
  }
  return unique;
}

function dedupeSuggestionLines(lines) {
  const seen = new Set();
  const unique = [];
  for (const line of lines || []) {
    const normalized = String(line || '').trim();
    if (!normalized) continue;
    const idMatch = normalized.match(/\[id:([^\s\]]+)\s+col:([^\]]+)\]/);
    const key = idMatch ? `${idMatch[2]}:${idMatch[1]}` : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique;
}

function normalizeTechLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'typescript react' || normalized === 'typescript') return 'typescript';
  if (normalized === 'javascript react' || normalized === 'javascript') return 'javascript';
  if (normalized === 'csharp' || normalized === 'c#') return 'c#';
  if (normalized === 'fsharp' || normalized === 'f#') return 'f#';
  if (normalized === 'yaml') return 'yaml';
  return normalized;
}

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

function commandSuggestsDomain(actionText, domain) {
  const keywords = DOMAIN_KEYWORDS[normalizeTechLabel(domain)];
  if (!keywords || keywords.length === 0) return false;
  const text = String(actionText || '').toLowerCase();
  return keywords.some(keyword => text.includes(keyword));
}

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

function inferLanguageMismatch(surface, actionDomain) {
  const scopeLang = normalizeTechLabel(surface?.scope?.lang);
  const hintDomain = normalizeTechLabel(surface?.domain);
  const normalizedAction = normalizeTechLabel(actionDomain);
  if (!normalizedAction) return false;
  if (scopeLang === 'all') return false;
  if (scopeLang && normalizedAction && scopeLang !== normalizedAction) {
    return true;
  }
  if (!scopeLang && hintDomain && normalizedAction && hintDomain !== normalizedAction) {
    return true;
  }
  return false;
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
  const track = readSessionTrack();
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
      await updatePointPayload(pending.collection, pending.id, incrementUnusedData);
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

  writeSessionTrack(track);
  return results;
}

function ensureNoiseReasonCounts(data) {
  if (!data.noiseReasonCounts || typeof data.noiseReasonCounts !== 'object' || Array.isArray(data.noiseReasonCounts)) {
    data.noiseReasonCounts = {};
  }
  return data.noiseReasonCounts;
}

function incrementIrrelevantWithReasonData(reason) {
  return function applyIrrelevantWithReason(data) {
    incrementIrrelevantData(data);
    const normalized = normalizeNoiseReason(reason);
    if (!normalized) return data;
    const counts = ensureNoiseReasonCounts(data);
    counts[normalized] = (counts[normalized] || 0) + 1;
    data.lastNoiseReason = normalized;
    return data;
  };
}

/**
 * Shared read-modify-write helper for FileStore and Qdrant.
 * Fetches the point payload, calls updateFn(data) to mutate in-place, then writes back.
 * @param {string} collection - Collection name
 * @param {string} pointId    - Point UUID
 * @param {Function} updateFn - Mutates data object in-place (e.g. applyHitUpdate, incrementIgnoreCountData)
 */
async function updatePointPayload(collection, pointId, updateFn) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const entry = entries.find(e => e.id === pointId);
    if (entry && entry.payload?.json) {
      const data = JSON.parse(entry.payload.json);
      updateFn(data);
      entry.payload.json = JSON.stringify(data);
      fileStoreWrite(collection, entries);
    }
    return;
  }
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const point = (await res.json()).result;
    if (!point?.payload?.json) return;
    const data = JSON.parse(point.payload.json);
    updateFn(data);
    await fetch(`${getQdrantBase()}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent */ }
}

async function incrementIgnoreCount(collection, pointId) {
  await updatePointPayload(collection, pointId, incrementIgnoreCountData);
}

// --- Qdrant availability (per D-14) ---
let qdrantAvailable = null; // null = unchecked, true/false = checked
// Phase 109: Multi-user support — user-namespaced store directory
function getExpUser() {
  return cfgValue('user', 'EXP_USER', 'default');
}
// Backward-compat: many call sites reference EXP_USER directly
const EXP_USER = getExpUser();

const FILESTORE_BASE = pathMod.join(os.homedir(), '.experience', 'store');

function getFileStoreDir() {
  return pathMod.join(FILESTORE_BASE, getExpUser());
}

// Auto-migrate: if old-style files exist at base and user is 'default', move them
(() => {
  if (getExpUser() !== 'default') return;
  try {
    const oldFiles = fs.readdirSync(FILESTORE_BASE).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    if (oldFiles.length > 0 && !fs.existsSync(getFileStoreDir())) {
      fs.mkdirSync(getFileStoreDir(), { recursive: true });
      for (const f of oldFiles) {
        const src = pathMod.join(FILESTORE_BASE, f);
        const dst = pathMod.join(getFileStoreDir(), f);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
    }
  } catch { /* migration is best-effort */ }
})();

async function checkQdrant() {
  if (qdrantAvailable !== null) return qdrantAvailable;
  try {
    const apiKey = getQdrantApiKey();
    const res = await fetch(`${getQdrantBase()}/collections`, {
      headers: apiKey ? { 'api-key': apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrantAvailable = res.ok;
  } catch { qdrantAvailable = false; }
  return qdrantAvailable;
}

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

function normalizeSourceMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  return {
    ...(meta.sourceKind ? { sourceKind: meta.sourceKind } : {}),
    ...(meta.sourceRuntime ? { sourceRuntime: meta.sourceRuntime } : {}),
    ...(meta.sourceSession ? { sourceSession: meta.sourceSession } : {}),
  };
}

function extractProjectPath(toolInput) {
  const raw = toolInput?.file_path || toolInput?.path || '';
  if (raw) return raw.replace(/\\/g, '/');

  // For Bash/Shell commands: extract project path from command text
  const cmd = toolInput?.command || toolInput?.cmd || '';
  if (!cmd) return null;

  const extracted = extractPathFromCommand(cmd);
  return extracted ? extracted.replace(/\\/g, '/') : null;
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
function extractProjectSlug(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  // Match: /sources/{org}/{project}/ or /repos/{project}/ or /projects/{project}/
  const patterns = [
    /\/sources\/[^/]+\/([^/]+)/i,
    /\/repos\/([^/]+)/i,
    /\/projects\/([^/]+)/i,
    /\/workspace\/([^/]+)/i,
    /\/home\/[^/]+\/([^/]+)/i,
  ];
  for (const pat of patterns) {
    const m = normalized.match(pat);
    if (m) return m[1].toLowerCase();
  }
  // Fallback: use first 2 meaningful path segments
  const parts = normalized.split('/').filter(p => p && p !== '.' && p !== '..');
  if (parts.length >= 2) return parts.slice(0, 2).join('/').toLowerCase();
  return null;
}

function fileStorePath(collection) {
  return pathMod.join(getFileStoreDir(), `${collection}.json`);
}

function fileStoreRead(collection) {
  try {
    return JSON.parse(fs.readFileSync(fileStorePath(collection), 'utf8'));
  } catch { return []; }
}

// File-level locking to prevent concurrent hook processes from clobbering data.
// Uses exclusive open (wx) on a .lock file with a stale timeout of 5s.
const LOCK_STALE_MS = 5000;

function acquireLock(collection) {
  const lockPath = fileStorePath(collection) + '.lock';
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try {
      // O_WRONLY | O_CREAT | O_EXCL — fails if file already exists
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check for stale lock (process died without releasing)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue; // retry after removing stale lock
          }
        } catch { /* lock gone between check — retry */ continue; }
        // Active lock — brief spin wait (1ms)
        const start = Date.now();
        while (Date.now() - start < 1) {} // busy-wait 1ms (no sleep in sync context)
        continue;
      }
      return false; // unexpected error — proceed without lock
    }
  }
  return false; // timeout — proceed without lock to avoid blocking hooks
}

function releaseLock(collection) {
  try { fs.unlinkSync(fileStorePath(collection) + '.lock'); } catch {}
}

function fileStoreWrite(collection, entries) {
  fs.mkdirSync(getFileStoreDir(), { recursive: true });
  const locked = acquireLock(collection);
  try {
    const tmp = fileStorePath(collection) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2)); // pretty-printed per specifics
    fs.renameSync(tmp, fileStorePath(collection)); // atomic per D-16
  } finally {
    if (locked) releaseLock(collection);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function fileStoreSearch(collection, vector, topK) {
  const entries = fileStoreRead(collection);
  const scored = entries
    .filter(e => e.vector && e.vector.length === vector.length)
    .map(e => ({ ...e, score: cosineSimilarity(vector, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  // Return in Qdrant-compatible format
  return scored.map(e => ({ id: e.id, score: e.score, payload: e.payload }));
}

function fileStoreUpsert(collection, id, vector, payload) {
  const entries = fileStoreRead(collection);
  const idx = entries.findIndex(e => e.id === id);
  const entry = { id, vector, payload };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  fileStoreWrite(collection, entries);
}

// --- Intercept: query experience before tool call ---

// P5: Read-only command detection — fast-path skip, no embedding/search cost
const READ_ONLY_CMD = /^(ls|dir|cat|head|tail|wc|file|stat|find|tree|which|where|echo|printf|pwd|whoami|hostname|date|uptime|type|less|more|sort|uniq|tee|realpath|basename|dirname|env|printenv|id|groups|df|du|free|top|htop|lsof|ps|pgrep|mount|uname)\b|^git\s+(log|status|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|shortlog|blame|reflog|ls-files|ls-tree|name-rev|cherry)\b|^(grep|rg|ag|ack)\b|^diff\b|^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why)\b|^(dotnet)\s+(--list-sdks|--list-runtimes|--info)\b|^(docker|podman)\s+(ps|images|inspect|logs|stats|top|port|volume\s+ls|network\s+ls)\b/;

/**
 * Detect the agent runtime from tool name patterns and env vars.
 * Returns 'claude' | 'gemini' | 'codex' | 'opencode' | null.
 */
function detectRuntime(toolName) {
  const tool = (toolName || '').toLowerCase();
  // Gemini CLI uses run_shell_command, write_file, edit_file, replace_in_file
  if (process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR
    || /^(run_shell_command|write_file|edit_file|replace_in_file)$/.test(tool)) return 'gemini';
  // Codex CLI
  if (process.env.CODEX_SESSION_ID) return 'codex';
  // OpenCode
  if (process.env.OPENCODE_SESSION_ID) return 'opencode';
  // Default: Claude Code (Edit, Write, Bash, Shell)
  return 'claude';
}

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
  const vector = await getEmbedding(query, signal);
  if (!vector) return null;

  // Route model in parallel with searches when routing is enabled (zero added latency)
  const routePromise = isRouterEnabled()
    ? routeModel(query, { files: [filePath].filter(Boolean), domain: queryDomain }, detectRuntime(toolName)).catch(() => null)
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
  const r0 = dedupePointsBySource(rerankByQuality(applyScopeFilter(t0), queryDomain, queryProjectSlug), COLLECTIONS[0].name);
  const r1 = dedupePointsBySource(rerankByQuality(applyScopeFilter(t1), queryDomain, queryProjectSlug), COLLECTIONS[1].name);
  const r2 = dedupePointsBySource(rerankByQuality(applyScopeFilter(t2), queryDomain, queryProjectSlug), COLLECTIONS[2].name);

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
            const graphFormatted = formatPoints([graphPoint]);
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
      return exp.solution && computeEffectiveConfidence(exp) >= getMinConfidence();
    } catch { return false; }
  });
  if (surfaced.length > 0) {
    Promise.all(surfaced.map(p => recordHit(p._collection, p.id))).catch(() => {});
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

  // P6: Brain relevance filter — ask brain if remaining suggestions are relevant to THIS action
  if (lines.length > 0 && getConfig().brainFilter !== false) {
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
    project: extractProjectPath(toolInput),
    ...(routeResult ? { route: routeResult.tier, routeModel: routeResult.model, routeSource: routeResult.source } : {}),
    ...sourceMeta
  });

  return { suggestions: lines.length > 0 ? lines.join('\n---\n') : null, surfacedIds: shownSurfacedMeta, route: routeResult || null };
}

// --- intercept: backward-compatible wrapper returning string|null ---

async function intercept(toolName, toolInput, signal, meta) {
  const result = await interceptWithMeta(toolName, toolInput, signal, meta);
  return result ? result.suggestions : null;
}

// --- Extract: detect mistakes and store lessons ---

function detectTranscriptDomain(transcript) {
  if (!transcript) return null;
  const pattern = /[\w/\\.-]+\.(ts|tsx|js|jsx|cs|py|rs|go|java|kt|swift|cpp|c|rb|lua|sh|ps1|sql)\b/gi;
  const counts = {};
  let match;
  while ((match = pattern.exec(transcript)) !== null) {
    const ext = '.' + match[1].toLowerCase();
    counts[ext] = (counts[ext] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return detectContext(entries[0][0]) || null;
}

async function extractFromSession(transcript, projectPath) {
  if (!transcript || transcript.length < 100) return 0;

  const domain = detectTranscriptDomain(transcript);

  const mistakes = detectMistakes(transcript);
  if (mistakes.length === 0) {
    activityLog({ op: 'extract', mistakes: 0, stored: 0, project: projectPath || null });
    return 0;
  }

  let stored = 0;
  for (const mistake of mistakes.slice(0, 5)) {
    try {
      const qa = await extractQA(mistake);
      if (!qa || !qa.trigger || !qa.solution) continue;
      if (await isDuplicate(qa)) continue;
      const projectSlug = extractProjectSlug(projectPath);
      await storeExperience(qa, domain, projectSlug);
      stored++;
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

function detectContext(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  const ext = '.' + parts.pop().toLowerCase();
  return LANG_MAP[ext] || null;
}

// Wave 2: Natural language detection for cross-lingual matching
function detectNaturalLang(text) {
  if (!text) return 'en';
  // Vietnamese detection: Latin diacritics + combining marks + Vietnamese-specific block
  const viPattern = /[\u00C0-\u00FF\u0100-\u024F\u0300-\u036F\u1EA0-\u1EFF]/g;
  const viCount = (text.match(viPattern) || []).length;
  return viCount >= 2 ? 'vi' : 'en';
}

// --- Query construction ---

function buildQuery(toolName, toolInput) {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  const context = detectContext(filePath);
  let raw;
  // Normalize tool names across agents
  const tool = (toolName || '').toLowerCase();

  if (tool === 'bash' || tool === 'shell' || tool === 'execute_command') {
    raw = `Command: ${(toolInput.command || toolInput.cmd || '').slice(0, 200)}`;
  } else if (tool === 'edit' || tool === 'replace' || tool === 'replace_in_file') {
    raw = `Edit: ${toolInput.file_path || toolInput.path || ''} — ${(toolInput.new_string || toolInput.content || '').slice(0, 300)}`;
  } else if (tool === 'write' || tool === 'write_file' || tool === 'create_file') {
    raw = `Write: ${toolInput.file_path || toolInput.path || ''} — ${(toolInput.content || '').slice(0, 300)}`;
  } else {
    raw = `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  }
  if (context) {
    raw = `[${context}] ${raw}`;
  }
  return raw.slice(0, QUERY_MAX_CHARS);
}

// --- Mistake detection ---

function detectMistakes(transcript) {
  const mistakes = [];
  const lines = transcript.split('\n');

  // Retry loops
  const toolCalls = {};
  for (const line of lines) {
    const match = line.match(/(Edit|Write|Bash|shell|replace|write_file).*?([\w./]+\.\w+)/i);
    if (match) {
      const key = `${match[1]}:${match[2]}`;
      toolCalls[key] = (toolCalls[key] || 0) + 1;
    }
  }
  for (const [key, count] of Object.entries(toolCalls)) {
    if (count >= 3) {
      mistakes.push({
        type: 'retry_loop',
        context: `Tool ${key} called ${count} times`,
        excerpt: lines.filter(l => l.includes(key.split(':')[1])).slice(0, 10).join('\n')
      });
    }
  }

  // Error → fix patterns
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].match(/error|Error|ERROR|fail|FAIL|exception/i)
        && lines[i + 1] && !lines[i + 1].match(/error|Error|fail/i)) {
      mistakes.push({
        type: 'error_fix',
        context: 'Error followed by correction',
        excerpt: lines.slice(Math.max(0, i - 2), i + 4).join('\n')
      });
    }
  }

  // User correction (per D-10, D-12) — proximity window after tool call
  const toolCallPattern = /Tool(Use|Call)|tool_name|toolName|>\s*(Edit|Write|Bash|Read)/i;
  const correctionPattern = /\b(no[,.]?\s|wrong|don't|instead|not that|stop|undo|revert this)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (toolCallPattern.test(lines[i])) {
      // Check next 5 lines for user correction
      for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
        if (correctionPattern.test(lines[j])) {
          mistakes.push({
            type: 'user_correction',
            context: `User corrected agent after tool call at line ${i}`,
            excerpt: lines.slice(Math.max(0, i - 1), j + 2).join('\n')
          });
          break;
        }
      }
    }
  }

  // Test fail -> fix (per D-10)
  const testFailPattern = /\bFAIL\b|test\s+failed|AssertionError|AssertError|FAILED|assert\.|expect\(.*\)\.to/i;
  const fixActionPattern = /(Edit|Write|write_file|replace|replace_in_file)/i;
  for (let i = 0; i < lines.length; i++) {
    if (testFailPattern.test(lines[i])) {
      for (let j = i + 1; j <= Math.min(i + 10, lines.length - 1); j++) {
        if (fixActionPattern.test(lines[j])) {
          mistakes.push({
            type: 'test_fail_fix',
            context: `Test failure at line ${i} followed by fix at line ${j}`,
            excerpt: lines.slice(Math.max(0, i - 1), j + 3).join('\n')
          });
          break;
        }
      }
    }
  }

  // Git revert (per D-10)
  const gitRevertPattern = /git\s+(revert|reset\s+--hard|checkout\s+--\s|restore\s)/i;
  for (let i = 0; i < lines.length; i++) {
    if (gitRevertPattern.test(lines[i])) {
      mistakes.push({
        type: 'git_revert',
        context: `Git revert/reset detected at line ${i}`,
        excerpt: lines.slice(Math.max(0, i - 3), i + 3).join('\n')
      });
    }
  }

  return mistakes;
}

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
function getBrainFallback() {
  return cfgValue('brainFallback', 'EXPERIENCE_BRAIN_FALLBACK', getBrainProvider() === 'ollama' ? '' : 'ollama');
}

async function callBrainWithFallback(prompt) {
  const brainProvider = getBrainProvider();
  const fallbackProvider = getBrainFallback();
  const primary = BRAIN_FNS[brainProvider] || BRAIN_FNS.ollama;
  let result = await primary(prompt);
  if (result) return result;
  activityLog({ op: 'brain-failure', provider: brainProvider, phase: 'primary' });
  if (fallbackProvider && BRAIN_FNS[fallbackProvider]) {
    result = await BRAIN_FNS[fallbackProvider](prompt);
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
async function brainRelevanceFilter(actionQuery, suggestionLines, signal, projectSlug) {
  if (!suggestionLines || suggestionLines.length === 0) return null;
  const hasClearHighConfidenceWarning = suggestionLines.some(line => /Experience - High Confidence \(([-\d.]+)\)/.test(line));

  // Extract just the warning text (strip emoji/score prefix for cleaner prompt)
  const warnings = suggestionLines.map((line, i) => {
    const clean = line.replace(/^.*?\]:\s*/, '');
    return `${i + 1}. ${clean}`;
  });

  const projectCtx = projectSlug ? `\nPROJECT: ${projectSlug} — warnings about OTHER projects are NOT relevant.` : '';
  const prompt = `You are a relevance filter. An AI coding agent is about to perform this action:

ACTION: ${actionQuery.slice(0, 300)}${projectCtx}

These warnings were retrieved from past experience:
${warnings.join('\n')}

Which warnings could help prevent a mistake in THIS SPECIFIC action?
Rules:
- A warning is relevant ONLY if the action could actually trigger the mistake the warning describes
- Generic advice that doesn't match the specific action is NOT relevant
- Warnings about a DIFFERENT project/codebase than the current one are NOT relevant
- "ls", "git log", "cat" commands reading files NEVER need warnings about code patterns

Reply with ONLY the relevant warning numbers separated by commas (e.g. "1,3"), or "none" if none are relevant.`;

  // Use a dedicated fast brain call with short timeout
  try {
    const brainProvider = getBrainProvider();
    let response;

    // Direct call with tight timeout — bypass callBrainWithFallback to avoid JSON parsing
    if (brainProvider === 'ollama') {
      const res = await fetch(getOllamaGenerateUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: getBrainModel(), prompt, stream: false, options: { temperature: 0.1, num_predict: 20 } }),
        signal: signal || AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      response = (await res.json()).response || '';
    } else {
      // OpenAI-compatible / Gemini / Claude — use chat endpoint
      const endpoint = getBrainEndpoint() || 'https://api.openai.com/v1/chat/completions';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
        body: JSON.stringify({ model: getBrainModel(), messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 20 }),
        signal: signal || AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      response = (await res.json()).choices?.[0]?.message?.content || '';
    }

    const text = response.trim().toLowerCase();
    if (text === 'none' || text === '0' || text === '') {
      return hasClearHighConfidenceWarning ? null : [];
    }

    // Parse comma-separated numbers
    const nums = text.match(/\d+/g);
    if (!nums) return null; // unparseable — fail-open
    const validIndices = nums.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < suggestionLines.length);
    if (validIndices.length === 0) {
      return hasClearHighConfidenceWarning ? null : [];
    }
    return validIndices.map(i => suggestionLines[i]);
  } catch {
    return null; // timeout or error — fail-open, show all suggestions
  }
}

async function extractQA(mistake) {
  const prompt = `Given this session excerpt where something went wrong:\n${mistake.excerpt.slice(0, 1500)}\n\nExtract in JSON (no markdown):\n{"trigger":"when this fires","question":"one line","reasoning":["step1","step2"],"solution":"what to do","why":"root cause or incident that created this rule","scope":{"lang":"C#|JavaScript|all","repos":[],"filePattern":"*.cs"}}`;
  return callBrainWithFallback(prompt);
}

async function brainOllama(prompt) {
  try {
    const res = await fetch(getOllamaGenerateUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getBrainModel(), prompt, stream: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    const m = (await res.json()).response?.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainOpenAI(prompt) {
  // Reused for any OpenAI-compatible API (OpenAI, SiliconFlow, Together, Groq, etc.)
  const endpoint = getBrainEndpoint() || 'https://api.openai.com/v1/chat/completions';
  const body = { model: getBrainModel() || 'gpt-4o-mini', messages: [{ role:'user', content: prompt }], temperature: 0.3 };
  // Only add json_object mode for known-supporting providers (OpenAI, DeepSeek)
  if (endpoint.includes('openai.com') || endpoint.includes('deepseek.com')) {
    body.response_format = { type: 'json_object' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    // Try direct parse, fallback to regex extract
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainGemini(prompt) {
  try {
    const model = getBrainModel() || 'gemini-2.0-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getBrainKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch { return null; }
}

async function brainClaude(prompt) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': getBrainKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: getBrainModel() || 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role:'user', content: prompt }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).content?.[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainDeepSeek(prompt) {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify({ model: getBrainModel() || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
  } catch { return null; }
}

// --- Dedup ---

async function isDuplicate(qa) {
  const vector = await getEmbedding(`${qa.trigger} ${qa.question}`);
  if (!vector) return false;

  if (!(await checkQdrant())) {
    const results = fileStoreSearch(SELFQA_COLLECTION, vector, 1);
    return (results[0]?.score ?? 0) > DEDUP_THRESHOLD;
  }

  try {
    const res = await fetch(`${getQdrantBase()}/collections/${SELFQA_COLLECTION}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ query: vector, limit: 1, with_payload: false, filter: { must: [buildQdrantUserFilter()] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.result?.points?.[0]?.score ?? 0) > DEDUP_THRESHOLD;
  } catch { return false; }
}

// --- Store ---

function buildStorePayload(id, qa, domain, projectSlug) {
  // Wave 2: Tag natural language for cross-lingual matching
  const naturalLang = detectNaturalLang(`${qa.trigger} ${qa.solution}`);
  return {
    id, trigger: qa.trigger, question: qa.question,
    reasoning: qa.reasoning || [], solution: qa.solution,
    why: qa.why || null,    // v2: root cause / incident motivation
    scope: qa.scope || null, // v2: {lang, repos, filePattern} — hard filter gate
    confidence: 0.5, hitCount: 0, tier: 2,
    lastHitAt: null, ignoreCount: 0, unusedCount: 0,
    confirmedAt: [],  // Phase 108: temporal trace
    domain: domain || null,
    _projectSlug: projectSlug || null, // P0: project-aware filtering
    naturalLang,
    createdAt: new Date().toISOString(), createdFrom: 'session-extractor',
  };
}

async function storeExperience(qa, domain, projectSlug) {
  const text = `${qa.trigger} ${qa.question} ${qa.solution}`;
  const vector = await getEmbedding(text);
  if (!vector) return;

  const id = crypto.randomUUID();
  const payload = {
    json: JSON.stringify(buildStorePayload(id, qa, domain, projectSlug)),
    user: getExpUser(),
  };

  if (!(await checkQdrant())) {
    fileStoreUpsert(SELFQA_COLLECTION, id, vector, payload);
  } else {
    await fetch(`${getQdrantBase()}/collections/${SELFQA_COLLECTION}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
      signal: AbortSignal.timeout(5000),
    });
  }

  // Phase 107: Create relates-to and supersedes edges
  if (vector) {
    try {
      const existing = await getAllEntries(SELFQA_COLLECTION);
      for (const entry of existing) {
        if (entry.id === id) continue;
        if (!entry.vector || entry.vector.length !== vector.length) continue;
        const sim = cosineSimilarity(vector, entry.vector);
        if (sim > DEDUP_THRESHOLD) {
          const d = parsePayload(entry);
          if (d && d.trigger && qa.trigger && d.trigger === qa.trigger) {
            createEdge(id, entry.id, 'supersedes', parseFloat(sim.toFixed(3)), 'store-supersedes');
          }
        }
        if (sim > RELATES_TO_THRESHOLD && sim <= DEDUP_THRESHOLD) {
          createEdge(id, entry.id, 'relates-to', parseFloat(sim.toFixed(3)), 'store-similarity');
        }
      }
    } catch { /* never block store on edge creation */ }
  }
}

// --- Provider abstraction (D-08, D-09, D-10) ---
// EMBED_PROVIDER / BRAIN_PROVIDER come from config.json (set by setup.sh).
// Dim is ALWAYS read from config.json via getEmbedDim() — never hardcoded here.
// siliconflow and custom are first-class providers (reuse OpenAI-compatible fn).

const EMBED_PROVIDERS = {
  ollama:       { fn: embedOllama },
  openai:       { fn: embedOpenAI },
  gemini:       { fn: embedGemini },
  voyageai:     { fn: embedVoyageAI },
  siliconflow:  { fn: embedOpenAI },
  custom:       { fn: embedOpenAI },
};

async function getEmbedding(text, signal) {
  const p = EMBED_PROVIDERS[getEmbedProvider()] || EMBED_PROVIDERS.ollama;
  return p.fn(text, signal);
}

async function embedOllama(text, signal) {
  try {
    const res = await fetch(getOllamaEmbedUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getEmbedModel(), input: text }),
      signal: signal || AbortSignal.timeout(10000),
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
      signal: signal || AbortSignal.timeout(10000),
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
      signal: signal || AbortSignal.timeout(10000),
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
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

// --- Qdrant search ---

async function fetchPointById(collection, pointId) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const found = entries.find(e => e.id === pointId);
    return found ? { id: found.id, score: 1.0, payload: found.payload } : null;
  }
  try {
    const apiKey = getQdrantApiKey();
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? { id: data.result.id, score: 1.0, payload: data.result.payload } : null;
  } catch { return null; }
}

// Qdrant user filter — only return entries owned by current user (or untagged legacy entries)
function buildQdrantUserFilter() {
  return {
    should: [
      { key: 'user', match: { value: getExpUser() } },
      { is_empty: { key: 'user' } },  // backward-compat: untagged = accessible by all
    ],
  };
}

async function searchCollection(name, vector, topK, signal) {
  if (!(await checkQdrant())) return fileStoreSearch(name, vector, topK);
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ query: vector, limit: topK, with_payload: true, filter: { must: [buildQdrantUserFilter()] } }),
      signal,
    });
    if (!res.ok) return fileStoreSearch(name, vector, topK);
    return (await res.json()).result?.points ?? [];
  } catch { return fileStoreSearch(name, vector, topK); }
}

// --- Anti-Noise Scoring (Phase 103) ---

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug) {
  const cosine = point.score || 0;
  const hitBoost = Math.log2(1 + (data.hitCount || 0)) * 0.08;
  const daysSinceHit = data.lastHitAt
    ? (Date.now() - new Date(data.lastHitAt).getTime()) / 86400000
    : 0;
  const recencyPenalty = daysSinceHit > 30
    ? Math.min(0.15, (daysSinceHit - 30) / 335 * 0.15)
    : 0;
  const ignorePenalty = Math.min(0.30, (data.ignoreCount || 0) * 0.05);
  const irrelevantPenalty = Math.min(0.24, (data.irrelevantCount || 0) * 0.04);
  const unusedPenalty = Math.min(0.18, (data.unusedCount || 0) * 0.03);
  const noiseReasonCounts = data.noiseReasonCounts || {};
  const noiseReasonPenalty = Math.min(
    0.18,
    ((noiseReasonCounts.wrong_repo || 0) * 0.05)
      + ((noiseReasonCounts.wrong_language || 0) * 0.04)
      + ((noiseReasonCounts.wrong_task || 0) * 0.03)
      + ((noiseReasonCounts.stale_rule || 0) * 0.06)
  );
  // P3: Heavier domain penalty (was 0.08/0.03, now 0.20/0.05)
  const domainPenalty = (queryDomain && data.domain && queryDomain !== data.domain) ? 0.20
    : (queryDomain && !data.domain) ? 0.05 : 0;
  // P0: Project-aware penalty — cross-project suggestions heavily penalized
  // v2: bypass penalty when scope.lang='all' (universal behavioral rules should surface everywhere)
  let projectPenalty = 0;
  if (queryProjectSlug && data._projectSlug) {
    const scopeLang = data.scope?.lang;
    if (queryProjectSlug !== data._projectSlug && scopeLang !== 'all') projectPenalty = 0.70;
  }
  // Phase 108: temporal boost/penalty from confirmedAt trace
  let temporalAdj = 0;
  const confirmed = Array.isArray(data.confirmedAt) ? data.confirmedAt : [];
  if (confirmed.length > 0) {
    const mostRecent = new Date(confirmed[confirmed.length - 1]).getTime();
    const daysSinceConfirm = (Date.now() - mostRecent) / 86400000;
    if (daysSinceConfirm <= 7) temporalAdj = 0.05;       // recently confirmed — boost
    else if (daysSinceConfirm > 60) temporalAdj = -0.08;  // stale — penalty
  }
  // Phase 108: superseded experience penalty
  const supersededPenalty = data.superseded ? 0.15 : 0;
  // Wave 3: Confidence weighting — low-confidence entries rank lower
  const confWeight = computeEffectiveConfidence(data);
  const rawScore = cosine + hitBoost - recencyPenalty - ignorePenalty - irrelevantPenalty - unusedPenalty - noiseReasonPenalty - domainPenalty - projectPenalty + temporalAdj - supersededPenalty;
  return rawScore * (0.6 + 0.4 * confWeight); // scale: 0.6 floor to avoid zeroing out
}

function rerankByQuality(points, queryDomain, queryProjectSlug) {
  return points
    .map(p => {
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      return { ...p, _effectiveScore: computeEffectiveScore(p, data, queryDomain, queryProjectSlug) };
    })
    .sort((a, b) => b._effectiveScore - a._effectiveScore);
}

// --- Formatting ---

function formatPoints(points) {
  const lines = [];
  for (const point of points) {
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    // Use effective confidence for the MIN_CONFIDENCE filter (NOISE-03)
    const effConf = computeEffectiveConfidence(exp);
    if (effConf < getMinConfidence()) continue;
    // Use _effectiveScore (from rerankByQuality) for display, fallback to raw score
    const displayScore = point._effectiveScore ?? point.score ?? 0;
    let line;
    if (displayScore >= getHighConfidence()) {
      line = `⚠️ [Experience - High Confidence (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else {
      line = `💡 [Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    }
    // v2: append why when present so agent understands the motivation
    if (exp.why) {
      line += `\n   Why: ${exp.why}`;
    }
    // v2: append point ID so agent can call POST /api/feedback when ignoring
    const pid = String(point.id).slice(0, 8);
    const coll = point._collection || 'experience-behavioral';
    line += `\n   [id:${pid} col:${coll}]`;
    lines.push(line);
  }
  return lines;
}

function applyBudget(lines, maxChars) {
  const result = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > maxChars) break;
    result.push(line);
    total += line.length;
  }
  return result;
}

// --- recordHit: increment hitCount on experience entries ---

function applyHitUpdate(data) {
  data.hitCount = (data.hitCount || 0) + 1;
  data.lastHitAt = new Date().toISOString();
  data.ignoreCount = 0;
  data.unusedCount = 0;
  // Phase 108: temporal trace — append to confirmedAt (cap at 50)
  if (!Array.isArray(data.confirmedAt)) data.confirmedAt = [];
  data.confirmedAt.push(data.lastHitAt);
  if (data.confirmedAt.length > 50) data.confirmedAt = data.confirmedAt.slice(-50);
  return data;
}

async function recordHit(collection, pointId) {
  await updatePointPayload(collection, pointId, applyHitUpdate);
}

// --- recordFeedback: explicit agent feedback on surfaced suggestions ---

async function recordFeedback(collection, pointId, verdictOrFollowed, reason = null, options = {}) {
  const verdict = normalizeFeedbackVerdict(verdictOrFollowed);
  if (!verdict) return false;

  const normalizedReason = verdict === 'IRRELEVANT' ? normalizeNoiseReason(reason) : null;
  const updateFn = verdict === 'FOLLOWED'
    ? applyHitUpdate
    : verdict === 'IGNORED'
      ? incrementIgnoreCountData
      : incrementIrrelevantWithReasonData(normalizedReason);

  await updatePointPayload(collection, pointId, updateFn);
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

async function syncToQdrant() {
  if (!(await checkQdrant())) throw new Error('Qdrant not available');
  const collections = COLLECTIONS.map(c => c.name);
  let synced = 0;
  for (const coll of collections) {
    const entries = fileStoreRead(coll);
    if (entries.length === 0) continue;
    // Batch upsert in chunks of 50
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50).map(e => ({
        id: e.id, vector: e.vector, payload: e.payload,
      }));
      await fetch(`${getQdrantBase()}/collections/${coll}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ points: batch }),
        signal: AbortSignal.timeout(30000),
      });
      synced += batch.length;
    }
  }
  return synced;
}

// --- Edge graph (Phase 107) ---

function createEdge(source, target, type, weight = 1.0, createdBy = 'auto') {
  const edge = {
    id: crypto.randomUUID(),
    source, target,
    type, // 'generalizes' | 'contradicts' | 'supersedes' | 'relates-to'
    weight,
    createdAt: new Date().toISOString(),
    createdBy,
  };
  const edges = fileStoreRead(EDGE_COLLECTION);
  const exists = edges.some(e => {
    try {
      const d = JSON.parse(e.payload?.json || '{}');
      return d.source === source && d.target === target && d.type === type;
    } catch { return false; }
  });
  if (exists) return null;
  // Edges are FileStore-only — no vector search needed, queried by source/target ID.
  // Removed dummy vector: [0] Qdrant upsert (Risk #4: wasted index space).
  fileStoreUpsert(EDGE_COLLECTION, edge.id, [], { json: JSON.stringify(edge), user: getExpUser() });
  activityLog({ op: 'edge-create', type, source: source.slice(0, 8), target: target.slice(0, 8) });
  return edge;
}

function getEdgesForId(experienceId) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && (e.source === experienceId || e.target === experienceId));
}

function getEdgesOfType(type) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && e.type === type);
}

// --- Evolution Engine (per D-03) ---

async function evolve(trigger) {
  const results = { promoted: 0, abstracted: 0, demoted: 0, archived: 0 };

  // Step 1: Promote T2 -> T1 (per D-04)
  // Read all T2 entries, filter hitCount >= 3, write to T1, delete from T2
  const t2Entries = await getAllEntries('experience-selfqa');
  for (const entry of t2Entries) {
    const data = parsePayload(entry);
    if (!data || (data.hitCount || 0) < 3) continue;
    // Wave 1: Minimum 7-day age before promotion — prevent rapid-fire poisoning
    const ageMs = Date.now() - new Date(data.createdAt || 0).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) continue;
    data.tier = 1;
    data.promotedAt = new Date().toISOString();
    const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
    if (!vector) continue;
    await upsertEntry('experience-behavioral', entry.id, vector, data);
    await deleteEntry('experience-selfqa', entry.id);
    results.promoted++;
  }

  // Step 1b: Promote probationary principles T1 -> T0 (Wave 1: principle probation)
  // Principles created by abstraction start at T1; promote to T0 after 3 confirmed hits
  const t1PrincipleEntries = await getAllEntries('experience-behavioral');
  for (const entry of t1PrincipleEntries) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'evolution-abstraction') continue;
    if ((data.hitCount || 0) >= 3) {
      data.tier = 0;
      data.promotedToT0At = new Date().toISOString();
      const vector = entry.vector || await getEmbedding(`${data.principle || data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-principles', entry.id, vector, data);
      await deleteEntry('experience-behavioral', entry.id);
      results.promoted++;
    }
  }

  // Step 2: Abstract T2 clusters -> T0 (per D-05)
  // Cluster T2 by cosine > 0.80, groups of 3+ -> brain abstract -> T0 principle
  const remainingT2 = await getAllEntries('experience-selfqa');
  const clustered = clusterByCosine(remainingT2, 0.80);
  for (const cluster of clustered) {
    if (cluster.length < 3) continue;
    const summaries = cluster.map(e => {
      const d = parsePayload(e);
      return d ? `${d.trigger}: ${d.solution}` : '';
    }).filter(Boolean);

    // Wave 3: Structured conditions[] — principle carries preconditions for constraint checking
    const prompt = `Given these ${summaries.length} related experiences, extract ONE general principle covering all cases. Format as JSON: {"principle":"When [condition], always [action] because [reason]","conditions":["keyword1","keyword2","keyword3"]}\nConditions = 2-4 keywords that MUST be present for this principle to apply.\n\n${summaries.join('\n')}`;

    const result = await callBrainWithFallback(prompt);
    if (!result?.principle) continue;

    const vector = await getEmbedding(result.principle);
    if (!vector) continue;

    // Wave 2: Round-trip validation — principle must match ≥60% of source cluster members
    let matchCount = 0;
    for (const e of cluster) {
      if (!e.vector || e.vector.length !== vector.length) continue;
      if (cosineSimilarity(vector, e.vector) >= 0.65) matchCount++;
    }
    if (matchCount / cluster.length < 0.6) {
      activityLog({ op: 'evolve-reject', reason: 'round-trip-fail', matchRate: matchCount / cluster.length, principle: result.principle.slice(0, 80) });
      continue;
    }

    const id = crypto.randomUUID();
    // Wave 1: Principle probation — start at T1 (behavioral), promote to T0 after 3 hits
    await upsertEntry('experience-behavioral', id, vector, {
      id, principle: result.principle, solution: result.principle,
      conditions: Array.isArray(result.conditions) ? result.conditions.slice(0, 4) : [],
      tier: 1, confidence: Math.min(0.80, 0.50 + (cluster.length / 10) * 0.30), hitCount: 0,
      createdAt: new Date().toISOString(), createdFrom: 'evolution-abstraction',
      sourceCount: cluster.length,
    });

    // Phase 107: Create generalizes edges (T2 sources -> T0 principle)
    for (const e of cluster) {
      createEdge(e.id, id, 'generalizes', 1.0, 'evolve-abstraction');
    }

    // Delete source entries from T2
    for (const e of cluster) {
      await deleteEntry('experience-selfqa', e.id);
    }
    results.abstracted++;
  }

  // Step 2b: Demote T0 -> T2 on contradiction (Wave 2: principle rollback)
  const t0Entries = await getAllEntries('experience-principles');
  for (const entry of t0Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = (data.ignoreCount || 0) >= 5
      || (data.contradiction && (data.contradictionCount || 1) >= 2);
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.3);
      data.demotedFromT0At = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction' : 'ignored';
      createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-t0-demotion');
      const vector = entry.vector || await getEmbedding(`${data.principle || data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-principles', entry.id);
      results.demoted++;
      activityLog({ op: 'evolve-t0-demote', id: entry.id.slice(0, 8), reason: data.demoteReason });
    }
  }

  // Step 3: Demote T1 -> T2 (per D-06)
  // Demotion triggers:
  //   - ignoreCount >= 3: agent repeatedly ignores this suggestion (tracked by NOISE-04)
  //   - confidence decayed below getMinConfidence() after aging
  //   - contradiction flag set externally (future: user override)
  const t1Entries = await getAllEntries('experience-behavioral');
  for (const entry of t1Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = data.contradiction
      || (data.ignoreCount || 0) >= 3
      || computeEffectiveConfidence(data) < getMinConfidence();
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.2);
      data.demotedAt = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction'
        : (data.ignoreCount || 0) >= 3 ? 'ignored'
        : 'confidence_decay';
      // Phase 107: Create contradicts edge on demotion
      if (data.demoteReason === 'contradiction' || data.demoteReason === 'ignored') {
        createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-demotion');
      }
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-behavioral', entry.id);
      results.demoted++;
    }
  }

  // Step 4: Archive stale T2 (per D-07)
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const allT2 = await getAllEntries('experience-selfqa');
  for (const entry of allT2) {
    const data = parsePayload(entry);
    if (!data) continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age > NINETY_DAYS && (data.hitCount || 0) === 0) {
      await deleteEntry('experience-selfqa', entry.id);
      results.archived++;
    }
  }

  // Step 4b: TTL cleanup for bulk-seeded T1 entries (60-day expiry if no organic confirmation)
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  const t1All = await getAllEntries('experience-behavioral');
  for (const entry of t1All) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'bulk-seed') continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age <= SIXTY_DAYS) continue;
    // No organic confirmations = confirmedAt is empty or missing
    const hasOrganic = Array.isArray(data.confirmedAt) && data.confirmedAt.length > 0;
    if (!hasOrganic) {
      await deleteEntry('experience-behavioral', entry.id);
      results.archived++;
      activityLog({ op: 'evolve-seed-ttl', id: entry.id.slice(0, 8), age: Math.round(age / (24 * 60 * 60 * 1000)) });
    }
  }

  // Step 4c: Auto-cleanup noise entries — high ignore + low hit ratio = junk
  // Targets: entries ignored often but rarely followed, across ALL tiers
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  for (const collCfg of [{ name: 'experience-behavioral' }, { name: 'experience-selfqa' }]) {
    const entries = await getAllEntries(collCfg.name);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data) continue;
      const ignores = data.ignoreCount || 0;
      const irrelevants = data.irrelevantCount || 0;
      const unuseds = data.unusedCount || 0;
      const hits = data.hitCount || 0;
      const age = now - new Date(data.createdAt || 0).getTime();
      const noiseReasonCounts = data.noiseReasonCounts || {};
      const staleRuleNoise = noiseReasonCounts.stale_rule || 0;
      // Noise criteria: ignoreCount >= 5 AND hit-to-ignore ratio < 0.2 AND age > 30 days
      const ignoredNoise = ignores >= 5 && (hits / Math.max(1, ignores)) < 0.2 && age > THIRTY_DAYS;
      const irrelevantNoise = irrelevants >= 4 && (hits / Math.max(1, irrelevants)) < 0.5 && age > (14 * 24 * 60 * 60 * 1000);
      const unusedNoise = unuseds >= 3 && (hits / Math.max(1, unuseds)) < 0.35 && age > (14 * 24 * 60 * 60 * 1000);
      const staleNoise = staleRuleNoise >= 2 && age > (7 * 24 * 60 * 60 * 1000);
      if (ignoredNoise || irrelevantNoise || unusedNoise || staleNoise) {
        await deleteEntry(collCfg.name, entry.id);
        results.archived++;
        activityLog({
          op: 'evolve-noise-cleanup',
          id: entry.id.slice(0, 8),
          ignores,
          irrelevants,
          unuseds,
          hits,
          staleRuleNoise,
          age: Math.round(age / (24 * 60 * 60 * 1000)),
        });
      }
    }
  }

  activityLog({ op: 'evolve', ...results, trigger: trigger || 'auto' });

  return results;
}

// --- Evolution helpers ---

function parsePayload(entry) {
  try { return JSON.parse(entry.payload?.json || '{}'); } catch { return null; }
}

function clusterByCosine(entries, threshold) {
  // Greedy clustering with centroid outlier rejection (Wave 2)
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i) || !entries[i].vector) continue;
    const cluster = [entries[i]];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j) || !entries[j].vector) continue;
      if (cosineSimilarity(entries[i].vector, entries[j].vector) > threshold) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }
    // Wave 2: Centroid outlier rejection — compute centroid, reject members < 0.75 vs centroid
    if (cluster.length >= 3) {
      const dim = cluster[0].vector.length;
      const centroid = new Array(dim).fill(0);
      for (const e of cluster) {
        for (let d = 0; d < dim; d++) centroid[d] += e.vector[d];
      }
      for (let d = 0; d < dim; d++) centroid[d] /= cluster.length;
      const filtered = cluster.filter(e => cosineSimilarity(e.vector, centroid) >= 0.75);
      clusters.push(filtered.length >= 3 ? filtered : cluster); // keep original if filtering drops below 3
    } else {
      clusters.push(cluster);
    }
  }
  return clusters;
}

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

async function deleteEntry(collection, id) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    fileStoreWrite(collection, entries.filter(e => e.id !== id));
    return;
  }
  await fetch(`${getQdrantBase()}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
    body: JSON.stringify({ points: [id] }),
    signal: AbortSignal.timeout(5000),
  });
}

// --- Phase 109: Share/Import principles ---

function sharePrinciple(principleId) {
  const entries = fileStoreRead('experience-principles');
  const entry = entries.find(e => e.id === principleId);
  if (!entry) return null;
  const data = parsePayload(entry);
  if (!data) return null;
  return {
    principle: data.principle || data.solution,
    solution: data.solution,
    confidence: data.confidence,
    domain: data.domain || null,
    sharedAt: new Date().toISOString(),
    sharedBy: getExpUser(),
  };
}

async function importPrinciple(shared) {
  if (!shared?.solution) return null;
  const vector = await getEmbedding(shared.solution);
  if (!vector) return null;
  const id = crypto.randomUUID();
  const payload = {
    id, principle: shared.principle || shared.solution, solution: shared.solution,
    tier: 0, confidence: Math.min(shared.confidence || 0.7, 0.8), // imported = slightly lower confidence
    hitCount: 0, confirmedAt: [],
    domain: shared.domain || null,
    createdAt: new Date().toISOString(), createdFrom: 'imported',
    importedFrom: shared.sharedBy || 'unknown',
  };
  await upsertEntry('experience-principles', id, vector, payload);
  activityLog({ op: 'principle-import', id: id.slice(0, 8), from: shared.sharedBy || 'unknown' });
  return { id, principle: payload.principle };
}

// --- getEmbeddingRaw: exported for external callers (e.g. bulk-seed.js) (D-16) ---

async function getEmbeddingRaw(text, signal) {
  return getEmbedding(text, signal);
}

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

const CLASSIFY_PROMPT = `Classify this coding task complexity. Reply ONLY one word: fast, balanced, or premium.

fast = trivial, mechanical, single action (rename, format, read file, delete unused, fix typo, update import, simple config change)
balanced = moderate, requires understanding (implement feature, write tests, refactor single file, add endpoint, update logic)
premium = complex, requires deep reasoning (multi-file architecture, race condition, security audit, system design, complex debug, breaking migration)

Task: "{TASK}"`;

// Keywords that hint at complexity level — used as a cheap pre-filter before brain call.
// If files context contains these extensions/patterns, we can short-circuit.
const COMPLEXITY_KEYWORDS = {
  premium: [
    'race condition', 'deadlock', 'concurrency', 'distributed', 'security audit',
    'breaking change', 'multi-file', 'multi-service', 'architecture',
    'performance regression', 'memory leak', 'heap', 'profil', 'benchmark',
  ],
  fast: [
    'rename ', 'fix typo', 'typo in ', 'delete unused', 'update import',
    'simple config', 'add comment', 'update version', 'format code',
  ],
};

/**
 * Cheap keyword pre-filter — returns tier hint without any API call.
 * Checks task text + context.files extensions for complexity signals.
 * Returns 'fast' | 'balanced' | 'premium' | null (null = inconclusive, call brain).
 */
function preFilterComplexity(taskText, context) {
  const lower = taskText.toLowerCase();
  const files = (context?.files || []).map(f => String(f).toLowerCase());

  // Premium signals in task text
  for (const kw of COMPLEXITY_KEYWORDS.premium) {
    if (lower.includes(kw)) return 'premium';
  }

  // Fast signals — only for short descriptions (long tasks are never trivial)
  if (lower.length < 80) {
    for (const kw of COMPLEXITY_KEYWORDS.fast) {
      if (lower.includes(kw)) return 'fast';
    }
  }

  // Context files: many files → complexity signal
  if (files.length >= 5) return 'premium';

  // Context files: TypeScript/Go/Rust architecture files hint at complexity
  const architectureFiles = files.filter(f =>
    f.includes('service') || f.includes('middleware') || f.includes('gateway') ||
    f.includes('migration') || f.includes('schema') || f.includes('interface')
  );
  if (architectureFiles.length >= 2) return 'premium';

  return null; // inconclusive — let brain decide
}

/**
 * Emit a structured routing decision line to stdout for GSD/user visibility.
 * Format: [Model Router] -> {tier} ({model}) — {reason} [{source}]
 */
function printRouteDecision(tier, model, reason, source) {
  const modelPart = model ? ` (${model})` : '';
  process.stdout.write(`[Model Router] -> ${tier}${modelPart} — ${reason} [${source}]\n`);
}

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
async function classifyViaBrain(prompt, timeoutMs = 10000) {
  const brainProvider = getBrainProvider();
  const endpoint = getBrainEndpoint();
  const brainModel = getBrainModel();
  const key = getBrainKey() || '';

  // Provider: siliconflow or any OpenAI-compatible endpoint
  if (brainProvider === 'siliconflow' || endpoint) {
    if (!key) return null;
    const targetEndpoint = endpoint || 'https://api.siliconflow.com/v1/chat/completions';
    try {
      const res = await fetch(targetEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: brainModel || 'Qwen/Qwen2.5-7B-Instruct',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 10,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()).choices?.[0]?.message?.content?.trim() || null;
    } catch { return null; }
  }

  // Provider: ollama (generate endpoint, plain text)
  if (brainProvider === 'ollama') {
    try {
      const res = await fetch(getOllamaGenerateUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: brainModel || 'qwen2.5:3b',
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 10 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()).response?.trim() || null;
    } catch { return null; }
  }

  return null;
}

/**
 * Normalize brain classification response to a valid tier.
 * Handles: multi-word responses, "medium" alias, casing.
 * Returns 'fast' | 'balanced' | 'premium' | null (null = unrecognized).
 */
function normalizeTierResponse(raw) {
  if (!raw) return null;
  const word = raw.trim().toLowerCase().split(/\s+/)[0];
  if (word === 'fast') return 'fast';
  if (word === 'balanced' || word === 'medium') return 'balanced';
  if (word === 'premium' || word === 'complex' || word === 'hard') return 'premium';
  return null;
}

function resolveTierModel(tier, runtime) {
  if (!runtime) return null;
  const runtimeTiers = getModelTiers()[runtime];
  if (!runtimeTiers) return null;
  return runtimeTiers[tier] || runtimeTiers.balanced || null;
}

/**
 * Store a new route decision to both FileStore and Qdrant (dual-write).
 * Non-blocking — errors are swallowed so routing always returns quickly.
 */
async function storeRouteDecision(taskText, taskHash, tier, model, runtime, context, vector) {
  const id = require('crypto').randomUUID();
  const routeData = {
    id, taskHash, taskSummary: taskText.slice(0, 200), tier, model, runtime: runtime || null,
    source: 'brain', outcome: null, retryCount: 0, duration: null,
    domain: context?.domain || null, projectSlug: context?.phase || null,
    createdAt: new Date().toISOString(), feedbackAt: null,
  };

  // Dual-write: FileStore always, Qdrant when available
  try { fileStoreUpsert(ROUTES_COLLECTION, id, vector, { json: JSON.stringify(routeData), user: getExpUser() }); } catch { /* non-blocking */ }
  if (await checkQdrant()) {
    try {
      await fetch(`${getQdrantBase()}/collections/${ROUTES_COLLECTION}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ points: [{ id, vector, payload: { json: JSON.stringify(routeData), user: getExpUser() } }] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-blocking */ }
  }
}

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
 * @returns {Promise<{tier, model, confidence, source, reason, taskHash}>}
 */
async function routeModel(task, context, runtime) {
  const taskText = (task || '').slice(0, 500);
  if (!taskText) {
    const tier = getRouterDefaultTier();
    const model = resolveTierModel(tier, runtime);
    printRouteDecision(tier, model, 'empty task', 'default');
    activityLog({ op: 'route', task: '', tier, model, source: 'default', confidence: 0 });
    return { tier, model, confidence: 0, source: 'default', reason: 'empty task', taskHash: null };
  }

  const taskHash = require('crypto').createHash('sha256').update(taskText).digest('hex').slice(0, 16);

  // Layer 0: Keyword pre-filter (no API call)
  const preFilterTier = preFilterComplexity(taskText, context);
  if (preFilterTier) {
    const model = resolveTierModel(preFilterTier, runtime);
    const reason = `${preFilterTier} complexity detected`;
    printRouteDecision(preFilterTier, model, reason, 'keyword');
    activityLog({ op: 'route', task: taskText.slice(0, 100), tier: preFilterTier, model, source: 'keyword', confidence: 0.70 });

    // Store for future history (async, non-blocking)
    getEmbedding(taskText).then(vector => {
      if (vector) storeRouteDecision(taskText, taskHash, preFilterTier, model, runtime, context, vector);
    }).catch(() => {});

    return { tier: preFilterTier, model, confidence: 0.70, source: 'keyword', reason, taskHash };
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
          const reason = source === 'history-upgrade'
            ? `similar task ${data.outcome === 'cancelled' ? 'was cancelled' : 'failed'} on ${data.tier || 'lower tier'}`
            : 'similar task succeeded before';
          const result = { tier, model, confidence: bestHit.score, source, reason, taskHash };
          printRouteDecision(tier, model, reason, source);
          activityLog({ op: 'route', task: taskText.slice(0, 100), tier, model, source, confidence: bestHit.score });
          return result;
        }
      }
    }
  } catch { /* Layer 1 failure — proceed to Layer 2 */ }

  // Layer 2: Brain classify (plain text — separate from callBrainWithFallback which expects JSON)
  try {
    const prompt = CLASSIFY_PROMPT.replace('{TASK}', taskText.slice(0, 300));
    const brainResult = await classifyViaBrain(prompt);
    if (brainResult) {
      const normalizedTier = normalizeTierResponse(brainResult);
      const tier = normalizedTier || getRouterDefaultTier();
      const model = resolveTierModel(tier, runtime);
      const confidence = normalizedTier ? 0.75 : 0.50;
      const reason = `${tier} complexity task`;
      const result = { tier, model, confidence, source: 'brain', reason, taskHash };
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
  printRouteDecision(fallbackTier, model, 'classification unavailable', 'default');
  activityLog({ op: 'route', task: taskText.slice(0, 100), tier: fallbackTier, model, source: 'default', confidence: 0 });
  return { tier: fallbackTier, model, confidence: 0, source: 'default', reason: 'fallback — classification unavailable', taskHash };
}

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
async function routeFeedback(taskHash, tier, model, outcome, retryCount, duration) {
  if (!taskHash || !outcome) return false;

  const validOutcomes = ['success', 'fail', 'retry', 'cancelled'];
  const normalizedOutcome = validOutcomes.includes(outcome) ? outcome : 'success';

  const applyUpdate = (data) => {
    data.outcome = normalizedOutcome;
    data.retryCount = retryCount || 0;
    data.duration = duration || null;
    data.feedbackAt = new Date().toISOString();
    if (tier) data.tier = tier;
    if (model) data.model = model;
  };

  let found = false;

  // FileStore: scan and update
  try {
    const entries = fileStoreRead(ROUTES_COLLECTION);
    for (const entry of entries) {
      const data = (() => { try { return JSON.parse(entry.payload?.json || '{}'); } catch { return {}; } })();
      if (data.taskHash === taskHash) {
        applyUpdate(data);
        entry.payload.json = JSON.stringify(data);
        fileStoreWrite(ROUTES_COLLECTION, entries);
        found = true;
        break;
      }
    }
  } catch { /* FileStore scan failed — continue to Qdrant */ }

  // Qdrant: scroll and update (always try, not just when FileStore misses)
  if (await checkQdrant()) {
    try {
      const scrollRes = await fetch(`${getQdrantBase()}/collections/${ROUTES_COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ limit: 100, with_payload: true, filter: { must: [buildQdrantUserFilter()] } }),
        signal: AbortSignal.timeout(5000),
      });
      if (scrollRes.ok) {
        const points = (await scrollRes.json()).result?.points || [];
        if (points.length === 100) activityLog({ op: 'route-feedback-warn', msg: 'scroll hit 100 limit, may miss entries' });
        for (const point of points) {
          const data = (() => { try { return JSON.parse(point.payload?.json || '{}'); } catch { return {}; } })();
          if (data.taskHash === taskHash) {
            applyUpdate(data);
            await fetch(`${getQdrantBase()}/collections/${ROUTES_COLLECTION}/points/payload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
              body: JSON.stringify({ points: [point.id], payload: { json: JSON.stringify(data), user: getExpUser() } }),
              signal: AbortSignal.timeout(5000),
            });
            found = true;
            break;
          }
        }
      }
    } catch { /* Qdrant scroll failed */ }
  }

  activityLog({ op: 'route-feedback', taskHash, tier, outcome: normalizedOutcome, retryCount: retryCount || 0, duration: duration || null });
  return found;
}

// --- Exports ---

module.exports = { intercept, interceptWithMeta, recordFeedback, recordJudgeFeedback, classifyViaBrain, extractFromSession, recordHit, incrementIgnoreCount, syncToQdrant, evolve, getEmbeddingRaw, searchCollection, deleteEntry, createEdge, getEdgesForId, getEdgesOfType, EDGE_COLLECTION, sharePrinciple, importPrinciple, EXP_USER, extractProjectSlug, migrateQdrantUserTags, routeModel, routeFeedback, _updatePointPayload: updatePointPayload, _applyHitUpdate: applyHitUpdate, _activityLog: activityLog, _detectContext: detectContext, _buildQuery: buildQuery, _computeEffectiveScore: computeEffectiveScore, _computeEffectiveConfidence: computeEffectiveConfidence, _rerankByQuality: rerankByQuality, _formatPoints: formatPoints, _storeExperiencePayload: (qa, domain, projectSlug) => buildStorePayload(require('crypto').randomUUID(), qa, domain || null, projectSlug || null), _extractProjectSlug: extractProjectSlug, _buildStorePayload: buildStorePayload, _recordHitUpdatesFields: applyHitUpdate, _trackSuggestions: trackSuggestions, _sessionUniqueCount: sessionUniqueCount, _incrementIgnoreCountData: incrementIgnoreCountData, _incrementUnusedData: incrementUnusedData, _reconcilePendingHints: reconcilePendingHints, _assessHintUsage: assessHintUsage, _detectTranscriptDomain: detectTranscriptDomain, _detectNaturalLang: detectNaturalLang, _callBrainWithFallback: callBrainWithFallback, _isReadOnlyCommand: isReadOnlyCommand, _brainRelevanceFilter: brainRelevanceFilter, _extractProjectPath: extractProjectPath, _extractPathFromCommand: extractPathFromCommand, _detectRuntime: detectRuntime, _isRouterEnabled: isRouterEnabled };
