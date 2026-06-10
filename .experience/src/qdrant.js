/**
 * qdrant.js — Qdrant I/O + FileStore fallback for Experience Engine.
 * Extracted from experience-core.js. Zero npm dependencies.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');

const {
  getQdrantBase, getQdrantApiKey,
  getStoreDir, getExpUser, COLLECTIONS,
} = require('./config');
const { log } = require('./logger');
const { buildSparseVector, SPARSE_VECTOR_NAME } = require('./sparse');

// ============================================================
//  Qdrant connection state
// ============================================================

let qdrantAvailable = null; // null = unchecked, true/false = checked
let qdrantCheckedAt = 0;
const QDRANT_OK_CACHE_MS = 30_000;
const QDRANT_FAIL_CACHE_MS = 5_000;

async function checkQdrant() {
  const now = Date.now();
  const ttl = qdrantAvailable ? QDRANT_OK_CACHE_MS : QDRANT_FAIL_CACHE_MS;
  if (qdrantAvailable !== null && now - qdrantCheckedAt < ttl) return qdrantAvailable;
  try {
    const apiKey = getQdrantApiKey();
    const res = await fetch(`${getQdrantBase()}/collections`, {
      headers: apiKey ? { 'api-key': apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrantAvailable = res.ok;
  } catch { qdrantAvailable = false; }
  qdrantCheckedAt = now;
  return qdrantAvailable;
}

function resetQdrantCheck() {
  qdrantAvailable = null;
  qdrantCheckedAt = 0;
}

function setQdrantAvailable(value) {
  qdrantAvailable = !!value;
  qdrantCheckedAt = Date.now();
}

// ============================================================
//  FileStore
// ============================================================

function fileStorePath(collection) {
  return pathMod.join(getStoreDir(), `${collection}.json`);
}

function fileStoreRead(collection) {
  try {
    return JSON.parse(fs.readFileSync(fileStorePath(collection), 'utf8'));
  } catch { return []; }
}

// File-level locking
const LOCK_STALE_MS = 5000;

function acquireLock(collection) {
  const lockPath = fileStorePath(collection) + '.lock';
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
          const start = Date.now();
          while (Date.now() - start < 1) {}
          continue;
        } catch { continue; }
      }
      return false;
    }
  }
  return false;
}

function releaseLock(collection) {
  try { fs.unlinkSync(fileStorePath(collection) + '.lock'); } catch {}
}

function withFileStoreLock(collection, fn) {
  const dir = getStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  const locked = acquireLock(collection);
  if (!locked) throw new Error(`Failed to acquire FileStore lock for ${collection}`);
  try {
    return fn();
  } finally {
    releaseLock(collection);
  }
}

function fileStoreWriteUnlocked(collection, entries) {
  const tmp = fileStorePath(collection) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, fileStorePath(collection));
}

function fileStoreWrite(collection, entries) {
  return withFileStoreLock(collection, () => fileStoreWriteUnlocked(collection, entries));
}

function fileStoreUpsert(collection, id, vector, payload) {
  return withFileStoreLock(collection, () => {
    const entries = fileStoreRead(collection);
    const idx = entries.findIndex(e => e.id === id);
    const entry = { id, vector, payload };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    fileStoreWriteUnlocked(collection, entries);
  });
}

function fileStoreUpdate(collection, updateFn) {
  return withFileStoreLock(collection, () => {
    const entries = fileStoreRead(collection);
    const result = updateFn(entries);
    fileStoreWriteUnlocked(collection, entries);
    return result;
  });
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function fileStoreSearch(collection, vector, topK) {
  const entries = fileStoreRead(collection);
  const scored = entries
    .filter(e => e.vector && e.vector.length === vector.length)
    .map(e => ({ ...e, score: cosineSimilarity(vector, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map(e => ({ id: e.id, score: e.score, payload: e.payload }));
}

// ============================================================
//  Qdrant API
// ============================================================

function buildQdrantUserFilter() {
  return {
    should: [
      { key: 'user', match: { value: getExpUser() } },
      { is_empty: { key: 'user' } },
    ],
  };
}

function qdrantHeaders(extra = {}) {
  const apiKey = getQdrantApiKey();
  return { ...extra, ...(apiKey ? { 'api-key': apiKey } : {}) };
}

async function fetchPointById(collection, pointId) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const found = entries.find(e => e.id === pointId);
    return found ? { id: found.id, score: 1.0, payload: found.payload } : null;
  }
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/${pointId}`, {
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? { id: data.result.id, score: 1.0, payload: data.result.payload } : null;
  } catch { return null; }
}

/**
 * searchCollection: Qdrant query-time top-K with optional caller filter.
 * extraFilter is a partial Qdrant Filter (must / must_not / should arrays) that
 * gets merged into the user-isolation filter. Pre-filtering at the index level
 * is REQUIRED for correctness when post-retrieval gates would otherwise drain
 * top-K (e.g. foreign repo + org-doc-dominated brain → 0 surfaces).
 */
