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
const { activityLog, buildRecallEvent } = require('./.experience/src/activity');
const runtimeConfig = require('./.experience/src/config');
const logger = require('./.experience/src/logger');
const { canonicalizeProjectSlug } = require('./lib/path-canonical');

// --- Structured logger (zero-dep) ---
function slog(level, msg, meta = {}) {
  logger.log(level, msg, meta);
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
const QDRANT_BASE = runtimeConfig.getQdrantBase();
const QDRANT_API_KEY = runtimeConfig.getQdrantApiKey();
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

function qdrantHeaders(extra = {}) {
  return { ...extra, ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}) };
}

// Derive caller scope (lang/framework/project_slug) for clients that don't
// pre-flatten them at the top level. Claude Code's hook script runs
// source-meta-enrich.js client-side and spreads ...sourceMeta into the body;
// muonroi-cli and other native clients post InterceptRequest without flat
// fields, so the server has to derive from toolInput.file_path + cwd or the
// scope filter falls back to permissive and cross-stack hints leak.
function deriveCallerMeta(body) {
  const flat = {
    lang: typeof body?.lang === 'string' ? body.lang : null,
    framework: typeof body?.framework === 'string' ? body.framework : null,
    project_slug: typeof body?.project_slug === 'string' ? body.project_slug : null,
  };
  if (flat.lang && flat.framework && flat.project_slug) return flat;
  try {
    const enricher = require(path.join(RUNTIME_DIR, 'source-meta-enrich.js'));
    if (typeof enricher.enrichSourceMeta !== 'function') return flat;
    const cwd = body?.cwd || null;
    const derived = enricher.enrichSourceMeta(body?.toolInput || body?.tool_input || null, undefined, cwd) || {};
    const mergedSlug = flat.project_slug || (typeof derived.project_slug === 'string' ? derived.project_slug : null);
    // Phase 1: if still no slug, canonicalize from file_path or cwd.
    const rawPathForCanon = body?.toolInput?.file_path || body?.tool_input?.file_path || body?.cwd || null;
    const canonSlug = (!mergedSlug && rawPathForCanon) ? canonicalizeProjectSlug(rawPathForCanon) : null;
    return {
      lang: flat.lang || (typeof derived.lang === 'string' ? derived.lang : null),
      framework: flat.framework || (typeof derived.framework === 'string' ? derived.framework : null),
      project_slug: mergedSlug || canonSlug,
    };
  } catch {
    // Fallback when enricher throws: try path canon from raw fields.
    const rawFallbackPath = body?.toolInput?.file_path || body?.tool_input?.file_path || body?.cwd || null;
    return {
      lang: flat.lang,
      framework: flat.framework,
      project_slug: flat.project_slug || (rawFallbackPath ? canonicalizeProjectSlug(rawFallbackPath) : null),
    };
  }
}

function isProtectedGetPath(pathname) {
  return pathname !== '/health';
}

function isReadOnlyApiPath(pathname) {
  return pathname === '/api/stats' || pathname === '/api/gates' || pathname === '/api/project-brief';
}

