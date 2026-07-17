/**
 * graph.js — Edge graph management (Phase 107).
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { EDGE_COLLECTION, getExpUser } = require('./config');
const { fileStoreRead, fileStoreUpsert, fileStorePath } = require('./qdrant');
// activityLog from ./activity (real writer); ./config exports a no-op stub.
const { activityLog } = require('./activity');

// --- Edge index (stat-keyed cache) ---
//
// The recall hot path calls getEdgesForId twice per surfaced point across ~45
// points (experience-core.js:460-461 and :489-495) — ~90 lookups per recall.
// Reading + parsing the whole edge store per lookup cost ~28.8ms against the
// production store (2.57MB / 6534 edges) = ~2.6s of uninterrupted synchronous
// blocking per recall. Because node is single-threaded that starved everything
// else: under 3 concurrent recalls even the static GET /api/version handler
// timed out for ~17s, and clients saw [ee_unavailable] / health status:0.
//
// So parse once and serve lookups from an index. The cache key is
// mtimeMs + size rather than mtime alone: mtime granularity can be coarse
// enough that two writes inside the same tick are indistinguishable, and a
// stale edge index silently corrupts supersede detection.
//
// Deliberately NOT cached inside fileStoreRead: fileStoreUpsert mutates the
// array it returns in place before writing it back, so a shared cached array
// would alias — and would stay poisoned if the write then failed.
let _edgeIndex = null; // { key, byId: Map<string, edge[]>, byType: Map<string, edge[]> }

function _edgeStoreKey() {
  try {
    const st = fs.statSync(fileStorePath(EDGE_COLLECTION));
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    // Missing store is the normal cold-start state, not an error worth logging.
    if (err.code !== 'ENOENT') {
      console.error(`[graph] stat of edge store failed: ${err?.message}`, { code: err?.code });
    }
    return 'absent';
  }
}

function _buildEdgeIndex() {
  const byId = new Map();
  const byType = new Map();
  const push = (map, key, edge) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(edge);
    else map.set(key, [edge]);
  };
  for (const raw of fileStoreRead(EDGE_COLLECTION)) {
    let edge;
    try {
      edge = JSON.parse(raw.payload?.json || '{}');
    } catch (err) {
      console.error(`[graph] skipping unparsable edge payload: ${err?.message}`, { id: raw?.id });
      continue;
    }
    if (!edge) continue;
    push(byType, edge.type, edge);
    push(byId, edge.source, edge);
    // A self-edge must not be double-counted for its own id.
    if (edge.target !== edge.source) push(byId, edge.target, edge);
  }
  return { byId, byType };
}

function _index() {
  const key = _edgeStoreKey();
  if (_edgeIndex && _edgeIndex.key === key) return _edgeIndex;
  const built = _buildEdgeIndex();
  _edgeIndex = { key, byId: built.byId, byType: built.byType };
  return _edgeIndex;
}

/** Drop the cached index — call after any write to the edge store. */
function invalidateEdgeIndex() {
  _edgeIndex = null;
}

// --- Edge graph (Phase 107) ---

function createEdge(source, target, type, weight = 1.0, createdBy = 'auto') {
  const edge = {
    id: crypto.randomUUID(),
    source, target,
    type, // 'generalizes' | 'contradicts' | 'supersedes' | 'relates-to'
    weight,
    createdAt: new Date().toISOString(),
    createdBy,
  };
  const exists = (_index().byId.get(source) || [])
    .some(d => d.source === source && d.target === target && d.type === type);
  if (exists) return null;
  fileStoreUpsert(EDGE_COLLECTION, edge.id, [], { json: JSON.stringify(edge), user: getExpUser() });
  invalidateEdgeIndex();
  activityLog({ op: 'edge-create', type, source: source.slice(0, 8), target: target.slice(0, 8) });
  return edge;
}

function getEdgesForId(experienceId) {
  return (_index().byId.get(experienceId) || []).slice();
}

function getEdgesOfType(type) {
  return (_index().byType.get(type) || []).slice();
}

module.exports = { createEdge, getEdgesForId, getEdgesOfType, invalidateEdgeIndex };
