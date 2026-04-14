#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const stop = require('../.experience/stop-extractor.js');
const { compactTranscript } = require('../.experience/extract-compact.js');

function parseArgs(argv) {
  const args = {
    runtime: 'codex',
    days: 7,
    limit: 10,
    dryRun: false,
    homeDir: os.homedir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime' && argv[i + 1]) args.runtime = argv[++i];
    else if (arg === '--days' && argv[i + 1]) args.days = Number(argv[++i]) || args.days;
    else if (arg === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]) || args.limit;
    else if (arg === '--home' && argv[i + 1]) args.homeDir = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

function loadConfig(homeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function walkSessions(rootDir, matcher) {
  const found = [];
  if (!fs.existsSync(rootDir)) return found;
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !matcher(entry.name, filePath)) continue;
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      found.push({ file: filePath, mtimeMs: stat.mtimeMs });
    }
  };
  visit(rootDir);
  return found;
}

function findSessions(runtime, homeDir, days, limit) {
  const cutoff = Date.now() - days * 86400000;
  let sessions = [];
  if (runtime === 'codex' || runtime === 'all') {
    sessions.push(...walkSessions(
      path.join(homeDir, '.codex', 'sessions'),
      (name) => /^rollout-.*\.jsonl$/i.test(name)
    ).map((item) => ({ ...item, runtime: 'codex', projectPath: null })));
  }
  if (runtime === 'claude' || runtime === 'all') {
    sessions.push(...walkSessions(
      path.join(homeDir, '.claude', 'projects'),
      (name) => name.endsWith('.jsonl')
    ).map((item) => ({ ...item, runtime: 'claude', projectPath: stop.extractProjectSlug(item.file) })));
  }
  return sessions
    .filter((item) => item.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

async function postExtract(config, homeDir, transcript, projectPath, sourceSession) {
  const serverBase = String(config.serverBaseUrl || '').replace(/\/$/, '');
  if (serverBase) {
    const headers = { 'Content-Type': 'application/json' };
    const token = config.serverAuthToken || config.server?.authToken || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${serverBase}/api/extract`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transcript,
        projectPath,
        sourceKind: 'replay-tool',
        sourceRuntime: 'history-replay',
        sourceSession,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`extract HTTP ${res.status}`);
    return res.json();
  }

  const core = require(path.join(homeDir, '.experience', 'experience-core.js'));
  const stored = await core.extractFromSession(transcript, projectPath);
  return { stored };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.homeDir);
  const sessions = findSessions(args.runtime, args.homeDir, args.days, args.limit);
  const results = [];

  for (const session of sessions) {
    const data = stop.buildSessionData(session, 0);
    const transcript = compactTranscript(data.transcript);
    if (!transcript || transcript.length < 100) {
      results.push({ session: session.file, runtime: session.runtime, stored: 0, skipped: 'empty-transcript' });
      continue;
    }
    if (args.dryRun) {
      results.push({
        session: session.file,
        runtime: session.runtime,
        stored: null,
        skipped: null,
        transcriptChars: transcript.length,
        projectPath: data.projectPath || session.projectPath || null,
      });
      continue;
    }
    try {
      const response = await postExtract(config, args.homeDir, transcript, data.projectPath || session.projectPath || null, session.file);
      results.push({
        session: session.file,
        runtime: session.runtime,
        stored: response?.stored ?? 0,
        projectPath: data.projectPath || session.projectPath || null,
      });
    } catch (error) {
      results.push({
        session: session.file,
        runtime: session.runtime,
        stored: 0,
        error: error.message || String(error),
      });
    }
  }

  const summary = {
    replayed: results.length,
    stored: results.reduce((sum, item) => sum + (item.stored || 0), 0),
    results,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  });
}
