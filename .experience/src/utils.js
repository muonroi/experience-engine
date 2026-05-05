/**
 * utils.js — Shared utility functions for Experience Engine.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 * IMPORTANT: This is a pure extract — no behavior changes.
 * Improvements/optimizations happen AFTER full extraction is verified.
 */
'use strict';

const { getMinConfidence, getHighConfidence } = require('./config');

// ============================================================
//  Language/context detection
// ============================================================

const LANG_MAP = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.cs': 'C#', '.fs': 'F#',
  '.py': 'Python', '.rb': 'Ruby',
  '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.cpp': 'C++', '.c': 'C',
  '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
  '.xml': 'XML', '.proto': 'Protobuf',
  '.dockerfile': 'Docker', '.tf': 'Terraform',
};

function detectContext(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  const ext = '.' + parts.pop().toLowerCase();
  return LANG_MAP[ext] || null;
}

function normalizeTechLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'typescript react' || normalized === 'typescript') return 'typescript';
  if (normalized === 'javascript react' || normalized === 'javascript') return 'javascript';
  if (normalized === 'csharp' || normalized === 'c#') return 'c#';
  if (normalized === 'fsharp' || normalized === 'f#') return 'f#';
  if (normalized === 'yaml') return 'yaml';
  return normalized;
}

const DOMAIN_KEYWORDS = {
  javascript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  typescript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  python: ['python', 'pip', 'pytest', 'poetry', 'uv', 'ruff'],
  'c#': ['dotnet', 'nuget', 'msbuild', 'csc'],
  java: ['java', 'javac', 'mvn', 'gradle'],
  rust: ['cargo', 'rustc'],
  go: ['go test', 'go build', 'gofmt'],
  ruby: ['bundle', 'bundler', 'rspec', 'ruby'],
  shell: ['bash', 'sh ', 'zsh'],
};

function commandSuggestsDomain(actionText, domain) {
  const keywords = DOMAIN_KEYWORDS[normalizeTechLabel(domain)];
  if (!keywords || keywords.length === 0) return false;
  const text = String(actionText || '').toLowerCase();
  return keywords.some(keyword => text.includes(keyword));
}

// ============================================================
//  Path extraction
// ============================================================

/**
 * Check if a path string looks like an absolute path (any OS).
 */
