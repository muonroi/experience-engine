/**
 * hittrack.js — Hit/surface/feedback tracking for Experience Engine.
 * Extracted from experience-core.js. Zero dependencies.
 */
'use strict';

const _format = require('./format');
const _qdrant = require('./qdrant');
const _session = require('./session');
const _noise = require('./noise');
const _activity = require('./activity');
const _betaEvidence = require('./beta-evidence');

const { ensureSignalMetrics, ensureNovelCaseEvidence, isPrincipleLikeEntry } = _format;
const { updatePointPayload } = _qdrant;
const { incrementIgnoreCountData, incrementIrrelevantData, incrementUnusedData, normalizeNoiseDisposition, normalizeNoiseReason, normalizeFeedbackVerdict } = _session;
const { recordNoiseMetadataData } = _noise;
const { activityLog } = _activity;

function getValidatedHitCount(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.validatedCount === 'number') return data.validatedCount;
  return 0;
}

// betaEvidence (spec §3 B1): every writer below passes its source. The evidence
// handle is taken BEFORE the legacy mutation — applyHitUpdate zeroes ignoreCount,
// and the first-write initialisation must see the counters as they were.
// `evidence` is optional so the many existing callers that pass applyHitUpdate
// straight to updatePointPayload record nothing extra.
function applyHitUpdate(data, evidence = null) {
  const handle = evidence ? _betaEvidence.beginBetaEvidence(data, evidence.source) : null;
  ensureSignalMetrics(data);
  data.validatedCount = (data.validatedCount || 0) + 1;
  data.hitCount = data.validatedCount;
  data.lastHitAt = new Date().toISOString();
  data.ignoreCount = 0;
  data.unusedCount = 0;
  data.confirmedAt.push(data.lastHitAt);
  if (data.confirmedAt.length > 50) data.confirmedAt = data.confirmedAt.slice(-50);
  const confidenceFloor = 0.50 + Math.min(0.18, (data.validatedCount || 0) * 0.04);
  data.confidence = Math.max(Number(data.confidence || 0), confidenceFloor);
  if (handle) _betaEvidence.recordBetaEvidence(data, handle, { sessionId: evidence.sessionId, sign: 1 });
  return data;
}

// Legacy noise-source names → betaEvidence sources. 'followed' from an implicit
// source would be a touch; the implicit writers use applyHitUpdateWithContext.
function betaSourceFor(source, disposition) {
  if (source === 'manual') return 'manual';
  if (source === 'judge') return 'judge';
  if (source === 'implicit-posttool' || source === 'prompt-stale') return disposition === 'followed' ? 'implicit-touch' : 'implicit-noise';
  return null;
}

