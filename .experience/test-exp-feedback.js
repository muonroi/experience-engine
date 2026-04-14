#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { parseArgs, resolveServerConfig, sendFeedback } = require('./exp-feedback.js');

test('parseArgs supports followed ignored and noise aliases', () => {
  assert.deepEqual(parseArgs(['node', 'exp-feedback.js', 'followed', 'abcd1234', 'experience-selfqa']), {
    ok: true,
    payload: { pointId: 'abcd1234', collection: 'experience-selfqa', verdict: 'FOLLOWED' }
  });

  assert.deepEqual(parseArgs(['node', 'exp-feedback.js', 'ignored', 'abcd1234', 'experience-selfqa']), {
    ok: true,
    payload: { pointId: 'abcd1234', collection: 'experience-selfqa', verdict: 'IGNORED' }
  });

  assert.deepEqual(parseArgs(['node', 'exp-feedback.js', 'noise', 'abcd1234', 'experience-selfqa', 'wrong_task']), {
    ok: true,
    payload: { pointId: 'abcd1234', collection: 'experience-selfqa', verdict: 'IRRELEVANT', reason: 'wrong_task' }
  });
});

test('resolveServerConfig prefers thin-client config values', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-feedback-home-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify({
    serverBaseUrl: 'http://brain.example:8082/',
    serverAuthToken: 'secret-token',
  }));

  assert.deepEqual(resolveServerConfig(homeDir), {
    baseUrl: 'http://brain.example:8082',
    authToken: 'secret-token',
  });
});

test('sendFeedback posts the parsed verdict payload', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = {
        url: req.url,
        auth: req.headers.authorization || '',
        body: JSON.parse(body),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, verdict: received.body.verdict }));
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-feedback-home-'));
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify({
    serverBaseUrl: `http://127.0.0.1:${port}`,
    serverAuthToken: 'token-123',
  }));

  const result = await sendFeedback({
    pointId: 'abcd1234',
    collection: 'experience-selfqa',
    verdict: 'IRRELEVANT',
    reason: 'wrong_task',
  }, homeDir);

  server.close();

  assert.equal(result.ok, true);
  assert.deepEqual(received.body, {
    pointId: 'abcd1234',
    collection: 'experience-selfqa',
    verdict: 'IRRELEVANT',
    reason: 'wrong_task',
  });
  assert.equal(received.url, '/api/feedback');
  assert.equal(received.auth, 'Bearer token-123');
});
