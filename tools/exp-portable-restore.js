#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = { from: '', homeDir: os.homedir(), restoreConfig: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) args.from = argv[++i];
    else if (arg === '--home' && argv[i + 1]) args.homeDir = argv[++i];
    else if (arg === '--restore-config') args.restoreConfig = true;
  }
  if (!args.from) throw new Error('--from is required');
  return args;
}

function safeReadJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyIfExists(fromPath, toPath) {
  if (!fs.existsSync(fromPath)) return false;
  ensureDir(path.dirname(toPath));
  fs.copyFileSync(fromPath, toPath);
  return true;
}

function copyDirectory(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirectory(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
  return true;
}

async function qdrantRequest(baseUrl, apiKey, requestPath, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;
  const res = await fetch(`${baseUrl}${requestPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 10000),
  });
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${requestPath} failed with ${res.status}`);
  return res.json();
}

async function ensureCollection(baseUrl, apiKey, snapshot) {
  try {
    await qdrantRequest(baseUrl, apiKey, `/collections/${snapshot.name}`);
    return;
  } catch {}

  const vectors = snapshot?.meta?.config?.params?.vectors || snapshot?.meta?.config?.vectors;
  if (!vectors) throw new Error(`cannot restore ${snapshot.name}: missing vector config`);
  await qdrantRequest(baseUrl, apiKey, `/collections/${snapshot.name}`, {
    method: 'PUT',
    body: { vectors },
  });
}

async function restoreCollection(baseUrl, apiKey, snapshot) {
  await ensureCollection(baseUrl, apiKey, snapshot);
  if (!Array.isArray(snapshot.points) || snapshot.points.length === 0) return 0;
  await qdrantRequest(baseUrl, apiKey, `/collections/${snapshot.name}/points`, {
    method: 'PUT',
    body: { points: snapshot.points },
  });
  return snapshot.points.length;
}

async function restorePortableBackup(options) {
  const backupDir = path.resolve(options.from);
  const manifest = safeReadJson(path.join(backupDir, 'manifest.json'));
  const config = safeReadJson(path.join(backupDir, 'config.json'));
  const expDir = path.join(options.homeDir, '.experience');
  ensureDir(expDir);

  if (options.restoreConfig) {
    fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify(config, null, 2));
  }

  copyIfExists(path.join(backupDir, 'state', 'activity.jsonl'), path.join(expDir, 'activity.jsonl'));
  copyIfExists(path.join(backupDir, 'state', 'activity.jsonl.1'), path.join(expDir, 'activity.jsonl.1'));
  copyIfExists(path.join(backupDir, 'state', '.evolve-marker'), path.join(expDir, '.evolve-marker'));
  copyIfExists(path.join(backupDir, 'state', '.stop-marker.json'), path.join(expDir, '.stop-marker.json'));
  copyDirectory(path.join(backupDir, 'state', 'store'), path.join(expDir, 'store'));

  const qdrantUrl = config.qdrantUrl || manifest.qdrantUrl || 'http://localhost:6333';
  const qdrantKey = config.qdrantKey || '';
  const restored = [];
  const collections = Array.isArray(manifest.collections) ? manifest.collections.map((item) => item.name) : [];
  for (const name of collections) {
    const snapshot = safeReadJson(path.join(backupDir, 'collections', `${name}.json`), null);
    if (!snapshot) continue;
    const count = await restoreCollection(qdrantUrl, qdrantKey, snapshot);
    restored.push({ name, count });
  }
  return { restored };
}

if (require.main === module) {
  restorePortableBackup(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write(`${error.message || String(error)}\n`);
      process.exit(1);
    });
}

module.exports = {
  restorePortableBackup,
  restoreCollection,
  ensureCollection,
};
