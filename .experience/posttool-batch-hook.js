#!/usr/bin/env node
'use strict';
/**
 * posttool-batch-hook.js — PostToolBatch hook for Experience Engine
 *
 * Fires after a full batch of parallel tool calls resolves, before the next
 * model call. Aggregates the batch into a single intercept query so the brain
 * can surface reflection-style hints that only emerge when looking across the
 * whole batch (e.g. "you edited 5 TS files then ran failing tests — common
 * mistake is X").
 *
 * Complements per-tool PostToolUse (which judges hint usage per-tool). This
 * hook is fire-and-forget for the brain query side, but it DOES print to
 * stdout — Claude Code injects stdout as system message before next model call.
 *
 * Register in ~/.claude/settings.json:
 *   PostToolBatch: [{ hooks: [{ type: "command", command: "node ~/.experience/posttool-batch-hook.js" }] }]
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXP_DIR  = path.join(os.homedir(), '.experience');
const CFG_PATH = path.join(EXP_DIR, 'config.json');
const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG
  || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

const TIMEOUT_MS = 1500;

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'posttool-batch', ...event }) + '\n');
  } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}

// ── Exit discipline (Windows libuv safety) ─────────────────────────────────
// NEVER call process.exit() on the main path. The fetch below uses an undici
// keep-alive socket; calling process.exit() while that socket (or the stdin
// handle) is mid-teardown trips a libuv assertion on Windows
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c:76) and crashes the
// hook child. Instead set process.exitCode and let the event loop drain so the
// socket/stdin handles close on their own. We also send `Connection: close`
// (same fix as remote-client.js) so the socket never lingers in the pool.
// process.exit() survives ONLY in the watchdog timers, which fire only when
// stdin never closes (no socket in flight at that point).
const t = setTimeout(() => {
  debugLog({ stage: 'timeout_waiting_for_stdin' });
  process.exit(0);
}, 3000);
const hardExit = setTimeout(() => {
  debugLog({ stage: 'hard_exit' });
  process.exit(0);
}, 5000);
hardExit.unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('error', () => { clearTimeout(t); process.exitCode = 0; });
process.stdin.on('end', async () => {
  clearTimeout(t);

  if (!raw) { debugLog({ stage: 'no_stdin' }); process.exitCode = 0; return; }

  let payload;
  try { payload = JSON.parse(raw); } catch { debugLog({ stage: 'parse_error' }); process.exitCode = 0; return; }

  const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
  if (toolCalls.length === 0) { debugLog({ stage: 'empty_batch' }); process.exitCode = 0; return; }

  const cfg = loadConfig();
  const baseUrl = (cfg.serverBaseUrl || cfg.server?.baseUrl || 'http://localhost:8082').replace(/\/$/, '');
  const authToken = cfg.serverAuthToken || cfg.server?.authToken || '';

  const firstWithFile = toolCalls.find((tc) => tc?.tool_input?.file_path);
  const reprFilePath = firstWithFile?.tool_input?.file_path || null;

  const body = {
    tools: toolCalls.map((tc) => ({
      tool_name: tc.tool_name,
      tool_input: tc.tool_input,
      tool_response_excerpt: typeof tc.tool_response === 'string'
        ? tc.tool_response.slice(0, 400)
        : (tc.tool_response ? JSON.stringify(tc.tool_response).slice(0, 400) : ''),
    })),
    cwd: payload.cwd || process.cwd(),
    representativeFilePath: reprFilePath,
    sessionId: payload.session_id || null,
    sourceKind: 'hook',
    sourceRuntime: 'claude-code',
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(`${baseUrl}/api/posttool-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Close the socket per-request so undici keep-alive pooling can't leave
        // one tearing down at exit (Windows libuv async.c:76 assertion).
        Connection: 'close',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      debugLog({ stage: 'http_error', status: resp.status });
      process.exitCode = 0;
      return;
    }
    const data = await resp.json();
    if (data?.hint && typeof data.hint === 'string') {
      process.stdout.write(data.hint);
      debugLog({ stage: 'hint_emitted', batchSize: toolCalls.length, hintBytes: data.hint.length });
    } else {
      debugLog({ stage: 'no_hint', batchSize: toolCalls.length });
    }
  } catch (err) {
    debugLog({ stage: 'error', message: err?.message || String(err) });
  }

  process.exitCode = 0;
});
