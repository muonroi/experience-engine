#!/usr/bin/env node
/**
 * server.js — Experience Engine REST API
 * Zero npm dependencies. Node.js 20+ built-in http module only.
 *
 * Endpoints:
 *   GET  /health                    — Qdrant + FileStore status
 *   POST /api/intercept             — Query experience before tool call
 *   POST /api/posttool              — Canonical post-tool reconciliation + judge enqueue
 *   POST /api/extract               — Extract lessons from session transcript
 *   POST /api/evolve                — Trigger evolution cycle
 *   GET  /api/stats                 — Observability data (?since=7d, ?all=true)
 *   GET  /api/gates                 — Server-side readiness / gate report
 *   GET  /api/timeline?topic=...    — Semantic timeline for a topic
 *   GET  /api/graph?id=...          — Experience graph edges
 *   POST /api/feedback              — Record agent feedback verdict on suggestion
 *   POST /api/principles/share      — Export a principle
 *   POST /api/principles/import     — Import a principle
 *   GET  /api/user                  — Current user identity
 *   POST /api/route-model           — Intelligent model tier routing
 *   POST /api/route-feedback        — Record agent outcome for routing learning
 *   POST /api/brain                 — Proxy brain LLM calls (for clients behind firewall)
 *
 * Config: ~/.experience/config.json (server.port, server.authToken)
 * Start: node server.js
 */

'use strict';

const http = require('node:http');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { intercept, extractFromSession, evolve, getEdgesForId, getEdgesOfType,
        getEmbeddingRaw, searchCollection, sharePrinciple, importPrinciple,
        EXP_USER, recordFeedback, routeModel, routeFeedback,
        _reconcilePendingHints: reconcilePendingHints,
        _activityLog: activityLog } = require('./.experience/experience-core');
const { parseSince, loadEvents, filterEvents, computeStats, loadTop5 } = require('./tools/exp-stats');
const { checkGates } = require('./tools/exp-gates');

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
const AUTH_TOKEN = _cfg.server?.authToken || _cfg.serverAuthToken || null;
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);
const TMP_DIR = path.join(os.homedir(), '.experience', 'tmp');

// --- CORS headers ---
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- Auth middleware ---
// When server.authToken is set in ~/.experience/config.json, all POST endpoints
// require the matching Bearer token. GET endpoints remain open for observability tools.
function requireAuth(req, res) {
  if (!AUTH_TOKEN) return true; // no auth configured — allow all
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${AUTH_TOKEN}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

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
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
  };
  const corePath = path.join(os.homedir(), '.experience', 'experience-core.js');
  delete require.cache[require.resolve(corePath)];
  const { interceptWithMeta, intercept: interceptFresh } = require(corePath);
  const resultMeta = typeof interceptWithMeta === 'function'
    ? await interceptWithMeta(body.toolName, body.toolInput || {}, undefined, meta)
    : {
      suggestions: await interceptFresh(body.toolName, body.toolInput || {}, undefined, meta),
      surfacedIds: [],
      route: null,
    };
  const result = resultMeta?.suggestions ?? null;
  json(res, {
    suggestions: result,
    hasSuggestions: result !== null,
    surfacedIds: resultMeta?.surfacedIds || [],
    route: resultMeta?.route || null,
  });
}

function classifyPostToolOutcome(toolName, toolOutput) {
  const tool = (toolName || '').toLowerCase();
  const isMutatingTool = /edit|write|bash|shell|replace|execute_command/i.test(tool);
  if (!isMutatingTool) return null;
  const exitCode = toolOutput?.exit_code ?? toolOutput?.exitCode ?? null;
  if (exitCode !== null && exitCode !== 0) return 'error';
  const hasError = !!(
    toolOutput?.error ||
    toolOutput?.is_error ||
    (typeof toolOutput === 'string' && /^error:/i.test(toolOutput)) ||
    (toolOutput?.output && /error|Error|ERROR|FAIL|fatal|exception/i.test(String(toolOutput.output).slice(0, 500)))
  );
  return hasError ? 'error' : 'success';
}

