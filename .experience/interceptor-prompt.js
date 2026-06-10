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

// Explicit runtime tag passed by register-hooks.js (e.g. `--runtime=antigravity`).
const RUNTIME_OVERRIDE = (() => {
  const arg = process.argv.find(a => a.startsWith('--runtime='));
  return arg ? arg.slice('--runtime='.length).trim().toLowerCase() : null;
})();

let _sessionEmit = null;
function loadSessionEmit() {
  if (_sessionEmit !== null) return _sessionEmit;
  try { _sessionEmit = require(path.join(os.homedir(), '.experience', 'src', 'session-emit.js')); }
  catch {
    try { _sessionEmit = require(path.join(__dirname, 'src', 'session-emit.js')); }
    catch { _sessionEmit = false; }
  }
  return _sessionEmit;
}
function timeoutFromEnv(name, fallback) {
  const raw = Number(process.env[name] || 0);
  return raw > 0 ? raw : fallback;
}

const STDIN_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_STDIN_TIMEOUT_MS', 3000);
const INTERCEPT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS', 2500);
const HARD_EXIT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_HARD_EXIT_TIMEOUT_MS', 3000);
const PROMPT_STALE_MS = timeoutFromEnv('EXPERIENCE_PROMPT_STALE_MS', 10_000);
const PROMPT_STALE_RECONCILE_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_PROMPT_STALE_RECONCILE_TIMEOUT_MS', 450);
const PROMPT_HOOK_MIN_SCORE = timeoutFromEnv('EXPERIENCE_PROMPT_HOOK_MIN_SCORE', 0.60);

// Active-recall nudge. SessionStart + CLAUDE.md/AGENTS.md get buried in long
// contexts (and dropped on compaction), so the agent stops actively pulling
// experience. Re-injecting a one-line reminder per prompt keeps the PULL path
// (exp-recall) top-of-mind. Emitted only when NO experience hint surfaced this
// turn — a surfaced hint already carries [id col] + the feedback command, so
// doubling up is redundant. Disable with EXPERIENCE_RECALL_NUDGE=0.
const RECALL_NUDGE_ENABLED = process.env.EXPERIENCE_RECALL_NUDGE !== '0';
const RECALL_NUDGE_TEXT = [
  '📌 [Experience — operating rule] Your CLAUDE.md / AGENTS.md mandate "recall-first": BEFORE an unfamiliar or risky step, actively query the brain — this is a standing instruction in your agent config, not an optional tip.',
  '`node ~/.experience/exp-recall.js "<your question>"`',
  '(semantic search across T0 principles → T1 behavioral → T2 seeds → self-QA; records a surface).',
  'After acting, report the verdict so the brain learns (also required by the same rule):',
  '`node ~/.experience/exp-feedback.js followed|ignored|noise <id> <col>`.',
].join(' ');

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

function writeLastSuggestionsState(tool, surfacedIds, sourceMeta, promptMeta = {}) {
  if (!Array.isArray(surfacedIds) || surfacedIds.length === 0) return;
  try {
    const tmpDir = path.join(EXP_DIR, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const state = {
      ts: new Date().toISOString(),
      tool,
      surfacedIds,
      sourceHook: 'UserPromptSubmit',
      prompt: promptMeta.prompt || null,
      cwd: promptMeta.cwd || null,
      sourceSession: sourceMeta?.sourceSession || null,
      sourceKind: sourceMeta?.sourceKind || null,
      sourceRuntime: sourceMeta?.sourceRuntime || null,
    };
    fs.writeFileSync(path.join(tmpDir, 'last-suggestions.json'), JSON.stringify(state, null, 2), 'utf8');
    activityLog({
      stage: 'state_written',
      tool,
      stateFile: 'last-suggestions.json',
      surfacedCount: surfacedIds.length,
      sourceHook: state.sourceHook,
      surfaced: surfacedIds.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
      ...sourceMeta
    });
  } catch {}
}

function statePath() {
  return path.join(EXP_DIR, 'tmp', 'last-suggestions.json');
}

function readLastSuggestionsState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function deleteLastSuggestionsState() {
  try { fs.unlinkSync(statePath()); } catch {}
}

function isPromptOnlyState(state) {
  return state?.sourceHook === 'UserPromptSubmit' || state?.tool === 'UserPrompt';
}

function isStalePromptOnlyState(state) {
  if (!isPromptOnlyState(state)) return false;
  const ts = state?.ts ? new Date(state.ts).getTime() : 0;
  return !ts || (Date.now() - ts) >= PROMPT_STALE_MS;
}

function splitSuggestionBlocks(suggestions) {
  return String(suggestions || '')
    .split(/\n---\n/g)
    .map(block => block.trim())
    .filter(Boolean);
}

function scoreForSuggestionBlock(block) {
  const match = String(block || '').match(/\[(?:Experience - High Confidence|Suggestion|Probationary Suggestion) \(([-\d.]+)\)\]/);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : null;
}

function idsForSuggestionBlock(block) {
  return [...String(block || '').matchAll(/\[id:([^\s\]]+)\s+col:([^\]]+)\]/g)]
    .map(match => ({ id: match[1], collection: match[2] }));
}

