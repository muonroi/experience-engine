#!/usr/bin/env node
'use strict';
/**
 * session-emit.js — reconstruct a Claude-shaped JSONL transcript for runtimes
 * that fire per-tool hooks but never deliver a transcript (e.g. Antigravity).
 *
 * Why this exists:
 *   Antigravity's hooks (PreToolUse/PostToolUse/UserPromptSubmit) deliver only
 *   per-event payloads — no `transcript_path`, and its conversation lives in an
 *   opaque Electron `state.vscdb` blob. So there is nothing for the EE extractor
 *   to read. This module accumulates the hook event stream into the SAME JSONL
 *   shape that `src/ee/transcript-emit.ts` (muonroi-cli) writes, so the existing
 *   `stop-extractor.js` `buildClaudeSessionData()` parser + `bulk-extract`
 *   handle it unmodified. The output lands under
 *   `~/.experience/antigravity-sessions/{sessionId}.jsonl`, which
 *   `findAllRecentSessions()` scans tagged `runtime:'antigravity'`.
 *
 * Contract: best-effort, never throws into the hook hot-path. Gated on the EE
 * opt-in (`~/.experience/config.json` present) AND `runtime === 'antigravity'`
 * so no other runtime and no fresh-clone machine is ever affected.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_BLOCK_CHARS = 8000;
const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG
  || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

function experienceRoot() { return path.join(os.homedir(), '.experience'); }
function emitRoot() { return path.join(experienceRoot(), 'antigravity-sessions'); }

// Debug-level log so a swallowed error is still diagnosable remotely without
// polluting the hook's stdout (which the agent reads as guidance). No-Silent-
// Catch rule: every catch records module + operation + err.message here.
function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'session-emit', ...event }) + '\n');
  } catch { /* debug log is itself best-effort; nothing else to do */ }
}

function isEnabled() {
  if (process.env.MUONROI_DISABLE_TRANSCRIPT_EMIT === '1') return false;
  try {
    return fs.existsSync(path.join(experienceRoot(), 'config.json'));
  } catch (err) {
    debugLog({ stage: 'isEnabled_error', message: err && err.message });
    return false;
  }
}

function clip(s) {
  const str = String(s == null ? '' : s);
  if (str.length <= MAX_BLOCK_CHARS) return str;
  return `${str.slice(0, MAX_BLOCK_CHARS)}... [truncated ${str.length - MAX_BLOCK_CHARS} chars]`;
}

function dayStampUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function sanitizeId(raw) {
  return String(raw).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

// Group events into a session file. Prefer the hook-provided session id, then
// the Antigravity env, then a deterministic per-cwd daily bucket so events
// still coalesce into one transcript when no id is supplied.
function resolveSessionId({ sessionId, cwd }) {
  if (sessionId && typeof sessionId === 'string' && sessionId.trim()) return sanitizeId(sessionId.trim());
  if (process.env.ANTIGRAVITY_SESSION_ID) return sanitizeId(process.env.ANTIGRAVITY_SESSION_ID);
  const base = cwd || process.cwd() || 'unknown';
  return `ag-${crypto.createHash('sha1').update(String(base)).digest('hex').slice(0, 12)}-${dayStampUTC()}`;
}

// Block builders mirroring exactly the shapes buildClaudeSessionData() parses:
//   { type:'text', text }            -> "User:"/"Assistant:" line
//   { type:'tool_use', name, input } -> formatToolCall() line
//   { type:'tool_result', content }  -> "ToolOutput:" line
function textBlock(text) { return { type: 'text', text: clip(text) }; }
function toolUseBlock(name, input) { return { type: 'tool_use', name: String(name || ''), input: input == null ? {} : input }; }
function toolResultBlock(content) {
  const body = typeof content === 'string' ? content : JSON.stringify(content == null ? '' : content);
  return { type: 'tool_result', content: clip(body) };
}

/**
 * Append one structured message entry to the runtime's session transcript.
 *
 * @param {object} opts
 * @param {string} opts.runtime   - must be 'antigravity' or the call is a no-op
 * @param {string|null} [opts.sessionId]
 * @param {string|null} [opts.cwd]
 * @param {'user'|'assistant'|'tool'} opts.role
 * @param {Array}  opts.blocks    - content blocks (use the *Block builders)
 * @returns {string|null} path written, or null if skipped/failed.
 */
function appendRuntimeEvent({ runtime, sessionId, cwd, role, blocks } = {}) {
  try {
    if (runtime !== 'antigravity') return null;            // scope guard — other runtimes untouched
    if (!isEnabled()) return null;                         // EE opt-in gate
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
    if (!Array.isArray(blocks) || blocks.length === 0) return null;

    const dir = emitRoot();
    fs.mkdirSync(dir, { recursive: true });
    const id = resolveSessionId({ sessionId, cwd });
    const file = path.join(dir, `${id}.jsonl`);

    // First write: session_meta head with TOP-LEVEL cwd (matches the reader in
    // findAllRecentSessions which reads `meta.cwd`).
    if (!fs.existsSync(file)) {
      const meta = { type: 'session_meta', cwd: cwd || null, runtime: 'antigravity', ts: new Date().toISOString() };
      fs.appendFileSync(file, JSON.stringify(meta) + '\n');
    }

    const entry = {
      message: { role, content: blocks },
      ts: new Date().toISOString(),
      source: 'antigravity',
      reason: 'hook-event',
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return file;
  } catch (err) {
    debugLog({ stage: 'append_error', runtime, message: err && err.message });
    return null;
  }
}

module.exports = {
  appendRuntimeEvent,
  textBlock,
  toolUseBlock,
  toolResultBlock,
  // exported for tests
  _resolveSessionId: resolveSessionId,
  _emitRoot: emitRoot,
  _isEnabled: isEnabled,
};
