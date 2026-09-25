/**
 * beta-evidence.js — `betaEvidence` bookkeeping for the Beta confidence model.
 *
 * Payload field (spec §3 B1):
 *   betaEvidence: { pos, neg, v: 1, sessions: [{ s, src, w, sign }] }   (last 50)
 *
 * Why a new field instead of reading the existing counters: every legacy counter
 * is already a policy, not a record. applyHitUpdate zeroes ignoreCount/unusedCount
 * on each hit and floors `confidence` upward; resetPromotionProbation wipes every
 * negative on promotion; noiseReasonCounts double-counts IRRELEVANT-with-reason
 * and implicit deterministic noise; `confidence` itself already contains the hits.
 * A posterior built from those would count some evidence twice and forget the
 * rest. So evidence is recorded once, at the writer, with its source.
 *
 * Rules:
 *   - weight by source (config betaEvidenceWeights): manual 1.0, judge 0.7,
 *     implicit touch 0.2, implicit noise/unused 0.3, organic support 0.3,
 *     session-repeat 0 (a weight-0 source records nothing);
 *   - one outcome per (session, point): a second event for a session keeps only
 *     the highest-priority source (manual > judge > implicit) — a higher or equal
 *     priority event REPLACES the earlier contribution, a lower one is dropped;
 *   - seeds (createdFrom seed-*, doc-to-experience, evolution-abstraction) take
 *     manual and judge evidence only: implicit signals are too noisy to move an
 *     authoritative entry;
 *   - initialisation happens inside the update function BEFORE any counter moves
 *     (applyHitUpdate zeroes ignoreCount): pos = 0.5*(validatedCount ?? hitCount ?? 0),
 *     neg = 0.5*(ignoreCount + irrelevantCount). Half weight, because what produced
 *     those historical counts is unknown. On READ the same value is computed but
 *     never persisted.
 * Tier moves (promotion, demotion, resetPromotionProbation) are not evidence and
 * never touch the field. Nothing reads it unless confidenceModel is shadow/beta/ab.
 */
'use strict';

const _config = require('./config');

const EVIDENCE_VERSION = 1;
const MAX_SESSIONS = 50;

// Source → [config weight key, dedupe priority].
const SOURCES = Object.freeze({
  manual: ['manual', 3],
  judge: ['judge', 2],
  'implicit-touch': ['implicitTouch', 1],
  'implicit-noise': ['implicitNoise', 1],
  organic: ['organic', 1],
  'session-repeat': ['sessionRepeat', 0],
});
const SEED_SOURCES = new Set(['manual', 'judge']);

