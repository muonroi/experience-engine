#!/usr/bin/env node
/**
 * server.js — Experience Engine REST API
 * Zero npm dependencies. Node.js 20+ built-in http module only.
 *
 * Endpoints:
 *   GET  /health         — Qdrant + FileStore status
 *   POST /api/intercept  — Query experience before tool call
 *   POST /api/extract    — Extract lessons from session transcript
 *   POST /api/evolve     — Trigger evolution cycle
 *   GET  /api/stats      — Observability data (?since=7d, ?all=true)
 *
 * Config: ~/.experience/config.json (server.port, default 8082)
 * Start: node server.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { intercept, extractFromSession, evolve } = require('./.experience/experience-core');
const { parseSince, loadEvents, filterEvents, computeStats, loadTop5 } = require('./tools/exp-stats');

// --- Config ---
const _cfg = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')
    );
  } catch { return {}; }
})();

const PORT = _cfg.server?.port || parseInt(process.env.EXP_SERVER_PORT, 10) || 8082;
const QDRANT_BASE = _cfg.qdrantUrl || process.env.EXPERIENCE_QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = _cfg.qdrantKey || process.env.EXPERIENCE_QDRANT_KEY || '';

// --- CORS headers ---
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// --- Response helpers ---
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function error(res, message, status = 400) {
  json(res, { error: message }, status);
}

// --- Body parser (1MB limit) ---
function readBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// --- Route handlers ---

async function handleHealth(req, res) {
  let qdrant = { status: 'unknown' };
  try {
    const r = await fetch(`${QDRANT_BASE}/collections`, {
      headers: QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrant = { status: r.ok ? 'ok' : 'error', code: r.status };
  } catch (e) { qdrant = { status: 'unreachable', error: e.message }; }

  const storeDir = path.join(os.homedir(), '.experience', 'store');
  let fileStore = { status: 'unknown' };
  try {
    fs.accessSync(storeDir, fs.constants.R_OK | fs.constants.W_OK);
    fileStore = { status: 'ok', path: storeDir };
  } catch { fileStore = { status: 'missing', path: storeDir }; }

  const overall = (qdrant.status === 'ok' || fileStore.status === 'ok') ? 'ok' : 'degraded';
  json(res, { status: overall, qdrant, fileStore, uptime: process.uptime() });
}

async function handleIntercept(req, res) {
  const body = await readBody(req);
  if (!body.toolName) return error(res, 'toolName is required');
  const result = await intercept(body.toolName, body.toolInput || {});
  json(res, { suggestions: result, hasSuggestions: result !== null });
}

async function handleExtract(req, res) {
  const body = await readBody(req);
  if (!body.transcript) return error(res, 'transcript is required');
  const stored = await extractFromSession(body.transcript, body.projectPath || null);
  json(res, { stored, success: true });
}

async function handleEvolve(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const results = await evolve(body.trigger || 'api');
  json(res, { ...results, success: true });
}

async function handleStats(req, res, url) {
  const logDir = path.join(os.homedir(), '.experience');
  const storeDir = path.join(logDir, 'store');

  const sinceParam = url.searchParams.get('since');
  const allTime = url.searchParams.get('all') === 'true';

  let cutoff = null;
  if (!allTime) {
    cutoff = parseSince(sinceParam || '7d') || parseSince('7d');
  }

  const allEvents = loadEvents(logDir);
  const events = filterEvents(allEvents, cutoff);
  const stats = computeStats(events);
  const top5 = loadTop5(storeDir);

  json(res, { since: allTime ? 'all' : (sinceParam || '7d'), ...stats, top5 });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/health' && req.method === 'GET') return await handleHealth(req, res);
    if (p === '/api/intercept' && req.method === 'POST') return await handleIntercept(req, res);
    if (p === '/api/extract' && req.method === 'POST') return await handleExtract(req, res);
    if (p === '/api/evolve' && req.method === 'POST') return await handleEvolve(req, res);
    if (p === '/api/stats' && req.method === 'GET') return await handleStats(req, res, url);
    error(res, 'Not found', 404);
  } catch (err) {
    error(res, err.message || 'Internal server error', 500);
  }
});

// Never crash on unhandled rejections (match experience-core.js philosophy)
process.on('unhandledRejection', () => {});

// Only start when run directly (not when required for testing)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Experience Engine API running on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

module.exports = { server, handleHealth, handleIntercept, handleExtract, handleEvolve, handleStats };
