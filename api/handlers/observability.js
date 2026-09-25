'use strict';

const path = require('node:path');
const logger = require('../../.experience/src/logger');
const os = require('node:os');
const { computeStats, filterEvents, loadEvents, loadTop5, parseSince } = require('../../tools/exp-stats');
const { checkGates } = require('../../tools/exp-gates');
const { QDRANT_BASE, RUNTIME_DIR, deriveCallerMeta, loadExperienceCore, qdrantHeaders } = require('../config');
const { error, json, readBody, slog } = require('../http');
const experimentLog = require('../../.experience/src/experiment');

// ── /api/projects — the slug directory ────────────────────────────────────────
//
// Every ee_query/ee_write caller has to put something in `project`, and without
// this it can only guess. Guessing is not harmless: the slug space is polluted
// with canonicalization debris from bad cwds (`.gemini`, `e:/tiennv`, `c:/users`,
// `tmp`, `any` all exist alongside `muonroi-cli` and `experience-engine`), so the
// slug an agent would invent and the slug that matches stored entries are
// routinely different strings — and a miss silently drops exactly the
// project-scoped entries the caller wanted, looking identical to an empty brain.
//
// Aggregates the FLAT top-level `scope_project_slug`. The nested
// experience.scope.project_slug is inside the opaque `json` payload string and is
// not filterable, so advertising it would hand agents values the filter can never
// match.
const PROJECT_SLUG_COLLECTIONS = ['experience-behavioral', 'experience-principles', 'experience-selfqa'];
const PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000;
const PROJECTS_SCROLL_LIMIT = 5000;
let _projectsCache = null;

function _resetProjectsCache() {
  _projectsCache = null;
}

/**
 * @param {{scroll?: Function, limit?: number, collections?: string[]}} [opts]
 */
async function collectProjectSlugs({ scroll, limit = PROJECTS_SCROLL_LIMIT, collections = PROJECT_SLUG_COLLECTIONS } = {}) {
  const scrollFn = scroll || require(path.join(RUNTIME_DIR, 'src', 'qdrant.js')).scrollCollection;
  const counts = new Map();
  const perCollection = {};
  const failed = [];
  let unscoped = 0;
  let total = 0;
  let truncated = false;

  for (const coll of collections) {
    let points;
    try {
      points = await scrollFn(coll, null, limit);
    } catch (err) {
      // Partial beats nothing — but the caller must be told the answer is partial
      // rather than reading a short list as "these are all the projects".
      failed.push(coll);
      slog('warn', 'projects_scroll_failed', { collection: coll, error: logger.serializeError(err) });
      continue;
    }
    points = Array.isArray(points) ? points : [];
    if (points.length >= limit) truncated = true;
    perCollection[coll] = points.length;
    total += points.length;

    for (const p of points) {
      const raw = p?.payload?.scope_project_slug;
      const slug = typeof raw === 'string' ? raw.trim() : '';
      if (!slug) { unscoped++; continue; }
      const entry = counts.get(slug) || { slug, count: 0, collections: {} };
      entry.count++;
      entry.collections[coll] = (entry.collections[coll] || 0) + 1;
      counts.set(slug, entry);
    }
  }

  const projects = [...counts.values()].sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  return { projects, unscoped, total, collections: perCollection, failed, truncated };
}

async function handleProjects(req, res) {
  const now = Date.now();
  if (_projectsCache && now - _projectsCache.ts < PROJECTS_CACHE_TTL_MS) {
    return json(res, { ..._projectsCache.data, cached: true });
  }
  try {
    const data = await collectProjectSlugs();
    _projectsCache = { ts: now, data };
    return json(res, { ...data, cached: false });
  } catch (err) {
    slog('error', 'projects_failed', { error: logger.serializeError(err) });
    return error(res, `project directory unavailable: ${err?.message || String(err)}`, 503);
  }
}

