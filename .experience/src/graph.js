/**
 * graph.js — Edge graph management (Phase 107).
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const crypto = require('crypto');
const { EDGE_COLLECTION, getExpUser } = require('./config');
const { fileStoreRead, fileStoreUpsert } = require('./qdrant');
const { activityLog } = require('./config');

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
  const edges = fileStoreRead(EDGE_COLLECTION);
  const exists = edges.some(e => {
    try {
      const d = JSON.parse(e.payload?.json || '{}');
      return d.source === source && d.target === target && d.type === type;
    } catch { return false; }
  });
  if (exists) return null;
  fileStoreUpsert(EDGE_COLLECTION, edge.id, [], { json: JSON.stringify(edge), user: getExpUser() });
  activityLog({ op: 'edge-create', type, source: source.slice(0, 8), target: target.slice(0, 8) });
  return edge;
}

function getEdgesForId(experienceId) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && (e.source === experienceId || e.target === experienceId));
}

function getEdgesOfType(type) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && e.type === type);
}

module.exports = { createEdge, getEdgesForId, getEdgesOfType };
