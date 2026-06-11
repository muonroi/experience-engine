#!/usr/bin/env node
'use strict';

/**
 * exp-recall.js — active, agent-initiated recall of learned experience.
 *
 * Companion to passive hints: when an agent wants context mid-task ("what do
 * we know about X?"), it calls this instead of waiting for a hook. Hits
 * POST /api/recall, which runs the full scope-filtered + scored retrieval,
 * records a SURFACE event for each returned entry, and returns a formatted
 * index with [id col] handles. The agent then reports usefulness via
 * exp-feedback.js (followed/ignored/noise) so the pull reinforces precisely.
 *
 * Reads serverBaseUrl + serverAuthToken from ~/.experience/config.json so it
 * works on thin clients (raw curl to localhost:8082 no-ops on remote installs).
 *
 * Usage:
 *   node ~/.experience/exp-recall.js "how do we restart the api server"
 *   node ~/.experience/exp-recall.js --json "qdrant filter by project"
 *   node ~/.experience/exp-recall.js --project experience-engine "scope filter"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function readConfig(homeDir = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveServerConfig(homeDir = os.homedir()) {
  const config = readConfig(homeDir);
  const baseUrl = (config.serverBaseUrl || 'http://localhost:8082').replace(/\/+$/, '');
  const authToken = config.serverAuthToken || config.server?.authToken || '';
  return { baseUrl, authToken };
}

function usage() {
  return [
    'Usage:',
    '  exp-recall [--json] [--project <slug>] [--cwd <path>] [--session <id>] <query...>',
    '',
    'Examples:',
    '  exp-recall "how do we restart the experience-engine server"',
    '  exp-recall --project experience-engine "qdrant scope filter by project"',
    '  exp-recall --json "ssh deploy steps"',
  ].join('\n');
}

// Encode an absolute path the way Claude Code names its per-project transcript
// directory: every ':' and path separator collapses to '-'. e.g.
// "D:\\sources\\Core\\muonroi-cli" -> "D--sources-Core-muonroi-cli".
function encodeProjectDir(cwd) {
  return String(cwd || '').replace(/[:\\/]/g, '-');
}

// Resolve a STABLE per-session id to attribute this recall to a session, so the
// engine can later detect "agent ran N recalls in one session and stitched the
// results" (the runbook-candidate signal). Precedence:
//   1. explicit --session
//   2. $EXP_SESSION (set by the hook wrapper when available — the reliable path)
//   3. best-effort: newest *.jsonl transcript under the cwd's Claude project dir
//      (the active session's transcript is the most-recently-appended file)
//   4. null (unattributed — recall still works, just not session-grouped)
function resolveSessionId(opts = {}, env = process.env, homeDir = os.homedir()) {
  if (opts.session) return String(opts.session);
  if (env && env.EXP_SESSION) return String(env.EXP_SESSION);
  // Best-effort transcript probe. Intentionally swallow fs errors (no projects
  // dir, perms, etc.): session attribution is optional and must never break a
  // recall. Surfaced at debug level per the No-Silent-Catch rule.
  try {
    const cwd = opts.cwd || process.cwd();
    const dir = path.join(homeDir, '.claude', 'projects', encodeProjectDir(cwd));
    let newest = null;
    let newestMtime = -1;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newest = name.slice(0, -'.jsonl'.length);
      }
    }
    return newest;
  } catch (err) {
    if (env && env.EXP_RECALL_DEBUG) {
      console.error(`[exp-recall] session-id transcript probe failed: ${err?.message}`);
    }
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { ok: false, code: args.length === 0 ? 1 : 0, help: usage() };
  }
  const opts = { json: false, project: null, cwd: null, session: null };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--project') opts.project = args[++i] || null;
    else if (a === '--cwd') opts.cwd = args[++i] || null;
    else if (a === '--session') opts.session = args[++i] || null;
    else words.push(a);
  }
  const query = words.join(' ').trim();
  if (!query) return { ok: false, code: 1, help: usage() };
  return { ok: true, query, opts };
}

async function recall(query, opts = {}, homeDir = os.homedir()) {
  const { baseUrl, authToken } = resolveServerConfig(homeDir);
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const body = { query, cwd: opts.cwd || process.cwd() };
  if (opts.project) body.project_slug = opts.project;
  const sessionId = resolveSessionId(opts, process.env, homeDir);
  if (sessionId) body.sourceSession = sessionId;

  const res = await fetch(`${baseUrl}/api/recall`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(json?.error || text || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json || { text: null, entries: [], count: 0 };
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    if (parsed.help) console.log(parsed.help);
    process.exit(parsed.code ?? 1);
  }
  try {
    const result = await recall(parsed.query, parsed.opts);
    if (parsed.opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.text) {
      console.log(result.text);
    } else {
      console.log(`(no learned experience matched: ${JSON.stringify(parsed.query)})`);
    }
  } catch (error) {
    console.error(`exp-recall failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, resolveServerConfig, recall, resolveSessionId, encodeProjectDir };
