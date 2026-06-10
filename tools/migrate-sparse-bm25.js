#!/usr/bin/env node
'use strict';

/**
 * migrate-sparse-bm25.js — add the native BM25 `text_bm25` sparse vector to the
 * experience collections.
 *
 * WHY a migration (not a backfill): Qdrant cannot ADD a sparse vector to an
 * existing dense-only collection — PATCH /collections only edits the params of
 * sparse vectors that already exist ("Not existing vector name error"). So a
 * collection created dense-only must be RECREATED with the sparse config and its
 * points re-uploaded. New installs are born with sparse (setup.sh), so this only
 * touches pre-existing collections.
 *
 * Safety:
 *  - DRY RUN by default. Pass --apply to mutate. The destructive recreate runs
 *    ONLY under --apply.
 *  - Before recreating, a Qdrant snapshot is taken (rollback point); its name is
 *    printed. Restore with: POST /collections/{name}/snapshots/{snapshot}/recover
 *  - Point count is verified after re-upload; a mismatch is reported as failure.
 *  - Collections already carrying text_bm25 are only TOP-UP backfilled (sparse
 *    vector added to points missing it via the update-vectors API — no recreate).
 *  - Idempotent: re-running after a successful migration is a no-op top-up.
 *
 * Usage:
 *   node tools/migrate-sparse-bm25.js                       # dry run, all collections
 *   node tools/migrate-sparse-bm25.js --apply               # migrate all
 *   node tools/migrate-sparse-bm25.js --apply --collection experience-behavioral
 */

const path = require('path');
const EXP = path.join(__dirname, '..', '.experience', 'src');
const { getQdrantBase, getQdrantApiKey } = require(path.join(EXP, 'config'));
const { checkQdrant, ensureTextIndex, invalidateSparseSupport } = require(path.join(EXP, 'qdrant'));
const { buildSparseVector, SPARSE_VECTOR_NAME } = require(path.join(EXP, 'sparse'));
const { buildTextSearch } = require(path.join(EXP, 'format'));

const ALL_COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const APPLY = process.argv.includes('--apply');
const collIdx = process.argv.indexOf('--collection');
const ONLY = collIdx !== -1 ? process.argv[collIdx + 1] : null;
const COLLECTIONS = ONLY ? [ONLY] : ALL_COLLECTIONS;
const PAGE = 256;
const BATCH = 64;

function headers() {
  const k = getQdrantApiKey();
  return { 'Content-Type': 'application/json', ...(k ? { 'api-key': k } : {}) };
}

async function qfetch(method, urlPath, body, timeout = 30000) {
  const res = await fetch(`${getQdrantBase()}${urlPath}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  return res;
}

async function getCollection(collection) {
  const res = await qfetch('GET', `/collections/${collection}`, null, 5000);
  if (!res.ok) return null;
  return (await res.json()).result;
}

async function scrollAll(collection) {
  const points = [];
  let offset = null;
  do {
    const res = await qfetch('POST', `/collections/${collection}/points/scroll`,
      { limit: PAGE, with_payload: true, with_vector: true, offset }, 30000);
    if (!res.ok) throw new Error(`scroll ${collection} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()).result || {};
    points.push(...(body.points || []));
    offset = body.next_page_offset ?? null;
  } while (offset !== null && offset !== undefined);
  return points;
}

// Normalize a scrolled point's dense vector. Unnamed-dense collections return an
// array; named return an object — keep only the default dense for re-upload.
function denseOf(point) {
  const v = point.vector;
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return v[''] || v.default || null;
  return null;
}

function sparseFor(point) {
  let text = point.payload?.text_search;
  if (typeof text !== 'string' || !text.trim()) {
    let data = {};
    try { data = JSON.parse(point.payload?.json || '{}'); } catch { /* default */ }
    text = buildTextSearch(data);
  }
  return { text, sparse: buildSparseVector(text) };
}

async function topUpSparse(collection, points) {
  // Collection already has the sparse config — only add the sparse vector to
  // points via the update-vectors API (idempotent overwrite). No recreate.
  let updated = 0, skipped = 0, failed = 0;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH).map(p => {
      const { sparse } = sparseFor(p);
      if (sparse.indices.length === 0) return null;
      return { id: p.id, vector: { [SPARSE_VECTOR_NAME]: sparse } };
    }).filter(Boolean);
    skipped += (points.slice(i, i + BATCH).length - batch.length);
    if (batch.length === 0) continue;
    if (!APPLY) { updated += batch.length; continue; }
    const res = await qfetch('PUT', `/collections/${collection}/points/vectors?wait=true`, { points: batch }, 30000);
    if (res.ok) updated += batch.length;
    else { failed += batch.length; console.error(`[migrate] ${collection} top-up batch failed: ${res.status} ${(await res.text()).slice(0, 200)}`); }
  }
  console.log(`[migrate] ${collection}: ALREADY sparse — top-up ${APPLY ? 'updated' : 'would-update'}=${updated} skipped(empty)=${skipped} failed=${failed}`);
  return { failed };
}

