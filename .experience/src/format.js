'use strict';

const { getMinConfidence, getHighConfidence, getMinSearchScore } = require('./config');
const { computeEffectiveConfidence } = require('./scoring');
const { detectNaturalLang } = require('./context');
const { log } = require('./logger');

function buildStorePayload(id, qa, domain, projectSlug) {
  // Wave 2: Tag natural language for cross-lingual matching
  const naturalLang = detectNaturalLang(`${qa.trigger} ${qa.solution}`);
  const normalizedConditions = normalizeConditions(qa.conditions, `${qa.trigger} ${qa.solution}`);
  const evidenceClass = normalizeEvidenceClass(qa.evidenceClass, qa);
  const failureMode = normalizeFailureMode(qa.failureMode, qa);
  const judgment = normalizeJudgment(qa.judgment, qa);
  // P0: merge projectSlug into qa.scope so the query-time filter
  // (experience-core#applyScopeFilter reads `scope.project_slug`) actually
  // sees a value. The legacy root-level `_projectSlug` field is kept for
  // one release as a fallback but is no longer the source of truth.
  const scope = (qa.scope && typeof qa.scope === 'object') ? { ...qa.scope } : {};
  if (projectSlug && !scope.project_slug) scope.project_slug = projectSlug;
  // Preserve legacy contract: scope is null when no constraints were set
  // (no qa.scope provided AND no projectSlug derivable). applyScopeFilter
  // treats null as "no gate" so this is semantically equivalent to {}, but
  // keeps the seed payload compact and matches existing tests.
  const finalScope = Object.keys(scope).length === 0 ? null : scope;
  return {
    id, trigger: qa.trigger, question: qa.question,
    reasoning: qa.reasoning || [], solution: qa.solution,
    why: qa.why || null,    // v2: root cause / incident motivation
    scope: finalScope, // v2: {lang, framework, project_slug, repos, filePattern} — hard filter gate
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

// opts.skipSearchScoreGate: bypass GATE 2 (the min-search-score relevance floor).
// Active recall (semantic-search mode) sets this — the floor is a noise-control
// signal for passive hints, not a relevance ceiling for a deliberate query. The
// min-confidence quality gate (GATE 1) and all HARD integrity gates (superseded,
// permanent-noise, irrelevant) still apply regardless of this flag.
function formatPoints(points, opts = {}) {
  const skipSearchScoreGate = !!(opts && opts.skipSearchScoreGate);
  const lines = [];
  for (const point of points) {
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    const effConf = computeEffectiveConfidence(exp);
    const mc = getMinConfidence();
    if (effConf < mc && !point._probationaryT2) {
      log('debug', 'format_point_rejected', {
        reason: 'confidence_below_min',
        effectiveConfidence: Number(effConf.toFixed(3)),
        minConfidence: mc,
        probationary: !!point._probationaryT2,
      });
      continue;
    }
    const displayScore = point._effectiveScore ?? point.score ?? 0;
    // Suppress anti-recommendations: when query-time effective score (which
    // factors in ignore/hit ratio + scope mismatch penalties) falls below
    // the min threshold, surfacing it as 💡 [Suggestion] tells the agent the
    // opposite of what the score actually says.
    const mss = getMinSearchScore();
    if (!skipSearchScoreGate && !point._probationaryT2 && displayScore < mss) {
      log('debug', 'format_point_rejected', {
        reason: 'score_below_min_search',
        displayScore: Number(displayScore.toFixed(3)),
        minSearchScore: mss,
      });
      continue;
    } // GATE 2: search relevance (separate from confidence quality)
    // Probationary entries are intentionally low-confidence (new, untested),
    // but never surface if score is clearly negative — that's a stronger
    // signal than "untested": penalties exceeded similarity, meaning the
    // candidate is actively misaligned with the query.
    if (point._probationaryT2 && displayScore < 0) continue;
    // HARD GATE A: superseded entries must never surface.
    // The -0.15 score penalty is too weak: a 0.80-cosine match still passes
    // minSearchScore after penalty, so we explicitly drop these regardless
    // of score. They will be physically deleted by evolve Step 4d.
    if (exp.superseded === true) {
      log('debug', 'format_point_rejected', {
        reason: 'superseded',
        confidence: exp.confidence,
      });
      continue;
    }
    // HARD GATE B: proven-noise entries. If an entry has been ignored ≥ 20
    // times while never producing a single hit, it is permanent noise and
    // must stop firing regardless of cosine similarity. ignorePenalty caps
    // at -0.30 which cannot defeat a 0.80+ cosine, so we need a hard cut.
    if ((exp.ignoreCount || 0) >= 20 && (exp.hitCount || 0) === 0) {
      log('debug', 'format_point_rejected', {
        reason: 'permanent_noise',
        ignoreCount: exp.ignoreCount,
        hitCount: exp.hitCount,
      });
      continue;
    }
    // Instant noise suppression: if the entry has been explicitly marked
    // IRRELEVANT ≥3 times, stop surfacing it immediately — don't wait for
    // the hourly evolve cycle to mark it superseded. This closes the loop
    // where an agent reports the same hint as noise repeatedly because the
    // feedback signal hasn't yet decayed into the score.
    if ((exp.irrelevantCount || 0) >= 3) {
      log('debug', 'format_point_rejected', {
        reason: 'irrelevant_threshold',
        irrelevantCount: exp.irrelevantCount,
      });
      continue;
    }
    let line;
    if (point._probationaryT2) {
      line = `💡 [Probationary Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else if (displayScore >= getHighConfidence()) {
      line = `⚠️ [Experience - High Confidence (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else {
      line = `💡 [Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    }
    if (exp.trigger) {
      line += `\n   When: ${exp.trigger.slice(0, 120)}`;
    }
    if (exp.why) {
      line += `\n   Why: ${exp.why}`;
    }
    if (exp.conditions && typeof exp.conditions === 'object' && !Array.isArray(exp.conditions)) {
      const conds = [];
      if (exp.conditions.toolMatch) conds.push('tools: ' + exp.conditions.toolMatch.join(', '));
      if (exp.conditions.commandMatch) conds.push('commands: ' + exp.conditions.commandMatch.slice(0, 3).join(', '));
      if (exp.conditions.errorMatch) conds.push('errors: ' + exp.conditions.errorMatch.slice(0, 2).join(', '));
      if (exp.conditions.filePattern) conds.push('files: ' + exp.conditions.filePattern.slice(0, 2).join(', '));
      if (conds.length > 0) line += `\n   Fires when: ${conds.join(' | ')}`;
    }
    if (exp.evidenceClass) {
      line += `\n   Evidence: ${exp.evidenceClass}`;
    }
    if (exp.judgment) {
      line += `\n   Rule: ${exp.judgment.slice(0, 120)}`;
    }
    const pid = String(point.id).slice(0, 8);
    const coll = point._collection || 'experience-behavioral';
    line += `\n   [id:${pid} col:${coll}]`;
    // v3: inline feedback — one compact line listing ALL THREE verdicts so the
    // loop is closed both ways without bloating the per-entry display budget
    // (a multi-line footer overflowed budgetChars and dropped whole entries).
    // `followed` is the asymmetric signal Gate-4 precision needs; `ignored`
    // keeps the entry alive; only `noise` pushes it toward removal. The helper
    // reads serverBaseUrl + token from ~/.experience/config.json (works on thin
    // clients; raw `POST /api/feedback` no-ops against a remote VPS).
    line += `\n   ↩ feedback: node ~/.experience/exp-feedback.js followed|ignored|noise ${pid} ${coll} [reason]`;
    lines.push(line);
  }
  return lines;
}

function applyBudget(lines, maxChars) {
  const result = [];
  let total = 0;
  for (const line of lines) {
    // Skip (continue), don't stop (break): a single oversized line must not
    // discard every line after it. Recall-format lines run ~2000 chars each;
    // with `break` one fat first line zeroed the whole collection leg, so recall
    // surfaced ≤1 entry per collection regardless of budget. continue keeps
    // packing smaller lines that still fit, while the total stays bounded.
    if (total + line.length > maxChars) continue;
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
  // Preserve structured conditions (object with filePattern/toolMatch/etc.)
  if (conditions && typeof conditions === 'object' && !Array.isArray(conditions)) {
    const hasStructured = conditions.filePattern || conditions.toolMatch || conditions.commandMatch || conditions.codePattern || conditions.errorMatch || conditions.userSaid;
    if (hasStructured) return conditions;
  }
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

// buildTextSearch: the lexical-search text for a stored entry. Concatenates the
// human-meaningful fields (trigger, question, solution, judgment, failureMode)
// into one normalized string that gets stored as a TOP-LEVEL payload field so
// Qdrant can full-text index it (the canonical text lives inside payload.json,
// which Qdrant cannot tokenize). Used by the write path (upsertEntry), the
// backfill tool, and — implicitly via the index — the hybrid recall lexical leg.
function buildTextSearch(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [
    data.trigger, data.question, data.solution,
    data.judgment, data.failureMode, data.principle,
  ];
  return parts
    .filter(p => typeof p === 'string' && p.trim())
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

module.exports = {
  buildStorePayload, formatPoints, applyBudget,
  ensureSignalMetrics, normalizeEvidenceClass, normalizeConditions,
  normalizeFailureMode, normalizeJudgment, ensureAbstractionFields,
  ensureNovelCaseEvidence, isPrincipleLikeEntry, buildPrincipleText,
  normalizeTechLabel, buildTextSearch,
};