async function resolvePointIdPrefix(collection, pointId) {
  let offset = null;

  for (;;) {
    const body = { limit: 100, with_payload: false };
    if (offset !== null) body.offset = offset;

    const scrollRes = await fetch(`${QDRANT_BASE}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
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
  slog('warn', 'stale_client', {
    clientCommit: key,
    serverCommit,
    path: url.split('?')[0],
  });
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
      headers: qdrantHeaders(),
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
  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
    // Forward caller-side scope hints so applyScopeFilter() in experience-core.js
    // can gate cross-language/framework hints. For clients that pre-flatten
    // (Claude Code hook), top-level body.lang/framework wins; for native
    // clients (muonroi-cli) we derive from toolInput.file_path + cwd.
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
  };

  // --- Deterministic static rules (file-size cap, etc.) ---
  // These fire BEFORE embedding lookup, are not subject to ignoreCount
  // throttling, and surface alongside vector-matched suggestions. See
  // .experience/src/static-rules.js for rule definitions.
  let staticHints = [];
  try {
    const { evaluateStaticRules } = require("./.experience/src/static-rules.js");
    staticHints = evaluateStaticRules(body.toolName, body.toolInput || {}, meta) || [];
  } catch (err) {
    console.error("[handleIntercept] static-rules failed:", err && err.message ? err.message : err);
  }

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
  let result = resultMeta?.suggestions ?? null;
  let surfacedIds = resultMeta?.surfacedIds || [];
  if (staticHints.length) {
    const synthIds = staticHints.map((h) => ({ collection: "static-rules", id: h.id, solution: h.line, scope: { lang: "any", framework: "any", project_slug: "any" }, hitCount: 0, ignoreCount: 0, superseded: false, static: true }));
    surfacedIds = synthIds.concat(surfacedIds);
    const lines = staticHints.map((h) => h.line).join("\n");
    result = result ? (lines + "\n" + result) : lines;
  }
  // Server-side stash of surfaced hints so PostToolUse can reconcile them even
  // when the remote client does not echo surfacedIds back (codex-windows path).
  try {
    if (surfacedIds.length && meta.sourceSession) {
      const stashCore = loadExperienceCore();
      if (typeof stashCore._stashSurfacedHints === "function") stashCore._stashSurfacedHints(surfacedIds, meta);
    }
  } catch (stashErr) {
    slog("error", "intercept stash failed", { msg: stashErr?.message, session: meta.sourceSession });
  }
  json(res, {
    suggestions: result,
    hasSuggestions: result !== null,
    surfacedIds: surfacedIds,
    route: resultMeta?.route || null,
  });
}

// Aggregate batch of parallel tool calls into a single reflection-style hint.
// Fires from PostToolBatch Claude Code hook AFTER the batch resolves, BEFORE
// the next model call — so the hint can shape the next assistant turn.
//
// Strategy: concatenate tool commands/files/outputs into one query string,
// route through the standard intercept pipeline to surface scope-filtered
// hints, return the first non-null suggestion as `hint`. Per-tool feedback
// stays handled by /api/posttool — this endpoint is purely additive.
async function handlePostToolBatch(req, res) {
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return error(res, 'request body must be a JSON object');
  if (!Array.isArray(body.tools)) return error(res, 'tools is required and must be an array');
  const tools = body.tools;
  if (tools.length === 0) return json(res, { hint: null });

  const aggregatedCommand = tools
    .map((t) => {
      const ti = t?.tool_input || {};
      if (ti.command) return `${t.tool_name}: ${String(ti.command).slice(0, 200)}`;
      if (ti.file_path) return `${t.tool_name}: ${ti.file_path}`;
      return t.tool_name || '';
    })
    .filter(Boolean)
    .join(' | ');

  const reprToolInput = {
    command: aggregatedCommand,
    file_path: body.representativeFilePath || null,
    batchSize: tools.length,
  };
  const derived = deriveCallerMeta({ ...body, toolInput: reprToolInput });
  const meta = {
    sourceKind: body.sourceKind || 'hook-batch',
    sourceRuntime: body.sourceRuntime || 'claude-code',
    sourceSession: body.sessionId || null,
    cwd: body.cwd || null,
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
  };
  const { interceptWithMeta } = loadExperienceCore();
  if (typeof interceptWithMeta !== 'function') return json(res, { hint: null });
  const resultMeta = await interceptWithMeta('PostToolBatch', reprToolInput, undefined, meta, { skipRoute: true });
  json(res, {
    hint: resultMeta?.suggestions ?? null,
    surfacedIds: resultMeta?.surfacedIds || [],
    batchSize: tools.length,
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
    lang: typeof body.lang === 'string' ? body.lang : null,
    framework: typeof body.framework === 'string' ? body.framework : null,
    project_slug: typeof body.project_slug === 'string' ? body.project_slug : null,
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
  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    framework: body.framework || derived.framework || null,
    lang: body.lang || derived.lang || null,
    project_slug: body.project_slug || derived.project_slug || null,
    _preDetectedExperiences: Array.isArray(body.preDetectedExperiences) ? body.preDetectedExperiences : null,
  };
  slog('info', 'extract_api_start', {
    project: body.projectPath || null,
    transcriptLen: (body.transcript || '').length,
    lang: meta.lang,
    framework: meta.framework,
    projectSlug: meta.project_slug,
    sourceRuntime: meta.sourceRuntime,
  });
  try {
    const stored = await extractFromSession(body.transcript, body.projectPath || null, meta);
    slog('info', 'extract_api_done', {
      project: body.projectPath || null,
      stored,
      sourceRuntime: meta.sourceRuntime,
    });
    json(res, { stored, success: true });
  } catch (err) {
    slog('error', 'extract_api_error', {
      project: body.projectPath || null,
      error: logger.serializeError(err),
    });
    json(res, { stored: 0, success: false, error: err?.message });
  }
}

async function handleEvolve(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const { evolve } = loadExperienceCore();
  const results = await evolve(body.trigger || 'api');
  json(res, { ...results, success: true });
}

// Direct structured-point ingestion — used by backfill scripts (e.g. ingest-bb-to-ee.mts)
// that have curated content + payload to upsert without going through the extraction
// pipeline. Embeds the text via experience-core and upserts to Qdrant directly.
// KNOWN_COLLECTIONS still gates which collections are writable.
async function handleIngestPoint(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    id: { type: 'string', required: true },
    text: { type: 'string', required: true },
    collection: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);
  if (!KNOWN_COLLECTIONS.has(body.collection)) {
    return error(res, `unknown collection: ${body.collection}`);
  }
  try {
    const { getEmbeddingRaw } = loadExperienceCore();
    const vector = await getEmbeddingRaw(body.text);
    if (!Array.isArray(vector) || vector.length === 0) {
      return error(res, 'embedding_failed');
    }
    const point = {
      id: body.id,
      vector,
      payload: { ...(body.payload || {}), text: body.text },
    };
    const upsert = await fetch(`${QDRANT_BASE}/collections/${body.collection}/points?wait=true`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ points: [point] }),
    });
    if (!upsert.ok) {
      const errBody = await upsert.text();
      return error(res, `qdrant_upsert_failed: ${upsert.status} ${errBody.slice(0, 200)}`);
    }
    json(res, { id: body.id, collection: body.collection, success: true });
  } catch (err) {
    slog('error', 'ingest_point_error', { error: String(err) });
    return error(res, String(err));
  }
}

// Hint quality stats — aggregates Qdrant points to surface noise patterns
// (cross-language seeds, high-ignore points, unscoped legacy seeds). Used by
// the `exp-hint-stats` CLI tool and by manual triage during noise reviews.
async function handleHintStats(req, res, url) {
  const minIgnoreCount = Number(url.searchParams.get('minIgnoreCount') || 2);
  const noiseRatio = Number(url.searchParams.get('noiseRatio') || 0.4);
  const topN = Math.min(Number(url.searchParams.get('topN') || 20), 100);
  const cols = (url.searchParams.get('collections') || 'experience-behavioral,experience-principles,experience-selfqa').split(',');

  const stats = {};

  for (const col of cols) {
    let offset = null;
    let total = 0;
    const byLang = { 'c#': 0, typescript: 0, javascript: 0, unscoped: 0, other: 0 };
    const byFramework = {};
    const noisy = [];
    const unscopedHigh = [];

    while (true) {
      const r = await fetch(`${QDRANT_BASE}/collections/${col}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ limit: 200, offset, with_payload: true }),
      }).catch(() => null);
      if (!r || !r.ok) break;
      const j = await r.json();
      const pts = j.result?.points || [];
      for (const p of pts) {
        total++;
        let exp = {};
        try { exp = JSON.parse(p.payload?.json || '{}'); } catch {}
        const lang = exp.scope?.lang ? String(exp.scope.lang).toLowerCase() : null;
        const fw = exp.scope?.framework ? String(exp.scope.framework).toLowerCase() : null;
        if (!lang) byLang.unscoped++;
        else if (/c#|csharp|dotnet/.test(lang)) byLang['c#']++;
        else if (/typescript/.test(lang)) byLang.typescript++;
        else if (/javascript/.test(lang)) byLang.javascript++;
        else byLang.other++;
        if (fw) byFramework[fw] = (byFramework[fw] || 0) + 1;
        const hits = Number(exp.hitCount || 0);
        const ignores = Number(exp.ignoreCount || 0);
        const totalFires = hits + ignores;
        if (ignores >= minIgnoreCount && totalFires > 0 && ignores / totalFires >= noiseRatio) {
          noisy.push({
            id: String(p.id || '').slice(0, 8),
            fullId: String(p.id || ''),
            hits, ignores,
            ignoreRatio: Number((ignores / totalFires).toFixed(2)),
            lang, framework: fw, org: exp.scope?.org || null,
            solution: String(exp.solution || '').slice(0, 100),
          });
        }
        if (!lang && (hits + ignores) >= 3) {
          unscopedHigh.push({
            id: String(p.id || '').slice(0, 8),
            fullId: String(p.id || ''),
            hits, ignores,
            solution: String(exp.solution || '').slice(0, 100),
          });
        }
      }
      offset = j.result?.next_page_offset;
      if (!offset) break;
    }
    noisy.sort((a, b) => b.ignores - a.ignores);
    unscopedHigh.sort((a, b) => (b.hits + b.ignores) - (a.hits + a.ignores));
    stats[col] = {
      total,
      byLang,
      byFramework,
      noisyCount: noisy.length,
      unscopedHighCount: unscopedHigh.length,
      noisy: noisy.slice(0, topN),
      unscopedHigh: unscopedHigh.slice(0, topN),
    };
  }

  json(res, { generatedAt: new Date().toISOString(), thresholds: { minIgnoreCount, noiseRatio }, stats });
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

  // Phase 1: build bySlug bucket from events that carry project_slug or project.
  const bySlug = {};
  for (const ev of events) {
    const slug = (typeof ev.project_slug === 'string' && ev.project_slug)
      ? ev.project_slug
      : (typeof ev.project === 'string' && ev.project ? ev.project : null);
    if (slug) bySlug[slug] = (bySlug[slug] || 0) + 1;
  }

  json(res, { since: allTime ? 'all' : (sinceParam || '7d'), ...stats, top5, bySlug });
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

