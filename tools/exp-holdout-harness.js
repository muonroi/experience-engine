#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CORE = require('../.experience/experience-core.js');

const DEFAULT_COLLECTIONS = ['experience-principles', 'experience-behavioral'];

function parseArgs(argv) {
  const args = {
    fixture: '',
    collections: [],
    topK: 5,
    threshold: 0.45,
    apply: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture' && argv[i + 1]) args.fixture = argv[++i];
    else if (arg === '--collection' && argv[i + 1]) args.collections.push(argv[++i]);
    else if (arg === '--top-k' && argv[i + 1]) args.topK = Math.max(1, Number(argv[++i]) || 5);
    else if (arg === '--threshold' && argv[i + 1]) args.threshold = Number(argv[++i]);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
  }

  return args;
}

function listFixtureFiles(inputPath) {
  const absolute = path.resolve(inputPath);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) throw new Error('fixture path must be a file or directory');
  return fs.readdirSync(absolute)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(absolute, name));
}

function loadFixture(filePath) {
  if (!filePath) throw new Error('--fixture is required');
  const files = listFixtureFiles(filePath);
  const suites = [];
  for (const absolute of files) {
    const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const fileSuites = Array.isArray(data?.suites) ? data.suites : [];
    if (fileSuites.length === 0) {
      throw new Error(`fixture ${path.basename(absolute)} must contain a non-empty suites[] array`);
    }
    for (const suite of fileSuites) {
      suites.push({ ...suite, fixtureFile: absolute });
    }
  }
  return { absolute: path.resolve(filePath), files, suites };
}

function normalizeCase(item, kind, index) {
  const text = String(item?.text || '').trim();
  if (!text) throw new Error(`${kind}[${index}] is missing text`);
  return {
    id: String(item.id || `${kind}-${index + 1}`),
    text,
    projectSlug: String(item.projectSlug || '').trim() || null,
    domain: String(item.domain || '').trim() || null,
  };
}

function normalizeSuite(raw, collections) {
  const suite = {
    name: String(raw?.name || '').trim() || 'unnamed-suite',
    family: String(raw?.family || raw?.name || '').trim() || 'unknown-family',
    fixtureFile: raw?.fixtureFile || null,
    principleId: String(raw?.principleId || '').trim(),
    targetCollection: String(raw?.targetCollection || '').trim() || 'experience-principles',
    collections: Array.isArray(raw?.collections) && raw.collections.length > 0 ? raw.collections : collections,
    seed: Array.isArray(raw?.seed) ? raw.seed.map((item, index) => normalizeCase(item, 'seed', index)) : [],
    holdout: Array.isArray(raw?.holdout) ? raw.holdout.map((item, index) => normalizeCase(item, 'holdout', index)) : [],
  };
  if (!suite.principleId) throw new Error(`suite "${suite.name}" is missing principleId`);
  if (suite.seed.length === 0) throw new Error(`suite "${suite.name}" must include at least one seed case`);
  if (suite.holdout.length === 0) throw new Error(`suite "${suite.name}" must include at least one holdout case`);
  return suite;
}

async function searchCandidates(text, suite, deps, topK) {
  const vector = await deps.getEmbeddingRaw(text);
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`embedding failed for query: ${text.slice(0, 80)}`);
  }

  let points = [];
  for (const collection of suite.collections) {
    const hits = await deps.searchCollection(collection, vector, topK);
    for (const hit of hits) {
      points.push({ ...hit, _collection: collection });
    }
  }

  if (typeof deps.rerankByQuality === 'function') {
    points = deps.rerankByQuality(points, null, null, text);
  } else {
    points = points.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  return points;
}

function findTargetMatch(points, suite, threshold) {
  const target = points.find((point) => point.id === suite.principleId && point._collection === suite.targetCollection);
  if (!target) return { matched: false, score: null, rank: null };
  const rank = points.findIndex((point) => point.id === suite.principleId && point._collection === suite.targetCollection) + 1;
  const score = Number((target._effectiveScore ?? target.score ?? 0).toFixed(3));
  return { matched: score >= threshold, score, rank };
}

async function evaluateCases(cases, kind, suite, args, deps) {
  const results = [];
  for (const item of cases) {
    const candidates = await searchCandidates(item.text, suite, deps, args.topK);
    const target = findTargetMatch(candidates, suite, args.threshold);
    const top = candidates.slice(0, args.topK).map((point) => ({
      id: point.id,
      collection: point._collection,
      score: Number((point._effectiveScore ?? point.score ?? 0).toFixed(3)),
    }));

    if (kind === 'holdout' && args.apply) {
      await deps.recordHoldoutOutcome(suite.targetCollection, suite.principleId, {
        holdoutKey: `${suite.name}:${item.id}`,
        matched: target.matched,
        projectSlug: item.projectSlug,
        sourceSession: `holdout:${suite.name}:${item.id}`,
        label: item.id,
      });
    }

    results.push({
      id: item.id,
      matched: target.matched,
      score: target.score,
      rank: target.rank,
      top,
    });
  }
  return results;
}

async function evaluateSuite(rawSuite, args, deps) {
  const suite = normalizeSuite(rawSuite, args.collections.length > 0 ? args.collections : DEFAULT_COLLECTIONS);
  const seed = await evaluateCases(suite.seed, 'seed', suite, args, deps);
  const holdout = await evaluateCases(suite.holdout, 'holdout', suite, args, deps);

  return {
    name: suite.name,
    family: suite.family,
    fixtureFile: suite.fixtureFile,
    principleId: suite.principleId,
    targetCollection: suite.targetCollection,
    seedSupport: {
      matched: seed.filter((item) => item.matched).length,
      tested: seed.length,
      cases: seed,
    },
    holdoutProof: {
      matched: holdout.filter((item) => item.matched).length,
      tested: holdout.length,
      cases: holdout,
    },
  };
}

async function runHarness(args, deps = {}) {
  const fixture = loadFixture(args.fixture);
  const runtimeDeps = {
    getEmbeddingRaw: deps.getEmbeddingRaw || CORE.getEmbeddingRaw,
    searchCollection: deps.searchCollection || CORE.searchCollection,
    rerankByQuality: deps.rerankByQuality || CORE._rerankByQuality,
    recordHoldoutOutcome: deps.recordHoldoutOutcome || CORE.recordHoldoutOutcome,
  };

  const suites = [];
  for (const suite of fixture.suites) {
    suites.push(await evaluateSuite(suite, args, runtimeDeps));
  }

  return {
    fixture: fixture.absolute,
    fixtureFiles: fixture.files,
    apply: args.apply,
    topK: args.topK,
    threshold: args.threshold,
    suites,
  };
}

function formatHuman(result) {
  const lines = [];
  for (const suite of result.suites) {
    lines.push(`${suite.name} [${suite.targetCollection}:${suite.principleId}]`);
    lines.push(`  seed support: ${suite.seedSupport.matched}/${suite.seedSupport.tested}`);
    lines.push(`  holdout proof: ${suite.holdoutProof.matched}/${suite.holdoutProof.tested}`);
  }
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runHarness(args);
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_COLLECTIONS,
  parseArgs,
  listFixtureFiles,
  loadFixture,
  normalizeSuite,
  findTargetMatch,
  evaluateSuite,
  runHarness,
  formatHuman,
};
