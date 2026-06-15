#!/usr/bin/env node
'use strict';

/**
 * sync.js — cross-platform, zero-bash session/memory sync into the brain.
 *
 *   npx @muonroi/experience-engine sync
 *
 * Node port of upgrade.sh's session-sync step (Step 4 / --sync-only). Feeds the
 * brain from this machine's local agent history without needing a repo checkout
 * or Git Bash:
 *   1. bulk-extract.js  — scan Claude/Codex/Gemini sessions → POST /api/extract
 *   2. import-memory.js — scan curated MEMORY.md → POST /api/import-memory
 *   3. write ~/.experience/.last-sync.json (health-check staleness marker)
 *
 * Both tools are thin-client aware: they read ~/.experience/config.json and
 * POST to the configured remote brain (serverBaseUrl + serverAuthToken). On a
 * full local install they fall back to direct-Qdrant. Sync is incremental —
 * per-tool markers track what was already processed.
 *
 * Tool resolution: prefer the installed copy in ~/.experience/tools (its
 * verified dep closure sits beside it), else the packaged copy in the npm
 * package. Either way transport is driven by ~/.experience/config.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_MAX = 30;
const DEFAULT_MAX_AGE = '365d';

const HELP = `Experience Engine — sync (feed the brain from local agent history)

Usage:
  npx @muonroi/experience-engine sync [options]

Scans this machine's Claude/Codex/Gemini sessions and curated MEMORY.md files
and pushes new experiences to the configured brain. Incremental and idempotent.

Options:
  --max N              Max sessions to extract this run (default ${DEFAULT_MAX})
  --max-age DUR        Only sessions newer than DUR, e.g. 90d (default ${DEFAULT_MAX_AGE})
  --runtime CSV        Limit to runtimes: claude,codex,gemini,muonroi-cli,antigravity
  --project SLUG       Limit to one project slug
  --sessions-only      Only run session extraction (skip curated memory import)
  --memory-only        Only run curated memory import (skip session extraction)
  --include-reference  Also import 'reference' type memory (import-memory)
  --reset-marker       Reprocess everything (ignore incremental markers)
  --upgrade            Refresh the thin-client runtime first (re-run init --yes)
  --dry-run            Detect only; write nothing to the brain or markers
  -v, --verbose        Verbose per-item output
  -h, --help           Show this help
`;

function parseArgs(argv) {
  const opts = {
    max: DEFAULT_MAX,
    maxAge: DEFAULT_MAX_AGE,
    runtime: '',
    project: '',
    sessionsOnly: false,
    memoryOnly: false,
    includeReference: false,
    resetMarker: false,
    upgrade: false,
    dryRun: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--max': opts.max = parseInt(argv[++i], 10); break;
      case '--max-age': opts.maxAge = argv[++i] || ''; break;
      case '--runtime': opts.runtime = argv[++i] || ''; break;
      case '--project': opts.project = argv[++i] || ''; break;
      case '--sessions-only': opts.sessionsOnly = true; break;
      case '--memory-only': opts.memoryOnly = true; break;
      case '--include-reference': opts.includeReference = true; break;
      case '--reset-marker': opts.resetMarker = true; break;
      case '--upgrade': opts.upgrade = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  if (opts.sessionsOnly && opts.memoryOnly) {
    throw new Error('--sessions-only and --memory-only are mutually exclusive');
  }
  if (!Number.isFinite(opts.max) || opts.max <= 0) {
    throw new Error('--max must be a positive integer');
  }
  return opts;
}

function packageRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Resolve a sync tool path. Prefer the installed thin-client copy (its dep
 * closure lives beside it); fall back to the packaged copy. Returns '' if
 * neither exists.
 */
function resolveToolPath(name, installDir, pkgRoot = packageRoot()) {
  const installed = path.join(installDir, 'tools', name);
  if (fs.existsSync(installed)) return installed;
  const packaged = path.join(pkgRoot, '.experience', 'tools', name);
  if (fs.existsSync(packaged)) return packaged;
  return '';
}

