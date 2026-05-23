#!/usr/bin/env node
/**
 * exp-dashboard.js — v3.0 effectiveness analyzer.
 *
 * Reads activity log + Qdrant payloads, runs `exp-gates.js --json`, and
 * writes a snapshot pair:
 *   ~/.experience/dashboard/snapshots/{YYYY-MM-DD}.json   history
 *   ~/.experience/dashboard/latest.json                   agent contract
 *   ~/.experience/dashboard/index.html                    human view
 *
 * Usage:
 *   node tools/exp-dashboard.js                # default 30d window
 *   node tools/exp-dashboard.js --since 7d
 *   node tools/exp-dashboard.js --output /tmp  # override output dir
 *
 * Zero dependencies. Schema doc lives at tools/dashboard/schema.md.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { collectEvents, resolveLogFiles } = require('./dashboard/activity-parser');
const {
  indexQdrantPoints,
  computePrecision,
  computeFunnel,
  computeTopOffenders,
  computeGateStatus,
  computeSessions,
  exportSessionsToCsv,
  computeStoreDistribution,
} = require('./dashboard/aggregators');
const { renderHtml } = require('./dashboard/render-html');

const SCHEMA_VERSION = '1.1';
const QDRANT_COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];

function parseArgs(argv) {
  const args = { since: '30d', output: null, configFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && argv[i + 1]) { args.since = argv[++i]; }
    else if (a.startsWith('--since=')) { args.since = a.slice(8); }
    else if (a === '--output' && argv[i + 1]) { args.output = argv[++i]; }
    else if (a.startsWith('--output=')) { args.output = a.slice(9); }
    else if (a === '--config' && argv[i + 1]) { args.configFile = argv[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: exp-dashboard.js [--since 30d] [--output DIR]');
      process.exit(0);
    }
  }
  return args;
}

function loadEngineConfig(configFile) {
  const file = configFile || path.join(os.homedir(), '.experience', 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

async function qdrantScrollAll(baseUrl, apiKey, name) {
  const out = [];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;
  let offset;
  while (true) {
    const body = { limit: 256, with_payload: true };
    if (offset) body.offset = offset;
    const res = await fetch(`${baseUrl}/collections/${name}/points/scroll`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Qdrant scroll ${name} HTTP ${res.status}`);
    }
    const j = await res.json();
    out.push(...j.result.points);
    offset = j.result.next_page_offset;
    if (!offset) break;
  }
  return out;
}

function runExpGates() {
  const script = path.join(__dirname, 'exp-gates.js');
  if (!fs.existsSync(script)) return null;
  try {
    const out = execFileSync(process.execPath, [script, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }).toString('utf8');
    return JSON.parse(out);
  } catch (err) {
    console.error('[warn] exp-gates.js failed:', err.message);
    return null;
  }
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv);
  const startMs = Date.now();
  const homeDir = os.homedir();
  const outputDir = args.output || path.join(homeDir, '.experience', 'dashboard');
  const snapshotsDir = path.join(outputDir, 'snapshots');
  ensureDir(snapshotsDir);

  console.log(`[exp-dashboard] window=${args.since} output=${outputDir}`);

  // Engine config — pull Qdrant URL + minConfidence for meta context
  const cfg = loadEngineConfig(args.configFile);
  const qdrantUrl = cfg.qdrantUrl || 'http://localhost:6333';
  const qdrantKey = cfg.qdrantKey || null;

  console.log('[exp-dashboard] streaming activity log…');
  const events = await collectEvents({ homeDir, since: args.since });
  const logFiles = resolveLogFiles(homeDir).map((f) => path.basename(f));

  console.log('[exp-dashboard] scrolling Qdrant…');
  const payloads = new Map();
  for (const name of QDRANT_COLLECTIONS) {
    payloads.set(name, await qdrantScrollAll(qdrantUrl, qdrantKey, name));
  }
  const qdrantIdx = indexQdrantPoints(payloads);
  const totalPoints = [...payloads.values()].reduce((sum, arr) => sum + arr.length, 0);

  console.log('[exp-dashboard] running exp-gates.js…');
  const gatesJson = runExpGates();

  console.log('[exp-dashboard] aggregating…');
  const precision = computePrecision(events, qdrantIdx);
  const funnel = computeFunnel(events);
  const topOffenders = computeTopOffenders(qdrantIdx, { minSurfaceCount: 5, limit: 20 });
  const store = computeStoreDistribution(payloads);
  const sessions = computeSessions(events, qdrantIdx, { limit: 50, windowDays: Math.round((Date.now() - new Date(events[0]?.ts || Date.now()).getTime()) / 86_400_000) });
  const gates = gatesJson
    ? computeGateStatus(gatesJson)
    : { build: 'fail', dogfood: { must: { passed: 0, total: 0, items: [] }, should: { passed: 0, total: 0, items: [] }, failing: [] }, acceptance: { Q1: 'pending', Q2: 'pending', Q3: 'pending', Q4: 'pending' }, verdict: 'exp-gates.js unavailable' };

  const now = new Date();
  const sinceMs = (() => {
    const m = String(args.since).match(/^(\d+)\s*(d|h)?$/i);
    if (!m) return 30 * 86_400_000;
    const n = parseInt(m[1], 10);
    return (m[2] || 'd').toLowerCase() === 'h' ? n * 3_600_000 : n * 86_400_000;
  })();
  const sinceDate = new Date(now.getTime() - sinceMs);
  const windowDays = Math.round(sinceMs / 86_400_000);

  const snapshot = {
    version: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    dataWindow: {
      since: sinceDate.toISOString(),
      until: now.toISOString(),
      days: windowDays,
    },
    gates,
    precision,
    funnel,
    topOffenders,
    store,
    sessions,
    meta: {
      sourceFiles: logFiles,
      linesScanned: events.length,
      qdrantPoints: totalPoints,
      buildMs: Date.now() - startMs,
      engineConfig: {
        minConfidence: cfg.minConfidence ?? null,
        highConfidence: cfg.highConfidence ?? null,
        brainProvider: cfg.brainProvider ?? null,
      },
    },
  };

  const dayFile = path.join(snapshotsDir, `${isoDate(now)}.json`);
  const latestFile = path.join(outputDir, 'latest.json');
  const htmlFile = path.join(outputDir, 'index.html');
  const csvFile = path.join(outputDir, 'sessions.csv');

  const json = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(dayFile, json, 'utf8');
  fs.writeFileSync(latestFile, json, 'utf8');
  fs.writeFileSync(htmlFile, renderHtml(snapshot), 'utf8');
  fs.writeFileSync(csvFile, exportSessionsToCsv(sessions), 'utf8');

  console.log(`[exp-dashboard] wrote ${dayFile}`);
  console.log(`[exp-dashboard]       ${latestFile}`);
  console.log(`[exp-dashboard]       ${htmlFile}`);
  console.log(`[exp-dashboard]       ${csvFile}`);
  console.log(`[exp-dashboard] verdict: ${gates.verdict}`);
  console.log(`[exp-dashboard] overall precision: ${precision.overall.precision == null ? '—' : (precision.overall.precision * 100).toFixed(1) + '%'} (${events.length} events / ${totalPoints} points / ${snapshot.meta.buildMs}ms)`);
}

main().catch((err) => {
  console.error('[exp-dashboard] FATAL', err);
  process.exit(1);
});
