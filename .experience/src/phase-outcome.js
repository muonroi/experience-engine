/**
 * src/phase-outcome.js — P1 Item 3: phase-grain reinforcement.
 *
 * Hosts applyPhaseOutcome and a 24h in-memory dedup cache. Receives the
 * verdict + evidence for a GSD phase and translates the phase outcome into
 * recordFeedback calls against principles that fired inside that phase.
 *
 * Mapping (conservative — see P1 design doc):
 *   pass       → FOLLOWED      reinforces principles that fired during a passing phase
 *   fail       → IGNORED       fail is ambiguous but spec assigns negative weight; we
 *                              record as IGNORED so the brain decays the principle
 *   abandoned  → IRRELEVANT    user dropped the phase — strong noise signal
 *
 * This module performs no Qdrant writes itself — it delegates to
 * recordFeedback which does the existing FileStore + Qdrant payload update.
 *
 * Idempotency: a (sessionId, phaseName) pair posted twice within 24h returns
 * the cached count without re-applying. This is in-memory only; restart-safe
 * is not a P1 requirement.
 *
 * Feature flag: callers should gate via process.env.ENABLE_PHASE_OUTCOME so
 * deployed servers without the flag set never invoke this path.
 */

'use strict';

const VALID_OUTCOMES = new Set(['pass', 'fail', 'abandoned']);
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const _dedupCache = new Map(); // key -> { ts, result }

function dedupKey(sessionId, phaseName) {
  return `${sessionId || ''}::${phaseName || ''}`;
}

function pruneDedup(now = Date.now()) {
  for (const [k, v] of _dedupCache.entries()) {
    if (now - v.ts > DEDUP_WINDOW_MS) _dedupCache.delete(k);
  }
}

function outcomeToVerdict(outcome) {
  if (outcome === 'pass') return { verdict: 'FOLLOWED', reason: null };
  if (outcome === 'fail') return { verdict: 'IGNORED', reason: null };
  if (outcome === 'abandoned') return { verdict: 'IRRELEVANT', reason: 'wrong_task' };
  return null;
}

/**
 * Apply a phase outcome to a list of fired principle references.
 *
 * @param {object} payload
 * @param {string} payload.sessionId
 * @param {string} payload.phaseName
 * @param {('pass'|'fail'|'abandoned')} payload.outcome
 * @param {Array<{collection: string, pointId: string}>} [payload.toolEventIds]
 *   List of principles that fired during the phase. When omitted, the caller
 *   should attach an empty list — the server has no other way to enumerate
 *   per-phase principles in P1.
 * @param {object} [payload.evidence] free-form evidence payload (logged only)
 * @param {object} deps
 * @param {Function} deps.recordFeedback — async (collection, pointId, verdict, reason, opts?) => bool
 * @param {Function} [deps.activityLog]   — sync logger
 *
 * @returns {Promise<{ok: boolean, applied: number, skipped: number, cached?: boolean, error?: string}>}
 */
async function applyPhaseOutcome(payload, deps) {
  if (!payload || typeof payload !== 'object') return { ok: false, applied: 0, skipped: 0, error: 'invalid payload' };
  const sessionId = String(payload.sessionId || '').trim();
  const phaseName = String(payload.phaseName || '').trim();
  const outcome = String(payload.outcome || '').toLowerCase();
  const toolEventIds = Array.isArray(payload.toolEventIds) ? payload.toolEventIds : [];

  if (!sessionId) return { ok: false, applied: 0, skipped: 0, error: 'sessionId is required' };
  if (!phaseName) return { ok: false, applied: 0, skipped: 0, error: 'phaseName is required' };
  if (!VALID_OUTCOMES.has(outcome)) return { ok: false, applied: 0, skipped: 0, error: 'invalid outcome' };

  const now = Date.now();
  pruneDedup(now);
  const key = dedupKey(sessionId, phaseName);
  const cached = _dedupCache.get(key);
  if (cached && now - cached.ts <= DEDUP_WINDOW_MS) {
    return { ...cached.result, cached: true };
  }

  const mapping = outcomeToVerdict(outcome);
  if (!mapping) return { ok: false, applied: 0, skipped: 0, error: 'unsupported outcome' };

  let applied = 0;
  let skipped = 0;
  for (const ref of toolEventIds) {
    if (!ref || !ref.collection || !ref.pointId) { skipped++; continue; }
    try {
      const ok = await deps.recordFeedback(ref.collection, ref.pointId, mapping.verdict, mapping.reason, { source: 'phase-outcome' });
      if (ok) applied++; else skipped++;
    } catch { skipped++; }
  }

  if (typeof deps.activityLog === 'function') {
    try {
      deps.activityLog({
        op: 'phase-outcome',
        sessionId,
        phaseName,
        outcome,
        verdict: mapping.verdict,
        applied,
        skipped,
        principleCount: toolEventIds.length,
      });
    } catch { /* non-fatal */ }
  }

  const result = { ok: true, applied, skipped, outcome, verdict: mapping.verdict, principleCount: toolEventIds.length };
  _dedupCache.set(key, { ts: now, result });
  return result;
}

function _resetDedup() {
  _dedupCache.clear();
}

module.exports = {
  applyPhaseOutcome,
  outcomeToVerdict,
  VALID_OUTCOMES,
  DEDUP_WINDOW_MS,
  _resetDedup,
};