function buildBulkArgs(opts) {
  const args = ['--max', String(opts.max), '--max-age', opts.maxAge || DEFAULT_MAX_AGE];
  if (opts.runtime) args.push('--runtime', opts.runtime);
  if (opts.project) args.push('--project', opts.project);
  if (opts.resetMarker) args.push('--reset-marker');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.verbose) args.push('-v');
  return args;
}

function buildMemoryArgs(opts) {
  const args = [];
  if (opts.runtime) args.push('--runtime', opts.runtime);
  if (opts.project) args.push('--project', opts.project);
  if (opts.includeReference) args.push('--include-reference');
  if (opts.resetMarker) args.push('--reset-marker');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.verbose) args.push('-v');
  return args;
}

function runUpgrade(installDir, log, io) {
  const initPath = path.join(packageRoot(), 'bin', 'init.js');
  if (!fs.existsSync(initPath)) {
    log('  ! init.js not found — cannot --upgrade; continuing with sync only');
    return true;
  }
  log('  Refreshing thin-client runtime (init --yes) …');
  const r = spawnSync(process.execPath, [initPath, '--yes'], { stdio: 'inherit' });
  if (r.status !== 0) {
    io.stderr.write('  [ERROR] runtime refresh failed (init exited non-zero)\n');
    return false;
  }
  return true;
}

async function run(argv, io) {
  const out = io.stdout;
  const log = (msg) => out.write(`${msg}\n`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err.message}\n\n${HELP}`);
    return 1;
  }
  if (opts.help) {
    out.write(HELP);
    return 0;
  }

  const home = os.homedir();
  const installDir = path.join(home, '.experience');
  const configPath = path.join(installDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    io.stderr.write(
      '\n  [ERROR] No ~/.experience/config.json found. Run `npx @muonroi/experience-engine init` first.\n'
    );
    return 1;
  }

  log('');
  log('Experience Engine — sync');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* tolerate */ }
  const serverBase = cfg && typeof cfg.serverBaseUrl === 'string' ? cfg.serverBaseUrl : '';
  log(`  Transport: ${serverBase ? `server(${serverBase})` : 'direct-qdrant (local install)'}`);

  if (opts.upgrade) {
    if (!runUpgrade(installDir, log, io)) return 1;
  }

  let failures = 0;

  // Step 1: session extraction
  if (!opts.memoryOnly) {
    const tool = resolveToolPath('bulk-extract.js', installDir);
    if (!tool) {
      io.stderr.write('  ! bulk-extract.js not found (install or package). Re-run init.\n');
      failures += 1;
    } else {
      log(`\n  Syncing agent sessions → brain (max ${opts.max}) …`);
      const r = spawnSync(process.execPath, [tool, ...buildBulkArgs(opts)], { stdio: 'inherit' });
      if (r.status !== 0) {
        io.stderr.write('  ! session sync had errors (non-fatal).\n');
        failures += 1;
      }
    }
  }

  // Step 2: curated memory import
  if (!opts.sessionsOnly) {
    const tool = resolveToolPath('import-memory.js', installDir);
    if (!tool) {
      io.stderr.write('  ! import-memory.js not found (install or package). Re-run init.\n');
      failures += 1;
    } else {
      log('\n  Syncing curated agent memory → brain …');
      const r = spawnSync(process.execPath, [tool, ...buildMemoryArgs(opts)], { stdio: 'inherit' });
      if (r.status !== 0) {
        io.stderr.write('  ! curated memory import had errors (non-fatal).\n');
        failures += 1;
      }
    }
  }

  // Step 3: staleness marker (skip on dry-run — nothing was written)
  if (!opts.dryRun) {
    try {
      fs.writeFileSync(
        path.join(installDir, '.last-sync.json'),
        JSON.stringify({ ts: new Date().toISOString(), sessions: opts.max, source: 'sync' })
      );
    } catch (err) {
      log(`  ! could not write .last-sync.json: ${err.message}`);
    }
  }

  log('');
  log(opts.dryRun
    ? 'Dry-run complete — nothing written. Re-run without --dry-run to apply.'
    : `Sync complete${failures ? ` (with ${failures} non-fatal warning(s))` : ''}.`);
  return 0;
}

async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  return run(argv, io);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  main,
  run,
  parseArgs,
  buildBulkArgs,
  buildMemoryArgs,
  resolveToolPath,
};
