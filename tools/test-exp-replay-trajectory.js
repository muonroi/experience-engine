#!/usr/bin/env node
/**
 * test-exp-replay-trajectory.js — Unit tests for the replay harness.
 *
 * Run: node tools/test-exp-replay-trajectory.js
 * Exit 0 on success, exit 1 on failure.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  parseSinceCutoff,
  readEvents,
  pairEvents,
  decisionFromReplay,
  principleIdsFromReplay,
  symmetricDiff,
  replaySession,
} = require('./exp-replay-trajectory.js');

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses path arguments', () => {
    const a = parseArgs(['/tmp/a.jsonl', '/tmp/b.jsonl']);
    assert.deepStrictEqual(a.paths, ['/tmp/a.jsonl', '/tmp/b.jsonl']);
  });

  it('parses --since/--out/--server', () => {
    const a = parseArgs(['--since', '7d', '--out', 'r.json', '--server', 'http://x:1']);
    assert.strictEqual(a.since, '7d');
    assert.strictEqual(a.out, 'r.json');
    assert.strictEqual(a.server, 'http://x:1');
  });

  it('parses --quiet flag', () => {
    const a = parseArgs(['--quiet']);
    assert.strictEqual(a.quiet, true);
  });
});

// ─── parseSinceCutoff ─────────────────────────────────────────────────────────

describe('parseSinceCutoff', () => {
  it('returns ms cutoff for "7d"', () => {
    const ms = parseSinceCutoff('7d');
    const expected = Date.now() - 7 * 86400000;
    assert.ok(Math.abs(ms - expected) < 2000);
  });

  it('returns null for null/invalid', () => {
    assert.strictEqual(parseSinceCutoff(null), null);
    assert.strictEqual(parseSinceCutoff('7h'), null);
    assert.strictEqual(parseSinceCutoff(''), null);
  });
});

// ─── readEvents ───────────────────────────────────────────────────────────────

describe('readEvents', () => {
  const tmp = path.join(os.tmpdir(), `replay-test-${process.pid}.jsonl`);
  before(() => {
    fs.writeFileSync(tmp,
      JSON.stringify({ ts: '2026-05-07T00:00:00Z', kind: 'intercept', toolName: 'Bash' }) + '\n' +
      '\n' + // blank line
      'not json\n' +
      JSON.stringify({ ts: '2026-05-07T00:00:01Z', kind: 'posttool', toolName: 'Bash', success: true }) + '\n',
      'utf8',
    );
  });
  after(() => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } });

  it('parses valid lines and skips malformed', () => {
    const evs = readEvents(tmp);
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[0].kind, 'intercept');
    assert.strictEqual(evs[1].kind, 'posttool');
  });

  it('returns [] for missing file', () => {
    assert.deepStrictEqual(readEvents('/no/such/file.jsonl'), []);
  });
});

// ─── pairEvents ───────────────────────────────────────────────────────────────

describe('pairEvents', () => {
  it('pairs intercept with posttool of same toolName within window', () => {
    const events = [
      { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit' },
      { ts: '2026-05-07T00:00:01.000Z', kind: 'posttool', toolName: 'Edit', success: true },
    ];
    const pairs = pairEvents(events);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].posttool.success, true);
  });

  it('leaves posttool null when none within window', () => {
    const events = [
      { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit' },
      { ts: '2026-05-07T00:02:00.000Z', kind: 'posttool', toolName: 'Edit', success: true }, // 120s out
    ];
    const pairs = pairEvents(events);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].posttool, null);
  });

  it('skips mismatched toolName', () => {
    const events = [
      { ts: '2026-05-07T00:00:00.000Z', kind: 'intercept', toolName: 'Edit' },
      { ts: '2026-05-07T00:00:01.000Z', kind: 'posttool', toolName: 'Bash', success: true },
    ];
    const pairs = pairEvents(events);
    assert.strictEqual(pairs[0].posttool, null);
  });
});

// ─── decisionFromReplay / principleIdsFromReplay ──────────────────────────────

describe('decisionFromReplay', () => {
  it('returns "allow" when no suggestions', () => {
    assert.strictEqual(decisionFromReplay({ suggestions: null }), 'allow');
    assert.strictEqual(decisionFromReplay({}), 'allow');
  });

  it('returns "allow" when matches are non-blocking', () => {
    const r = { suggestions: { matches: [{ principle_uuid: 'p1', action: 'suggest', severity: 'low' }] } };
    assert.strictEqual(decisionFromReplay(r), 'allow');
  });

  it('returns "block" when any match has action:block', () => {
    const r = { suggestions: { matches: [{ principle_uuid: 'p1', action: 'block' }] } };
    assert.strictEqual(decisionFromReplay(r), 'block');
  });

  it('returns "block" when any match has severity:high', () => {
    const r = { suggestions: { matches: [{ principle_uuid: 'p1', severity: 'high' }] } };
    assert.strictEqual(decisionFromReplay(r), 'block');
  });
});

describe('principleIdsFromReplay', () => {
  it('extracts principle_uuid from matches', () => {
    const r = { suggestions: { matches: [{ principle_uuid: 'a' }, { principle_uuid: 'b' }] } };
    assert.deepStrictEqual(principleIdsFromReplay(r), ['a', 'b']);
  });

  it('falls back to id', () => {
    const r = { suggestions: { matches: [{ id: 'x' }] } };
    assert.deepStrictEqual(principleIdsFromReplay(r), ['x']);
  });

  it('returns [] when none', () => {
    assert.deepStrictEqual(principleIdsFromReplay({}), []);
    assert.deepStrictEqual(principleIdsFromReplay({ suggestions: {} }), []);
  });
});

// ─── symmetricDiff ────────────────────────────────────────────────────────────

describe('symmetricDiff', () => {
  it('returns disjoint members in each direction', () => {
    const d = symmetricDiff(['a', 'b'], ['b', 'c']);
    assert.deepStrictEqual(d.onlyOriginal, ['a']);
    assert.deepStrictEqual(d.onlyReplay, ['c']);
  });

  it('returns empty arrays when identical', () => {
    const d = symmetricDiff(['a', 'b'], ['a', 'b']);
    assert.deepStrictEqual(d.onlyOriginal, []);
    assert.deepStrictEqual(d.onlyReplay, []);
  });
});

// ─── Integration: replaySession against a stub HTTP server ────────────────────

describe('replaySession (integration with stub server)', () => {
  let server;
  let port;
  let receivedRequests = 0;
  const tmpFile = path.join(os.tmpdir(), `replay-int-${process.pid}.jsonl`);

  before(async () => {
    // Stub server that returns a "block" suggestion for tool=Bash, allow for others.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedRequests++;
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.toolName === 'Bash') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            suggestions: { matches: [{ principle_uuid: 'block-id', action: 'block' }] },
            hasSuggestions: true,
            surfacedIds: ['block-id'],
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ suggestions: null, hasSuggestions: false, surfacedIds: [] }));
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    const events = [
      // Intercept on Bash that originally allowed; replay will block. Sibling posttool=user-veto.
      { ts: '2026-05-07T00:00:00.000Z', sessionId: 'int-test', kind: 'intercept',
        toolName: 'Bash', decision: 'allow', matchCount: 0, matchIds: [] },
      { ts: '2026-05-07T00:00:01.000Z', sessionId: 'int-test', kind: 'posttool',
        toolName: 'Bash', success: false, mistakeKind: 'user-veto' },
      // Intercept on Edit that originally allowed; replay also allows. Sibling posttool=success.
      { ts: '2026-05-07T00:00:02.000Z', sessionId: 'int-test', kind: 'intercept',
        toolName: 'Edit', decision: 'allow', matchCount: 0, matchIds: [] },
      { ts: '2026-05-07T00:00:03.000Z', sessionId: 'int-test', kind: 'posttool',
        toolName: 'Edit', success: true },
    ];
    fs.writeFileSync(tmpFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  });

  after(async () => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    if (server) await new Promise((r) => server.close(r));
  });

  it('reports nowBlockingCorrectly + nowAllowingCorrectly', async () => {
    const summary = await replaySession(tmpFile, { server: `http://127.0.0.1:${port}` });
    assert.strictEqual(summary.interceptCount, 2);
    assert.strictEqual(summary.errors, 0);
    assert.strictEqual(summary.nowBlockingCorrectly, 1, 'replay block + original veto');
    assert.strictEqual(summary.nowAllowingCorrectly, 1, 'replay allow + original success');
    assert.strictEqual(summary.decisionDrift, 1, 'Bash drifted from allow→block');
    assert.ok(receivedRequests >= 2, 'two intercept calls');
  });
});
