#!/usr/bin/env node
/**
 * test-server.js — Integration tests for Experience Engine REST API
 * Zero dependencies. Node.js 20+ native fetch only.
 *
 * Starts the real server on a random port and hits all endpoints. By default it
 * creates a disposable ~/.experience harness so CI does not depend on a real
 * local install, Qdrant instance, or provider credentials.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function loadConfig(homeDir = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function startFakeQdrant() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const collections = ['experience-selfqa', 'experience-behavioral', 'experience-principles'];
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'GET' && url.pathname === '/collections') {
      return send(200, {
        result: {
          collections: collections.map((name) => ({ name })),
        },
      });
    }

    const collectionMatch = url.pathname.match(/^\/collections\/([^/]+)$/);
    if (req.method === 'GET' && collectionMatch) {
      return send(200, { result: { points_count: 0 } });
    }

    const scrollMatch = url.pathname.match(/^\/collections\/([^/]+)\/points\/scroll$/);
    if (req.method === 'POST' && scrollMatch) {
      return send(200, { result: { points: [] } });
    }

    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function ensureHarnessHome() {
  if (process.env.EXPERIENCE_TEST_USE_HOME === '1') {
    return { homeDir: os.homedir(), cleanup: async () => {} };
  }

  const fakeQdrant = await startFakeQdrant();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-server-'));
  const expDir = path.join(homeDir, '.experience');
  fs.mkdirSync(path.join(expDir, 'store'), { recursive: true });
  fs.mkdirSync(path.join(expDir, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(expDir, 'activity.jsonl'), '');
  fs.writeFileSync(
    path.join(expDir, 'config.json'),
    JSON.stringify(
      {
        qdrantUrl: `http://127.0.0.1:${fakeQdrant.port}`,
        qdrantKey: '',
        version: 'test-harness',
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(expDir, 'experience-core.js'),
    [
      "'use strict';",
      'module.exports = {',
      '  async getEmbeddingRaw() { return [0.1, 0.2, 0.3]; },',
      "  async _callBrainWithFallback() { return { test: 'ok' }; },",
      '  _assessExtractedQaQuality() { return { ok: true }; },',
      '};',
      '',
    ].join('\n')
  );

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  return {
    homeDir,
    cleanup: async () => {
      await new Promise((resolve) => fakeQdrant.server.close(resolve));
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

async function postJson(base, requestPath, body, authToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function getJson(base, requestPath, token = '') {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return fetch(`${base}${requestPath}`, { headers });
}

(async () => {
  const harness = await ensureHarnessHome();
  const CONFIG = loadConfig(harness.homeDir);
  const AUTH_TOKEN = CONFIG.server?.authToken || CONFIG.serverAuthToken || '';
  const READ_AUTH_TOKEN = CONFIG.server?.readAuthToken || CONFIG.serverReadAuthToken || '';
  const { server } = require('../server');

  server.listen(0, async () => {
    const port = server.address().port;
    const base = `http://localhost:${port}`;
    console.log(`Test server running on port ${port}\n`);

    try {
      assert(typeof server === 'object', 'server exports an object');

      console.log('\n--- GET /health ---');
      const healthRes = await fetch(`${base}/health`);
      const health = await healthRes.json();
      assert(healthRes.status === 200, 'health returns 200');
      assert('status' in health, 'health has status field');
      assert('qdrant' in health, 'health has qdrant field');
      assert('fileStore' in health, 'health has fileStore field');
      assert('uptime' in health, 'health has uptime field');

      console.log('\n--- POST /api/intercept ---');
      const interceptRes = await postJson(base, '/api/intercept', {
        toolName: 'Write',
        toolInput: { file_path: 'test.js' },
      }, AUTH_TOKEN);
      const interceptData = await interceptRes.json();
      assert(interceptRes.status === 200, 'intercept returns 200');
      assert('suggestions' in interceptData, 'intercept has suggestions field');
      assert('hasSuggestions' in interceptData, 'intercept has hasSuggestions field');
      assert('surfacedIds' in interceptData, 'intercept has surfacedIds field');
      assert('route' in interceptData, 'intercept has route field');

      console.log('\n--- POST /api/intercept (validation) ---');
      const interceptBadRes = await postJson(base, '/api/intercept', {}, AUTH_TOKEN);
      const interceptBadData = await interceptBadRes.json();
      assert(interceptBadRes.status === 400, 'intercept without toolName returns 400');
      assert('error' in interceptBadData, 'validation error has error field');

      console.log('\n--- POST /api/posttool ---');
      const postToolRes = await postJson(base, '/api/posttool', {
        toolName: 'Edit',
        toolInput: { file_path: 'README.md' },
        toolOutput: { output: 'ok' },
        surfacedIds: [],
        sourceKind: 'test',
        sourceRuntime: 'codex-test',
        sourceSession: 'session-1',
      }, AUTH_TOKEN);
      const postToolData = await postToolRes.json();
      assert(postToolRes.status === 200, 'posttool returns 200');
      assert(postToolData.ok === true, 'posttool returns ok=true');
      assert('reconcile' in postToolData, 'posttool has reconcile field');
      assert('judgeQueued' in postToolData, 'posttool has judgeQueued field');

      console.log('\n--- POST /api/extract ---');
      const extractRes = await postJson(base, '/api/extract', {
        transcript: 'short session',
      }, AUTH_TOKEN);
      const extractData = await extractRes.json();
      assert(extractRes.status === 200, 'extract returns 200');
      assert(extractData.stored === 0, 'extract with short transcript stores 0');

      console.log('\n--- POST /api/extract (validation) ---');
      const extractBadRes = await postJson(base, '/api/extract', {}, AUTH_TOKEN);
      const extractBadData = await extractBadRes.json();
      assert(extractBadRes.status === 400, 'extract without transcript returns 400');
      assert('error' in extractBadData, 'extract validation has error field');

      console.log('\n--- POST /api/evolve ---');
      const evolveRes = await postJson(base, '/api/evolve', {}, AUTH_TOKEN);
      const evolveData = await evolveRes.json();
      assert(evolveRes.status === 200, 'evolve returns 200');
      assert('promoted' in evolveData, 'evolve has promoted field');
      assert('demoted' in evolveData, 'evolve has demoted field');
      assert('abstracted' in evolveData, 'evolve has abstracted field');
      assert('archived' in evolveData, 'evolve has archived field');

      console.log('\n--- GET /api/stats ---');
      const statsRes = await getJson(base, '/api/stats', READ_AUTH_TOKEN || AUTH_TOKEN);
      const statsData = await statsRes.json();
      assert(statsRes.status === 200, 'stats returns 200');
      assert('totalIntercepts' in statsData, 'stats has totalIntercepts');
      assert('suggestions' in statsData, 'stats has suggestions');
      assert('top5' in statsData, 'stats has top5');
      assert('feedbackCount' in statsData, 'stats has feedbackCount');
      assert('feedbackByVerdict' in statsData, 'stats has feedbackByVerdict');
      assert('noiseByReason' in statsData, 'stats has noiseByReason');
      assert('implicitUnusedCount' in statsData, 'stats has implicitUnusedCount');
      assert('implicitUnusedByReason' in statsData, 'stats has implicitUnusedByReason');

      console.log('\n--- GET /api/gates ---');
      const gatesRes = await getJson(base, '/api/gates', READ_AUTH_TOKEN || AUTH_TOKEN);
      const gatesData = await gatesRes.json();
      assert(gatesRes.status === 200, 'gates returns 200');
      assert('gate1' in gatesData, 'gates has gate1');
      assert('gate2' in gatesData, 'gates has gate2');
      assert('gate3' in gatesData, 'gates has gate3');
      assert('overall' in gatesData, 'gates has overall');
      assert(Array.isArray(gatesData.gate1.checks), 'gates gate1 has checks');
      assert(typeof gatesData.overall.percent === 'number', 'gates overall has percent');

      console.log('\n--- GET /api/stats?since=30d ---');
      const stats30Res = await getJson(base, '/api/stats?since=30d', READ_AUTH_TOKEN || AUTH_TOKEN);
      assert(stats30Res.status === 200, 'stats?since=30d returns 200');

      console.log('\n--- GET /api/stats?all=true ---');
      const statsAllRes = await getJson(base, '/api/stats?all=true', READ_AUTH_TOKEN || AUTH_TOKEN);
      const statsAllData = await statsAllRes.json();
      assert(statsAllRes.status === 200, 'stats?all=true returns 200');
      assert(statsAllData.since === 'all', 'stats all-time has since=all');

      console.log('\n--- CORS ---');
      assert(
        healthRes.headers.get('access-control-allow-origin') === '*',
        'CORS Access-Control-Allow-Origin: * present'
      );

      console.log('\n--- OPTIONS /api/intercept ---');
      const optionsRes = await fetch(`${base}/api/intercept`, { method: 'OPTIONS' });
      assert(optionsRes.status === 204, 'OPTIONS returns 204');
      assert(
        optionsRes.headers.get('access-control-allow-methods')?.includes('POST'),
        'OPTIONS includes POST in Allow-Methods'
      );

      console.log('\n--- GET /nonexistent ---');
      const notFoundRes = await fetch(`${base}/nonexistent`);
      const notFoundData = await notFoundRes.json();
      assert(notFoundRes.status === 404, '404 for unknown route');
      assert('error' in notFoundData, '404 has error field');

      console.log('\n--- POST /api/intercept (invalid JSON) ---');
      const badJsonRes = await fetch(`${base}/api/intercept`, {
        method: 'POST',
        headers: AUTH_TOKEN
          ? { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` }
          : { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      });
      assert(badJsonRes.status >= 400, 'invalid JSON returns error status');

      console.log('\n--- GET /api/graph (no id) ---');
      const graphNoIdRes = await getJson(base, '/api/graph', AUTH_TOKEN);
      const graphNoIdData = await graphNoIdRes.json();
      assert(graphNoIdRes.status === 400, 'graph without id returns 400');
      assert(graphNoIdData.error === 'id query parameter is required', 'graph error message correct');

      console.log('\n--- GET /api/graph?id=unknown ---');
      const graphUnknownRes = await getJson(base, '/api/graph?id=00000000-0000-0000-0000-000000000000', AUTH_TOKEN);
      const graphUnknownData = await graphUnknownRes.json();
      assert(graphUnknownRes.status === 200, 'graph with unknown id returns 200');
      assert(Array.isArray(graphUnknownData.edges), 'graph returns edges array');
      assert(graphUnknownData.count === 0, 'graph returns 0 edges for unknown id');

      console.log('\n--- GET /api/graph CORS ---');
      assert(graphUnknownRes.headers.get('access-control-allow-origin') === '*', 'graph has CORS');

      console.log('\n--- GET /api/timeline (no topic) ---');
      const timelineNoTopicRes = await getJson(base, '/api/timeline', AUTH_TOKEN);
      assert(timelineNoTopicRes.status === 400, 'timeline without topic returns 400');

      console.log('\n--- GET /api/timeline?topic=test ---');
      const timelineRes = await getJson(base, '/api/timeline?topic=test', AUTH_TOKEN);
      assert(timelineRes.status === 200 || timelineRes.status === 503, 'timeline returns 200 or 503');
      if (timelineRes.status === 200) {
        const timelineData = await timelineRes.json();
        assert(Array.isArray(timelineData.timeline), 'timeline returns timeline array');
        assert('count' in timelineData, 'timeline has count field');
      }

      assert(timelineNoTopicRes.headers.get('access-control-allow-origin') === '*', 'timeline has CORS');

      console.log('\n--- GET /api/user ---');
      const userRes = await getJson(base, '/api/user', AUTH_TOKEN);
      const userData = await userRes.json();
      assert(userRes.status === 200, 'user returns 200');
      assert(typeof userData.user === 'string', 'user has user field');

      console.log('\n--- POST /api/principles/share (no id) ---');
      const shareNoIdRes = await postJson(base, '/api/principles/share', {}, AUTH_TOKEN);
      assert(shareNoIdRes.status === 400, 'share without principleId returns 400');

      console.log('\n--- POST /api/principles/share (unknown) ---');
      const shareUnknownRes = await postJson(base, '/api/principles/share', { principleId: '00000000-0000-0000-0000-000000000000' }, AUTH_TOKEN);
      assert(shareUnknownRes.status === 404, 'share with unknown id returns 404');

      console.log('\n--- POST /api/principles/import (empty) ---');
      const importEmptyRes = await postJson(base, '/api/principles/import', {}, AUTH_TOKEN);
      assert(importEmptyRes.status === 400, 'import without principle returns 400');

      console.log('\n--- POST /api/feedback (missing verdict) ---');
      const feedbackMissingVerdictRes = await postJson(base, '/api/feedback', {
        pointId: '00000000-0000-0000-0000-000000000000',
        collection: 'experience-behavioral',
      }, AUTH_TOKEN);
      assert(feedbackMissingVerdictRes.status === 400, 'feedback without verdict returns 400');

      console.log('\n--- POST /api/feedback (invalid verdict) ---');
      const feedbackBadVerdictRes = await postJson(base, '/api/feedback', {
        pointId: '00000000-0000-0000-0000-000000000000',
        collection: 'experience-behavioral',
        verdict: 'MAYBE',
      }, AUTH_TOKEN);
      assert(feedbackBadVerdictRes.status === 400, 'feedback with invalid verdict returns 400');

      console.log('\n--- POST /api/feedback (irrelevant without reason) ---');
      const feedbackIrrelevantNoReasonRes = await postJson(base, '/api/feedback', {
        pointId: '00000000-0000-0000-0000-000000000000',
        collection: 'experience-behavioral',
        verdict: 'IRRELEVANT',
      }, AUTH_TOKEN);
      assert(feedbackIrrelevantNoReasonRes.status === 400, 'irrelevant feedback without reason returns 400');

      console.log('\n--- POST /api/feedback (verdict contract) ---');
      const feedbackVerdictRes = await postJson(base, '/api/feedback', {
        pointId: '00000000-0000-0000-0000-000000000000',
        collection: 'experience-behavioral',
        verdict: 'IGNORED',
      }, AUTH_TOKEN);
      const feedbackVerdictData = await feedbackVerdictRes.json();
      assert(feedbackVerdictRes.status === 200, 'feedback with verdict returns 200');
      assert(feedbackVerdictData.verdict === 'IGNORED', 'feedback echoes verdict');

      console.log('\n--- /v1/ API versioning ---');
      const v1HealthRes = await fetch(`${base}/v1/health`);
      assert(v1HealthRes.status === 200, '/v1/health returns 200');
      const v1Health = await v1HealthRes.json();
      assert('status' in v1Health, '/v1/health has status field');

      const v1InterceptRes = await postJson(base, '/v1/api/intercept', {
        toolName: 'Write',
        toolInput: { file_path: 'test.js' },
      }, AUTH_TOKEN);
      assert(v1InterceptRes.status === 200, '/v1/api/intercept returns 200');
    } finally {
      server.close(async () => {
        await harness.cleanup();
        console.log(`\n${'='.repeat(40)}`);
        console.log(`${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
      });
    }
  });
})().catch(async (error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
