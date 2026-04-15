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
const STDIN_TIMEOUT_MS = 3000;
const INTERCEPT_TIMEOUT_MS = 2500;
const HARD_EXIT_TIMEOUT_MS = 4500;

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-prompt', ...event }) + '\n');
  } catch {}
}

function activityLog(event) {
  if (isRemoteMode()) return;
  try {
    const core = require(path.join(EXP_DIR, 'experience-core.js'));
    if (typeof core._activityLog === 'function') {
      core._activityLog({ op: 'hook', hook: 'interceptor-prompt', ...event });
    }
  } catch {}
}

function getRemoteClient() {
  try {
    return require(path.join(EXP_DIR, 'remote-client.js'));
  } catch {
    return null;
  }
}

function isRemoteMode() {
  const remote = getRemoteClient();
  if (!remote) return false;
  try {
    return remote.isRemoteEnabled(remote.loadConfig());
  } catch {
    return false;
  }
}

function suppressHookOutput() {
  const muted = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const capture = (stream, chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (text) muted.push({ stream, text });
    return true;
  };

  process.stdout.write = ((chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return capture('stdout', chunk);
  });
  process.stderr.write = ((chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return capture('stderr', chunk);
  });
  console.log = (...args) => capture('console.log', args.join(' '));
  console.info = (...args) => capture('console.info', args.join(' '));
  console.warn = (...args) => capture('console.warn', args.join(' '));
  console.error = (...args) => capture('console.error', args.join(' '));

  return {
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      return muted;
    }
  };
}

function buildSourceMeta(data) {
  return {
    sourceKind: 'codex-hook',
    sourceRuntime: process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows',
    sourceSession: data?.session_id || process.env.CODEX_SESSION_ID || null,
  };
}

// Skip trivial prompts — greetings, single words, very short
const SKIP_PATTERNS = /^(hi|hello|hey|thanks|ok|yes|no|quit|exit|help|\/\w+)\s*$/i;
const MIN_PROMPT_LENGTH = 10;

let input = '';

const t = setTimeout(() => {
  debugLog({ stage: 'timeout' });
  process.exit(0);
}, STDIN_TIMEOUT_MS);

const hardExit = setTimeout(() => {
  debugLog({ stage: 'hard_exit' });
  activityLog({ stage: 'hard_exit' });
  process.exit(0);
}, HARD_EXIT_TIMEOUT_MS);

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  debugLog({ stage: 'stdin_end', bytes: input.length });
  activityLog({ stage: 'stdin_end', bytes: input.length });

  try {
    const data = JSON.parse(input || '{}');
    const hookEvent = data.hook_event_name || '';
    const sourceMeta = buildSourceMeta(data);

    // Only handle UserPromptSubmit
    if (hookEvent !== 'UserPromptSubmit') {
      debugLog({ stage: 'skip', reason: 'not UserPromptSubmit', hookEvent });
      activityLog({ stage: 'skip', reason: 'not UserPromptSubmit', hookEvent, ...sourceMeta });
      process.exit(0);
    }

    // Extract the user's prompt text
    // Codex sends: { hook_event_name, session_id, cwd, ... }
    // The prompt text location may vary — check common fields
    const prompt = data.user_prompt || data.prompt || data.message || '';
    debugLog({ stage: 'parsed', promptLen: prompt.length, preview: prompt.slice(0, 100) });
    activityLog({ stage: 'parsed', promptLen: prompt.length, preview: prompt.slice(0, 100), ...sourceMeta });

    // Skip trivial prompts
    if (!prompt || prompt.length < MIN_PROMPT_LENGTH || SKIP_PATTERNS.test(prompt.trim())) {
      debugLog({ stage: 'skip', reason: 'trivial prompt' });
      activityLog({ stage: 'skip', reason: 'trivial prompt', promptLen: prompt.length, ...sourceMeta });
      process.exit(0);
    }

    const ctrl = new AbortController();
    let timedOut = false;
    let timer = null;
    const mute = suppressHookOutput();

    // Use the prompt as the query — treat it like a generic tool call
    // This searches all experience collections for relevant warnings
    const toolInput = { command: prompt, _promptHook: true };
    const resultPromise = (async () => {
      const remote = getRemoteClient();
      if (remote) {
        const config = remote.loadConfig();
        if (remote.isRemoteEnabled(config)) {
          try { await remote.flushQueueForHook({ config }); } catch {}
          return remote.postJsonForHook('/api/intercept', {
          toolName: 'UserPrompt',
          toolInput,
          cwd: data.cwd || process.cwd(),
          ...sourceMeta,
          }, { config });
        }
      }

      const corePath = path.join(EXP_DIR, 'experience-core.js');
      if (!fs.existsSync(corePath)) {
        debugLog({ stage: 'skip', reason: 'experience-core.js not found' });
        activityLog({ stage: 'skip', reason: 'experience-core.js not found', ...sourceMeta });
        return null;
      }

      const { interceptWithMeta } = require(corePath);
      if (!interceptWithMeta) {
        debugLog({ stage: 'skip', reason: 'interceptWithMeta not exported' });
        activityLog({ stage: 'skip', reason: 'interceptWithMeta not exported', ...sourceMeta });
        return null;
      }
      return interceptWithMeta('UserPrompt', toolInput, ctrl.signal, sourceMeta);
    })().catch(error => {
      if (ctrl.signal.aborted) {
        debugLog({ stage: 'aborted', message: error?.message || String(error) });
        activityLog({ stage: 'aborted', message: error?.message || String(error), ...sourceMeta });
        return null;
      }
      throw error;
    });
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        debugLog({ stage: 'abort' });
        activityLog({ stage: 'abort', ...sourceMeta });
        ctrl.abort();
        resolve(null);
      }, INTERCEPT_TIMEOUT_MS);
    });
    const resultMeta = await Promise.race([resultPromise, timeoutPromise]);
    const mutedOutput = mute.restore();
    clearTimeout(timer);
    if (mutedOutput.length > 0) {
      debugLog({
        stage: 'suppressed_output',
        count: mutedOutput.length,
        preview: mutedOutput.map(entry => entry.text).join('').slice(0, 240),
      });
      activityLog({
        stage: 'suppressed_output',
        count: mutedOutput.length,
        preview: mutedOutput.map(entry => entry.text).join('').slice(0, 240),
        ...sourceMeta,
      });
    }
    if (timedOut || !resultMeta) process.exit(0);

    const suggestions = resultMeta?.suggestions || null;
    const routeInfo = resultMeta?.route || null;
    try {
      const remote = getRemoteClient();
      if (remote) remote.maybeSpawnExtractDrain();
    } catch {}
    debugLog({ stage: 'done', hasSuggestions: !!suggestions, hasRoute: !!routeInfo });
    activityLog({
      stage: 'done',
      hasSuggestions: !!suggestions,
      hasRoute: !!routeInfo,
      surfacedCount: (resultMeta?.surfacedIds || []).length,
      surfaced: (resultMeta?.surfacedIds || []).slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
      routeTier: routeInfo?.tier || null,
      routeModel: routeInfo?.model || null,
      routeSource: routeInfo?.source || null,
      preview: suggestions ? suggestions.slice(0, 240) : null,
      ...sourceMeta
    });

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
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: outputText,
        }
      }));
    }
  } catch (error) {
    debugLog({ stage: 'error', message: error?.message || String(error) });
    activityLog({ stage: 'error', message: error?.message || String(error) });
  }
  clearTimeout(hardExit);
  process.exit(0);
});
