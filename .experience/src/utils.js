/**
 * utils.js — Shared utility functions for Experience Engine.
 * Pure functions: scoring, formatting, context detection, noise analysis.
 * Extracted from experience-core.js. Zero npm dependencies.
 */
'use strict';

// ============================================================
//  Context Detection
// ============================================================

const EXT_MAP = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.cs': 'C#', '.fs': 'F#', '.py': 'Python', '.rb': 'Ruby',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.php': 'PHP', '.scala': 'Scala',
  '.css': 'CSS', '.scss': 'CSS', '.less': 'CSS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON', '.xml': 'XML', '.toml': 'TOML',
  '.md': 'Markdown', '.mdx': 'Markdown', '.sql': 'SQL',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
  '.dockerfile': 'Docker', '.tf': 'Terraform',
};

function detectContext(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const [ext, lang] of Object.entries(EXT_MAP)) {
    if (normalized.endsWith(ext)) return lang;
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
//  Path / Project Slug
// ============================================================

function extractProjectPath(toolInput) {
  return toolInput?.file_path || toolInput?.path || toolInput?.cmd || toolInput?.command || '';
}

function extractProjectSlug(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const patterns = [
    /\/sources\/[^/]+\/([^/]+)/,
    /\/repos\/([^/]+)/,
    /\/projects\/([^/]+)/,
    /\/workspace\/([^/]+)/,
    /\/Personal\/([^/]+)/,
    /\/Code\/([^/]+)/,
    /\/muonroi\/([^/]+)/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1].replace(/[^a-z0-9._-]/g, '');
  }
  return null;
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

function computeEffectiveScore(point, data, queryDomain, queryProjectSlug, queryText) {
  let score = point.score || 0;
  const conf = computeEffectiveConfidence(data);
  const confWeight = Math.max(0.6, Math.min(1.0, conf * 0.7 + 0.3));
  score *= confWeight;
  if (queryDomain && data.domain) {
    const qd = normalizeTechLabel(queryDomain);
    const dd = normalizeTechLabel(data.domain);
    if (qd && dd && qd !== dd) score -= 0.08;
  }
  const hits = data.hitCount || 0;
  if (hits > 0) score += Math.log2(hits + 1) * 0.05;
  if (data.lastHitAt) {
    const daysSince = (Date.now() - new Date(data.lastHitAt).getTime()) / 86400000;
    if (daysSince > 30) score -= Math.min(0.15, (daysSince - 30) / 365 * 0.15);
  }
  const ignoreCount = data.ignoreCount || 0;
  if (ignoreCount > 0) score -= Math.min(0.30, ignoreCount * 0.05);
  const irrelevantCount = data.irrelevantCount || 0;
  if (irrelevantCount > 0) {
    const reasonPenalty = (data.noiseReasonCounts?.stale_rule || 0) > 0 ? 0.10 : 0.05;
    score -= Math.min(0.30, irrelevantCount * reasonPenalty);
  }
  const unusedCount = data.unusedCount || 0;
  if (unusedCount > 0) score -= Math.min(0.15, unusedCount * 0.03);
  if (queryProjectSlug && data._projectSlug && queryProjectSlug !== data._projectSlug) score -= 0.30;
  if (data.superseded) score *= 0.5;
  return Math.max(score, 0);
}

// ============================================================
//  Rerank by quality
// ============================================================

function rerankByQuality(points, queryDomain, queryProjectSlug, queryText) {
  if (!Array.isArray(points)) return [];
  return points.map(p => {
    let data = {};
    try { data = JSON.parse(p.payload?.json || '{}'); } catch {}
    const effectiveScore = computeEffectiveScore(p, data, queryDomain, queryProjectSlug, queryText);
    return { ...p, _effectiveScore: effectiveScore };
  }).sort((a, b) => (b._effectiveScore || 0) - (a._effectiveScore || 0));
}

// ============================================================
//  Format suggestions
// ============================================================

function formatPoints(points) {
  if (!Array.isArray(points)) return [];
  const lines = [];
  for (const point of points) {
    try {
      const data = JSON.parse(point.payload?.json || '{}');
      const solution = data.solution || data.principle || '';
      if (!solution) continue;
      const effectiveConf = computeEffectiveConfidence(data);
      if (effectiveConf < 0.42 && !point._probationaryT2) continue;
      const confidence = data.confidence || 0.5;
      const shortId = String(point.id || '').slice(0, 8);
      const collection = point._collection || 'unknown';
      let label;
      if (point._probationaryT2) {
        label = `Probationary Suggestion (score: ${(point._effectiveScore || point.score || 0).toFixed(2)})`;
      } else if (confidence >= 0.60) {
        label = `Experience - High Confidence (${confidence.toFixed(2)})`;
      } else if (effectiveConf >= 0.42) {
        label = `Experience (${confidence.toFixed(2)})`;
      } else { continue; }
      let line = `⚠️ [${label}]: ${solution}`;
      if (data.why) line += `\n   Why: ${data.why}`;
      if (data.principle) line += `\n   Principle: ${data.principle}`;
      line += `\n   [id:${shortId} col:${collection}]`;
      lines.push(line);
    } catch { /* skip malformed */ }
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
  extractProjectPath, extractProjectSlug,
  buildQuery, QUERY_MAX_CHARS,
  computeEffectiveConfidence, computeEffectiveScore,
  rerankByQuality,
  formatPoints,
  dedupePointsBySource, pointSourceKey, applyBudget,
  inferLanguageMismatch,
  hasRecentValidatedConfirmation, isCodeSpecificHint,
  shouldSuppressForNoise, filterNoiseSuppressedPoints,
  normalizeSourceMeta, resolveRuntimeFromSourceMeta, detectRuntime,
};
