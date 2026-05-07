#!/usr/bin/env node
/**
 * exp-replay-trajectory.js — Replay harness over muonroi-cli trajectory JSONL.
 *
 * Reads ~/.experience/sessions/<sid>.jsonl files (written by muonroi-cli's
 * P0 native observation), re-issues each captured `intercept` event against
 * the current EE brain, pairs the intercept with its downstream `posttool`
 * sibling, and emits a per-session report comparing original vs. replayed
 * decisions.
 *
 * Side-effect-free against the brain — only calls /api/intercept (read-only
 * suggestion path with skipRoute=true). Never calls posttool, never updates
 * weights.
 *
 * Usage:
 *   node tools/exp-replay-trajectory.js [path...]
 *   node tools/exp-replay-trajectory.js --since 7d
 *   node tools/exp-replay-trajectory.js --out report.json
 *   node tools/exp-replay-trajectory.js --server http://localhost:8082
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SERVER = process.env.EXP_SERVER || 'http://localhost:8082';
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.experience', 'sessions');
const POSTTOOL_PAIR_WINDOW_MS = 60_000;

function parseArgs(argv) {
  const args = {
    paths: [],
    since: null,
    out: null,
    server: DEFAULT_SERVER,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && argv[i + 1]) args.since = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--server' && argv[i + 1]) args.server = argv[++i];
    else if (a === '--dir' && argv[i + 1]) args.sessionsDir = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('--')) args.paths.push(a);
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'exp-replay-trajectory.js — replay captured intercepts against current brain',
    '',
    'Usage:',
    '  node tools/exp-replay-trajectory.js [path...]      explicit JSONL paths',
    '  node tools/exp-replay-trajectory.js --since 7d     scan default dir',
    '',
    'Options:',
    '  --out <file>     write JSON report to file (else stdout)',
    '  --server <url>   EE server URL (default: $EXP_SERVER or http://localhost:8082)',
    '  --dir <path>     sessions dir (default: ~/.experience/sessions)',
    '  --quiet          suppress progress lines',
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
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return events;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

/**
 * Pair each intercept event with the closest downstream posttool on the same
 * toolName within POSTTOOL_PAIR_WINDOW_MS. Many posttools may have no warning,
 * but every intercept that mattered should have a sibling.
 */
function pairEvents(events) {
  const pairs = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== 'intercept') continue;
    const evTs = Date.parse(ev.ts);
    let pair = null;
    for (let j = i + 1; j < events.length; j++) {
      const cand = events[j];
      if (cand.kind !== 'posttool') continue;
      if (cand.toolName !== ev.toolName) continue;
      const dt = Date.parse(cand.ts) - evTs;
      if (dt < 0 || dt > POSTTOOL_PAIR_WINDOW_MS) continue;
      pair = cand;
      break;
    }
    pairs.push({ intercept: ev, posttool: pair });
  }
  return pairs;
}

