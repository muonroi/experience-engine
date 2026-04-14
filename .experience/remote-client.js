#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_HOOK_TIMEOUT_MS = 1200;
const DEFAULT_HOOK_FLUSH_TIMEOUT_MS = 150;
const DEFAULT_HOOK_FLUSH_LIMIT = 1;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60000;
const DEFAULT_FLUSH_LIMIT = 10;
let queueSeq = 0;

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getExperienceDir(homeDir = getHomeDir()) {
  return path.join(homeDir, '.experience');
}

function getConfigPath(homeDir = getHomeDir()) {
  return path.join(getExperienceDir(homeDir), 'config.json');
}

function getQueueDir(homeDir = getHomeDir()) {
  return path.join(getExperienceDir(homeDir), 'offline-queue');
}

function getTmpDir(homeDir = getHomeDir()) {
  return path.join(getExperienceDir(homeDir), 'tmp');
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig(homeDir = getHomeDir()) {
  return safeReadJson(getConfigPath(homeDir), {});
}

function getServerBaseUrl(config = loadConfig()) {
  const raw = String(config.serverBaseUrl || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function isRemoteEnabled(config = loadConfig()) {
  return !!getServerBaseUrl(config);
}

function getServerAuthToken(config = loadConfig()) {
  return String(config.serverAuthToken || '').trim();
}

function getRemoteTimeoutMs(config = loadConfig()) {
  const timeoutMs = Number(config.serverTimeoutMs || 0);
  return timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function getHookTimeoutMs(config = loadConfig()) {
  const timeoutMs = Number(config.serverHookTimeoutMs || 0);
  if (timeoutMs > 0) return timeoutMs;
  return Math.min(getRemoteTimeoutMs(config), DEFAULT_HOOK_TIMEOUT_MS);
}

function getExtractTimeoutMs(config = loadConfig()) {
  const timeoutMs = Number(config.serverExtractTimeoutMs || 0);
  if (timeoutMs > 0) return timeoutMs;
  return Math.max(getRemoteTimeoutMs(config), DEFAULT_EXTRACT_TIMEOUT_MS);
}

function buildHeaders(config = loadConfig(), extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = getServerAuthToken(config);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestJson(method, requestPath, body, options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const config = options.config || loadConfig(homeDir);
  const baseUrl = options.baseUrl || getServerBaseUrl(config);
  if (!baseUrl) {
    throw new Error('remote serverBaseUrl is not configured');
  }

  const headers = buildHeaders(config, options.headers || {});
  let payload;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(options.timeoutMs || getRemoteTimeoutMs(config)),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(json?.error || text || `${method} ${requestPath} failed`);
    error.status = res.status;
    error.body = json;
    throw error;
  }

  return json;
}

function queueRequest(method, requestPath, body, options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const queueDir = getQueueDir(homeDir);
  fs.mkdirSync(queueDir, { recursive: true });
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    method,
    path: requestPath,
    body,
    attempts: 0,
  };
  queueSeq = (queueSeq + 1) % 1_000_000;
  const seq = String(queueSeq).padStart(6, '0');
  const filePath = path.join(queueDir, `${Date.now()}-${seq}-${record.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { filePath, record };
}

function readQueue(homeDir = getHomeDir()) {
  const queueDir = getQueueDir(homeDir);
  if (!fs.existsSync(queueDir)) return [];
  const files = fs.readdirSync(queueDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.map((name) => path.join(queueDir, name));
}

async function flushQueue(options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const allowedPaths = Array.isArray(options.allowedPaths) && options.allowedPaths.length > 0
    ? new Set(options.allowedPaths)
    : null;
  const files = readQueue(homeDir);
  const results = { sent: 0, remaining: readQueue(homeDir).length, failed: [] };
  let processed = 0;

  for (const filePath of files) {
    if (processed >= (options.limit || DEFAULT_FLUSH_LIMIT)) break;
    const record = safeReadJson(filePath, null);
    if (!record || !record.method || !record.path) {
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }
    if (allowedPaths && !allowedPaths.has(record.path)) {
      continue;
    }
    try {
      await requestJson(record.method, record.path, record.body, options);
      try { fs.unlinkSync(filePath); } catch {}
      results.sent++;
      processed++;
    } catch (error) {
      record.attempts = (record.attempts || 0) + 1;
      record.lastError = error.message || String(error);
      record.lastTriedAt = new Date().toISOString();
      try { fs.writeFileSync(filePath, JSON.stringify(record, null, 2)); } catch {}
      results.failed.push({ file: path.basename(filePath), error: record.lastError });
      break;
    }
  }

  results.remaining = readQueue(homeDir).length;
  return results;
}

async function postJson(requestPath, body, options = {}) {
  return requestJson('POST', requestPath, body, options);
}

async function flushQueueForHook(options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const config = options.config || loadConfig(homeDir);
  return flushQueue({
    ...options,
    homeDir,
    config,
    limit: options.limit || DEFAULT_HOOK_FLUSH_LIMIT,
    timeoutMs: options.timeoutMs || getHookTimeoutMs(config) || DEFAULT_HOOK_FLUSH_TIMEOUT_MS,
    allowedPaths: options.allowedPaths || ['/api/posttool', '/api/feedback', '/api/route-feedback'],
  });
}

async function postJsonForHook(requestPath, body, options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const config = options.config || loadConfig(homeDir);
  return postJson(requestPath, body, {
    ...options,
    homeDir,
    config,
    timeoutMs: options.timeoutMs || getHookTimeoutMs(config),
  });
}

function maybeSpawnExtractDrain(options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const queueDir = getQueueDir(homeDir);
  if (!fs.existsSync(queueDir)) return false;

  const hasExtract = fs.readdirSync(queueDir)
    .filter((name) => name.endsWith('.json'))
    .some((name) => {
      const record = safeReadJson(path.join(queueDir, name), null);
      return record?.path === '/api/extract';
    });
  if (!hasExtract) return false;

  const tmpDir = getTmpDir(homeDir);
  const lockPath = path.join(tmpDir, 'client-drain.lock');
  try {
    const stat = fs.statSync(lockPath);
    if ((Date.now() - stat.mtimeMs) < 60_000) return false;
  } catch {}

  const scriptPath = path.join(getExperienceDir(homeDir), 'exp-client-drain.js');
  const compactPath = path.join(getExperienceDir(homeDir), 'extract-compact.js');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(compactPath)) return false;

  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(process.execPath, [scriptPath, '--extract-only'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  });
  child.unref();
  return true;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_HOOK_FLUSH_TIMEOUT_MS,
  DEFAULT_HOOK_FLUSH_LIMIT,
  DEFAULT_EXTRACT_TIMEOUT_MS,
  DEFAULT_FLUSH_LIMIT,
  loadConfig,
  getServerBaseUrl,
  getServerAuthToken,
  getRemoteTimeoutMs,
  getHookTimeoutMs,
  getExtractTimeoutMs,
  isRemoteEnabled,
  requestJson,
  postJson,
  postJsonForHook,
  queueRequest,
  readQueue,
  flushQueue,
  flushQueueForHook,
  maybeSpawnExtractDrain,
  getQueueDir,
};
