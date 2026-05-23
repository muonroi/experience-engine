#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compactTranscript } = require('./extract-compact');

const crypto = require('crypto');

const MIN_NEW_LINES = 5;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const MIN_IMPORTANT_SIGNALS = 4;
const MIN_SIGNAL_TRANSCRIPT_CHARS = 180;
const MAX_EXTRACTIONS_PER_SESSION = 10;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
// Backfill: cover sessions a STOP hook may have missed (user closes the
// terminal with the window's X button instead of letting the agent exit
// cleanly, /clear, /compact, ...). Bounded so SessionStart stays fast.
const BACKFILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKFILL_MAX_SESSIONS = 5;

function getHomeDir() {
  return process.env.HOME || os.homedir();
}

function getCore(homeDir = getHomeDir()) {
  return require(path.join(homeDir, '.experience', 'experience-core.js'));
}

function getRemoteClient(homeDir = getHomeDir()) {
  try {
    return require(path.join(homeDir, '.experience', 'remote-client.js'));
  } catch {
    return null;
  }
}

function getMarkerPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.experience', '.stop-marker.json');
}

function getEvolveMarkerPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.experience', '.evolve-marker');
}

function getVersionCheckMarkerPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.experience', '.version-check-marker');
}

// Rate-limited (1×/24h) check that emits a one-line nudge to stderr when the
// install commit recorded in config.json differs from the server's current
// commit. Silent on match, on network errors, or before 7 days have elapsed
// since install. The Stop hook is the right place: it fires once per session
// end, not on every tool call.
async function maybeWarnIfStale(homeDir = getHomeDir(), remote, config) {
  try {
    const markerPath = getVersionCheckMarkerPath(homeDir);
    let lastChecked = 0;
    try { lastChecked = fs.statSync(markerPath).mtimeMs; } catch {}
    const now = Date.now();
    if (now - lastChecked < 24 * 60 * 60 * 1000) return;  // cooldown
    const installedAt = config?.installedAt ? new Date(config.installedAt).getTime() : now;
    if (now - installedAt < 7 * 24 * 60 * 60 * 1000) return;  // grace period
    const baseUrl = remote.getServerBaseUrl(config);
    if (!baseUrl) return;
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!res || !res.ok) return;
    const body = await res.json().catch(() => null);
    if (!body || !body.commit) return;
    fs.writeFileSync(markerPath, String(now), { flag: 'w' });  // update cooldown either way
    const localCommit = String(config.installCommit || '').slice(0, 12);
    if (!localCommit || localCommit === 'unknown') {
      process.stderr.write(
        '[Experience] Your install predates commit stamping. Run `bash upgrade.sh` to refresh.\n'
      );
      return;
    }
    if (localCommit === body.commit) return;
    process.stderr.write(
      `[Experience] Client is stale (installed: ${localCommit}, server: ${body.commit}). ` +
      'Run `bash upgrade.sh` from your repo clone to refresh.\n'
    );
  } catch { /* swallow — never block the hook on diagnostics */ }
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function trimText(value, max = 500) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractProjectSlug(sessionPath) {
  if (!sessionPath) return null;
  const norm = sessionPath.replace(/\\/g, '/');
  const match = norm.match(/\.claude\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

function walkLatestJsonl(rootDir, matcher, now = Date.now()) {
  if (!fs.existsSync(rootDir)) return null;
  let latest = null;
  let latestMtime = 0;

  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !matcher(filePath, entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = filePath;
      }
    }
  };

  visit(rootDir);
  if (!latest) return null;
  if ((now - latestMtime) > SESSION_MAX_AGE_MS) return null;
  return { file: latest, mtimeMs: latestMtime };
}

