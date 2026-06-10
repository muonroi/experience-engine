#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

// Explicit runtime tag passed by register-hooks.js (e.g. `--runtime=antigravity`).
// Deterministic on Windows where the hook child env does not carry
// ANTIGRAVITY_SESSION_ID; absent for other runtimes so behavior is unchanged.
const RUNTIME_OVERRIDE = (() => {
  const arg = process.argv.find(a => a.startsWith('--runtime='));
  return arg ? arg.slice('--runtime='.length).trim().toLowerCase() : null;
})();

// Best-effort transcript emit for runtimes that deliver no transcript (Antigravity).
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

let input = '';
function timeoutFromEnv(name, fallback) {
  const raw = Number(process.env[name] || 0);
  return raw > 0 ? raw : fallback;
}

const STDIN_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_STDIN_TIMEOUT_MS', 3000);
const INTERCEPT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS', 2500);
const HARD_EXIT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_HARD_EXIT_TIMEOUT_MS', 3000);

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor', ...event }) + '\n');
  } catch {}
}

function activityLog(event) {
  if (isRemoteMode()) return;
  try {
    const core = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
    if (typeof core._activityLog === 'function') {
      core._activityLog({ op: 'hook', hook: 'interceptor', ...event });
    }
  } catch {}
}

function getRemoteClient() {
  try {
    return require(path.join(os.homedir(), '.experience', 'remote-client.js'));
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

// Load enricher from install dir, with fallback to repo-local for tests.
function loadEnricher() {
  try { return require(path.join(os.homedir(), '.experience', 'source-meta-enrich.js')); }
  catch {
    try { return require(path.join(__dirname, 'source-meta-enrich.js')); }
    catch { return null; }
  }
}
const _enricher = loadEnricher();

function _loadInstalled(rel) {
  try { return require(path.join(os.homedir(), '.experience', rel)); }
  catch {
    try { return require(path.join(__dirname, rel)); }
    catch { return null; }
  }
}
const _riskTriggers = _loadInstalled('src/risk-triggers.js');
const _riskCfg = _loadInstalled('src/config.js');

// Tool-level risk gate (PreToolUse): a one-line nudge when a command keyword or a
// cross-repo file path is touched and nothing relevant surfaced. No extra recall
// here — the intercept already searched; this just flags the risk + points at recall.
function buildToolRiskGate(tool, toolInput, cwd) {
  if (!_riskTriggers) return null;
  const enabled = _riskCfg && typeof _riskCfg.getRiskGateEnabled === 'function' ? _riskCfg.getRiskGateEnabled() : true;
  if (!enabled) return null;
  const keywords = _riskCfg && typeof _riskCfg.getRiskKeywords === 'function' ? _riskCfg.getRiskKeywords() : undefined;
  let triggers = [];
  try {
    triggers = _riskTriggers.detectRiskTriggers({ toolName: tool, toolInput, cwd, keywords, repoRootOf: _riskTriggers.gitRepoRootOf });
  } catch (err) {
    debugLog({ stage: 'risk_detect_failed', message: err?.message || String(err) });
    return null;
  }
  if (!triggers.length) return null;
  const top = triggers[0];
  return { line: `⚠️ [Experience — risk gate] ${top.kind}: "${top.topic}". Run \`node ~/.experience/exp-recall.js "${top.topic}"\` before this step, or note one line why you're skipping.`, top };
}

function buildSourceMeta(data, toolInput) {
  const runtime = RUNTIME_OVERRIDE || (process.env.WSL_DISTRO_NAME ? 'codex-wsl' : 'codex-windows');
  const meta = {
    sourceKind: RUNTIME_OVERRIDE ? `${RUNTIME_OVERRIDE}-hook` : 'codex-hook',
    sourceRuntime: runtime,
    // Codex hook payload reliably includes session_id; CODEX_SESSION_ID is
    // not guaranteed to be present in the hook subprocess environment.
    sourceSession: data.session_id || process.env.CODEX_SESSION_ID || null,
  };
  // Caller-side language/framework enrichment. Best-effort: a missing
  // enricher or any throw inside leaves the filter pass-through (status quo).
  // Pass cwd so Bash hooks (no file_path) still get scope hints from the
  // surrounding repo manifest — otherwise the Qdrant scope filter is skipped
  // entirely and cross-language hints bleed into the top-K.
  if (_enricher) {
    try {
      const cwd = data?.cwd || process.cwd();
      Object.assign(meta, _enricher.enrichSourceMeta(toolInput, undefined, cwd));
    }
    catch { /* swallow */ }
  }
  return meta;
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

// Tools that mutate state and benefit from session-scoped hint de-dup.
// Claude Code v2.1.9+ honors `additionalContext` on PreToolUse correctly
// (anthropics/claude-code#15345 implemented), so we no longer need the
// `permissionDecision: "deny"` workaround that surfaced hints via the
// reason field. We keep the delivered-hints tracking purely as a UX
// guard so the same hint is not re-injected on retry of the exact same
// (tool, args) within one session. Set EXPERIENCE_PRETOOL_LEGACY_DENY=1
// to force the legacy behaviour on older Claude CLIs (< 2.1.9).
const MUTATING_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|shell|execute_command|replace.*|write_file|edit_file)$/i;

const DELIVERED_STATE_PATH = path.join(os.homedir(), '.experience', 'tmp', 'delivered-hints.json');
const DELIVERED_STATE_TTL_MS = 24 * 60 * 60 * 1000; // prune entries older than 24h

function _loadDelivered() {
  try { return JSON.parse(fs.readFileSync(DELIVERED_STATE_PATH, 'utf8')) || {}; }
  catch { return {}; }
}

function _saveDelivered(state) {
  try {
    fs.mkdirSync(path.dirname(DELIVERED_STATE_PATH), { recursive: true });
    const tmp = DELIVERED_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DELIVERED_STATE_PATH);
  } catch { /* best-effort */ }
}

function _pruneDelivered(state) {
  const cutoff = Date.now() - DELIVERED_STATE_TTL_MS;
  for (const key of Object.keys(state)) {
    if (!state[key] || typeof state[key].ts !== 'number' || state[key].ts < cutoff) {
      delete state[key];
    }
  }
  return state;
}

function _argsFingerprint(tool, toolInput) {
  // Stable short hash of the tool + canonical args so retry-with-same-args
  // can be detected. Use file_path for edits, command for shells, fall back
  // to JSON of all keys for unknown tools.
  const crypto = require('crypto');
  const canonical = (() => {
    if (!toolInput || typeof toolInput !== 'object') return String(toolInput || '');
    if (toolInput.file_path) return `file:${toolInput.file_path}`;
    if (toolInput.path) return `path:${toolInput.path}`;
    if (toolInput.command) return `cmd:${toolInput.command}`;
    if (toolInput.cmd) return `cmd:${toolInput.cmd}`;
    try { return JSON.stringify(toolInput); } catch { return ''; }
  })();
  return crypto.createHash('sha1').update(`${tool}\x00${canonical}`).digest('hex').slice(0, 12);
}

function _filterUndeliveredHints(session, fingerprint, hintIds) {
  if (!hintIds || hintIds.length === 0) return [];
  const state = _pruneDelivered(_loadDelivered());
  const key = `${session}:${fingerprint}`;
  const delivered = new Set((state[key] && state[key].ids) || []);
  return hintIds.filter(id => !delivered.has(id));
}

function _markHintsDelivered(session, fingerprint, hintIds) {
  if (!hintIds || hintIds.length === 0) return;
  const state = _pruneDelivered(_loadDelivered());
  const key = `${session}:${fingerprint}`;
  const existing = new Set((state[key] && state[key].ids) || []);
  for (const id of hintIds) existing.add(id);
  state[key] = { ts: Date.now(), ids: [...existing] };
  _saveDelivered(state);
}

function emitPreToolUseGuidance(data, tool, additionalContext = '', extras) {
  const isGemini = !!(process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR)
    || /^(run_shell_command|write_file|edit_file|replace_in_file)$/.test(tool || '');
  // Claude Code sets CLAUDE_PROJECT_DIR in hook subprocess env. Detect it
  // FIRST — previously isCodexHookInvocation() matched on hook_event_name
  // alone, which Claude Code ALSO sets ("PreToolUse"), so every Claude hook
  // was misrouted to the Codex `{systemMessage}` branch (which Claude does
  // not read). That's why no hint ever reached the agent before this fix.
  const isClaude = !isGemini && !!(process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_CODE_SESSION_ID);
  const isCodex = !isGemini && !isClaude && isCodexHookInvocation(data, tool);
  if (isGemini) {
    if (additionalContext) process.stdout.write(additionalContext);
    return;
  }

  if (isCodex) {
    if (additionalContext) {
      process.stdout.write(JSON.stringify({ systemMessage: additionalContext }));
    }
    return;
  }

  if (!additionalContext) return;

  // Claude path. v2.1.9+ honors hookSpecificOutput.additionalContext on
  // PreToolUse, so we just emit it directly. Session-scoped delivered-hints
  // tracking still runs for mutating tools so a retry of the exact same
  // (tool, args) does not re-inject the same hint text.
  const toolInput = extras?.toolInput || data?.tool_input || data?.input || {};
  const surfacedIds = (extras?.surfacedIds || []).map(s => String(s.id || '')).filter(Boolean);
  const shouldDedup = MUTATING_TOOLS.test(tool || '') && surfacedIds.length > 0;
  let contextToEmit = additionalContext;

  if (shouldDedup) {
    const session = data?.session_id || data?.tool_use_id || data?.turn_id || 'default';
    const fingerprint = _argsFingerprint(tool, toolInput);
    const undelivered = _filterUndeliveredHints(session, fingerprint, surfacedIds);
    if (undelivered.length === 0) {
      // Every hint in this batch was already surfaced for this exact
      // (tool, args) in the current session — skip re-injection.
      return;
    }
    _markHintsDelivered(session, fingerprint, undelivered);
  }

  // Legacy fallback for users still on Claude CLI < 2.1.9 — opt in with
  // EXPERIENCE_PRETOOL_LEGACY_DENY=1. Modern path below is the default.
  if (process.env.EXPERIENCE_PRETOOL_LEGACY_DENY === '1' && shouldDedup) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: contextToEmit,
      }
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: contextToEmit,
    }
  }));
}

