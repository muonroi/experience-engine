/**
 * surface-trigger.js — the shared "surface the right knowledge at the right
 * moment" layer (proposal §4). Both the prompt hook (interceptor-prompt.js) and
 * the tool hook (interceptor.js) used to duplicate the same plumbing: load
 * risk-triggers + config, check the gate flag, fetch the keyword list, run
 * detectRiskTriggers with the real repo-root resolver, take the top trigger.
 * That common flow lives here once.
 *
 * The two surfaces differ ONLY in framing (⚠️ risky vs ▶ known procedure) and in
 * whether they run a targeted recall — so the framing strings stay in the
 * callers; this module returns the structured trigger + (optionally) the recall.
 *
 * Module loading mirrors the hooks' install-dir-first, repo-local-fallback
 * lookup, and every dep is injectable so the unit tests stay pure.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');

function loadInstalled(rel) {
  try { return require(path.join(os.homedir(), '.experience', rel)); }
  catch {
    try { return require(path.join(__dirname, '..', rel)); }
    catch { return null; }
  }
}

// Resolved once at module load (same as the hooks did). Tests override via the
// `injected` param so they never depend on the operator's real install.
const _deps = {
  riskTriggers: loadInstalled('src/risk-triggers.js'),
  cfg: loadInstalled('src/config.js'),
  expRecall: loadInstalled('exp-recall.js'),
};

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`surface-trigger timeout ${ms}ms`)), ms);
      if (t && typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * Detect the top deterministic trigger for a prompt or tool action. Wraps the
 * gate-enabled check, keyword resolution, and detectRiskTriggers (with the real
 * gitRepoRootOf injected for cross-repo). PURE w.r.t. its own logic — all I/O is
 * in the injected deps.
 *
 * @returns {null} when no trigger fires, or a status object:
 *   {unavailable:true}          — risk-triggers module not synced (caller may fall back)
 *   {disabled:true}             — gate turned off via config/env
 *   {error:true}                — detectRiskTriggers threw (already logged)
 *   {top:{kind,topic,evidence}, triggers:[...]}  — at least one trigger
 */
function detectTopTrigger({ promptText = '', toolName, toolInput = {}, cwd = '' } = {}, injected = {}) {
  // 'in' check (not ||) so an explicit `null` injection forces the missing-module
  // path in tests rather than silently falling back to the real loaded dep.
  const riskTriggers = 'riskTriggers' in injected ? injected.riskTriggers : _deps.riskTriggers;
  const cfg = 'cfg' in injected ? injected.cfg : _deps.cfg;
  if (!riskTriggers || typeof riskTriggers.detectRiskTriggers !== 'function') return { unavailable: true };

  const enabled = cfg && typeof cfg.getRiskGateEnabled === 'function' ? cfg.getRiskGateEnabled() : true;
  if (!enabled) return { disabled: true };

  const keywords = cfg && typeof cfg.getRiskKeywords === 'function' ? cfg.getRiskKeywords() : undefined;
  let triggers = [];
  try {
    triggers = riskTriggers.detectRiskTriggers({
      promptText, toolName, toolInput, cwd, keywords, repoRootOf: riskTriggers.gitRepoRootOf,
    });
  } catch (err) {
    console.error(`[surface-trigger] detectRiskTriggers failed: ${err?.message}`);
    return { error: true };
  }
  if (!Array.isArray(triggers) || triggers.length === 0) return null;
  return { top: triggers[0], triggers };
}

/**
 * Run ONE bounded, fast, non-logged recall on a trigger topic — the payload the
 * prompt gate push-injects. fast:true skips the brain LLM rerank so it fits the
 * synchronous hook budget; logLocal:false keeps automatic gate recalls out of
 * the runbook-candidate stitch signal. Returns the recall result ({count,text})
 * or null on any failure (logged, never thrown).
 *
 * @param {string} topic
 * @param {string} cwd
 * @param {{timeoutMs?:number}} [opts]
 * @param {{expRecall?:object}} [injected]
 */
async function runTargetedRecall(topic, cwd, opts = {}, injected = {}) {
  const expRecall = 'expRecall' in injected ? injected.expRecall : _deps.expRecall;
  if (!expRecall || typeof expRecall.recall !== 'function') return null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 2500;
  try {
    return await _withTimeout(expRecall.recall(topic, { cwd, fast: true, logLocal: false }), timeoutMs);
  } catch (err) {
    console.error(`[surface-trigger] targeted recall failed for "${topic}": ${err?.message}`);
    return null;
  }
}

module.exports = { detectTopTrigger, runTargetedRecall, loadInstalled, _deps };
