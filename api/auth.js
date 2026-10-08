'use strict';

const crypto = require('node:crypto');
const { AUTH_TOKEN, READ_AUTH_TOKEN, _cfg } = require('./config');
const { CORS } = require('./http');

// --- Rate limiting (token bucket, keyed by caller IDENTITY) ---
//
// Identity first, then the bucket. An authenticated agent and an anonymous
// stranger are not the same caller and must not share a quota:
//   - valid token → per-token bucket, high cap. EE tools are a query-first SOT
//     that agents hit before every step, so this is a runaway backstop, not a
//     quota. Throughput is bounded by the work itself, not by this number.
//   - no token → per-IP bucket, low cap. This is the actual abuse surface.
//
// `??` not `||`: an explicit 0 means "disabled". `|| 120` turned 0 into 120 —
// the exact opposite of what the operator asked for.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_AUTHED = _cfg.server?.rateLimit ?? 6000;
const RATE_LIMIT_ANON = _cfg.server?.rateLimitAnon ?? 120;
const _rateBuckets = new Map();

function _isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

// Apache reverse-proxies experience.muonroi.com to 127.0.0.1:8082, so every
// request in the fleet arrives with remoteAddress 127.0.0.1 and keying on it
// collapses all agents into ONE bucket. X-Forwarded-For fixes that — but only
// when the peer is our own loopback proxy. From a direct (non-loopback) peer the
// header is caller-controlled, and trusting it would let one attacker mint a
// fresh bucket per request and bypass the limiter entirely.
function _clientIp(req) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (_isLoopback(peer)) {
    const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return peer;
}

// Constant-time "Bearer <token>" check. Both sides are hashed first so the
// comparison is length-independent and timingSafeEqual never throws.
function _bearerMatches(hdr, token) {
  if (!token) return false;
  const a = crypto.createHash('sha256').update(String(hdr)).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  return crypto.timingSafeEqual(a, b);
}

// Mirrors requireAuth's accepted tokens. Kept as a plain equality check (not a
// call into requireAuth) because this must classify, never respond.
function _rateLimitIdentity(req) {
  const hdr = req.headers?.['authorization'] || '';
  if (_bearerMatches(hdr, AUTH_TOKEN)) return { key: 'rw', max: RATE_LIMIT_AUTHED };
  if (_bearerMatches(hdr, READ_AUTH_TOKEN)) return { key: 'ro', max: RATE_LIMIT_AUTHED };
  // No auth configured at all (local full-brain install): every caller already has
  // full access, so an anon cap would only throttle the owner.
  if (!AUTH_TOKEN) return { key: `open:${_clientIp(req)}`, max: RATE_LIMIT_AUTHED };
  return { key: `anon:${_clientIp(req)}`, max: RATE_LIMIT_ANON };
}

function rateLimit(req, res) {
  const { key, max } = _rateLimitIdentity(req);
  if (!(max > 0)) return false; // explicitly disabled
  // Authed callers share one token, so bucket per token AND per client — one
  // runaway agent then cannot spend the whole fleet's headroom.
  const bucketKey = key === 'rw' || key === 'ro' ? `${key}:${_clientIp(req)}` : key;
  const now = Date.now();
  let bucket = _rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    _rateBuckets.set(bucketKey, bucket);
  }
  bucket.count++;
  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
  if (bucket.count > max) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return true;
  }
  return false;
}

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [key, bucket] of _rateBuckets) {
    if (bucket.windowStart < cutoff) _rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

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
  if (acceptedTokens.some(token => _bearerMatches(hdr, token))) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function isProtectedGetPath(pathname) {
  return pathname !== '/health';
}

function isReadOnlyApiPath(pathname) {
  return pathname === '/api/stats' || pathname === '/api/gates' || pathname === '/api/project-brief'
    || pathname === '/api/projects';
}

module.exports = {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_AUTHED,
  RATE_LIMIT_ANON,
  _rateBuckets,
  _isLoopback,
  _clientIp,
  _bearerMatches,
  _rateLimitIdentity,
  rateLimit,
  requireAuth,
  isProtectedGetPath,
  isReadOnlyApiPath,
};
