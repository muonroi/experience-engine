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

function applyHitUpdate(data) {
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
  return data;
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

async function recordHit(collection, pointId) {
  await updatePointPayload(collection, pointId, applyHitUpdate);
}

async function recordSurface(collection, pointId) {
  await updatePointPayload(collection, pointId, applySurfaceUpdate);
}

async function recordHoldoutOutcome(collection, pointId, outcome = {}) {
  await updatePointPayload(collection, pointId, (data) => recordHoldoutOutcomeOnData(data, outcome));
}

async function incrementIgnoreCount(collection, pointId) {
  await updatePointPayload(collection, pointId, incrementIgnoreCountData);
}

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

async function recordJudgeFeedback(collection, pointId, verdict, reason = null) {
  const normalized = normalizeFeedbackVerdict(verdict);
  if (!normalized) return false;
  return recordFeedback(collection, pointId, normalized, reason, { source: 'judge' });
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
