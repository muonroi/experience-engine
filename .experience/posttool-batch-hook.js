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

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(buf), 500);
  });
}

(async () => {
  const raw = await readStdin();
  if (!raw) { debugLog({ stage: 'no_stdin' }); process.exit(0); }

  let payload;
  try { payload = JSON.parse(raw); } catch { debugLog({ stage: 'parse_error' }); process.exit(0); }

  const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
  if (toolCalls.length === 0) { debugLog({ stage: 'empty_batch' }); process.exit(0); }

  const cfg = loadConfig();
  const baseUrl = (cfg.serverBaseUrl || cfg.server?.baseUrl || 'http://localhost:8082').replace(/\/$/, '');
  const authToken = cfg.serverAuthToken || cfg.server?.authToken || '';

  const firstWithFile = toolCalls.find((t) => t?.tool_input?.file_path);
  const reprFilePath = firstWithFile?.tool_input?.file_path || null;

  const body = {
    tools: toolCalls.map((t) => ({
      tool_name: t.tool_name,
      tool_input: t.tool_input,
      tool_response_excerpt: typeof t.tool_response === 'string'
        ? t.tool_response.slice(0, 400)
        : (t.tool_response ? JSON.stringify(t.tool_response).slice(0, 400) : ''),
    })),
    cwd: payload.cwd || process.cwd(),
    representativeFilePath: reprFilePath,
    sessionId: payload.session_id || null,
    sourceKind: 'hook',
    sourceRuntime: 'claude-code',
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(`${baseUrl}/api/posttool-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) { debugLog({ stage: 'http_error', status: resp.status }); process.exit(0); }
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
  process.exit(0);
})();
