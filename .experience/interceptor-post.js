#!/usr/bin/env node
'use strict';
/**
 * interceptor-post.js — PostToolUse hook for Experience Engine feedback loop
 *
 * Reads last-suggestions state written by the PreToolUse hook, then heuristically
 * detects whether the agent followed or ignored each surfaced hint by comparing the
 * tool output/new content against key terms from the suggestion's solution text.
 *
 * Calls recordFeedback(collection, pointId, followed) for each surfaced point.
 * Total budget: <500ms. Non-blocking — exits cleanly on any error.
 *
 * Register in ~/.claude/settings.json as a PostToolUse hook:
 *   { "hooks": { "PostToolUse": [{ "command": "node ~/.experience/interceptor-post.js" }] } }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STATE_FILE = path.join(os.homedir(), '.experience', 'tmp', 'last-suggestions.json');
const DEBUG_LOG  = process.env.EXPERIENCE_HOOK_DEBUG_LOG
  || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

// Stale threshold: 30 seconds
const STALE_MS = 30_000;

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-post', ...event }) + '\n');
  } catch {}
}

/** Extract meaningful keywords from a solution string for heuristic matching. */
function extractKeyTerms(solution) {
  if (!solution) return [];
  // Remove common filler words, keep substantive tokens ≥4 chars
  const stop = new Set(['this', 'that', 'with', 'when', 'from', 'into', 'over', 'then', 'will', 'also', 'have', 'been', 'your', 'they', 'does', 'not', 'use', 'the', 'and', 'for', 'are', 'all']);
  return solution
    .toLowerCase()
    .replace(/[^a-z0-9\s_/-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !stop.has(t))
    .slice(0, 6); // top 6 terms
}

/**
 * Heuristic: did the agent follow the suggestion?
 * Returns true/false/null (null = inconclusive, skip).
 */
function didFollow(suggestion, toolName, toolInput, toolOutput) {
  const solution = suggestion.solution || '';
  if (!solution) return null;

  const tool = (toolName || '').toLowerCase();
  const isMutatingTool = /edit|write|bash|shell|replace|execute_command/i.test(tool);
  if (!isMutatingTool) return null;

  // If tool errored, can't determine
  if (toolOutput?.error || toolOutput?.is_error) return null;

  const keyTerms = extractKeyTerms(solution);
  if (keyTerms.length === 0) return null;

  // Gather content to check: new_string (Edit), content (Write), output (Bash)
  const contentToCheck = [
    toolInput?.new_string || '',
    toolInput?.content    || '',
    toolInput?.command    || '',
    typeof toolOutput === 'string' ? toolOutput : '',
    toolOutput?.output   || toolOutput?.stdout || '',
  ].join('\n').toLowerCase();

  if (!contentToCheck.trim()) return null;

  // Count how many key terms appear in the written content
  const matchCount = keyTerms.filter(t => contentToCheck.includes(t)).length;
  const matchRatio = matchCount / keyTerms.length;

  // >50% match → likely followed; <20% match → likely ignored
  if (matchRatio > 0.5) return true;
  if (matchRatio < 0.2) return false;
  return null; // inconclusive
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

    // Load recordFeedback from experience-core
    const { recordFeedback } = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
    if (typeof recordFeedback !== 'function') {
      debugLog({ stage: 'no_recordFeedback' });
      process.exit(0);
    }

    // Process each surfaced suggestion
    const feedbackPromises = [];
    for (const suggestion of surfacedIds) {
      const followed = didFollow(suggestion, toolName, toolInput, toolOutput);
      if (followed === null) {
        debugLog({ stage: 'inconclusive', id: suggestion.id });
        continue;
      }
      debugLog({ stage: 'record_feedback', id: suggestion.id, collection: suggestion.collection, followed });
      feedbackPromises.push(
        recordFeedback(suggestion.collection, suggestion.id, followed ? 'followed' : 'ignored').catch(err => {
          debugLog({ stage: 'feedback_error', id: suggestion.id, error: err?.message });
        })
      );
    }

    // Wait up to 400ms for all feedback calls
    await Promise.race([
      Promise.all(feedbackPromises),
      new Promise(resolve => setTimeout(resolve, 400)),
    ]);

    // Clean up state file after processing
    try { fs.unlinkSync(STATE_FILE); } catch {}
    debugLog({ stage: 'done', processed: surfacedIds.length });

  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error) });
  }

  process.exit(0);
});
