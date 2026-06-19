#!/usr/bin/env node
/**
 * interceptor-session.js — SessionStart hook (Project Brief injection)
 *
 * Mirrors the disk-based auto-memory pattern: at session start, inject a
 * breadth-first index of WHAT THE ENGINE KNOWS about the current project —
 * the high-confidence, reinforced, recent facts that the similarity-gated
 * intercept path would never surface unless the prompt happened to embed
 * close to them. One line per entry, each tagged [id col] for lazy detail.
 *
 * Lightweight + fail-open: derive the project slug from cwd, ask the engine
 * for the brief (remote or local), emit it as additionalContext. Silent when
 * there is no slug or no learned facts. Client-side TTL cache avoids hitting
 * the engine on every session for the same project.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXP_DIR = path.join(os.homedir(), '.experience');
const DEBUG_LOG = process.env.EXPERIENCE_HOOK_DEBUG_LOG || path.join(os.homedir(), '.codex', 'log', 'experience-hook-debug.jsonl');

const RUNTIME_OVERRIDE = (() => {
  const arg = process.argv.find(a => a.startsWith('--runtime='));
  return arg ? arg.slice('--runtime='.length).trim().toLowerCase() : null;
})();

function timeoutFromEnv(name, fallback) {
  const raw = Number(process.env[name] || 0);
  return raw > 0 ? raw : fallback;
}
const STDIN_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_STDIN_TIMEOUT_MS', 3000);
const INTERCEPT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_INTERCEPT_TIMEOUT_MS', 2500);
const HARD_EXIT_TIMEOUT_MS = timeoutFromEnv('EXPERIENCE_HOOK_HARD_EXIT_TIMEOUT_MS', 3000);
const BRIEF_CLIENT_TTL_MS = timeoutFromEnv('EXPERIENCE_BRIEF_CLIENT_TTL_MS', 600000);
const BRIEF_LIMIT = timeoutFromEnv('EXPERIENCE_BRIEF_LIMIT', 12);

function debugLog(event) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), hook: 'interceptor-session', ...event }) + '\n');
  } catch (err) {
    // Debug log is best-effort; surface to stderr so a broken log dir is visible.
    try { process.stderr.write(`[interceptor-session] debugLog failed: ${err?.message || err}\n`); } catch { /* nothing left to do */ }
  }
}

function getRemoteClient() {
  try {
    return require(path.join(EXP_DIR, 'remote-client.js'));
  } catch (err) {
    debugLog({ stage: 'remote_client_load_failed', message: err?.message || String(err) });
    return null;
  }
}

function suppressHookOutput() {
  const muted = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (stream, chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (text) muted.push({ stream, text });
    return true;
  };
  process.stdout.write = ((chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return capture('stdout', chunk);
  });
  process.stderr.write = ((chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return capture('stderr', chunk);
  });
  console.log = (...args) => capture('console.log', args.join(' '));
  console.info = (...args) => capture('console.info', args.join(' '));
  console.warn = (...args) => capture('console.warn', args.join(' '));
  console.error = (...args) => capture('console.error', args.join(' '));
  return {
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      return muted;
    }
  };
}

function _loadEnricher() {
  try { return require(path.join(EXP_DIR, 'source-meta-enrich.js')); }
  catch {
    try { return require(path.join(__dirname, 'source-meta-enrich.js')); }
    catch (err) { debugLog({ stage: 'enricher_load_failed', message: err?.message || String(err) }); return null; }
  }
}
const _enricher = _loadEnricher();

// "Who Am I" v4.0 (slice 2): load the privacy config + profile model + pure
// renderer for the on-device profile block. Dual-path (EXP_DIR/src → __dirname/src)
// mirrors interceptor-prompt.js:393-408 so it resolves on thin + full installs;
// returns null (logged) when any module is absent → injection degrades to brief-only.
function _loadProfileDeps() {
  const fromDir = (dir) => ({
    config: require(path.join(dir, 'src', 'config.js')),
    model: require(path.join(dir, 'src', 'profile-model.js')),
    render: require(path.join(dir, 'src', 'profile-render.js')),
  });
  try { return fromDir(EXP_DIR); }
  catch {
    try { return fromDir(__dirname); }
    catch (err) { debugLog({ stage: 'profile_deps_load_failed', message: err?.message || String(err) }); return null; }
  }
}

function deriveProjectSlug(cwd) {
  if (!_enricher || typeof _enricher.enrichSourceMeta !== 'function') return null;
  try {
    const meta = _enricher.enrichSourceMeta({}, undefined, cwd) || {};
    return typeof meta.project_slug === 'string' && meta.project_slug.trim() ? meta.project_slug.trim() : null;
  } catch (err) {
    debugLog({ stage: 'slug_derive_failed', message: err?.message || String(err) });
    return null;
  }
}