// /api/project-brief — breadth-first SessionStart digest for a project.
// GET  /api/project-brief?project=<slug>[&cwd=<path>][&limit=N]  (read token OK)
// POST /api/project-brief  { project, cwd, limit }              (full token; hook path)
// One handler, both methods: the SessionStart hook posts via remote-client's
// postJsonForHook (POST only); dashboards/curl use GET with the read token.
async function handleProjectBrief(req, res, url) {
  let project = null;
  let cwd = null;
  let limit;
  if (req.method === 'POST') {
    const body = await readBody(req);
    project = typeof body?.project === 'string' ? body.project : null;
    cwd = typeof body?.cwd === 'string' ? body.cwd : null;
    if (Number.isFinite(body?.limit)) limit = body.limit;
  } else {
    project = url.searchParams.get('project');
    cwd = url.searchParams.get('cwd');
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit != null && Number.isFinite(Number(rawLimit))) limit = Number(rawLimit);
  }
  // Fall back to deriving the project slug from cwd (same path the intercept
  // uses) so a hook that only knows the working directory still gets a brief.
  if (!project) project = deriveCallerMeta({ project_slug: null, cwd }).project_slug;
  if (!project) return json(res, { text: null, entries: [], projectSlug: null, count: 0 });

  const { buildProjectBrief } = loadExperienceCore();
  const brief = await buildProjectBrief(project, { limit });
  return json(res, brief);
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
  // Capture caller context (lang/framework/project_slug) so future evolve
  // cycles can do scope narrowing instead of full supersede — e.g. entry
  // marked wrong_language 3 times all from TypeScript queries → exclude
  // TypeScript instead of killing the entry (it may still be valid in C#).
  const callerCtx = deriveCallerMeta(body);
  await recordFeedback(body.collection, pointId, resolvedVerdict, normalizedReason, { callerContext: callerCtx });
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

