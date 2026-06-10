'use strict';

/**
 * fusion.js — hybrid-recall result fusion.
 *
 * Recall runs two retrieval legs: a dense-vector kNN leg (semantic) and a
 * full-text lexical leg (exact terms / identifiers the embedding may miss).
 * This module fuses them with Reciprocal Rank Fusion (RRF) — the same rank-based
 * fusion Elasticsearch uses — so an entry that matches strongly on EITHER leg
 * surfaces. RRF needs only ranks, not calibrated scores, so the lexical leg is
 * scored with a light term-overlap metric (no BM25 model / no dependency).
 *
 * Zero deps. Pure functions — unit-testable without Qdrant.
 */

const RRF_K = 60; // standard RRF dampening constant

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let i = 0, n = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}

function tokenize(queryText) {
  return [...new Set(
    String(queryText || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter(t => t.length >= 2)
  )];
}

// lexicalScore: BM25-lite over a candidate's text_search. Term frequency is
// log-dampened; longer tokens (identifiers, error codes) weigh slightly more
// than short common words. Only relative ordering matters (feeds RRF).
function lexicalScore(textSearch, queryTokens) {
  const text = String(textSearch || '').toLowerCase();
  if (!text) return 0;
  let score = 0;
  for (const tok of queryTokens) {
    const occ = countOccurrences(text, tok);
    if (occ > 0) score += (1 + Math.log(occ)) * Math.min(2, tok.length / 4 + 0.5);
  }
  return score;
}

// lexicalRank: rank lexical candidates by lexicalScore desc (tie-break by stored
// hitCount when available). Drops zero-score candidates. Candidates are points
// shaped { id, payload } where payload.text_search holds the indexed text.
function lexicalRank(candidates, queryText) {
  const tokens = tokenize(queryText);
  if (tokens.length === 0) return [];
  return (candidates || [])
    .map(p => {
      let hitCount = 0;
      try { hitCount = JSON.parse(p.payload?.json || '{}').hitCount || 0; } catch { /* default */ }
      return { ...p, _lexScore: lexicalScore(p.payload?.text_search, tokens), _hitCount: hitCount };
    })
    .filter(p => p._lexScore > 0)
    .sort((a, b) => (b._lexScore - a._lexScore) || (b._hitCount - a._hitCount));
}

// rrfFuse: merge rank-ordered lists. score(d) = Σ 1/(k + rank_i(d)), rank 1-based.
// Dedupes by keyOf (default point id) — the FIRST list's representative wins, so
// pass the vector leg first to keep its cosine score on shared points. Returns
// points ordered by fused score with _rrfScore attached.
function rrfFuse(rankedLists, opts = {}) {
  const k = opts.k || RRF_K;
  const keyOf = opts.keyOf || (p => String(p.id));
  const acc = new Map();
  for (const list of (rankedLists || [])) {
    (list || []).forEach((p, idx) => {
      const key = keyOf(p);
      const contribution = 1 / (k + idx + 1);
      const cur = acc.get(key);
      if (cur) cur.score += contribution;
      else acc.set(key, { point: p, score: contribution });
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map(e => ({ ...e.point, _rrfScore: e.score }));
}

// hybridFuse: fuse a vector leg (points with cosine .score, Qdrant rank order)
// with lexical candidates ({id, payload}). Returns points in fused order, each
// carrying a display `score`: the real cosine for vector-origin points, or an
// indicative score for lexical-only hits (no cosine available). _rrfScore and
// _lexicalOnly are attached for diagnostics.
function hybridFuse(vectorPoints, lexicalCandidates, queryText, opts = {}) {
  // opts.preranked: the lexical leg is already scored + ordered (e.g. Qdrant
  // native BM25 sparse query) — use it as-is instead of app-side lexicalRank.
  const lexRanked = opts.preranked ? (lexicalCandidates || []) : lexicalRank(lexicalCandidates, queryText);
  const cosineById = new Map((vectorPoints || []).map(p => [String(p.id), p.score]));
  const fused = rrfFuse([vectorPoints || [], lexRanked], opts);
  const lexicalDisplay = typeof opts.lexicalDisplayScore === 'number' ? opts.lexicalDisplayScore : 0.5;
  return fused.map(p => {
    const cos = cosineById.get(String(p.id));
    if (typeof cos === 'number') return { ...p, score: cos };
    return { ...p, score: lexicalDisplay, _lexicalOnly: true };
  });
}

module.exports = { rrfFuse, lexicalRank, lexicalScore, hybridFuse, tokenize, RRF_K };
