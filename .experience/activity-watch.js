#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LOG = path.join(os.homedir(), '.experience', 'activity.jsonl');
const args = process.argv.slice(2);

let logFile = DEFAULT_LOG;
let follow = false;
let json = false;
let compact = false;
let showAll = false;
let tailCount = 40;
let headerPrinted = false;

const COLUMN_WIDTHS = {
  time: 8,
  flow: 9,
  stage: 15,
  tool: 11,
  res: 5,
  surf: 5,
  route: 12,
  session: 10,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--follow') follow = true;
  else if (arg === '--json') json = true;
  else if (arg === '--compact') compact = true;
  else if (arg === '--all') showAll = true;
  else if (arg === '--file' && args[i + 1]) logFile = args[++i];
  else if (arg === '--tail' && args[i + 1]) tailCount = Math.max(1, parseInt(args[++i], 10) || 40);
}

const color = (() => {
  const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = code => text => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    dim: wrap('2'),
    cyan: wrap('36'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    blue: wrap('34'),
  };
})();

function shortSession(session) {
  return session ? String(session).slice(0, 8) : '-';
}

function hhmmss(ts) {
  const d = new Date(ts || Date.now());
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toISOString().slice(11, 19);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function pad(text, width) {
  const s = String(text ?? '');
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function cut(text, width) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + '…';
}

function screenWidth() {
  return Math.max(process.stdout.columns || 120, 72);
}

function wrapText(text, width) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (width <= 8) return [normalized];

  const words = normalized.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      if (word.length <= width) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      }
      continue;
    }

    if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
      continue;
    }

    lines.push(current);
    if (word.length <= width) {
      current = word;
      continue;
    }

    current = '';
    for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
  }

  if (current) lines.push(current);
  return lines;
}

function detailLabel(label, value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? `${label}: ${text}` : '';
}

function summarizeHits(entry) {
  const hits = Array.isArray(entry?.surfaced) ? entry.surfaced : [];
  if (hits.length === 0) return '';
  return hits
    .map(hit => {
      const collection = hit.collection || '?';
      const point = hit.pointId || hit.id || '?';
      return `${collection}:${point}`;
    })
    .join(', ');
}

function renderRow(columns, detailLines) {
  const prefix = columns.join(' ');
  const details = detailLines.filter(Boolean);
  if (details.length === 0) return prefix;

  const available = Math.max(20, screenWidth() - prefix.length - 1);
  if (compact) return `${prefix} ${cut(details.join(' | '), available)}`;

  const rendered = [prefix];
  const indent = ' '.repeat(prefix.length + 1);
  for (const detail of details) {
    for (const wrapped of wrapText(detail, available)) {
      rendered.push(indent + wrapped);
    }
  }
  return rendered.join('\n');
}

function printHeader() {
  if (json || headerPrinted) return;
  headerPrinted = true;
  const header = [
    pad('TIME', COLUMN_WIDTHS.time),
    pad('FLOW', COLUMN_WIDTHS.flow),
    pad('STAGE', COLUMN_WIDTHS.stage),
    pad('TOOL', COLUMN_WIDTHS.tool),
    pad('RES', COLUMN_WIDTHS.res),
    pad('SURF', COLUMN_WIDTHS.surf),
    pad('ROUTE', COLUMN_WIDTHS.route),
    pad('SESSION', COLUMN_WIDTHS.session),
    'CONTEXT',
  ].join(' ');
  process.stdout.write(color.dim(header) + '\n');
}

function stageColor(stage) {
  if (/error|spawn_error/.test(stage || '')) return color.red;
  if (/done|state_written|route_written|judge_spawned/.test(stage || '')) return color.green;
  if (/parsed|search_done/.test(stage || '')) return color.cyan;
  if (/skip|budget_capped|stale|abort/.test(stage || '')) return color.yellow;
  return x => x;
}

function normalizeHookName(hook) {
  if (hook === 'interceptor') return 'pretool';
  if (hook === 'interceptor-post') return 'posttool';
  if (hook === 'interceptor-prompt') return 'prompt';
  return hook || '-';
}

function routeLabel(entry) {
  if (entry.routeTier && entry.routeModel) return `${entry.routeTier}/${entry.routeModel}`;
  if (entry.routeTier) return entry.routeTier;
  if (entry.routeModel) return entry.routeModel;
  if (entry.route) return entry.route;
  return '-';
}

function buildColumns(flow, stage, tool, res, surf, route, session) {
  return [
    color.dim(pad(hhmmss(flow.ts), COLUMN_WIDTHS.time)),
    flow.label,
    stageColor(stage)(pad(stage, COLUMN_WIDTHS.stage)),
    color.blue(pad(tool || '-', COLUMN_WIDTHS.tool)),
    pad(res, COLUMN_WIDTHS.res),
    pad(surf, COLUMN_WIDTHS.surf),
    pad(route, COLUMN_WIDTHS.route),
    color.dim(pad(shortSession(session), COLUMN_WIDTHS.session)),
  ];
}

