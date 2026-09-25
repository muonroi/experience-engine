/**
 * bayes.js — pure math for the lift experiment and the Beta confidence model.
 * Zero dependencies, no I/O, no config: every input is an argument.
 *
 * Hashing (fnv1a32 → fmix32 → [0,1)) is the one randomisation primitive the plan
 * uses everywhere a draw must be REPRODUCIBLE rather than random: session arms
 * (holdout, confidence model) and the per-(session, point, day) posterior draw of
 * the beta gate. Math.random would make an arm or a gate decision unrepeatable
 * across the separate hook processes that serve one session.
 * See docs/specs/2026-09-25-hint-lift-and-bayesian-confidence.md §3 A2, B2, B3.
 */
'use strict';

const TWO_POW_32 = 4294967296;

// 32-bit FNV-1a over the UTF-8 bytes (not UTF-16 code units, so a session id
// hashes the same in any runtime that re-implements this).
function fnv1a32(str) {
  const bytes = Buffer.from(String(str), 'utf8');
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// MurmurHash3's 32-bit finaliser. FNV-1a alone has weak avalanche in the high
// bits for inputs that differ only in their last characters ("s-1", "s-2", ...),
// which is exactly what sequential session ids look like; fmix32 spreads them.
function fmix32(h) {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic uniform draw in [0, 1) from a string key. */
function unitHash(key) {
  return fmix32(fnv1a32(key)) / TWO_POW_32;
}

module.exports = {
  fnv1a32,
  fmix32,
  unitHash,
};
