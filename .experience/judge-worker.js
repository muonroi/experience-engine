#!/usr/bin/env node
'use strict';
/**
 * judge-worker.js — detached LLM judge for experience feedback
 *
 * Called by interceptor-post.js via:
 *   spawn(process.execPath, [__filename, queueFile], { detached: true, stdio: 'ignore' })
 *
 * Reads a queue JSON file, calls classifyViaBrain() for each surfaced suggestion,
 * records feedback via recordFeedback(), then deletes the queue file.
 *
 * All errors are swallowed — a crashing judge must never affect agent flow.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXP_DIR   = path.join(os.homedir(), '.experience');
const queueFile = process.argv[2];
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);

function shortAction(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseToolInputObject(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function inferLanguageMismatch(surface, actionDomain) {
  const scopeLang = String(surface?.scope?.lang || '').toLowerCase();
  const hintDomain = String(surface?.domain || '').toLowerCase();
  const normalizedAction = String(actionDomain || '').toLowerCase();
  if (!normalizedAction) return false;
  if (scopeLang === 'all') return false;
  if (scopeLang && normalizedAction && !normalizedAction.startsWith(scopeLang) && !scopeLang.startsWith(normalizedAction)) {
    return true;
  }
  if (!scopeLang && hintDomain && normalizedAction && !hintDomain.startsWith(normalizedAction) && !normalizedAction.startsWith(hintDomain)) {
    return true;
  }
  return false;
}

function inferNoiseReason(surface, toolInputObj, helperFns) {
  const { extractProjectPath, extractProjectSlug, detectContext } = helperFns;
  const extractedPath = typeof extractProjectPath === 'function' ? extractProjectPath(toolInputObj || {}) : null;
  const actionProject = typeof extractProjectSlug === 'function' ? extractProjectSlug(extractedPath || '') : null;
  const actionDomain = typeof detectContext === 'function' ? detectContext(extractedPath || '') : null;

  if (surface?.projectSlug && actionProject && surface.projectSlug !== actionProject) {
    return 'wrong_repo';
  }
  if (inferLanguageMismatch(surface, actionDomain)) {
    return 'wrong_language';
  }

  const createdAt = surface?.createdAt ? new Date(surface.createdAt).getTime() : 0;
  const lastHitAt = surface?.lastHitAt ? new Date(surface.lastHitAt).getTime() : 0;
  const ageDays = createdAt ? (Date.now() - createdAt) / 86400000 : 0;
  const lastHitDays = lastHitAt ? (Date.now() - lastHitAt) / 86400000 : ageDays;
  if (surface?.superseded || (ageDays > 180 && lastHitDays > 90 && (surface?.hitCount || 0) <= 1)) {
    return 'stale_rule';
  }
  return 'wrong_task';
}

function isDeterministicNoiseReason(reason) {
  return reason === 'wrong_repo' || reason === 'wrong_language' || reason === 'wrong_task' || reason === 'stale_rule';
}

function applyDeterministicAssessment(verdict, toolOutcome, assessment) {
  if (verdict !== 'UNCLEAR') return verdict;
  if (assessment?.touched) {
    return toolOutcome === 'error' ? 'IGNORED' : 'FOLLOWED';
  }
  if (isDeterministicNoiseReason(assessment?.reason)) {
    return 'IRRELEVANT';
  }
  return 'UNCLEAR';
}

function resolveUnclearFallback(verdict, toolOutcome, assessment) {
  const assessed = applyDeterministicAssessment(verdict, toolOutcome, assessment);
  if (assessed !== 'UNCLEAR') return assessed;
  return 'UNCLEAR';
}

// Validate path to prevent path traversal (T-b3s-01)
// Must reside inside ~/.experience/tmp/ and match judge-*.json pattern
const tmpDir     = path.join(EXP_DIR, 'tmp');
function resolveQueueFilePath(candidate) {
  if (!candidate) return null;
  const normalised = path.resolve(candidate);
  if (!normalised.startsWith(path.resolve(tmpDir) + path.sep) &&
      normalised !== path.resolve(tmpDir)) {
    return null;
  }
  const basename = path.basename(normalised);
  if (!/^judge-\d+\.json$/.test(basename)) return null;
  if (!fs.existsSync(normalised)) return null;
  return normalised;
}

async function main() {
  const normalised = resolveQueueFilePath(queueFile);
  if (!normalised) process.exit(0);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(normalised, 'utf8'));
  } catch {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  const { surfacedIds = [], toolName = '', toolInput = '', toolInputObj = {}, toolOutcome = null } = data;

  // Load core functions from experience-core.js
  let classifyViaBrain, recordJudgeFeedback, activityLog, extractProjectPath, extractProjectSlug, detectContext, assessHintUsage;
  try {
    const core = require(path.join(EXP_DIR, 'experience-core.js'));
    classifyViaBrain    = core.classifyViaBrain;
    recordJudgeFeedback = core.recordJudgeFeedback;
    activityLog         = typeof core._activityLog === 'function' ? core._activityLog : null;
    extractProjectPath  = core._extractProjectPath;
    extractProjectSlug  = core._extractProjectSlug;
    detectContext       = core._detectContext;
    assessHintUsage     = core._assessHintUsage;
  } catch {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  if (typeof classifyViaBrain !== 'function' || typeof recordJudgeFeedback !== 'function') {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  // Judge each suggestion in parallel — one LLM call per suggestion
  const VALID_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT', 'UNCLEAR']);
  const action = shortAction(toolInput);
  const parsedToolInput = parseToolInputObject(toolInputObj || toolInput);

  await Promise.allSettled(surfacedIds.map(async (surface) => {
    const { collection, id, solution } = surface || {};
    if (!solution || !id || !collection) return;

    const prompt =
      `HINT: ${solution}\nTOOL: ${toolName}\nACTION: ${toolInput || ''}\n\n` +
      `Classify this interaction. Reply with exactly one word.\n\n` +
      `FOLLOWED — the action directly applies what the hint recommends\n` +
      `IGNORED — the hint IS relevant to this action but the agent did the opposite\n` +
      `IRRELEVANT — the hint has NOTHING to do with this action (wrong language, wrong tool, unrelated task like git/deploy/docs)\n` +
      `UNCLEAR — cannot determine\n\n` +
      `Examples:\n` +
      `- HINT about C# code + ACTION edits .cs file following hint → FOLLOWED\n` +
      `- HINT about C# code + ACTION edits .cs file ignoring hint → IGNORED\n` +
      `- HINT about C# code + ACTION runs "git status" → IRRELEVANT\n` +
      `- HINT about library code + ACTION edits docs/config/deploy → IRRELEVANT\n` +
      `- HINT about C# code + ACTION edits STATE.md / PLAN.md / README.md → IRRELEVANT\n` +
      `- HINT about logging code + ACTION runs git commit, deploy script, or edits .yml/.sh → IRRELEVANT\n` +
      `- HINT about TypeScript code + ACTION writes JSON config or edits docker-compose → IRRELEVANT\n` +
      `Rule: if the hint's language/framework/pattern has NOTHING to do with what the action modifies → IRRELEVANT\n\n` +
      `Your answer (one word):`;

    let verdict = 'UNCLEAR';
    try {
      let raw = await classifyViaBrain(prompt, 8000);
      // Fallback: if direct brain call returns null, try VPS brain proxy
      if (raw === null) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(EXP_DIR, 'config.json'), 'utf8'));
          const proxyUrl = cfg.brainProxyUrl; // e.g. "http://72.61.127.154:8082/api/brain"
          if (proxyUrl) {
            const res = await fetch(proxyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt, timeoutMs: 8000 }),
              signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
              const j = await res.json();
              raw = j.result || null;
            }
          }
        } catch { /* proxy fallback best-effort */ }
      }
      const word = (raw || '').trim().toUpperCase().split(/\s+/)[0];
      if (VALID_VERDICTS.has(word)) verdict = word;
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : 'unreachable';
      if (activityLog) {
        activityLog({
          op: 'judge-brain-error',
          tool: toolName,
          action,
          collection,
          pointId: id.slice(0, 8),
          reason,
          verdict: 'UNCLEAR',
          toolOutcome,
        });
      }
    }

    let deterministicAssessment = null;
    if (verdict === 'UNCLEAR' && typeof assessHintUsage === 'function') {
      try {
        deterministicAssessment = assessHintUsage(surface, toolName, parsedToolInput, {});
      } catch { /* stay UNCLEAR */ }
    }
    verdict = resolveUnclearFallback(verdict, toolOutcome, deterministicAssessment);
    const noiseReason = verdict === 'IRRELEVANT'
      ? (isDeterministicNoiseReason(deterministicAssessment?.reason)
          ? deterministicAssessment.reason
          : inferNoiseReason(surface, parsedToolInput, { extractProjectPath, extractProjectSlug, detectContext }))
      : null;

    // UNCLEAR → no feedback (neutral), but log for diagnostics
    if (verdict === 'UNCLEAR') {
      if (activityLog) {
        activityLog({
          op: 'judge-skipped',
          tool: toolName,
          action,
          collection,
          pointId: id.slice(0, 8),
          reason: 'unclear',
          toolOutcome,
        });
      }
      return;
    }

    try {
      if (activityLog) {
        activityLog({
          op: 'judge-verdict',
          tool: toolName,
          action,
          collection,
          pointId: id.slice(0, 8),
          verdict,
          ...(noiseReason && VALID_NOISE_REASONS.has(noiseReason) ? { reason: noiseReason } : {}),
          toolOutcome,
        });
      }
      await recordJudgeFeedback(collection, id, verdict, noiseReason);
    } catch {
      // Ignore — feedback failure must not crash worker
    }
  }));

  try { fs.unlinkSync(normalised); } catch {}
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
} else {
  module.exports = {
    inferLanguageMismatch,
    inferNoiseReason,
    isDeterministicNoiseReason,
    applyDeterministicAssessment,
    resolveUnclearFallback,
    resolveQueueFilePath,
  };
}
