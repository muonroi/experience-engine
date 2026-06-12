/**
 * activity.js — Activity logging and cost tracking for Experience Engine.
 * Extracted from experience-core.js. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');
const os = require('os');

const ACTIVITY_LOG = process.env.EXPERIENCE_ACTIVITY_LOG || pathMod.join(os.homedir(), '.experience', 'activity.jsonl');
const MAX_LOG_SIZE = 10 * 1024 * 1024;

function activityLog(event) {
  try {
    try {
      const stat = fs.statSync(ACTIVITY_LOG);
      if (stat.size >= MAX_LOG_SIZE) {
        try { fs.renameSync(ACTIVITY_LOG, ACTIVITY_LOG + '.1'); } catch { /* race-safe */ }
      }
    } catch { /* file may not exist yet — fine */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(ACTIVITY_LOG, line + '\n');
  } catch { /* never crash the engine */ }
}

function estimateTextUnits(text, cap = 12000) {
  return Math.min(String(text || '').length, cap);
}

function logCostCall(kind, provider, source, units, extra = {}) {
  activityLog({
    op: 'cost-call',
    kind,
    provider: provider || 'unknown',
    source: source || 'unknown',
    units: Math.max(0, Math.round(Number(units) || 0)),
    ...extra,
  });
}

// Build the activity row for an active-recall call (op:'recall'). Pure (no I/O)
// so it is unit-testable without the server. Caller passes it to activityLog().
// This is the per-session observability foundation the runbook-candidate signal
// reads back from activity.jsonl ("agent ran N recalls in one session").
function buildRecallEvent(query, meta = {}, entries = []) {
  const ids = Array.isArray(entries)
    ? entries.map((e) => (e && e.id != null ? String(e.id) : '')).filter(Boolean)
    : [];
  return {
    op: 'recall',
    query: String(query || '').slice(0, 200),
    sourceSession: meta.sourceSession || null,
    project_slug: meta.project_slug || null,
    surfacedIds: ids,
    count: ids.length,
  };
}

// Build the activity row for a feedback verdict (op:'feedback'). Pure (no I/O).
// Pairs with buildRecallEvent: the session-end nudge / forensics compute unrated
// debt as recalled surfacedIds minus fed-back pointIds. verdict is the wire form
// (FOLLOWED|IGNORED|IRRELEVANT); reason is only present for IRRELEVANT (noise).
function buildFeedbackEvent(pointId, collection, verdict, reason = null) {
  return {
    op: 'feedback',
    pointId: String(pointId || ''),
    collection: collection || null,
    verdict: String(verdict || '').toUpperCase(),
    ...(reason ? { reason: String(reason) } : {}),
  };
}

function logMistakeSeen(mistakes, projectPath) {
  if (!Array.isArray(mistakes) || mistakes.length === 0) return;
  const counts = new Map();
  for (const mistake of mistakes) {
    const type = String(mistake?.type || 'unknown');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  for (const [type, count] of counts.entries()) {
    activityLog({ op: 'mistake-seen', type, count, project: projectPath || null });
  }
}

module.exports = {
  activityLog,
  estimateTextUnits,
  logCostCall,
  logMistakeSeen,
  buildRecallEvent,
  buildFeedbackEvent,
  ACTIVITY_LOG,
};
