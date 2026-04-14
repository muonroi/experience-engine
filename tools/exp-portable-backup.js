#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COLLECTIONS = [
  'experience-principles',
  'experience-behavioral',
  'experience-selfqa',
  'experience-edges',
];

function parseArgs(argv) {
  const args = { out: '', includeSecrets: false, homeDir: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (arg === '--home' && argv[i + 1]) args.homeDir = argv[++i];
    else if (arg === '--include-secrets') args.includeSecrets = true;
  }
  if (!args.out) throw new Error('--out is required');
  return args;
}

function safeReadJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadConfig(homeDir) {
  return safeReadJson(path.join(homeDir, '.experience', 'config.json'), {});
}

function scrubConfig(config, includeSecrets) {
  if (includeSecrets) return config;
  const cloned = JSON.parse(JSON.stringify(config || {}));
  delete cloned.qdrantKey;
  delete cloned.embedKey;
  delete cloned.brainKey;
  delete cloned.serverAuthToken;
  if (cloned.server && typeof cloned.server === 'object') delete cloned.server.authToken;
  return cloned;
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

async function exportCollection(baseUrl, apiKey, name) {
  const points = [];
  let offset = null;
  do {
    const body = { limit: 100, with_payload: true, with_vector: true };
    if (offset !== null) body.offset = offset;
    const data = await qdrantRequest(baseUrl, apiKey, `/collections/${name}/points/scroll`, {
      method: 'POST',
      body,
    });
    const batch = data?.result?.points || [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
  } while (offset !== null);

  const meta = await qdrantRequest(baseUrl, apiKey, `/collections/${name}`);
  return { name, meta: meta?.result || null, points };
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

async function createPortableBackup(options) {
  const config = loadConfig(options.homeDir);
  const qdrantUrl = config.qdrantUrl || 'http://localhost:6333';
  const qdrantKey = config.qdrantKey || '';
  const outDir = path.resolve(options.out);
  const collectionsDir = path.join(outDir, 'collections');
  const stateDir = path.join(outDir, 'state');

  ensureDir(collectionsDir);
  ensureDir(stateDir);

  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(scrubConfig(config, options.includeSecrets), null, 2));
  copyIfExists(path.join(options.homeDir, '.experience', 'activity.jsonl'), path.join(stateDir, 'activity.jsonl'));
  copyIfExists(path.join(options.homeDir, '.experience', 'activity.jsonl.1'), path.join(stateDir, 'activity.jsonl.1'));
  copyIfExists(path.join(options.homeDir, '.experience', '.evolve-marker'), path.join(stateDir, '.evolve-marker'));
  copyIfExists(path.join(options.homeDir, '.experience', '.stop-marker.json'), path.join(stateDir, '.stop-marker.json'));
  copyDirectory(path.join(options.homeDir, '.experience', 'store'), path.join(stateDir, 'store'));

  const exported = [];
  for (const name of DEFAULT_COLLECTIONS) {
    try {
      const snapshot = await exportCollection(qdrantUrl, qdrantKey, name);
      fs.writeFileSync(path.join(collectionsDir, `${name}.json`), JSON.stringify(snapshot, null, 2));
      exported.push({ name, count: snapshot.points.length });
    } catch (error) {
      if (!String(error.message || error).includes('404')) throw error;
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    homeDir: options.homeDir,
    includeSecrets: !!options.includeSecrets,
    qdrantUrl,
    collections: exported,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) {
  createPortableBackup(parseArgs(process.argv.slice(2)))
    .then((manifest) => {
      process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write(`${error.message || String(error)}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_COLLECTIONS,
  createPortableBackup,
  exportCollection,
  scrubConfig,
};
