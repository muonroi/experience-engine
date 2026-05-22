#!/usr/bin/env node
/**
 * bulk-extract.js — Extract experiences from ALL local agent sessions
 * (Claude, Codex, Gemini) and store them into the brain.
 *
 * Uses the same session finders and transcript builders as stop-extractor.js
 * so all 3 runtimes are handled identically.
 *
 * Usage:
 *   node tools/bulk-extract.js                      # all runtimes, newest first, max 50
 *   node tools/bulk-extract.js --max 600            # up to 600 sessions
 *   node tools/bulk-extract.js --runtime claude     # only Claude sessions
 *   node tools/bulk-extract.js --runtime codex      # only Codex sessions
 *   node tools/bulk-extract.js --runtime gemini     # only Gemini sessions
 *   node tools/bulk-extract.js --dry-run            # detect only, don't store
 *   node tools/bulk-extract.js --min-size 10000     # skip sessions < 10KB
 *   node tools/bulk-extract.js --project muonroi    # filter by project slug
 *   node tools/bulk-extract.js --reset-marker       # reprocess all sessions
 *   node tools/bulk-extract.js --max-age 90d        # sessions up to 90 days old (default 365d)
 *
 * Designed to run as a background cron job:
 *   node tools/bulk-extract.js --max 30             # process 30 new sessions per run
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
const { detectExperience, detectTranscriptDomain } = require(path.join(expDir, 'src/context.js'));
const {
  findAllRecentSessions,
  buildSessionData,
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
    max: 50, dryRun: false, minSize: 5000, project: null,
    runtime: null, resetMarker: false, verbose: false,
    maxAge: '365d',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max' && argv[i + 1]) args.max = parseInt(argv[++i], 10);
    if (argv[i] === '--min-size' && argv[i + 1]) args.minSize = parseInt(argv[++i], 10);
    if (argv[i] === '--project' && argv[i + 1]) args.project = argv[++i].toLowerCase();
    if (argv[i] === '--runtime' && argv[i + 1]) args.runtime = argv[++i].toLowerCase();
    if (argv[i] === '--max-age' && argv[i + 1]) args.maxAge = argv[++i];
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--reset-marker') args.resetMarker = true;
    if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true;
    if (argv[i] === '--help') {
      console.log('Usage: bulk-extract.js [--max N] [--runtime claude|codex|gemini] [--dry-run] [--min-size N] [--project slug] [--reset-marker] [--max-age 365d] [-v]');
      process.exit(0);
    }
  }
  return args;
}

function parseMaxAge(str) {
  const m = String(str).match(/^(\d+)\s*(d|h)?$/i);
  if (!m) return 365 * 86_400_000;
  const n = parseInt(m[1], 10);
  return (m[2] || 'd').toLowerCase() === 'h' ? n * 3_600_000 : n * 86_400_000;
}

// Marker for tracking which sessions have been bulk-extracted
const MARKER_PATH = path.join(expDir, '.bulk-extract-marker.json');

function readBulkMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); } catch { return { files: {} }; }
}

function writeBulkMarker(marker) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

// ── Slug → real path resolution ──────────────────────────────────────────────
// Claude session projectPath uses slug format: "D--sources-Core-muonroi-cli"
// This cannot be used for file-system scanning (package.json, .csproj, etc.).
// Convert back to a real path that exists on disk.
//
// Claude's slug convention: path.replace(/[/\\:]/g, '-') so both path separators
// and literal hyphens in folder names become '-'. This is ambiguous:
//   "D--sources-Core-muonroi-cli" could be:
//     D:\sources\Core\muonroi\cli     (all dashes = separator)
//     D:\sources\Core\muonroi-cli     (last dash = literal hyphen)
//
// Strategy: greedy DFS — at each dash, try "path separator" first (check if
// resulting directory exists on disk), then "literal hyphen" (merge with current
// segment). This correctly resolves:
//   D--sources-Core-muonroi-cli    → D:\sources\Core\muonroi-cli
//   D--sources-Core-storyflow-ui   → D:\sources\Core\storyflow_ui  (via underscore fallback)
//   D--sources-eBerth              → D:\sources\eBerth

const _slugCache = new Map();

function resolveProjectPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;

  if (_slugCache.has(rawPath)) return _slugCache.get(rawPath);

  let result = null;

  // Already a real path (Codex/Gemini style)?
  if (rawPath.includes('/') || rawPath.includes('\\')) {
    const normalized = path.resolve(rawPath);
    try { if (fs.statSync(normalized).isDirectory()) result = normalized; } catch {}
    _slugCache.set(rawPath, result);
    return result;
  }

  // Claude slug format: single letter + "--" prefix = drive letter
  // "D--sources-Core-muonroi-cli" → drive=D, parts=[sources,Core,muonroi,cli]
  //
  // Each dash is ambiguous: path separator OR literal hyphen in folder name.
  // DFS: track (parentDir, pendingSegment) — pendingSegment accumulates chars
  // until we "commit" it by checking if parentDir/pendingSegment exists on disk.
  const slugMatch = rawPath.match(/^([A-Za-z])--(.+)$/);
  if (!slugMatch) { _slugCache.set(rawPath, null); return null; }

  const drive = slugMatch[1].toUpperCase();
  const parts = slugMatch[2].split('-');

  // parentDir: confirmed existing directory
  // pending: segment being built (not yet committed as a child dir)
  // idx: next part index to consume
  function tryResolve(idx, parentDir, pending) {
    if (idx >= parts.length) {
      // All parts consumed — commit pending as final segment
      const full = path.join(parentDir, pending);
      try { if (fs.statSync(full).isDirectory()) return full; } catch {}
      return null;
    }

    const part = parts[idx];

    // Option A: commit pending as directory, start new segment with part
    const committedDir = path.join(parentDir, pending);
    try {
      if (fs.statSync(committedDir).isDirectory()) {
        const deeper = tryResolve(idx + 1, committedDir, part);
        if (deeper) return deeper;
      }
    } catch {}

    // Option B: dash was literal hyphen — extend pending
    const deeper2 = tryResolve(idx + 1, parentDir, pending + '-' + part);
    if (deeper2) return deeper2;

    // Option C: dash was literal underscore — extend pending
    const deeper3 = tryResolve(idx + 1, parentDir, pending + '_' + part);
    if (deeper3) return deeper3;

    // Option D: dash was literal dot — extend pending (e.g. Muonroi.BaseTemplate)
    const deeper4 = tryResolve(idx + 1, parentDir, pending + '.' + part);
    if (deeper4) return deeper4;

    return null;
  }

  result = tryResolve(1, `${drive}:\\`, parts[0]);
  _slugCache.set(rawPath, result);
  return result;
}

// ── Transcript-based lang/framework detection ────────────────────────────────
// When file-system enrichment fails (slug path, remote session), fall back to
// analyzing file extensions and framework markers in the transcript itself.
const TRANSCRIPT_FW_PATTERNS = [
  { pattern: /package\.json|node_modules|npm |bun |yarn /i, frameworks: null }, // JS ecosystem, check deeper
  { pattern: /\.csproj|\.sln|dotnet |nuget /i, framework: 'dotnet' },
  { pattern: /Cargo\.toml|cargo build/i, framework: 'rust' },
  { pattern: /go\.mod|go build|go run/i, framework: 'go' },
  { pattern: /pyproject\.toml|pip install|requirements\.txt/i, framework: 'python' },
  { pattern: /@angular\/core|angular\.json/i, framework: 'angular' },
  { pattern: /next\.config|next\/|from 'next/i, framework: 'next' },
  { pattern: /@nestjs\/|nest-cli\.json/i, framework: 'nest' },
  { pattern: /from ['"]react['"]|jsx|tsx.*React/i, framework: 'react' },
  { pattern: /from ['"]vue['"]|\.vue\b/i, framework: 'vue' },
];

// Map domain string from detectTranscriptDomain to the scope lang enum
const DOMAIN_TO_LANG = {
  'TypeScript': 'TypeScript',
  'TypeScript React': 'TypeScript',
  'JavaScript': 'JavaScript',
  'JavaScript React': 'JavaScript',
  'C#': 'C#',
  'F#': 'C#',
  'Python': 'Python',
  'Ruby': 'Ruby',
  'Rust': 'Rust',
  'Go': 'Go',
  'Java': 'Java',
  'Kotlin': 'Java',
  'Swift': 'Swift',
  'C++': 'C++',
  'C': 'C',
  'Shell': 'Shell',
  'PowerShell': 'Shell',
};

function detectMetaFromTranscript(transcript) {
  const out = {};
  if (!transcript) return out;

  // Lang from file extensions in transcript
  const domain = detectTranscriptDomain(transcript);
  if (domain && DOMAIN_TO_LANG[domain]) {
    out.lang = DOMAIN_TO_LANG[domain];
  }

  // Framework from content patterns
  const sample = transcript.slice(0, 30000); // first 30KB enough for detection
  for (const entry of TRANSCRIPT_FW_PATTERNS) {
    if (entry.pattern.test(sample)) {
      if (entry.framework) {
        out.framework = entry.framework;
        break;
      }
    }
  }

  return out;
}

async function extractAndStore(transcript, projectPath, meta, dryRun) {
  if (dryRun || !transcript) return 0;

  const remote = getRemote();
  if (remote) {
    const config = remote.loadConfig(homeDir);
    if (remote.isRemoteEnabled(config)) {
      const body = {
        transcript,
        projectPath,
        sourceKind: 'bulk-extract',
        sourceRuntime: meta?.runtime || 'unknown',
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

  try {
    const { extractFromSession } = getCore();
    return await extractFromSession(transcript, projectPath, meta);
  } catch (err) {
    if (meta?.verbose) console.error(`    local error:`, err.message);
    return 0;
  }
}

function enrichMeta(projectPath, transcript) {
  const out = {};

  // Step 1: Try file-system based detection (most accurate)
  const realPath = resolveProjectPath(projectPath);
  if (realPath) {
    try {
      const enrichPath = path.join(expDir, 'source-meta-enrich.js');
      if (fs.existsSync(enrichPath)) {
        const enrich = require(enrichPath);
        const fsMeta = enrich.enrichSourceMeta(null, undefined, realPath) || {};
        if (fsMeta.lang) out.lang = fsMeta.lang;
        if (fsMeta.framework) out.framework = fsMeta.framework;
        if (fsMeta.project_slug) out.project_slug = fsMeta.project_slug;
      }
    } catch {}
  }

  // Step 2: Fill gaps from transcript analysis
  if (transcript && (!out.lang || !out.framework)) {
    const txMeta = detectMetaFromTranscript(transcript);
    if (!out.lang && txMeta.lang) out.lang = txMeta.lang;
    if (!out.framework && txMeta.framework) out.framework = txMeta.framework;
  }

  // Step 3: Derive project_slug from raw path if not already set
  if (!out.project_slug && projectPath) {
    try {
      const enrich = require(path.join(expDir, 'source-meta-enrich.js'));
      const slug = enrich.detectProjectSlug(realPath || projectPath);
      if (slug) out.project_slug = slug;
    } catch {}
  }

  return out;
}

function shortLabel(session) {
  const base = path.basename(session.file).slice(0, 12);
  const proj = session.projectPath
    ? path.basename(String(session.projectPath))
    : path.basename(path.dirname(session.file)).slice(0, 25);
  return `${session.runtime}:${proj}/${base}`;
}

async function main() {
  const args = parseArgs();
  const startMs = Date.now();
  const maxAgeMs = parseMaxAge(args.maxAge);

  console.log(`[bulk-extract] Scanning all agent sessions (Claude + Codex + Gemini)...`);
  console.log(`  max: ${args.max}, min-size: ${args.minSize}, max-age: ${args.maxAge}, dry-run: ${args.dryRun}`);
  if (args.runtime) console.log(`  runtime filter: ${args.runtime}`);
  if (args.project) console.log(`  project filter: ${args.project}`);

  let sessions = findAllRecentSessions(homeDir, Date.now(), maxAgeMs);

  // Filter by runtime
  if (args.runtime) {
    sessions = sessions.filter(s => s.runtime === args.runtime);
  }

  // Filter by project
  if (args.project) {
    sessions = sessions.filter(s => {
      const proj = String(s.projectPath || s.file || '').toLowerCase();
      return proj.includes(args.project);
    });
  }

  // Filter by min size
  sessions = sessions.filter(s => {
    try { return fs.statSync(s.file).size >= args.minSize; } catch { return false; }
  });

  // Skip subagent files
  sessions = sessions.filter(s => !s.file.includes('subagent'));

  const byRuntime = {};
  for (const s of sessions) byRuntime[s.runtime] = (byRuntime[s.runtime] || 0) + 1;
  console.log(`  Found ${sessions.length} sessions: ${Object.entries(byRuntime).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  const marker = args.resetMarker ? { files: {} } : readBulkMarker();
  const toProcess = sessions.filter(s => !marker.files[s.file]).slice(0, args.max);
  console.log(`  To process: ${toProcess.length} (${sessions.length - toProcess.length} already done)\n`);

  let totalExperiences = 0;
  let totalStored = 0;
  let totalSessions = 0;
  let errors = 0;
  let scopeStats = { withLang: 0, withFw: 0, withSlug: 0, fromFs: 0, fromTranscript: 0 };
  const storedByRuntime = {};

  for (let i = 0; i < toProcess.length; i++) {
    const session = toProcess[i];
    const label = `[${i + 1}/${toProcess.length}]`;

    try {
      let sessionData;
      try {
        sessionData = buildSessionData(session, 0);
      } catch (err) {
        if (args.verbose) console.error(`${label} parse error: ${err.message}`);
        marker.files[session.file] = { ts: Date.now(), error: 'parse_failed' };
        errors++;
        continue;
      }

      const transcript = compactTranscript(sessionData.transcript);
      if (!transcript || transcript.length < 200) {
        marker.files[session.file] = { ts: Date.now(), skip: 'too-short' };
        continue;
      }

      const experiences = detectExperience(transcript);
      totalExperiences += experiences.length;

      const byType = {};
      for (const e of experiences) byType[e.type] = (byType[e.type] || 0) + 1;
      const typeStr = Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ');

      const sizeKB = (() => { try { return (fs.statSync(session.file).size / 1024).toFixed(0); } catch { return '?'; } })();

      if (experiences.length > 0) {
        const meta = enrichMeta(session.projectPath || session.file, transcript);

        // Track scope quality stats
        if (meta.lang) scopeStats.withLang++;
        if (meta.framework) scopeStats.withFw++;
        if (meta.project_slug) scopeStats.withSlug++;
        const resolvedPath = resolveProjectPath(session.projectPath);
        if (resolvedPath) scopeStats.fromFs++;
        else if (meta.lang) scopeStats.fromTranscript++;

        const scopeLabel = `lang=${meta.lang || 'NONE'} fw=${meta.framework || 'NONE'} slug=${meta.project_slug || 'NONE'}`;
        console.log(`${label} ${shortLabel(session)} (${sizeKB}KB) → ${experiences.length} exp [${typeStr || 'none'}] scope:[${scopeLabel}]`);

        if (args.dryRun && args.verbose) {
          for (const e of experiences.slice(0, 3)) {
            console.log(`    ${e.type}: ${(e.excerpt || '').substring(0, 100)}`);
          }
        }

        const stored = await extractAndStore(transcript, session.projectPath || session.file, {
          ...meta,
          runtime: session.runtime,
          verbose: args.verbose,
        }, args.dryRun);
        totalStored += stored;
        storedByRuntime[session.runtime] = (storedByRuntime[session.runtime] || 0) + stored;
        if (stored > 0) console.log(`  → stored ${stored}`);
      } else {
        console.log(`${label} ${shortLabel(session)} (${sizeKB}KB) → 0 exp`);
      }

      totalSessions++;
      marker.files[session.file] = { ts: Date.now(), runtime: session.runtime, experiences: experiences.length };

      if (i % 5 === 4) writeBulkMarker(marker);

    } catch (err) {
      console.error(`${label} ERROR: ${err.message}`);
      marker.files[session.file] = { ts: Date.now(), error: err.message };
      errors++;
    }
  }

  writeBulkMarker(marker);

  const sessionsWithExp = scopeStats.withLang + (totalExperiences > 0 ? 0 : 0); // just for clarity
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  bulk-extract complete in ${elapsed}s`);
  console.log(`  Sessions: ${totalSessions} processed, ${errors} errors`);
  console.log(`  Experiences: ${totalExperiences} detected, ${totalStored} stored`);
  console.log(`  Scope quality: lang=${scopeStats.withLang} fw=${scopeStats.withFw} slug=${scopeStats.withSlug}`);
  console.log(`  Detection source: filesystem=${scopeStats.fromFs} transcript=${scopeStats.fromTranscript}`);
  console.log(`  By runtime: ${Object.entries(storedByRuntime).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  if (args.dryRun) console.log(`  (DRY RUN — nothing stored)`);
  console.log(`${'═'.repeat(55)}`);
}

main().catch(err => {
  console.error('[bulk-extract] FATAL:', err);
  process.exit(1);
});
