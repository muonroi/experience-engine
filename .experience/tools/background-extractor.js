#!/usr/bin/env node
/**
 * background-extractor.js — Periodic background job that replaces stop-hooks.
 *
 * Runs as a cron job or Task Scheduler task. On each invocation:
 * 1. Scans all Claude/Codex/Gemini sessions for new content since last run
 * 2. Extracts experiences via detectExperience() + LLM
 * 3. Stores to brain (remote VPS or local Qdrant)
 * 4. Updates marker so only new content is processed next run
 *
 * Replaces the need for:
 * - stop-hook (misses X-close, crash, /clear)
 * - session-start backfill (limited to 5 sessions, races with agent)
 * - custom hooks per agent runtime
 *
 * Setup (Windows Task Scheduler):
 *   schtasks /create /sc MINUTE /mo 30 /tn "ExperienceExtractor" /tr "node %USERPROFILE%\.experience\tools\background-extractor.js"
 *
 * Setup (cron on Linux/macOS):
 *   */30 * * * * node ~/.experience/tools/background-extractor.js >> ~/.experience/logs/background-extract.log 2>&1
 *
 * Or run continuously with --watch:
 *   node tools/background-extractor.js --watch --interval 1800
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const expDir = fs.existsSync(path.join(__dirname, '..', 'src', 'context.js'))
  ? path.resolve(__dirname, '..')
  : path.join(homeDir, '.experience');

const { compactTranscript } = require(path.join(expDir, 'extract-compact.js'));
const { detectExperience } = require(path.join(expDir, 'src/context.js'));
const {
  findAllRecentSessions,
  buildSessionData,
  readMarker,
  writeMarker,
} = require(path.join(expDir, 'stop-extractor.js'));

let _remote = null;
function getRemote() {
  if (_remote !== null) return _remote;
  try { _remote = require(path.join(expDir, 'remote-client.js')); } catch { _remote = false; }
  return _remote || null;
}

let _core = null;
function getCore() {
  if (!_core) _core = require(path.join(expDir, 'experience-core.js'));
  return _core;
}

function parseArgs() {
  const args = {
    maxPerRun: 20,
    watch: false,
    intervalSec: 1800,
    maxAge: '7d',
    verbose: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) args.maxPerRun = parseInt(argv[++i], 10);
    if (argv[i] === '--watch') args.watch = true;
    if (argv[i] === '--interval' && argv[i + 1]) args.intervalSec = parseInt(argv[++i], 10);
    if (argv[i] === '--max-age' && argv[i + 1]) args.maxAge = argv[++i];
    if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true;
    if (argv[i] === '--help') {
      console.log('Usage: background-extractor.js [--max N] [--watch] [--interval SEC] [--max-age 7d] [-v]');
      process.exit(0);
    }
  }
  return args;
}

function parseMaxAge(str) {
  const m = String(str).match(/^(\d+)\s*(d|h)?$/i);
  if (!m) return 7 * 86_400_000;
  const n = parseInt(m[1], 10);
  return (m[2] || 'd').toLowerCase() === 'h' ? n * 3_600_000 : n * 86_400_000;
}

const LOG_PATH = path.join(expDir, 'logs', 'background-extract.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

async function extractAndStore(transcript, projectPath, meta) {
  if (!transcript) return 0;
  const remote = getRemote();
  if (remote) {
    const config = remote.loadConfig(homeDir);
    if (remote.isRemoteEnabled(config)) {
      const body = {
        transcript,
        projectPath,
        sourceKind: 'background-extract',
        sourceRuntime: meta?.runtime || 'unknown',
      };
      if (meta?.lang) body.lang = meta.lang;
      if (meta?.framework) body.framework = meta.framework;
      try {
        const result = await remote.postJson('/api/extract', body, { homeDir, config, timeoutMs: 30000 });
        return result?.stored || 0;
      } catch { return 0; }
    }
  }
  try {
    const { extractFromSession } = getCore();
    return await extractFromSession(transcript, projectPath, meta);
  } catch { return 0; }
}

function enrichMeta(projectPath) {
  try {
    const enrichPath = path.join(expDir, 'source-meta-enrich.js');
    if (fs.existsSync(enrichPath) && projectPath) {
      return require(enrichPath).enrichSourceMeta(null, undefined, projectPath) || {};
    }
  } catch {}
  return {};
}

async function runOnce(args) {
  const maxAgeMs = parseMaxAge(args.maxAge);
  const sessions = findAllRecentSessions(homeDir, Date.now(), maxAgeMs)
    .filter(s => !s.file.includes('subagent'));

  const marker = readMarker(homeDir);
  const newSessions = sessions.filter(s => {
    const prev = marker.files[s.file];
    if (!prev) return true;
    try {
      const stat = fs.statSync(s.file);
      return stat.size > 5000 && (prev.line || 0) < stat.size;
    } catch { return false; }
  }).slice(0, args.maxPerRun);

  if (newSessions.length === 0) {
    if (args.verbose) log('No new sessions to process');
    return { processed: 0, stored: 0, errors: 0 };
  }

  log(`Processing ${newSessions.length} new sessions`);
  let processed = 0, stored = 0, errors = 0;

  for (const session of newSessions) {
    try {
      const sessionData = buildSessionData(session, marker.files[session.file]?.line || 0);
      const transcript = compactTranscript(sessionData.transcript);
      if (!transcript || transcript.length < 200) {
        marker.files[session.file] = { line: sessionData.totalLines, extractedAt: new Date().toISOString() };
        continue;
      }

      const experiences = detectExperience(transcript);
      if (experiences.length === 0) {
        marker.files[session.file] = { line: sessionData.totalLines, extractedAt: new Date().toISOString() };
        processed++;
        continue;
      }

      const meta = enrichMeta(session.projectPath || session.file);
      const count = await extractAndStore(transcript, session.projectPath || session.file, {
        ...meta,
        runtime: session.runtime,
      });

      marker.files[session.file] = { line: sessionData.totalLines, extractedAt: new Date().toISOString() };
      stored += count;
      processed++;

      const byType = {};
      for (const e of experiences) byType[e.type] = (byType[e.type] || 0) + 1;
      if (args.verbose || count > 0) {
        log(`  ${session.runtime}:${path.basename(session.file).slice(0, 12)} → ${experiences.length} exp, ${count} stored [${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ')}]`);
      }
    } catch (err) {
      errors++;
      marker.files[session.file] = { line: 0, error: err.message, extractedAt: new Date().toISOString() };
    }
  }

  writeMarker(homeDir, marker);
  log(`Done: ${processed} processed, ${stored} stored, ${errors} errors`);
  return { processed, stored, errors };
}

async function main() {
  const args = parseArgs();

  if (args.watch) {
    log(`Starting watch mode (interval: ${args.intervalSec}s, max-per-run: ${args.maxPerRun})`);
    while (true) {
      try {
        await runOnce(args);
      } catch (err) {
        log(`ERROR: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, args.intervalSec * 1000));
    }
  } else {
    await runOnce(args);
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
