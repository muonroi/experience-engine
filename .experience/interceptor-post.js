#!/usr/bin/env node
'use strict';
/**
 * interceptor-post.js — PostToolUse hook for Experience Engine feedback loop
 *
 * Strategy B: Outcome-based feedback (complemented by Strategy A: agent self-report via POST /api/feedback).
 *
 * Instead of guessing whether the agent "followed" a hint via keyword matching (unreliable),
 * we observe the OUTCOME of the tool call after a hint was surfaced:
 *
 *   - Tool ERRORED right after hint was shown → hint was relevant, agent likely ignored it
 *     → record followed=false (boost hint confidence)
 *   - Tool SUCCEEDED → neutral, can't determine causation
 *     → record followed=true (mild positive signal — hint didn't hurt)
 *   - Agent explicitly told user "ignoring this hint" → Strategy A covers this
 *     (agent calls POST /api/feedback directly)
 *
 * This is conservative: we only penalize on clear negative signal (error after hint),
 * and give mild positive on success. Strategy A (agent self-report) provides the precise signal.
 *
 * Register in ~/.claude/settings.json:
 *   PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ command: "node ~/.experience/interceptor-post.js" }] }]
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STATE_FILE = path.join(os.homedir(), '.experience', 'tmp', 'last-suggestions.json');
const DEBUG_LOG  = process.env.EXPERIENCE_HOOK_DEBUG_LOG
  || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

const STALE_MS = 10_000;

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-post', ...event }) + '\n');
  } catch {}
}

/**
 * Outcome-based feedback: observe tool result, not content.
 *
 * @param {object} toolOutput - PostToolUse output/result
 * @returns {'error'|'success'|null} - error = hint was relevant and ignored, success = neutral positive, null = can't determine
 */
function classifyOutcome(toolName, toolInput, toolOutput) {
  const tool = (toolName || '').toLowerCase();
  const isMutatingTool = /edit|write|bash|shell|replace|execute_command/i.test(tool);
  if (!isMutatingTool) return null;

  // Check for error signals in tool output
  const hasError = !!(
    toolOutput?.error ||
    toolOutput?.is_error ||
    (typeof toolOutput === 'string' && /^error:/i.test(toolOutput)) ||
    (toolOutput?.output && /error|Error|ERROR|FAIL|fatal|exception/i.test(String(toolOutput.output).slice(0, 500)))
  );

  // For Bash: also check exit code
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
    // Load state file written by PreToolUse hook
    let state;
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      state = JSON.parse(raw);
    } catch {
      debugLog({ stage: 'no_state_file' });
      process.exit(0);
    }

    // Stale check
    const ageMs = Date.now() - new Date(state.ts).getTime();
    if (ageMs > STALE_MS) {
      debugLog({ stage: 'stale_state', ageMs });
      try { fs.unlinkSync(STATE_FILE); } catch {}
      process.exit(0);
    }

    const surfacedIds = state.surfacedIds || [];
    if (surfacedIds.length === 0) {
      debugLog({ stage: 'no_surfaced_ids' });
      process.exit(0);
    }

    // Parse PostToolUse input
    let data;
    try { data = JSON.parse(input || '{}'); } catch { data = {}; }

    const toolName   = data.tool_name  || data.toolName  || '';
    const toolInput  = data.tool_input || data.input     || {};
    const toolOutput = data.tool_response || data.output || data.result || {};
    debugLog({ stage: 'parsed', tool: toolName, surfacedCount: surfacedIds.length });

    // Classify outcome
    const outcome = classifyOutcome(toolName, toolInput, toolOutput);
    if (outcome === null) {
      debugLog({ stage: 'unclassifiable_outcome' });
      try { fs.unlinkSync(STATE_FILE); } catch {}
      process.exit(0);
    }

    // Load recordFeedback from experience-core
    const { recordFeedback } = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
    if (typeof recordFeedback !== 'function') {
      debugLog({ stage: 'no_recordFeedback' });
      process.exit(0);
    }

    // Record feedback for each surfaced suggestion based on outcome:
    // - error → followed=false (hint was relevant, agent ignored it → boost hint)
    // - success → followed=true (mild positive — hint didn't cause problems)
    const followed = outcome === 'success';
    const feedbackPromises = [];
    for (const suggestion of surfacedIds) {
      if (!suggestion.collection || !suggestion.id) continue;
      debugLog({ stage: 'record_feedback', id: suggestion.id, collection: suggestion.collection, outcome, followed });
      feedbackPromises.push(
        recordFeedback(suggestion.collection, suggestion.id, followed).catch(err => {
          debugLog({ stage: 'feedback_error', id: suggestion.id, error: err?.message });
        })
      );
    }

    // Wait up to 400ms for all feedback calls
    await Promise.race([
      Promise.all(feedbackPromises),
      new Promise(resolve => setTimeout(resolve, 400)),
    ]);

    // Clean up state file
    try { fs.unlinkSync(STATE_FILE); } catch {}
    debugLog({ stage: 'done', outcome, processed: surfacedIds.length });

  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error) });
  }

  process.exit(0);
});
