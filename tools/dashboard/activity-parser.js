'use strict';

/**
 * activity-parser.js — stream-read ~/.experience/activity.jsonl[.N].
 *
 * Yields typed events:
 *   { kind, ts, raw }   where kind ∈ KNOWN_KINDS, raw = original parsed object
 *
 * Files are processed oldest-first (activity.jsonl.1 before activity.jsonl)
 * so consumers see chronological order. Lines that fail JSON parse are
 * skipped silently — activity logs may contain partial trailing writes.
 *
 * Zero deps — Node built-ins only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const KNOWN_KINDS = new Set([
  'intercept',          // hint surface attempt (may surface 0 or N matches)
  'posttool',           // posttool outcome — has surfacedCount + toolOutcome
  'feedback',           // FOLLOWED / IGNORED / IRRELEVANT verdict
  'implicit-touch',     // surfaced hint matched the next action (relevant)
  'implicit-unused',    // surfaced hint did not match (irrelevant) + reason
  'relevance-gate',     // pre-surface gate dropped N mismatched candidates
  'extract',            // QA entry extracted from session
  'extract-skip',
  'extract-merge',
  'evolve',             // generic evolve step
  'evolve-reject',
  'evolve-t0-demote',
  'evolve-repair-abs-orphan',
  'evolve-auto-supersede',
  'edge-create',        // graph edge added
  'mistake-seen',       // mistake detector signal
  'noise-suppressed',   // entry suppressed by anti-noise filter
  'noise-disposition',
  'brain',              // brain LLM call (cost-call sibling)
  'cost-call',          // brain provider cost event
]);

function parseSinceMs(spec) {
  // accepts "30d" | "7d" | "12h" | "90m" | number-of-ms
  if (spec == null) return null;
  if (typeof spec === 'number') return spec;
  const m = String(spec).trim().match(/^(\d+)\s*(ms|m|h|d)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'ms').toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  if (unit === 'd') return n * 86_400_000;
  return null;
}

function resolveLogFiles(homeDir) {
  const dir = path.join(homeDir, '.experience');
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir)
    .filter((f) => f === 'activity.jsonl' || /^activity\.jsonl\.\d+$/.test(f));
  // Oldest first: .2 before .1 before bare. Higher suffix = older rotation.
  const ranked = all.map((f) => {
    const m = f.match(/\.jsonl(?:\.(\d+))?$/);
    return { name: f, rank: m && m[1] ? -parseInt(m[1], 10) : 0 };
  });
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((r) => path.join(dir, r.name));
}

function detectKind(obj) {
  const op = obj && (obj.op || obj.kind || obj.type);
  if (!op) return null;
  return KNOWN_KINDS.has(op) ? op : 'other';
}

/**
 * Async generator. Yields events from oldest to newest across all log
 * files. Honours `opts.since` (string like "30d" or epoch-ms number) to
 * skip events older than the cutoff.
 *
 * @param {{ homeDir?: string, since?: string|number, files?: string[] }} opts
 * @returns {AsyncGenerator<{kind: string, ts: string, tsMs: number, raw: object}>}
 */
async function* streamEvents(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const files = opts.files || resolveLogFiles(homeDir);
  const sinceMs = parseSinceMs(opts.since);
  const cutoffMs = sinceMs != null ? Date.now() - sinceMs : null;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const kind = detectKind(obj);
      if (!kind) continue;
      const ts = obj.ts || obj.timestamp;
      const tsMs = ts ? Date.parse(ts) : NaN;
      if (cutoffMs != null && Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
      yield { kind, ts: ts || null, tsMs: Number.isFinite(tsMs) ? tsMs : null, raw: obj };
    }
  }
}

/**
 * Convenience: collect all events into memory. For dashboards over 30d
 * this is a few MB at most.
 */
async function collectEvents(opts = {}) {
  const out = [];
  for await (const ev of streamEvents(opts)) out.push(ev);
  return out;
}

module.exports = {
  KNOWN_KINDS,
  streamEvents,
  collectEvents,
  resolveLogFiles,
  parseSinceMs,
  detectKind,
};
