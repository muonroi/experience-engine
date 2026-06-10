/**
 * brief.js — "Project Brief": breadth-first, always-on memory digest.
 *
 * Companion to the similarity-gated retrieval path (intercept). The brief is
 * injected once at SessionStart so the agent gets a map of WHAT THE ENGINE
 * KNOWS about a project up-front — project-state facts that would never embed
 * close enough to the current prompt to clear the intercept score gate.
 *
 * No query, no vector: entries are enumerated by project membership (Qdrant
 * payload filter on the flat `scope_project_slug` written by evolution.js,
 * plus universal `scope_lang=all` rules) and ranked by stored confidence ×
 * hit-count × recency (scoring.computeBriefScore). Lazy detail: each line
 * carries `[id:xxxx col:name]` so the agent can fetch the full entry on demand.
 *
 * Zero npm dependencies. Node 20 CommonJS.
 */
'use strict';

const { COLLECTIONS } = require('./config');
const { scrollCollection } = require('./qdrant');
const { computeBriefScore } = require('./scoring');
const { buildPrincipleText } = require('./format');
const { log } = require('./logger');

const BRIEF_TTL_MS = Number(process.env.EXPERIENCE_BRIEF_TTL_MS || 0) > 0
  ? Number(process.env.EXPERIENCE_BRIEF_TTL_MS)
  : 600000; // 10 min — brief changes slowly; avoid re-scroll on every session
const SCROLL_LIMIT = 256; // per-collection ceiling for the enumeration
const GIST_MAX = 120;

// Server-side cache keyed by normalized project slug.
const _cache = new Map();

function normSlug(slug) {
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

function parsePayload(point) {
  try {
    return JSON.parse(point?.payload?.json || '{}');
  } catch (err) {
    log('debug', 'brief_payload_parse_failed', {
      pointId: String(point?.id || '').slice(0, 8),
      error: err?.message || String(err),
    });
    return null;
  }
}

function entrySlug(data) {
  const raw = data?.scope?.project_slug || data?.scope?.projectSlug || data?._projectSlug;
  return normSlug(raw);
}

// Mirrors scoring.js:98 — universal behavioral rules (scope.lang='all') belong
// in every project's brief; otherwise the entry must match this project.
function belongsToProject(data, slug) {
  if (!data) return false;
  if (String(data?.scope?.lang || '').toLowerCase() === 'all') return true;
  return entrySlug(data) === slug;
}

// Surfacing hygiene — keep the brief honest. Drop entries the intercept path
// would also refuse to surface (superseded / proven-noise / repeatedly-flagged).
function isSurfaceable(data) {
  if (!data || data.superseded === true) return false;
  if (!buildPrincipleText(data)) return false;
  if ((data.ignoreCount || 0) >= 20 && (data.hitCount || 0) === 0) return false;
  if ((data.irrelevantCount || 0) >= 3) return false;
  return true;
}

function oneLineGist(data) {
  return String(buildPrincipleText(data) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GIST_MAX);
}

function qdrantMembershipFilter(slug) {
  // Pre-filter at the index level when Qdrant is healthy. FileStore fallback
  // ignores this (no payload index) and relies on belongsToProject() below.
  return {
    must: [
      {
        should: [
          { key: 'scope_project_slug', match: { value: slug } },
          { key: 'scope_lang', match: { value: 'all' } },
        ],
      },
    ],
  };
}

/**
 * buildProjectBrief(projectSlug, opts)
 * @param {string} projectSlug
 * @param {{ signal?: AbortSignal, limit?: number, fresh?: boolean }} [opts]
 * @returns {Promise<{ text: string|null, entries: Array, projectSlug: string, count: number, cached: boolean }>}
 */
async function buildProjectBrief(projectSlug, opts = {}) {
  const slug = normSlug(projectSlug);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 12;
  const empty = { text: null, entries: [], projectSlug: slug, count: 0, cached: false };
  if (!slug) return empty;

  if (!opts.fresh) {
    const hit = _cache.get(slug);
    if (hit && (Date.now() - hit.ts) < BRIEF_TTL_MS) {
      return { ...hit.result, cached: true };
    }
  }

  const filter = qdrantMembershipFilter(slug);
  const candidates = [];
  for (const col of COLLECTIONS) {
    let points;
    try {
      points = await scrollCollection(col.name, filter, SCROLL_LIMIT, opts.signal);
    } catch (err) {
      log('error', 'brief_scroll_failed', { collection: col.name, projectSlug: slug, error: err?.message || String(err) });
      continue;
    }
    for (const point of points || []) {
      const data = parsePayload(point);
      if (!belongsToProject(data, slug) || !isSurfaceable(data)) continue;
      candidates.push({ point, data, collection: col.name, score: computeBriefScore(data) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit);

  if (top.length === 0) {
    const result = { ...empty };
    _cache.set(slug, { ts: Date.now(), result });
    return result;
  }

  const lines = top.map(c => {
    const id8 = String(c.point.id).slice(0, 8);
    return `- ${oneLineGist(c.data)} [id:${id8} col:${c.collection}]`;
  });
  const header = `[Project Brief] ${slug} — top ${lines.length} learned facts ranked by confidence×hits×recency. Fetch full detail by id (node ~/.experience/exp-feedback.js / GET /api/graph?id=).`;
  const text = `${header}\n${lines.join('\n')}`;
  const entries = top.map(c => ({ id: String(c.point.id), collection: c.collection, score: Number(c.score.toFixed(4)) }));

  const result = { text, entries, projectSlug: slug, count: entries.length, cached: false };
  _cache.set(slug, { ts: Date.now(), result });
  return result;
}

function _clearBriefCache() {
  _cache.clear();
}

module.exports = { buildProjectBrief, _clearBriefCache, BRIEF_TTL_MS };
