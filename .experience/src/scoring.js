/**
 * scoring.js — Anti-noise scoring, confidence aging, probationary T2.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const { getValidatedHitCount } = require('./utils');
const { COLLECTIONS, getMinConfidence } = require('./config');

const SELFQA_COLLECTION = 'experience-selfqa';
const PROBATIONARY_T2_RAW_SCORE_THRESHOLD = 0.78;
const PROBATIONARY_T2_SURFACE_LIMIT = 2;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;

// --- Anti-Noise Scoring (Phase 103) ---

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug, queryText = '') {
  const cosine = point.score || 0;
  const hitBoost = Math.log2(1 + (data.hitCount || 0)) * 0.08;
  const normalizedQuery = String(queryText || '').toLowerCase();
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
  if (queryProjectSlug) {
    const scopeLang = data.scope?.lang;
    const principleLike = !!data.principle || data.createdFrom === 'evolution-abstraction' || getValidatedHitCount(data) >= SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD;
    if (scopeLang === 'all') {
      projectPenalty = 0; // Universal rules surface everywhere
    } else if (!data._projectSlug) {
      // No project slug on entry — apply heavier penalty (unknown origin)
      projectPenalty = principleLike ? 0.10 : 0.35;
    } else if (queryProjectSlug !== data._projectSlug) {
      // Cross-project — near-elimination penalty for non-principles
      projectPenalty = principleLike ? 0.22 : 0.85;
    }
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
  let conditionAdj = 0;
  if (Array.isArray(data.conditions) && data.conditions.length > 0) {
    const normalizedConditions = data.conditions
      .map((condition) => String(condition || '').trim().toLowerCase())
      .filter(Boolean);
    const matchedConditions = normalizedConditions.filter((condition) => normalizedQuery.includes(condition));
    if (matchedConditions.length === 0) conditionAdj = -0.14;
    else conditionAdj = Math.min(0.12, matchedConditions.length * 0.04);
  }
  // Phase 108: superseded experience penalty
  const supersededPenalty = data.superseded ? 0.15 : 0;
  // Wave 3: Confidence weighting — low-confidence entries rank lower
  const confWeight = computeEffectiveConfidence(data);
  const rawScore = cosine + hitBoost - recencyPenalty - ignorePenalty - irrelevantPenalty - unusedPenalty - noiseReasonPenalty - domainPenalty - projectPenalty + temporalAdj + conditionAdj - supersededPenalty;
  return rawScore * (0.6 + 0.4 * confWeight); // scale: 0.6 floor to avoid zeroing out
}

function rerankByQuality(points, queryDomain, queryProjectSlug, queryText = '') {
  return points
    .map(p => {
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      return { ...p, _effectiveScore: computeEffectiveScore(p, data, queryDomain, queryProjectSlug, queryText) };
    })
    .sort((a, b) => b._effectiveScore - a._effectiveScore);
}

function getSurfaceCountForProbation(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.surfaceCount === 'number') return data.surfaceCount;
  return (data.signalVersion || 0) >= 2 ? 0 : (data.hitCount || 0);
}

function hasProbationaryT2Debt(data) {
  if (!data || typeof data !== 'object') return true;
  if ((data.ignoreCount || 0) > 0) return true;
  if ((data.irrelevantCount || 0) > 0) return true;
  const noiseCounts = data.noiseReasonCounts || {};
  return Object.values(noiseCounts).some(value => Number(value || 0) > 0);
}

function isProbationaryT2Candidate(point) {
  if (!point || point._collection !== SELFQA_COLLECTION) return false;
  const rawScore = Number(point.score || 0);
  if (rawScore < PROBATIONARY_T2_RAW_SCORE_THRESHOLD) return false;
  let data;
  try { data = JSON.parse(point.payload?.json || '{}'); } catch { return false; }
  if (!data.solution) return false;
  if (computeEffectiveConfidence(data) >= getMinConfidence()) return false;
  if (getSurfaceCountForProbation(data) >= PROBATIONARY_T2_SURFACE_LIMIT) return false;
  if (hasProbationaryT2Debt(data)) return false;
  return true;
}

function selectProbationaryT2Points(points) {
  let selected = false;
  return (points || []).map(point => {
    if (selected || !isProbationaryT2Candidate(point)) return point;
    selected = true;
    return { ...point, _probationaryT2: true };
  });
}

module.exports = {
  computeEffectiveConfidence, computeEffectiveScore, rerankByQuality,
  getSurfaceCountForProbation, hasProbationaryT2Debt,
  isProbationaryT2Candidate, selectProbationaryT2Points,
};
