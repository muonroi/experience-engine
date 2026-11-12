#!/usr/bin/env node
/**
 * post-sync-check.js — advisory scope-quality check after a bulk-extract sync.
 *
 * Runs `tools/exp-hint-stats.js --json` and warns (never fails) when the brain
 * has accumulated too many UNSCOPED or noisy entries — the debris pattern that
 * `bulk-extract.js` cannot fully prevent because it refuses to guess a scope
 * (by design: commits 1226b16, 8d90964). This gives the operator visibility
 * that a cleanup pass (see docs/BRAIN_CLEANUP_RUNBOOK.md) is due, without
 * changing ingest behavior.
 *
 * Exit code is always 0 (advisory only) so it never blocks an upgrade.
 *
 * Usage:
 *   node tools/post-sync-check.js                     # default thresholds
 *   node tools/post-sync-check.js --unscoped-warn 25  # warn when UNSCOPED % >= 25
 *   node tools/post-sync-check.js --noisy-warn 20     # warn when noisy % >= 20
 *
 * Thresholds default high so the check only fires on real drift, not on a
 * freshly-synced small batch.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  const a = { unscopedWarn: 30, noisyWarn: 25 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--unscoped-warn' && argv[i + 1]) a.unscopedWarn = Number(argv[++i]);
    else if (argv[i] === '--noisy-warn' && argv[i + 1]) a.noisyWarn = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: post-sync-check.js [--unscoped-warn PCT] [--noisy-warn PCT]');
      console.log('  Advisory only — always exits 0. See docs/BRAIN_CLEANUP_RUNBOOK.md.');
      process.exit(0);
    }
  }
  return a;
}

const COLS = ['experience-behavioral', 'experience-selfqa', 'experience-principles'];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const statsScript = path.join(__dirname, 'exp-hint-stats.js');
  const res = spawnSync(process.execPath, [statsScript, '--json', '--top', '0'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  // exp-hint-stats queries Qdrant via the server. If Qdrant is down (the fd
  // exhaustion case in the runbook), it returns empty — surface that as a
  // distinct advisory rather than a silent "looks fine".
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) {
    console.log('[post-sync-check] could not read brain stats (Qdrant unreachable or exp-hint-stats empty).');
    console.log('[post-sync-check] If this persists, see "Qdrant fd exhaustion" in docs/BRAIN_CLEANUP_RUNBOOK.md.');
    return;
  }
  let stats;
  try { stats = JSON.parse(res.stdout).stats; }
  catch { console.log('[post-sync-check] exp-hint-stats returned non-JSON — skipping.'); return; }

  let total = 0, unscoped = 0, noisy = 0;
  const perCol = [];
  for (const col of COLS) {
    const s = stats[col];
    if (!s) continue;
    const t = s.total || 0;
    const u = (s.byLang && s.byLang.unscoped) || 0;
    const n = s.noisyCount || 0;
    total += t; unscoped += u; noisy += n;
    perCol.push({ col, total: t, unscoped: u, noisy: n });
  }
  if (total === 0) { console.log('[post-sync-check] brain appears empty (0 entries) — nothing to assess.'); return; }

  const unscopedPct = Math.round((unscoped / total) * 100);
  const noisyPct = Math.round((noisy / total) * 100);
  const unscopedFlag = unscopedPct >= args.unscopedWarn;
  const noisyFlag = noisyPct >= args.noisyWarn;

  console.log(`[post-sync-check] brain scope quality: ${total} entries`);
  for (const c of perCol) {
    const up = c.total ? Math.round((c.unscoped / c.total) * 100) : 0;
    console.log(`  ${c.col.padEnd(24)} total=${String(c.total).padStart(4)}  unscoped=${String(c.unscoped).padStart(4)} (${up}%)  noisy=${c.noisy}`);
  }
  console.log(`[post-sync-check] overall: unscoped=${unscopedPct}% (warn at ${args.unscopedWarn}%)  noisy=${noisyPct}% (warn at ${args.noisyWarn}%)`);

  if (unscopedFlag || noisyFlag) {
    console.log('[post-sync-check] ⚠ debris accumulating — a cleanup pass is due.');
    console.log('[post-sync-check]   See docs/BRAIN_CLEANUP_RUNBOOK.md (Step 1 inventory → Step 3 read-then-remap).');
    console.log('[post-sync-check]   This is advisory only; the upgrade succeeded.');
  } else {
    console.log('[post-sync-check] within thresholds — no cleanup needed yet.');
  }
}

main();