function isAbsolutePath(p) {
  if (!p) return false;
  // Windows: C:\ or C:/
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // Unix/MSYS: starts with /
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * Extract a meaningful project path from a shell command string.
 * Handles: cd targets, explicit file paths in arguments.
 * Supports: Windows (D:\path), Unix (/path), mixed (D:/path), MSYS (/d/path).
 * Returns first valid absolute path found, or null.
 */
function extractPathFromCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;

  // Strategy 1: Look for "cd <path>" — strongest project signal
  // Matches: cd "path", cd 'path', cd path (with &&, ||, ; terminators)
  const cdMatch = cmd.match(/\bcd\s+["']?([^"';&|$\n]+?)["']?\s*(?:[;&|]|\s*$)/);
  if (cdMatch) {
    const p = cdMatch[1].trim();
    if (isAbsolutePath(p)) return p;
  }

  // Strategy 2: Scan for absolute paths in the command
  // Collects all candidate paths and picks the best (longest, most specific)
  const candidates = [];

  // Windows: D:\path or D:/path (drive letter)
  const winMatches = cmd.matchAll(/[A-Za-z]:[\\/][^\s"';&|$*?<>]+/g);
  for (const m of winMatches) candidates.push(m[0]);

  // Unix absolute: /path/to/something (at least 2 segments to avoid bare /)
  const unixMatches = cmd.matchAll(/(?:^|\s|["'=])(\/{1}(?!dev\/null)[A-Za-z][^\s"';&|$*?<>]*\/[^\s"';&|$*?<>]*)/g);
  for (const m of unixMatches) candidates.push(m[1]);

  // MSYS: /d/Personal/... (single lowercase letter after /)
  const msysMatches = cmd.matchAll(/\/([a-z])\/[^\s"';&|$*?<>]+/g);
  for (const m of msysMatches) candidates.push(m[0]);

  if (candidates.length === 0) return null;

  // Pick the longest candidate (most specific path = best project signal)
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * Extract a project slug from a file path for project-aware filtering.
 * Detects common patterns: /sources/{org}/{project}/, /repos/{project}/, etc.
 * Returns lowercase slug or null.
 */
function extractProjectSlug(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  // Match common repo-workspace layouts first so Windows/WSL paths map to the same slug.
  const patterns = [
    /^[a-z]:\/personal\/core\/([^/]+)/i,
    /\/mnt\/[a-z]\/personal\/core\/([^/]+)/i,
    /^[a-z]:\/sources\/[^/]+\/([^/]+)/i,
    /\/sources\/[^/]+\/([^/]+)/i,
    /\/repos\/([^/]+)/i,
    /\/projects\/([^/]+)/i,
    /\/workspace\/([^/]+)/i,
    /\/home\/[^/]+\/([^/]+)/i,
  ];
  for (const pat of patterns) {
    const m = normalized.match(pat);
    if (m) return m[1].toLowerCase();
  }
  const explicitRepo = normalized.match(/\/([^/]+)\/(?:src|tests|test|tools|docs|sdk|\.experience|bin)(?:\/|$)/i);
  if (explicitRepo) return explicitRepo[1].toLowerCase();
  // Fallback: use first 2 meaningful path segments
  const parts = normalized.split('/').filter(p => p && p !== '.' && p !== '..');
  if (parts.length >= 2) return parts.slice(0, 2).join('/').toLowerCase();
  return null;
}

function extractProjectPath(toolInput) {
  const raw = toolInput?.file_path || toolInput?.path || '';
  if (raw) return raw.replace(/\\/g, '/');

  // For Bash/Shell commands: extract project path from command text
  const cmd = toolInput?.command || toolInput?.cmd || '';
  if (!cmd) return null;

  const extracted = extractPathFromCommand(cmd);
  return extracted ? extracted.replace(/\\/g, '/') : null;
}

// ============================================================
//  Query Building
// ============================================================

const QUERY_MAX_CHARS = 500;

function buildQuery(toolName, toolInput) {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  const lang = detectContext(filePath);
  const prefix = lang ? `[${lang}] ` : '';
  let action = toolInput?.command || toolInput?.cmd || toolInput?.new_string || toolInput?.content || toolInput?.old_string || '';
  if (!action && toolInput?.new_string) action = toolInput.new_string;
  if (!action && toolInput?.content) action = toolInput.content;
  const query = `${prefix}${String(action || toolName || '').trim()}`;
  return query.slice(0, QUERY_MAX_CHARS);
}

// ============================================================
//  Scoring
// ============================================================

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;

function getValidatedHitCount(data) {
  if (!data || typeof data !== 'object') return 0;
  return data.hitCount || 0;
}

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug, queryText = '') {
  const cosine = point.score || 0;
  const hitBoost = Math.log2(1 + (data.hitCount || 0)) * 0.08;
  const normalizedQuery = String(queryText || '').toLowerCase();
  const daysSinceHit = data.lastHitAt
    ? (Date.now() - new Date(data.lastHitAt).getTime()) / 86400000
    : 0;
  const recencyPenalty = daysSinceHit > 30
    ? Math.min(0.15, (daysSinceHit - 30) / 335 * 0.15)
    : 0;
  const ignorePenalty = Math.min(0.30, (data.ignoreCount || 0) * 0.05);
  const irrelevantPenalty = Math.min(0.24, (data.irrelevantCount || 0) * 0.04);
  const unusedPenalty = Math.min(0.18, (data.unusedCount || 0) * 0.03);
  const noiseReasonCounts = data.noiseReasonCounts || {};
  const noiseReasonPenalty = Math.min(
    0.18,
    ((noiseReasonCounts.wrong_repo || 0) * 0.05)
      + ((noiseReasonCounts.wrong_language || 0) * 0.04)
      + ((noiseReasonCounts.wrong_task || 0) * 0.03)
      + ((noiseReasonCounts.stale_rule || 0) * 0.06)
  );
  // P3: Heavier domain penalty (was 0.08/0.03, now 0.20/0.05)
  const domainPenalty = (queryDomain && data.domain && queryDomain !== data.domain) ? 0.20
    : (queryDomain && !data.domain) ? 0.05 : 0;
  // P0: Project-aware penalty — cross-project suggestions heavily penalized
  // v2: bypass penalty when scope.lang='all' (universal behavioral rules should surface everywhere)
  let projectPenalty = 0;
  if (queryProjectSlug) {
    const scopeLang = data.scope?.lang;
    const principleLike = !!data.principle || data.createdFrom === 'evolution-abstraction' || getValidatedHitCount(data) >= SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD;
    if (scopeLang === 'all') {
      projectPenalty = 0; // Universal rules surface everywhere
    } else if (!data._projectSlug) {
      // No project slug on entry — apply heavier penalty (unknown origin)
      projectPenalty = principleLike ? 0.10 : 0.35;
    } else if (queryProjectSlug !== data._projectSlug) {
      // Cross-project — near-elimination penalty for non-principles
      projectPenalty = principleLike ? 0.22 : 0.85;
    }
  }
  // Phase 108: temporal boost/penalty from confirmedAt trace
  let temporalAdj = 0;
  const confirmed = Array.isArray(data.confirmedAt) ? data.confirmedAt : [];
  if (confirmed.length > 0) {
    const mostRecent = new Date(confirmed[confirmed.length - 1]).getTime();
    const daysSinceConfirm = (Date.now() - mostRecent) / 86400000;
    if (daysSinceConfirm <= 7) temporalAdj = 0.05;       // recently confirmed — boost
    else if (daysSinceConfirm > 60) temporalAdj = -0.08;  // stale — penalty
  }
  let conditionAdj = 0;
  if (Array.isArray(data.conditions) && data.conditions.length > 0) {
    const normalizedConditions = data.conditions
      .map((condition) => String(condition || '').trim().toLowerCase())
      .filter(Boolean);
    const matchedConditions = normalizedConditions.filter((condition) => normalizedQuery.includes(condition));
    if (matchedConditions.length === 0) conditionAdj = -0.14;
    else conditionAdj = Math.min(0.12, matchedConditions.length * 0.04);
  }
  // Phase 108: superseded experience penalty
  const supersededPenalty = data.superseded ? 0.15 : 0;
  // Wave 3: Confidence weighting — low-confidence entries rank lower
  const confWeight = computeEffectiveConfidence(data);
  const rawScore = cosine + hitBoost - recencyPenalty - ignorePenalty - irrelevantPenalty - unusedPenalty - noiseReasonPenalty - domainPenalty - projectPenalty + temporalAdj + conditionAdj - supersededPenalty;
  return rawScore * (0.6 + 0.4 * confWeight); // scale: 0.6 floor to avoid zeroing out
}

// ============================================================
//  Rerank by quality
// ============================================================

function rerankByQuality(points, queryDomain, queryProjectSlug, queryText = '') {
  return points
    .map(p => {
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      return { ...p, _effectiveScore: computeEffectiveScore(p, data, queryDomain, queryProjectSlug, queryText) };
    })
    .sort((a, b) => b._effectiveScore - a._effectiveScore);
}

// ============================================================
//  Format suggestions
// ============================================================

function formatPoints(points) {
  const lines = [];
  for (const point of points) {
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    const effConf = computeEffectiveConfidence(exp);
    if (effConf < getMinConfidence() && !point._probationaryT2) continue;
    const displayScore = point._effectiveScore ?? point.score ?? 0;
    let line;
    if (point._probationaryT2) {
      line = `💡 [Probationary Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else if (displayScore >= getHighConfidence()) {
      line = `⚠️ [Experience - High Confidence (${displayScore.toFixed(2)})]: ${exp.solution}`;
    } else {
      line = `💡 [Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`;
    }
    if (exp.why) {
      line += `\n   Why: ${exp.why}`;
    }
    const pid = String(point.id).slice(0, 8);
    const coll = point._collection || 'experience-behavioral';
    line += `\n   [id:${pid} col:${coll}]`;
    // v3: inline feedback — agent reports noisy/wrong hints
    line += `\n   ↩ Wrong? POST /api/feedback {"pointId":"${pid}","collection":"${coll}","verdict":"IRRELEVANT","reason":"wrong_repo"}`;
    lines.push(line);
  }
  return lines;
}

// ============================================================
//  Point dedup + budget
// ============================================================

function dedupePointsBySource(points, fallbackCollection) {
  const seen = new Set();
  const unique = [];
  for (const point of points || []) {
    if (!point) continue;
    const key = pointSourceKey(point, fallbackCollection);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    if (fallbackCollection && !point._collection) {
      unique.push({ ...point, _collection: fallbackCollection });
    } else { unique.push(point); }
  }
  return unique;
}

function pointSourceKey(point, fallbackCollection) {
  const collection = point?._collection || fallbackCollection || '';
  const pointId = String(point?.id || '');
  return pointId ? `${collection}:${pointId}` : null;
}

function applyBudget(lines, maxChars) {
  let total = 0;
  const result = [];
  for (const line of lines) {
    const len = line.length;
    if (total + len > maxChars && result.length > 0) break;
    total += len;
    result.push(line);
  }
  return result;
}

// ============================================================
//  Noise suppression
// ============================================================

function inferLanguageMismatch(surface, actionDomain) {
  const scopeLang = normalizeTechLabel(surface?.scope?.lang);
  const hintDomain = normalizeTechLabel(surface?.domain);
  const normalizedAction = normalizeTechLabel(actionDomain);
  if (!normalizedAction) return false;
  if (scopeLang === 'all') return false;
  if (scopeLang && normalizedAction && scopeLang !== normalizedAction) return true;
  if (!scopeLang && hintDomain && normalizedAction && hintDomain !== normalizedAction) return true;
  return false;
}

const RECENT_VALIDATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function hasRecentValidatedConfirmation(data, nowMs = Date.now()) {
  const candidates = [];
  if (data?.lastHitAt) candidates.push(data.lastHitAt);
  if (Array.isArray(data?.confirmedAt)) candidates.push(...data.confirmedAt);
  for (const candidate of candidates) {
    const ts = new Date(candidate).getTime();
    if (Number.isFinite(ts) && nowMs - ts <= RECENT_VALIDATION_WINDOW_MS) return true;
  }
  return false;
}

function isCodeSpecificHint(data) {
  const scopeLang = normalizeTechLabel(data?.scope?.lang);
  if (scopeLang && scopeLang !== 'all') return true;
  const domain = normalizeTechLabel(data?.domain);
  return !!domain && domain !== 'all' && domain !== 'markdown' && domain !== 'json' && domain !== 'yaml';
}

function shouldSuppressForNoise(data, context = {}) {
  if (!data || typeof data !== 'object') return { suppress: false };
  if (hasRecentValidatedConfirmation(data)) return { suppress: false, reason: 'recent_validation' };
  const counts = data.noiseReasonCounts || {};
  const qps = context.queryProjectSlug || null;
  const qd = context.queryDomain || null;
  const ak = context.actionKind || 'unknown';
  if ((counts.wrong_repo || 0) >= 1 && data._projectSlug && qps && data._projectSlug !== qps) return { suppress: true, reason: 'wrong_repo' };
  if ((counts.wrong_language || 0) >= 1 && inferLanguageMismatch({ scope: data.scope, domain: data.domain }, qd)) return { suppress: true, reason: 'wrong_language' };
  if ((counts.wrong_task || 0) >= 1 && (ak === 'docs' || ak === 'config' || ak === 'ops') && isCodeSpecificHint(data)) return { suppress: true, reason: 'wrong_task' };
  if ((counts.stale_rule || 0) >= 1) return { suppress: true, reason: 'stale_rule' };
  return { suppress: false };
}

function filterNoiseSuppressedPoints(points, context = {}) {
  const kept = [];
  const suppressed = [];
  for (const point of points || []) {
    let data = {};
    try { data = JSON.parse(point.payload?.json || '{}'); } catch {}
    const decision = shouldSuppressForNoise(data, context);
    if (decision.suppress) suppressed.push({ point, reason: decision.reason });
    else kept.push(point);
  }
  return { kept, suppressed };
}

// ============================================================
//  Normalize source meta
// ============================================================

function normalizeSourceMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  return {
    ...(meta.sourceKind ? { sourceKind: meta.sourceKind } : {}),
    ...(meta.sourceRuntime ? { sourceRuntime: meta.sourceRuntime } : {}),
    ...(meta.sourceSession ? { sourceSession: meta.sourceSession } : {}),
  };
}

function resolveRuntimeFromSourceMeta(sourceMeta, fallbackRuntime) {
  const normalized = String(sourceMeta?.sourceRuntime || '').trim().toLowerCase();
  if (normalized.startsWith('codex')) return 'codex';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('opencode')) return 'opencode';
  return fallbackRuntime;
}

function detectRuntime(toolName) {
  const tool = (toolName || '').toLowerCase();
  if (process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR
    || /^(run_shell_command|write_file|edit_file|replace_in_file)$/.test(tool)) return 'gemini';
  if (process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.OPENCODE_SESSION_ID) return 'opencode';
  return 'claude';
}

// ============================================================
//  Exports
// ============================================================

module.exports = {
  detectContext, normalizeTechLabel, commandSuggestsDomain,
  extractProjectPath, extractProjectSlug, extractPathFromCommand, isAbsolutePath,
  buildQuery, QUERY_MAX_CHARS,
  computeEffectiveConfidence, computeEffectiveScore, getValidatedHitCount,
  rerankByQuality,
  formatPoints,
  dedupePointsBySource, pointSourceKey, applyBudget,
  inferLanguageMismatch,
  hasRecentValidatedConfirmation, isCodeSpecificHint,
  shouldSuppressForNoise, filterNoiseSuppressedPoints,
  normalizeSourceMeta, resolveRuntimeFromSourceMeta, detectRuntime,
};