function clientCachePath(slug) {
  return path.join(EXP_DIR, 'tmp', `brief-${String(slug).replace(/[^a-z0-9._-]/gi, '_')}.json`);
}
function readClientCache(slug) {
  try {
    const cached = JSON.parse(fs.readFileSync(clientCachePath(slug), 'utf8'));
    const ts = cached?.ts ? new Date(cached.ts).getTime() : 0;
    if (ts && (Date.now() - ts) < BRIEF_CLIENT_TTL_MS) return cached;
  } catch { /* miss — fall through to a fresh fetch */ }
  return null;
}
function writeClientCache(slug, text) {
  try {
    fs.mkdirSync(path.join(EXP_DIR, 'tmp'), { recursive: true });
    fs.writeFileSync(clientCachePath(slug), JSON.stringify({ ts: new Date().toISOString(), slug, text }), 'utf8');
  } catch (err) {
    debugLog({ stage: 'cache_write_failed', slug, message: err?.message || String(err) });
  }
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function fetchBrief(slug, cwd) {
  const remote = getRemoteClient();
  if (remote) {
    try {
      const config = remote.loadConfig();
      if (remote.isRemoteEnabled(config)) {
        const res = await remote.postJsonForHook('/api/project-brief', { project: slug, cwd, limit: BRIEF_LIMIT }, { config });
        return res?.text || null;
      }
    } catch (err) {
      debugLog({ stage: 'remote_brief_failed', slug, message: err?.message || String(err) });
      return null;
    }
  }
  // Local mode
  const corePath = path.join(EXP_DIR, 'experience-core.js');
  if (!fs.existsSync(corePath)) {
    debugLog({ stage: 'skip', reason: 'experience-core.js not found' });
    return null;
  }
  try {
    const { buildProjectBrief } = require(corePath);
    if (typeof buildProjectBrief !== 'function') {
      debugLog({ stage: 'skip', reason: 'buildProjectBrief not exported' });
      return null;
    }
    const brief = await buildProjectBrief(slug, { limit: BRIEF_LIMIT });
    return brief?.text || null;
  } catch (err) {
    debugLog({ stage: 'local_brief_failed', slug, message: err?.message || String(err) });
    return null;
  }
}

let input = '';
const t = setTimeout(() => { debugLog({ stage: 'timeout' }); process.exit(0); }, STDIN_TIMEOUT_MS);
// Watchdog: force-quit only if natural drain hangs. Unref'd so it never keeps
// the loop alive on its own — when the handler finishes and undici sockets
// close, the process exits naturally (avoiding the Windows libuv double-close
// assertion that process.exit() trips while sockets are mid-teardown).
const hardExit = setTimeout(() => { debugLog({ stage: 'hard_exit' }); process.exit(0); }, HARD_EXIT_TIMEOUT_MS);
hardExit.unref();

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input || '{}');
    const hookEvent = data.hook_event_name || '';
    if (hookEvent && hookEvent !== 'SessionStart') {
      debugLog({ stage: 'skip', reason: 'not SessionStart', hookEvent });
      process.exitCode = 0; return;
    }
    const cwd = data.cwd || process.cwd();
    const slug = deriveProjectSlug(cwd);
    debugLog({ stage: 'parsed', source: data.source || null, cwd, slug, runtime: RUNTIME_OVERRIDE });

    // "Who Am I" v4.0 profile block — composed FRESH each session (never written
    // to the brief cache), entirely on-device, gated by the LIVE privacy level so
    // a downgrade/off takes effect next session. Independent of the slug: it fires
    // even on a no-slug / fact-less session. Fail-open: any error degrades to
    // brief-only and never drops the SessionStart injection.
    let profileBlock = '';
    try {
      const deps = _loadProfileDeps();
      if (deps) {
        const level = deps.config.getPrivacyLevel();
        if (level !== 'off') {
          const profile = deps.model.loadProfile(deps.config.getProfilePath());
          profileBlock = deps.render.renderProfileBlock(profile, { level, now: Date.now() }) || '';
          debugLog({ stage: 'profile_injected', level, injected: !!profileBlock, chars: profileBlock.length });
        } else {
          debugLog({ stage: 'profile_skip', reason: 'privacyLevel off' });
        }
      }
    } catch (err) {
      debugLog({ stage: 'profile_read_failed', message: err?.message || String(err) });
    }

    // Project Brief — only fetched when a slug exists. Client cache short-circuit
    // (brief changes slowly); the profile is deliberately NOT cached here.
    let text = null;
    let fromCache = false;
    if (slug) {
      const cached = readClientCache(slug);
      if (cached) { text = cached.text || null; fromCache = true; }
      else {
        const mute = suppressHookOutput();
        text = await withTimeout(fetchBrief(slug, cwd), INTERCEPT_TIMEOUT_MS);
        const muted = mute.restore();
        if (muted.length > 0) {
          debugLog({ stage: 'suppressed_output', count: muted.length, preview: muted.map(m => m.text).join('').slice(0, 240) });
        }
        if (text) writeClientCache(slug, text);
      }
    }

    debugLog({ stage: 'done', slug, hasBrief: !!text, hasProfile: !!profileBlock, fromCache });
    const additionalContext = [profileBlock, text].filter(Boolean).join('\n\n');
    if (additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext,
        }
      }));
    }
  } catch (err) {
    debugLog({ stage: 'error', message: err?.message || String(err) });
  }
  // Exit naturally so undici sockets close cleanly; hardExit (unref'd) is the
  // watchdog if drain ever hangs. See hardExit comment above.
  process.exitCode = 0;
});