const KNOWN_COLLECTIONS = new Set([
  'experience-behavioral',
  'experience-selfqa',
  'experience-principles',
  // Phase 2: BB-specific collections
  'bb-behavioral',
  'bb-recipes',
  'bb-packages', // Plan 23: BB NuGet packages
]);

// ensureCollections — creates bb-* Qdrant collections at server startup if absent.
// Vector dims must match the configured embedding model.
async function ensureCollections() {
  const BB_COLLECTIONS = ['bb-behavioral', 'bb-recipes', 'bb-packages'];
  const VECTOR_SIZE = Number(runtimeConfig.getEmbedDim()) || 768;
  for (const col of BB_COLLECTIONS) {
    try {
      const check = await fetch(`${QDRANT_BASE}/collections/${col}`, {
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(5000),
      });
      if (check.status === 200) {
        slog('info', 'collection_exists', { collection: col });
        continue;
      }
      const create = await fetch(`${QDRANT_BASE}/collections/${col}`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
        signal: AbortSignal.timeout(10000),
      });
      if (create.ok) {
        slog('info', 'collection_created', { collection: col });
      } else {
        const errBody = await create.text();
        slog('error', 'collection_create_failed', { collection: col, status: create.status, body: errBody });
      }
    } catch (err) {
      slog('error', 'collection_ensure_error', { collection: col, error: String(err) });
    }
  }

  // Hybrid recall: ensure a full-text index on the top-level `text_search`
  // payload field for the experience collections so the lexical leg's MatchText
  // queries work. Idempotent — Qdrant treats an existing index as success; any
  // failure is logged and non-fatal (lexical leg returns [] until the index
  // lands, so recall degrades cleanly to vector-only).
  for (const col of ['experience-principles', 'experience-behavioral', 'experience-selfqa']) {
    try {
      const idx = await fetch(`${QDRANT_BASE}/collections/${col}/index`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          field_name: 'text_search',
          field_schema: { type: 'text', tokenizer: 'word', lowercase: true, min_token_len: 2, max_token_len: 30 },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (idx.ok) {
        slog('info', 'text_index_ensured', { collection: col });
      } else {
        const body = await idx.text();
        if (/exist/i.test(body)) slog('info', 'text_index_exists', { collection: col });
        else slog('warn', 'text_index_failed', { collection: col, status: idx.status, body: body.slice(0, 200) });
      }
    } catch (err) {
      slog('warn', 'text_index_error', { collection: col, error: String(err) });
    }
  }
}

