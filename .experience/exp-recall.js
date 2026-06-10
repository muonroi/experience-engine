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
    '  exp-recall [--json] [--project <slug>] [--cwd <path>] <query...>',
    '',
    'Examples:',
    '  exp-recall "how do we restart the experience-engine server"',
    '  exp-recall --project experience-engine "qdrant scope filter by project"',
    '  exp-recall --json "ssh deploy steps"',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { ok: false, code: args.length === 0 ? 1 : 0, help: usage() };
  }
  const opts = { json: false, project: null, cwd: null };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--project') opts.project = args[++i] || null;
    else if (a === '--cwd') opts.cwd = args[++i] || null;
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

module.exports = { parseArgs, resolveServerConfig, recall };
