#!/usr/bin/env node
'use strict';
/**
 * interceptor-post.js — PostToolUse hook for Experience Engine feedback loop
 *
 * Strategy: Async LLM judge (judge-worker.js) evaluates whether the agent followed
 * each surfaced hint. PostToolUse writes a queue file and spawns the judge worker
 * detached — zero latency impact on agent flow.
 *
 * Flow:
 *   1. Orphan cleanup — delete stale judge-*.json files older than 60s
 *   2. Read last-suggestions.json (written by PreToolUse interceptor.js)
 *   3. Stale check (10s window)
 *   4. Write judge-{ts}.json queue file (~1ms)
 *   5. Spawn judge-worker.js detached + unref (~1ms)
 *   6. Delete last-suggestions.json
 *   7. Exit (total added latency ~3ms, no inline LLM call)
 *
 * Register in ~/.claude/settings.json:
 *   PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ command: "node ~/.experience/interceptor-post.js" }] }]
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXP_DIR    = path.join(os.homedir(), '.experience');
const TMP_DIR    = path.join(EXP_DIR, 'tmp');
const STATE_FILE = path.join(TMP_DIR, 'last-suggestions.json');
const DEBUG_LOG  = process.env.EXPERIENCE_HOOK_DEBUG_LOG
  || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

const STALE_MS   = 10_000;
const ORPHAN_TTL = 60_000;

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-post', ...event }) + '\n');
  } catch {}
}

/**
 * Classify tool outcome for hybrid signal in judge queue.
 * Kept here so judge-worker can record toolOutcome without needing outcome logic.
 *
 * @returns {'error'|'success'|null}
 */
function classifyOutcome(toolName, toolInput, toolOutput) {
  const tool = (toolName || '').toLowerCase();
  const isMutatingTool = /edit|write|bash|shell|replace|execute_command/i.test(tool);
  if (!isMutatingTool) return null;

  const hasError = !!(
    toolOutput?.error ||
    toolOutput?.is_error ||
    (typeof toolOutput === 'string' && /^error:/i.test(toolOutput)) ||
    (toolOutput?.output && /error|Error|ERROR|FAIL|fatal|exception/i.test(String(toolOutput.output).slice(0, 500)))
  );

  const exitCode = toolOutput?.exit_code ?? toolOutput?.exitCode ?? null;
  if (exitCode !== null && exitCode !== 0) return 'error';

  if (hasError) return 'error';
  return 'success';
}

const t = setTimeout(() => {
  debugLog({ stage: 'timeout_waiting_for_stdin' });
  process.exit(0);
}, 3000);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  debugLog({ stage: 'stdin_end', bytes: input.length });

  try {
    // --- Step 1: Orphan cleanup — delete judge-*.json files older than 60s ---
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const cutoff = Date.now() - ORPHAN_TTL;
      for (const f of fs.readdirSync(TMP_DIR)) {
        if (f.startsWith('judge-') && f.endsWith('.json')) {
          const fp = path.join(TMP_DIR, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
          } catch { /* skip individual file errors */ }
        }
      }
    } catch { /* tmp dir may not exist yet */ }

    // --- Step 2: Read last-suggestions.json ---
    let state;
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      state = JSON.parse(raw);
    } catch {
      debugLog({ stage: 'no_state_file' });
      process.exit(0);
    }

    // --- Step 3: Stale check ---
    const ageMs = Date.now() - new Date(state.ts).getTime();
    if (ageMs > STALE_MS) {
      debugLog({ stage: 'stale_state', ageMs });
      try { fs.unlinkSync(STATE_FILE); } catch {}
      process.exit(0);
    }

    const surfacedIds = state.surfacedIds || [];
    if (surfacedIds.length === 0) {
      debugLog({ stage: 'no_surfaced_ids' });
      try { fs.unlinkSync(STATE_FILE); } catch {}
      process.exit(0);
    }

    // Parse PostToolUse input
    let data;
    try { data = JSON.parse(input || '{}'); } catch { data = {}; }

    const toolName   = data.tool_name  || data.toolName  || '';
    const toolInput  = data.tool_input || data.input     || {};
    const toolOutput = data.tool_response || data.output || data.result || {};
    debugLog({ stage: 'parsed', tool: toolName, surfacedCount: surfacedIds.length });

    // --- Step 4: Write judge queue file ---
    const queueFile = path.join(TMP_DIR, `judge-${Date.now()}.json`);
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(queueFile, JSON.stringify({
        ts:          new Date().toISOString(),
        surfacedIds,
        toolName,
        toolInput:   JSON.stringify(toolInput || {}).slice(0, 300),
        toolOutcome: classifyOutcome(toolName, toolInput, toolOutput),
      }));

      // --- Step 5: Spawn judge-worker detached + unref ---
      const workerPath = path.join(EXP_DIR, 'judge-worker.js');
      const worker = require('child_process').spawn(
        process.execPath,
        [workerPath, queueFile],
        { detached: true, stdio: 'ignore' }
      );
      worker.unref(); // parent exits immediately, worker continues in background

      debugLog({ stage: 'judge_spawned', queueFile, surfacedCount: surfacedIds.length });
    } catch (spawnErr) {
      // Spawn failure must never block PostToolUse
      debugLog({ stage: 'spawn_error', message: spawnErr?.message });
    }

    // --- Step 6: Delete last-suggestions.json ---
    try { fs.unlinkSync(STATE_FILE); } catch {}
    debugLog({ stage: 'done', processed: surfacedIds.length });

  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error) });
  }

  process.exit(0);
});
