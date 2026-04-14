#!/usr/bin/env node
/**
 * test-server.js — Integration tests for Experience Engine REST API
 * Zero dependencies. Node.js 20+ native fetch only.
 *
 * Starts server on random port, hits all endpoints, validates responses.
 */

'use strict';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const { server } = require('../server');

server.listen(0, async () => {
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  console.log(`Test server running on port ${port}\n`);

  try {
    // 1. Server import
    assert(typeof server === 'object', 'server exports an object');

    // 2. Health endpoint
    console.log('\n--- GET /health ---');
    const healthRes = await fetch(`${base}/health`);
    const health = await healthRes.json();
    assert(healthRes.status === 200, 'health returns 200');
    assert('status' in health, 'health has status field');
    assert('qdrant' in health, 'health has qdrant field');
    assert('fileStore' in health, 'health has fileStore field');
    assert('uptime' in health, 'health has uptime field');

    // 3. Intercept endpoint
    console.log('\n--- POST /api/intercept ---');
    const interceptRes = await postJson(base, '/api/intercept', {
      toolName: 'Write',
      toolInput: { file_path: 'test.js' },
    });
    const interceptData = await interceptRes.json();
    assert(interceptRes.status === 200, 'intercept returns 200');
    assert('suggestions' in interceptData, 'intercept has suggestions field');
    assert('hasSuggestions' in interceptData, 'intercept has hasSuggestions field');
    assert('surfacedIds' in interceptData, 'intercept has surfacedIds field');
    assert('route' in interceptData, 'intercept has route field');

    // 4. Intercept validation — missing toolName
    console.log('\n--- POST /api/intercept (validation) ---');
    const interceptBadRes = await postJson(base, '/api/intercept', {});
    const interceptBadData = await interceptBadRes.json();
    assert(interceptBadRes.status === 400, 'intercept without toolName returns 400');
    assert('error' in interceptBadData, 'validation error has error field');

    // 4b. PostTool endpoint
    console.log('\n--- POST /api/posttool ---');
    const postToolRes = await postJson(base, '/api/posttool', {
      toolName: 'Edit',
      toolInput: { file_path: 'README.md' },
      toolOutput: { output: 'ok' },
      surfacedIds: [],
      sourceKind: 'test',
      sourceRuntime: 'codex-test',
      sourceSession: 'session-1',
    });
    const postToolData = await postToolRes.json();
    assert(postToolRes.status === 200, 'posttool returns 200');
    assert(postToolData.ok === true, 'posttool returns ok=true');
    assert('reconcile' in postToolData, 'posttool has reconcile field');
    assert('judgeQueued' in postToolData, 'posttool has judgeQueued field');

    // 5. Extract endpoint — short transcript (< 100 chars → stored = 0)
    console.log('\n--- POST /api/extract ---');
    const extractRes = await postJson(base, '/api/extract', {
      transcript: 'short session',
    });
    const extractData = await extractRes.json();
    assert(extractRes.status === 200, 'extract returns 200');
    assert(extractData.stored === 0, 'extract with short transcript stores 0');

    // 6. Extract validation — missing transcript
    console.log('\n--- POST /api/extract (validation) ---');
    const extractBadRes = await postJson(base, '/api/extract', {});
    const extractBadData = await extractBadRes.json();
    assert(extractBadRes.status === 400, 'extract without transcript returns 400');
    assert('error' in extractBadData, 'extract validation has error field');

    // 7. Evolve endpoint
    console.log('\n--- POST /api/evolve ---');
    const evolveRes = await postJson(base, '/api/evolve', {});
    const evolveData = await evolveRes.json();
    assert(evolveRes.status === 200, 'evolve returns 200');
    assert('promoted' in evolveData, 'evolve has promoted field');
    assert('demoted' in evolveData, 'evolve has demoted field');
    assert('abstracted' in evolveData, 'evolve has abstracted field');
    assert('archived' in evolveData, 'evolve has archived field');

    // 8. Stats endpoint
    console.log('\n--- GET /api/stats ---');
    const statsRes = await fetch(`${base}/api/stats`);
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

    // 8b. Gates endpoint
    console.log('\n--- GET /api/gates ---');
    const gatesRes = await fetch(`${base}/api/gates`);
    const gatesData = await gatesRes.json();
    assert(gatesRes.status === 200, 'gates returns 200');
    assert('gate1' in gatesData, 'gates has gate1');
    assert('gate2' in gatesData, 'gates has gate2');
    assert('gate3' in gatesData, 'gates has gate3');
    assert('overall' in gatesData, 'gates has overall');
    assert(Array.isArray(gatesData.gate1.checks), 'gates gate1 has checks');
    assert(typeof gatesData.overall.percent === 'number', 'gates overall has percent');

    // 9. Stats with since param
    console.log('\n--- GET /api/stats?since=30d ---');
    const stats30Res = await fetch(`${base}/api/stats?since=30d`);
    assert(stats30Res.status === 200, 'stats?since=30d returns 200');

    // 10. Stats all-time
    console.log('\n--- GET /api/stats?all=true ---');
    const statsAllRes = await fetch(`${base}/api/stats?all=true`);
    const statsAllData = await statsAllRes.json();
    assert(statsAllRes.status === 200, 'stats?all=true returns 200');
    assert(statsAllData.since === 'all', 'stats all-time has since=all');

    // 11. CORS headers
    console.log('\n--- CORS ---');
    assert(
      healthRes.headers.get('access-control-allow-origin') === '*',
      'CORS Access-Control-Allow-Origin: * present'
    );

    // 12. OPTIONS preflight
    console.log('\n--- OPTIONS /api/intercept ---');
    const optionsRes = await fetch(`${base}/api/intercept`, { method: 'OPTIONS' });
    assert(optionsRes.status === 204, 'OPTIONS returns 204');
    assert(
      optionsRes.headers.get('access-control-allow-methods')?.includes('POST'),
      'OPTIONS includes POST in Allow-Methods'
    );

    // 13. 404 handling
    console.log('\n--- GET /nonexistent ---');
    const notFoundRes = await fetch(`${base}/nonexistent`);
    const notFoundData = await notFoundRes.json();
    assert(notFoundRes.status === 404, '404 for unknown route');
    assert('error' in notFoundData, '404 has error field');

    // 14. Invalid JSON body
    console.log('\n--- POST /api/intercept (invalid JSON) ---');
    const badJsonRes = await fetch(`${base}/api/intercept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    assert(badJsonRes.status >= 400, 'invalid JSON returns error status');

    // 15. Graph endpoint — missing id
    console.log('\n--- GET /api/graph (no id) ---');
    const graphNoIdRes = await fetch(`${base}/api/graph`);
    const graphNoIdData = await graphNoIdRes.json();
    assert(graphNoIdRes.status === 400, 'graph without id returns 400');
    assert(graphNoIdData.error === 'id query parameter is required', 'graph error message correct');

    // 16. Graph endpoint — unknown id returns empty edges
    console.log('\n--- GET /api/graph?id=unknown ---');
    const graphUnknownRes = await fetch(`${base}/api/graph?id=00000000-0000-0000-0000-000000000000`);
    const graphUnknownData = await graphUnknownRes.json();
    assert(graphUnknownRes.status === 200, 'graph with unknown id returns 200');
    assert(Array.isArray(graphUnknownData.edges), 'graph returns edges array');
    assert(graphUnknownData.count === 0, 'graph returns 0 edges for unknown id');

    // 17. Graph endpoint — CORS headers
    console.log('\n--- GET /api/graph CORS ---');
    assert(graphUnknownRes.headers.get('access-control-allow-origin') === '*', 'graph has CORS');

    // 18. Timeline endpoint — missing topic
    console.log('\n--- GET /api/timeline (no topic) ---');
    const timelineNoTopicRes = await fetch(`${base}/api/timeline`);
    assert(timelineNoTopicRes.status === 400, 'timeline without topic returns 400');

    // 19. Timeline endpoint — with topic (may return 503 if no embed provider, or 200)
    console.log('\n--- GET /api/timeline?topic=test ---');
    const timelineRes = await fetch(`${base}/api/timeline?topic=test`);
    assert(timelineRes.status === 200 || timelineRes.status === 503, 'timeline returns 200 or 503');
    if (timelineRes.status === 200) {
      const timelineData = await timelineRes.json();
      assert(Array.isArray(timelineData.timeline), 'timeline returns timeline array');
      assert('count' in timelineData, 'timeline has count field');
    }

    // 20. Timeline CORS
    assert(timelineNoTopicRes.headers.get('access-control-allow-origin') === '*', 'timeline has CORS');

    // 21. User endpoint
    console.log('\n--- GET /api/user ---');
    const userRes = await fetch(`${base}/api/user`);
    const userData = await userRes.json();
    assert(userRes.status === 200, 'user returns 200');
    assert(typeof userData.user === 'string', 'user has user field');

    // 22. Share validation — missing principleId
    console.log('\n--- POST /api/principles/share (no id) ---');
    const shareNoIdRes = await postJson(base, '/api/principles/share', {});
    assert(shareNoIdRes.status === 400, 'share without principleId returns 400');

    // 23. Share with unknown id → 404
    console.log('\n--- POST /api/principles/share (unknown) ---');
    const shareUnknownRes = await postJson(base, '/api/principles/share', { principleId: '00000000-0000-0000-0000-000000000000' });
    assert(shareUnknownRes.status === 404, 'share with unknown id returns 404');

    // 24. Import validation — missing fields
    console.log('\n--- POST /api/principles/import (empty) ---');
    const importEmptyRes = await postJson(base, '/api/principles/import', {});
    assert(importEmptyRes.status === 400, 'import without principle returns 400');

    // 25. Feedback validation — missing verdict/followed
    console.log('\n--- POST /api/feedback (missing verdict) ---');
    const feedbackMissingVerdictRes = await postJson(base, '/api/feedback', {
      pointId: '00000000-0000-0000-0000-000000000000',
      collection: 'experience-behavioral',
    });
    assert(feedbackMissingVerdictRes.status === 400, 'feedback without verdict returns 400');

    // 26. Feedback validation — invalid verdict
    console.log('\n--- POST /api/feedback (invalid verdict) ---');
    const feedbackBadVerdictRes = await postJson(base, '/api/feedback', {
      pointId: '00000000-0000-0000-0000-000000000000',
      collection: 'experience-behavioral',
      verdict: 'MAYBE',
    });
    assert(feedbackBadVerdictRes.status === 400, 'feedback with invalid verdict returns 400');

    // 27. Feedback validation — IRRELEVANT requires reason
    console.log('\n--- POST /api/feedback (irrelevant without reason) ---');
    const feedbackIrrelevantNoReasonRes = await postJson(base, '/api/feedback', {
      pointId: '00000000-0000-0000-0000-000000000000',
      collection: 'experience-behavioral',
      verdict: 'IRRELEVANT',
    });
    assert(feedbackIrrelevantNoReasonRes.status === 400, 'irrelevant feedback without reason returns 400');

    // 28. Feedback verdict accepts full UUID path
    console.log('\n--- POST /api/feedback (verdict contract) ---');
    const feedbackVerdictRes = await postJson(base, '/api/feedback', {
      pointId: '00000000-0000-0000-0000-000000000000',
      collection: 'experience-behavioral',
      verdict: 'IGNORED',
    });
    const feedbackVerdictData = await feedbackVerdictRes.json();
    assert(feedbackVerdictRes.status === 200, 'feedback with verdict returns 200');
    assert(feedbackVerdictData.verdict === 'IGNORED', 'feedback echoes verdict');

  } finally {
    server.close();
    console.log(`\n${'='.repeat(40)}`);
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
});
