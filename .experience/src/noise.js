/**
 * noise.js — Noise suppression, metadata tracking, language mismatch.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const { normalizeTechLabel } = require('./utils');
const {
  normalizeNoiseSource, normalizeNoiseReason,
} = require('./session');
const {
  RECENT_VALIDATION_WINDOW_MS, NOISE_SUPPRESSION_THRESHOLD,
} = require('./config');

// ============================================================
//  Recent validation / confirmation check
// ============================================================

function hasRecentValidatedConfirmation(data, nowMs = Date.now()) {
  const candidates = [];
  if (data?.lastHitAt) candidates.push(data.lastHitAt);
  if (Array.isArray(data?.confirmedAt)) candidates.push(...data.confirmedAt);
  for (const candidate of candidates) {
    const ts = new Date(candidate).getTime();
    if (Number.isFinite(ts) && nowMs - ts <= RECENT_VALIDATION_WINDOW_MS) return true;
  }
  return false;
}

function isCodeSpecificHint(data) {
  const scopeLang = normalizeTechLabel(data?.scope?.lang);
  if (scopeLang && scopeLang !== 'all') return true;
  const domain = normalizeTechLabel(data?.domain);
  return !!domain && domain !== 'all' && domain !== 'markdown' && domain !== 'json' && domain !== 'yaml';
}

// ============================================================
//  Suppression gates
// ============================================================

function shouldSuppressForNoise(data, context = {}) {
  if (!data || typeof data !== 'object') return { suppress: false };
  if (hasRecentValidatedConfirmation(data)) return { suppress: false, reason: 'recent_validation' };
  const counts = data.noiseReasonCounts || {};
  const queryProjectSlug = context.queryProjectSlug || null;
  const queryDomain = context.queryDomain || null;
  const actionKind = context.actionKind || 'unknown';

  if ((counts.wrong_repo || 0) >= NOISE_SUPPRESSION_THRESHOLD
      && data._projectSlug && queryProjectSlug && data._projectSlug !== queryProjectSlug) {
    return { suppress: true, reason: 'wrong_repo' };
  }
  if ((counts.wrong_language || 0) >= NOISE_SUPPRESSION_THRESHOLD
      && inferLanguageMismatch({ scope: data.scope, domain: data.domain }, queryDomain)) {
    return { suppress: true, reason: 'wrong_language' };
  }
  if ((counts.wrong_task || 0) >= NOISE_SUPPRESSION_THRESHOLD
      && (actionKind === 'docs' || actionKind === 'config' || actionKind === 'ops')
      && isCodeSpecificHint(data)) {
    return { suppress: true, reason: 'wrong_task' };
  }
  if ((counts.stale_rule || 0) >= NOISE_SUPPRESSION_THRESHOLD) {
    return { suppress: true, reason: 'stale_rule' };
  }
  return { suppress: false };
}

function filterNoiseSuppressedPoints(points, context = {}) {
  const kept = [];
  const suppressed = [];
  for (const point of points || []) {
    let data = {};
    try { data = JSON.parse(point.payload?.json || '{}'); } catch { /* keep malformed */ }
    const decision = shouldSuppressForNoise(data, context);
    if (decision.suppress) {
      suppressed.push({ point, reason: decision.reason });
    } else {
      kept.push(point);
    }
  }
  return { kept, suppressed };
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

// ============================================================
//  Noise metadata tracking
// ============================================================

function ensureNoiseReasonCounts(data) {
  if (!data.noiseReasonCounts || typeof data.noiseReasonCounts !== 'object' || Array.isArray(data.noiseReasonCounts)) {
    data.noiseReasonCounts = {};
  }
  return data.noiseReasonCounts;
}

function ensureNoiseSourceCounts(data) {
  if (!data.noiseSourceCounts || typeof data.noiseSourceCounts !== 'object' || Array.isArray(data.noiseSourceCounts)) {
    data.noiseSourceCounts = {};
  }
  return data.noiseSourceCounts;
}

function recordNoiseMetadataData(data, source, reason) {
  const normalizedSource = normalizeNoiseSource(source);
  const normalizedReason = normalizeNoiseReason(reason);
  const nowIso = new Date().toISOString();
  if (normalizedSource) {
    const sourceCounts = ensureNoiseSourceCounts(data);
    sourceCounts[normalizedSource] = (sourceCounts[normalizedSource] || 0) + 1;
    data.lastNoiseSource = normalizedSource;
  }
  if (normalizedReason) {
    const normalized = normalizeNoiseReason(reason);
    const counts = ensureNoiseReasonCounts(data);
    counts[normalized] = (counts[normalized] || 0) + 1;
    data.lastNoiseReason = normalized;
  }
  if (normalizedSource || normalizedReason) {
    data.lastNoiseAt = nowIso;
  }
  return data;
}

module.exports = {
  hasRecentValidatedConfirmation, isCodeSpecificHint,
  shouldSuppressForNoise, filterNoiseSuppressedPoints,
  inferLanguageMismatch,
  ensureNoiseReasonCounts, ensureNoiseSourceCounts,
  recordNoiseMetadataData,
};