async function recreateWithSparse(collection, cfg, points) {
  const size = cfg?.config?.params?.vectors?.size;
  const distance = cfg?.config?.params?.vectors?.distance || 'Cosine';
  const before = points.length;
  if (!size) { console.error(`[migrate] ${collection}: cannot read vector size — skipping`); return { failed: 1 }; }

  console.log(`[migrate] ${collection}: dense-only (size=${size}, points=${before}) → RECREATE with ${SPARSE_VECTOR_NAME} (idf)`);
  if (!APPLY) {
    let upserts = 0, noSparse = 0, noDense = 0;
    for (const p of points) {
      if (denseOf(p) == null) { noDense += 1; continue; }
      if (sparseFor(p).sparse.indices.length === 0) noSparse += 1;
      upserts += 1;
    }
    console.log(`[migrate] ${collection}: DRY RUN — would recreate + re-upload ${upserts} points (no-dense=${noDense}, no-sparse-terms=${noSparse}). Pass --apply to perform.`);
    return { failed: 0 };
  }

  // 1) snapshot for rollback
  const snap = await qfetch('POST', `/collections/${collection}/snapshots?wait=true`, null, 120000);
  if (snap.ok) {
    const name = (await snap.json()).result?.name;
    console.log(`[migrate] ${collection}: snapshot created for rollback → ${name}`);
  } else {
    console.error(`[migrate] ${collection}: snapshot FAILED (${snap.status}) — aborting recreate for safety.`);
    return { failed: 1 };
  }

  // 2) delete + 3) recreate with dense + sparse
  const del = await qfetch('DELETE', `/collections/${collection}`, null, 30000);
  if (!del.ok) { console.error(`[migrate] ${collection}: delete failed ${del.status} — aborting.`); return { failed: 1 }; }
  const create = await qfetch('PUT', `/collections/${collection}`, {
    vectors: { size, distance },
    sparse_vectors: { [SPARSE_VECTOR_NAME]: { modifier: 'idf' } },
  }, 30000);
  if (!create.ok) { console.error(`[migrate] ${collection}: recreate FAILED ${create.status} ${(await create.text()).slice(0, 200)} — RESTORE FROM SNAPSHOT.`); return { failed: 1 }; }
  invalidateSparseSupport(collection);
  await ensureTextIndex(collection); // MatchText fallback leg + scope filters

  // 4) re-upload points with dense + sparse
  let uploaded = 0, noDense = 0, failed = 0;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = [];
    for (const p of points.slice(i, i + BATCH)) {
      const dense = denseOf(p);
      if (dense == null) { noDense += 1; continue; }
      const { text, sparse } = sparseFor(p);
      const payload = { ...(p.payload || {}) };
      if (text && !payload.text_search) payload.text_search = text;
      const vector = sparse.indices.length > 0 ? { '': dense, [SPARSE_VECTOR_NAME]: sparse } : { '': dense };
      batch.push({ id: p.id, vector, payload });
    }
    if (batch.length === 0) continue;
    const res = await qfetch('PUT', `/collections/${collection}/points?wait=true`, { points: batch }, 60000);
    if (res.ok) uploaded += batch.length;
    else { failed += batch.length; console.error(`[migrate] ${collection}: upload batch failed ${res.status} ${(await res.text()).slice(0, 200)}`); }
  }

  // 5) verify count
  const after = await getCollection(collection);
  const afterCount = after?.points_count ?? -1;
  const ok = afterCount === before;
  console.log(`[migrate] ${collection}: re-uploaded=${uploaded} no-dense=${noDense} failed=${failed} | count before=${before} after=${afterCount} ${ok ? 'OK' : 'MISMATCH!'}`);
  return { failed: failed + (ok ? 0 : 1) + noDense };
}

(async () => {
  if (!(await checkQdrant())) {
    console.error('[migrate] Qdrant not available — aborting (server-side only).');
    process.exitCode = 1;
    return;
  }
  console.log(`[migrate] sparse BM25 migration${APPLY ? '' : ' (DRY RUN — pass --apply to mutate)'} across: ${COLLECTIONS.join(', ')}`);
  let failures = 0;
  for (const c of COLLECTIONS) {
    const cfg = await getCollection(c);
    if (!cfg) { console.error(`[migrate] ${c}: not found — skipping.`); continue; }
    const hasSparse = !!cfg.config?.params?.sparse_vectors?.[SPARSE_VECTOR_NAME];
    let points;
    try { points = await scrollAll(c); }
    catch (err) { console.error(`[migrate] ${c}: ${err?.message || err}`); failures += 1; continue; }
    const r = hasSparse ? await topUpSparse(c, points) : await recreateWithSparse(c, cfg, points);
    failures += (r.failed || 0);
  }
  console.log(`[migrate] DONE — failures=${failures}${APPLY ? '' : ' (dry run)'}`);
  if (failures > 0) process.exitCode = 1;
})();
