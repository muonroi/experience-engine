/**
 * utils.js — Shared utility functions for Experience Engine.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 * IMPORTANT: This is a pure extract — no behavior changes.
 * Improvements/optimizations happen AFTER full extraction is verified.
 */
'use strict';

const { getMinConfidence, getHighConfidence } = require('./config');
const { buildSemanticQuery } = require('./query-builder');

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

// ============================================================
//  Framework detection (cached per project root)
//  Walks up from filePath looking for stack markers. Returns
//  a lowercase framework token or null. Consumers lowercase
//  it again before comparison (see experience-core.js).
// ============================================================

const _FRAMEWORK_CACHE = new Map();
const _FRAMEWORK_CACHE_MAX = 256;

const _FRAMEWORK_MARKERS = [
  { ext: '.csproj', framework: 'dotnet' },
  { ext: '.fsproj', framework: 'dotnet' },
  { ext: '.sln', framework: 'dotnet' },
  { file: 'Cargo.toml', framework: 'rust' },
  { file: 'go.mod', framework: 'go' },
  { file: 'pyproject.toml', framework: 'python' },
  { file: 'requirements.txt', framework: 'python' },
  { file: 'pom.xml', framework: 'java' },
  { file: 'build.gradle', framework: 'java' },
  { file: 'build.gradle.kts', framework: 'java' },
  { file: 'Gemfile', framework: 'ruby' },
];

const _PKG_DEP_FRAMEWORKS = [
  { dep: 'next', framework: 'next' },
  { dep: '@nestjs/core', framework: 'nest' },
  { dep: 'nuxt', framework: 'nuxt' },
  { dep: 'react-native', framework: 'react-native' },
  { dep: 'expo', framework: 'expo' },
  { dep: 'react', framework: 'react' },
  { dep: 'vue', framework: 'vue' },
  { dep: 'svelte', framework: 'svelte' },
  { dep: 'electron', framework: 'electron' },
];

function _scanDirForFramework(dir, fs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  const fileNames = new Set();
  for (const e of entries) if (e.isFile()) fileNames.add(e.name);

  for (const m of _FRAMEWORK_MARKERS) {
    if (m.ext) {
      for (const n of fileNames) {
        if (n.toLowerCase().endsWith(m.ext)) return m.framework;
      }
    } else if (m.file && fileNames.has(m.file)) {
      return m.framework;
    }
  }

  if (fileNames.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      for (const { dep, framework } of _PKG_DEP_FRAMEWORKS) {
        if (deps[dep]) return framework;
      }
      return null;
    } catch { return null; }
  }
  return null;
}

function detectFrameworkFromProject(filePath) {
  if (!filePath) return null;
  const fs = require('fs');
  const path = require('path');
  let dir = path.dirname(filePath.replace(/\\/g, '/'));
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === '/' || dir === '.' || /^[A-Za-z]:\/?$/.test(dir)) break;
    if (_FRAMEWORK_CACHE.has(dir)) return _FRAMEWORK_CACHE.get(dir);
    const fw = _scanDirForFramework(dir, fs);
    if (fw) {
      if (_FRAMEWORK_CACHE.size >= _FRAMEWORK_CACHE_MAX) _FRAMEWORK_CACHE.clear();
      _FRAMEWORK_CACHE.set(dir, fw);
      return fw;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

// Org-stack membership test — hints tagged scope.org=<orgName> only fire when
// the file under work belongs to a repo in the user-configured org.
//
// Configuration (per-user, in ~/.experience/config.json):
//   { "org": { "name": "<orgName>", "repoPatterns": ["<slug>", "prefix-*", ...] } }
//
// Matching rules against the file's extracted project slug:
//   1. exact match to orgConfig.name
//   2. slug starts with `${orgConfig.name}-`  (e.g. org="acme" → "acme-web" matches)
//   3. exact match to any literal pattern (case-insensitive)
//   4. glob match if pattern contains `*` (only `*` wildcard is supported)
//
// If orgConfig is absent or has no name, returns false → engine runs in
// "global mode" where the org filter never fires and every hint is eligible.
// The repo itself contains zero hardcoded org names by design.
function _patternToRegex(pat) {
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function isOrgStackRepo(filePath, orgConfig) {
  if (!orgConfig || typeof orgConfig.name !== 'string' || !orgConfig.name.trim()) return false;
  const slug = extractProjectSlug(filePath);
  if (!slug) return false;
  const name = orgConfig.name.trim().toLowerCase();
  if (slug === name || slug.startsWith(`${name}-`)) return true;
  const patterns = Array.isArray(orgConfig.repoPatterns) ? orgConfig.repoPatterns : [];
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const trimmed = p.trim();
    if (trimmed.includes('*')) {
      if (_patternToRegex(trimmed).test(slug)) return true;
    } else if (trimmed.toLowerCase() === slug) {
      return true;
    }
  }
  return false;
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

// Code identifiers (PascalCase types, qualified Type.Method, class : Parent) embed
// far from natural-language trigger phrases ("When setting timestamps, use
// XDateTimeService..."). We extract those identifiers and prepend an NL hint so
// the query vector lands closer to NL trigger vectors. Verified +0.15 cosine
// improvement on benchmark cases (qualified-symbol query: 0.536 → 0.691).
const _IDENT_PATTERNS = [
  /\bclass\s+\w+\s*:\s*([A-Z][A-Za-z0-9_]*)/g,       // class X : ParentBase  → ParentBase
  /\b([A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]+)\b/g,    // DateTime.UtcNow, SaveChangesAsync (qualified)
  /\b(I[A-Z][A-Za-z0-9_]+(?:Accessor|Service|Context|Repository|Logger|Factory|Provider|Handler))\b/g, // I-prefixed interfaces (common .NET shape)
  /\b([A-Z][A-Za-z0-9_]+(?:Async|Controller|Handler|Service|Repository|Context|Factory|Builder))\b/g, // common .NET type suffixes
  /\bthrow\s+new\s+([A-Z][A-Za-z0-9_]+Exception)\b/g, // throw new XException
];

// Guard against regex blowup on huge diffs: 5 global regexes × O(n) is O(5n),
// and pathological inputs (long runs of capital letters / IPattern… sequences)
// can compound. Hard-cap input size so worst-case latency stays bounded.
// 8000 chars covers every realistic single-file edit; bigger diffs lose only
// the augmentation, not retrieval (cosine still runs on the raw action).
const _EXTRACT_MAX_INPUT = 8000;
const _EXTRACT_ITER_BUDGET = 2000;

function extractCodeSymbols(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const scanText = text.length > _EXTRACT_MAX_INPUT ? text.slice(0, _EXTRACT_MAX_INPUT) : text;
  const seen = new Set();
  const ordered = [];
  const limit = 8;
  let iters = 0;
  for (const re of _IDENT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanText)) !== null) {
      if (++iters > _EXTRACT_ITER_BUDGET) return ordered;
      const sym = m[1];
      if (!sym) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      ordered.push(sym);
      if (ordered.length >= limit) return ordered;
    }
  }
  return ordered;
}

