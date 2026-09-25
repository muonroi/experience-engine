/**
 * tool-outcome.js — strict tool-call outcome classification for the lift experiment.
 * Zero dependencies (node:crypto only), so the hooks, the server and the tools/
 * analyzers can all share ONE definition of "this call failed".
 *
 * Why not reuse classifyOutcome / classifyPostToolOutcome (interceptor-post.js,
 * api/handlers/hooks.js): those return the legacy `toolOutcome` the LLM judge
 * reads, and they call a call an 'error' when its output merely CONTAINS
 * error|FAIL|fatal|exception in the first 500 chars — a grep for "error" that
 * finds nothing, a test run that prints "0 failed", a diff touching an
 * `exception` handler. That is fine as a soft hint to the judge; it is not an
 * outcome measure, because the experiment compares failure ratios between arms
 * and a keyword classifier's false positives scale with how much the agent reads
 * logs, not with whether it failed. So the experiment gets its own classifier that
 * trusts explicit signals only, and the legacy toolOutcome stays byte-identical.
 * See docs/specs/2026-09-25-hint-lift-and-bayesian-confidence.md §3 A0.2.
 */
'use strict';

const crypto = require('crypto');

// Claude Code: PostToolUse fires ONLY on success; failures arrive on the separate
// PostToolUseFailure event (register-hooks.js wires it with --event=failure).
const FAILURE_HOOK_EVENTS = new Set(['PostToolUseFailure']);

// Same tool family the legacy classifiers treat as "mutating" (their isMutatingTool
// regex), so the experiment's denominator is the population the judge already sees.
const MUTATING_TOOL_RE = /edit|write|bash|shell|replace|execute_command/i;

function isMutatingTool(toolName) {
  return MUTATING_TOOL_RE.test(String(toolName || ''));
}

// An exit code counts only when it is actually a number (or a string that is
// exactly one): `exit_code: "unknown"` or `exitCode: null` is no signal at all.
function numericExitCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number(value);
  return null;
}

function hasNonEmptyError(value) {
  if (value == null || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function parseStructuredString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exitCodeOf(response) {
  const direct = numericExitCode(response.exit_code ?? response.exitCode);
  if (direct !== null) return direct;
  // Codex shell output nests it: {output, metadata: {exit_code}}.
  const meta = response.metadata;
  if (meta && typeof meta === 'object') return numericExitCode(meta.exit_code ?? meta.exitCode);
  return null;
}

/**
 * Classify one tool call from explicit signals only.
 *
 * 'fail'    — failure hook event; is_error === true; interrupted === true; a
 *             numeric exit code other than 0; a non-empty `error` field.
 * 'ok'      — an explicit success signal: exit code 0, is_error === false,
 *             success === true, or a Claude Code PostToolUse (which by contract
 *             fires only on success).
 * 'unknown' — anything else. Output text is never inspected, so keyword-only
 *             output ("Error: ...") is 'unknown', never 'fail'.
 *
 * @param {{hookEvent?: string, toolName?: string, toolResponse?: any, runtime?: string}} input
 *   runtime is optional; it only enables the Claude Code success-by-contract rule.
 * @returns {'fail'|'ok'|'unknown'}
 */
function classifyToolFailure({ hookEvent, toolName: _toolName, toolResponse, runtime } = {}) {
  if (FAILURE_HOOK_EVENTS.has(String(hookEvent || ''))) return 'fail';
  let response = toolResponse;
  if (typeof response === 'string') response = parseStructuredString(response);
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (response.is_error === true) return 'fail';
    if (response.interrupted === true) return 'fail';
    const code = exitCodeOf(response);
    if (code !== null && code !== 0) return 'fail';
    if (hasNonEmptyError(response.error)) return 'fail';
    if (code === 0) return 'ok';
    if (response.is_error === false || response.success === true) return 'ok';
  }
  if (String(runtime || '') === 'claude-code' && String(hookEvent || '') === 'PostToolUse') return 'ok';
  return 'unknown';
}

// Deterministic JSON with sorted keys, so {a,b} and {b,a} hash the same.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Short stable hash of (tool, full input). Two calls share an inputHash only when
 * the agent re-ran EXACTLY the same thing — the retry-loop secondary metric
 * (>= 2 failures with the same inputHash in one session) depends on that.
 */
function inputHash(toolName, toolInput) {
  let canonical;
  try { canonical = stableStringify(toolInput ?? {}); } catch { canonical = String(toolInput); }
  return crypto.createHash('sha1').update(`${String(toolName || '')}\u0000${canonical}`).digest('hex').slice(0, 16);
}

/**
 * The runtime a hook is actually running under. The hooks' sourceRuntime field
 * cannot be used: Claude Code hooks are registered without --runtime, so their
 * sourceRuntime reads 'codex-windows'/'codex-wsl' — and sourceKind feeds payload
 * fields (confirmedSourceKinds), so it is not ours to rename. This is a separate,
 * experiment-only label.
 */
function detectHookRuntime(runtimeOverride, env = process.env) {
  if (runtimeOverride) return String(runtimeOverride).toLowerCase();
  if (env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  if (env.GEMINI_SESSION_ID || env.GEMINI_PROJECT_DIR) return 'gemini';
  if (env.CODEX_SESSION_ID) return 'codex';
  return null;
}

module.exports = {
  FAILURE_HOOK_EVENTS,
  isMutatingTool,
  classifyToolFailure,
  inputHash,
  stableStringify,
  detectHookRuntime,
};