function isSeedProvenance(data) {
  const cf = typeof data?.createdFrom === 'string' ? data.createdFrom : '';
  return cf.startsWith('seed-') || cf === 'doc-to-experience' || cf === 'evolution-abstraction';
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function isValidEvidence(ev) {
  return !!ev && typeof ev === 'object' && ev.v === EVIDENCE_VERSION
    && Number.isFinite(ev.pos) && Number.isFinite(ev.neg) && Array.isArray(ev.sessions);
}

function initialEvidence(data) {
  const validated = data?.validatedCount ?? data?.hitCount ?? 0;
  const pos = 0.5 * (Number(validated) || 0);
  const neg = 0.5 * ((Number(data?.ignoreCount) || 0) + (Number(data?.irrelevantCount) || 0));
  return { pos: round6(pos), neg: round6(neg), v: EVIDENCE_VERSION, sessions: [] };
}

/** The evidence as the model sees it: stored, or computed from counters (not persisted). */
function readBetaEvidence(data) {
  return isValidEvidence(data?.betaEvidence) ? data.betaEvidence : initialEvidence(data);
}

function normalizeSession(sessionId) {
  if (sessionId === null || sessionId === undefined) return null;
  const s = String(sessionId).trim();
  return s && s !== 'null' && s !== 'undefined' ? s : null;
}

function weightFor(source, weights) {
  const entry = SOURCES[source];
  if (!entry) return 0;
  const w = Number(weights[entry[0]]);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * Call at the TOP of an update function, before any legacy counter moves.
 * Returns a handle for recordBetaEvidence, or null when this event will record
 * nothing (bookkeeping off, unknown or zero-weight source, implicit on a seed) —
 * in which case the payload is left untouched.
 */
function beginBetaEvidence(data, source) {
  if (!data || typeof data !== 'object') return null;
  if (!_config.getBetaEvidenceEnabled()) return null;
  const weights = _config.getBetaEvidenceWeights();
  const w = weightFor(source, weights);
  if (!(w > 0)) return null;
  if (isSeedProvenance(data) && !SEED_SOURCES.has(source)) return null;
  if (!isValidEvidence(data.betaEvidence)) data.betaEvidence = initialEvidence(data);
  return { source, w };
}

/**
 * Record one outcome after the legacy update. sign: +1 (helpful) / -1 (noise).
 * No-op for a null handle.
 * @param {object} data
 * @param {{source: string, w: number}|null} handle
 * @param {{sessionId?: string|null, sign?: number}} [opts]
 */
function recordBetaEvidence(data, handle, { sessionId = null, sign = 1 } = {}) {
  if (!handle || !data || !isValidEvidence(data.betaEvidence)) return data;
  const ev = data.betaEvidence;
  const s = normalizeSession(sessionId);
  const side = sign > 0 ? 'pos' : 'neg';
  const priority = SOURCES[handle.source][1];
  if (s) {
    const idx = ev.sessions.findIndex((e) => e && e.s === s);
    if (idx >= 0) {
      const prev = ev.sessions[idx];
      const prevPriority = SOURCES[prev.src] ? SOURCES[prev.src][1] : 0;
      if (prevPriority > priority) return data; // a stronger source already spoke for this session
      const prevSide = prev.sign > 0 ? 'pos' : 'neg';
      ev[prevSide] = Math.max(0, round6(ev[prevSide] - (Number(prev.w) || 0)));
      ev.sessions.splice(idx, 1);
    }
  }
  ev[side] = round6(ev[side] + handle.w);
  ev.sessions.push({ s, src: handle.source, w: handle.w, sign: sign > 0 ? 1 : -1 });
  if (ev.sessions.length > MAX_SESSIONS) ev.sessions = ev.sessions.slice(-MAX_SESSIONS);
  return data;
}

/**
 * Convenience for writers with no counter mutation in between.
 * @param {object} data
 * @param {{source: string, sessionId?: string|null, sign?: number}} event
 */
function addBetaEvidence(data, { source, sessionId = null, sign = 1 }) {
  return recordBetaEvidence(data, beginBetaEvidence(data, source), { sessionId, sign });
}

/**
 * Clear negative evidence (exp-reset-ignore-count.js --beta): neg = 0 and the
 * negative session entries go too, so a later same-session replacement cannot
 * subtract from a neg that no longer holds it.
 */
function clearNegativeEvidence(data) {
  if (!data || typeof data !== 'object') return data;
  const ev = isValidEvidence(data.betaEvidence) ? data.betaEvidence : initialEvidence(data);
  data.betaEvidence = { ...ev, neg: 0, sessions: ev.sessions.filter((e) => e && e.sign > 0) };
  return data;
}

/** Prior (mu, k) for an entry by provenance (spec §3 B2). */
function priorFor(data, means = _config.getBetaPriorMeans(), strength = _config.getBetaPriorStrength()) {
  const cf = typeof data?.createdFrom === 'string' ? data.createdFrom : '';
  let mu = means.default;
  if (cf && Object.prototype.hasOwnProperty.call(means, cf) && cf !== 'default') mu = means[cf];
  else if (cf.startsWith('seed-') && Number.isFinite(means['seed-*'])) mu = means['seed-*'];
  const k = isSeedProvenance(data) ? strength.seed : strength.default;
  return { mu, k };
}

module.exports = {
  EVIDENCE_VERSION,
  MAX_SESSIONS,
  SOURCES,
  isSeedProvenance,
  isValidEvidence,
  initialEvidence,
  readBetaEvidence,
  beginBetaEvidence,
  recordBetaEvidence,
  addBetaEvidence,
  clearNegativeEvidence,
  priorFor,
};
