#!/usr/bin/env node
'use strict';

/**
 * test-judge-consensus.js — Unit tests for P1 Item 2 cross-model judge consensus
 * helpers exported from judge-worker.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadJudgesConfig,
  callJudgeBrain,
  normaliseVerdict,
  resolveConsensus,
  recordDisagreement,
} = require('./judge-worker.js');

const VALID = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT', 'UNCLEAR']);

// ─── normaliseVerdict ─────────────────────────────────────────────────────────

test('normaliseVerdict returns concrete verdict when raw matches', () => {
  assert.strictEqual(normaliseVerdict('FOLLOWED', VALID), 'FOLLOWED');
  assert.strictEqual(normaliseVerdict('  ignored \n', VALID), 'IGNORED');
  assert.strictEqual(normaliseVerdict('IRRELEVANT extra noise', VALID), 'IRRELEVANT');
});

test('normaliseVerdict returns UNCLEAR for unknown / empty', () => {
  assert.strictEqual(normaliseVerdict(null, VALID), 'UNCLEAR');
  assert.strictEqual(normaliseVerdict('', VALID), 'UNCLEAR');
  assert.strictEqual(normaliseVerdict('maybe', VALID), 'UNCLEAR');
});

// ─── resolveConsensus ─────────────────────────────────────────────────────────

test('resolveConsensus agrees when all judges return same concrete verdict', () => {
  const r = resolveConsensus(['FOLLOWED', 'FOLLOWED']);
  assert.deepStrictEqual(r, { agreed: true, finalVerdict: 'FOLLOWED' });
});

test('resolveConsensus disagrees when judges differ', () => {
  const r = resolveConsensus(['FOLLOWED', 'IGNORED']);
  assert.deepStrictEqual(r, { agreed: false, finalVerdict: null });
});

test('resolveConsensus disagrees when any judge is UNCLEAR', () => {
  assert.deepStrictEqual(
    resolveConsensus(['FOLLOWED', 'UNCLEAR']),
    { agreed: false, finalVerdict: null },
  );
  assert.deepStrictEqual(
    resolveConsensus(['UNCLEAR', 'UNCLEAR']),
    { agreed: false, finalVerdict: null },
  );
});

test('resolveConsensus single-judge always agrees with itself when concrete', () => {
  assert.deepStrictEqual(
    resolveConsensus(['FOLLOWED']),
    { agreed: true, finalVerdict: 'FOLLOWED' },
  );
});

test('resolveConsensus empty array returns no agreement', () => {
  assert.deepStrictEqual(resolveConsensus([]), { agreed: false, finalVerdict: null });
});

// ─── loadJudgesConfig ─────────────────────────────────────────────────────────

test('loadJudgesConfig returns judges array from config.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({
        judges: [{ model: 'a', role: 'primary' }, { model: 'b', role: 'secondary' }],
        brainProxyUrl: 'http://example.com/api/brain',
      }),
      'utf8',
    );
    const r = loadJudgesConfig(tmp);
    assert.strictEqual(r.judges.length, 2);
    assert.strictEqual(r.judges[0].model, 'a');
    assert.strictEqual(r.brainProxyUrl, 'http://example.com/api/brain');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadJudgesConfig returns empty array when missing or malformed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-'));
  try {
    // No config.json at all
    const r1 = loadJudgesConfig(tmp);
    assert.deepStrictEqual(r1.judges, []);
    assert.strictEqual(r1.brainProxyUrl, null);

    // Malformed JSON
    fs.writeFileSync(path.join(tmp, 'config.json'), '{not json', 'utf8');
    const r2 = loadJudgesConfig(tmp);
    assert.deepStrictEqual(r2.judges, []);

    // judges is not an array
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ judges: 'string' }), 'utf8');
    const r3 = loadJudgesConfig(tmp);
    assert.deepStrictEqual(r3.judges, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── callJudgeBrain ───────────────────────────────────────────────────────────

test('callJudgeBrain returns classifyViaBrain result on success', async () => {
  const stubBrain = async (prompt, _timeoutMs, opts) => {
    assert.strictEqual(opts.model, 'm1');
    assert.strictEqual(opts.endpoint, 'https://x');
    return 'FOLLOWED';
  };
  const r = await callJudgeBrain({
    classifyViaBrain: stubBrain,
    prompt: 'test',
    judgeConfig: { model: 'm1', endpoint: 'https://x', key: 'k', provider: 'siliconflow' },
    brainProxyUrl: null,
    expDir: os.tmpdir(),
  });
  assert.strictEqual(r, 'FOLLOWED');
});

test('callJudgeBrain falls through to brainProxyUrl when classifyViaBrain returns null', async () => {
  const stubBrain = async () => null;
  // Spin up a tiny stub HTTP server.
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'IGNORED' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await callJudgeBrain({
      classifyViaBrain: stubBrain,
      prompt: 'test',
      judgeConfig: { model: 'fallback' },
      brainProxyUrl: `http://127.0.0.1:${port}/api/brain`,
      expDir: os.tmpdir(),
    });
    assert.strictEqual(r, 'IGNORED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('callJudgeBrain returns null when both paths fail', async () => {
  const stubBrain = async () => null;
  const r = await callJudgeBrain({
    classifyViaBrain: stubBrain,
    prompt: 'test',
    judgeConfig: null,
    brainProxyUrl: null,
    expDir: os.tmpdir(),
  });
  assert.strictEqual(r, null);
});

// ─── recordDisagreement ───────────────────────────────────────────────────────

test('recordDisagreement appends one JSONL line per call', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dis-'));
  try {
    recordDisagreement(tmp, { tool: 'Bash', verdicts: [{ role: 'p', verdict: 'F' }, { role: 's', verdict: 'I' }] });
    recordDisagreement(tmp, { tool: 'Edit', verdicts: [{ role: 'p', verdict: 'I' }, { role: 's', verdict: 'R' }] });
    const file = path.join(tmp, 'judge-disagreements.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    assert.strictEqual(e1.tool, 'Bash');
    assert.ok(e1.ts, 'has ts field');
    assert.ok(Array.isArray(e1.verdicts));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
