#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compactTranscript } = require('./extract-compact');

const MIN_NEW_LINES = 8;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000;

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

function findCurrentSession(homeDir = getHomeDir(), now = Date.now()) {
  const candidates = [
    findLatestClaudeSession(homeDir, now),
    findLatestCodexSession(homeDir, now),
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
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
  if (tool === 'exec_command' || tool === 'write_stdin') return 'Bash';
  if (tool === 'apply_patch' || tool === 'edit' || tool === 'replace_in_file') return 'Edit';
  if (tool === 'write_file' || tool === 'create_file') return 'Write';
  return name;
}

function summarizeToolArguments(name, args) {
  const parsed = parseJsonString(args);
  if (!parsed || typeof parsed !== 'object') return trimText(parsed, 300);
  const tool = normalizeToolName(name);
  if (tool === 'Bash') return trimText(parsed.cmd || parsed.command || parsed.chars || '', 300);
  if (tool === 'Edit') {
    const target = parsed.file_path || parsed.path || '';
    const snippet = parsed.new_string || parsed.content || parsed.patch || '';
    return trimText(`${target} ${snippet}`.trim(), 300);
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
  const transcript = lines.slice(startLine).map((line) => {
    try {
      const entry = JSON.parse(line);
      return contentBlocksToText(entry.message?.content);
    } catch {
      return '';
    }
  }).filter(Boolean).join('\n');
  return {
    transcript,
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
  return buildClaudeSessionData(session.file, startLine);
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

async function runStopExtractor(options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const now = options.now || Date.now();
  const minNewLines = options.minNewLines || MIN_NEW_LINES;
  const markerPath = getMarkerPath(homeDir);
  const session = findCurrentSession(homeDir, now);
  if (!session) {
    return { session: null, extracted: 0, skipped: 'no-session' };
  }

  const marker = safeReadJson(markerPath, {});
  const startLine = marker.file === session.file ? (marker.line || 0) : 0;
  const sessionData = buildSessionData(session, startLine);
  const newLines = sessionData.totalLines - startLine;
  if (newLines < minNewLines) {
    return { session, extracted: 0, skipped: 'not-enough-new-lines', newLines };
  }

  const transcript = compactTranscript(sessionData.transcript);
  if (!transcript) {
    return { session, extracted: 0, skipped: 'empty-transcript', newLines };
  }

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
      sourceKind: 'stop-hook',
      sourceRuntime: session.runtime,
      sourceSession: session.file,
    };
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
  fs.writeFileSync(markerPath, JSON.stringify({ file: session.file, line: sessionData.totalLines }));

  const evolveResult = (remote && remote.isRemoteEnabled(remote.loadConfig(homeDir)))
    ? null
    : await maybeEvolve(homeDir);
  return {
    session,
    extracted: count,
    transcript,
    projectPath,
    evolveResult,
  };
}

async function main() {
  const result = await runStopExtractor();
  if (result.extracted > 0) {
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
  main().catch(() => {}).finally(() => process.exit(0));
}

module.exports = {
  MIN_NEW_LINES,
  SESSION_MAX_AGE_MS,
  extractProjectSlug,
  findLatestClaudeSession,
  findLatestCodexSession,
  findCurrentSession,
  buildClaudeSessionData,
  buildCodexSessionData,
  buildSessionData,
  runStopExtractor,
  normalizeToolName,
  formatToolCall,
};
