#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createPortableBackup } = require('./exp-portable-backup');
const { restorePortableBackup } = require('./exp-portable-restore');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-portable-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'store'), { recursive: true });
  return homeDir;
}

function writeConfig(homeDir, cfg) {
  fs.writeFileSync(path.join(homeDir, '.experience', 'config.json'), JSON.stringify(cfg, null, 2));
}

function startFakeQdrant(state) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && parts[0] === 'collections' && parts.length === 2) {
        const name = parts[1];
        const collection = state[name];
        if (!collection) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: collection.meta }));
        return;
      }

      if (req.method === 'POST' && parts[0] === 'collections' && parts[2] === 'points' && parts[3] === 'scroll') {
        const name = parts[1];
        const collection = state[name];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { points: collection ? collection.points : [], next_page_offset: null } }));
        return;
      }

      if (req.method === 'PUT' && parts[0] === 'collections' && parts.length === 2) {
        const name = parts[1];
        const parsed = JSON.parse(body || '{}');
        state[name] = state[name] || { meta: { config: { params: { vectors: parsed.vectors } } }, points: [] };
        if (parsed.vectors) state[name].meta = { config: { params: { vectors: parsed.vectors } } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: true }));
        return;
      }

      if (req.method === 'PUT' && parts[0] === 'collections' && parts[2] === 'points') {
        const name = parts[1];
        const parsed = JSON.parse(body || '{}');
        state[name] = state[name] || { meta: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } }, points: [] };
        state[name].points = parsed.points || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { status: 'acknowledged' } }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('portable backup and restore round-trip config, state, and Qdrant collections', async () => {
  const sourceHome = makeHome();
  const targetHome = makeHome();
  const state = {
    'experience-principles': {
      meta: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } },
      points: [{ id: 'p1', vector: [0.1, 0.2, 0.3], payload: { json: '{"trigger":"rule"}' } }],
    },
    'experience-behavioral': {
      meta: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } },
      points: [{ id: 'b1', vector: [0.3, 0.2, 0.1], payload: { json: '{"trigger":"warn"}' } }],
    },
    'experience-selfqa': {
      meta: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } },
      points: [],
    },
    'experience-edges': {
      meta: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } },
      points: [],
    },
  };
  const { server, port } = await startFakeQdrant(state);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-backup-'));

  writeConfig(sourceHome, {
    qdrantUrl: `http://127.0.0.1:${port}`,
    qdrantKey: 'secret-key',
    serverAuthToken: 'server-secret',
  });
  fs.writeFileSync(path.join(sourceHome, '.experience', 'activity.jsonl'), '{"op":"intercept"}\n');
  fs.writeFileSync(path.join(sourceHome, '.experience', 'store', 'experience-edges.json'), '[]');

  try {
    const manifest = await createPortableBackup({ out: backupDir, homeDir: sourceHome, includeSecrets: false });
    assert.equal(manifest.collections.length, 4);
    assert.equal(fs.existsSync(path.join(backupDir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(backupDir, 'state', 'activity.jsonl')), true);
    const scrubbed = JSON.parse(fs.readFileSync(path.join(backupDir, 'config.json'), 'utf8'));
    assert.equal('qdrantKey' in scrubbed, false);
    assert.equal('serverAuthToken' in scrubbed, false);

    for (const key of Object.keys(state)) delete state[key];
    fs.writeFileSync(path.join(backupDir, 'config.json'), JSON.stringify({ qdrantUrl: `http://127.0.0.1:${port}` }, null, 2));

    const restored = await restorePortableBackup({ from: backupDir, homeDir: targetHome, restoreConfig: true });
    assert.equal(restored.restored.length, 4);
    assert.equal(fs.existsSync(path.join(targetHome, '.experience', 'activity.jsonl')), true);
    assert.equal(fs.existsSync(path.join(targetHome, '.experience', 'store', 'experience-edges.json')), true);
    assert.equal(state['experience-principles'].points.length, 1);
    assert.equal(state['experience-behavioral'].points.length, 1);
  } finally {
    server.close();
  }
});
