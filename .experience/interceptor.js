#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { intercept } = require(path.join(os.homedir(), '.experience', 'experience-core.js'));

const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');
let input = '';

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor', ...event }) + '\n');
  } catch {}
}

function activityLog(event) {
  try {
    const core = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
    if (typeof core._activityLog === 'function') {
      core._activityLog({ op: 'hook', hook: 'interceptor', ...event });
    }
  } catch {}
}

function buildSourceMeta(data) {
  const runtime = process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows';
  return {
    sourceKind: 'codex-hook',
    sourceRuntime: runtime,
    // Codex hook payload reliably includes session_id; CODEX_SESSION_ID is
    // not guaranteed to be present in the hook subprocess environment.
    sourceSession: data.session_id || process.env.CODEX_SESSION_ID || null,
  };
}

function isCodexHookInvocation(data, tool) {
  const hookEvent = data?.hook_event_name || '';
  if (process.env.CODEX_SESSION_ID) return true;
  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse' || hookEvent === 'UserPromptSubmit' || hookEvent === 'Stop') {
    return true;
  }
  if ((data?.tool_use_id || data?.turn_id) && String(tool || '') === 'Bash') {
    return true;
  }
  return false;
}

const t = setTimeout(() => {
  debugLog({ stage: 'timeout_waiting_for_stdin' });
  process.exit(0);
}, 3000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  debugLog({ stage: 'stdin_end', bytes: input.length });
  activityLog({ stage: 'stdin_end', bytes: input.length });
  try {
    const data = JSON.parse(input || '{}');
    const tool = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.input || {};
    const sourceMeta = buildSourceMeta(data);
    const matches = /Edit|Write|Bash|shell|replace|write_file|execute_command/i.test(tool);
    debugLog({ stage: 'parsed', tool, matches, keys: Object.keys(toolInput || {}).slice(0, 12), ...sourceMeta });
    activityLog({ stage: 'parsed', tool, matches, keys: Object.keys(toolInput || {}).slice(0, 12), query: toolInput?.command || toolInput?.cmd || null, ...sourceMeta });
    if (!matches) process.exit(0);

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      debugLog({ stage: 'intercept_abort', tool });
      activityLog({ stage: 'intercept_abort', tool, ...sourceMeta });
      ctrl.abort();
    }, 2500);

    const resultMeta = await (async () => {
      // Use interceptWithMeta to get surfacedIds + route alongside suggestions
      const { interceptWithMeta: interceptMeta } = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
      if (interceptMeta) return interceptMeta(tool, toolInput, ctrl.signal, sourceMeta);
      return { suggestions: await intercept(tool, toolInput, ctrl.signal, sourceMeta), surfacedIds: [], route: null };
    })();
    clearTimeout(timer);
    const result = resultMeta?.suggestions ?? (typeof resultMeta === 'string' ? resultMeta : null);
    const surfacedIds = resultMeta?.surfacedIds || [];
    const routeInfo = resultMeta?.route || null;
    debugLog({ stage: 'intercept_done', tool, hasResult: !!result, surfacedCount: surfacedIds.length, preview: typeof result === 'string' ? result.slice(0, 240) : null, ...sourceMeta });
    activityLog({
      stage: 'intercept_done',
      tool,
      hasResult: !!result,
      surfacedCount: surfacedIds.length,
      surfaced: surfacedIds.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
      routeTier: routeInfo?.tier || null,
      routeModel: routeInfo?.model || null,
      routeSource: routeInfo?.source || null,
      preview: typeof result === 'string' ? result.slice(0, 240) : null,
      ...sourceMeta
    });

    // Write last-suggestions state for PostToolUse hook
    if (result && surfacedIds.length > 0) {
      try {
        const tmpDir = path.join(os.homedir(), '.experience', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const state = { ts: new Date().toISOString(), tool, surfacedIds };
        fs.writeFileSync(path.join(tmpDir, 'last-suggestions.json'), JSON.stringify(state, null, 2), 'utf8');
        activityLog({
          stage: 'state_written',
          tool,
          stateFile: 'last-suggestions.json',
          surfacedCount: surfacedIds.length,
          surfaced: surfacedIds.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
          ...sourceMeta
        });
      } catch {}
    }

    // Write route decision for consumers (GSD, external tools)
    if (routeInfo) {
      try {
        const tmpDir = path.join(os.homedir(), '.experience', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'last-route.json'), JSON.stringify({ ts: new Date().toISOString(), ...routeInfo }, null, 2), 'utf8');
        activityLog({
          stage: 'route_written',
          tool,
          routeTier: routeInfo?.tier || null,
          routeModel: routeInfo?.model || null,
          routeSource: routeInfo?.source || null,
          ...sourceMeta
        });
      } catch {}
    }

    if (result || routeInfo) {
      // Detect CLI from tool name pattern or env vars
      const isGemini = !!(process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR)
        || /^(run_shell_command|write_file|edit_file|replace_in_file)$/.test(tool);
      const isCodex = !isGemini && isCodexHookInvocation(data, tool);

      // Build output text: experience suggestions + optional route advisory
      let outputText = result || '';
      if (routeInfo && routeInfo.tier) {
        const routeLine = `\n[Model Route] tier=${routeInfo.tier} model=${routeInfo.model || '?'} confidence=${(routeInfo.confidence || 0).toFixed(2)} source=${routeInfo.source || 'default'}`;
        outputText = outputText ? outputText + '\n---\n' + routeLine : routeLine;
      }

      if (isGemini) {
        // Gemini: plain text stdout → treated as systemMessage
        process.stdout.write(outputText);
      } else if (isCodex) {
        // Codex PreToolUse ignores plain stdout and does not support
        // additionalContext/updatedInput yet. systemMessage is the supported
        // way to surface pre-tool guidance without blocking the tool.
        // Ref: https://developers.openai.com/codex/hooks
        process.stdout.write(JSON.stringify({ systemMessage: outputText }));
      } else {
        // Claude Code: structured JSON with additionalContext
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: outputText }
        }));
      }
    }
  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error), stack: error?.stack || null });
    activityLog({ stage: 'error', message: error?.message || String(error), stack: error?.stack || null });
  }
  process.exit(0);
});
