#!/usr/bin/env node
/**
 * server.js — Experience Engine REST API
 * Zero npm dependencies. Node.js 20+ built-in http module only.
 *
 * Endpoints:
 *   GET  /health                    — Qdrant + FileStore status
 *   POST /api/intercept             — Query experience before tool call
 *   POST /api/posttool              — Canonical post-tool reconciliation + judge enqueue
 *   POST /api/prompt-stale          — Reconcile stale prompt-only suggestions
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
 *   POST /api/route-task            — Intelligent wrapper task routing
 *   POST /api/route-model           — Intelligent model tier routing
 *   POST /api/route-feedback        — Record agent outcome for routing learning
 *   POST /api/brain                 — Proxy brain LLM calls (for clients behind firewall)
 *   POST /api/phase-outcome         — GSD phase-grain reinforcement (gated by ENABLE_PHASE_OUTCOME=1)
 *
 * Config: ~/.experience/config.json (server.port, server.authToken, server.readAuthToken)
 * Start: node server.js
 */

'use strict';

const http = require('node:http');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseSince, loadEvents, filterEvents, computeStats, loadTop5 } = require('./tools/exp-stats');
const { checkGates } = require('./tools/exp-gates');
const { validateBody } = require('./.experience/src/validate');

// --- Structured logger (zero-dep) ---
function slog(level, msg, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  process[level === 'error' ? 'stderr' : 'stdout'].write(entry + '\n');
}

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
const READ_AUTH_TOKEN = _cfg.server?.readAuthToken || _cfg.serverReadAuthToken || process.env.EXPERIENCE_SERVER_READ_AUTH_TOKEN || null;
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);
const TMP_DIR = path.join(os.homedir(), '.experience', 'tmp');
const PACKAGED_RUNTIME_DIR = path.join(__dirname, '.experience');
const HOME_RUNTIME_DIR = path.join(os.homedir(), '.experience');
const RUNTIME_DIR = fs.existsSync(path.join(PACKAGED_RUNTIME_DIR, 'experience-core.js'))
  ? PACKAGED_RUNTIME_DIR
  : HOME_RUNTIME_DIR;
const RUNTIME_CORE_PATH = path.join(RUNTIME_DIR, 'experience-core.js');
const RUNTIME_JUDGE_WORKER_PATH = path.join(RUNTIME_DIR, 'judge-worker.js');

// --- Rate limiting (token bucket per IP) ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = _cfg.server?.rateLimit || 120;
const _rateBuckets = new Map();

