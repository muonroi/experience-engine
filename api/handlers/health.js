'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { CORS, json, slog } = require('../http');
const { QDRANT_BASE, qdrantHeaders } = require('../config');
const { _rateBuckets } = require('../auth');

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
    const repoDir = path.join(__dirname, '..', '..');
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

module.exports = {
  _healthState,
  _serverVersionInfo,
  _staleClientLogMap,
  STALE_LOG_COOLDOWN_MS,
  _maybeLogStaleClient,
  handleVersion,
  handleHealth,
  handleMetrics,
};
