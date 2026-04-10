#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const home = require('os').homedir();
const { extractFromSession, evolve } = require(home + '/.experience/experience-core.js');
const MARKER = home + '/.experience/.stop-marker.json';
const MIN_NEW_LINES = 8;

/**
 * Extract project slug from session path.
 * Session paths look like: ~/.claude/projects/D--sources-Core/.../session.jsonl
 * The segment after "projects/" is the project slug.
 */
function extractProjectSlug(sessionPath) {
  if (!sessionPath) return null;
  const norm = sessionPath.replace(/\\/g, '/');
  const match = norm.match(/\.claude\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

async function main() {
  const log = findCurrentSession();
  if (!log) return;
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  let marker = {};
  try { marker = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch {}
  const start = marker.file === log ? (marker.line || 0) : 0;
  const newLines = lines.slice(start);
  if (newLines.length < MIN_NEW_LINES) return;
  const transcript = newLines.map(l => {
    try {
      const e = JSON.parse(l);
      const c = e.message?.content;
      if (!c) return '';
      if (typeof c === 'string') return c.slice(0, 300);
      if (Array.isArray(c)) return c.map(b => b.text || '').filter(Boolean).join(' ').slice(0, 300);
      return '';
    } catch { return ''; }
  }).filter(Boolean).join('\n');

  const projectSlug = extractProjectSlug(log);
  const count = await extractFromSession(transcript, projectSlug);
  fs.writeFileSync(MARKER, JSON.stringify({ file: log, line: lines.length }));
  if (count > 0) process.stderr.write('Experience: +' + count + ' lessons\n');

  try {
    const evolveMarker = home + '/.experience/.evolve-marker';
    let lastEvolve = 0;
    try { lastEvolve = JSON.parse(fs.readFileSync(evolveMarker, 'utf8')).ts || 0; } catch {}
    if (Date.now() - lastEvolve > 86400000) {
      const r = await evolve('auto');
      fs.writeFileSync(evolveMarker, JSON.stringify({ ts: Date.now() }));
      const total = r.promoted + r.abstracted + r.demoted + r.archived;
      if (total > 0) process.stderr.write('Evolution: +' + r.promoted + ' promoted, ' + r.abstracted + ' abstracted, ' + r.demoted + ' demoted, ' + r.archived + ' archived\n');
    }
  } catch {}
}

function findCurrentSession() {
  const dir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(dir)) return null;
  let latest = null, t = 0;
  const walk = d => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.jsonl') && fs.statSync(f).mtimeMs > t) {
          t = fs.statSync(f).mtimeMs;
          latest = f;
        }
      }
    } catch {}
  };
  walk(dir);
  return latest && (Date.now() - t) < 600000 ? latest : null;
}

main().catch(() => {}).finally(() => process.exit(0));
