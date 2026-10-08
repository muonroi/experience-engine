'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtimeConfig = require('../.experience/src/config');
const { canonicalizeProjectSlug } = require('../lib/path-canonical');

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
// Without a token every API (including the /api/brain LLM proxy) is open, so an
// unconfigured server only listens on loopback. With a token it keeps Node's
// default (all interfaces) so thin clients that reach it directly still work.
// An explicit server.host / EXP_SERVER_HOST always wins ("0.0.0.0" in Docker).
const HOST = _cfg.server?.host || process.env.EXP_SERVER_HOST || (AUTH_TOKEN ? undefined : '127.0.0.1');
const VALID_FEEDBACK_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT']);
const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);
const TMP_DIR = path.join(os.homedir(), '.experience', 'tmp');
const PACKAGED_RUNTIME_DIR = path.join(__dirname, '..', '.experience');
const HOME_RUNTIME_DIR = path.join(os.homedir(), '.experience');
const RUNTIME_DIR = fs.existsSync(path.join(PACKAGED_RUNTIME_DIR, 'experience-core.js'))
  ? PACKAGED_RUNTIME_DIR
  : HOME_RUNTIME_DIR;
const RUNTIME_CORE_PATH = path.join(RUNTIME_DIR, 'experience-core.js');
const RUNTIME_JUDGE_WORKER_PATH = path.join(RUNTIME_DIR, 'judge-worker.js');

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

module.exports = {
  _cfg,
  PORT,
  QDRANT_BASE,
  QDRANT_API_KEY,
  AUTH_TOKEN,
  READ_AUTH_TOKEN,
  HOST,
  VALID_FEEDBACK_VERDICTS,
  VALID_NOISE_REASONS,
  TMP_DIR,
  PACKAGED_RUNTIME_DIR,
  HOME_RUNTIME_DIR,
  RUNTIME_DIR,
  RUNTIME_CORE_PATH,
  RUNTIME_JUDGE_WORKER_PATH,
  loadExperienceCore,
  qdrantHeaders,
  deriveCallerMeta,
};
