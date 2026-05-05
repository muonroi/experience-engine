/**
 * config.js — Shared config and constants for Experience Engine modules.
 * Extracted from experience-core.js. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');
const os = require('os');

// --- Native config loader ---
const CONFIG_PATH = pathMod.join(os.homedir(), '.experience', 'config.json');
const configState = { mtimeMs: null, value: {} };

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
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

function getConfig() { return loadConfig(false); }
function refreshConfig() { return loadConfig(true); }

function cfgValue(key, envKey, fallback) {
  const cfg = getConfig();
  return cfg[key] ?? process.env[envKey] ?? fallback;
}

// --- Config accessors ---
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
function getOllamaEmbedUrl() { return `${getOllamaBase()}/api/embed`; }
function getOllamaGenerateUrl() { return `${getOllamaBase()}/api/generate`; }
function getExpUser() {
  return getConfig().user || process.env.EXP_USER || 'default';
}
const EXP_USER = getExpUser();

// --- Constants ---
const COLLECTIONS = [
  { name: 'experience-principles', topK: 2, budgetChars: 800 },
  { name: 'experience-behavioral', topK: 3, budgetChars: 1200 },
  { name: 'experience-selfqa',     topK: 2, budgetChars: 1000 },
];
const EDGE_COLLECTION = 'experience-edges';
const ROUTES_COLLECTION = 'experience-routes';
const DEDUP_THRESHOLD = 0.85;
const QUERY_MAX_CHARS = 500;
const MAX_SESSION_UNIQUE = 8;
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
  getConfig, refreshConfig, cfgValue,
  getQdrantBase, getQdrantApiKey,
  getOllamaBase, getOllamaEmbedUrl, getOllamaGenerateUrl,
  getEmbedProvider, getEmbedModel, getEmbedEndpoint, getEmbedKey, getEmbedDim,
  getBrainProvider, getBrainModel, getBrainEndpoint, getBrainKey,
  getMinConfidence, getHighConfidence,
  getExpUser, EXP_USER,
  getHomeExpDir, getStoreDir, getActivityLogPath,
  COLLECTIONS, EDGE_COLLECTION, ROUTES_COLLECTION,
  DEDUP_THRESHOLD, QUERY_MAX_CHARS, MAX_SESSION_UNIQUE, COMPACT_DIM,
  VALID_FEEDBACK_VERDICTS, VALID_NOISE_REASONS, VALID_NOISE_DISPOSITIONS, VALID_NOISE_SOURCES,
  NOISE_SUPPRESSION_THRESHOLD, RECENT_VALIDATION_WINDOW_MS,
  UNUSED_NO_TOUCH_THRESHOLD, PENDING_HINT_TTL_MS, PROMPT_STALE_RECONCILE_MS,
  setActivityLog, activityLog,
};