function formatHook(entry) {
  const hook = normalizeHookName(entry.hook);
  const stage = entry.stage || '-';
  if (!showAll && ['stdin_end', 'skip', 'no_state_file', 'no_surfaced_ids'].includes(stage)) return null;

  const res = typeof entry.hasSuggestions === 'boolean'
    ? (entry.hasSuggestions ? 'warn' : 'none')
    : typeof entry.hasResult === 'boolean'
      ? yesNo(entry.hasResult)
      : '-';

  const details = [
    detailLabel('action', entry.query),
    typeof entry.promptLen === 'number' ? `prompt-len: ${entry.promptLen}` : '',
    detailLabel('hits', summarizeHits(entry)),
    detailLabel('state', entry.stateFile),
    detailLabel('queue', entry.queueFile),
    detailLabel('outcome', entry.toolOutcome),
    detailLabel('route-source', entry.routeSource),
    detailLabel('runtime', entry.sourceRuntime),
    !compact ? detailLabel('preview', entry.preview) : '',
  ];

  const columns = buildColumns(
    { ts: entry.ts, label: color.magenta(pad(hook, COLUMN_WIDTHS.flow)) },
    stage,
    entry.tool,
    res,
    typeof entry.surfacedCount === 'number' ? entry.surfacedCount : '-',
    routeLabel(entry),
    entry.sourceSession
  );

  return renderRow(columns, details);
}

function formatIntercept(entry) {
  const stage = entry.stage || 'intercept';
  if (!showAll && stage !== 'search_done' && stage !== 'budget_capped') return null;

  const details = [
    detailLabel('action', entry.query),
    Array.isArray(entry.scores) && entry.scores.length > 0
      ? `scores: ${entry.scores.map(s => Number(s).toFixed(2)).join(', ')}`
      : '',
    detailLabel('hits', summarizeHits(entry)),
    detailLabel('project', entry.project),
    detailLabel('route-source', entry.routeSource),
    detailLabel('runtime', entry.sourceRuntime),
  ];

  const columns = buildColumns(
    { ts: entry.ts, label: color.cyan(pad('lookup', COLUMN_WIDTHS.flow)) },
    stage,
    entry.tool,
    typeof entry.hasResult === 'boolean' ? yesNo(entry.hasResult) : '-',
    typeof entry.surfacedCount === 'number' ? entry.surfacedCount : '-',
    routeLabel(entry),
    entry.sourceSession
  );

  return renderRow(columns, details);
}

function formatFeedback(entry) {
  if (!showAll && ['brain-filter', 'judge-feedback'].includes(entry.op)) return null;

  const details = [
    detailLabel('action', entry.action),
    entry.collection || entry.pointId ? `target: ${(entry.collection || '?')}:${entry.pointId || '?'}` : '',
    typeof entry.followed === 'boolean' ? `followed: ${yesNo(entry.followed)}` : '',
    detailLabel('verdict', entry.verdict),
    detailLabel('reason', entry.reason),
    detailLabel('message', entry.msg || entry.message),
    detailLabel('outcome', entry.toolOutcome),
    detailLabel('runtime', entry.sourceRuntime),
  ];

  const columns = buildColumns(
    { ts: entry.ts, label: color.yellow(pad('event', COLUMN_WIDTHS.flow)) },
    entry.op || 'event',
    entry.tool,
    '-',
    '-',
    '-',
    entry.sourceSession
  );

  return renderRow(columns, details);
}

function formatEntry(entry) {
  if (json) return JSON.stringify(entry);
  if (entry.op === 'hook') return formatHook(entry);
  if (entry.op === 'intercept') return formatIntercept(entry);
  return formatFeedback(entry);
}

function emitLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const entry = JSON.parse(trimmed);
    const formatted = formatEntry(entry);
    if (formatted) process.stdout.write(formatted + '\n');
  } catch {
    if (showAll) process.stdout.write(trimmed + '\n');
  }
}

function readLastLines(file, count) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

function followFile(file) {
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    offset = 0;
  }

  setInterval(() => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    const stream = fs.createReadStream(file, { encoding: 'utf8', start: offset, end: stat.size });
    let chunk = '';
    stream.on('data', data => { chunk += data; });
    stream.on('end', () => {
      offset = stat.size;
      chunk.split('\n').forEach(emitLine);
    });
  }, 500);
}

printHeader();
readLastLines(logFile, tailCount).forEach(emitLine);
if (follow) {
  process.stdout.write(color.dim(`Watching ${logFile}\n`));
  followFile(logFile);
}
