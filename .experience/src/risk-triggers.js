/**
 * risk-triggers.js — deterministic detection of "this step is risky" conditions.
 *
 * The recall nudge used to fire every turn and delegate "is this risky?" to the
 * agent — which always had a ready rationalization to skip. This module moves the
 * classification OUT of the agent's hands: hooks call detectRiskTriggers() and only
 * surface a recall gate when a concrete condition matches.
 *
 * detectRiskTriggers is PURE (no filesystem) — the caller injects `repoRootOf` so
 * cross-repo detection stays testable. gitRepoRootOf() is the real fs-walking
 * implementation the hooks pass in.
 */
'use strict';

const pathMod = require('node:path');
const fs = require('node:fs');

// Fallback list when the caller passes none. Source of truth at runtime is
// config.getRiskKeywords(); this default only guards tests / un-synced clients.
const DEFAULT_KEYWORDS = [
  'rate limit', 'rate-limit', 'auth', 'oauth', 'token', 'secret', 'credential', 'password',
  'migration', 'migrate', 'deploy', 'cors', 'interceptor', 'rm -rf', 'force push', 'force-push',
  'drop table', 'reset --hard', 'prod', 'production', 'truncate', 'webhook',
];

const MAX_TRIGGERS = 3;

function matchKeywords(text, keywords) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return [];
  const seen = new Set();
  const hits = [];
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    if (hay.includes(k)) { seen.add(k); hits.push(k); }
  }
  return hits;
}

function snippetAround(text, keyword, radius = 40) {
  const hay = String(text || '');
  const i = hay.toLowerCase().indexOf(String(keyword).toLowerCase());
  if (i < 0) return String(keyword);
  const start = Math.max(0, i - radius);
  const end = Math.min(hay.length, i + keyword.length + radius);
  return `${start > 0 ? '…' : ''}${hay.slice(start, end).replace(/\s+/g, ' ').trim()}${end < hay.length ? '…' : ''}`;
}

/**
 * @param {object} args
 * @param {string} [args.promptText]   user prompt (UserPromptSubmit)
 * @param {string} [args.toolName]
 * @param {object} [args.toolInput]    { command, file_path, path, ... }
 * @param {string} [args.cwd]
 * @param {string[]} [args.keywords]   risk keyword list (defaults to DEFAULT_KEYWORDS)
 * @param {(absPath:string)=>string|null} [args.repoRootOf]  injected for cross-repo (pure)
 * @returns {Array<{kind:string, topic:string, evidence:string}>}
 */
function detectRiskTriggers({ promptText = '', toolInput = {}, cwd = '', keywords, repoRootOf } = {}) {
  const kws = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const triggers = [];

  // 1. Sensitive keyword — scan prompt text AND the tool command.
  const cmd = String((toolInput && (toolInput.command || toolInput.cmd)) || '');
  const haystacks = [promptText, cmd];
  const matchedTopics = new Set();
  for (const text of haystacks) {
    for (const kw of matchKeywords(text, kws)) {
      if (matchedTopics.has(kw)) continue;
      matchedTopics.add(kw);
      triggers.push({ kind: 'sensitive-keyword', topic: kw, evidence: snippetAround(text, kw) });
      if (triggers.length >= MAX_TRIGGERS) return triggers;
    }
  }

  // 2. Cross-repo — a file path under a different git repo root than cwd's.
  if (typeof repoRootOf === 'function') {
    const filePath = toolInput && (toolInput.file_path || toolInput.path);
    if (filePath && cwd) {
      try {
        const abs = pathMod.isAbsolute(filePath) ? filePath : pathMod.resolve(cwd, filePath);
        const fileRoot = repoRootOf(abs);
        const cwdRoot = repoRootOf(cwd);
        if (fileRoot && cwdRoot && pathMod.resolve(fileRoot) !== pathMod.resolve(cwdRoot)) {
          triggers.push({ kind: 'cross-repo', topic: pathMod.basename(fileRoot), evidence: `${filePath} is under ${fileRoot}, not ${cwdRoot}` });
        }
      } catch { /* path resolution failure → no cross-repo trigger */ }
    }
  }

  return triggers.slice(0, MAX_TRIGGERS);
}

/** Real repo-root resolver: walk up from absPath to the nearest .git dir. fs-touching. */
function gitRepoRootOf(absPath) {
  try {
    let dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : pathMod.dirname(absPath);
    for (let i = 0; i < 40 && dir; i++) {
      if (fs.existsSync(pathMod.join(dir, '.git'))) return dir;
      const parent = pathMod.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (err) {
    console.error(`[risk-triggers] repo-root walk failed for ${absPath}: ${err?.message}`);
  }
  return null;
}

module.exports = { detectRiskTriggers, matchKeywords, gitRepoRootOf, DEFAULT_KEYWORDS, MAX_TRIGGERS };
