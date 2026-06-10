'use strict';

/**
 * sparse.js — zero-dependency BM25 sparse-vector builder for native Qdrant
 * lexical retrieval.
 *
 * Qdrant (>=1.10) computes BM25 IDF natively when a sparse vector is configured
 * with `modifier: "idf"`: it tracks document frequency per dimension across the
 * collection and multiplies each stored value by idf at query time. So we do NOT
 * need a BM25/SPLADE model — we only emit a sparse vector whose VALUES are raw
 * term frequencies and whose INDICES are stable hashes of the terms. Qdrant
 * supplies the idf weighting and dot-product scoring.
 *
 * indices: uint32 FNV-1a hashes of tokens (collisions sum their tf — negligible
 *          at our corpus size, and harmless to ranking).
 * values:  term frequency (raw count). Capped to the top-N most frequent terms
 *          to bound payload size.
 *
 * The same builder is used for both stored documents and the query vector
 * (query terms are tf-counted identically; Qdrant scores the dot product).
 */

const SPARSE_VECTOR_NAME = 'text_bm25';
const MAX_TERMS = 256; // cap distinct dimensions per vector to bound payload

// FNV-1a 32-bit — deterministic, fast, well-distributed for short tokens.
// Returned as an unsigned 32-bit integer (valid Qdrant sparse index).
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// rawTokens: lowercased word tokens WITH duplicates (tokenize() in fusion.js
// dedupes via Set, which loses term frequency — so we re-split here for tf).
function rawTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(t => t.length >= 2);
}

/**
 * buildSparseVector(text) -> { indices: number[], values: number[] }
 * Empty { indices: [], values: [] } when text has no usable tokens — callers
 * must treat an empty sparse vector as "skip the sparse leg / write dense-only".
 */
function buildSparseVector(text) {
  const toks = rawTokens(text);
  if (toks.length === 0) return { indices: [], values: [] };

  // Term frequency keyed by hashed index (collisions accumulate).
  const tf = new Map();
  for (const tok of toks) {
    const idx = fnv1a32(tok);
    tf.set(idx, (tf.get(idx) || 0) + 1);
  }

  // Keep the highest-tf terms when over the cap (most informative for BM25).
  let entries = [...tf.entries()];
  if (entries.length > MAX_TERMS) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, MAX_TERMS);
  }

  const indices = new Array(entries.length);
  const values = new Array(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    indices[i] = entries[i][0];
    values[i] = entries[i][1];
  }
  return { indices, values };
}

module.exports = { buildSparseVector, fnv1a32, rawTokens, SPARSE_VECTOR_NAME, MAX_TERMS };
