#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = require('../.experience/experience-core.js');

const DEFAULT_COLLECTIONS = [
  'experience-principles',
  'experience-behavioral',
  'experience-selfqa',
  'experience-routes',
];

function parseArgs(argv) {
  const args = {
    query: '',
    collections: [],
    limit: 5,
    mode: 'semantic',
    json: false,
    listCollections: false,
    includeRaw: false,
    minScore: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--collection' && argv[i + 1]) args.collections.push(argv[++i]);
    else if (arg === '--limit' && argv[i + 1]) args.limit = Math.max(1, Number(argv[++i]) || 5);
    else if (arg === '--mode' && argv[i + 1]) args.mode = String(argv[++i] || '').toLowerCase();
    else if (arg === '--json') args.json = true;
    else if (arg === '--list-collections') args.listCollections = true;
    else if (arg === '--include-raw') args.includeRaw = true;
    else if (arg === '--min-score' && argv[i + 1]) args.minScore = Number(argv[++i]);
    else if (!arg.startsWith('-') && !args.query) args.query = arg;
    else if (!arg.startsWith('-') && args.query) args.query += ` ${arg}`;
  }

  return args;
}

function loadConfig(homeDir = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveCollections(requested) {
  if (Array.isArray(requested) && requested.length > 0) return requested;
  return DEFAULT_COLLECTIONS.slice();
}

function parsePayload(point) {
  try {
    return JSON.parse(point?.payload?.json || '{}');
  } catch {
    return {};
  }
}

function buildTextHaystack(point, data) {
  const parts = [
    point.id,
    data.trigger,
    data.question,
    data.solution,
    data.principle,
    data.why,
    data.failureMode,
    data.judgment,
    data.domain,
    data.createdFrom,
    data._projectSlug,
    ...(Array.isArray(data.conditions) ? data.conditions : []),
    ...(Array.isArray(data.confirmedProjects) ? data.confirmedProjects : []),
  ];
  return parts
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
}

function scoreTextMatch(query, point, data) {
  const haystack = buildTextHaystack(point, data);
  const tokens = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) matched++;
  }
  return matched / tokens.length;
}

function sortAndTrim(points, limit, minScore = null) {
  return points
    .filter((point) => minScore == null || (point.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

function summarizePoint(point, collection, includeRaw = false) {
  const data = parsePayload(point);
  const summary = {
    id: point.id,
    collection,
    score: typeof point.score === 'number' ? Number(point.score.toFixed(3)) : null,
    tier: data.tier ?? null,
    trigger: data.trigger || null,
    principle: data.principle || null,
    solution: data.solution || null,
    failureMode: data.failureMode || null,
    judgment: data.judgment || null,
    createdFrom: data.createdFrom || null,
    projectSlug: data._projectSlug || null,
    confirmedProjects: Array.isArray(data.confirmedProjects) ? data.confirmedProjects : [],
  };
  if (includeRaw) summary.raw = data;
  return summary;
}

async function qdrantRequest(baseUrl, apiKey, requestPath, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;
  const res = await fetch(`${String(baseUrl || '').replace(/\/$/, '')}${requestPath}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`${requestPath} HTTP ${res.status}`);
  }
  return res.json();
}

function buildUserFilter() {
  return {
    must: [
      {
        should: [
          { key: 'user', match: { value: CORE.EXP_USER } },
          { is_empty: { key: 'user' } },
        ],
      },
    ],
  };
}

async function listCollections(config) {
  const data = await qdrantRequest(config.qdrantUrl || 'http://localhost:6333', config.qdrantKey || '', '/collections');
  return data?.result?.collections?.map((item) => item.name) || [];
}

async function scrollCollection(collection, config, limit = 50) {
  const data = await qdrantRequest(
    config.qdrantUrl || 'http://localhost:6333',
    config.qdrantKey || '',
    `/collections/${collection}/points/scroll`,
    {
      method: 'POST',
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
        filter: buildUserFilter(),
      }),
    }
  );
  return data?.result?.points || [];
}

async function semanticSearch(query, collection, limit) {
  const vector = await CORE.getEmbeddingRaw(query);
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding failed for semantic search');
  }
  const points = await CORE.searchCollection(collection, vector, limit);
  return points.map((point) => ({ ...point, _collection: collection }));
}

async function scrollSearch(query, collection, config, limit) {
  const points = await scrollCollection(collection, config, Math.max(limit * 10, 50));
  const matched = points
    .map((point) => {
      const data = parsePayload(point);
      return {
        ...point,
        _collection: collection,
        score: scoreTextMatch(query, point, data),
      };
    })
    .filter((point) => point.score > 0);
  return sortAndTrim(matched, limit);
}

async function runQuery(args, options = {}) {
  const config = options.config || loadConfig(args.homeDir);
  if (args.listCollections) {
    return { mode: 'list-collections', collections: await listCollections(config) };
  }
  if (!args.query) throw new Error('query text is required unless --list-collections is used');

  const collections = resolveCollections(args.collections);
  const results = [];
  for (const collection of collections) {
    const points = args.mode === 'scroll'
      ? await scrollSearch(args.query, collection, config, args.limit)
      : await semanticSearch(args.query, collection, args.limit);
    for (const point of points) {
      results.push({
        ...summarizePoint(point, collection, args.includeRaw),
        score: typeof point.score === 'number' ? Number(point.score.toFixed(3)) : null,
      });
    }
  }

  return {
    query: args.query,
    mode: args.mode,
    user: CORE.EXP_USER,
    collections,
    results: sortAndTrim(results, args.limit, args.minScore),
  };
}

function formatHuman(result) {
  if (result.mode === 'list-collections') {
    return result.collections.join('\n');
  }
  if (!Array.isArray(result.results) || result.results.length === 0) {
    return 'No matches found.';
  }
  return result.results.map((item, index) => {
    const label = `${index + 1}. [${item.collection}] ${item.id}`;
    const meta = [
      item.score != null ? `score=${item.score}` : null,
      item.tier != null ? `tier=T${item.tier}` : null,
      item.failureMode ? `failureMode=${item.failureMode}` : null,
      item.projectSlug ? `project=${item.projectSlug}` : null,
      item.createdFrom ? `createdFrom=${item.createdFrom}` : null,
    ].filter(Boolean).join(' | ');
    const text = item.principle || item.solution || item.trigger || '(no summary text)';
    return `${label}\n   ${meta}\n   ${text}`;
  }).join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runQuery(args);
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
  resolveCollections,
  parsePayload,
  buildTextHaystack,
  scoreTextMatch,
  sortAndTrim,
  summarizePoint,
  formatHuman,
};
