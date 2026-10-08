#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compactExtractBody } = require('./extract-compact');

const {
  loadConfig,
  readQueue,
  flushQueue,
  getExtractTimeoutMs,
} = require('./remote-client');

// src/swallow.js records errors this file drops on purpose. An install that
// predates it gets silent no-ops, so a missing module never breaks the hook.
const { swallow, safeUnlink } = (() => {
  try { return require('./src/swallow'); }
  catch {
    return {
      swallow() {},
      safeUnlink(file) { try { fs.unlinkSync(file); } catch { /* best-effort */ } },
    };
  }
})();

const LOCK_TTL_MS = 60_000;
const MAX_EVENTS_PER_RUN = 5;

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getExperienceDir(homeDir = getHomeDir()) {
  return path.join(homeDir, '.experience');
}

function getTmpDir(homeDir = getHomeDir()) {
  return path.join(getExperienceDir(homeDir), 'tmp');
}

function getLockPath(homeDir = getHomeDir()) {
  return path.join(getTmpDir(homeDir), 'client-drain.lock');
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function compactQueuedExtractBodies(homeDir) {
  for (const filePath of readQueue(homeDir)) {
    const record = safeReadJson(filePath, null);
    if (!record || record.path !== '/api/extract' || !record.body) continue;
    const compactedBody = compactExtractBody(record.body);
    if (JSON.stringify(compactedBody) === JSON.stringify(record.body)) continue;
    record.body = compactedBody;
    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
    } catch (err) { swallow('exp-client-drain.persistCompacted', err); }
  }
}

function hasQueuedPath(homeDir, targetPath) {
  for (const filePath of readQueue(homeDir)) {
    const record = safeReadJson(filePath, null);
    if (record?.path === targetPath) return true;
  }
  return false;
}

function acquireLock(homeDir = getHomeDir()) {
  const tmpDir = getTmpDir(homeDir);
  const lockPath = getLockPath(homeDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const stat = fs.statSync(lockPath);
    if ((Date.now() - stat.mtimeMs) < LOCK_TTL_MS) return null;
  } catch { /* no lock file — free to take */ }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  return lockPath;
}

function releaseLock(lockPath) {
  if (!lockPath) return;
  safeUnlink(lockPath, 'exp-client-drain.releaseLock');
}

async function main() {
  const homeDir = getHomeDir();
  const config = loadConfig(homeDir);
  const extractOnly = process.argv.includes('--extract-only');
  const allowedPaths = extractOnly ? ['/api/extract'] : undefined;
  if (extractOnly && !hasQueuedPath(homeDir, '/api/extract')) return;

  const lockPath = acquireLock(homeDir);
  if (!lockPath) return;

  try {
    compactQueuedExtractBodies(homeDir);
    await flushQueue({
      homeDir,
      config,
      allowedPaths,
      limit: MAX_EVENTS_PER_RUN,
      timeoutMs: getExtractTimeoutMs(config),
    });
  } finally {
    releaseLock(lockPath);
  }
}

main().catch(() => {
  process.exitCode = 0;
});
