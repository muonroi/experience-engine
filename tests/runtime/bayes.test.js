'use strict';

// bayes.js — Beta posterior math (spec §3 B2, §5 "bayes"): betaQuantile against
// known values (absolute tolerance 1e-6) and monotone in a and b; posterior math.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const B = require(path.join(__dirname, '..', '..', '.experience', 'src', 'bayes.js'));

const TOL = 1e-6;
const near = (actual, expected, tol = TOL, msg = '') => assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

// Exact CDF for integer a, b: P(Beta(a,b) <= x) = P(Binomial(a+b-1, x) >= a).
function binomialBetaCdf(x, a, b) {
  const n = a + b - 1;
  let sum = 0;
  let c = 1; // C(n, 0)
  for (let j = 0; j <= n; j++) {
    if (j > 0) c = (c * (n - j + 1)) / j;
    if (j >= a) sum += c * x ** j * (1 - x) ** (n - j);
  }
  return sum;
}

test('lgamma matches log((n-1)!) and log(sqrt(pi))', () => {
  near(B.lgamma(1), 0, 1e-12);
  near(B.lgamma(5), Math.log(24), 1e-12);
  near(B.lgamma(11), Math.log(3628800), 1e-10);
  near(B.lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
});

test('regularizedIncompleteBeta matches the exact binomial form for integer parameters', () => {
  for (const [a, b] of [[1, 1], [2, 3], [5, 2], [7, 13], [24, 6]]) {
    for (const x of [0.01, 0.2, 0.42, 0.5, 0.77, 0.99]) {
      near(B.regularizedIncompleteBeta(x, a, b), binomialBetaCdf(x, a, b), 1e-10, `I_${x}(${a},${b})`);
    }
  }
  assert.equal(B.regularizedIncompleteBeta(0, 2, 2), 0);
  assert.equal(B.regularizedIncompleteBeta(1, 2, 2), 1);
});

test('betaQuantile against known values', () => {
  near(B.betaQuantile(0.5, 2, 3), 0.3857275681323906, TOL, 'median Beta(2,3)');
  near(B.betaQuantile(0.5, 2, 2), 0.5, TOL, 'median Beta(2,2)');
  near(B.betaQuantile(0.3, 1, 1), 0.3, TOL, 'uniform');
  for (const u of [0.05, 0.3, 0.9]) {
    near(B.betaQuantile(u, 3, 1), u ** (1 / 3), TOL, `Beta(3,1) q${u}`);
    near(B.betaQuantile(u, 1, 4), 1 - (1 - u) ** (1 / 4), TOL, `Beta(1,4) q${u}`);
    near(B.betaQuantile(u, 0.5, 0.5), Math.sin((Math.PI * u) / 2) ** 2, TOL, `arcsine q${u}`);
  }
  // Round trip through the exact CDF for the shapes the gate actually sees.
  for (const [a, b] of [[4, 4], [2.8, 1.2], [14, 6], [21.5, 9.5], [102, 5]]) {
    for (const u of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      near(B.regularizedIncompleteBeta(B.betaQuantile(u, a, b), a, b), u, 1e-9, `round trip (${a},${b}) u=${u}`);
    }
  }
});

test('betaQuantile edge cases', () => {
  assert.equal(B.betaQuantile(0, 2, 2), 0);
  assert.equal(B.betaQuantile(1, 2, 2), 1);
  assert.ok(Number.isNaN(B.betaQuantile(0.5, 0, 2)));
  assert.ok(Number.isNaN(B.betaQuantile(0.5, 2, -1)));
});

test('betaQuantile is monotone: non-decreasing in a, non-increasing in b', () => {
  const us = [0.02, 0.2, 0.5, 0.8, 0.98];
  const grid = [0.5, 1, 1.7, 2, 3.3, 5, 8, 13, 21, 40];
  for (const u of us) {
    for (const b of grid) {
      let prev = -Infinity;
      for (const a of grid) {
        const q = B.betaQuantile(u, a, b);
        assert.ok(q >= prev - 1e-12, `a↑ u=${u} b=${b} a=${a}: ${q} < ${prev}`);
        prev = q;
      }
    }
    for (const a of grid) {
      let prev = Infinity;
      for (const b of grid) {
        const q = B.betaQuantile(u, a, b);
        assert.ok(q <= prev + 1e-12, `b↑ u=${u} a=${a} b=${b}: ${q} > ${prev}`);
        prev = q;
      }
    }
  }
});

test('posterior: a = mu*k + pos, b = (1-mu)*k + neg; mean', () => {
  assert.deepEqual(B.posterior({ mu: 0.5, k: 4, pos: 3, neg: 1 }), { a: 5, b: 3 });
  const seed = B.posterior({ mu: 0.7, k: 20, pos: 0, neg: 2 });
  near(seed.a, 14, 1e-12);
  near(seed.b, 8, 1e-12);
  near(B.posteriorMean(seed.a, seed.b), 14 / 22, 1e-12);
  assert.deepEqual(B.posterior({ mu: 0.5, k: 4, pos: -2, neg: -1 }), { a: 2, b: 2 }, 'negative evidence is clamped');
});
