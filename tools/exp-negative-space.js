#!/usr/bin/env node
/**
 * exp-negative-space.js — Find principles that SHOULD have fired on a
 * confirmed user-veto but didn't.
 *
 * P1 Item 4 of the EE Native Observation roadmap.
 *
 * Walks ~/.experience/sessions/<sid>.jsonl for posttool events tagged with
 * outcome.mistakeKind = "user-veto", pairs each with the upstream intercept
 * event (whose matchIds we already know fired), then queries the brain at a
 * RELAXED similarity threshold to find principles that were close-but-not-
 * close-enough. Output is a review queue — never updates the brain.
 *
 * Read-only against the brain. No /api/posttool, no recordJudgeFeedback,
 * no Qdrant writes.
 *
 * Usage:
 *   node tools/exp-negative-space.js --since 7d
 *   node tools/exp-negative-space.js --out gaps.json
 *   node tools/exp-negative-space.js --threshold 0.4 --top 20
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.experience', 'sessions');
const DEFAULT_THRESHOLD = 0.4;
const DEFAULT_TOPK = 20;
const PAIR_WINDOW_MS = 60_000;

function parseArgs(argv) {
  const args = {
    since: null,
    out: null,
    threshold: DEFAULT_THRESHOLD,
    topK: DEFAULT_TOPK,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    paths: [],
    quiet: false,
    collections: ['code', 'general', 'principles', 'experience'],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && argv[i + 1]) args.since = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--threshold' && argv[i + 1]) args.threshold = Number(argv[++i]) || args.threshold;
    else if (a === '--top' && argv[i + 1]) args.topK = Number(argv[++i]) || args.topK;
    else if (a === '--dir' && argv[i + 1]) args.sessionsDir = argv[++i];
    else if (a === '--collection' && argv[i + 1]) args.collections = String(argv[++i]).split(',');
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('--')) args.paths.push(a);
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'exp-negative-space.js — find principles that should have fired on user-veto but did not',
    '',
    'Usage:',
    '  node tools/exp-negative-space.js [path...]    explicit JSONL paths',
    '  node tools/exp-negative-space.js --since 7d   scan default dir',
    '',
    'Options:',
    '  --threshold <n>   relaxed similarity floor (default 0.4)',
    '  --top <n>         topK per query (default 20)',
    '  --collection <list>  comma-separated collections to search (default code,general,principles,experience)',
    '  --out <file>      write JSON report to file (else stdout)',
    '  --dir <path>      sessions dir (default: ~/.experience/sessions)',
    '  --quiet           suppress progress lines',
    '',
  ].join('\n'));
}

function parseSinceCutoff(since) {
  if (!since) return null;
  const m = String(since).match(/^(\d+)d$/);
  if (!m) return null;
  return Date.now() - Number(m[1]) * 86400000;
}

function listSessionFiles(dir, sinceMs) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (sinceMs !== null && stat.mtimeMs < sinceMs) continue;
    out.push(full);
  }
  return out;
}

function readEvents(filePath) {
  const events = [];
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return events; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return events;
}

/**
 * Pair user-veto posttool events with their upstream intercept event on
 * the same toolName within PAIR_WINDOW_MS. Returns an array of
 * { intercept, posttool } pairs where the posttool is a confirmed veto.
 */
function findVetoPairs(events) {
  const pairs = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== 'posttool') continue;
    if (ev.mistakeKind !== 'user-veto') continue;
    const evTs = Date.parse(ev.ts);
    let intercept = null;
    for (let j = i - 1; j >= 0; j--) {
      const cand = events[j];
      if (cand.kind !== 'intercept') continue;
      if (cand.toolName !== ev.toolName) continue;
      if (evTs - Date.parse(cand.ts) > PAIR_WINDOW_MS) break;
      intercept = cand;
      break;
    }
    pairs.push({ intercept, posttool: ev });
  }
  return pairs;
}