async function handlePostTool(req, res) {
  const body = await readBody(req);
  const toolName = body.toolName || '';
  const toolInput = body.toolInput || {};
  const toolOutput = body.toolOutput || body.output || body.result || {};
  const surfacedIds = Array.isArray(body.surfacedIds) ? body.surfacedIds : [];
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
  };

  let reconcile = { touched: [], pending: [], implicitUnused: [], expired: [] };
  if (typeof reconcilePendingHints === 'function') {
    reconcile = await reconcilePendingHints(surfacedIds, toolName, toolInput, meta);
  }

  const toolOutcome = classifyPostToolOutcome(toolName, toolOutput);
  if (typeof activityLog === 'function') {
    activityLog({
      op: 'posttool',
      tool: toolName,
      surfacedCount: surfacedIds.length,
      toolOutcome,
      sourceKind: meta.sourceKind,
      sourceRuntime: meta.sourceRuntime,
      sourceSession: meta.sourceSession,
    });
  }

  if (surfacedIds.length > 0) {
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const queueFile = path.join(TMP_DIR, `judge-${Date.now()}.json`);
      fs.writeFileSync(queueFile, JSON.stringify({
        ts: new Date().toISOString(),
        surfacedIds,
        toolName,
        toolInputObj: toolInput || {},
        toolInput: JSON.stringify(toolInput || {}).slice(0, 300),
        toolOutcome,
      }));
      const workerPath = path.join(os.homedir(), '.experience', 'judge-worker.js');
      const worker = childProcess.spawn(process.execPath, [workerPath, queueFile], {
        detached: true,
        stdio: 'ignore',
      });
      worker.unref();
    } catch (spawnErr) {
      if (typeof activityLog === 'function') {
        activityLog({
          op: 'posttool-spawn-error',
          tool: toolName,
          message: spawnErr?.message || String(spawnErr),
          sourceRuntime: meta.sourceRuntime,
        });
      }
    }
  }

  json(res, { ok: true, reconcile, judgeQueued: surfacedIds.length > 0, toolOutcome });
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

