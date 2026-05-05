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
  ACTIVITY_LOG,
};
