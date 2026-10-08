/**
 * dashboard/experiment.js — ADR-004 experiment progress and health for the dashboard.
 *
 * Monitoring only. It shows whether the experiment is running and healthy — how many
 * sessions and classified calls each arm has, whether the arms split as configured,
 * and whether the experiment's own plumbing is dropping errors — and deliberately
 * NOT which arm fails less. Comparing outcomes before the pre-registered end date is
 * peeking; that comparison belongs to tools/exp-engine-lift.js, once, at the end date.
 *
 * Sample-ratio mismatch (SRM): with a hashed assignment the observed control share
 * should match experimentHoldoutShare. A significant mismatch (chi-square, 1 dof,
 * p < 0.001) means sessions are lost or mislabelled in one arm — e.g. a control arm
 * leaking — and the analysis would be biased. The session-arm log counts every
 * session that reached the engine, so SRM uses it, not the eligible subset.
 *
 * Zero dependencies.
 */
'use strict';

const { isMutatingTool } = require('../../.experience/src/tool-outcome');
const { assembleSessions } = require('../exp-engine-lift');

const SRM_P_THRESHOLD = 0.001;
const DAY_MS = 86400000;
// Call sites whose dropped errors bear on the experiment's validity.
const EXPERIMENT_SWALLOW_SITES = /rememberExperimentArm|experiment|readState|flushQueue|persistAttempts|dequeue/i;

// Complementary error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

/**
 * Chi-square test (1 dof) of the observed control count against the expected share.
 * @returns {{expectedShare: number, observedShare: number|null, chi2: number|null, pValue: number|null, mismatch: boolean}}
 */
function sampleRatioMismatch(control, treatment, share) {
  const n = control + treatment;
  if (!(n > 0) || !(share > 0 && share < 1)) {
    return { expectedShare: share, observedShare: n > 0 ? control / n : null, chi2: null, pValue: null, mismatch: false };
  }
  const ec = n * share;
  const et = n * (1 - share);
  const chi2 = ((control - ec) ** 2) / ec + ((treatment - et) ** 2) / et;
  const pValue = erfc(Math.sqrt(chi2 / 2));
  return { expectedShare: share, observedShare: control / n, chi2, pValue, mismatch: pValue < SRM_P_THRESHOLD };
}

function armVolume(sessions, arm, minCalls) {
  const own = sessions.filter((s) => s.arm === arm);
  return {
    sessions: own.length,
    eligibleSessions: own.filter((s) => s.calls >= minCalls).length,
    classifiedCalls: own.reduce((a, s) => a + s.calls, 0),
    unclassifiedCalls: own.reduce((a, s) => a + s.unknown, 0),
  };
}

function modelSummary(sessions, minCalls, abShare) {
  const beta = armVolume(sessions, 'beta', minCalls);
  const legacy = armVolume(sessions, 'legacy', minCalls);
  return { beta, legacy, srm: sampleRatioMismatch(beta.sessions, legacy.sessions, Number(abShare)) };
}

/**
 * @param {Array<object>} experimentEvents  readExperimentLog() output
 * @param {Array<{raw: object}>} activityEvents  dashboard activity events (for op:'swallowed')
 * @param {{holdoutShare?: number, confidenceModel?: string, abShare?: number, log?: {path: string, files: number}, minCalls?: number, now?: Date}} opts
 */
function computeExperiment(experimentEvents, activityEvents, opts = {}) {
  const holdoutShare = Number(opts.holdoutShare) || 0;
  const confidenceModel = opts.confidenceModel || 'legacy';
  const minCalls = opts.minCalls || 5;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const events = Array.isArray(experimentEvents) ? experimentEvents : [];

  const arms = events.filter((e) => e.event === 'session-arm');
  const firstMs = arms.reduce((m, e) => Math.min(m, Date.parse(e.ts) || Infinity), Infinity);
  const lastMs = events.reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0);
  const daysRunning = Number.isFinite(firstMs) ? Math.max(0, (now.getTime() - firstMs) / DAY_MS) : 0;

  const holdout = assembleSessions(events, { compare: 'holdout' });
  const holdoutSessions = [...holdout.sessions.values()];
  const control = armVolume(holdoutSessions, 'control', minCalls);
  const treatment = armVolume(holdoutSessions, 'treatment', minCalls);

  const model = assembleSessions(events, { compare: 'model' });
  const modelSessions = [...model.sessions.values()];

  const swallowed = { total: 0, bySite: {} };
  for (const ev of activityEvents || []) {
    const raw = ev && ev.raw ? ev.raw : ev;
    if (!raw || raw.op !== 'swallowed' || !EXPERIMENT_SWALLOW_SITES.test(String(raw.where || ''))) continue;
    swallowed.total++;
    swallowed.bySite[raw.where] = (swallowed.bySite[raw.where] || 0) + 1;
  }

  const outcomes = events.filter((e) => e.event === 'outcome' && isMutatingTool(e.tool));
  return {
    status: 'monitoring, not a decision',
    note: 'Outcomes are compared only by tools/exp-engine-lift.js at the pre-registered end date (ADR-004).',
    active: holdoutShare > 0 || confidenceModel !== 'legacy',
    config: { holdoutShare, confidenceModel, abShare: opts.abShare ?? null },
    log: opts.log || null,
    events: events.length,
    firstSessionAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    lastEventAt: lastMs ? new Date(lastMs).toISOString() : null,
    daysRunning,
    sessionsPerWeek: daysRunning > 0 ? (holdoutSessions.length / daysRunning) * 7 : null,
    mutatingOutcomes: outcomes.length,
    holdout: {
      salt: holdout.salt,
      otherSaltSessions: holdout.ignoredOtherSalt,
      control,
      treatment,
      srm: sampleRatioMismatch(control.sessions, treatment.sessions, holdoutShare),
    },
    model: modelSessions.length ? modelSummary(modelSessions, minCalls, opts.abShare) : null,
    swallowed,
  };
}

module.exports = { computeExperiment, sampleRatioMismatch, erfc, SRM_P_THRESHOLD };