function filterPromptSuggestionsForPrecision(suggestions, surfacedIds) {
  if (!suggestions) return { suggestions: null, surfacedIds: [] };
  const blocks = splitSuggestionBlocks(suggestions);
  if (blocks.length === 0) return { suggestions: null, surfacedIds: [] };
  const kept = blocks.filter(block => {
    const score = scoreForSuggestionBlock(block);
    return score === null || score >= PROMPT_HOOK_MIN_SCORE;
  });
  if (kept.length === blocks.length) return { suggestions, surfacedIds };
  const keptShortIds = new Set(kept.flatMap(block => idsForSuggestionBlock(block).map(item => item.id)));
  return {
    suggestions: kept.length > 0 ? kept.join('\n---\n') : null,
    surfacedIds: keptShortIds.size > 0
      ? (surfacedIds || []).filter(surface => keptShortIds.has(String(surface?.id || '').slice(0, 8)))
      : (kept.length > 0 ? surfacedIds : []),
  };
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function reconcileStalePromptState(data, sourceMeta, prompt) {
  const state = readLastSuggestionsState();
  if (!isStalePromptOnlyState(state)) return;
  const nextPromptMeta = {
    prompt,
    cwd: data.cwd || process.cwd(),
    ...sourceMeta,
  };
  const body = { state, nextPromptMeta };

  try {
    const remote = getRemoteClient();
    if (remote) {
      const config = remote.loadConfig();
      if (remote.isRemoteEnabled(config)) {
        try {
          await remote.postJsonForHook('/api/prompt-stale', body, { config, timeoutMs: PROMPT_STALE_RECONCILE_TIMEOUT_MS });
          debugLog({ stage: 'prompt_stale_remote_sent', surfacedCount: state.surfacedIds?.length || 0 });
        } catch (sendErr) {
          debugLog({ stage: 'prompt_stale_remote_failed', message: sendErr?.message || String(sendErr) });
        }
        return;
      }
    }

    const corePath = path.join(EXP_DIR, 'experience-core.js');
    if (!fs.existsSync(corePath)) return;
    const core = require(corePath);
    if (typeof core._reconcileStalePromptSuggestions === 'function') {
      const result = await withTimeout(
        core._reconcileStalePromptSuggestions(state, nextPromptMeta),
        PROMPT_STALE_RECONCILE_TIMEOUT_MS
      );
      if (!result) {
        debugLog({ stage: 'prompt_stale_reconcile_timeout' });
        return;
      }
      debugLog({
        stage: 'prompt_stale_reconciled',
        unused: result?.unused?.length || 0,
        irrelevant: result?.irrelevant?.length || 0,
        expired: result?.expired?.length || 0,
      });
    }
  } catch (error) {
    debugLog({ stage: 'prompt_stale_error', message: error?.message || String(error) });
  } finally {
    deleteLastSuggestionsState();
  }
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

// Load enricher from install dir, with fallback to repo-local for tests.
function _loadEnricher() {
  try { return require(path.join(os.homedir(), '.experience', 'source-meta-enrich.js')); }
  catch {
    try { return require(path.join(__dirname, 'source-meta-enrich.js')); }
    catch { return null; }
  }
}
const _promptEnricher = _loadEnricher();

function buildSourceMeta(data, _toolInput) {
  // UserPromptSubmit has no toolInput. Cwd-based enrichment derives
  // lang/framework from the session's working directory so the Qdrant scope
  // filter has something to gate on — without this, prompt-hook intercepts
  // are repo-agnostic and surface cross-language hints (e.g., .NET seeds
  // inside a TS CLI repo).
  const meta = {
    sourceKind: RUNTIME_OVERRIDE ? `${RUNTIME_OVERRIDE}-hook` : 'codex-hook',
    sourceRuntime: RUNTIME_OVERRIDE || (process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows'),
    sourceSession: data?.session_id || process.env.CODEX_SESSION_ID || null,
  };
  if (_promptEnricher) {
    try {
      const cwd = data?.cwd || process.cwd();
      Object.assign(meta, _promptEnricher.enrichSourceMeta({}, undefined, cwd));
    }
    catch { /* swallow */ }
  }
  return meta;
}

// Skip trivial prompts — greetings, single words, very short. Criteria are
// config/env-driven (src/config.js getMinPromptLength + getPromptSkipRegex) so
// they can be tuned per install (e.g. non-English greetings, length floor)
// without editing this hook. Fail-open to the original hardcoded defaults if
// config.js can't be loaded (thin-client safety) so triviality skipping never
// breaks prompt handling.
const DEFAULT_SKIP_PATTERNS = /^(hi|hello|hey|thanks|ok|yes|no|quit|exit|help|\/\w+)\s*$/i;
const DEFAULT_MIN_PROMPT_LENGTH = 10;

function loadTrivialityConfig() {
  try {
    const cfg = require(path.join(EXP_DIR, 'src', 'config.js'));
    return {
      minLength: cfg.getMinPromptLength(),
      skipRegex: cfg.getPromptSkipRegex(),
    };
  } catch {
    try {
      const cfg = require(path.join(__dirname, 'src', 'config.js'));
      return { minLength: cfg.getMinPromptLength(), skipRegex: cfg.getPromptSkipRegex() };
    } catch {
      return { minLength: DEFAULT_MIN_PROMPT_LENGTH, skipRegex: DEFAULT_SKIP_PATTERNS };
    }
  }
}
const { minLength: MIN_PROMPT_LENGTH, skipRegex: SKIP_PATTERNS } = loadTrivialityConfig();

let input = '';

const t = setTimeout(() => {
  debugLog({ stage: 'timeout' });
  process.exit(0);
}, STDIN_TIMEOUT_MS);

// Watchdog: force-quit only if natural drain hangs. Unref'd so it never keeps
// the loop alive on its own — when the handler finishes and undici sockets
// close, the process exits naturally (avoiding the Windows libuv double-close
// assertion that process.exit() trips while sockets are mid-teardown). It fires
// only if a genuinely stuck ref'd handle keeps the loop alive past the timeout.
const hardExit = setTimeout(() => {
  debugLog({ stage: 'hard_exit' });
  activityLog({ stage: 'hard_exit' });
  process.exit(0);
}, HARD_EXIT_TIMEOUT_MS);
hardExit.unref();

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
      process.exitCode = 0; return;
    }

    // Extract the user's prompt text
    // Codex sends: { hook_event_name, session_id, cwd, ... }
    // The prompt text location may vary — check common fields
    const prompt = data.user_prompt || data.prompt || data.message || '';
    // Antigravity transcript reconstruction: anchor the session with the user
    // prompt. Best-effort, guarded; runs before the trivial-prompt skip so the
    // transcript stays faithful to what the user actually asked.
    if (RUNTIME_OVERRIDE === 'antigravity' && prompt) {
      const emit = loadSessionEmit();
      if (emit) emit.appendRuntimeEvent({
        runtime: 'antigravity',
        sessionId: data.session_id || null,
        cwd: data.cwd || process.cwd(),
        role: 'user',
        blocks: [emit.textBlock(prompt)],
      });
    }
    debugLog({ stage: 'parsed', promptLen: prompt.length, preview: prompt.slice(0, 100) });
    activityLog({ stage: 'parsed', promptLen: prompt.length, preview: prompt.slice(0, 100), ...sourceMeta });

    await reconcileStalePromptState(data, sourceMeta, prompt);

    // Skip trivial prompts
    if (!prompt || prompt.length < MIN_PROMPT_LENGTH || SKIP_PATTERNS.test(prompt.trim())) {
      debugLog({ stage: 'skip', reason: 'trivial prompt' });
      activityLog({ stage: 'skip', reason: 'trivial prompt', promptLen: prompt.length, ...sourceMeta });
      process.exitCode = 0; return;
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
    if (timedOut || !resultMeta) { process.exitCode = 0; return; }

    let suggestions = resultMeta?.suggestions || null;
    let surfacedIds = resultMeta?.surfacedIds || [];
    const precisionResult = filterPromptSuggestionsForPrecision(suggestions, surfacedIds);
    suggestions = precisionResult.suggestions;
    surfacedIds = precisionResult.surfacedIds;
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
      surfacedCount: surfacedIds.length,
      surfaced: surfacedIds.slice(0, 8).map(s => ({ collection: s.collection, pointId: String(s.id || '').slice(0, 8) })),
      promptPrecisionRemoved: Math.max(0, (resultMeta?.surfacedIds || []).length - surfacedIds.length),
      routeTier: routeInfo?.tier || null,
      routeModel: routeInfo?.model || null,
      routeSource: routeInfo?.source || null,
      preview: suggestions ? suggestions.slice(0, 240) : null,
      ...sourceMeta
    });

    if (suggestions) {
      writeLastSuggestionsState('UserPrompt', surfacedIds, sourceMeta, {
        prompt,
        cwd: data.cwd || process.cwd(),
      });
    }

    // Build output
    let outputText = '';
    if (suggestions) {
      outputText = suggestions;
    }
    if (sourceMeta.sourceKind !== 'codex-hook' && routeInfo && routeInfo.tier) {
      const routeLine = `[Model Route] tier=${routeInfo.tier} model=${routeInfo.model || '?'} confidence=${(routeInfo.confidence || 0).toFixed(2)} source=${routeInfo.source || 'default'}`;
      outputText = outputText ? outputText + '\n---\n' + routeLine : routeLine;
    }

    // Active-recall nudge — only when no experience hint surfaced this turn.
    if (RECALL_NUDGE_ENABLED && !suggestions) {
      outputText = outputText ? outputText + '\n---\n' + RECALL_NUDGE_TEXT : RECALL_NUDGE_TEXT;
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
  // Exit naturally: let the event loop drain so undici sockets close cleanly.
  // Force-exit (process.exit) here trips the Windows libuv double-close
  // assertion when concurrent fetches (flushQueueForHook batch) are mid-teardown.
  // hardExit (unref'd) remains armed as a watchdog if drain ever hangs.
  process.exitCode = 0;
});