async function callIntercept(serverUrl, toolName, toolInput, sessionId) {
  const url = serverUrl.replace(/\/+$/, '') + '/api/intercept';
  const body = JSON.stringify({
    toolName,
    toolInput: toolInput || {},
    sourceKind: 'replay-harness',
    sourceRuntime: 'replay',
    sourceSession: sessionId,
    skipRoute: true, // do not perturb routing learner
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`intercept ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/**
 * Replayed decision = block iff suggestions are non-null AND any has a "block"
 * action. Otherwise allow. Mirrors the CLI's hook decision logic.
 */
function decisionFromReplay(replayResp) {
  const suggestions = replayResp?.suggestions;
  if (!suggestions || !Array.isArray(suggestions.matches)) return 'allow';
  const blocking = suggestions.matches.some((m) => m.action === 'block' || m.severity === 'high');
  return blocking ? 'block' : 'allow';
}

function principleIdsFromReplay(replayResp) {
  const m = replayResp?.suggestions?.matches;
  if (!Array.isArray(m)) return [];
  return m.map((x) => x.principle_uuid || x.id).filter(Boolean);
}

function symmetricDiff(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const onlyA = [...A].filter((x) => !B.has(x));
  const onlyB = [...B].filter((x) => !A.has(x));
  return { onlyOriginal: onlyA, onlyReplay: onlyB };
}

async function replaySession(filePath, args) {
  const events = readEvents(filePath);
  const sessionId = path.basename(filePath, '.jsonl');
  const pairs = pairEvents(events);

  const summary = {
    sessionId,
    file: filePath,
    eventCount: events.length,
    interceptCount: pairs.length,
    decisionDrift: 0,
    principleDrift: 0,
    nowBlockingCorrectly: 0, // replay blocked AND original posttool was a veto
    nowAllowingCorrectly: 0, // replay allowed AND original posttool succeeded
    errors: 0,
    perEvent: [],
  };

  for (const { intercept, posttool } of pairs) {
    let replayResp;
    try {
      replayResp = await callIntercept(args.server, intercept.toolName, intercept.toolInput, sessionId);
    } catch (err) {
      summary.errors++;
      summary.perEvent.push({ ts: intercept.ts, toolName: intercept.toolName, error: String(err && err.message || err) });
      continue;
    }

    const originalDecision = intercept.decision || 'allow';
    const replayDecision = decisionFromReplay(replayResp);
    const decisionChanged = originalDecision !== replayDecision;

    const originalIds = Array.isArray(intercept.matchIds) ? intercept.matchIds : [];
    const replayIds = principleIdsFromReplay(replayResp);
    const diff = symmetricDiff(originalIds, replayIds);
    const principleChanged = diff.onlyOriginal.length > 0 || diff.onlyReplay.length > 0;

    if (decisionChanged) summary.decisionDrift++;
    if (principleChanged) summary.principleDrift++;

    const wasVeto = posttool?.mistakeKind === 'user-veto';
    const wasSuccess = posttool?.success === true && !posttool?.mistakeKind;
    if (replayDecision === 'block' && wasVeto) summary.nowBlockingCorrectly++;
    if (replayDecision === 'allow' && wasSuccess) summary.nowAllowingCorrectly++;

    summary.perEvent.push({
      ts: intercept.ts,
      toolName: intercept.toolName,
      originalDecision,
      replayDecision,
      decisionChanged,
      principleDrift: diff,
      paired: posttool ? {
        success: posttool.success,
        mistakeKind: posttool.mistakeKind || null,
      } : null,
    });
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceMs = parseSinceCutoff(args.since);

  let files = args.paths.slice();
  if (files.length === 0) {
    files = listSessionFiles(args.sessionsDir, sinceMs);
  }
  if (files.length === 0) {
    if (!args.quiet) process.stderr.write('No session files found.\n');
    process.exit(0);
  }

  const reports = [];
  for (const file of files) {
    if (!args.quiet) process.stderr.write(`Replaying ${path.basename(file)}…\n`);
    try {
      reports.push(await replaySession(file, args));
    } catch (err) {
      reports.push({ file, error: String(err && err.message || err) });
    }
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    server: args.server,
    sessionCount: reports.length,
    totalIntercepts: reports.reduce((a, r) => a + (r.interceptCount || 0), 0),
    totalDecisionDrift: reports.reduce((a, r) => a + (r.decisionDrift || 0), 0),
    totalPrincipleDrift: reports.reduce((a, r) => a + (r.principleDrift || 0), 0),
    totalNowBlockingCorrectly: reports.reduce((a, r) => a + (r.nowBlockingCorrectly || 0), 0),
    totalNowAllowingCorrectly: reports.reduce((a, r) => a + (r.nowAllowingCorrectly || 0), 0),
    totalErrors: reports.reduce((a, r) => a + (r.errors || 0), 0),
    sessions: reports,
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
    process.stderr.write(`exp-replay-trajectory: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseSinceCutoff,
  readEvents,
  pairEvents,
  decisionFromReplay,
  principleIdsFromReplay,
  symmetricDiff,
  replaySession,
};
