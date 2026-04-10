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

const { intercept, extractFromSession, evolve, getEdgesForId, getEmbeddingRaw, sharePrinciple, importPrinciple, EXP_USER, recordFeedback } = require('./.experience/experience-core');
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

async function handleGraph(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id) return error(res, 'id query parameter is required');

  const edges = getEdgesForId(id);
  const enriched = edges.map(edge => {
    const targetId = edge.source === id ? edge.target : edge.source;
    const direction = edge.source === id ? 'outgoing' : 'incoming';
    return { type: edge.type, target: targetId, weight: edge.weight, direction, createdAt: edge.createdAt };
  });

  json(res, { id, edges: enriched, count: enriched.length });
}

async function handleShare(req, res) {
  const body = await readBody(req);
  if (!body.principleId) return error(res, 'principleId is required');
  const shared = sharePrinciple(body.principleId);
  if (!shared) return error(res, 'Principle not found', 404);
  json(res, { shared, success: true });
}

async function handleImport(req, res) {
  const body = await readBody(req);
  if (!body.principle && !body.solution) return error(res, 'principle or solution is required');
  const result = await importPrinciple(body);
  if (!result) return error(res, 'Import failed (embedding unavailable)', 503);
  json(res, { imported: result, success: true });
}

async function handleFeedback(req, res) {
  const body = await readBody(req);
  if (!body.pointId) return error(res, 'pointId is required');
  if (!body.collection) return error(res, 'collection is required');
  if (typeof body.followed !== 'boolean') return error(res, 'followed (boolean) is required');
  await recordFeedback(body.collection, body.pointId, body.followed);
  json(res, { ok: true });
}

function handleUser(req, res) {
  json(res, { user: EXP_USER });
}

async function handleTimeline(req, res, url) {
  const topic = url.searchParams.get('topic');
  if (!topic) return error(res, 'topic query parameter is required');

  // Semantic search for experiences matching the topic
  const vector = await getEmbeddingRaw(topic);
  if (!vector) return error(res, 'Embedding unavailable', 503);

  // Search across all experience collections
  const collections = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
  const allResults = [];
  for (const coll of collections) {
    try {
      const fs = require('node:fs');
      const pathMod = require('node:path');
      const storeDir = pathMod.join(os.homedir(), '.experience', 'store');
      const filePath = pathMod.join(storeDir, `${coll}.json`);
      const entries = (() => { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; } })();
      for (const entry of entries) {
        if (!entry.vector || entry.vector.length !== vector.length) continue;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < vector.length; i++) { dot += vector[i] * entry.vector[i]; na += vector[i] ** 2; nb += entry.vector[i] ** 2; }
        const sim = Math.sqrt(na) * Math.sqrt(nb) === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
        if (sim > 0.5) {
          const data = (() => { try { return JSON.parse(entry.payload?.json || '{}'); } catch { return {}; } })();
          allResults.push({ id: entry.id, collection: coll, score: sim, ...data });
        }
      }
    } catch { /* skip collection */ }
  }

  // Sort by most recent confirmation (confirmedAt last entry, fallback to createdAt)
  allResults.sort((a, b) => {
    const aTime = (Array.isArray(a.confirmedAt) && a.confirmedAt.length > 0) ? new Date(a.confirmedAt[a.confirmedAt.length - 1]).getTime() : new Date(a.createdAt || 0).getTime();
    const bTime = (Array.isArray(b.confirmedAt) && b.confirmedAt.length > 0) ? new Date(b.confirmedAt[b.confirmedAt.length - 1]).getTime() : new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  // Check for supersedes edges
  const { getEdgesOfType } = require('./.experience/experience-core');
  const supersedes = getEdgesOfType('supersedes');
  const supersededIds = new Set(supersedes.map(e => e.target));

  const timeline = allResults.slice(0, 20).map(r => ({
    id: r.id,
    trigger: r.trigger,
    solution: r.solution,
    tier: r.tier,
    confirmedAt: r.confirmedAt || [],
    createdAt: r.createdAt,
    superseded: supersededIds.has(r.id),
    score: parseFloat(r.score.toFixed(3)),
  }));

  json(res, { topic, timeline, count: timeline.length });
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
    if (p === '/api/graph' && req.method === 'GET') return await handleGraph(req, res, url);
    if (p === '/api/timeline' && req.method === 'GET') return await handleTimeline(req, res, url);
    if (p === '/api/principles/share' && req.method === 'POST') return await handleShare(req, res);
    if (p === '/api/principles/import' && req.method === 'POST') return await handleImport(req, res);
    if (p === '/api/feedback' && req.method === 'POST') return await handleFeedback(req, res);
    if (p === '/api/user' && req.method === 'GET') return handleUser(req, res);
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

module.exports = { server, handleHealth, handleIntercept, handleExtract, handleEvolve, handleStats, handleGraph, handleTimeline, handleShare, handleImport, handleFeedback, handleUser };
