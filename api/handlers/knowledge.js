'use strict';

const { validateBody } = require('../../.experience/src/validate');
const runtimeConfig = require('../../.experience/src/config');
const { activityLog, buildRecallEvent } = require('../../.experience/src/activity');
const { QDRANT_BASE, VALID_FEEDBACK_VERDICTS, VALID_NOISE_REASONS, _cfg, deriveCallerMeta, loadExperienceCore, qdrantHeaders } = require('../config');
const { error, json, readBody, slog } = require('../http');
const { requireAuth } = require('../auth');

async function resolvePointIdPrefix(collection, pointId) {
  let offset = null;

  for (;;) {
    const body = { limit: 100, with_payload: false };
    if (offset !== null) body.offset = offset;

    const scrollRes = await fetch(`${QDRANT_BASE}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!scrollRes.ok) return { ok: false, reason: 'unavailable' };

    const result = (await scrollRes.json()).result || {};
    const points = Array.isArray(result.points) ? result.points : [];
    const match = points.find(point => String(point.id).startsWith(pointId));
    if (match) return { ok: true, id: match.id };

    if (!('next_page_offset' in result) || result.next_page_offset == null || points.length === 0) {
      return { ok: true, id: null };
    }
    offset = result.next_page_offset;
  }
}

async function handleShare(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { principleId: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const { sharePrinciple } = loadExperienceCore();
  const shared = sharePrinciple(body.principleId);
  if (!shared) return error(res, 'Principle not found', 404);
  json(res, { shared, success: true });
}

async function handleImport(req, res) {
  const body = await readBody(req);
  if (!body.principle && !body.solution) return error(res, 'principle or solution is required');
  const { importPrinciple } = loadExperienceCore();
  const result = await importPrinciple(body);
  if (!result) return error(res, 'Import failed (embedding unavailable)', 503);
  json(res, { imported: result, success: true });
}

async function handleFeedback(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    pointId: { type: 'string', required: true },
    collection: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim().toUpperCase() : null;
  const followed = typeof body.followed === 'boolean' ? body.followed : null;
  if (!verdict && followed === null) return error(res, 'verdict is required (or legacy followed boolean)');
  if (verdict && !VALID_FEEDBACK_VERDICTS.has(verdict)) {
    return error(res, `verdict must be one of: ${[...VALID_FEEDBACK_VERDICTS].join(', ')}`);
  }
  const normalizedReason = body.reason == null ? null : String(body.reason).trim().toLowerCase();
  if (normalizedReason && !VALID_NOISE_REASONS.has(normalizedReason)) {
    return error(res, `reason must be one of: ${[...VALID_NOISE_REASONS].join(', ')}`);
  }
  const resolvedVerdict = verdict || (followed ? 'FOLLOWED' : 'IGNORED');
  if (resolvedVerdict === 'IRRELEVANT' && !normalizedReason) {
    return error(res, 'reason is required when verdict is IRRELEVANT');
  }

  let pointId = body.pointId;
  // Support short ID prefix (8 chars) — resolve to full UUID via Qdrant scroll
  if (pointId.length < 36) {
    try {
      const resolved = await resolvePointIdPrefix(body.collection, pointId);
      if (!resolved.ok) {
        return error(res, 'Failed to resolve short ID — Qdrant unavailable', 503);
      }
      if (!resolved.id) {
        return error(res, `No point found matching prefix "${pointId}" in ${body.collection}`, 404);
      }
      pointId = resolved.id;
    } catch {
      return error(res, 'Failed to resolve short ID — provide full UUID', 400);
    }
  }
  const { recordFeedback } = loadExperienceCore();
  // Capture caller context (lang/framework/project_slug) so future evolve
  // cycles can do scope narrowing instead of full supersede — e.g. entry
  // marked wrong_language 3 times all from TypeScript queries → exclude
  // TypeScript instead of killing the entry (it may still be valid in C#).
  const callerCtx = deriveCallerMeta(body);
  // sourceSession (optional): one betaEvidence outcome per (session, point).
  const sessionId = typeof body.sourceSession === 'string' && body.sourceSession ? body.sourceSession : null;
  await recordFeedback(body.collection, pointId, resolvedVerdict, normalizedReason, { callerContext: callerCtx, ...(sessionId ? { sessionId } : {}) });
  json(res, { ok: true, resolvedId: pointId, verdict: resolvedVerdict, ...(normalizedReason ? { reason: normalizedReason } : {}) });
}

const KNOWN_COLLECTIONS = new Set([
  'experience-behavioral',
  'experience-selfqa',
  'experience-principles',
  // Phase 2: BB-specific collections
  'bb-behavioral',
  'bb-recipes',
  'bb-packages', // Plan 23: BB NuGet packages
  // Sprint-2 Part D: write-during-execution workflow collections. Written via
  // /api/workflow-event; intentionally KEPT OUT of the recall hot path (the
  // 3-collection unrolled search in experience-core.js) so adding them cannot
  // destabilize passive/active recall. Queried directly by the endpoint only.
  'workflow_debate',
  'workflow_sprint',
  'workflow_decision',
  'workflow_mistake',
]);

// Sprint-2 Part D: map a workflow event `kind` → its collection.
const WORKFLOW_KIND_TO_COLLECTION = {
  'council-debate': 'workflow_debate',
  debate: 'workflow_debate',
  'sprint-execution': 'workflow_sprint',
  sprint: 'workflow_sprint',
  decision: 'workflow_decision',
  mistake: 'workflow_mistake',
};

// ensureCollections — creates bb-* Qdrant collections at server startup if absent.
// Vector dims must match the configured embedding model.
async function ensureCollections() {
  // Sprint-2 Part D: create workflow_* alongside bb-* at startup (only when the
  // endpoint is enabled — no reason to provision otherwise).
  const workflowEnabled = process.env.ENABLE_WORKFLOW_EVENT === '1' || _cfg.enableWorkflowEvent === true;
  const WORKFLOW_COLLECTIONS = workflowEnabled
    ? ['workflow_debate', 'workflow_sprint', 'workflow_decision', 'workflow_mistake']
    : [];
  const BB_COLLECTIONS = ['bb-behavioral', 'bb-recipes', 'bb-packages', ...WORKFLOW_COLLECTIONS];
  const VECTOR_SIZE = Number(runtimeConfig.getEmbedDim()) || 768;
  for (const col of BB_COLLECTIONS) {
    try {
      const check = await fetch(`${QDRANT_BASE}/collections/${col}`, {
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(5000),
      });
      if (check.status === 200) {
        slog('info', 'collection_exists', { collection: col });
        continue;
      }
      const create = await fetch(`${QDRANT_BASE}/collections/${col}`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
        signal: AbortSignal.timeout(10000),
      });
      if (create.ok) {
        slog('info', 'collection_created', { collection: col });
      } else {
        const errBody = await create.text();
        slog('error', 'collection_create_failed', { collection: col, status: create.status, body: errBody });
      }
    } catch (err) {
      slog('error', 'collection_ensure_error', { collection: col, error: String(err) });
    }
  }

  // Hybrid recall: ensure a full-text index on the top-level `text_search`
  // payload field for the experience collections so the lexical leg's MatchText
  // queries work. Idempotent — Qdrant treats an existing index as success; any
  // failure is logged and non-fatal (lexical leg returns [] until the index
  // lands, so recall degrades cleanly to vector-only).
  for (const col of ['experience-principles', 'experience-behavioral', 'experience-selfqa', ...WORKFLOW_COLLECTIONS]) {
    try {
      const idx = await fetch(`${QDRANT_BASE}/collections/${col}/index`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          field_name: 'text_search',
          field_schema: { type: 'text', tokenizer: 'word', lowercase: true, min_token_len: 2, max_token_len: 30 },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (idx.ok) {
        slog('info', 'text_index_ensured', { collection: col });
      } else {
        const body = await idx.text();
        if (/exist/i.test(body)) slog('info', 'text_index_exists', { collection: col });
        else slog('warn', 'text_index_failed', { collection: col, status: idx.status, body: body.slice(0, 200) });
      }
    } catch (err) {
      slog('warn', 'text_index_error', { collection: col, error: String(err) });
    }
  }
}

// /api/recall — agent-initiated active recall of learned experience.
// Unlike /api/search (raw vector hits, no signal), recall runs the full
// intercept pipeline: scope-filtered retrieval, scored + formatted with
// [id col] feedback handles, and records a SURFACE event for each returned
// entry. Surfacing bumps surfaceCount only (NOT hitCount) — the agent then
// reports usefulness via /api/feedback (followed/ignored/noise), so actively
// pulled context reinforces precisely and filters noise faster than passive
// hints (the agent chose to ask, so its verdict is high-signal).
async function handleRecall(req, res) {
  // Defense-in-depth: the POST dispatch block already gates on requireAuth, but
  // mirror handleSearch/handlePilContext so the handler is safe even if routing
  // is later refactored (recall can record surface + reads scoped experience).
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return error(res, 'query is required');
  if (query.length > 10_000) return error(res, 'query exceeds 10KB');

  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'recall-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
    // Sprint-2 Part D: optional stance/role hint for per-stance recall. Recorded
    // on meta (non-breaking — ignored when absent). The recall search hot path
    // stays unrolled to the 3 experience-* collections; wiring stance into
    // collection weighting is a follow-up that requires looping that path.
    stance: typeof body.stance === 'string' ? body.stance : null,
    role: typeof body.role === 'string' ? body.role : null,
  };

  const { interceptWithMeta } = loadExperienceCore();
  // Active recall = semantic-search mode. Reuses the intercept pipeline (embed →
  // search → rank → format → recordSurface) but with recallMode:true, which:
  //   - ranks by RAW COSINE (not the penalty-weighted effective score),
  //   - drops the positive lang/framework/project scope gates, and
  //   - bypasses the min-search-score floor (format.js GATE 2).
  // The score floor is a noise-control signal for PASSIVE hints — a deliberate
  // query has no such ceiling. Integrity gates still apply: superseded,
  // permanent-noise (ignore≥20 & hit=0), irrelevant≥3, learned lang/project
  // exclusions, and the min-confidence quality floor. Surfaces are still
  // recorded so the agent's /api/feedback verdict grows + cleans the brain.
  // body.fast → fast recall: skip the model-routing side-effect and bound the
  // internal budget tighter (4s vs 8s) so a slow embed can't blow a latency-bound
  // caller's hook deadline (the prompt risk gate). It no longer distinguishes
  // itself by skipping the brainRelevanceFilter — recallMode skips that for every
  // recall now, fast or not; see experience-core.js for the measurements.
  const fast = !!body.fast;
  const result = await interceptWithMeta(
    'UserPrompt',
    { command: query, _promptHook: true },
    AbortSignal.timeout(fast ? 4000 : 8000),
    meta,
    { recallMode: true, fast }
  );
  const entries = (result?.surfacedIds || []).map(s => ({ id: String(s.id || ''), collection: s.collection || null }));
  // P1: record the recall on activity.jsonl so the engine can later detect a
  // session that stitched ≥N recalls (runbook-candidate signal). activityLog
  // never throws (it self-guards), so this cannot break the response path.
  activityLog(buildRecallEvent(query, meta, entries));
  return json(res, { text: result?.suggestions || null, entries, count: entries.length, query });
}

// /api/import-memory — thin-client bridge for the curated-memory importer.
// Curated memory files live on the CLIENT (e.g. ~/.claude/projects/<slug>/memory),
// and project-slug derivation needs the client's real project dirs — so the client
// scans + maps locally and POSTs pre-mapped experiences here. The server (where
// Qdrant + embeddings live) embeds and stores them seed-like via
// storeImportedExperience (stable-id upsert, earned-counter preserving).
async function handleImportMemory(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  const experiences = Array.isArray(body.experiences) ? body.experiences : null;
  if (!experiences) return error(res, 'experiences[] is required');
  if (experiences.length > 500) return error(res, 'too many experiences (max 500 per call)');
  const { storeImportedExperience } = require('../../.experience/src/evolution');
  const stats = { count: experiences.length, stored: 0, upserted: 0, failed: 0 };
  const results = [];
  for (const e of experiences) {
    if (!e || typeof e.id !== 'string' || !KNOWN_COLLECTIONS.has(e.collection) || !e.qa || typeof e.qa !== 'object') {
      stats.failed++; results.push({ id: e?.id || null, ok: false, reason: 'invalid' }); continue;
    }
    try {
      const r = await storeImportedExperience(e.qa, {
        id: e.id, collection: e.collection,
        tier: Number(e.tier) || 2, confidence: Number(e.confidence) || 0.6,
        runtime: typeof e.runtime === 'string' ? e.runtime : 'claude',
      });
      if (r.stored) { stats.stored++; if (r.upserted) stats.upserted++; results.push({ id: e.id, ok: true, upserted: !!r.upserted }); }
      else { stats.failed++; results.push({ id: e.id, ok: false, reason: r.reason || 'not_stored' }); }
    } catch (err) {
      stats.failed++;
      results.push({ id: e.id, ok: false, reason: String(err?.message || err) });
      slog('error', 'import_memory_store_error', { id: String(e.id).slice(0, 8), error: String(err?.message || err) });
    }
  }
  stats.new = stats.stored - stats.upserted;
  return json(res, { ...stats, results });
}

async function handleSearch(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.query || typeof body.query !== 'string') return error(res, 'query is required');
  const limit = Math.min(body.limit || 5, 20);

  // Accept optional `collections: string[]` for thin-client multi-collection queries.
  // Backwards-compat: omitted → ['experience-behavioral'].
  let collections;
  if (Array.isArray(body.collections) && body.collections.length > 0) {
    collections = body.collections.filter((c) => typeof c === 'string' && KNOWN_COLLECTIONS.has(c));
    if (collections.length === 0) return error(res, `collections must be a subset of: ${[...KNOWN_COLLECTIONS].join(', ')}`);
  } else {
    collections = ['experience-behavioral'];
  }

  const { getEmbeddingRaw, searchCollection, searchCollectionHybrid } = loadExperienceCore();
  const vector = await getEmbeddingRaw(body.query, AbortSignal.timeout(2000));
  if (!vector) return error(res, 'Embedding unavailable', 503);

  // Hybrid (dense cosine + native BM25 sparse, RRF-fused) by default — /api/search
  // is a deliberate query, so it fuses a lexical leg like /api/recall to surface
  // lexically-distinct lessons the dense leg buries. EXPERIENCE_SEARCH_HYBRID=false
  // reverts to dense-only; hybrid also auto-degrades to dense when the lexical leg
  // is unavailable (collection not sparse-migrated). See config.getSearchHybrid.
  const useHybrid = runtimeConfig.getSearchHybrid() && typeof searchCollectionHybrid === 'function';
  const searchSignal = AbortSignal.timeout(2500);
  const results = await Promise.all(collections.map((c) =>
    useHybrid
      ? searchCollectionHybrid(c, body.query, vector, limit, searchSignal)
      : searchCollection(c, vector, limit)
  ));
  const mapped = [];
  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    for (const p of results[i] || []) {
      const payload = p.payload || {};
      const json = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
      mapped.push({ id: p.id, score: p.score, text: payload.text || json.solution || '', collection });
    }
  }

  json(res, { points: mapped });
}

module.exports = {
  resolvePointIdPrefix,
  handleShare,
  handleImport,
  handleFeedback,
  KNOWN_COLLECTIONS,
  WORKFLOW_KIND_TO_COLLECTION,
  ensureCollections,
  handleRecall,
  handleImportMemory,
  handleSearch,
};