function walkAllJsonl(rootDir, matcher, now = Date.now(), maxAgeMs = BACKFILL_MAX_AGE_MS) {
  if (!fs.existsSync(rootDir)) return [];
  const found = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(filePath); continue; }
      if (!entry.isFile() || !matcher(filePath, entry.name)) continue;
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if ((now - stat.mtimeMs) > maxAgeMs) continue;
      found.push({ file: filePath, mtimeMs: stat.mtimeMs });
    }
  };
  visit(rootDir);
  return found;
}

function findLatestClaudeSession(homeDir = getHomeDir(), now = Date.now()) {
  const rootDir = path.join(homeDir, '.claude', 'projects');
  const latest = walkLatestJsonl(rootDir, (_filePath, name) => name.endsWith('.jsonl'), now);
  if (!latest) return null;
  return {
    runtime: 'claude',
    file: latest.file,
    mtimeMs: latest.mtimeMs,
    projectPath: extractProjectSlug(latest.file),
  };
}

function findLatestCodexSession(homeDir = getHomeDir(), now = Date.now()) {
  const rootDir = path.join(homeDir, '.codex', 'sessions');
  const latest = walkLatestJsonl(rootDir, (_filePath, name) => /^rollout-.*\.jsonl$/i.test(name), now);
  if (!latest) return null;
  return {
    runtime: 'codex',
    file: latest.file,
    mtimeMs: latest.mtimeMs,
    projectPath: null,
  };
}

function resolveGeminiProjectPath(dirName, homeDir) {
  try {
    const projectsFile = path.join(homeDir, '.gemini', 'projects.json');
    const data = safeReadJson(projectsFile, {});
    const projects = data.projects || {};
    // Build reverse map: slug → absolute path
    for (const [absPath, slug] of Object.entries(projects)) {
      if (slug === dirName) return absPath;
    }
  } catch {}
  return null;
}

function findLatestGeminiSession(homeDir = getHomeDir(), now = Date.now()) {
  const tmpDir = path.join(homeDir, '.gemini', 'tmp');
  if (!fs.existsSync(tmpDir)) return null;

  let latestFile = null;
  let latestMtime = 0;
  let latestProjectPath = null;

  let topEntries;
  try {
    topEntries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const topEntry of topEntries) {
    if (!topEntry.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, topEntry.name, 'chats');
    let chatEntries;
    try {
      chatEntries = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Determine if this dir is a named project (not a sha256 hash)
    const isHash = /^[0-9a-f]{60,}$/.test(topEntry.name);
    const projectPath = isHash ? null : resolveGeminiProjectPath(topEntry.name, homeDir);

    for (const chatEntry of chatEntries) {
      if (!chatEntry.isFile()) continue;
      if (!/^session-.*\.(json|jsonl)$/.test(chatEntry.name)) continue;
      const filePath = path.join(chatsDir, chatEntry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = filePath;
        latestProjectPath = projectPath;
      }
    }
  }

  if (!latestFile) return null;
  if ((now - latestMtime) > SESSION_MAX_AGE_MS) return null;
  return {
    runtime: 'gemini',
    file: latestFile,
    mtimeMs: latestMtime,
    projectPath: latestProjectPath,
  };
}

function buildGeminiSessionData(logPath) {
  const transcriptLines = [];
  let messages = [];

  if (logPath.endsWith('.jsonl')) {
    // New format: each line is a JSON object (message)
    const lines = readJsonlLines(logPath);
    for (const line of lines) {
      try { messages.push(JSON.parse(line)); } catch {}
    }
  } else {
    // Old format: single JSON file with messages array
    const data = safeReadJson(logPath, {});
    messages = Array.isArray(data.messages) ? data.messages : [];
  }

  for (const msg of messages) {
    if (!msg || !msg.type) continue;

    if (msg.type === 'user') {
      const text = contentBlocksToText(msg.content);
      if (text) transcriptLines.push(`User: ${text}`);
      continue;
    }

    if (msg.type === 'gemini') {
      const text = contentBlocksToText(msg.content);
      if (text) transcriptLines.push(`Assistant: ${text}`);

      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (!tc || !tc.name) continue;
          transcriptLines.push(formatToolCall(tc.name, tc.args || {}));
          const output = tc.result?.[0]?.functionResponse?.response?.output;
          const normalized = normalizeToolOutput(output || '');
          if (normalized) transcriptLines.push(`ToolOutput: ${normalized}`);
        }
      }
    }
  }

  return {
    transcript: transcriptLines.join('\n'),
    totalLines: messages.length,
    projectPath: null, // resolved by findLatestGeminiSession
  };
}