async function searchCollection(name, vector, topK, signal, extraFilter) {
  if (!(await checkQdrant())) return fileStoreSearch(name, vector, topK);
  try {
    const filter = { must: [buildQdrantUserFilter()] };
    if (extraFilter && typeof extraFilter === 'object') {
      if (Array.isArray(extraFilter.must)) filter.must.push(...extraFilter.must);
      if (Array.isArray(extraFilter.must_not)) filter.must_not = [...(filter.must_not || []), ...extraFilter.must_not];
      if (Array.isArray(extraFilter.should)) filter.should = [...(filter.should || []), ...extraFilter.should];
    }
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/query`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query: vector, limit: topK, with_payload: true, filter }),
      signal,
    });
    if (!res.ok) return fileStoreSearch(name, vector, topK);
    return (await res.json()).result?.points ?? [];
  } catch { return fileStoreSearch(name, vector, topK); }
}

/**
 * scrollCollection: payload-filtered enumeration with NO vector query. Used by
 * the Project Brief (breadth-first), where ranking is by stored confidence /
 * hit-count / recency rather than similarity to a query. `extraFilter` is a
 * partial Qdrant Filter (must / must_not / should arrays) merged into the
 * user-isolation filter, identical to searchCollection's contract. Returns an
 * array of points `{ id, payload }`. FileStore fallback enumerates the whole
 * collection (no server-side filter), leaving payload filtering to the caller.
 */
async function scrollCollection(name, extraFilter, limit = 100, signal) {
  if (!(await checkQdrant())) {
    // FileStore has no payload index — return all points; brief.js filters in-process.
    return fileStoreRead(name).map(e => ({ id: e.id, payload: e.payload }));
  }
  try {
    const filter = { must: [buildQdrantUserFilter()] };
    if (extraFilter && typeof extraFilter === 'object') {
      if (Array.isArray(extraFilter.must)) filter.must.push(...extraFilter.must);
      if (Array.isArray(extraFilter.must_not)) filter.must_not = [...(filter.must_not || []), ...extraFilter.must_not];
      if (Array.isArray(extraFilter.should)) filter.should = [...(filter.should || []), ...extraFilter.should];
    }
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ limit, with_payload: true, with_vector: false, filter }),
      signal,
    });
    if (!res.ok) {
      log('warn', 'scroll_collection_http_error', { collection: name, status: res.status });
      return fileStoreRead(name).map(e => ({ id: e.id, payload: e.payload }));
    }
    return (await res.json()).result?.points ?? [];
  } catch (err) {
    log('error', 'scroll_collection_failed', { collection: name, error: err?.message || String(err) });
    return fileStoreRead(name).map(e => ({ id: e.id, payload: e.payload }));
  }
}

/**
 * searchCollectionLexical: full-text (lexical) candidate retrieval for hybrid
 * recall. Tokenizes queryText and matches the top-level `text_search` payload
 * field with an OR over tokens (permissive — recall casts a wide net; RRF
 * fusion ranks afterward). Requires a Qdrant `text` index on `text_search`
 * (ensureTextIndex); if the index is missing or Qdrant is down, returns [] so
 * recall degrades cleanly to the vector leg. Match is boolean (unscored) — the
 * caller ranks candidates (see fusion.lexicalRank). Returns `{ id, payload }`.
 */
function tokenizeForLexical(queryText) {
  return [...new Set(
    String(queryText || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter(t => t.length >= 2)
  )].slice(0, 24);
}

async function searchCollectionLexical(name, queryText, limit, signal, extraFilter) {
  const tokens = tokenizeForLexical(queryText);
  if (tokens.length === 0) return [];
  // FileStore has no full-text index — lexical leg is a no-op there (vector leg
  // still serves recall). Callers fuse whatever each leg returns.
  if (!(await checkQdrant())) return [];
  try {
    const filter = {
      must: [buildQdrantUserFilter()],
      should: tokens.map(t => ({ key: 'text_search', match: { text: t } })),
    };
    if (extraFilter && typeof extraFilter === 'object') {
      if (Array.isArray(extraFilter.must)) filter.must.push(...extraFilter.must);
      if (Array.isArray(extraFilter.must_not)) filter.must_not = [...(filter.must_not || []), ...extraFilter.must_not];
    }
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ limit, with_payload: true, with_vector: false, filter }),
      signal,
    });
    if (!res.ok) {
      log('warn', 'lexical_search_http_error', { collection: name, status: res.status });
      return [];
    }
    return (await res.json()).result?.points ?? [];
  } catch (err) {
    log('warn', 'lexical_search_failed', { collection: name, error: err?.message || String(err) });
    return [];
  }
}

/**
 * ensureTextIndex: idempotently create a Qdrant full-text payload index on a
 * field (default `text_search`) so MatchText queries work. Safe to call on
 * every startup — Qdrant returns ok if the index already exists; any error is
 * logged and non-fatal (lexical leg degrades to empty until the index lands).
 */
async function ensureTextIndex(collection, field = 'text_search', signal) {
  if (!(await checkQdrant())) return false;
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/index`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        field_name: field,
        field_schema: { type: 'text', tokenizer: 'word', lowercase: true, min_token_len: 2, max_token_len: 30 },
      }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      // "already exists" is success-equivalent for our purposes.
      if (/exist/i.test(body)) return true;
      log('warn', 'ensure_text_index_failed', { collection, field, status: res.status, body: body.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    log('warn', 'ensure_text_index_error', { collection, field, error: err?.message || String(err) });
    return false;
  }
}

/**
 * setPayloadFields: merge top-level fields into a point's payload (Qdrant
 * set-payload merges, leaving other keys intact). Used by the text_search
 * backfill. No-op without Qdrant. Returns true on success.
 */
async function setPayloadFields(collection, pointId, fields, signal) {
  if (!(await checkQdrant())) return false;
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ points: [pointId], payload: fields }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log('warn', 'set_payload_fields_failed', { collection, pointId: String(pointId).slice(0, 8), status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log('warn', 'set_payload_fields_error', { collection, pointId: String(pointId).slice(0, 8), error: err?.message || String(err) });
    return false;
  }
}

// ============================================================
//  updatePointPayload — update single point in FileStore
// ============================================================

async function updatePointPayload(collection, pointId, updateFn) {
  if (!(await checkQdrant())) {
    fileStoreUpdate(collection, (entries) => {
      const entry = entries.find(e => e.id === pointId);
      if (entry && entry.payload?.json) {
        const data = JSON.parse(entry.payload.json);
        updateFn(data);
        entry.payload.json = JSON.stringify(data);
      }
    });
    return;
  }
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/${pointId}`, {
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const point = (await res.json()).result;
    if (!point?.payload?.json) return;
    const data = JSON.parse(point.payload.json);
    updateFn(data);
    await fetch(`${getQdrantBase()}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent */ }
}

