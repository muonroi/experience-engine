#!/usr/bin/env node
/**
 * interceptor-prompt.js — UserPromptSubmit hook for Codex CLI
 *
 * Codex only intercepts Bash via PreToolUse. This hook fires on EVERY
 * user prompt — before Codex picks any tool — so experience warnings
 * cover all tools (rg, Search, Write, etc.), not just Bash.
 *
 * Lightweight: embeds prompt text, searches experience, returns
 * relevant warnings as additionalContext. Skips if prompt is too
 * short or looks like a greeting.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXP_DIR = path.join(os.homedir(), '.experience');
const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-prompt', ...event }) + '\n');
  } catch {}
}

// Skip trivial prompts — greetings, single words, very short
const SKIP_PATTERNS = /^(hi|hello|hey|thanks|ok|yes|no|quit|exit|help|\/\w+)\s*$/i;
const MIN_PROMPT_LENGTH = 10;

let input = '';

const t = setTimeout(() => {
  debugLog({ stage: 'timeout' });
  process.exit(0);
}, 3000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  debugLog({ stage: 'stdin_end', bytes: input.length });

  try {
    const data = JSON.parse(input || '{}');
    const hookEvent = data.hook_event_name || '';

    // Only handle UserPromptSubmit
    if (hookEvent !== 'UserPromptSubmit') {
      debugLog({ stage: 'skip', reason: 'not UserPromptSubmit', hookEvent });
      process.exit(0);
    }

    // Extract the user's prompt text
    // Codex sends: { hook_event_name, session_id, cwd, ... }
    // The prompt text location may vary — check common fields
    const prompt = data.user_prompt || data.prompt || data.message || '';
    debugLog({ stage: 'parsed', promptLen: prompt.length, preview: prompt.slice(0, 100) });

    // Skip trivial prompts
    if (!prompt || prompt.length < MIN_PROMPT_LENGTH || SKIP_PATTERNS.test(prompt.trim())) {
      debugLog({ stage: 'skip', reason: 'trivial prompt' });
      process.exit(0);
    }

    // Load experience engine
    const corePath = path.join(EXP_DIR, 'experience-core.js');
    if (!fs.existsSync(corePath)) {
      debugLog({ stage: 'skip', reason: 'experience-core.js not found' });
      process.exit(0);
    }

    const { interceptWithMeta, _activityLog: activityLog } = require(corePath);
    if (!interceptWithMeta) {
      debugLog({ stage: 'skip', reason: 'interceptWithMeta not exported' });
      process.exit(0);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      debugLog({ stage: 'abort' });
      ctrl.abort();
    }, 2500);

    // Use the prompt as the query — treat it like a generic tool call
    // This searches all experience collections for relevant warnings
    const toolInput = { command: prompt, _promptHook: true };
    const resultMeta = await interceptWithMeta('UserPrompt', toolInput, ctrl.signal);
    clearTimeout(timer);

    const suggestions = resultMeta?.suggestions || null;
    const routeInfo = resultMeta?.route || null;
    debugLog({ stage: 'done', hasSuggestions: !!suggestions, hasRoute: !!routeInfo });

    // Build output
    let outputText = '';
    if (suggestions) {
      outputText = suggestions;
    }
    if (routeInfo && routeInfo.tier) {
      const routeLine = `[Model Route] tier=${routeInfo.tier} model=${routeInfo.model || '?'} confidence=${(routeInfo.confidence || 0).toFixed(2)} source=${routeInfo.source || 'default'}`;
      outputText = outputText ? outputText + '\n---\n' + routeLine : routeLine;
    }

    if (outputText) {
      // UserPromptSubmit: plain text stdout is added as developer context.
      // This is the safest cross-version approach per Codex hooks spec.
      // Ref: https://developers.openai.com/codex/hooks
      process.stdout.write(outputText);
    }
  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error) });
  }
  process.exit(0);
});