/** Build a stable query string out of toolName + toolInput (mirrors core's _buildQuery loosely). */
function buildQueryString(toolName, toolInput) {
  let inputStr = '';
  try {
    inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {});
  } catch { inputStr = String(toolInput || ''); }
  return `${toolName}: ${inputStr}`.slice(0, 2000);
}

/**
 * Run a relaxed similarity search across the configured collections and
 * return matches whose score >= threshold AND whose ID is NOT in the
 * already-fired set. Returns an array sorted by score desc.
 */
async function searchNearMisses({ core, query, alreadyFired, collections, threshold, topK }) {
  let vector;
  try {
    vector = await core.getEmbeddingRaw(query);
  } catch { return []; }
  if (!vector) return [];

  const fired = new Set(alreadyFired || []);
  const found = [];
  for (const col of collections) {
    let points;
    try { points = await core.searchCollection(col, vector, topK); } catch { continue; }
    if (!Array.isArray(points)) continue;
    for (const p of points) {
      const score = typeof p.score === 'number' ? p.score : 0;
      if (score < threshold) continue;
      const id = p.id || p.point_id;
      if (!id || fired.has(id)) continue;
      let solution = null;
      let confidence = null;
      try {
        const data = p.payload?.json ? JSON.parse(p.payload.json) : p.payload || {};
        solution = data.solution || data.summary || null;
        confidence = typeof data.confidence === 'number' ? data.confidence : null;
      } catch { /* leave nulls */ }
      found.push({
        id,
        collection: col,
        score: Number(score.toFixed(3)),
        confidence,
        solution: solution ? String(solution).slice(0, 200) : null,
      });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, topK);
}

async function loadCore(expDir) {
  const corePath = path.join(expDir, 'experience-core.js');
  if (!fs.existsSync(corePath)) {
    throw new Error(`experience-core.js not found at ${corePath}`);
  }
  return require(corePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expDir = path.join(os.homedir(), '.experience');
  let core;
  try { core = await loadCore(expDir); }
  catch (err) {
    process.stderr.write(`exp-negative-space: ${err.message}\n`);
    process.exit(1);
  }

  const sinceMs = parseSinceCutoff(args.since);
  let files = args.paths.slice();
  if (files.length === 0) files = listSessionFiles(args.sessionsDir, sinceMs);
  if (files.length === 0) {
    if (!args.quiet) process.stderr.write('No session files found.\n');
    process.exit(0);
  }

  const allGaps = [];
  let totalVetos = 0;
  for (const file of files) {
    const events = readEvents(file);
    const sessionId = path.basename(file, '.jsonl');
    const pairs = findVetoPairs(events);
    if (pairs.length === 0) continue;
    if (!args.quiet) process.stderr.write(`Scanning ${pairs.length} veto(s) in ${sessionId}…\n`);
    for (const { intercept, posttool } of pairs) {
      totalVetos++;
      const toolName = posttool.toolName || intercept?.toolName || '';
      const toolInput = intercept?.toolInput || {};
      const alreadyFired = Array.isArray(intercept?.matchIds) ? intercept.matchIds : [];
      const query = buildQueryString(toolName, toolInput);
      const nearMisses = await searchNearMisses({
        core, query, alreadyFired,
        collections: args.collections,
        threshold: args.threshold,
        topK: args.topK,
      });
      allGaps.push({
        sessionId,
        ts: posttool.ts,
        toolName,
        evidenceSignal: posttool.evidence?.signal || null,
        alreadyFiredCount: alreadyFired.length,
        nearMissCount: nearMisses.length,
        nearMisses,
      });
    }
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    threshold: args.threshold,
    topK: args.topK,
    collections: args.collections,
    totalVetos,
    totalGaps: allGaps.length,
    gaps: allGaps,
  };

  const outJson = JSON.stringify(aggregate, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, outJson + '\n', 'utf8');
    if (!args.quiet) process.stderr.write(`Report written: ${args.out}\n`);
  } else {
    process.stdout.write(outJson + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`exp-negative-space: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseSinceCutoff,
  readEvents,
  findVetoPairs,
  buildQueryString,
  searchNearMisses,
};