// ============================================================
//  deleteEntry — remove from FileStore + Qdrant
// ============================================================

async function deleteEntry(collection, id) {
  if (!(await checkQdrant())) {
    fileStoreUpdate(collection, (entries) => {
      const kept = entries.filter(e => e.id !== id);
      entries.length = 0;
      entries.push(...kept);
    });
    return;
  }
  await fetch(`${getQdrantBase()}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ points: [id] }),
    signal: AbortSignal.timeout(5000),
  });
}

// ============================================================
//  syncToQdrant — push FileStore entries to Qdrant
// ============================================================

async function syncToQdrant() {
  if (!(await checkQdrant())) throw new Error('Qdrant not available');
  const collections = COLLECTIONS.map(c => c.name);
  let synced = 0;
  for (const coll of collections) {
    const entries = fileStoreRead(coll);
    if (entries.length === 0) continue;
    // Batch upsert in chunks of 50
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50).map(e => ({
        id: e.id, vector: e.vector, payload: e.payload,
      }));
      await fetch(`${getQdrantBase()}/collections/${coll}/points`, {
        method: 'PUT',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ points: batch }),
        signal: AbortSignal.timeout(30000),
      });
      synced += batch.length;
    }
  }
  return synced;
}

// ============================================================
//  Sparse BM25 (native Qdrant lexical leg)
//  Qdrant scores these with idf weighting server-side (sparse vector configured
//  with modifier:"idf"). Replaces the boolean MatchText leg with real scored
//  retrieval. A collection only supports this once it was (re)created with the
//  sparse vector config — see tools/migrate-sparse-bm25.js. The write path
//  probes support and falls back to dense-only, so deploy is non-breaking before
//  migration; the recall path falls back to searchCollectionLexical.
// ============================================================

// Per-collection support cache. value: { supported: bool, at: ms }
const _sparseSupport = new Map();
const SPARSE_SUPPORT_TTL_MS = 60_000;

/**
 * collectionSupportsSparse: true iff the collection was created with the
 * `text_bm25` sparse vector. Cached (60s) so the hot write path doesn't probe
 * Qdrant on every upsert. Returns false without Qdrant or on any error (callers
 * then write dense-only / fall back to MatchText).
 */
async function collectionSupportsSparse(collection, signal) {
  const cached = _sparseSupport.get(collection);
  if (cached && (Date.now() - cached.at) < SPARSE_SUPPORT_TTL_MS) return cached.supported;
  if (!(await checkQdrant())) return false;
  let supported = false;
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${collection}`, {
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const sv = (await res.json()).result?.config?.params?.sparse_vectors;
      supported = !!(sv && sv[SPARSE_VECTOR_NAME]);
    } else {
      log('warn', 'sparse_support_probe_http_error', { collection, status: res.status });
    }
  } catch (err) {
    log('warn', 'sparse_support_probe_error', { collection, error: err?.message || String(err) });
    return false; // do not cache transient errors
  }
  _sparseSupport.set(collection, { supported, at: Date.now() });
  return supported;
}