// /api/recall — agent-initiated active recall of learned experience.
// Unlike /api/search (raw vector hits, no signal), recall runs the full
// intercept pipeline: scope-filtered retrieval, scored + formatted with
// [id col] feedback handles, and records a SURFACE event for each returned
// entry. Surfacing bumps surfaceCount only (NOT hitCount) — the agent then
// reports usefulness via /api/feedback (followed/ignored/noise), so actively
// pulled context reinforces precisely and filters noise faster than passive
// hints (the agent chose to ask, so its verdict is high-signal).
async function handleRecall(req, res) {
  // Defense-in-depth: the POST dispatch block already gates on requireAuth, but
  // mirror handleSearch/handlePilContext so the handler is safe even if routing
  // is later refactored (recall can record surface + reads scoped experience).
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return error(res, 'query is required');
  if (query.length > 10_000) return error(res, 'query exceeds 10KB');

  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'recall-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
  };

  const { interceptWithMeta } = loadExperienceCore();
  // Active recall = semantic-search mode. Reuses the intercept pipeline (embed →
  // search → rank → format → recordSurface) but with recallMode:true, which:
  //   - ranks by RAW COSINE (not the penalty-weighted effective score),
  //   - drops the positive lang/framework/project scope gates, and
  //   - bypasses the min-search-score floor (format.js GATE 2).
  // The score floor is a noise-control signal for PASSIVE hints — a deliberate
  // query has no such ceiling. Integrity gates still apply: superseded,
  // permanent-noise (ignore≥20 & hit=0), irrelevant≥3, learned lang/project
  // exclusions, and the min-confidence quality floor. Surfaces are still
  // recorded so the agent's /api/feedback verdict grows + cleans the brain.
  // body.fast → fast recall: skip the brainRelevanceFilter LLM rerank (~8s) so
  // latency-bound callers (the prompt risk gate) get a ~1.5-2s recall that still
  // carries [id col]. Full pipeline otherwise. Bound the internal budget tighter
  // in fast mode so a slow embed can't blow the caller's hook deadline.
  const fast = !!body.fast;
  const result = await interceptWithMeta(
    'UserPrompt',
    { command: query, _promptHook: true },
    AbortSignal.timeout(fast ? 4000 : 8000),
    meta,
    { recallMode: true, fast }
  );
  const entries = (result?.surfacedIds || []).map(s => ({ id: String(s.id || ''), collection: s.collection || null }));
  // P1: record the recall on activity.jsonl so the engine can later detect a
  // session that stitched ≥N recalls (runbook-candidate signal). activityLog
  // never throws (it self-guards), so this cannot break the response path.
  activityLog(buildRecallEvent(query, meta, entries));
  return json(res, { text: result?.suggestions || null, entries, count: entries.length, query });
}

