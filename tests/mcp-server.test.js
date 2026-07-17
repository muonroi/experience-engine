#!/usr/bin/env node
'use strict';

/**
 * mcp-server.test.js — the ee_* MCP server (protocol + tools + wiring).
 *
 * The MCP surface used to live in muonroi-cli, which meant the brain was only
 * reachable from one CLI. It lives here now so any MCP client can install the
 * engine and get the same four tools; muonroi-cli keeps calling the brain
 * natively (no MCP hop, no SDK).
 *
 * @modelcontextprotocol/sdk is NOT used: this package is zero-runtime-dependency
 * by policy, and a tools-only stdio server owes a client three methods. The cost
 * of owning them is these tests — most of what follows pins protocol rules the
 * SDK would otherwise have enforced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const MCP_DIR = path.join(__dirname, '..', 'mcp');
const { handleMessage, negotiateProtocol, serve, LATEST_PROTOCOL_VERSION } = require(path.join(MCP_DIR, 'server.js'));
const { buildTools, callTool, describeTools } = require(path.join(MCP_DIR, 'tools.js'));
const { validate } = require(path.join(MCP_DIR, 'validate.js'));
const { createRecallLedger } = require(path.join(MCP_DIR, 'ledger.js'));

// ─────────────────────────── validate (the zod stand-in) ───────────────────────

test('validate: enforces type, bounds and enum; absent optional is fine', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 10 },
      maxChars: { type: 'integer', minimum: 500, maximum: 20000 },
      verdict: { type: 'string', enum: ['followed', 'ignored'] },
    },
    required: ['query'],
  };

  assert.equal(validate(schema, { query: 'hi' }).ok, true);
  assert.equal(validate(schema, {}).error, 'query is required');
  assert.equal(validate(schema, { query: 42 }).error, 'query must be a string');
  assert.equal(validate(schema, { query: '' }).error, 'query must be at least 1 characters');
  assert.equal(validate(schema, { query: 'x'.repeat(11) }).error, 'query must be at most 10 characters');
  assert.equal(validate(schema, { query: 'a', maxChars: 100 }).error, 'maxChars must be >= 500');
  assert.equal(validate(schema, { query: 'a', maxChars: 1.5 }).error, 'maxChars must be an integer');
  assert.equal(validate(schema, { query: 'a', verdict: 'nope' }).error, 'verdict must be one of: followed | ignored');
});

test('validate: null/undefined optionals are treated as absent, not as bad input', () => {
  // MCP clients serialise "no value" both ways; rejecting either would fail valid calls.
  const schema = { type: 'object', properties: { q: { type: 'string' }, p: { type: 'string' } }, required: ['q'] };
  const r = validate(schema, { q: 'x', p: null });
  assert.equal(r.ok, true);
  assert.equal('p' in r.value, false, 'a null optional must be dropped, not passed through as null');
});

test('validate: a required key sent as null is still missing', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  assert.equal(validate(schema, { q: null }).error, 'q is required');
});

// ────────────────────────────── protocol rules ─────────────────────────────────

function ctxWith(deps = {}) {
  return { tools: buildTools(deps), callTool, describeTools, version: '9.9.9' };
}

test('initialize: echoes a supported protocol version, advertises tools', async () => {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    ctxWith(),
  );
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2024-11-05', 'must speak the version the client asked for when supported');
  assert.deepEqual(res.result.capabilities.tools, { listChanged: false });
  assert.equal(res.result.serverInfo.name, 'experience-engine');
  assert.equal(res.result.serverInfo.version, '9.9.9');
});

test('initialize: falls back to our latest for an unknown protocol version', async () => {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ctxWith(),
  );
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocol(undefined), LATEST_PROTOCOL_VERSION, 'a missing version must not crash');
});

test('a notification gets NO response (replying to one is a protocol violation)', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctxWith());
  assert.equal(res, null);
});

test('id 0 is a real id, not an absent one', async () => {
  // `if (!id)` would misread 0 as a notification and silently answer nothing.
  const res = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'ping' }, ctxWith());
  assert.ok(res, 'id 0 must be answered');
  assert.equal(res.id, 0);
  assert.deepEqual(res.result, {});
});

test('unknown method → JSON-RPC method-not-found', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, ctxWith());
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /resources\/list/);
});

test('tools/list: exposes exactly the four ee_* tools, each with a schema', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctxWith());
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['ee_feedback', 'ee_health', 'ee_query', 'ee_write']);
  for (const t of res.result.tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a description an agent can act on`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal('handler' in t, false, 'the handler must never go on the wire');
  }
});

test('a throwing tool becomes an isError RESULT, not a JSON-RPC error', async () => {
  // A failing tool is something the model should read and react to; a JSON-RPC
  // error means "the call itself failed" and never reaches the model as content.
  const api = { recall: async () => { throw new Error('brain exploded'); }, formatRecallForAgent: () => '' };
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ee_query', arguments: { query: 'x' } } },
    ctxWith({ api, ledger: createRecallLedger() }),
  );
  assert.equal(res.error, undefined, 'must not be a JSON-RPC error');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /ee_unavailable/);
  assert.match(res.result.content[0].text, /brain exploded/);
});

test('tools/call with bad arguments is rejected before the brain is called', async () => {
  let called = false;
  const api = { recall: async () => { called = true; return null; }, formatRecallForAgent: () => '' };
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ee_query', arguments: {} } },
    ctxWith({ api, ledger: createRecallLedger() }),
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /invalid_arguments/);
  assert.equal(called, false, 'a malformed call must not spend a brain call');
});

test('tools/call for an unknown tool reports it as a tool error', async () => {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ee_nope', arguments: {} } },
    ctxWith(),
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unknown_tool/);
});

// ───────────────────────────── tool behaviour ──────────────────────────────────

const RECALL_RESP = {
  text: 'do the thing [id:aaaaaaaa col:experience-behavioral]',
  entries: [{ id: 'aaaaaaaa', collection: 'experience-behavioral' }],
  count: 1,
  query: 'q',
};

function apiStub(over = {}) {
  const realFormat = require(path.join(MCP_DIR, 'ee-api.js')).formatRecallForAgent;
  return {
    recall: async () => RECALL_RESP,
    health: async () => ({ ok: true, status: 200 }),
    feedback: async () => ({ ok: true, resolvedId: 'aaaaaaaa', verdict: 'FOLLOWED' }),
    write: async () => ({ ok: true, id: 'new-id' }),
    formatRecallForAgent: realFormat,
    ...over,
  };
}

async function call(name, args, deps) {
  return callTool(buildTools(deps), name, args);
}

test('ee_query: returns the [id col] index and records the entries as unrated debt', async () => {
  const ledger = createRecallLedger();
  const out = await call('ee_query', { query: 'how do I restart' }, { api: apiStub(), ledger, env: {} });
  assert.equal(out.isError, undefined);
  assert.match(out.content[0].text, /\[id:aaaaaaaa col:experience-behavioral\]/);
  assert.match(out.content[0].text, /\[recall: 1 entries for "how do I restart"\]/);
  assert.equal(ledger.pendingCount(), 1, 'a recall must create feedback debt');
});

// A recall routinely renders ~30k chars while maxChars defaults to 6000, so most
// of what the brain returns never reaches the agent. Debt for an entry whose
// handle was truncated away is debt the agent cannot possibly settle: it never
// saw the `[id col]`. Under gate=hard that unsettleable debt refuses the NEXT
// recall outright. Only what was rendered may be charged.
const TRUNCATING_RESP = {
  text: [
    `first ${'x'.repeat(300)}\n   [id:aaaaaaaa col:experience-behavioral]`,
    `second ${'y'.repeat(300)}\n   [id:bbbbbbbb col:experience-behavioral]`,
    `third ${'z'.repeat(300)}\n   [id:cccccccc col:experience-behavioral]`,
  ].join('\n'),
  // Real entries carry the full UUID; format.js renders only an 8-char prefix.
  entries: [
    { id: 'aaaaaaaa-1111-4111-8111-111111111111', collection: 'experience-behavioral' },
    { id: 'bbbbbbbb-2222-4222-8222-222222222222', collection: 'experience-behavioral' },
    { id: 'cccccccc-3333-4333-8333-333333333333', collection: 'experience-behavioral' },
  ],
  count: 3,
  query: 'q',
};

test('ee_query: charges feedback debt ONLY for entries whose handle survived truncation', async () => {
  const ledger = createRecallLedger();
  const out = await call(
    'ee_query',
    { query: 'q', maxChars: 500 },
    { api: apiStub({ recall: async () => TRUNCATING_RESP }), ledger, env: {} },
  );

  assert.match(out.content[0].text, /\[id:aaaaaaaa col:experience-behavioral\]/);
  assert.doesNotMatch(out.content[0].text, /\[id:cccccccc/, 'precondition: the tail must be truncated away');
  assert.equal(ledger.pendingCount(), 1, 'only the rendered entry may become debt');
  assert.equal(ledger.pending()[0].id, 'aaaaaaaa-1111-4111-8111-111111111111', 'debt keeps the full id');
});

test('ee_query: an index with no surviving handle charges no debt at all', async () => {
  const ledger = createRecallLedger();
  await call(
    'ee_query',
    { query: 'q', maxChars: 500 },
    {
      api: apiStub({ recall: async () => ({ ...TRUNCATING_RESP, text: 'body with no handle at all' }) }),
      ledger,
      env: {},
    },
  );
  assert.equal(ledger.pendingCount(), 0);
});

test('ee_query: a null response is ee_unavailable, not an empty index', async () => {
  const out = await call('ee_query', { query: 'q' }, { api: apiStub({ recall: async () => null }), ledger: createRecallLedger(), env: {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /ee_unavailable/);
});

test('ee_query: soft gate surfaces prior unrated debt alongside the new index', async () => {
  const ledger = createRecallLedger();
  ledger.record([{ id: 'old-1', collection: 'experience-selfqa' }], 'earlier question');
  const out = await call('ee_query', { query: 'next' }, { api: apiStub(), ledger, env: {} });
  assert.equal(out.isError, undefined, 'soft mode must never block the recall');
  assert.match(out.content[0].text, /still unrated/);
  assert.match(out.content[0].text, /old-1 experience-selfqa/);
  assert.match(out.content[0].text, /\[id:aaaaaaaa/, 'the new index must still be delivered');
});

test('ee_query: hard gate refuses at the threshold WITHOUT spending a brain call', async () => {
  const ledger = createRecallLedger();
  ledger.record([{ id: 'a', collection: 'c' }, { id: 'b', collection: 'c' }], 'q');
  let recalls = 0;
  const api = apiStub({ recall: async () => { recalls++; return RECALL_RESP; } });
  const env = { EXPERIENCE_RECALL_FEEDBACK_GATE: 'hard', EXPERIENCE_RECALL_FEEDBACK_THRESHOLD: '2' };

  const out = await call('ee_query', { query: 'q' }, { api, ledger, env });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /feedback_required/);
  assert.equal(recalls, 0, 'a refused recall must not cost a brain call');
});

test('ee_query: gate=off records no debt and surfaces no nag', async () => {
  const ledger = createRecallLedger();
  ledger.record([{ id: 'old-1', collection: 'c' }], 'earlier');
  const out = await call('ee_query', { query: 'q' }, { api: apiStub(), ledger, env: { EXPERIENCE_RECALL_FEEDBACK_GATE: 'off' } });
  assert.doesNotMatch(out.content[0].text, /still unrated/);
  assert.equal(ledger.pendingCount(), 1, 'gate=off must not record new debt');
});

test('ee_feedback: clears the debt and reports what remains', async () => {
  const ledger = createRecallLedger();
  ledger.record([{ id: 'aaaaaaaa', collection: 'x' }, { id: 'bbbbbbbb', collection: 'x' }], 'q');
  const out = await call('ee_feedback', { id: 'aaaaaaaa', collection: 'x', verdict: 'followed' }, { api: apiStub(), ledger, env: {} });
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.pendingRemaining, 1);
  assert.equal(ledger.isPending('aaaaaaaa'), false);
});

test('ee_feedback: a short id prefix still settles the debt it was recalled under', async () => {
  // The server resolves a prefix to a full id, so clearing must use BOTH the
  // resolved id and the (short) id the agent actually passed.
  const ledger = createRecallLedger();
  ledger.record([{ id: 'aaaa', collection: 'x' }], 'q');
  const api = apiStub({ feedback: async () => ({ ok: true, resolvedId: 'aaaa-full-uuid', verdict: 'FOLLOWED' }) });
  await call('ee_feedback', { id: 'aaaa', collection: 'x', verdict: 'followed' }, { api, ledger, env: {} });
  assert.equal(ledger.pendingCount(), 0, 'the prefix the agent used must be cleared too');
});

test('ee_feedback: noise without a reason is refused (the reason IS the signal)', async () => {
  // wrong_repo/wrong_language narrow an entry's scope and PRESERVE it; wrong_task
  // deletes it. An unlabelled noise verdict would throw that distinction away.
  let called = false;
  const api = apiStub({ feedback: async () => { called = true; return { ok: true }; } });
  const out = await call('ee_feedback', { id: 'a', collection: 'x', verdict: 'noise' }, { api, ledger: createRecallLedger(), env: {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /reason_required/);
  assert.equal(called, false);
});

test('ee_feedback: an unknown noise reason is rejected by the schema', async () => {
  const out = await call('ee_feedback', { id: 'a', collection: 'x', verdict: 'noise', reason: 'because' }, { api: apiStub(), ledger: createRecallLedger(), env: {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /invalid_arguments/);
});

test('ee_feedback: a failed POST leaves the debt in place', async () => {
  const ledger = createRecallLedger();
  ledger.record([{ id: 'aaaaaaaa', collection: 'x' }], 'q');
  const api = apiStub({ feedback: async () => ({ ok: false, error: 'HTTP 500' }) });
  const out = await call('ee_feedback', { id: 'aaaaaaaa', collection: 'x', verdict: 'followed' }, { api, ledger, env: {} });
  assert.equal(out.isError, true);
  assert.equal(ledger.pendingCount(), 1, 'an unsent verdict must stay owed');
});

test('ee_write: defaults to experience-behavioral and reports recallability', async () => {
  let seen = null;
  const api = apiStub({ write: async (lesson, opts) => { seen = { lesson, opts }; return { ok: true, id: 'w1' }; } });
  const out = await call('ee_write', { lesson: 'Always read a file before editing it.' }, { api, ledger: createRecallLedger(), env: {} });
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.collection, 'experience-behavioral');
  assert.equal(seen.opts.collection, 'experience-behavioral');
  assert.equal(seen.opts.confidence, 0.65);
});

test('ee_write: a too-short lesson is rejected (one word is not a lesson)', async () => {
  const out = await call('ee_write', { lesson: 'oops' }, { api: apiStub(), ledger: createRecallLedger(), env: {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /invalid_arguments/);
});

test('ee_write: an over-long lesson is truncated, not rejected', async () => {
  let seen = '';
  const api = apiStub({ write: async (lesson) => { seen = lesson; return { ok: true, id: 'w1' }; } });
  await call('ee_write', { lesson: 'x'.repeat(3000) }, { api, ledger: createRecallLedger(), env: {} });
  assert.equal(seen.length, 1500);
  assert.ok(seen.endsWith('...'));
});

test('ee_health: passes the probe through verbatim', async () => {
  const out = await call('ee_health', {}, { api: apiStub({ health: async () => ({ ok: false, status: 0, error: 'TimeoutError: x' }) }), ledger: createRecallLedger(), env: {} });
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.status, 0);
  assert.match(body.error, /TimeoutError/, 'status:0 alone is not diagnosable — the cause must survive');
});

// ────────────────────────── stdio transport (in-process) ───────────────────────

test('serve: reads newline-delimited JSON, answers requests, stays silent on notifications', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString('utf8')));

  const done = serve(ctxWith({ api: apiStub(), ledger: createRecallLedger(), env: {} }), input, output);

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write('\n'); // blank lines are noise, not a parse error
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  input.end();
  await done;

  const lines = chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'exactly two requests → exactly two responses');
  assert.deepEqual(lines.map((l) => l.id), [1, 2]);
});

test('serve: malformed JSON gets a parse error and does NOT kill the loop', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString('utf8')));

  const done = serve(ctxWith(), input, output);
  input.write('{not json\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\n`);
  input.end();
  await done;

  const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].id, 9, 'the server must survive garbage and answer the next request');
});

// ─────────────────── end-to-end: the real binary, driven as a client ───────────

test('exp-mcp binary: a real client handshake reaches the real brain API', async () => {
  // Everything real except the brain: the actual bin/exp-mcp.js process, spawned
  // and driven over stdio exactly as an MCP client would, against a stub EE
  // server. This is the only test that proves the wiring (bin → server → tools →
  // ee-api → exp-recall.js config resolution) holds end to end.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-mcp-e2e-'));
  fs.mkdirSync(path.join(home, '.experience'), { recursive: true });

  const brain = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/api/recall') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          text: 'prefer X over Y [id:deadbeef col:experience-behavioral]',
          entries: [{ id: 'deadbeef', collection: 'experience-behavioral' }],
          count: 1,
          query: 'q',
        }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => brain.listen(0, '127.0.0.1', r));
  const brainPort = brain.address().port;

  fs.writeFileSync(
    path.join(home, '.experience', 'config.json'),
    JSON.stringify({ serverBaseUrl: `http://127.0.0.1:${brainPort}`, serverAuthToken: 'e2e-token' }),
  );

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'exp-mcp.js')], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      EXPERIENCE_ACTIVITY_LOG: path.join(home, '.experience', 'activity.jsonl'),
      EXPERIENCE_RECALL_FEEDBACK_GATE: 'off',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const waitFor = (id) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = responses.find((r) => r.id === id);
      if (hit) { clearInterval(tick); resolve(hit); }
      else if (Date.now() - started > 10000) { clearInterval(tick); reject(new Error(`no response for id ${id}`)); }
    }, 25);
  });

  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, 'experience-engine');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const list = await waitFor(2);
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['ee_feedback', 'ee_health', 'ee_query', 'ee_write']);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ee_query', arguments: { query: 'what do we know' } } })}\n`);
    const call3 = await waitFor(3);
    assert.equal(call3.result.isError, undefined);
    assert.match(call3.result.content[0].text, /\[id:deadbeef col:experience-behavioral\]/);
    assert.match(call3.result.content[0].text, /\[recall: 1 entries/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await new Promise((r) => brain.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
