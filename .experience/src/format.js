'use strict';

const { getMinConfidence, getHighConfidence } = require('./config');
const { computeEffectiveConfidence } = require('./scoring');

function buildStorePayload(id, qa, domain, projectSlug) {
  // Wave 2: Tag natural language for cross-lingual matching
  const naturalLang = detectNaturalLang(`${qa.trigger} ${qa.solution}`);
  const normalizedConditions = normalizeConditions(qa.conditions, `${qa.trigger} ${qa.solution}`);
  const evidenceClass = normalizeEvidenceClass(qa.evidenceClass, qa);
  const failureMode = normalizeFailureMode(qa.failureMode, qa);
  const judgment = normalizeJudgment(qa.judgment, qa);
  return {
    id, trigger: qa.trigger, question: qa.question,
    reasoning: qa.reasoning || [], solution: qa.solution,
    why: qa.why || null,    // v2: root cause / incident motivation
    scope: qa.scope || null, // v2: {lang, repos, filePattern} — hard filter gate
    failureMode,
    judgment,
    conditions: normalizedConditions,
    evidenceClass,
    provenance: {
      kind: 'seed',
      source: 'session-extractor',
      sourceSession: qa.sourceSession || null,
    },
    novelCaseEvidence: {
      seedSupportCount: 1,
      seedEntryIds: [id],
      holdoutMatchedCount: 0,
      holdoutTestedCount: 0,
      holdoutSessions: [],
      holdoutProjects: [],
      lastMatchedAt: null,
    },
    confidence: 0.5, hitCount: 0, validatedCount: 0, surfaceCount: 0, signalVersion: 2, tier: 2,
    lastHitAt: null, ignoreCount: 0, unusedCount: 0,
    confirmedAt: [],  // Phase 108: temporal trace
    domain: domain || null,
    _projectSlug: projectSlug || null, // P0: project-aware filtering
    naturalLang,
    createdAt: new Date().toISOString(), createdFrom: 'session-extractor',
  };
}