// /api/import-memory — thin-client bridge for the curated-memory importer.
// Curated memory files live on the CLIENT (e.g. ~/.claude/projects/<slug>/memory),
// and project-slug derivation needs the client's real project dirs — so the client
// scans + maps locally and POSTs pre-mapped experiences here. The server (where
// Qdrant + embeddings live) embeds and stores them seed-like via
// storeImportedExperience (stable-id upsert, earned-counter preserving).
async function handleImportMemory(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  const experiences = Array.isArray(body.experiences) ? body.experiences : null;
  if (!experiences) return error(res, 'experiences[] is required');
  if (experiences.length > 500) return error(res, 'too many experiences (max 500 per call)');
  const { storeImportedExperience } = require('./.experience/src/evolution');
  const stats = { count: experiences.length, stored: 0, upserted: 0, failed: 0 };
  const results = [];
  for (const e of experiences) {
    if (!e || typeof e.id !== 'string' || !KNOWN_COLLECTIONS.has(e.collection) || !e.qa || typeof e.qa !== 'object') {
      stats.failed++; results.push({ id: e?.id || null, ok: false, reason: 'invalid' }); continue;
    }
    try {
      const r = await storeImportedExperience(e.qa, {
        id: e.id, collection: e.collection,
        tier: Number(e.tier) || 2, confidence: Number(e.confidence) || 0.6,
        runtime: typeof e.runtime === 'string' ? e.runtime : 'claude',
      });
      if (r.stored) { stats.stored++; if (r.upserted) stats.upserted++; results.push({ id: e.id, ok: true, upserted: !!r.upserted }); }
      else { stats.failed++; results.push({ id: e.id, ok: false, reason: r.reason || 'not_stored' }); }
    } catch (err) {
      stats.failed++;
      results.push({ id: e.id, ok: false, reason: String(err?.message || err) });
      slog('error', 'import_memory_store_error', { id: String(e.id).slice(0, 8), error: String(err?.message || err) });
    }
  }
  stats.new = stats.stored - stats.upserted;
  return json(res, { ...stats, results });
}

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

  const { getEmbeddingRaw, searchCollection, searchCollectionHybrid } = loadExperienceCore();
  const vector = await getEmbeddingRaw(body.query, AbortSignal.timeout(2000));
  if (!vector) return error(res, 'Embedding unavailable', 503);

  // Hybrid (dense cosine + native BM25 sparse, RRF-fused) by default — /api/search
  // is a deliberate query, so it fuses a lexical leg like /api/recall to surface
  // lexically-distinct lessons the dense leg buries. EXPERIENCE_SEARCH_HYBRID=false
  // reverts to dense-only; hybrid also auto-degrades to dense when the lexical leg
  // is unavailable (collection not sparse-migrated). See config.getSearchHybrid.
  const useHybrid = runtimeConfig.getSearchHybrid() && typeof searchCollectionHybrid === 'function';
  const searchSignal = AbortSignal.timeout(2500);
  const results = await Promise.all(collections.map((c) =>
    useHybrid
      ? searchCollectionHybrid(c, body.query, vector, limit, searchSignal)
      : searchCollection(c, vector, limit)
  ));
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

  // 1+2. Classification AND embedding run in parallel — they have no data
  // dependency on each other. Previously these were sequential (classify then
  // embed+search), which stacked p95 classifier (3000ms) on top of p95 embed
  // (~600ms). Running them concurrently caps total at max(classifier, embed)
  // which is classifier-bound. For taskType=general we waste the embedding
  // work, but embedding is cheap relative to classifier.
  let taskType = null;
  let outputStyle = 'balanced';
  let intentKind = null;
  let confidence = 0;
  let t0_principles = [];
  let t2_patterns = [];
  let retrieval_skipped_reason = null;

  const classifierSystem =
    'You are an intent classifier for a developer CLI. ' +
    'Given a user prompt (English, Vietnamese, or mixed), output ONLY a JSON object: ' +
    '{"category":"<one>","style":"<one>"}. ' +
    'category ∈ {refactor, debug, plan, analyze, documentation, generate, none}. ' +
    'style ∈ {concise, balanced, detailed}. ' +
    'No prose, no markdown fences, just the JSON.';
  // 4 few-shot pairs cover the category space without inflating input tokens.
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
  const classifierModel = process.env.EE_PIL_CLASSIFIER_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

  // Kick off both in parallel. Use allSettled so a failed embedding does not
  // abort the classifier and vice versa.
  const [classifyResult, embedResult] = await Promise.allSettled([
    core.classifyViaBrain(body.prompt, 3500, {
      model: classifierModel,
      messages: fewShot,
      maxTokens: 40,
      responseFormat: { type: 'json_object' },
    }),
    core.getEmbeddingRaw(body.prompt, AbortSignal.timeout(2000)),
  ]);

  // Parse classifier result.
  if (classifyResult.status === 'fulfilled' && classifyResult.value) {
    const raw = classifyResult.value;
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
      // Fallback for non-JSON responses — keep prior substring match.
      const lower = raw.toLowerCase();
      const matched = cats.find((c) => lower.includes(c));
      if (matched) { taskType = matched; intentKind = 'task'; confidence = 0.6; }
      else if (/\bnone\b/.test(lower)) { taskType = 'general'; intentKind = 'chitchat'; confidence = 0.5; outputStyle = 'concise'; }
      const styleMatched = styles.find((s) => lower.includes(s));
      if (styleMatched) outputStyle = styleMatched;
    }
  }

  // Use embedding for retrieval — gated by classifier result.
  const skipRetrievalFor = new Set(['general']);
  if (skipRetrievalFor.has(taskType)) {
    retrieval_skipped_reason = `task_type:${taskType}`;
  } else if (embedResult.status !== 'fulfilled' || !embedResult.value) {
    retrieval_skipped_reason = 'embedding_unavailable';
  } else {
    try {
      const vector = embedResult.value;
      const [principles, behavioral, selfqa] = await Promise.all([
        core.searchCollection('experience-principles', vector, 3),
        core.searchCollection('experience-behavioral', vector, 4),
        core.searchCollection('experience-selfqa', vector, 4),
      ]);
      // Tag each point with its SOURCE collection before merging selfqa into the
      // behavioral bucket — a selfqa hit is not 'experience-behavioral', and the
      // id/collection pair must point at the real collection so the CLI's
      // ee_feedback(id, collection, verdict) resolves the right entry.
      const tag = (arr, collection) => (arr || []).map((p) => ({ point: p, collection }));
      const principlesTagged = tag(principles, 'experience-principles');
      const behavioralTagged = [
        ...tag(behavioral, 'experience-behavioral'),
        ...tag(selfqa, 'experience-selfqa'),
      ];
      // Emit id + collection alongside text/score (schema_version 1.1) so
      // muonroi-cli's unified PIL injection path (layer3 formatter mode) can record
      // the point as rateable recall debt and the agent can credit it via
      // ee_feedback. Without these the unified path is unrateable and the EE recall
      // loop stays half-open there. Additive + backward compatible (older CLIs strip
      // the unknown fields at schema parse).
      const toScoredText = ({ point: p, collection }) => {
        const payload = p.payload || {};
        const j = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
        return {
          id: p.id != null ? String(p.id) : undefined,
          collection,
          text: payload.text || j.solution || '',
          score: p.score || 0,
        };
      };
      const SCORE_FLOOR = 0.55;
      t0_principles = principlesTagged.map(toScoredText).filter((p) => p.score >= 0.40 && p.text);
      t2_patterns = behavioralTagged.map(toScoredText).filter((p) => p.score >= SCORE_FLOOR && p.text);
    } catch (err) {
      retrieval_skipped_reason = 'retrieval_error';
      console.error(`[pil-context] retrieval failed: ${err?.message}`, { stack: err?.stack?.split('\n').slice(0, 3) });
    }
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
    // 1.1: t0_principles / t2_patterns items now carry id + collection so the CLI
    // unified injection path can record them as rateable recall debt (ee_feedback).
    schema_version: '1.1',
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

async function handleSyncBuffers(req, res) {
  const body = await readBody(req);
  if (!body.buffers || typeof body.buffers !== 'object') {
    return error(res, 'buffers object is required');
  }
  const { syncIDEBuffers } = loadExperienceCore();
  const ok = syncIDEBuffers(body.buffers);
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ ok }));
}

