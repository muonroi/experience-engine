#!/usr/bin/env node
'use strict';

/**
 * import-memory.js — import curated agent memory markdown into the experience
 * brain DIRECTLY (no LLM). See ../src/memory-import.js for the adapter design.
 *
 * Pipeline: scanMemorySources (per-runtime adapters) → mapMemoryToExperience
 * (type→tier routing, skip user/reference) → store. mtime-incremental marker so
 * only changed files re-import.
 *
 * Transport (auto-detected):
 *   - THIN CLIENT (config.serverBaseUrl set, e.g. a dev laptop): scan + map
 *     LOCALLY — project-slug derivation needs the local project dirs — then POST
 *     pre-mapped experiences to the server's /api/import-memory. The server (with
 *     Qdrant + embeddings) does the actual store.
 *   - SERVER-LOCAL (Qdrant reachable directly): call storeImportedExperience inline.
 *
 * Usage:
 *   node tools/import-memory.js --dry-run -v          # preview (default-safe)
 *   node tools/import-memory.js                       # import all runtimes
 *   node tools/import-memory.js --runtime claude
 *   node tools/import-memory.js --project muonroi-cli
 *   node tools/import-memory.js --reset-marker        # re-import everything
 *   node tools/import-memory.js --include-reference   # also import reference type
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanMemorySources, mapMemoryToExperience, toWireExperience } = require('../src/memory-import');
const { storeImportedExperience } = require('../src/evolution');
const rc = require('../remote-client');

const expDir = path.join(os.homedir(), '.experience');
const MARKER_PATH = path.join(expDir, '.memory-import-marker.json');
const POST_BATCH = 200;

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

  const rcCfg = rc.loadConfig();
  const serverBase = rc.getServerBaseUrl(rcCfg);
  const thinClient = !!serverBase;

  const records = scanMemorySources({ runtimes: args.runtimes });
  const stats = { scanned: records.length, skippedType: 0, skippedProject: 0, skippedUnchanged: 0, new: 0, upserted: 0, failed: 0, byTier: { 1: 0, 2: 0 } };

  console.log(`[import-memory] mode=${args.dryRun ? 'DRY-RUN' : 'APPLY'} transport=${thinClient ? `server(${serverBase})` : 'direct-qdrant'} scanned=${records.length} runtimes=${args.runtimes ? args.runtimes.join(',') : 'all'}`);

  // Build the work list (project filter + map + skip user/reference + skip unchanged).
  const work = []; // { record, mapped }
  for (const record of records) {
    if (args.project && record.projectSlug !== args.project) { stats.skippedProject++; continue; }
    const mapped = mapMemoryToExperience(record, { includeReference: args.includeReference });
    if (!mapped) {
      stats.skippedType++;
      if (args.verbose) console.log(`  skip-type   [${record.type || 'untyped'}] ${record.name} (${record.runtime})`);
      continue;
    }
    const m = marker.files[record.file];
    const unchanged = m && m.mtimeMs === record.mtimeMs && m.id === mapped.id;
    if (unchanged && !args.dryRun) { stats.skippedUnchanged++; if (args.verbose) console.log(`  unchanged   ${record.name}`); continue; }
    work.push({ record, mapped, unchanged });
  }

  if (args.dryRun) {
    for (const { record, mapped, unchanged } of work) {
      const action = unchanged ? 'unchanged' : (marker.files[record.file] ? 'upsert' : 'new');
      stats.byTier[mapped.tier]++;
      if (action === 'new') stats.new++; else if (action === 'upsert') stats.upserted++; else stats.skippedUnchanged++;
      if (args.verbose) console.log(`  ${action.padEnd(9)} T${mapped.tier} [${mapped.type}] ${record.name} → ${record.projectSlug || '(no-scope)'}`);
    }
    summarize(stats, true, thinClient);
    return;
  }

  if (thinClient) {
    if (!rc.getServerAuthToken(rcCfg)) console.error('[import-memory] WARNING: no serverAuthToken configured — POST may be rejected.');
    for (let i = 0; i < work.length; i += POST_BATCH) {
      const batch = work.slice(i, i + POST_BATCH);
      const experiences = batch.map(({ record, mapped }) => toWireExperience(mapped, record));
      let resp;
      try { resp = await rc.postJson('/api/import-memory', { experiences }); }
      catch (err) {
        stats.failed += batch.length;
        console.error(`[import-memory] POST batch failed: ${err?.message}${err?.status ? ` (HTTP ${err.status})` : ''}`);
        continue;
      }
      const byId = new Map((resp.results || []).map((r) => [r.id, r]));
      for (const { record, mapped } of batch) {
        const r = byId.get(mapped.id);
        if (r && r.ok) {
          marker.files[record.file] = { mtimeMs: record.mtimeMs, id: mapped.id, tier: mapped.tier, ts: new Date().toISOString() };
          stats.byTier[mapped.tier]++;
          if (r.upserted) stats.upserted++; else stats.new++;
          if (args.verbose) console.log(`  ${(r.upserted ? 'upsert' : 'new').padEnd(9)} T${mapped.tier} [${mapped.type}] ${record.name} → ${record.projectSlug || '(no-scope)'}`);
        } else {
          stats.failed++;
          console.error(`  FAILED    ${record.name}: ${r?.reason || 'no result'}`);
        }
      }
    }
  } else {
    for (const { record, mapped } of work) {
      try {
        const res = await storeImportedExperience(mapped.qa, { id: mapped.id, collection: mapped.collection, tier: mapped.tier, confidence: mapped.confidence, runtime: record.runtime });
        if (res.stored) {
          marker.files[record.file] = { mtimeMs: record.mtimeMs, id: mapped.id, tier: mapped.tier, ts: new Date().toISOString() };
          stats.byTier[mapped.tier]++;
          if (res.upserted) stats.upserted++; else stats.new++;
          if (args.verbose) console.log(`  ${(res.upserted ? 'upsert' : 'new').padEnd(9)} T${mapped.tier} [${mapped.type}] ${record.name} → ${record.projectSlug || '(no-scope)'}`);
        } else { stats.failed++; console.error(`  FAILED    ${record.name}: ${res.reason || 'unknown'}`); }
      } catch (err) { stats.failed++; console.error(`  FAILED    ${record.name}: ${err?.message}`); }
    }
  }

  writeMarker(marker);
  summarize(stats, false, thinClient);
}

function summarize(stats, dryRun) {
  console.log('');
  console.log(`[import-memory] new=${stats.new} upserted=${stats.upserted} unchanged=${stats.skippedUnchanged} skipped(type)=${stats.skippedType} skipped(project)=${stats.skippedProject} failed=${stats.failed}`);
  console.log(`[import-memory] tiers: T1(behavioral)=${stats.byTier[1]} T2(selfqa)=${stats.byTier[2]}`);
  if (dryRun) console.log('[import-memory] DRY-RUN only — re-run without --dry-run to write.');
}

main().catch((err) => { console.error('[import-memory] FATAL', err); process.exit(1); });
