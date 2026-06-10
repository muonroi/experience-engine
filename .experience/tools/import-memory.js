#!/usr/bin/env node
'use strict';

/**
 * import-memory.js — import curated agent memory markdown into the experience
 * brain DIRECTLY (no LLM). See ../src/memory-import.js for the adapter design.
 *
 * Pipeline: scanMemorySources (per-runtime adapters) → mapMemoryToExperience
 * (type→tier routing, skip user/reference) → storeImportedExperience (stable-id
 * upsert into T1/T2, seed-like, counter-preserving). mtime-incremental marker so
 * only changed files re-import.
 *
 * Usage:
 *   node tools/import-memory.js --dry-run -v          # preview (default-safe)
 *   node tools/import-memory.js                       # import all runtimes
 *   node tools/import-memory.js --runtime claude
 *   node tools/import-memory.js --project muonroi-cli
 *   node tools/import-memory.js --reset-marker        # re-import everything
 *   node tools/import-memory.js --include-reference   # also import reference type
 *
 * Reads Qdrant/embed config from ~/.experience/config.json via src/config.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanMemorySources, mapMemoryToExperience } = require('../src/memory-import');
const { storeImportedExperience } = require('../src/evolution');

const expDir = path.join(os.homedir(), '.experience');
const MARKER_PATH = path.join(expDir, '.memory-import-marker.json');

function parseArgs(argv) {
  const args = { runtimes: null, project: null, dryRun: false, verbose: false, resetMarker: false, includeReference: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime' && argv[i + 1]) { args.runtimes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a.startsWith('--runtime=')) { args.runtimes = a.slice(10).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--project' && argv[i + 1]) { args.project = argv[++i]; }
    else if (a.startsWith('--project=')) { args.project = a.slice(10); }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--reset-marker') { args.resetMarker = true; }
    else if (a === '--include-reference') { args.includeReference = true; }
    else if (a === '-v' || a === '--verbose') { args.verbose = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: import-memory.js [--runtime claude,codex] [--project slug] [--dry-run] [--reset-marker] [--include-reference] [-v]');
      process.exit(0);
    }
  }
  return args;
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')); } catch { return { files: {} }; }
}
function writeMarker(marker) {
  try { fs.writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8'); }
  catch (err) { console.error(`[import-memory] marker write failed: ${err?.message}`); }
}

async function main() {
  const args = parseArgs(process.argv);
  const marker = args.resetMarker ? { files: {} } : readMarker();

  const records = scanMemorySources({ runtimes: args.runtimes });
  const stats = {
    scanned: records.length,
    skippedType: 0, skippedProject: 0, skippedUnchanged: 0,
    new: 0, upserted: 0, failed: 0,
    byTier: { 1: 0, 2: 0 },
  };

  console.log(`[import-memory] mode=${args.dryRun ? 'DRY-RUN' : 'APPLY'} scanned=${records.length} runtimes=${args.runtimes ? args.runtimes.join(',') : 'all'}`);

  for (const record of records) {
    if (args.project && record.projectSlug !== args.project) { stats.skippedProject++; continue; }

    const mapped = mapMemoryToExperience(record, { includeReference: args.includeReference });
    if (!mapped) {
      stats.skippedType++;
      if (args.verbose) console.log(`  skip-type   [${record.type || 'untyped'}] ${record.name} (${record.runtime})`);
      continue;
    }

    const markEntry = marker.files[record.file];
    const unchanged = markEntry && markEntry.mtimeMs === record.mtimeMs && markEntry.id === mapped.id;
    if (unchanged && !args.dryRun) { stats.skippedUnchanged++; if (args.verbose) console.log(`  unchanged   ${record.name}`); continue; }

    if (args.dryRun) {
      const action = unchanged ? 'unchanged' : (markEntry ? 'upsert' : 'new');
      stats.byTier[mapped.tier]++;
      if (action === 'new') stats.new++; else if (action === 'upsert') stats.upserted++; else stats.skippedUnchanged++;
      if (args.verbose) console.log(`  ${action.padEnd(9)} T${mapped.tier} [${mapped.type}] ${record.name} → ${record.projectSlug || '(no-scope)'}`);
      continue;
    }

    try {
      const res = await storeImportedExperience(mapped.qa, { id: mapped.id, collection: mapped.collection, tier: mapped.tier, confidence: mapped.confidence, runtime: record.runtime });
      if (res.stored) {
        marker.files[record.file] = { mtimeMs: record.mtimeMs, id: mapped.id, tier: mapped.tier, ts: new Date().toISOString() };
        stats.byTier[mapped.tier]++;
        if (res.upserted) stats.upserted++; else stats.new++;
        if (args.verbose) console.log(`  ${(res.upserted ? 'upsert' : 'new').padEnd(9)} T${mapped.tier} [${mapped.type}] ${record.name} → ${record.projectSlug || '(no-scope)'}`);
      } else {
        stats.failed++;
        console.error(`  FAILED    ${record.name}: ${res.reason || 'unknown'}`);
      }
    } catch (err) {
      stats.failed++;
      console.error(`  FAILED    ${record.name}: ${err?.message}`);
    }
  }

  if (!args.dryRun) writeMarker(marker);

  console.log('');
  console.log(`[import-memory] new=${stats.new} upserted=${stats.upserted} unchanged=${stats.skippedUnchanged} skipped(type)=${stats.skippedType} skipped(project)=${stats.skippedProject} failed=${stats.failed}`);
  console.log(`[import-memory] tiers: T1(behavioral)=${stats.byTier[1]} T2(selfqa)=${stats.byTier[2]}`);
  if (args.dryRun) console.log('[import-memory] DRY-RUN only — re-run without --dry-run to write.');
}

main().catch((err) => { console.error('[import-memory] FATAL', err); process.exit(1); });