// Keep this read-only detector aligned with experience-core.js so thin-client
// hooks can skip harmless commands before touching the remote server.
const READ_ONLY_CMD = /^(ls|dir|cat|head|tail|wc|file|stat|find|tree|which|where|echo|printf|pwd|whoami|hostname|date|uptime|type|less|more|sort|uniq|tee|realpath|basename|dirname|env|printenv|id|groups|df|du|free|top|htop|lsof|ps|pgrep|mount|uname)\b|^git\s+(log|status|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|shortlog|blame|reflog|ls-files|ls-tree|name-rev|cherry)\b|^(grep|rg|ag|ack)\b|^diff\b|^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why)\b|^(dotnet)\s+(--list-sdks|--list-runtimes|--info)\b|^(docker|podman)\s+(ps|images|inspect|logs|stats|top|port|volume\s+ls|network\s+ls)\b|^(get-content|select-string|measure-object|get-childitem|get-item|get-location|resolve-path|test-path|get-command)\b/i;

function isReadOnlyCommand(tool, toolInput) {
  const normalizedTool = String(tool || '').toLowerCase();
  if (normalizedTool !== 'bash' && normalizedTool !== 'shell' && normalizedTool !== 'execute_command') return false;
  const cmd = String(toolInput?.command || toolInput?.cmd || '').trim();
  if (!cmd) return false;
  const parts = cmd.split(/\s*(?:&&|\|\||;)\s*/);
  return parts.every(part => READ_ONLY_CMD.test(part.trim()));
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

const t = setTimeout(() => {
  debugLog({ stage: 'timeout_waiting_for_stdin' });
  process.exit(0);
}, STDIN_TIMEOUT_MS);

// Watchdog: force-quit only if natural drain hangs. Unref'd so it never keeps
// the loop alive on its own — when the handler finishes and undici sockets
// close, the process exits naturally (avoiding the Windows libuv double-close
// assertion that process.exit() trips while sockets are mid-teardown).
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
  let mute = null;
  try {
    const data = JSON.parse(input || '{}');
    const tool = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.input || {};
    const sourceMeta = buildSourceMeta(data, toolInput);
    // Antigravity transcript reconstruction: record the tool call. Guarded +
    // best-effort — never affects surfacing or other runtimes.
    if (RUNTIME_OVERRIDE === 'antigravity') {
      const emit = loadSessionEmit();
      if (emit) emit.appendRuntimeEvent({
        runtime: 'antigravity',
        sessionId: data.session_id || data.tool_use_id || data.turn_id || null,
        cwd: data.cwd || process.cwd(),
        role: 'assistant',
        blocks: [emit.toolUseBlock(tool, toolInput)],
      });
    }
    const matches = /Edit|Write|Bash|shell|replace|write_file|execute_command/i.test(tool);
    debugLog({ stage: 'parsed', tool, matches, keys: Object.keys(toolInput || {}).slice(0, 12), ...sourceMeta });
    activityLog({ stage: 'parsed', tool, matches, keys: Object.keys(toolInput || {}).slice(0, 12), query: toolInput?.command || toolInput?.cmd || null, ...sourceMeta });
    if (!matches) {
      emitPreToolUseGuidance(data, tool);
      process.exitCode = 0; return;
    }
    if (isReadOnlyCommand(tool, toolInput)) {
      emitPreToolUseGuidance(data, tool);
      process.exitCode = 0; return;
    }

    const ctrl = new AbortController();
    let timedOut = false;
    let timer = null;
    mute = suppressHookOutput();
    const resultPromise = (async () => {
      const remote = getRemoteClient();
      if (remote) {
        const config = remote.loadConfig();
        if (remote.isRemoteEnabled(config)) {
          try { await remote.flushQueueForHook({ config }); } catch {}
          return remote.postJsonForHook('/api/intercept', {
          toolName: tool,
          toolInput,
          cwd: data.cwd || process.cwd(),
          ...sourceMeta,
          }, { config });
        }
      }

      const corePath = path.join(os.homedir(), '.experience', 'experience-core.js');
      const { interceptWithMeta: interceptMeta, intercept: localIntercept } = require(corePath);
      if (interceptMeta) return interceptMeta(tool, toolInput, ctrl.signal, sourceMeta);
      return { suggestions: await localIntercept(tool, toolInput, ctrl.signal, sourceMeta), surfacedIds: [], route: null };
    })().catch(error => {
      if (ctrl.signal.aborted) {
        debugLog({ stage: 'intercept_aborted', tool, message: error?.message || String(error) });
        activityLog({ stage: 'intercept_aborted', tool, message: error?.message || String(error), ...sourceMeta });
        return null;
      }
      throw error;
    });
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        debugLog({ stage: 'intercept_abort', tool });
        activityLog({ stage: 'intercept_abort', tool, ...sourceMeta });
        ctrl.abort();
        resolve(null);
      }, INTERCEPT_TIMEOUT_MS);
    });
    const resultMeta = await Promise.race([resultPromise, timeoutPromise]);
    const mutedOutput = mute.restore();
    mute = null;
    clearTimeout(timer);
    if (mutedOutput.length > 0) {
      debugLog({
        stage: 'suppressed_output',
        tool,
        count: mutedOutput.length,
        preview: mutedOutput.map(entry => entry.text).join('').slice(0, 240),
      });
      activityLog({
        stage: 'suppressed_output',
        tool,
        count: mutedOutput.length,
        preview: mutedOutput.map(entry => entry.text).join('').slice(0, 240),
        ...sourceMeta,
      });
    }
    if (timedOut || !resultMeta) {
      emitPreToolUseGuidance(data, tool);
      process.exitCode = 0; return;
    }
    const result = resultMeta?.suggestions ?? (typeof resultMeta === 'string' ? resultMeta : null);
    const surfacedIds = resultMeta?.surfacedIds || [];
    const routeInfo = resultMeta?.route || null;
    try {
      const remote = getRemoteClient();
      if (remote) remote.maybeSpawnExtractDrain();
    } catch {}
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

    let outputText = result || '';
    if (sourceMeta.sourceKind !== 'codex-hook' && routeInfo && routeInfo.tier) {
      const routeLine = `\n[Model Route] tier=${routeInfo.tier} model=${routeInfo.model || '?'} confidence=${(routeInfo.confidence || 0).toFixed(2)} source=${routeInfo.source || 'default'}`;
      outputText = outputText ? outputText + '\n---\n' + routeLine : routeLine;
    }

    // Surface a one-line stderr indicator for Claude Code TUI users.
    // Claude Code auto-collapses hook output, so even though v2.1.9+
    // honors additionalContext on PreToolUse, the user has no visible
    // signal that hints fired without Ctrl+O. A stderr line shows up
    // next to "Ran 1 PreToolUse hook" so the user knows EE is alive.
    if (outputText && surfacedIds.length > 0 && process.env.EXPERIENCE_VISIBLE_HINT_INDICATOR !== '0') {
      try {
        const hintCount = surfacedIds.length;
        const isClaudeTui = !!(process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_CODE_SESSION_ID);
        if (isClaudeTui) {
          process.stderr.write(`💡 Experience: ${hintCount} hint${hintCount === 1 ? '' : 's'} surfaced (Ctrl+O to expand)\n`);
        }
      } catch {}
    }

    // Risk gate: when nothing relevant surfaced for a risky tool step, append a
    // one-line nudge naming the trigger so the agent can recall or explicitly skip.
    if (surfacedIds.length === 0) {
      const gate = buildToolRiskGate(tool, toolInput, data.cwd || process.cwd());
      if (gate && gate.line) {
        activityLog({ stage: 'risk_gate', tool, kind: gate.top.kind, topic: gate.top.topic, ...sourceMeta });
        outputText = outputText ? outputText + '\n---\n' + gate.line : gate.line;
      }
    }

    emitPreToolUseGuidance(data, tool, outputText, { toolInput, surfacedIds });
  } catch (error) {
    try {
      if (typeof mute?.restore === 'function') mute.restore();
    } catch {}
    debugLog({ stage: 'error', message: error?.message || String(error), stack: error?.stack || null });
    activityLog({ stage: 'error', message: error?.message || String(error), stack: error?.stack || null });
    try {
      const data = JSON.parse(input || '{}');
      const tool = data.tool_name || data.toolName || '';
      if (isCodexHookInvocation(data, tool)) {
        emitPreToolUseGuidance(data, tool);
      }
    } catch {}
  }
  // Exit naturally so undici sockets close cleanly; hardExit (unref'd) is the
  // watchdog if drain ever hangs. See hardExit comment above.
  process.exitCode = 0;
});
