'use strict';
/**
 * lib/path-canonical.js — Server-side path canonicalization for project_slug derivation.
 *
 * canonicalizeProjectSlug(rawPath, repoPatterns?) → string | null
 *
 * Strips host drive letters and OS path prefixes, normalizes separators to '/',
 * then matches the last path segment that appears in org.repoPatterns from config.json.
 *
 * Returns the matched slug or null if no pattern matches.
 * Logs a one-time warning at startup when repoPatterns is absent/empty.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Load config once.
let _configCache = null;
function _loadConfig() {
  if (_configCache !== null) return _configCache;
  try {
    _configCache = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')
    );
  } catch {
    _configCache = {};
  }
  return _configCache;
}

// Track whether the "no repoPatterns" warning has fired.
let _warnedMissingPatterns = false;

/**
 * Normalize a raw intercept path to forward-slash form and strip drive letter.
 * Examples:
 *   D:/sources/Core/muonroi-building-block/src/X.cs → /sources/Core/muonroi-building-block/src/X.cs
 *   /d/sources/Core/muonroi-building-block/src/X.cs → /sources/Core/muonroi-building-block/src/X.cs (WSL drive)
 *   ~/projects/storyflow_ui/readme.md             → /home/<user>/projects/storyflow_ui/readme.md (tilde expanded)
 *   C:\sources\muonroi-building-block\X.cs        → /sources/muonroi-building-block/X.cs
 */
function normalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  // Expand tilde
  let p = rawPath.trim();
  if (p.startsWith('~')) {
    p = os.homedir() + p.slice(1);
  }
  // Strip Windows long-path UNC prefix (\\?\C:\... → C:\...) BEFORE backslash normalize.
  p = p.replace(/^\\\\\?\\/, '');
  // Normalize backslash to forward slash
  p = p.replace(/\\/g, '/');
  // Strip Windows drive letter (e.g. D:/ → /)
  p = p.replace(/^[A-Za-z]:/, '');
  // Normalize WSL drive mount prefixes: /d/sources → /sources, /mnt/d/sources → /sources
  p = p.replace(/^\/mnt\/[a-z]\//i, '/');
  p = p.replace(/^\/[a-z]\/(?=[A-Za-z])/i, '/');
  return p;
}

/**
 * Given a normalized path, return the segments as an array.
 * E.g. "/sources/Core/muonroi-building-block/src" → ["sources", "Core", "muonroi-building-block", "src"]
 */
function pathSegments(normalizedPath) {
  return normalizedPath.split('/').filter(Boolean);
}

/**
 * Canonicalize a raw intercept path → project slug.
 *
 * @param {string} rawPath       — raw path from intercept payload
 * @param {string[]} [patterns]  — override repoPatterns (used in tests / standalone callers)
 * @returns {string|null}
 */
function canonicalizeProjectSlug(rawPath, patterns) {
  const cfg = _loadConfig();
  const repoPatterns = patterns ?? (Array.isArray(cfg?.org?.repoPatterns) ? cfg.org.repoPatterns : null);

  if (!repoPatterns || repoPatterns.length === 0) {
    if (!_warnedMissingPatterns) {
      _warnedMissingPatterns = true;
      // Use stderr so it surfaces as a startup warning regardless of log level.
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'path_canonical_no_patterns',
          detail: 'org.repoPatterns absent or empty in ~/.experience/config.json — project_slug backfill will produce null for all paths',
        }) + '\n'
      );
    }
    return null;
  }

  const normalized = normalizePath(rawPath);
  const segments = pathSegments(normalized);

  // Walk segments right-to-left: first match wins (closest to file).
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    // Exact match against any pattern (case-insensitive on Windows paths).
    if (repoPatterns.some((pat) => seg.toLowerCase() === pat.toLowerCase())) {
      // Return the original casing from repoPatterns for canonical form.
      const found = repoPatterns.find((pat) => seg.toLowerCase() === pat.toLowerCase());
      return found;
    }
  }

  return null;
}

/**
 * Reset the warning latch — useful in tests.
 */
function _resetWarnLatch() {
  _warnedMissingPatterns = false;
}

module.exports = { canonicalizeProjectSlug, normalizePath, pathSegments, _resetWarnLatch };
