#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_NOISE_REASONS = new Set(['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule']);

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
    '  exp-feedback followed <pointId> <collection>',
    '  exp-feedback ignored <pointId> <collection>',
    '  exp-feedback noise <pointId> <collection> <wrong_repo|wrong_language|wrong_task|stale_rule>',
    '',
    'Examples:',
    '  exp-feedback ignored a1b2c3d4 experience-behavioral',
    '  exp-feedback noise a1b2c3d4 experience-selfqa wrong_task',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { ok: false, code: 0, help: usage() };
  }

  const [command, pointId, collection, reason] = args;
  if (!command || !pointId || !collection) {
    return { ok: false, code: 1, help: usage() };
  }

  const normalized = String(command).trim().toLowerCase();
  if (normalized === 'followed') {
    return { ok: true, payload: { pointId, collection, verdict: 'FOLLOWED' } };
  }
  if (normalized === 'ignored') {
    return { ok: true, payload: { pointId, collection, verdict: 'IGNORED' } };
  }
  if (normalized === 'noise' || normalized === 'irrelevant') {
    if (!reason || !VALID_NOISE_REASONS.has(reason)) {
      return {
        ok: false,
        code: 1,
        help: `Invalid noise reason.\n${usage()}`,
      };
    }
    return { ok: true, payload: { pointId, collection, verdict: 'IRRELEVANT', reason } };
  }

  return { ok: false, code: 1, help: usage() };
}

async function sendFeedback(payload, homeDir = os.homedir()) {
  const { baseUrl, authToken } = resolveServerConfig(homeDir);
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const message = json?.error || text || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return json || { ok: true };
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    if (parsed.help) console.log(parsed.help);
    process.exit(parsed.code ?? 1);
  }

  try {
    const result = await sendFeedback(parsed.payload);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`exp-feedback failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  VALID_NOISE_REASONS,
  parseArgs,
  resolveServerConfig,
  sendFeedback,
};
