/**
 * scoring.js — Anti-noise scoring, confidence aging, probationary T2.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const { getValidatedHitCount } = require('./utils');
const { COLLECTIONS, getMinConfidence } = require('./config');

const SELFQA_COLLECTION = 'experience-selfqa';
const PROBATIONARY_T2_RAW_SCORE_THRESHOLD = 0.60;
const PROBATIONARY_T2_SURFACE_LIMIT = 5;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;

// hitBoost cap: organic entries with many hits previously got unbounded boost
// (log2(1+100)*0.08 ≈ +0.53), letting a 0.45-cosine old entry beat a 0.85-cosine
// fresh seed. Cap so cosine remains the primary signal and hits a tiebreaker.
const HIT_BOOST_MAX = 0.12;

function isSeedEntry(data) {
  if (typeof data?.createdFrom !== 'string') return false;
  // evolution-abstraction entries are synthesized from clustering experience —
  // treat them as seeds so their confidence isn't discounted by lack of initial hits.
  return data.createdFrom.startsWith('seed-') || data.createdFrom === 'evolution-abstraction';
}

// --- Anti-Noise Scoring (Phase 103) ---

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  // Seeds come from authoritative org/common docs; their confidence shouldn't
  // be discounted for lack of accumulated runtime hits. Without this bypass,
  // a 0.7-base seed with 0 hits → 0.7 * 0.7 = 0.49 and gets filtered below
  // minConfidence at display time, even when retrieval is otherwise perfect.
  if (isSeedEntry(data)) return base;
  // Bootstrap grace: entries that were never surfaced (surfaceCount=0) should
  // not be penalized for lack of hits — they never had a chance to be validated.
  // Without this, the circular death spiral kills entries: no surface -> no hits
  // -> ageFactor 0.7 -> effConf drops below minConfidence -> never surfaces.
  const surfaceCount = data.surfaceCount || 0;
  if (surfaceCount <= 3 && hits <= surfaceCount) return Math.max(base, 0.50 + Math.min(0.20, hits * 0.05));
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug, queryText = '') {
  const cosine = point.score || 0;
  // Seeds never accumulate runtime hits, so granting them hitBoost (or letting
  // organic boost grow unbounded) inverts the intended ordering: a stale
  // 100-hit organic with 0.45 cosine should never edge out a 0-hit seed of
  // 0.85 cosine. Cap organic, zero for seeds.
  const hitBoost = isSeedEntry(data)
    ? 0
    : Math.min(HIT_BOOST_MAX, Math.log2(1 + (data.hitCount || 0)) * 0.08);
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
  // Seeds originate from org docs, not project files — '_projectSlug missing'
  // is by design, not unknown origin. Cross-repo leakage is already prevented
  // by the Qdrant pre-filter on scope_org plus applyScopeFilter's fail-closed
  // org gate (experience-core.js applyScopeFilter); double-charging seeds via
  // projectPenalty filtered them out of every foreign-repo query.
  if (queryProjectSlug && !isSeedEntry(data)) {
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
  const conditions = data.conditions;
  if (conditions && typeof conditions === 'object' && !Array.isArray(conditions)) {
    // Structured conditions: {toolMatch, commandMatch, filePattern, errorMatch, codePattern}
    let matched = 0;
    let total = 0;
    if (Array.isArray(conditions.toolMatch)) {
      total += conditions.toolMatch.length;
      // Extract actual tool name from query prefix "[tool:Edit]" or "[Edit]"
      const toolNameMatch = normalizedQuery.match(/\[(?:tool:)?([a-z_]+)\]/i);
      const actualTool = toolNameMatch ? toolNameMatch[1].toLowerCase() : '';
      matched += conditions.toolMatch.filter(t => {
        const ct = String(t).toLowerCase();
        // Exact tool name match (not substring of semantic text)
        return actualTool === ct || actualTool.includes(ct);
      }).length;
    }
    if (Array.isArray(conditions.commandMatch)) {
      total += conditions.commandMatch.length;
      matched += conditions.commandMatch.filter(c => normalizedQuery.includes(String(c).toLowerCase())).length;
    }
    if (Array.isArray(conditions.errorMatch)) {
      total += conditions.errorMatch.length;
      matched += conditions.errorMatch.filter(e => normalizedQuery.includes(String(e).toLowerCase())).length;
    }
    if (Array.isArray(conditions.filePattern)) {
      total += conditions.filePattern.length;
      // File patterns match against filePath, not query
      const fp = normalizedQuery;
      matched += conditions.filePattern.filter(p => {
        const pat = String(p).toLowerCase().replace(/\*\*/g, '').replace(/\*/g, '');
        return pat && (fp.includes(pat) || normalizedQuery.includes(pat));
      }).length;
    }
    if (total > 0) {
      conditionAdj = matched > 0 ? Math.min(0.12, matched * 0.04) : -0.14;
    }
    // No conditions at all = neutral (0), not penalty
  } else if (Array.isArray(conditions) && conditions.length > 0) {
    const normalizedConditions = conditions
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
  let selected = false; let probCount = 0;
  return (points || []).map(point => {
    if (selected || !isProbationaryT2Candidate(point)) return point;
    // Allow up to 3 probationary entries per intercept
    if (++probCount >= 3) selected = true;
    return { ...point, _probationaryT2: true };
  });
}

module.exports = {
  computeEffectiveConfidence, computeEffectiveScore, rerankByQuality,
  getSurfaceCountForProbation, hasProbationaryT2Debt,
  isProbationaryT2Candidate, selectProbationaryT2Points,
};
