/**
 * config.js — Shared config and constants for Experience Engine modules.
 * Extracted from experience-core.js. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');
const os = require('os');

// --- Native config loader ---
// Resolved per call so EXPERIENCE_CONFIG_PATH can isolate unit tests from the
// operator's live ~/.experience/config.json (e.g. a config that enables an
// opt-in feature must not break that feature's "default OFF" unit assertion).
function getConfigPath() {
  return process.env.EXPERIENCE_CONFIG_PATH || pathMod.join(os.homedir(), '.experience', 'config.json');
}
const configState = { mtimeMs: null, value: {}, path: null };

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')); } catch { return {}; }
}

function loadConfig(force = false) {
  const path = getConfigPath();
  try {
    const stat = fs.statSync(path);
    if (!force && configState.path === path && configState.mtimeMs === stat.mtimeMs) return configState.value;
    configState.path = path;
    configState.mtimeMs = stat.mtimeMs;
    configState.value = readConfigFile();
    return configState.value;
  } catch {
    configState.path = path;
    configState.mtimeMs = null;
    configState.value = {};
    return configState.value;
  }
}

function getConfig() { return loadConfig(false); }
function refreshConfig() { return loadConfig(true); }

// Auto-decrypt enc: prefixed values at runtime
const _decryptCache = new Map();
let _configKey = null;
function _tryDecrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('enc:')) return value;
  if (_decryptCache.has(value)) return _decryptCache.get(value);
  try {
    if (!_configKey) {
      const keyPath = pathMod.join(os.homedir(), '.experience', '.config-key');
      if (!fs.existsSync(keyPath)) return value;
      _configKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    }
    const buf = Buffer.from(value.slice(4), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const crypto = require('crypto');
    const decipher = crypto.createDecipheriv('aes-256-gcm', _configKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    _decryptCache.set(value, decrypted);
    return decrypted;
  } catch { return value; }
}

function cfgValue(key, envKey, fallback) {
  const cfg = getConfig();
  const raw = cfg[key] ?? process.env[envKey] ?? fallback;
  return _tryDecrypt(raw);
}

function cfgNestedValue(key, nestedPath, envKey, fallback) {
  const cfg = getConfig();
  const nested = nestedPath.reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), cfg);
  const raw = cfg[key] ?? nested ?? process.env[envKey] ?? fallback;
  return _tryDecrypt(raw);
}

// --- Config accessors ---
function getQdrantBase()     { return cfgNestedValue('qdrantUrl', ['qdrant', 'url'], 'EXPERIENCE_QDRANT_URL', 'http://localhost:6333'); }
function getQdrantApiKey()   { return cfgNestedValue('qdrantKey', ['qdrant', 'key'], 'EXPERIENCE_QDRANT_KEY', ''); }
function getOllamaBase()     { return cfgValue('ollamaUrl', 'EXPERIENCE_OLLAMA_URL', 'http://localhost:11434'); }
function getEmbedProvider()  { return cfgValue('embedProvider', 'EXPERIENCE_EMBED_PROVIDER', 'ollama'); }
function getBrainProvider()  { return cfgValue('brainProvider', 'EXPERIENCE_BRAIN_PROVIDER', 'ollama'); }
function getEmbedModel()     { return cfgValue('embedModel', 'EXPERIENCE_EMBED_MODEL', 'nomic-embed-text'); }
// Dedicated model name for the Ollama cross-provider fallback. Empty by default:
// reusing the primary's model name (e.g. SiliconFlow 'Qwen/Qwen3-Embedding-0.6B')
// against Ollama 404s, and a DIFFERENT model emits vectors in an incompatible
// space / wrong dimension that poison Qdrant. So the fallback is opt-in — set
// this only to an Ollama-pulled model whose dimension matches embedDim.
function getOllamaEmbedModel() { return cfgValue('ollamaEmbedModel', 'EXPERIENCE_OLLAMA_EMBED_MODEL', ''); }
function getBrainModel()     { return cfgValue('brainModel', 'EXPERIENCE_BRAIN_MODEL', 'qwen2.5:3b'); }
// Optional larger model used only for pattern-extraction jobs (extractQA + evolve abstraction).
// Hot-path jobs (intercept brain-filter, judge, route) keep using getBrainModel() so latency
// and cost stay bounded. When unset, falls through to getBrainModel.
function getBrainExtractModel() {
  const override = cfgValue('brainExtractModel', 'EXPERIENCE_BRAIN_EXTRACT_MODEL', null);
  return override || getBrainModel();
}
// Source-aware model picker. Sources are set by callers via meta.source in callBrainWithFallback.
function getBrainModelForSource(source) {
  if (source === 'extract' || source === 'evolve') return getBrainExtractModel();
  return getBrainModel();
}
function getEmbedEndpoint()  { return cfgValue('embedEndpoint', 'EXPERIENCE_EMBED_ENDPOINT', ''); }
function getEmbedKey()       { return cfgValue('embedKey', 'EXPERIENCE_EMBED_KEY', ''); }
function getBrainEndpoint()  { return cfgValue('brainEndpoint', 'EXPERIENCE_BRAIN_ENDPOINT', ''); }
function getBrainKey()       { return cfgValue('brainKey', 'EXPERIENCE_BRAIN_KEY', ''); }
function getEmbedDim()       { return cfgValue('embedDim', 'EXPERIENCE_EMBED_DIM', 768); }
// Per-request embedding timeout (ms). Provider tail-latency (observed: siliconflow
// p99 ~2.6s, occasional spikes >5s) was being converted into hard failures by a
// hardcoded 5000ms abort; 10s gives the tail headroom while still bounding hangs.
function getEmbedTimeoutMs() { return Number(cfgValue('embedTimeoutMs', 'EXPERIENCE_EMBED_TIMEOUT_MS', 10000)) || 10000; }
function getMinConfidence()  { return cfgValue('minConfidence', 'EXPERIENCE_MIN_CONFIDENCE', 0.42); }
function getHighConfidence() { return cfgValue('highConfidence', 'EXPERIENCE_HIGH_CONFIDENCE', 0.60); }
function getMinSearchScore() { return cfgValue('minSearchScore', 'EXPERIENCE_MIN_SEARCH_SCORE', 0.40); }

// --- Passive-hint hybridization (PreToolUse/UserPromptSubmit lexical leg) ---
// Recall is fully hybrid; passive hints stay vector-only by DEFAULT because they
// are tuned for precision (dashboard Gate 4). These knobs let the native BM25
// sparse leg also feed passive hints — OFF by default so it can be A/B measured
// before becoming the norm. When ON, lexical-only hits are capped and given a
// borderline display score so the existing confidence/scope/precision gates
// (not a new threshold) decide whether they actually surface.
function getPassiveHybrid()            { return cfgValue('passiveHybrid', 'EXPERIENCE_PASSIVE_HYBRID', false) === true
                                                || String(cfgValue('passiveHybrid', 'EXPERIENCE_PASSIVE_HYBRID', 'false')).toLowerCase() === 'true'; }
function getPassiveLexicalMaxAdds()    { return Math.max(0, Number(cfgValue('passiveLexicalMaxAdds', 'EXPERIENCE_PASSIVE_LEXICAL_MAX_ADDS', 1)) || 0); }
function getPassiveLexicalDisplayScore() {
  const v = cfgValue('passiveLexicalDisplayScore', 'EXPERIENCE_PASSIVE_LEXICAL_DISPLAY_SCORE', null);
  return v == null ? (getMinSearchScore() + 0.10) : (Number(v) || (getMinSearchScore() + 0.10));
}

// --- /api/search hybridization (default ON) ---
// Unlike passive hints (precision-tuned, vector-only by default), /api/search is a
// DELIBERATE query — the CLI layer3 legacy block + thin-client lookups — so, like
// /api/recall, it fuses a native BM25 sparse leg with the dense leg via RRF by
// default. This surfaces lessons that match strongly on exact terms even when they
// are semantically distant from the query embedding. Set EXPERIENCE_SEARCH_HYBRID=false
// (or "searchHybrid": false in config.json) to revert /api/search to dense-only.
// Fail-open: if the lexical leg is dead (collection not sparse-migrated and no text
// index), hybrid silently degrades to dense-only — never a regression.
function getSearchHybrid() {
  const v = cfgValue('searchHybrid', 'EXPERIENCE_SEARCH_HYBRID', true);
  if (v === true) return true;
  if (v === false) return false;
  return String(v).toLowerCase() !== 'false';
}

// --- Prompt triviality gate (consumed by interceptor-prompt.js) ---
// Decides whether a UserPromptSubmit prompt is worth running retrieval +
// injecting the active-recall nudge. Previously hardcoded in the hook; now
// config/env-driven so it can be tuned per install without a code change
// (e.g. add non-English greetings, lower the length floor). Deterministic and
// zero-latency by design — the brain still judges relevance of the RETRIEVED
// hints downstream (brainRelevanceFilter), so this stays a cheap pre-filter.
function getMinPromptLength() {
  const n = Number(cfgValue('minPromptLength', 'EXPERIENCE_MIN_PROMPT_LENGTH', 10));
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

// Default greeting/ack words (multilingual). A prompt whose entire trimmed text
// is one of these (or a bare slash-command) is treated as trivial.
const DEFAULT_PROMPT_SKIP_WORDS = [
  'hi', 'hello', 'hey', 'yo', 'thanks', 'thank you', 'thx', 'ok', 'okay', 'k',
  'yes', 'yep', 'no', 'nope', 'quit', 'exit', 'help',
  // Vietnamese
  'chào', 'chao', 'xin chào', 'cảm ơn', 'cam on', 'cám ơn', 'thanks nhé',
  'ừ', 'ờ', 'vâng', 'dạ', 'ok nhé', 'tiếp', 'tiếp tục', 'được',
];

function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Returns a RegExp matching a trivial prompt (anchored, case-insensitive).
// Override priority: explicit full pattern > word list > built-in default.
function getPromptSkipRegex() {
  const cfg = getConfig();
  // Full override: a raw regex source string via config.promptSkipPattern or env.
  const rawPattern = cfg.promptSkipPattern || process.env.EXPERIENCE_PROMPT_SKIP_PATTERN;
  if (rawPattern) {
    try { return new RegExp(rawPattern, 'i'); }
    catch (err) {
      // Fail-open to default rather than crash the hook on a bad config value.
      activityLog({ op: 'config', warn: 'invalid_prompt_skip_pattern', error: err?.message });
    }
  }
  // Word list: array from config.json, or comma/pipe-separated env, else default.
  let words = cfg.promptSkipWords;
  if (!Array.isArray(words)) {
    const envWords = process.env.EXPERIENCE_PROMPT_SKIP_WORDS;
    words = envWords ? envWords.split(/[,|]/).map(w => w.trim()).filter(Boolean) : DEFAULT_PROMPT_SKIP_WORDS;
  }
  const alt = words.map(_escapeRegex).join('|');
  // Always treat a bare slash-command (/clear, /help, …) as trivial too.
  return new RegExp(`^(?:${alt}|\\/\\w+)\\s*$`, 'i');
}

function getOllamaEmbedUrl() { return `${getOllamaBase()}/api/embed`; }
function getOllamaGenerateUrl() { return `${getOllamaBase()}/api/generate`; }
function getExpUser() {
  return getConfig().user || process.env.EXP_USER || 'default';
}
const EXP_USER = getExpUser();

// --- Constants ---
// topK bumped from 2/3/2 → 4/6/4: rerank pipeline (cosine → effectiveScore with
// hit/recency/domain adjustments) sometimes demotes the perfect-cosine match
// below entries with hit history. Larger top-K gives correct hints headroom to
// survive rerank, then budgetChars caps the final display volume. Net cost is
// one Qdrant payload per extra slot — negligible vs the wrong-content cost.
// topK: per-collection candidate count for passive hints (precision-tuned).
// recallTopK: wider net for active recall — recall drops the score floor and
// fuses a lexical leg (RRF), so fetching more candidates per leg then ranking
// is strictly better than the precision-tuned passive topK.
// budgetChars: display budget for passive hints (tight — hints interrupt).
// recallBudgetChars: larger budget for active recall — a deliberate query wants
// depth, and recall entries (with their feedback footer) run longer, so the
// passive budget would drop whole entries.
const COLLECTIONS = [
  { name: 'experience-principles', topK: 4, recallTopK: 10, budgetChars: 800,  recallBudgetChars: 1800 },
  { name: 'experience-behavioral', topK: 6, recallTopK: 15, budgetChars: 1200, recallBudgetChars: 3500 },
  { name: 'experience-selfqa',     topK: 4, recallTopK: 20, budgetChars: 1000, recallBudgetChars: 3500 },
];
const SELFQA_COLLECTION = 'experience-selfqa';
const EDGE_COLLECTION = 'experience-edges';
const ROUTES_COLLECTION = 'experience-routes';
const DEDUP_THRESHOLD = 0.85;
const QUERY_MAX_CHARS = 500;
const COMPACT_DIM = 768;

// --- Noise constants ---
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);
const VALID_NOISE_DISPOSITIONS = new Set(['unused', 'irrelevant', 'ignored', 'followed']);
const VALID_NOISE_SOURCES = new Set(['manual', 'judge', 'implicit-posttool', 'prompt-stale']);
const NOISE_SUPPRESSION_THRESHOLD = 1;
const RECENT_VALIDATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const UNUSED_NO_TOUCH_THRESHOLD = 3;
const PENDING_HINT_TTL_MS = 20 * 60 * 1000;
const PROMPT_STALE_RECONCILE_MS = 10 * 1000;

// --- FileStore paths ---
function getHomeExpDir() {
  return pathMod.join(os.homedir(), '.experience');
}

function getStoreDir() {
  return pathMod.join(getHomeExpDir(), 'store', getExpUser());
}

function getActivityLogPath() {
  return pathMod.join(getHomeExpDir(), 'activity.jsonl');
}

// --- "Who Am I" v4.0 personalization (slice 1: Signal Detector -> profile model) ---
// Privacy level gates the whole feature. Default 'off' = feature dark (no profile written)
// until the user opts in. 'minimal' = work patterns only (Tang 1); 'standard' = + decision &
// communication style (Tang 2). 'full' (Tang 3 emotional) is reserved, NOT implemented yet.
function getPrivacyLevel() {
  const v = String(cfgValue('privacyLevel', 'EXPERIENCE_PRIVACY_LEVEL', 'off') || 'off').toLowerCase();
  return ['off', 'minimal', 'standard', 'full'].includes(v) ? v : 'off';
}
function getProfilePath() {
  return cfgValue('profilePath', 'EXPERIENCE_PROFILE_PATH', pathMod.join(getHomeExpDir(), 'profile.yaml'));
}
function getSignalWindowDays() {
  const n = Number(cfgValue('signalWindowDays', 'EXPERIENCE_SIGNAL_WINDOW_DAYS', 30));
  return Number.isFinite(n) && n > 0 ? Math.min(365, Math.round(n)) : 30;
}

// --- Risk gate (conditional recall nudge) ---
// Replaces the always-on per-prompt recall nudge with a gate that fires only when
// a deterministic risk trigger matches (sensitive keyword / cross-repo). Default ON;
// set EXPERIENCE_RISK_GATE=0 to fall back to the legacy generic nudge path.
const DEFAULT_RISK_KEYWORDS = [
  'rate limit', 'rate-limit', 'auth', 'oauth', 'token', 'secret', 'credential', 'password',
  'migration', 'migrate', 'deploy', 'cors', 'interceptor', 'rm -rf', 'force push', 'force-push',
  'drop table', 'reset --hard', 'prod', 'production', 'truncate', 'webhook',
];
function getRiskGateEnabled() {
  return String(cfgValue('riskGate', 'EXPERIENCE_RISK_GATE', '1')) !== '0';
}
function getRiskKeywords() {
  const raw = cfgValue('riskKeywords', 'EXPERIENCE_RISK_KEYWORDS', '');
  if (Array.isArray(raw)) return raw.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  const list = String(raw || '').split(',').map((s) => s.toLowerCase().trim()).filter(Boolean);
  return list.length ? list : DEFAULT_RISK_KEYWORDS.slice();
}

// --- Runbook-candidate detection (session-end nudge) ---
// When an agent runs >= getRunbookStitchMin() recalls in one session that reuse
// the same atomic entries and none of them is a runbook, the stop-extractor
// proposes "crystallize a runbook?". Detection is deterministic (counts only,
// no LLM) and observes recorded op:'recall' activity rows. Default ON; set
// EXPERIENCE_RUNBOOK_NUDGE=0 to silence the session-end nudge.
function getRunbookNudgeEnabled() {
  return String(cfgValue('runbookNudge', 'EXPERIENCE_RUNBOOK_NUDGE', '1')) !== '0';
}
function getRunbookStitchMin() {
  const n = Number(cfgValue('runbookStitchMin', 'EXPERIENCE_RUNBOOK_STITCH_MIN', 3));
  // Floor of 2: the signal also requires >= 2 atomic entries to recur, so a
  // stitch threshold below 2 can never produce a candidate.
  return Number.isFinite(n) && n >= 2 ? Math.round(n) : 3;
}

// --- Activity Log ---
let _activityLog = null;

function setActivityLog(fn) {
  _activityLog = fn;
}

function activityLog(event) {
  if (typeof _activityLog === 'function') {
    _activityLog(event);
  }
}

module.exports = {
  getConfig, refreshConfig, cfgValue, cfgNestedValue,
  getQdrantBase, getQdrantApiKey,
  getOllamaBase, getOllamaEmbedUrl, getOllamaGenerateUrl,
  getEmbedProvider, getEmbedModel, getOllamaEmbedModel, getEmbedEndpoint, getEmbedKey, getEmbedDim, getEmbedTimeoutMs,
  getBrainProvider, getBrainModel, getBrainExtractModel, getBrainModelForSource, getBrainEndpoint, getBrainKey,
  getMinConfidence, getHighConfidence, getMinSearchScore,
  getPassiveHybrid, getPassiveLexicalMaxAdds, getPassiveLexicalDisplayScore,
  getSearchHybrid,
  getMinPromptLength, getPromptSkipRegex, DEFAULT_PROMPT_SKIP_WORDS,
  getExpUser, EXP_USER,
  getHomeExpDir, getStoreDir, getActivityLogPath,
  getPrivacyLevel, getProfilePath, getSignalWindowDays,
  getRiskGateEnabled, getRiskKeywords, DEFAULT_RISK_KEYWORDS,
  getRunbookNudgeEnabled, getRunbookStitchMin,
  COLLECTIONS, SELFQA_COLLECTION, EDGE_COLLECTION, ROUTES_COLLECTION,
  DEDUP_THRESHOLD, QUERY_MAX_CHARS, COMPACT_DIM,
  VALID_FEEDBACK_VERDICTS, VALID_NOISE_REASONS, VALID_NOISE_DISPOSITIONS, VALID_NOISE_SOURCES,
  NOISE_SUPPRESSION_THRESHOLD, RECENT_VALIDATION_WINDOW_MS,
  UNUSED_NO_TOUCH_THRESHOLD, PENDING_HINT_TTL_MS, PROMPT_STALE_RECONCILE_MS,
  setActivityLog, activityLog,
};
