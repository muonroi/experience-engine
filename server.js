#!/usr/bin/env node
/**
 * server.js — Experience Engine REST API
 * Zero npm dependencies. Node.js 22+ built-in http module only.
 *
 * This file is the entry point: request dispatch, startup and shutdown.
 *   api/routes.js     — the route table (every endpoint, method and access level)
 *   api/handlers/*.js — endpoint handlers, grouped by area
 *   api/auth.js       — bearer auth, rate limiting
 *   api/config.js     — server config, runtime paths, shared helpers
 *   api/http.js       — JSON responses, body parsing, CORS, logging
 * API reference: docs/openapi.yaml.
 *
 * Config: ~/.experience/config.json (server.port, server.host, server.authToken, server.readAuthToken)
 * Start: node server.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { PORT, HOST, AUTH_TOKEN, RUNTIME_DIR, loadExperienceCore } = require('./api/config');
const { CORS, error, slog } = require('./api/http');
const {
  _isLoopback, _clientIp, _rateLimitIdentity, rateLimit, requireAuth,
  isProtectedGetPath, isReadOnlyApiPath,
} = require('./api/auth');
const { _maybeLogStaleClient } = require('./api/handlers/health');
const { ensureCollections } = require('./api/handlers/knowledge');
const { findRoute } = require('./api/routes');

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

    const route = findRoute(req.method, p);

    // Keep health and version open for liveness/diagnostic checks.
    if (route?.access === 'public') return await route.handler(req, res, url);

    // Rate limit all non-health endpoints
    if (rateLimit(req, res)) return;
    // Auth runs before the 404 so unknown paths do not reveal what exists.
    if (req.method === 'GET' && isProtectedGetPath(p)) {
      if (!requireAuth(req, res, { allowReadToken: isReadOnlyApiPath(p) })) return;
    }
    // POST endpoints — require Bearer token when server.authToken is configured
    if (req.method === 'POST' && !requireAuth(req, res)) return;

    if (route) return await route.handler(req, res, url);
    error(res, 'Not found', 404);
  } catch (err) {
    error(res, err.message || 'Internal server error', 500);
  }
});

// Log unhandled rejections instead of crashing — but never swallow silently
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  try { fs.appendFileSync(path.join(os.homedir(), '.experience', 'server-errors.log'), `[${new Date().toISOString()}] UnhandledRejection: ${msg}\n`); } catch {}
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
  server.listen(PORT, HOST, () => {
    slog('info', 'server_started', { port: PORT, host: HOST || '*', health: `http://localhost:${PORT}/health` });
    if (!AUTH_TOKEN && HOST !== 'localhost' && !_isLoopback(HOST)) {
      slog('warn', 'server_unauthenticated', {
        hint: `No server.authToken set and server.host is ${HOST}: every API, including /api/brain, is open to anyone who can reach this port. Set server.authToken, or restrict who can reach it.`,
      });
    }
    // Phase 2: ensure bb-behavioral and bb-recipes collections exist in Qdrant.
    ensureCollections().catch((err) => slog('error', 'ensure_collections_failed', { error: String(err) }));
  });
}

// Handlers are re-exported so existing callers (tests, tools) keep requiring server.js.
module.exports = {
  ...require('./api/handlers/health'),
  ...require('./api/handlers/hooks'),
  ...require('./api/handlers/observability'),
  ...require('./api/handlers/knowledge'),
  ...require('./api/handlers/pil'),
  ...require('./api/handlers/routing'),
  server,
  isProtectedGetPath,
  isReadOnlyApiPath,
  loadExperienceCore,
  RUNTIME_DIR,
  _clientIp,
  _rateLimitIdentity,
};
