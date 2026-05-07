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

// P1 Item 2 — Cross-model judge consensus.
//
// Reads `judges` array from config.json:
//   { "judges": [
//       { "model": "Qwen2.5-7B", "role": "primary" },
//       { "model": "deepseek-chat", "role": "secondary",
//         "provider": "siliconflow", "endpoint": "...", "key": "..." }
//     ] }
//
// When `judges` is missing or has length <= 1, falls back to the existing
// single-judge behavior (call classifyViaBrain with no overrides). When
// length >= 2, runs all judges in parallel and only reinforces on agreement.
// Disagreements are appended to ~/.experience/judge-disagreements.jsonl.
//
// VALID_VERDICTS is parsed from a brain response; consensus is the verdict
// returned by ALL configured judges (post-normalization). UNCLEAR responses
// from individual judges are still UNCLEAR contributions — they cannot
// agree with any concrete verdict, so disagreement gates them out (safe).

function loadJudgesConfig(expDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(expDir, 'config.json'), 'utf8'));
    const judges = Array.isArray(cfg.judges) ? cfg.judges : [];
    return { judges, brainProxyUrl: cfg.brainProxyUrl || null };
  } catch {
    return { judges: [], brainProxyUrl: null };
  }
}

const DISAGREEMENT_FILE = 'judge-disagreements.jsonl';

function recordDisagreement(expDir, payload) {
  try {
    const file = path.join(expDir, DISAGREEMENT_FILE);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Call brain (via classifyViaBrain) with optional model/provider/endpoint/key
 * overrides. Falls back to brainProxyUrl when direct call returns null.
 * Returns the raw response string or null.
 */
async function callJudgeBrain({ classifyViaBrain, prompt, judgeConfig, brainProxyUrl, expDir }) {
  const overrides = judgeConfig
    ? {
        ...(judgeConfig.model ? { model: judgeConfig.model } : {}),
        ...(judgeConfig.provider ? { provider: judgeConfig.provider } : {}),
        ...(judgeConfig.endpoint ? { endpoint: judgeConfig.endpoint } : {}),
        ...(judgeConfig.key ? { key: judgeConfig.key } : {}),
      }
    : {};
  let raw = null;
  try {
    raw = await classifyViaBrain(prompt, 8000, overrides);
  } catch { /* fall through to proxy */ }
  if (raw !== null) return raw;
  if (!brainProxyUrl) return null;
  try {
    const res = await fetch(brainProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, timeoutMs: 8000, ...(judgeConfig?.model ? { model: judgeConfig.model } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const j = await res.json();
      return j.result || null;
    }
  } catch { /* swallow — best-effort */ }
  return null;
}

function normaliseVerdict(raw, validSet) {
  const word = (raw || '').trim().toUpperCase().split(/\s+/)[0];
  return validSet.has(word) ? word : 'UNCLEAR';
}

/**
 * Pure function — given an array of per-judge verdicts, returns
 * { agreed: boolean, finalVerdict: string|null }.
 *
 * Agreement requires ALL judges to return the SAME concrete verdict
 * (FOLLOWED/IGNORED/IRRELEVANT). Any UNCLEAR or any divergence => no
 * agreement. Single-judge configs always agree with themselves.
 */
function resolveConsensus(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    return { agreed: false, finalVerdict: null };
  }
  const first = verdicts[0];
  if (!first || first === 'UNCLEAR') return { agreed: false, finalVerdict: null };
  for (let i = 1; i < verdicts.length; i++) {
    if (verdicts[i] !== first) return { agreed: false, finalVerdict: null };
  }
  return { agreed: true, finalVerdict: first };
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

  // Judge each suggestion in parallel — one LLM call per suggestion (or N
  // calls when cross-model consensus is configured).
  const VALID_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT', 'UNCLEAR']);
  const action = shortAction(toolInput);
  const parsedToolInput = parseToolInputObject(toolInputObj || toolInput);

  // P1 Item 2: load judges from config. Empty/single → existing behavior.
  const { judges: judgesConfig, brainProxyUrl } = loadJudgesConfig(EXP_DIR);
  const consensusEnabled = judgesConfig.length >= 2;

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
    let perJudgeVerdicts = null; // populated only when consensusEnabled

    try {
      if (consensusEnabled) {
        // Parallel calls, one per judge. Each judge sees the same prompt; only
        // the model/endpoint/key differ.
        const verdicts = await Promise.all(judgesConfig.map(async (jc) => {
          const raw = await callJudgeBrain({ classifyViaBrain, prompt, judgeConfig: jc, brainProxyUrl, expDir: EXP_DIR });
          return normaliseVerdict(raw, VALID_VERDICTS);
        }));
        perJudgeVerdicts = judgesConfig.map((jc, i) => ({
          role: jc.role || (i === 0 ? 'primary' : `judge-${i}`),
          model: jc.model || null,
          verdict: verdicts[i],
        }));
        const { agreed, finalVerdict } = resolveConsensus(verdicts);
        verdict = agreed ? finalVerdict : 'UNCLEAR';
        if (activityLog) {
          activityLog({
            op: 'judge-consensus',
            tool: toolName,
            action,
            collection,
            pointId: id.slice(0, 8),
            agreed,
            verdicts: perJudgeVerdicts,
            finalVerdict: agreed ? finalVerdict : null,
            toolOutcome,
          });
        }
        if (!agreed) {
          recordDisagreement(EXP_DIR, {
            tool: toolName,
            action,
            collection,
            pointId: id.slice(0, 8),
            verdicts: perJudgeVerdicts,
            toolOutcome,
            solution: String(solution).slice(0, 200),
          });
        }
      } else {
        // Single-judge path: identical to pre-P1 behavior.
        const raw = await callJudgeBrain({ classifyViaBrain, prompt, judgeConfig: null, brainProxyUrl, expDir: EXP_DIR });
        verdict = normaliseVerdict(raw, VALID_VERDICTS);
      }
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
    // P1 Item 2 exports
    loadJudgesConfig,
    callJudgeBrain,
    normaliseVerdict,
    resolveConsensus,
    recordDisagreement,
  };
}