function findCurrentSession(homeDir = getHomeDir(), now = Date.now()) {
  const candidates = [
    findLatestClaudeSession(homeDir, now),
    findLatestCodexSession(homeDir, now),
    findLatestGeminiSession(homeDir, now),
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

// Enumerate every session file (Claude + Codex + Gemini) modified within
// maxAgeMs, sorted newest-first. Used by backfill mode so a SessionStart
// hook can re-scan sessions that a STOP hook missed (terminal closed with
// X button, /clear, /compact, OS crash, ...).
function findAllRecentSessions(homeDir = getHomeDir(), now = Date.now(), maxAgeMs = BACKFILL_MAX_AGE_MS) {
  const sessions = [];

  const claudeRoot = path.join(homeDir, '.claude', 'projects');
  for (const f of walkAllJsonl(claudeRoot, (_p, name) => name.endsWith('.jsonl'), now, maxAgeMs)) {
    sessions.push({ runtime: 'claude', file: f.file, mtimeMs: f.mtimeMs, projectPath: extractProjectSlug(f.file) });
  }

  const codexRoot = path.join(homeDir, '.codex', 'sessions');
  for (const f of walkAllJsonl(codexRoot, (_p, name) => /^rollout-.*\.jsonl$/i.test(name), now, maxAgeMs)) {
    sessions.push({ runtime: 'codex', file: f.file, mtimeMs: f.mtimeMs, projectPath: null });
  }

  const geminiTmp = path.join(homeDir, '.gemini', 'tmp');
  if (fs.existsSync(geminiTmp)) {
    let topEntries;
    try { topEntries = fs.readdirSync(geminiTmp, { withFileTypes: true }); } catch { topEntries = []; }
    for (const topEntry of topEntries) {
      if (!topEntry.isDirectory()) continue;
      const chatsDir = path.join(geminiTmp, topEntry.name, 'chats');
      const isHash = /^[0-9a-f]{60,}$/.test(topEntry.name);
      const projectPath = isHash ? null : resolveGeminiProjectPath(topEntry.name, homeDir);
      for (const f of walkAllJsonl(chatsDir, (_p, name) => /^session-.*\.(json|jsonl)$/.test(name), now, maxAgeMs)) {
        sessions.push({ runtime: 'gemini', file: f.file, mtimeMs: f.mtimeMs, projectPath });
      }
    }
  }

  // muonroi-cli native emit — JSONL written by src/ee/transcript-emit.ts
  // First line is a session_meta record with the session's cwd; using it as
  // projectPath lets detectFrameworkFromProject() resolve framework + lang
  // correctly instead of defaulting to framework=any.
  const muonRoot = path.join(homeDir, '.experience', 'muonroi-cli-sessions');
  for (const f of walkAllJsonl(muonRoot, (_p, name) => name.endsWith('.jsonl'), now, maxAgeMs)) {
    let cwd = null;
    try {
      const head = fs.readFileSync(f.file, 'utf8').split('\n', 1)[0];
      const meta = head ? JSON.parse(head) : null;
      if (meta && meta.type === 'session_meta' && typeof meta.cwd === 'string') cwd = meta.cwd;
    } catch {}
    sessions.push({ runtime: 'muonroi-cli', file: f.file, mtimeMs: f.mtimeMs, projectPath: cwd });
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

// Per-file marker: tracks last processed line for each session file
// independently. Migrates the old single-file shape ({file, line}) so an
// existing marker on disk keeps its progress on the previously-extracted
// session. The legacy single-file fields are kept on write for any old
// reader still in flight.
function readMarker(homeDir = getHomeDir()) {
  const markerPath = getMarkerPath(homeDir);
  const raw = safeReadJson(markerPath, {});
  if (raw && raw.files && typeof raw.files === 'object') {
    return { files: { ...raw.files } };
  }
  if (raw && typeof raw.file === 'string' && typeof raw.line === 'number') {
    return { files: { [raw.file]: { line: raw.line } } };
  }
  return { files: {} };
}

function writeMarker(homeDir = getHomeDir(), marker) {
  const markerPath = getMarkerPath(homeDir);
  // Pick the most-recently-extracted file for legacy {file, line} fields so
  // any older code path that still reads the v1 shape sees a coherent value.
  let latestFile = null, latestTs = 0, latestLine = 0;
  for (const [file, info] of Object.entries(marker.files || {})) {
    const ts = info?.extractedAt ? Date.parse(info.extractedAt) : 0;
    if (ts >= latestTs) { latestTs = ts; latestFile = file; latestLine = info?.line || 0; }
  }
  const payload = { files: marker.files || {} };
  if (latestFile) { payload.file = latestFile; payload.line = latestLine; }
  fs.writeFileSync(markerPath, JSON.stringify(payload));
}

function contentBlocksToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return trimText(content, 600);
  if (!Array.isArray(content)) return trimText(content.text || content.content || '', 600);
  return trimText(content.map((block) => {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join(' '), 600);
}

function parseJsonString(input) {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function normalizeToolName(name) {
  const tool = String(name || '').trim().toLowerCase();
  if (!tool) return 'Tool';
  if (tool === 'exec_command' || tool === 'write_stdin' || tool === 'run_shell_command') return 'Bash';
  if (tool === 'apply_patch' || tool === 'edit' || tool === 'replace_in_file' || tool === 'replace') return 'Edit';
  if (tool === 'write_file' || tool === 'create_file') return 'Write';
  if (tool === 'list_directory' || tool === 'glob') return 'Glob';
  if (tool === 'grep' || tool === 'grep_search' || tool === 'search_file_content') return 'Grep';
  if (tool === 'read_file') return 'Read';
  return name;
}

function summarizeToolArguments(name, args) {
  const parsed = parseJsonString(args);
  if (!parsed || typeof parsed !== 'object') return trimText(parsed, 300);
  const tool = normalizeToolName(name);
  if (tool === 'Bash') return trimText(parsed.cmd || parsed.command || parsed.chars || '', 300);
  if (tool === 'Edit') {
    const target = parsed.file_path || parsed.path || '';
    const oldStr = parsed.old_string || '';
    const newStr = parsed.new_string || parsed.content || parsed.patch || '';
    const oldSnip = oldStr ? `old="${trimText(oldStr, 80)}" ` : '';
    const newSnip = newStr ? `new="${trimText(newStr, 80)}"` : '';
    return trimText(`${target} ${oldSnip}${newSnip}`.trim(), 400);
  }
  if (tool === 'Write') {
    const target = parsed.file_path || parsed.path || '';
    const snippet = parsed.content || '';
    return trimText(`${target} ${snippet}`.trim(), 300);
  }
  if (parsed.file_path || parsed.path) return trimText(parsed.file_path || parsed.path, 300);
  return trimText(JSON.stringify(parsed), 300);
}

function formatToolCall(name, args) {
  const tool = normalizeToolName(name);
  const summary = summarizeToolArguments(name, args);
  return summary ? `ToolCall ${tool}: ${summary}` : `ToolCall ${tool}`;
}

function normalizeToolOutput(output) {
  if (!output) return '';
  let text = String(output);
  const marker = '\nOutput:\n';
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) text = text.slice(idx + marker.length);
  if (idx < 0 && text.includes('\\nOutput:\\n')) {
    text = text.split('\\nOutput:\\n').pop();
    text = text.replace(/\\n/g, '\n');
  }
  return trimText(text, 600);
}

function formatExecCommandEnd(payload) {
  if (!payload || payload.type !== 'exec_command_end') return '';
  const command = Array.isArray(payload.command) ? payload.command.join(' ') : '';
  const text = payload.aggregated_output || payload.stderr || payload.stdout || '';
  if (!text && payload.exit_code == null) return '';
  const prefix = payload.exit_code && payload.exit_code !== 0 ? `Bash exit ${payload.exit_code}` : 'Bash result';
  return trimText(`${prefix}: ${command} ${text}`.trim(), 700);
}

function buildClaudeSessionData(logPath, startLine) {
  const lines = readJsonlLines(logPath);
  const transcriptLines = [];

  for (const line of lines.slice(startLine)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const content = entry.message?.content;
    const role = entry.message?.role;
    if (!content) continue;

    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
    for (const block of blocks) {
      if (!block) continue;
      // text block — assistant narration or user message
      if (block.type === 'text' || typeof block.text === 'string') {
        const text = trimText(block.text || block.content || '', 600);
        if (!text) continue;
        const label = role === 'user' ? 'User' : 'Assistant';
        transcriptLines.push(`${label}: ${text}`);
        continue;
      }
      // tool_use block — e.g. Edit, Write, Bash calls
      if (block.type === 'tool_use' && block.name) {
        transcriptLines.push(formatToolCall(block.name, block.input));
        continue;
      }
      // tool_result block — tool output / error
      if (block.type === 'tool_result') {
        const resultContent = Array.isArray(block.content)
          ? block.content.map(c => c.text || '').filter(Boolean).join(' ')
          : String(block.content || '');
        const normalized = normalizeToolOutput(resultContent);
        if (normalized) transcriptLines.push(`ToolOutput: ${normalized}`);
      }
    }
  }

  return {
    transcript: transcriptLines.join('\n'),
    totalLines: lines.length,
    projectPath: extractProjectSlug(logPath),
  };
}

function buildCodexSessionData(logPath, startLine) {
  const lines = readJsonlLines(logPath);
  const transcriptLines = [];
  let projectPath = null;

  for (const line of lines.slice(startLine)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'session_meta') {
      projectPath = entry.payload?.cwd || projectPath;
      if (entry.payload?.cwd) {
        transcriptLines.push(`Session cwd: ${entry.payload.cwd}`);
      }
      continue;
    }

    if (entry.type === 'response_item') {
      const payload = entry.payload || {};
      if (payload.type === 'function_call') {
        transcriptLines.push(formatToolCall(payload.name, payload.arguments));
        continue;
      }
      if (payload.type === 'function_call_output') {
        const text = normalizeToolOutput(payload.output);
        if (text) transcriptLines.push(`ToolOutput: ${text}`);
        continue;
      }
      if (payload.type === 'message') {
        const text = contentBlocksToText(payload.content);
        if (!text) continue;
        const role = payload.role || 'assistant';
        const label = role.charAt(0).toUpperCase() + role.slice(1);
        transcriptLines.push(`${label}: ${text}`);
      }
      continue;
    }

    if (entry.type === 'event_msg') {
      const payload = entry.payload || {};
      if (payload.type === 'agent_message' && payload.message) {
        transcriptLines.push(`Assistant: ${trimText(payload.message, 600)}`);
        continue;
      }
      if (payload.type === 'user_message' && payload.message) {
        transcriptLines.push(`User: ${trimText(payload.message, 600)}`);
        continue;
      }
      const execLine = formatExecCommandEnd(payload);
      if (execLine) transcriptLines.push(execLine);
    }
  }

  return {
    transcript: transcriptLines.join('\n'),
    totalLines: lines.length,
    projectPath,
  };
}

function buildSessionData(session, startLine) {
  if (!session) return { transcript: '', totalLines: 0, projectPath: null };
  if (session.runtime === 'codex') return buildCodexSessionData(session.file, startLine);
  if (session.runtime === 'gemini') {
    const data = buildGeminiSessionData(session.file);
    data.projectPath = session.projectPath || null;
    return data;
  }
  // muonroi-cli uses the same JSONL shape as Claude — same parser handles it.
  return buildClaudeSessionData(session.file, startLine);
}

function countImportantSignals(transcript) {
  return String(transcript || '')
    .split('\n')
    .filter((line) => /^(User:|Assistant:|ToolCall |ToolOutput:|Bash result:|Session cwd:)/.test(line)
      || /\b(error|fail|exception|fatal|denied|timeout|unauthorized|not found)\b/i.test(line))
    .length;
}

async function maybeEvolve(homeDir = getHomeDir()) {
  try {
    const markerPath = getEvolveMarkerPath(homeDir);
    const marker = safeReadJson(markerPath, {});
    if (Date.now() - (marker.ts || 0) <= 86400000) return null;
    const { evolve } = getCore(homeDir);
    const result = await evolve('auto');
    fs.writeFileSync(markerPath, JSON.stringify({ ts: Date.now() }));
    return result;
  } catch {
    return null;
  }
}

// Inner helper used by both runStopExtractor (latest session) and
// runBackfillExtractor (every session newer than marker). Returns the
// number of lessons stored. Does NOT write the marker — callers do that
// so a backfill loop can update many entries atomically at the end.
async function extractAndStore(homeDir, session, sessionData, sourceKind) {
  const transcript = compactTranscript(sessionData.transcript);
  if (!transcript) return { count: 0, transcript: '' };

  const remote = getRemoteClient(homeDir);
  const projectPath = sessionData.projectPath || session.projectPath || null;
  let count = 0;

  if (remote && remote.isRemoteEnabled(remote.loadConfig(homeDir))) {
    const config = remote.loadConfig(homeDir);
    const extractTimeoutMs = typeof remote.getExtractTimeoutMs === 'function'
      ? remote.getExtractTimeoutMs(config)
      : undefined;
    try { await remote.flushQueue({ homeDir, config, timeoutMs: extractTimeoutMs }); } catch {}
    const body = {
      transcript,
      projectPath,
      sourceKind: sourceKind || 'stop-hook',
      sourceRuntime: session.runtime,
      sourceSession: session.file,
    };
    try {
      const enrichPath = path.join(homeDir, 'source-meta-enrich.js');
      if (fs.existsSync(enrichPath) && projectPath) {
        const enrich = require(enrichPath);
        const meta = enrich.enrichSourceMeta(null, undefined, projectPath);
        if (meta && meta.lang) body.lang = meta.lang;
        if (meta && meta.framework) body.framework = meta.framework;
      }
    } catch {}
    try {
      const result = await remote.postJson('/api/extract', body, { homeDir, config, timeoutMs: extractTimeoutMs });
      count = result?.stored || 0;
    } catch (error) {
      remote.queueRequest('POST', '/api/extract', body, { homeDir });
      try { remote.maybeSpawnExtractDrain({ homeDir, config }); } catch {}
    }
  } else {
    const { extractFromSession } = getCore(homeDir);
    count = await extractFromSession(transcript, projectPath);
  }

  return { count, transcript, projectPath };
}

function shouldExtractDelta(sessionData, startLine, minNewLines) {
  const newLines = sessionData.totalLines - startLine;
  const importantSignals = countImportantSignals(sessionData.transcript);
  const hasDenseSignal = importantSignals >= MIN_IMPORTANT_SIGNALS
    && String(sessionData.transcript || '').length >= MIN_SIGNAL_TRANSCRIPT_CHARS;
  return { ok: newLines >= minNewLines || hasDenseSignal, newLines };
}

async function runStopExtractor(options = {}) {
  // Auto-extraction disabled — user syncs manually via bulk-extract.
  // Only evolve is kept so cron-triggered evolution still works.
  const homeDir = options.homeDir || getHomeDir();
  const remote = getRemoteClient(homeDir);
  const evolveResult = (remote && remote.isRemoteEnabled(remote.loadConfig(homeDir)))
    ? null
    : await maybeEvolve(homeDir);
  return { session: null, extracted: 0, skipped: 'auto-extract-disabled', evolveResult };
}

// Backfill mode — process every session newer than its marker entry, up to
// BACKFILL_MAX_SESSIONS files (newest first). Wired into SessionStart hooks
// so sessions a STOP hook missed (X-close, /clear, /compact, crash) are
// still extracted on the next agent boot.
async function runBackfillExtractor(options = {}) {
  // Auto-extraction disabled — user syncs manually via bulk-extract.
  return { mode: 'backfill', processed: 0, skipped: 0, errors: 0, extracted: 0, sessions: [] };
}

async function main() {
  const args = process.argv.slice(2);
  const isBackfill = args.includes('--backfill') || process.env.MUONROI_EXP_MODE === 'backfill';
  const result = isBackfill ? await runBackfillExtractor() : await runStopExtractor();

  try {
    const homeDir = getHomeDir();
    const remote = getRemoteClient(homeDir);
    if (remote && remote.isRemoteEnabled(remote.loadConfig(homeDir))) {
      await maybeWarnIfStale(homeDir, remote, remote.loadConfig(homeDir));
    }
  } catch {}

  if (isBackfill) {
    if (result.processed > 0 || result.extracted > 0) {
      process.stderr.write(
        `Experience: backfill processed ${result.processed} session(s), +${result.extracted} lessons` +
        (result.skipped ? `, ${result.skipped} skipped` : '') +
        (result.errors ? `, ${result.errors} error(s)` : '') + `\n`
      );
    }
  } else if (result.extracted > 0) {
    process.stderr.write(`Experience: +${result.extracted} lessons\n`);
  }

  const evolveResult = result.evolveResult;
  if (evolveResult) {
    const total = (evolveResult.promoted || 0) + (evolveResult.abstracted || 0)
      + (evolveResult.demoted || 0) + (evolveResult.archived || 0);
    if (total > 0) {
      process.stderr.write(
        `Evolution: +${evolveResult.promoted} promoted, ${evolveResult.abstracted} abstracted, ` +
        `${evolveResult.demoted} demoted, ${evolveResult.archived} archived\n`
      );
    }
  }
}

if (require.main === module) {
  // Defer exit by one tick + a small setTimeout to let libuv finish closing
  // HTTP keep-alive sockets and pending async handles. Without this, Windows
  // Node hits "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in
  // src/win/async.c when process.exit() races with in-flight socket close.
  // process.exitCode is set instead of an immediate exit so the event loop
  // drains naturally; the setTimeout is a hard cap if a hanging socket
  // somehow blocks drain.
  main()
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
      setTimeout(() => process.exit(0), 250).unref();
    });
}

module.exports = {
  MIN_NEW_LINES,
  SESSION_MAX_AGE_MS,
  MIN_IMPORTANT_SIGNALS,
  MIN_SIGNAL_TRANSCRIPT_CHARS,
  BACKFILL_MAX_AGE_MS,
  BACKFILL_MAX_SESSIONS,
  extractProjectSlug,
  findLatestClaudeSession,
  findLatestCodexSession,
  findLatestGeminiSession,
  findCurrentSession,
  findAllRecentSessions,
  buildClaudeSessionData,
  buildCodexSessionData,
  buildGeminiSessionData,
  buildSessionData,
  countImportantSignals,
  runStopExtractor,
  runBackfillExtractor,
  readMarker,
  writeMarker,
  normalizeToolName,
  formatToolCall,
};
