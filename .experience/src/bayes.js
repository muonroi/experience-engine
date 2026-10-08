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

// --- Beta distribution ---------------------------------------------------------

// Lanczos approximation (g = 7, n = 9), ~1e-15 relative error for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let acc = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < LANCZOS.length; i++) acc += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

// Continued fraction for the incomplete beta (modified Lentz; Numerical Recipes
// betacf). Converges fast for x < (a+1)/(a+b+2); the caller uses the symmetry
// I_x(a,b) = 1 - I_{1-x}(b,a) on the other side.
function betaContinuedFraction(a, b, x) {
  const MAXIT = 500;
  const EPS = 1e-16;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b) = P(Beta(a, b) <= x). a, b > 0. */
function regularizedIncompleteBeta(x, a, b) {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const logFront = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(logFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Quantile of Beta(a, b): the x with I_x(a, b) = u, by bisection. Bisection, not
 * Newton: it cannot overshoot or diverge near 0/1, and because I_x(a, b) falls as
 * a grows and rises as b grows, the returned quantile is monotone — non-decreasing
 * in a, non-increasing in b — which is what makes the beta gate monotone in
 * evidence (more positive evidence can never turn a pass into a fail).
 */
function betaQuantile(u, a, b) {
  if (!(a > 0) || !(b > 0)) return NaN;
  if (!(u > 0)) return 0;
  if (!(u < 1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Posterior Beta(a, b) from a prior mean mu with strength k (pseudo-observations)
 * and weighted evidence: a = mu*k + pos, b = (1 - mu)*k + neg.
 */
function posterior({ mu, k, pos = 0, neg = 0 }) {
  return { a: mu * k + Math.max(0, pos), b: (1 - mu) * k + Math.max(0, neg) };
}

function posteriorMean(a, b) {
  return a / (a + b);
}

module.exports = {
  fnv1a32,
  fmix32,
  unitHash,
  lgamma,
  regularizedIncompleteBeta,
  betaQuantile,
  posterior,
  posteriorMean,
};