function applySurfaceUpdate(data) {
  ensureSignalMetrics(data);
  data.surfaceCount = (data.surfaceCount || 0) + 1;
  data.lastSurfacedAt = new Date().toISOString();
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

// Implicit touch (reconcilePendingHints): the deterministic path/lang match.
function applyHitUpdateWithContext(context = {}) {
  return function applyHitWithContext(data) {
    applyHitUpdate(data, { source: 'implicit-touch', sessionId: context.sourceSession || null });
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

// options.sessionId: one betaEvidence outcome per (session, point).
// options.betaSource: override the evidence source (recordFeedback maps
// phase-outcome verdicts, which legacy files under 'manual', to 'judge').
function applyNoiseDispositionData(disposition, source = 'manual', reason = null, options = {}) {
  return function applyNoiseDisposition(data) {
    const normalizedDisposition = normalizeNoiseDisposition(disposition);
    if (!normalizedDisposition) return data;
    const betaSource = options.betaSource || betaSourceFor(source, normalizedDisposition);
    const handle = betaSource ? _betaEvidence.beginBetaEvidence(data, betaSource) : null;
    if (normalizedDisposition === 'followed') {
      applyHitUpdate(data);
      _betaEvidence.recordBetaEvidence(data, handle, { sessionId: options.sessionId, sign: 1 });
      return data;
    }
    if (normalizedDisposition === 'ignored') incrementIgnoreCountData(data);
    if (normalizedDisposition === 'irrelevant') incrementIrrelevantData(data);
    if (normalizedDisposition === 'unused') {
      incrementUnusedData(data);
      if (options.countIrrelevant) incrementIrrelevantData(data);
    }
    recordNoiseMetadataData(data, source, reason);
    _betaEvidence.recordBetaEvidence(data, handle, { sessionId: options.sessionId, sign: -1 });
    return data;
  };
}

function incrementIrrelevantWithReasonData(reason) {
  return applyNoiseDispositionData('irrelevant', 'manual', reason);
}

// An explicit API hit (no in-tree caller today) is a manual confirmation.
async function recordHit(collection, pointId, options = {}) {
  await updatePointPayload(collection, pointId, (data) => applyHitUpdate(data, { source: 'manual', sessionId: options.sessionId || null }));
}

async function recordSurface(collection, pointId) {
  await updatePointPayload(collection, pointId, applySurfaceUpdate);
}

async function recordHoldoutOutcome(collection, pointId, outcome = {}) {
  await updatePointPayload(collection, pointId, (data) => recordHoldoutOutcomeOnData(data, outcome));
}

// Session-repeat flag (trackSuggestions' third re-show). Deliberately NO
// betaEvidence: its weight is 0 — re-showing a hint says nothing about the hint.
async function incrementIgnoreCount(collection, pointId) {
  await updatePointPayload(collection, pointId, incrementIgnoreCountData);
}

async function recordFeedback(collection, pointId, verdictOrFollowed, reason = null, options = {}) {
  const verdict = normalizeFeedbackVerdict(verdictOrFollowed);
  if (!verdict) return false;

  const normalizedReason = verdict === 'IRRELEVANT' ? normalizeNoiseReason(reason) : null;
  const source = options.source === 'judge' ? 'judge' : 'manual';
  const callerContext = options.callerContext || null;
  // Evidence source: phase-outcome is an automated outcome mapping, not an
  // explicit verdict, so it weighs like the judge rather than like a human.
  const evidenceOpts = {
    sessionId: options.sessionId || null,
    betaSource: options.source === 'phase-outcome' ? 'judge' : source,
  };
  const baseUpdateFn = verdict === 'FOLLOWED'
    ? applyNoiseDispositionData('followed', source, null, evidenceOpts)
    : verdict === 'IGNORED'
      ? applyNoiseDispositionData('ignored', source, null, evidenceOpts)
      : applyNoiseDispositionData('irrelevant', source, normalizedReason, evidenceOpts);

  // Wrap to also append caller context to noiseContextHistory (capped at 50
  // entries to avoid unbounded growth). Future evolve step consumes this to
  // narrow scope (exclude specific lang/project) instead of full supersede.
  const updateFn = (data) => {
    baseUpdateFn(data);
    if (callerContext && (verdict === 'IGNORED' || verdict === 'IRRELEVANT')) {
      if (!Array.isArray(data.noiseContextHistory)) data.noiseContextHistory = [];
      data.noiseContextHistory.push({
        ts: new Date().toISOString(),
        verdict,
        reason: normalizedReason,
        lang: callerContext.lang || null,
        framework: callerContext.framework || null,
        project_slug: callerContext.project_slug || null,
      });
      if (data.noiseContextHistory.length > 50) {
        data.noiseContextHistory = data.noiseContextHistory.slice(-50);
      }
    }
    return data;
  };

  await updatePointPayload(collection, pointId, updateFn);
  activityLog({
    op: 'noise-disposition',
    collection,
    pointId: pointId.slice(0, 8),
    disposition: verdict.toLowerCase(),
    source,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
  // Unified op naming: all explicit verdicts emit op='feedback' with a
  // 'source' tag (manual / judge / implicit). Prior to this, judge-emitted
  // FOLLOWED verdicts used op='judge-feedback' which the dashboard precision
  // aggregator did not count — they were invisible to Gate 4 measurement.
  activityLog({
    op: 'feedback',
    source,
    collection,
    pointId: pointId.slice(0, 8),
    verdict,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
  return true;
}

async function recordJudgeFeedback(collection, pointId, verdict, reason = null, options = {}) {
  const normalized = normalizeFeedbackVerdict(verdict);
  if (!normalized) return false;
  return recordFeedback(collection, pointId, normalized, reason, { source: 'judge', sessionId: options.sessionId || null });
}

module.exports = {
  getValidatedHitCount,
  applyHitUpdate,
  applySurfaceUpdate,
  recordHoldoutOutcomeOnData,
  recordNovelCaseEvidence,
  applyHitUpdateWithContext,
  applyNoiseDispositionData,
  incrementIrrelevantWithReasonData,
  recordHit,
  recordSurface,
  recordHoldoutOutcome,
  incrementIgnoreCount,
  recordFeedback,
  recordJudgeFeedback,
};
