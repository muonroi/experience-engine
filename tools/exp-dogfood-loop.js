#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = require('../.experience/experience-core.js');

const DEFAULT_ITERATIONS = 4;
const SELFQA_COLLECTION = 'experience-selfqa';
const BEHAVIORAL_COLLECTION = 'experience-behavioral';
const PRINCIPLES_COLLECTION = 'experience-principles';

function parseArgs(argv) {
  const args = {
    homeDir: os.homedir(),
    serverBaseUrl: '',
    token: '',
    pointId: '',
    iterations: DEFAULT_ITERATIONS,
    evolveEach: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--home' && argv[i + 1]) args.homeDir = argv[++i];
    else if (arg === '--server' && argv[i + 1]) args.serverBaseUrl = argv[++i];
    else if (arg === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (arg === '--point-id' && argv[i + 1]) args.pointId = argv[++i];
    else if (arg === '--iterations' && argv[i + 1]) args.iterations = Math.max(1, Number(argv[++i]) || DEFAULT_ITERATIONS);
    else if (arg === '--no-evolve-each') args.evolveEach = false;
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

function loadConfig(homeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readCollectionPoints(collection, config) {
  const qdrantUrl = String(config.qdrantUrl || process.env.EXPERIENCE_QDRANT_URL || '').replace(/\/$/, '');
  const qdrantKey = config.qdrantKey || process.env.EXPERIENCE_QDRANT_KEY || '';
  if (!qdrantUrl) return [];
  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(qdrantKey ? { 'api-key': qdrantKey } : {}),
    },
    body: JSON.stringify({
      limit: 200,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          {
            should: [
              { key: 'user', match: { value: CORE.EXP_USER } },
              { is_empty: { key: 'user' } },
            ],
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`qdrant scroll ${collection} HTTP ${res.status}`);
  return (await res.json()).result?.points || [];
}

function parsePayload(point) {
  try {
    return JSON.parse(point?.payload?.json || '{}');
  } catch {
    return {};
  }
}

function pickDogfoodCandidate(points, pointId = '') {
  const candidates = points
    .map((point) => ({ point, data: parsePayload(point) }))
    .filter(({ point, data }) => {
      if (pointId && point.id !== pointId) return false;
      if (data.createdFrom !== 'session-extractor') return false;
      if (data.tier !== 2) return false;
      return CORE._assessExtractedQaQuality(data).ok;
    })
    .sort((a, b) => new Date(b.data.createdAt || 0).getTime() - new Date(a.data.createdAt || 0).getTime());
  return candidates[0] || null;
}

function extensionForScope(scope) {
  const lang = String(scope?.lang || '').toLowerCase();
  if (lang.includes('typescript')) return '.ts';
  if (lang.includes('javascript')) return '.js';
  if (lang.includes('python')) return '.py';
  if (lang.includes('c#')) return '.cs';
  if (lang.includes('shell')) return '.sh';
  return '.txt';
}

function buildDogfoodToolInput(candidate, iteration) {
  const ext = extensionForScope(candidate.scope);
  const filePath = `/home/${process.env.USER || 'phila'}/experience-engine/.experience/dogfood-${candidate.id.slice(0, 8)}-${iteration}${ext}`;
  return {
    file_path: filePath,
    new_string: [
      `// dogfood confirmation ${iteration}`,
      candidate.trigger,
      candidate.solution,
    ].join('\n'),
  };
}

async function postJson(baseUrl, requestPath, body, token) {
  const res = await fetch(`${baseUrl}${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${requestPath} HTTP ${res.status}`);
  return res.json();
}

async function locatePoint(config, pointId) {
  for (const collection of [SELFQA_COLLECTION, BEHAVIORAL_COLLECTION, PRINCIPLES_COLLECTION]) {
    const points = await readCollectionPoints(collection, config);
    const found = points.find((point) => point.id === pointId);
    if (found) return { collection, point: found, data: parsePayload(found) };
  }
  return null;
}

async function runDogfoodLoop(args = {}) {
  const config = loadConfig(args.homeDir);
  const serverBaseUrl = String(args.serverBaseUrl || config.serverBaseUrl || '').replace(/\/$/, '');
  const token = args.token || config.serverAuthToken || config.server?.authToken || '';
  if (!serverBaseUrl) throw new Error('serverBaseUrl is required');
  if (!token) throw new Error('server auth token is required');

  const seedPoints = await readCollectionPoints(SELFQA_COLLECTION, config);
  const picked = pickDogfoodCandidate(seedPoints, args.pointId);
  if (!picked) {
    throw new Error(args.pointId ? `no organic T2 candidate found for ${args.pointId}` : 'no organic T2 candidate available');
  }

  const candidate = picked.data;
  const results = [];
  for (let iteration = 1; iteration <= args.iterations; iteration++) {
    const sourceSession = `dogfood-loop:${picked.point.id}:${Date.now()}:${iteration}`;
    const toolInput = buildDogfoodToolInput(candidate, iteration);
    if (args.dryRun) {
      results.push({ iteration, sourceSession, toolInput, dryRun: true });
      continue;
    }

    const intercept = await postJson(serverBaseUrl, '/api/intercept', {
      toolName: 'Edit',
      toolInput,
      sourceKind: 'dogfood-loop',
      sourceRuntime: 'codex',
      sourceSession,
    }, token);
    const surfacedIds = Array.isArray(intercept.surfacedIds) ? intercept.surfacedIds : [];
    const surfacedTarget = surfacedIds.find((item) => item.id === picked.point.id);
    if (!surfacedTarget) {
      throw new Error(`candidate ${picked.point.id} did not surface on iteration ${iteration}`);
    }

    const posttool = await postJson(serverBaseUrl, '/api/posttool', {
      toolName: 'Edit',
      toolInput,
      toolOutput: { output: 'dogfood confirmation applied' },
      surfacedIds,
      sourceKind: 'dogfood-loop',
      sourceRuntime: 'codex',
      sourceSession,
    }, token);

    let evolve = null;
    if (args.evolveEach) {
      evolve = await postJson(serverBaseUrl, '/api/evolve', { trigger: 'dogfood-loop' }, token);
    }

    const current = await locatePoint(config, picked.point.id);
    results.push({
      iteration,
      sourceSession,
      surfacedCount: surfacedIds.length,
      reconcile: posttool.reconcile || null,
      evolve,
      currentCollection: current?.collection || null,
      currentTier: current?.data?.tier || null,
      validatedCount: current?.data?.validatedCount || 0,
      confidence: current?.data?.confidence || null,
    });
  }

  const finalState = await locatePoint(config, picked.point.id);
  return {
    pointId: picked.point.id,
    trigger: candidate.trigger,
    question: candidate.question,
    iterations: args.iterations,
    results,
    finalState: finalState ? {
      collection: finalState.collection,
      tier: finalState.data.tier,
      validatedCount: finalState.data.validatedCount || 0,
      confidence: finalState.data.confidence || null,
      principle: finalState.data.principle || null,
    } : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runDogfoodLoop(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  pickDogfoodCandidate,
  buildDogfoodToolInput,
  runDogfoodLoop,
};