function formatPoints(points) {
  const lines = [];
  for (const point of points) {
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    const effConf = computeEffectiveConfidence(exp);
    if (effConf < getMinConfidence() && !point._probationaryT2) continue;
    const displayScore = point._effectiveScore ?? point.score ?? 0;
    let line;
    if (point._probationaryT2) {
      line = `💡 [Probationary Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else if (displayScore >= getHighConfidence()) {
      line = `⚠️ [Experience - High Confidence (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else {
      line = `💡 [Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    }
    if (exp.why) {
      line += `\n   Why: ${exp.why}`;
    }
    const pid = String(point.id).slice(0, 8);
    const coll = point._collection || 'experience-behavioral';
    line += `\n   [id:${pid} col:${coll}]`;
    // v3: inline feedback — agent reports noisy/wrong hints
    line += `\n   ↩ Wrong? POST /api/feedback {"pointId":"${pid}","collection":"${coll}","verdict":"IRRELEVANT","reason":"wrong_repo"}`;
    lines.push(line);
  }
  return lines;
}

function applyBudget(lines, maxChars) {
  const result = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > maxChars) break;
    result.push(line);
    total += line.length;
  }
  return result;
}

function ensureSignalMetrics(data) {
  if (!data || typeof data !== 'object') return data;
  if (typeof data.surfaceCount !== 'number') {
    data.surfaceCount = (data.signalVersion || 0) >= 2 ? 0 : (data.hitCount || 0);
  }
  if (typeof data.validatedCount !== 'number') data.validatedCount = 0;
  if (!Array.isArray(data.confirmedAt)) data.confirmedAt = [];
  data.signalVersion = 2;
  ensureAbstractionFields(data);
  ensureNovelCaseEvidence(data);
  return data;
}

function normalizeEvidenceClass(value, qa = {}) {
  const allowed = new Set(['log', 'test', 'runtime', 'review', 'user-correction', 'other']);
  const normalized = String(value || '').trim().toLowerCase();
  if (allowed.has(normalized)) return normalized;
  const combined = `${qa.trigger || ''} ${qa.question || ''} ${qa.solution || ''}`.toLowerCase();
  if (/\b(test|assert|fixture|expect|jest|vitest|mocha)\b/.test(combined)) return 'test';
  if (/\b(log|trace|stack|stderr|stdout)\b/.test(combined)) return 'log';
  if (/\b(review|comment|requested changes)\b/.test(combined)) return 'review';
  if (/\b(user correction|corrected by user)\b/.test(combined)) return 'user-correction';
  return 'runtime';
}

function normalizeConditions(conditions, fallbackText = '') {
  const fallbackTokens = String(fallbackText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  const combined = []
    .concat(Array.isArray(conditions) ? conditions : [])
    .concat(fallbackTokens.slice(0, 4));
  const seen = new Set();
  const normalized = [];
  for (const item of combined) {
    const value = String(item || '').trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= 4) break;
  }
  return normalized;
}

function normalizeFailureMode(value, qa = {}) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized) return normalized;
  const why = String(qa.why || '').replace(/\s+/g, ' ').trim();
  if (why) return why;
  return String(qa.question || qa.trigger || '').replace(/\s+/g, ' ').trim() || null;
}

function normalizeJudgment(value, qa = {}) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized) return normalized;
  return String(qa.solution || '').replace(/\s+/g, ' ').trim() || null;
}

function ensureAbstractionFields(data) {
  if (!data || typeof data !== 'object') return data;
  if (!data.failureMode) data.failureMode = normalizeFailureMode(data.failureMode, data);
  if (!data.judgment) data.judgment = normalizeJudgment(data.judgment, data);
  data.conditions = normalizeConditions(data.conditions, `${data.trigger || ''} ${data.solution || ''}`);
  if (!data.evidenceClass) data.evidenceClass = normalizeEvidenceClass(data.evidenceClass, data);
  if (!data.provenance || typeof data.provenance !== 'object') {
    data.provenance = {
      kind: data.tier === 0 ? 'principle' : data.tier === 1 ? 'behavioral' : 'seed',
      source: data.createdFrom || 'unknown',
      sourceSession: data.lastConfirmedSession || null,
    };
  }
  return data;
}

function ensureNovelCaseEvidence(data) {
  if (!data || typeof data !== 'object') return data;
  if (!data.novelCaseEvidence || typeof data.novelCaseEvidence !== 'object') data.novelCaseEvidence = {};
  const evidence = data.novelCaseEvidence;
  if (typeof evidence.seedSupportCount !== 'number') evidence.seedSupportCount = data.tier === 2 ? 1 : 0;
  if (!Array.isArray(evidence.seedEntryIds)) evidence.seedEntryIds = [];
  if (typeof evidence.holdoutMatchedCount !== 'number') evidence.holdoutMatchedCount = 0;
  if (typeof evidence.holdoutTestedCount !== 'number') evidence.holdoutTestedCount = 0;
  if (!Array.isArray(evidence.holdoutTestedKeys)) evidence.holdoutTestedKeys = [];
  if (!Array.isArray(evidence.holdoutMatchedKeys)) evidence.holdoutMatchedKeys = [];
  if (!Array.isArray(evidence.holdoutSessions)) evidence.holdoutSessions = [];
  if (!Array.isArray(evidence.holdoutProjects)) evidence.holdoutProjects = [];
  if (!('lastMatchedAt' in evidence)) evidence.lastMatchedAt = null;
  return data;
}

function isPrincipleLikeEntry(data) {
  return !!(data?.principle || data?.tier === 0 || data?.createdFrom === 'evolution-abstraction');
}

function buildPrincipleText(data) {
  if (!data) return '';
  if (data.principle) return data.principle;
  if (data.failureMode && data.judgment) {
    const because = String(data.why || '').replace(/\s+/g, ' ').trim();
    return because
      ? `When ${data.failureMode}, ${data.judgment} because ${because}`
      : `When ${data.failureMode}, ${data.judgment}`;
  }
  if (data.trigger && data.solution) {
    return /^(when|if|always|never)\b/i.test(data.trigger)
      ? `${data.trigger} ${data.solution}`.trim()
      : `When ${data.trigger}, ${data.solution}`;
  }
  return data.solution || data.trigger || '';
}

function normalizeTechLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'typescript react' || normalized === 'typescript') return 'typescript';
  if (normalized === 'javascript react' || normalized === 'javascript') return 'javascript';
  if (normalized === 'csharp' || normalized === 'c#') return 'c#';
  if (normalized === 'fsharp' || normalized === 'f#') return 'f#';
  if (normalized === 'yaml') return 'yaml';
  return normalized;
}

module.exports = {
  buildStorePayload, formatPoints, applyBudget,
  ensureSignalMetrics, normalizeEvidenceClass, normalizeConditions,
  normalizeFailureMode, normalizeJudgment, ensureAbstractionFields,
  ensureNovelCaseEvidence, isPrincipleLikeEntry, buildPrincipleText,
  normalizeTechLabel,
};
