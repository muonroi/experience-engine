/**
 * qdrant.js — Qdrant I/O + FileStore fallback for Experience Engine.
 * Extracted from experience-core.js. Zero npm dependencies.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');

const {
  getQdrantBase, getQdrantApiKey,
  getStoreDir, getExpUser, COLLECTIONS, getEmbedDim,
  activityLog,
} = require('./config');

// ============================================================
//  Qdrant connection state
// ============================================================

let qdrantAvailable = null; // null = unchecked, true/false = checked

async function checkQdrant() {
  if (qdrantAvailable !== null) return qdrantAvailable;
  try {
    const apiKey = getQdrantApiKey();
    const res = await fetch(`${getQdrantBase()}/collections`, {
      headers: apiKey ? { 'api-key': apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrantAvailable = res.ok;
  } catch { qdrantAvailable = false; }
  return qdrantAvailable;
}

function resetQdrantCheck() {
  qdrantAvailable = null;
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

function fileStoreWrite(collection, entries) {
  const dir = getStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  const locked = acquireLock(collection);
  try {
    const tmp = fileStorePath(collection) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, fileStorePath(collection));
  } finally {
    if (locked) releaseLock(collection);
  }
}

function fileStoreUpsert(collection, id, vector, payload) {
  const entries = fileStoreRead(collection);
  const idx = entries.findIndex(e => e.id === id);
  const entry = { id, vector, payload };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  fileStoreWrite(collection, entries);
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

async function fetchPointById(collection, pointId) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const found = entries.find(e => e.id === pointId);
    return found ? { id: found.id, score: 1.0, payload: found.payload } : null;
  }
  try {
    const apiKey = getQdrantApiKey();
    const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? { id: data.result.id, score: 1.0, payload: data.result.payload } : null;
  } catch { return null; }
}

async function searchCollection(name, vector, topK, signal) {
  if (!(await checkQdrant())) return fileStoreSearch(name, vector, topK);
  try {
    const res = await fetch(`${getQdrantBase()}/collections/${name}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ query: vector, limit: topK, with_payload: true, filter: { must: [buildQdrantUserFilter()] } }),
      signal,
    });
    if (!res.ok) return fileStoreSearch(name, vector, topK);
    return (await res.json()).result?.points ?? [];
  } catch { return fileStoreSearch(name, vector, topK); }
}

// ============================================================
//  updatePointPayload — update single point in FileStore
// ============================================================

async function updatePointPayload(collection, pointId, updateFn) {
  const entries = fileStoreRead(collection);
  const idx = entries.findIndex(e => e.id === pointId);
  if (idx < 0) {
    // Create entry if not found
    const emptyPayload = { json: JSON.stringify({ id: pointId }) };
    const newEntry = { id: pointId, vector: [], payload: emptyPayload };
    const updatedData = updateFn(JSON.parse(emptyPayload.json));
    newEntry.payload.json = JSON.stringify(updatedData);
    entries.push(newEntry);
    fileStoreWrite(collection, entries);
    return;
  }
  const data = JSON.parse(entries[idx].payload.json || '{}');
  const updated = updateFn(data);
  entries[idx].payload.json = JSON.stringify(updated);
  fileStoreWrite(collection, entries);
}

// ============================================================
//  deleteEntry — remove from FileStore + Qdrant
// ============================================================

async function deleteEntry(collection, id) {
  // Remove from FileStore
  const entries = fileStoreRead(collection);
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length !== entries.length) {
    fileStoreWrite(collection, filtered);
  }

  // Remove from Qdrant if reachable
  if (await checkQdrant()) {
    try {
      await fetch(`${getQdrantBase()}/collections/${collection}/points/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ points: [id] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best-effort */ }
  }
}

// ============================================================
//  syncToQdrant — push FileStore entries to Qdrant
// ============================================================

async function syncToQdrant() {
  if (!(await checkQdrant())) {
    activityLog({ op: 'sync-skip', reason: 'qdrant-unavailable' });
    return;
  }
  const collections = [
    ...COLLECTIONS.map(c => c.name),
    'experience-edges',
    'experience-routes',
  ];

  for (const coll of collections) {
    try {
      const entries = fileStoreRead(coll);
      if (entries.length === 0) continue;

      const points = entries.map(e => {
        let payload = e.payload || {};
        try { payload = typeof payload.json === 'string' ? JSON.parse(payload.json) : payload; } catch {}
        return {
          id: e.id,
          vector: e.vector || [],
          payload: { ...payload, user: getExpUser() },
        };
      });

      // Batch upsert (limit 100 per request per Qdrant recommendation)
      for (let i = 0; i < points.length; i += 100) {
        const batch = points.slice(i, i + 100);
        await fetch(`${getQdrantBase()}/collections/${coll}/points`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
          body: JSON.stringify({ points: batch }),
          signal: AbortSignal.timeout(15000),
        });
      }

      // Remove deleted entries from Qdrant (entries in Qdrant but not in FileStore)
      const qdrantIds = new Set(points.map(p => p.id));
      const res = await fetch(`${getQdrantBase()}/collections/${coll}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ limit: 10000, with_payload: false, filter: { must: [buildQdrantUserFilter()] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const remotePoints = (await res.json()).result?.points || [];
        const toDelete = remotePoints.filter(rp => !qdrantIds.has(rp.id)).map(rp => rp.id);
        if (toDelete.length > 0) {
          for (let i = 0; i < toDelete.length; i += 100) {
            await fetch(`${getQdrantBase()}/collections/${coll}/points/delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
              body: JSON.stringify({ points: toDelete.slice(i, i + 100) }),
              signal: AbortSignal.timeout(10000),
            });
          }
        }
      }

      activityLog({ op: 'sync', collection: coll, points: points.length });
    } catch (err) {
      activityLog({ op: 'sync-error', collection: coll, error: err?.message || String(err) });
    }
  }
}

// ============================================================
//  Exports
// ============================================================

module.exports = {
  checkQdrant, resetQdrantCheck, qdrantAvailable,
  fileStoreRead, fileStoreWrite, fileStoreSearch, fileStoreUpsert, fileStorePath,
  updatePointPayload,
  searchCollection,
  fetchPointById,
  deleteEntry,
  syncToQdrant,
  buildQdrantUserFilter,
  cosineSimilarity,
};