function rateLimit(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    _rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count));
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return true;
  }
  return false;
}

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of _rateBuckets) {
    if (bucket.windowStart < cutoff) _rateBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// --- CORS headers ---
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- Auth middleware ---
// When server.authToken is set, writes and sensitive reads require the full token.
// Optionally, server.readAuthToken may authorize read-only observability endpoints.
function requireAuth(req, res, options = {}) {
  const allowReadToken = options.allowReadToken === true;
  const acceptedTokens = [];
  if (AUTH_TOKEN) acceptedTokens.push(AUTH_TOKEN);
  if (allowReadToken && READ_AUTH_TOKEN) acceptedTokens.push(READ_AUTH_TOKEN);
  if (acceptedTokens.length === 0) return true; // no auth configured — allow all
  const hdr = req.headers['authorization'] || '';
  if (acceptedTokens.some(token => hdr === `Bearer ${token}`)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function loadExperienceCore({ fresh = false } = {}) {
  if (fresh) delete require.cache[require.resolve(RUNTIME_CORE_PATH)];
  return require(RUNTIME_CORE_PATH);
}

function isProtectedGetPath(pathname) {
  return pathname !== '/health';
}

function isReadOnlyApiPath(pathname) {
  return pathname === '/api/stats' || pathname === '/api/gates';
}

async function resolvePointIdPrefix(collection, pointId) {
  let offset = null;

  for (;;) {
    const body = { limit: 100, with_payload: false };
    if (offset !== null) body.offset = offset;

    const scrollRes = await fetch(`${QDRANT_BASE}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!scrollRes.ok) return { ok: false, reason: 'unavailable' };

    const result = (await scrollRes.json()).result || {};
    const points = Array.isArray(result.points) ? result.points : [];
    const match = points.find(point => String(point.id).startsWith(pointId));
    if (match) return { ok: true, id: match.id };

    if (!('next_page_offset' in result) || result.next_page_offset == null || points.length === 0) {
      return { ok: true, id: null };
    }
    offset = result.next_page_offset;
  }
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

// --- Health degradation tracking (G14) ---
const _healthState = {
  qdrantConsecutiveFailures: 0,
  embedConsecutiveFailures: 0,
  lastQdrantOk: null,
  lastEmbedOk: null,
  lastQdrantError: null,
  lastEmbedError: null,
};

// --- Server commit fingerprint (computed once at startup) ---
const _serverVersionInfo = (() => {
  const { execSync } = require('child_process');
  const out = { commit: 'unknown', commitDate: null, version: '3.2' };
  try {
    const repoDir = __dirname;
    out.commit = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().slice(0, 12);
    out.commitDate = execSync('git log -1 --format=%cI', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* not a git checkout — keep defaults */ }
  if (process.env.EE_COMMIT) out.commit = String(process.env.EE_COMMIT).slice(0, 12);
  return out;
})();

// Rate-limited per-client stale logging. Keys: short commit hash from the
// X-EE-Client-Commit header. Value: last-logged epoch ms. Caps to avoid noise.
const _staleClientLogMap = new Map();
const STALE_LOG_COOLDOWN_MS = 6 * 60 * 60 * 1000;  // log a given stale client at most every 6h

function _maybeLogStaleClient(req) {
  // Skip introspection requests so /api/version isn't itself a noise source.
  const url = req.url || '';
  if (url.startsWith('/api/version') || url.startsWith('/health') || url.startsWith('/metrics')) return;
  const headerCommit = String(req.headers['x-ee-client-commit'] || '').trim().slice(0, 12);
  const serverCommit = _serverVersionInfo.commit;
  if (serverCommit === 'unknown') return;  // can't compare
  const key = headerCommit || '(none)';
  if (key === serverCommit) return;
  const last = _staleClientLogMap.get(key) || 0;
  const now = Date.now();
  if (now - last < STALE_LOG_COOLDOWN_MS) return;
  _staleClientLogMap.set(key, now);
  if (_staleClientLogMap.size > 64) {
    // Evict oldest half to bound memory under header-spoof / churn.
    const sorted = [..._staleClientLogMap.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, _staleClientLogMap.size / 2)) _staleClientLogMap.delete(k);
  }
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    msg: 'stale_client',
    clientCommit: key,
    serverCommit,
    path: url.split('?')[0],
  }));
}

function handleVersion(req, res) {
  json(res, {
    ..._serverVersionInfo,
    timestamp: new Date().toISOString(),
  });
}

async function handleHealth(req, res) {
  let qdrant = { status: 'unknown' };
  try {
    const r = await fetch(`${QDRANT_BASE}/collections`, {
      headers: QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrant = { status: r.ok ? 'ok' : 'error', code: r.status };
    if (r.ok) {
      _healthState.qdrantConsecutiveFailures = 0;
      _healthState.lastQdrantOk = new Date().toISOString();
    } else {
      _healthState.qdrantConsecutiveFailures++;
      _healthState.lastQdrantError = new Date().toISOString();
    }
  } catch (e) {
    qdrant = { status: 'unreachable', error: e.message };
    _healthState.qdrantConsecutiveFailures++;
    _healthState.lastQdrantError = new Date().toISOString();
  }

  // Embed health: check last 10 cost-call entries from activity log
  let embed = { status: 'unknown' };
  try {
    const activityPath = path.join(os.homedir(), '.experience', 'activity.jsonl');
    const lines = fs.readFileSync(activityPath, 'utf8').trim().split('\n').slice(-50);
    const embedCalls = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.op === 'cost-call' && e.kind === 'embed')
      .slice(-10);
    if (embedCalls.length > 0) {
      const failures = embedCalls.filter(e => !e.ok).length;
      const failRate = failures / embedCalls.length;
      embed = {
        status: failRate > 0.5 ? 'degraded' : failRate > 0 ? 'warn' : 'ok',
        recentFailRate: Math.round(failRate * 100) + '%',
        lastProvider: embedCalls[embedCalls.length - 1]?.provider || 'unknown',
      };
      if (failRate > 0.5) {
        _healthState.embedConsecutiveFailures++;
        _healthState.lastEmbedError = new Date().toISOString();
      } else {
        _healthState.embedConsecutiveFailures = 0;
        _healthState.lastEmbedOk = new Date().toISOString();
      }
    }
  } catch { embed = { status: 'no-data' }; }

  const storeDir = path.join(os.homedir(), '.experience', 'store');
  let fileStore = { status: 'unknown' };
  try {
    fs.accessSync(storeDir, fs.constants.R_OK | fs.constants.W_OK);
    fileStore = { status: 'ok', path: storeDir };
  } catch { fileStore = { status: 'missing', path: storeDir }; }

  const degraded = qdrant.status !== 'ok' && fileStore.status !== 'ok';
  const overall = degraded ? 'degraded' : (embed.status === 'degraded' ? 'warn' : 'ok');
  const alerts = [];
  if (_healthState.qdrantConsecutiveFailures >= 3) alerts.push('Qdrant unreachable for 3+ checks');
  if (_healthState.embedConsecutiveFailures >= 3) alerts.push('Embed provider degraded for 3+ checks');
  json(res, { status: overall, qdrant, embed, fileStore, uptime: process.uptime(), ...(alerts.length > 0 ? { alerts } : {}) });
}

// --- Prometheus-style metrics endpoint (G13) ---
function handleMetrics(req, res) {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const lines = [];
  lines.push(`# HELP experience_uptime_seconds Server uptime in seconds`);
  lines.push(`# TYPE experience_uptime_seconds gauge`);
  lines.push(`experience_uptime_seconds ${uptime.toFixed(1)}`);
  lines.push(`# HELP experience_memory_rss_bytes Resident set size`);
  lines.push(`# TYPE experience_memory_rss_bytes gauge`);
  lines.push(`experience_memory_rss_bytes ${mem.rss}`);
  lines.push(`# HELP experience_memory_heap_used_bytes Heap used`);
  lines.push(`# TYPE experience_memory_heap_used_bytes gauge`);
  lines.push(`experience_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push(`# HELP experience_rate_limit_buckets Active rate limit buckets`);
  lines.push(`# TYPE experience_rate_limit_buckets gauge`);
  lines.push(`experience_rate_limit_buckets ${_rateBuckets.size}`);
  lines.push(`# HELP experience_qdrant_consecutive_failures Qdrant consecutive failures`);
  lines.push(`# TYPE experience_qdrant_consecutive_failures gauge`);
  lines.push(`experience_qdrant_consecutive_failures ${_healthState.qdrantConsecutiveFailures}`);
  lines.push(`# HELP experience_embed_consecutive_failures Embed provider consecutive failures`);
  lines.push(`# TYPE experience_embed_consecutive_failures gauge`);
  lines.push(`experience_embed_consecutive_failures ${_healthState.embedConsecutiveFailures}`);

  // Activity-based counters from JSONL
  let intercepts = 0, suggestions = 0, feedbacks = 0, evolves = 0, embedOk = 0, embedFail = 0;
  try {
    const activityPath = path.join(os.homedir(), '.experience', 'activity.jsonl');
    const lines24h = fs.readFileSync(activityPath, 'utf8').trim().split('\n').slice(-500);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const l of lines24h) {
      try {
        const e = JSON.parse(l);
        const ts = new Date(e.ts).getTime();
        if (ts < cutoff) continue;
        if (e.op === 'intercept') intercepts++;
        if (e.op === 'intercept' && e.surfacedCount > 0) suggestions++;
        if (e.op === 'judge-verdict') feedbacks++;
        if (e.op === 'evolve') evolves++;
        if (e.op === 'cost-call' && e.kind === 'embed' && e.ok) embedOk++;
        if (e.op === 'cost-call' && e.kind === 'embed' && !e.ok) embedFail++;
      } catch {}
    }
  } catch {}
  lines.push(`# HELP experience_intercepts_24h Intercepts in last 24h`);
  lines.push(`# TYPE experience_intercepts_24h gauge`);
  lines.push(`experience_intercepts_24h ${intercepts}`);
  lines.push(`# HELP experience_suggestions_24h Suggestions surfaced in last 24h`);
  lines.push(`# TYPE experience_suggestions_24h gauge`);
  lines.push(`experience_suggestions_24h ${suggestions}`);
  lines.push(`# HELP experience_feedbacks_24h Judge feedbacks in last 24h`);
  lines.push(`# TYPE experience_feedbacks_24h gauge`);
  lines.push(`experience_feedbacks_24h ${feedbacks}`);
  lines.push(`# HELP experience_evolves_24h Evolution cycles in last 24h`);
  lines.push(`# TYPE experience_evolves_24h gauge`);
  lines.push(`experience_evolves_24h ${evolves}`);
  lines.push(`# HELP experience_embed_ok_24h Successful embed calls in last 24h`);
  lines.push(`# TYPE experience_embed_ok_24h gauge`);
  lines.push(`experience_embed_ok_24h ${embedOk}`);
  lines.push(`# HELP experience_embed_fail_24h Failed embed calls in last 24h`);
  lines.push(`# TYPE experience_embed_fail_24h gauge`);
  lines.push(`experience_embed_fail_24h ${embedFail}`);

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', ...CORS });
  res.end(lines.join('\n') + '\n');
}

async function handleIntercept(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { toolName: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
  };
  // skipRoute=true lets latency-sensitive callers (e.g. CLI hook fast-path)
  // bypass the model-routing side-effect of intercept and only get suggestions.
  const options = { skipRoute: !!body.skipRoute };
  const { interceptWithMeta, intercept: interceptFresh } = loadExperienceCore();
  const resultMeta = typeof interceptWithMeta === 'function'
    ? await interceptWithMeta(body.toolName, body.toolInput || {}, undefined, meta, options)
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
  const v = validateBody(body, { toolName: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const core = loadExperienceCore();
  const reconcilePendingHints = core._reconcilePendingHints;
  const activityLog = core._activityLog;
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
      const worker = childProcess.spawn(process.execPath, [RUNTIME_JUDGE_WORKER_PATH, queueFile], {
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

async function handlePromptStale(req, res) {
  const body = await readBody(req);
  const core = loadExperienceCore();
  const reconcileStalePromptSuggestions = core._reconcileStalePromptSuggestions;
  const empty = { ok: true, unused: [], irrelevant: [], expired: [] };
  if (typeof reconcileStalePromptSuggestions !== 'function') {
    return json(res, empty);
  }
  const result = await reconcileStalePromptSuggestions(body.state || {}, body.nextPromptMeta || {});
  json(res, {
    ok: result?.ok !== false,
    unused: result?.unused || [],
    irrelevant: result?.irrelevant || [],
    expired: result?.expired || [],
  });
}

async function handleExtract(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { transcript: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const { extractFromSession } = loadExperienceCore();
  const stored = await extractFromSession(body.transcript, body.projectPath || null, {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    framework: typeof body.framework === 'string' ? body.framework : null,
    lang: typeof body.lang === 'string' ? body.lang : null,
  });
  json(res, { stored, success: true });
}

async function handleEvolve(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const { evolve } = loadExperienceCore();
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

  const { getEdgesForId } = loadExperienceCore();
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
  const v = validateBody(body, { principleId: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const { sharePrinciple } = loadExperienceCore();
  const shared = sharePrinciple(body.principleId);
  if (!shared) return error(res, 'Principle not found', 404);
  json(res, { shared, success: true });
}

async function handleImport(req, res) {
  const body = await readBody(req);
  if (!body.principle && !body.solution) return error(res, 'principle or solution is required');
  const { importPrinciple } = loadExperienceCore();
  const result = await importPrinciple(body);
  if (!result) return error(res, 'Import failed (embedding unavailable)', 503);
  json(res, { imported: result, success: true });
}

async function handleFeedback(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    pointId: { type: 'string', required: true },
    collection: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);
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
      const resolved = await resolvePointIdPrefix(body.collection, pointId);
      if (!resolved.ok) {
        return error(res, 'Failed to resolve short ID — Qdrant unavailable', 503);
      }
      if (!resolved.id) {
        return error(res, `No point found matching prefix "${pointId}" in ${body.collection}`, 404);
      }
      pointId = resolved.id;
    } catch {
      return error(res, 'Failed to resolve short ID — provide full UUID', 400);
    }
  }
  const { recordFeedback } = loadExperienceCore();
  await recordFeedback(body.collection, pointId, resolvedVerdict, normalizedReason);
  json(res, { ok: true, resolvedId: pointId, verdict: resolvedVerdict, ...(normalizedReason ? { reason: normalizedReason } : {}) });
}

function handleUser(req, res) {
  const { EXP_USER } = loadExperienceCore();
  json(res, { user: EXP_USER });
}

async function handleTimeline(req, res, url) {
  const topic = url.searchParams.get('topic');
  if (!topic) return error(res, 'topic query parameter is required');

  const { getEmbeddingRaw, searchCollection, getEdgesOfType } = loadExperienceCore();
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

const KNOWN_COLLECTIONS = new Set(['experience-behavioral', 'experience-principles']);

async function handleSearch(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.query || typeof body.query !== 'string') return error(res, 'query is required');
  const limit = Math.min(body.limit || 5, 20);

  // Accept optional `collections: string[]` for thin-client multi-collection queries.
  // Backwards-compat: omitted → ['experience-behavioral'].
  let collections;
  if (Array.isArray(body.collections) && body.collections.length > 0) {
    collections = body.collections.filter((c) => typeof c === 'string' && KNOWN_COLLECTIONS.has(c));
    if (collections.length === 0) return error(res, `collections must be a subset of: ${[...KNOWN_COLLECTIONS].join(', ')}`);
  } else {
    collections = ['experience-behavioral'];
  }

  const { getEmbeddingRaw, searchCollection } = loadExperienceCore();
  const vector = await getEmbeddingRaw(body.query, AbortSignal.timeout(2000));
  if (!vector) return error(res, 'Embedding unavailable', 503);

  const results = await Promise.all(collections.map((c) => searchCollection(c, vector, limit)));
  const mapped = [];
  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    for (const p of results[i] || []) {
      const payload = p.payload || {};
      const json = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
      mapped.push({ id: p.id, score: p.score, text: payload.text || json.solution || '', collection });
    }
  }

  json(res, { points: mapped });
}

const PIL_CONTEXT_CACHE = new Map(); // key → { value, expiresAt }
const PIL_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const PIL_CONTEXT_CACHE_MAX = 200;

function pilCacheKey(prompt, locale) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${locale || ''}\0${prompt}`).digest('hex');
}

function pilCacheGet(key) {
  const entry = PIL_CONTEXT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { PIL_CONTEXT_CACHE.delete(key); return null; }
  // refresh LRU order
  PIL_CONTEXT_CACHE.delete(key);
  PIL_CONTEXT_CACHE.set(key, entry);
  return entry.value;
}

function pilCacheSet(key, value) {
  if (PIL_CONTEXT_CACHE.size >= PIL_CONTEXT_CACHE_MAX) {
    const oldest = PIL_CONTEXT_CACHE.keys().next().value;
    PIL_CONTEXT_CACHE.delete(oldest);
  }
  PIL_CONTEXT_CACHE.set(key, { value, expiresAt: Date.now() + PIL_CONTEXT_CACHE_TTL_MS });
}

async function handlePilContext(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.prompt || typeof body.prompt !== 'string') {
    return error(res, 'prompt is required');
  }
  if (body.prompt.length > 10_000) {
    return error(res, 'prompt exceeds 10KB');
  }

  const cacheKey = pilCacheKey(body.prompt, body.locale_hint);
  const cached = pilCacheGet(cacheKey);
  if (cached) {
    return json(res, { ...cached, cache_hit: true, inference_ms: 0 });
  }

  const startMs = Date.now();
  const core = loadExperienceCore();

  // 1. Classification — dedicated intent classifier with few-shot + JSON output.
  // Previous version reused classifyViaBrain whose default system prompt is for
  // tier classification (fast/balanced/premium); the conflict produced ~69% null
  // results. We now pass our own system prompt and few-shot examples for stable
  // structured output. See docs plan 2026-05-13-pil-classifier-prompt-fix.md.
  let taskType = null;
  let outputStyle = 'balanced';
  let intentKind = null;
  let confidence = 0;
  try {
    const classifierSystem =
      'You are an intent classifier for a developer CLI. ' +
      'Given a user prompt (English, Vietnamese, or mixed), output ONLY a JSON object: ' +
      '{"category":"<one>","style":"<one>"}. ' +
      'category ∈ {refactor, debug, plan, analyze, documentation, generate, none}. ' +
      'style ∈ {concise, balanced, detailed}. ' +
      'No prose, no markdown fences, just the JSON.';
    // 4 few-shot pairs cover the category space without inflating input tokens.
    // EN+VI mix, two distinct styles, plus chitchat (none). Trimmed from 7
    // to keep Qwen3-14B processing within the 2s budget; quality is maintained
    // because category names appear in the system prompt vocabulary list.
    const fewShot = [
      { role: 'system', content: classifierSystem },
      { role: 'user', content: 'refactor this function to be async' },
      { role: 'assistant', content: '{"category":"refactor","style":"concise"}' },
      { role: 'user', content: 'tại sao test fail?' },
      { role: 'assistant', content: '{"category":"debug","style":"concise"}' },
      { role: 'user', content: 'thiết kế hệ thống auth cho team' },
      { role: 'assistant', content: '{"category":"plan","style":"detailed"}' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '{"category":"none","style":"concise"}' },
      { role: 'user', content: body.prompt.slice(0, 500) },
    ];
    // Timeout sized for the new prompt: Qwen3-14B + ~300 input tokens + json
    // response_format averages 800-1500ms on siliconflow. 2000ms gives a 25%
    // safety margin. CLI-side pipeline budget is 2500ms, leaving headroom for
    // retrieval. NOT a workaround — original 1500ms was sized for the broken
    // short prompt, not the corrected few-shot one.
    const raw = await core.classifyViaBrain(body.prompt, 2000, {
      messages: fewShot,
      maxTokens: 40,
      responseFormat: { type: 'json_object' },
    });
    if (raw) {
      // Tolerate a leading prose blurb or markdown fence; extract the first {...}.
      const jsonMatch = raw.match(/\{[\s\S]*?\}/);
      let parsed = null;
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
      }
      const cats = ['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'];
      const styles = ['concise', 'balanced', 'detailed'];
      if (parsed && typeof parsed === 'object') {
        const cat = String(parsed.category || '').toLowerCase().trim();
        const sty = String(parsed.style || '').toLowerCase().trim();
        if (cats.includes(cat)) { taskType = cat; intentKind = 'task'; confidence = 0.8; }
        else if (cat === 'none') { taskType = 'general'; intentKind = 'chitchat'; confidence = 0.7; outputStyle = 'concise'; }
        if (styles.includes(sty)) outputStyle = sty;
      } else {
        // Fallback for non-JSON responses — keep prior substring match so we
        // never regress below the legacy path's hit rate.
        const lower = raw.toLowerCase();
        const matched = cats.find((c) => lower.includes(c));
        if (matched) { taskType = matched; intentKind = 'task'; confidence = 0.6; }
        else if (/\bnone\b/.test(lower)) { taskType = 'general'; intentKind = 'chitchat'; confidence = 0.5; outputStyle = 'concise'; }
        const styleMatched = styles.find((s) => lower.includes(s));
        if (styleMatched) outputStyle = styleMatched;
      }
    }
  } catch (_e) { /* keep defaults */ }

  // 2. Retrieval — parallel search of both collections.
  let t0_principles = [];
  let t2_patterns = [];
  let retrieval_skipped_reason = null;
  const skipRetrievalFor = new Set(['general']);
  if (skipRetrievalFor.has(taskType)) {
    retrieval_skipped_reason = `task_type:${taskType}`;
  } else {
    try {
      const vector = await core.getEmbeddingRaw(body.prompt, AbortSignal.timeout(2000));
      if (!vector) {
        retrieval_skipped_reason = 'embedding_unavailable';
      } else {
        const [principles, behavioral] = await Promise.all([
          core.searchCollection('experience-principles', vector, 3),
          core.searchCollection('experience-behavioral', vector, 4),
        ]);
        const toScoredText = (p) => {
          const payload = p.payload || {};
          const j = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
          return { text: payload.text || j.solution || '', score: p.score || 0 };
        };
        const SCORE_FLOOR = 0.55;
        t0_principles = (principles || []).map(toScoredText).filter((p) => p.score >= 0.40 && p.text);
        t2_patterns = (behavioral || []).map(toScoredText).filter((p) => p.score >= SCORE_FLOOR && p.text);
      }
    } catch (_e) { retrieval_skipped_reason = 'retrieval_error'; }
  }

  // 3. T1 rules: high-score behavioral patterns (>=0.75) treated as "proven" proxy.
  const t1_rules = [];
  for (const p of t2_patterns) {
    if (p.score >= 0.75) t1_rules.push(p.text);
  }

  const response = {
    taskType,
    intentKind,
    outputStyle,
    confidence,
    domain: null,
    gsd_phase: null,
    gsd_route_source: 'none',
    t0_principles,
    t1_rules,
    t2_patterns,
    retrieval_skipped_reason,
    cache_hit: false,
    inference_ms: Date.now() - startMs,
    schema_version: '1.0',
  };
  pilCacheSet(cacheKey, response);
  json(res, response);
}

const VALID_OUTCOMES = new Set(['success', 'fail', 'retry', 'cancelled']);
const KNOWN_RUNTIMES = new Set(['claude', 'gemini', 'codex', 'opencode']);

async function handleRouteModel(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { task: { type: 'string', required: true, maxLength: 2000 } });
  if (!v.ok) return error(res, v.error);
  if (body.runtime !== undefined && body.runtime !== null && !KNOWN_RUNTIMES.has(body.runtime)) {
    return error(res, `runtime must be one of: ${[...KNOWN_RUNTIMES].join(', ')}, or null`);
  }
  const { routeModel } = loadExperienceCore();
  const result = await routeModel(body.task, body.context || null, body.runtime || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': result.source || 'default', ...CORS });
  res.end(JSON.stringify(result));
}

async function handleRouteTask(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { task: { type: 'string', required: true, maxLength: 2000 } });
  if (!v.ok) return error(res, v.error);
  if (body.runtime !== undefined && body.runtime !== null && !KNOWN_RUNTIMES.has(body.runtime)) {
    return error(res, `runtime must be one of: ${[...KNOWN_RUNTIMES].join(', ')}, or null`);
  }
  const { routeTask } = loadExperienceCore();
  const result = await routeTask(body.task, body.context || null, body.runtime || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': result.source || 'default', ...CORS });
  res.end(JSON.stringify(result));
}

async function handleRouteFeedback(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    taskHash: { type: 'string', required: true },
    outcome: { type: 'string', required: true, oneOf: VALID_OUTCOMES },
  });
  if (!v.ok) return error(res, v.error);
  const { routeFeedback } = loadExperienceCore();
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
    const { classifyViaBrain } = loadExperienceCore();
    const result = await classifyViaBrain(body.prompt, timeoutMs);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: false, error: err.message || 'brain call failed' }));
  }
}

// P1 Item 3: phase-outcome endpoint, gated by ENABLE_PHASE_OUTCOME=1.
async function handlePhaseOutcome(req, res) {
  if (process.env.ENABLE_PHASE_OUTCOME !== '1' && _cfg.enablePhaseOutcome !== true) {
    return error(res, 'phase-outcome endpoint is disabled (set ENABLE_PHASE_OUTCOME=1)', 404);
  }
  const body = await readBody(req);
  const v = validateBody(body, {
    sessionId: { type: 'string', required: true },
    phaseName: { type: 'string', required: true },
    outcome: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);

  let phaseModule;
  try {
    phaseModule = require(path.join(RUNTIME_DIR, 'src', 'phase-outcome.js'));
  } catch (err) {
    return error(res, `phase-outcome module unavailable: ${err.message}`, 503);
  }

  const core = loadExperienceCore();
  const result = await phaseModule.applyPhaseOutcome(body, {
    recordFeedback: core.recordFeedback,
    activityLog: core._activityLog,
  });
  if (!result.ok) return error(res, result.error || 'phase-outcome failed', 400);
  json(res, result);
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
  const p = url.pathname.startsWith('/v1') ? url.pathname.slice(3) : url.pathname;

  try {
    // Stale-client observability: log header commit vs server commit (no rejection).
    _maybeLogStaleClient(req);

    // Keep health and version open for liveness/diagnostic checks.
    if (p === '/health' && req.method === 'GET') return await handleHealth(req, res);
    if (p === '/metrics' && req.method === 'GET') return handleMetrics(req, res);
    if (p === '/api/version' && req.method === 'GET') return handleVersion(req, res);

    // Rate limit all non-health endpoints
    if (rateLimit(req, res)) return;
    if (req.method === 'GET' && isProtectedGetPath(p)) {
      if (!requireAuth(req, res, { allowReadToken: isReadOnlyApiPath(p) })) return;
    }
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
      if (p === '/api/prompt-stale') return await handlePromptStale(req, res);
      if (p === '/api/extract') return await handleExtract(req, res);
      if (p === '/api/evolve') return await handleEvolve(req, res);
      if (p === '/api/principles/share') return await handleShare(req, res);
      if (p === '/api/principles/import') return await handleImport(req, res);
      if (p === '/api/feedback') return await handleFeedback(req, res);
      if (p === '/api/route-task') return await handleRouteTask(req, res);
      if (p === '/api/route-model') return await handleRouteModel(req, res);
      if (p === '/api/route-feedback') return await handleRouteFeedback(req, res);
      if (p === '/api/brain') return await handleBrainProxy(req, res);
      if (p === '/api/search') return await handleSearch(req, res);
      if (p === '/api/pil-context') return await handlePilContext(req, res);
      if (p === '/api/phase-outcome') return await handlePhaseOutcome(req, res);
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
  slog('error', 'UnhandledRejection', { detail: msg });
});

// --- Graceful shutdown ---
function shutdown(signal) {
  slog('info', 'shutdown', { signal });
  server.close(() => {
    slog('info', 'shutdown_complete');
    process.exit(0);
  });
  setTimeout(() => {
    slog('error', 'shutdown_timeout');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Only start when run directly (not when required for testing)
if (require.main === module) {
  server.listen(PORT, () => {
    slog('info', 'server_started', { port: PORT, health: `http://localhost:${PORT}/health` });
  });
}

module.exports = {
  server,
  handleHealth,
  handleIntercept,
  handlePostTool,
  handlePromptStale,
  handleExtract,
  handleEvolve,
  handleStats,
  handleGates,
  handleGraph,
  handleTimeline,
  handleSearch,
  handlePilContext,
  handleShare,
  handleImport,
  handleFeedback,
  handleUser,
  handleRouteModel,
  handleRouteFeedback,
  isProtectedGetPath,
  isReadOnlyApiPath,
  loadExperienceCore,
  resolvePointIdPrefix,
  RUNTIME_DIR,
};