// --- Brain Proxy (allows local clients to reach SiliconFlow via VPS) ---

async function handleBrainProxy(req, res) {
  const body = await readBody(req);
  if (!body.prompt) return error(res, 'prompt is required');
  const timeoutMs = body.timeoutMs || 8000;
  try {
    const { classifyViaBrain } = loadExperienceCore();
    // Forward optional classification overrides from SAMR/advanced callers.
    // The underlying classifyViaBrain already supports options.systemPrompt,
    // options.responseFormat, options.model, options.maxTokens, options.provider.
    const options = {};
    if (body.systemPrompt) options.systemPrompt = body.systemPrompt;
    if (body.responseFormat) options.responseFormat = body.responseFormat;
    if (body.model) options.model = body.model;
    if (body.maxTokens != null) options.maxTokens = body.maxTokens;
    if (body.provider) options.provider = body.provider;
    const result = await classifyViaBrain(body.prompt, timeoutMs, options);
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
    if (p === '/api/project-brief' && req.method === 'GET') return await handleProjectBrief(req, res, url);
    if (p === '/api/timeline' && req.method === 'GET') return await handleTimeline(req, res, url);
    if (p === '/api/user' && req.method === 'GET') return handleUser(req, res);
    if (p === '/api/hint-stats' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return await handleHintStats(req, res, url);
    }

    // POST endpoints — require Bearer token when server.authToken is configured
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      if (p === '/api/intercept') return await handleIntercept(req, res);
      if (p === '/api/posttool-batch') return await handlePostToolBatch(req, res);
      if (p === '/api/posttool') return await handlePostTool(req, res);
      if (p === '/api/prompt-stale') return await handlePromptStale(req, res);
      if (p === '/api/extract') return await handleExtract(req, res);
      if (p === '/api/ingest-point') return await handleIngestPoint(req, res);
      if (p === '/api/evolve') return await handleEvolve(req, res);
      if (p === '/api/principles/share') return await handleShare(req, res);
      if (p === '/api/principles/import') return await handleImport(req, res);
      if (p === '/api/feedback') return await handleFeedback(req, res);
      if (p === '/api/route-task') return await handleRouteTask(req, res);
      if (p === '/api/route-model') return await handleRouteModel(req, res);
      if (p === '/api/route-feedback') return await handleRouteFeedback(req, res);
      if (p === '/api/sync-buffers') return await handleSyncBuffers(req, res);
      if (p === '/api/brain') return await handleBrainProxy(req, res);
      if (p === '/api/search') return await handleSearch(req, res);
      if (p === '/api/recall') return await handleRecall(req, res);
      if (p === '/api/import-memory') return await handleImportMemory(req, res);
      if (p === '/api/pil-context') return await handlePilContext(req, res);
      if (p === '/api/phase-outcome') return await handlePhaseOutcome(req, res);
      if (p === '/api/project-brief') return await handleProjectBrief(req, res, url);
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
    // Phase 2: ensure bb-behavioral and bb-recipes collections exist in Qdrant.
    ensureCollections().catch((err) => slog('error', 'ensure_collections_failed', { error: String(err) }));
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
  ensureCollections,
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