function buildQuery(toolName, toolInput) {
  // Delegate to intent-based query builder. The old implementation sent raw
  // code content which embedded far from natural-language principles (avg
  // cosine 0.27). The new builder extracts INTENT — what the agent is doing —
  // producing queries that embed much closer to brain entry text.
  const symbols = (() => {
    const raw = toolInput?.new_string || toolInput?.content || toolInput?.old_string || toolInput?.command || '';
    const actionStr = String(raw || toolName || '').trim();
    const codeShape = /(?:[A-Z][A-Za-z0-9_]+(?:\.[A-Z]|<|\s*:\s*[A-Z]|Async\b|Exception\b))|(?:\bI[A-Z][A-Za-z0-9_]+(?:Accessor|Service|Context|Repository|Logger|Factory|Provider|Handler)\b)|(?:\bM[A-Z][A-Za-z]{2,}\b)/;
    if (actionStr.length > 8 && codeShape.test(actionStr)) {
      return extractCodeSymbols(actionStr);
    }
    return [];
  })();
  return buildSemanticQuery(toolName, toolInput, { existingSymbols: symbols });
}

// ============================================================
//  Scoring
// ============================================================

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  // Seed entries originate from authoritative org docs / common standards; their
  // confidence shouldn't be discounted for lack of usage hits. ageFactor was
  // designed for organic entries that should prove themselves via accumulated
  // validations — applying it to seeds drops effConf below minConfidence and
  // gets them filtered out at display time even when retrieval is perfect.
  if (typeof data?.createdFrom === 'string' && data.createdFrom.startsWith('seed-')) return base;
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;

function getValidatedHitCount(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.validatedCount === 'number') return data.validatedCount;
  return 0;
}

// hitBoost cap: organic entries with many hits previously got unbounded boost
// (log2(1+100)*0.08 = +0.53), letting a 0.45-cosine old entry beat a 0.85-cosine
// fresh seed. Cap so cosine remains the primary signal, hits a tiebreaker.
const HIT_BOOST_MAX = 0.12;

function isSeedEntry(data) {
  return typeof data?.createdFrom === 'string' && data.createdFrom.startsWith('seed-');
}

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug, queryText = '') {
  const cosine = point.score || 0;
  const hitBoost = Math.min(HIT_BOOST_MAX, Math.log2(1 + (data.hitCount || 0)) * 0.08);
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
  // v3: bypass penalty for seed entries (createdFrom starts with 'seed-'); they originate from
  // org docs not project files, so 'missing _projectSlug' is by design, not unknown origin.
  // Cross-repo leak is already prevented by Qdrant pre-filter on scope_org.
  let projectPenalty = 0;
  if (queryProjectSlug && !isSeedEntry(data)) {
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
    // Suppress anti-recommendations (negative or sub-threshold effective score).
    if (!point._probationaryT2 && displayScore < getMinConfidence()) continue;
    // Probationary still gets floored at score=0 — mirror of format.js.
    if (point._probationaryT2 && displayScore < 0) continue;
    // Instant noise suppression (mirror of format.js).
    if ((exp.irrelevantCount || 0) >= 3) continue;
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
  detectContext, normalizeTechLabel, commandSuggestsDomain, detectFrameworkFromProject,
  extractProjectPath, extractProjectSlug, extractPathFromCommand, isAbsolutePath,
  isOrgStackRepo,
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