// Hint quality stats — aggregates Qdrant points to surface noise patterns
// (cross-language seeds, high-ignore points, unscoped legacy seeds). Used by
// the `exp-hint-stats` CLI tool and by manual triage during noise reviews.
async function handleHintStats(req, res, url) {
  const minIgnoreCount = Number(url.searchParams.get('minIgnoreCount') || 2);
  const noiseRatio = Number(url.searchParams.get('noiseRatio') || 0.4);
  const topN = Math.min(Number(url.searchParams.get('topN') || 20), 100);
  const cols = (url.searchParams.get('collections') || 'experience-behavioral,experience-principles,experience-selfqa').split(',');

  const stats = {};

  for (const col of cols) {
    let offset = null;
    let total = 0;
    const byLang = { 'c#': 0, typescript: 0, javascript: 0, unscoped: 0, other: 0 };
    const byFramework = {};
    const noisy = [];
    const unscopedHigh = [];

    while (true) {
      const r = await fetch(`${QDRANT_BASE}/collections/${col}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ limit: 200, offset, with_payload: true }),
      }).catch(() => null);
      if (!r || !r.ok) break;
      const j = await r.json();
      const pts = j.result?.points || [];
      for (const p of pts) {
        total++;
        let exp = {};
        try { exp = JSON.parse(p.payload?.json || '{}'); } catch {}
        const lang = exp.scope?.lang ? String(exp.scope.lang).toLowerCase() : null;
        const fw = exp.scope?.framework ? String(exp.scope.framework).toLowerCase() : null;
        if (!lang) byLang.unscoped++;
        else if (/c#|csharp|dotnet/.test(lang)) byLang['c#']++;
        else if (/typescript/.test(lang)) byLang.typescript++;
        else if (/javascript/.test(lang)) byLang.javascript++;
        else byLang.other++;
        if (fw) byFramework[fw] = (byFramework[fw] || 0) + 1;
        const hits = Number(exp.hitCount || 0);
        const ignores = Number(exp.ignoreCount || 0);
        const totalFires = hits + ignores;
        if (ignores >= minIgnoreCount && totalFires > 0 && ignores / totalFires >= noiseRatio) {
          noisy.push({
            id: String(p.id || '').slice(0, 8),
            fullId: String(p.id || ''),
            hits, ignores,
            ignoreRatio: Number((ignores / totalFires).toFixed(2)),
            lang, framework: fw, org: exp.scope?.org || null,
            solution: String(exp.solution || '').slice(0, 100),
          });
        }
        if (!lang && (hits + ignores) >= 3) {
          unscopedHigh.push({
            id: String(p.id || '').slice(0, 8),
            fullId: String(p.id || ''),
            hits, ignores,
            solution: String(exp.solution || '').slice(0, 100),
          });
        }
      }
      offset = j.result?.next_page_offset;
      if (!offset) break;
    }
    noisy.sort((a, b) => b.ignores - a.ignores);
    unscopedHigh.sort((a, b) => (b.hits + b.ignores) - (a.hits + a.ignores));
    stats[col] = {
      total,
      byLang,
      byFramework,
      noisyCount: noisy.length,
      unscopedHighCount: unscopedHigh.length,
      noisy: noisy.slice(0, topN),
      unscopedHigh: unscopedHigh.slice(0, topN),
    };
  }

  json(res, { generatedAt: new Date().toISOString(), thresholds: { minIgnoreCount, noiseRatio }, stats });
}

async function handleStats(req, res, url) {
  const logDir = path.join(os.homedir(), '.experience');
  const storeDir = path.join(logDir, 'store');

  const sinceParam = url.searchParams.get('since');
  const allTime = url.searchParams.get('all') === 'true';

  let cutoff = null;
  if (!allTime) {
    cutoff = parseSince(sinceParam || '7d') || parseSince('7d');
  }

  const allEvents = loadEvents(logDir);
  const events = filterEvents(allEvents, cutoff);
  const stats = computeStats(events);
  const top5 = loadTop5(storeDir);

  // Phase 1: build bySlug bucket from events that carry project_slug or project.
  const bySlug = {};
  for (const ev of events) {
    const slug = (typeof ev.project_slug === 'string' && ev.project_slug)
      ? ev.project_slug
      : (typeof ev.project === 'string' && ev.project ? ev.project : null);
    if (slug) bySlug[slug] = (bySlug[slug] || 0) + 1;
  }

  json(res, { since: allTime ? 'all' : (sinceParam || '7d'), ...stats, top5, bySlug });
}

async function handleGates(req, res) {
  const results = await checkGates({ homeDir: os.homedir() });
  json(res, results);
}

async function handleGraph(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id) return error(res, 'id query parameter is required');

  const { getEdgesForId } = loadExperienceCore();
  const edges = getEdgesForId(id);
  const enriched = edges.map(edge => {
    const targetId = edge.source === id ? edge.target : edge.source;
    const direction = edge.source === id ? 'outgoing' : 'incoming';
    return { type: edge.type, target: targetId, weight: edge.weight, direction, createdAt: edge.createdAt };
  });

  json(res, { id, edges: enriched, count: enriched.length });
}

// /api/project-brief — breadth-first SessionStart digest for a project.
// GET  /api/project-brief?project=<slug>[&cwd=<path>][&limit=N]  (read token OK)
// POST /api/project-brief  { project, cwd, limit }              (full token; hook path)
// One handler, both methods: the SessionStart hook posts via remote-client's
// postJsonForHook (POST only); dashboards/curl use GET with the read token.
async function handleProjectBrief(req, res, url) {
  let project = null;
  let cwd = null;
  let limit;
  let sessionId = null;
  let runtime = null;
  if (req.method === 'POST') {
    const body = await readBody(req);
    project = typeof body?.project === 'string' ? body.project : null;
    cwd = typeof body?.cwd === 'string' ? body.cwd : null;
    if (Number.isFinite(body?.limit)) limit = body.limit;
    sessionId = typeof body?.sourceSession === 'string' ? body.sourceSession : null;
    runtime = typeof body?.sourceRuntime === 'string' ? body.sourceRuntime : null;
  } else {
    project = url.searchParams.get('project');
    cwd = url.searchParams.get('cwd');
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit != null && Number.isFinite(Number(rawLimit))) limit = Number(rawLimit);
  }
  // Fall back to deriving the project slug from cwd (same path the intercept
  // uses) so a hook that only knows the working directory still gets a brief.
  if (!project) project = deriveCallerMeta({ project_slug: null, cwd }).project_slug;
  if (!project) return json(res, { text: null, entries: [], projectSlug: null, count: 0 });

  // Holdout (spec §3 A3): the SessionStart brief is passive engine output, so a
  // control session gets none. Only the hook's POST carries a session id; the
  // dashboard GET is never in the experiment. null unless an experiment is active.
  const holdout = experimentLog.noteHoldoutFor(sessionId, runtime);
  if (holdout && holdout.arm === 'control') {
    return json(res, { text: null, entries: [], projectSlug: project, count: 0, cached: false, experiment: { arm: 'control' } });
  }

  const { buildProjectBrief } = loadExperienceCore();
  const brief = await buildProjectBrief(project, { limit });
  return json(res, holdout ? { ...brief, experiment: { arm: holdout.arm } } : brief);
}

function handleUser(req, res) {
  const { EXP_USER } = loadExperienceCore();
  json(res, { user: EXP_USER });
}

async function handleTimeline(req, res, url) {
  const topic = url.searchParams.get('topic');
  if (!topic) return error(res, 'topic query parameter is required');

  const { getEmbeddingRaw, searchCollection, getEdgesOfType } = loadExperienceCore();
  // Semantic search for experiences matching the topic
  const vector = await getEmbeddingRaw(topic);
  if (!vector) return error(res, 'Embedding unavailable', 503);

  // Search across all experience collections using the canonical searchCollection helper
  const collections = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
  const allResults = [];
  for (const coll of collections) {
    try {
      const hits = await searchCollection(coll, vector, 20);
      for (const hit of hits) {
        if ((hit.score || 0) < 0.5) continue;
        const data = (() => { try { return JSON.parse(hit.payload?.json || '{}'); } catch { return {}; } })();
        allResults.push({ id: hit.id, collection: coll, score: hit.score, ...data });
      }
    } catch { /* skip collection */ }
  }

  // Sort by most recent confirmation (confirmedAt last entry, fallback to createdAt)
  allResults.sort((a, b) => {
    const aTime = (Array.isArray(a.confirmedAt) && a.confirmedAt.length > 0) ? new Date(a.confirmedAt[a.confirmedAt.length - 1]).getTime() : new Date(a.createdAt || 0).getTime();
    const bTime = (Array.isArray(b.confirmedAt) && b.confirmedAt.length > 0) ? new Date(b.confirmedAt[b.confirmedAt.length - 1]).getTime() : new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  // Filter out superseded experiences
  const supersedes = getEdgesOfType('supersedes');
  const supersededIds = new Set(supersedes.map(e => e.target));

  const timeline = allResults.slice(0, 20).map(r => ({
    id: r.id,
    trigger: r.trigger,
    solution: r.solution,
    tier: r.tier,
    confirmedAt: r.confirmedAt || [],
    createdAt: r.createdAt,
    superseded: supersededIds.has(r.id),
    score: parseFloat(r.score.toFixed(3)),
  }));

  json(res, { topic, timeline, count: timeline.length });
}

module.exports = {
  PROJECT_SLUG_COLLECTIONS,
  PROJECTS_CACHE_TTL_MS,
  PROJECTS_SCROLL_LIMIT,
  _projectsCache,
  _resetProjectsCache,
  collectProjectSlugs,
  handleProjects,
  handleHintStats,
  handleStats,
  handleGates,
  handleGraph,
  handleProjectBrief,
  handleUser,
  handleTimeline,
};