async function handleGates(req, res) {
  const results = await checkGates({ homeDir: os.homedir() });
  json(res, results);
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
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim().toUpperCase() : null;
  const followed = typeof body.followed === 'boolean' ? body.followed : null;
  if (!verdict && followed === null) return error(res, 'verdict is required (or legacy followed boolean)');
  if (verdict && !VALID_FEEDBACK_VERDICTS.has(verdict)) {
    return error(res, `verdict must be one of: ${[...VALID_FEEDBACK_VERDICTS].join(', ')}`);
  }
  const normalizedReason = body.reason == null ? null : String(body.reason).trim().toLowerCase();
  if (normalizedReason && !VALID_NOISE_REASONS.has(normalizedReason)) {
    return error(res, `reason must be one of: ${[...VALID_NOISE_REASONS].join(', ')}`);
  }
  const resolvedVerdict = verdict || (followed ? 'FOLLOWED' : 'IGNORED');
  if (resolvedVerdict === 'IRRELEVANT' && !normalizedReason) {
    return error(res, 'reason is required when verdict is IRRELEVANT');
  }

  let pointId = body.pointId;
  // Support short ID prefix (8 chars) — resolve to full UUID via Qdrant scroll
  if (pointId.length < 36) {
    try {
      const scrollRes = await fetch(`${QDRANT_BASE}/collections/${body.collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}) },
        body: JSON.stringify({ limit: 100, with_payload: false }),
        signal: AbortSignal.timeout(5000),
      });
      if (scrollRes.ok) {
        const points = (await scrollRes.json()).result?.points || [];
        const match = points.find(p => String(p.id).startsWith(pointId));
        if (match) pointId = match.id;
        else return error(res, `No point found matching prefix "${pointId}" in ${body.collection}`, 404);
      } else {
        return error(res, 'Failed to resolve short ID — Qdrant unavailable', 503);
      }
    } catch {
      return error(res, 'Failed to resolve short ID — provide full UUID', 400);
    }
  }

  await recordFeedback(body.collection, pointId, resolvedVerdict, normalizedReason);
  json(res, { ok: true, resolvedId: pointId, verdict: resolvedVerdict, ...(normalizedReason ? { reason: normalizedReason } : {}) });
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

  // Search across all experience collections using the canonical searchCollection helper
  const collections = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
  const allResults = [];
  for (const coll of collections) {
    try {
      const hits = await searchCollection(coll, vector, 20);
      for (const hit of hits) {
        if ((hit.score || 0) < 0.5) continue;
        const data = (() => { try { return JSON.parse(hit.payload?.json || '{}'); } catch { return {}; } })();
        allResults.push({ id: hit.id, collection: coll, score: hit.score, ...data });
      }
    } catch { /* skip collection */ }
  }

  // Sort by most recent confirmation (confirmedAt last entry, fallback to createdAt)
  allResults.sort((a, b) => {
    const aTime = (Array.isArray(a.confirmedAt) && a.confirmedAt.length > 0) ? new Date(a.confirmedAt[a.confirmedAt.length - 1]).getTime() : new Date(a.createdAt || 0).getTime();
    const bTime = (Array.isArray(b.confirmedAt) && b.confirmedAt.length > 0) ? new Date(b.confirmedAt[b.confirmedAt.length - 1]).getTime() : new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  // Filter out superseded experiences
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

const VALID_OUTCOMES = new Set(['success', 'fail', 'retry', 'cancelled']);
const KNOWN_RUNTIMES = new Set(['claude', 'gemini', 'codex', 'opencode']);

async function handleRouteModel(req, res) {
  const body = await readBody(req);
  if (!body.task || typeof body.task !== 'string') return error(res, 'task is required and must be a string');
  if (body.task.length > 2000) return error(res, 'task must be 2000 characters or less');
  if (body.runtime !== undefined && body.runtime !== null && !KNOWN_RUNTIMES.has(body.runtime)) {
    return error(res, `runtime must be one of: ${[...KNOWN_RUNTIMES].join(', ')}, or null`);
  }
  const result = await routeModel(body.task, body.context || null, body.runtime || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': result.source || 'default', ...CORS });
  res.end(JSON.stringify(result));
}

async function handleRouteFeedback(req, res) {
  const body = await readBody(req);
  if (!body.taskHash || typeof body.taskHash !== 'string') return error(res, 'taskHash is required');
  if (!body.outcome) return error(res, 'outcome is required');
  if (!VALID_OUTCOMES.has(body.outcome)) {
    return error(res, `outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}`);
  }
  const ok = await routeFeedback(body.taskHash, body.tier || null, body.model || null, body.outcome, body.retryCount || 0, body.duration || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': 'feedback', ...CORS });
  res.end(JSON.stringify({ ok }));
}

// --- Brain Proxy (allows local clients to reach SiliconFlow via VPS) ---

async function handleBrainProxy(req, res) {
  const body = await readBody(req);
  if (!body.prompt) return error(res, 'prompt is required');
  const timeoutMs = body.timeoutMs || 8000;
  try {
    const { classifyViaBrain } = require(path.join(os.homedir(), '.experience', 'experience-core.js'));
    const result = await classifyViaBrain(body.prompt, timeoutMs);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: false, error: err.message || 'brain call failed' }));
  }
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
    // GET endpoints — open (no auth required)
    if (p === '/health' && req.method === 'GET') return await handleHealth(req, res);
    if (p === '/api/stats' && req.method === 'GET') return await handleStats(req, res, url);
    if (p === '/api/gates' && req.method === 'GET') return await handleGates(req, res);
    if (p === '/api/graph' && req.method === 'GET') return await handleGraph(req, res, url);
    if (p === '/api/timeline' && req.method === 'GET') return await handleTimeline(req, res, url);
    if (p === '/api/user' && req.method === 'GET') return handleUser(req, res);

    // POST endpoints — require Bearer token when server.authToken is configured
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      if (p === '/api/intercept') return await handleIntercept(req, res);
      if (p === '/api/posttool') return await handlePostTool(req, res);
      if (p === '/api/extract') return await handleExtract(req, res);
      if (p === '/api/evolve') return await handleEvolve(req, res);
      if (p === '/api/principles/share') return await handleShare(req, res);
      if (p === '/api/principles/import') return await handleImport(req, res);
      if (p === '/api/feedback') return await handleFeedback(req, res);
      if (p === '/api/route-model') return await handleRouteModel(req, res);
      if (p === '/api/route-feedback') return await handleRouteFeedback(req, res);
      if (p === '/api/brain') return await handleBrainProxy(req, res);
    }

    error(res, 'Not found', 404);
  } catch (err) {
    error(res, err.message || 'Internal server error', 500);
  }
});

// Log unhandled rejections instead of crashing — but never swallow silently
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  try { require('node:fs').appendFileSync(require('node:path').join(require('node:os').homedir(), '.experience', 'server-errors.log'), `[${new Date().toISOString()}] UnhandledRejection: ${msg}\n`); } catch {}
  console.error(`[Experience Engine] UnhandledRejection: ${msg}`);
});

// Only start when run directly (not when required for testing)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Experience Engine API running on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

module.exports = { server, handleHealth, handleIntercept, handlePostTool, handleExtract, handleEvolve, handleStats, handleGates, handleGraph, handleTimeline, handleShare, handleImport, handleFeedback, handleUser, handleRouteModel, handleRouteFeedback };
