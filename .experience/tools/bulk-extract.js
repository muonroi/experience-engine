#!/usr/bin/env node
/**
 * bulk-extract.js — Extract experiences from ALL local Claude sessions
 * and store them into the brain via the remote API or local Qdrant.
 *
 * Usage:
 *   node tools/bulk-extract.js                   # process all sessions (newest first, max 50)
 *   node tools/bulk-extract.js --max 100         # up to 100 sessions
 *   node tools/bulk-extract.js --dry-run         # detect only, don't store
 *   node tools/bulk-extract.js --min-size 10000  # skip sessions < 10KB
 *   node tools/bulk-extract.js --project muonroi-cli  # filter by project slug
 *   node tools/bulk-extract.js --reset-marker    # ignore previous extraction markers
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const homeDir = os.homedir();
// Resolve .experience dir: prefer repo-local (tools/ is inside .experience/tools/),
// fall back to ~/.experience for VPS installs.
const expDir = fs.existsSync(path.join(__dirname, '..', 'src', 'context.js'))
  ? path.resolve(__dirname, '..')
  : path.join(homeDir, '.experience');

const { compactTranscript } = require(path.join(expDir, 'extract-compact.js'));
const { detectExperience } = require(path.join(expDir, 'src/context.js'));

let _core = null;
function getCore() {
  if (!_core) _core = require(path.join(expDir, 'experience-core.js'));
  return _core;
}

let _remote = null;
function getRemote() {
  if (_remote !== null) return _remote;
  try { _remote = require(path.join(expDir, 'remote-client.js')); } catch { _remote = false; }
  return _remote || null;
}

function parseArgs() {
  const args = { max: 50, dryRun: false, minSize: 5000, project: null, resetMarker: false, verbose: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) args.max = parseInt(argv[++i], 10);
    if (argv[i] === '--min-size' && argv[i + 1]) args.minSize = parseInt(argv[++i], 10);
    if (argv[i] === '--project' && argv[i + 1]) args.project = argv[++i].toLowerCase();
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--reset-marker') args.resetMarker = true;
    if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true;
    if (argv[i] === '--help') {
      console.log('Usage: bulk-extract.js [--max N] [--dry-run] [--min-size N] [--project slug] [--reset-marker] [-v]');
      process.exit(0);
    }
  }
  return args;
}

function findAllClaudeSessions(minSize, projectFilter) {
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const sessions = [];
  for (const dir of fs.readdirSync(projectsDir)) {
    const fullDir = path.join(projectsDir, dir);
    let stat;
    try { stat = fs.statSync(fullDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    // Skip worktree and subagent dirs
    if (dir.includes('worktree') || dir.includes('subagent')) continue;

    const projectSlug = extractProjectSlug(dir);
    if (projectFilter && projectSlug && !projectSlug.includes(projectFilter)) continue;

    for (const file of fs.readdirSync(fullDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(fullDir, file);
      let fstat;
      try { fstat = fs.statSync(fullPath); } catch { continue; }
      if (fstat.size < minSize) continue;

      sessions.push({
        path: fullPath,
        projectDir: dir,
        projectSlug,
        size: fstat.size,
        modified: fstat.mtime,
        sessionId: file.replace('.jsonl', ''),
      });
    }
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

function extractProjectSlug(dirName) {
  // D--sources-Core-muonroi-cli → muonroi-cli
  const parts = dirName.replace(/^[A-Z]--/, '').split('-');
  // Find last meaningful segment
  const meaningful = dirName.split(/-{2,}/).pop() || dirName;
  return meaningful.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function buildTranscriptFromJsonl(logPath) {
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const transcriptLines = [];

  for (const rawLine of lines) {
    let entry;
    try { entry = JSON.parse(rawLine); } catch { continue; }
    const content = entry.message?.content;
    const role = entry.message?.role;
    if (!content) continue;

    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'text' || typeof block.text === 'string') {
        const text = String(block.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!text) continue;
        transcriptLines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
        continue;
      }
      if (block.type === 'tool_use' && block.name) {
        const args = block.input || {};
        const tool = block.name.replace(/^mcp__\w+__/, '');
        let summary = '';
        if (tool === 'Edit' || tool === 'edit') {
          const target = args.file_path || args.path || '';
          const oldStr = args.old_string || '';
          const newStr = args.new_string || '';
          const oldSnip = oldStr ? `old="${String(oldStr).replace(/\s+/g, ' ').trim().slice(0, 80)}" ` : '';
          const newSnip = newStr ? `new="${String(newStr).replace(/\s+/g, ' ').trim().slice(0, 80)}"` : '';
          summary = `${target} ${oldSnip}${newSnip}`.trim();
        } else if (tool === 'Bash' || tool === 'bash' || tool === 'PowerShell') {
          summary = String(args.command || args.cmd || '').slice(0, 300);
        } else if (tool === 'Write' || tool === 'write_file') {
          summary = String(args.file_path || args.path || '').slice(0, 200);
        } else {
          summary = String(args.file_path || args.path || JSON.stringify(args || {})).slice(0, 200);
        }
        transcriptLines.push(`ToolCall ${tool}: ${summary.slice(0, 400)}`);
        continue;
      }
      if (block.type === 'tool_result') {
        const resultContent = Array.isArray(block.content)
          ? block.content.map(c => c.text || '').filter(Boolean).join(' ')
          : String(block.content || '');
        const text = resultContent.replace(/\s+/g, ' ').trim().slice(0, 600);
        if (text) transcriptLines.push(`ToolOutput: ${text}`);
      }
    }
  }
  return transcriptLines.join('\n');
}

// Dedup within bulk run
const seenHashes = new Set();
function dedupHash(exp) {
  const key = `${exp.type || ''}:${exp.context || ''}:${(exp.excerpt || '').slice(0, 200)}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// Marker for tracking which sessions have been bulk-extracted
const MARKER_PATH = path.join(expDir, '.bulk-extract-marker.json');

function readBulkMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); } catch { return { files: {} }; }
}

function writeBulkMarker(marker) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function extractAndStore(transcript, projectPath, meta, dryRun) {
  if (dryRun || !transcript) return 0;

  // Use remote API if configured (thin client → VPS brain)
  const remote = getRemote();
  if (remote) {
    const config = remote.loadConfig(homeDir);
    if (remote.isRemoteEnabled(config)) {
      const body = {
        transcript,
        projectPath,
        sourceKind: 'bulk-extract',
        sourceRuntime: 'claude',
      };
      if (meta?.lang) body.lang = meta.lang;
      if (meta?.framework) body.framework = meta.framework;
      try {
        const result = await remote.postJson('/api/extract', body, { homeDir, config, timeoutMs: 30000 });
        return result?.stored || 0;
      } catch (err) {
        if (meta?.verbose) console.error(`    remote error:`, err.message);
        return 0;
      }
    }
  }

  // Local path — requires brain LLM + Qdrant accessible locally
  try {
    const { extractFromSession } = getCore();
    return await extractFromSession(transcript, projectPath, meta);
  } catch (err) {
    if (meta?.verbose) console.error(`    local error:`, err.message);
    return 0;
  }
}

function enrichMeta(projectPath) {
  try {
    const enrichPath = path.join(expDir, 'source-meta-enrich.js');
    if (fs.existsSync(enrichPath) && projectPath) {
      const enrich = require(enrichPath);
      return enrich.enrichSourceMeta(null, undefined, projectPath) || {};
    }
  } catch {}
  return {};
}

async function main() {
  const args = parseArgs();
  const startMs = Date.now();

  console.log(`[bulk-extract] Scanning Claude sessions...`);
  console.log(`  max: ${args.max}, min-size: ${args.minSize}, dry-run: ${args.dryRun}`);
  if (args.project) console.log(`  filter: ${args.project}`);

  const sessions = findAllClaudeSessions(args.minSize, args.project);
  console.log(`  Found ${sessions.length} sessions`);

  const marker = args.resetMarker ? { files: {} } : readBulkMarker();
  const toProcess = sessions.filter(s => !marker.files[s.path]).slice(0, args.max);
  console.log(`  To process: ${toProcess.length} (${sessions.length - toProcess.length} already done)`);

  let totalExperiences = 0;
  let totalStored = 0;
  let totalSessions = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const session = toProcess[i];
    const label = `[${i + 1}/${toProcess.length}]`;

    try {
      const rawTranscript = buildTranscriptFromJsonl(session.path);
      const transcript = compactTranscript(rawTranscript);
      if (!transcript || transcript.length < 200) {
        marker.files[session.path] = { ts: Date.now(), skip: 'too-short' };
        continue;
      }

      const experiences = detectExperience(transcript);
      totalExperiences += experiences.length;

      const byType = {};
      for (const e of experiences) byType[e.type] = (byType[e.type] || 0) + 1;
      const typeStr = Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ');

      console.log(`${label} ${session.projectSlug || session.projectDir.slice(0, 30)} (${(session.size / 1024).toFixed(0)}KB) → ${experiences.length} exp [${typeStr || 'none'}]`);

      if (experiences.length > 0) {
        const meta = enrichMeta(session.path);
        const stored = await extractAndStore(transcript, session.path, {
          ...meta,
          projectSlug: session.projectSlug,
          verbose: args.verbose,
        }, args.dryRun);
        totalStored += stored;
        if (stored > 0) console.log(`  → stored ${stored}`);
      }

      totalSessions++;
      marker.files[session.path] = { ts: Date.now(), experiences: experiences.length };

      // Save marker every 5 sessions for crash recovery
      if (i % 5 === 4) writeBulkMarker(marker);

    } catch (err) {
      console.error(`${label} ERROR: ${err.message}`);
      marker.files[session.path] = { ts: Date.now(), error: err.message };
      errors++;
    }
  }

  writeBulkMarker(marker);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  bulk-extract complete in ${elapsed}s`);
  console.log(`  Sessions: ${totalSessions} processed, ${errors} errors`);
  console.log(`  Experiences: ${totalExperiences} detected, ${totalStored} stored`);
  console.log(`  Dedup: ${seenHashes.size} unique hashes`);
  if (args.dryRun) console.log(`  (DRY RUN — nothing stored)`);
  console.log(`${'═'.repeat(50)}`);
}

main().catch(err => {
  console.error('[bulk-extract] FATAL:', err);
  process.exit(1);
});