function invalidateSparseSupport(collection) {
  if (collection) _sparseSupport.delete(collection);
  else _sparseSupport.clear();
}

/**
 * searchCollectionSparse: native BM25 lexical leg. Builds a sparse query vector
 * from queryText and runs a scored sparse query (`using: text_bm25`). Returns
 * scored points `{ id, score, payload }` in Qdrant rank order. Returns [] when:
 * Qdrant is down, the collection has no sparse vector yet (pre-migration), the
 * query has no usable tokens, or any error — so recall degrades cleanly.
 */
async function searchCollectionSparse(name, queryText, limit, signal, extraFilter) {
  if (!(await checkQdrant())) return [];
  const sparse = buildSparseVector(queryText);
  if (sparse.indices.length === 0) return [];
  if (!(await collectionSupportsSparse(name, signal))) return [];
  try {
    const filter = { must: [buildQdrantUserFilter()] };
    if (extraFilter && typeof extraFilter === 'object') {
      if (Array.isArray(extraFilter.must)) filter.must.push(...extraFilter.must);
      if (Array.isArray(extraFilter.must_not)) filter.must_not = [...(filter.must_not || []), ...extraFilter.must_not];
      if (Array.isArray(extraFilter.should)) filter.should = [...(filter.should || []), ...extraFilter.should];
    }
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/query`, {
      method: 'POST',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query: sparse, using: SPARSE_VECTOR_NAME, limit, with_payload: true, filter }),
      signal,
    });
    if (!res.ok) {
      log('warn', 'sparse_search_http_error', { collection: name, status: res.status });
      return [];
    }
    return (await res.json()).result?.points ?? [];
  } catch (err) {
    log('warn', 'sparse_search_failed', { collection: name, error: err?.message || String(err) });
    return [];
  }
}

/**
 * ensureSparseCollection: create the collection WITH the text_bm25 sparse vector
 * if it does not exist. Qdrant cannot ADD a sparse vector to an existing
 * dense-only collection (PATCH update_collection only edits existing sparse
 * params) — migrating an existing collection is tools/migrate-sparse-bm25.js's
 * job. This only covers the fresh-install case. Idempotent; non-fatal.
 */
async function ensureSparseCollection(collection, dim, signal) {
  if (!(await checkQdrant())) return false;
  try {
    const check = await fetch(`${getQdrantBase()}/collections/${collection}`, {
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (check.ok) {
      const sv = (await check.json()).result?.config?.params?.sparse_vectors;
      if (sv && sv[SPARSE_VECTOR_NAME]) return true;
      log('warn', 'sparse_vector_absent_needs_migration', { collection });
      return false; // exists but dense-only — migration required, cannot PATCH-add
    }
    const create = await fetch(`${getQdrantBase()}/collections/${collection}`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        vectors: { size: Number(dim) || 768, distance: 'Cosine' },
        sparse_vectors: { [SPARSE_VECTOR_NAME]: { modifier: 'idf' } },
      }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!create.ok) {
      const body = await create.text();
      log('warn', 'ensure_sparse_collection_failed', { collection, status: create.status, body: body.slice(0, 200) });
      return false;
    }
    invalidateSparseSupport(collection);
    return true;
  } catch (err) {
    log('warn', 'ensure_sparse_collection_error', { collection, error: err?.message || String(err) });
    return false;
  }
}

// ============================================================
//  Exports
// ============================================================

module.exports = {
  checkQdrant, resetQdrantCheck, setQdrantAvailable, qdrantAvailable,
  fileStoreRead, fileStoreWrite, fileStoreSearch, fileStoreUpsert, fileStorePath,
  fileStoreUpdate,
  updatePointPayload,
  searchCollection,
  searchCollectionLexical,
  searchCollectionSparse,
  collectionSupportsSparse,
  invalidateSparseSupport,
  ensureSparseCollection,
  scrollCollection,
  ensureTextIndex,
  setPayloadFields,
  fetchPointById,
  deleteEntry,
  syncToQdrant,
  buildQdrantUserFilter,
  cosineSimilarity,
  tokenizeForLexical,
};
