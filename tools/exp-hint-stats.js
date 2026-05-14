#!/usr/bin/env node
/**
 * exp-hint-stats.js — Hint-quality observability for the Experience Engine.
 *
 * Aggregates Qdrant points (via server /api/hint-stats) and reports:
 *   - scope.lang distribution per collection (surfaces cross-language seeds)
 *   - noisy hints: ignoreCount >= N and ignoreRatio >= R
 *   - unscoped seeds with high fire count (legacy data prone to leak)
 *
 * Usage:
 *   node exp-hint-stats.js                          # default thresholds
 *   node exp-hint-stats.js --min-ignore 5 --ratio 0.5
 *   node exp-hint-stats.js --top 30
 *   node exp-hint-stats.js --json                   # raw JSON output
 *   node exp-hint-stats.js --collections experience-behavioral
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8'));
  } catch { return {}; }
}

function parseArgs(argv) {
  const args = {
    minIgnore: 2,
    ratio: 0.4,
    topN: 20,
    json: false,
    collections: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-ignore') args.minIgnore = Number(argv[++i]) || 2;
    else if (a === '--ratio') args.ratio = Number(argv[++i]) || 0.4;
    else if (a === '--top') args.topN = Number(argv[++i]) || 20;
    else if (a === '--json') args.json = true;
    else if (a === '--collections') args.collections = argv[++i] || null;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`exp-hint-stats — Hint-quality stats from the brain.

Options:
  --min-ignore N    Mark as "noisy" when ignoreCount >= N (default 2)
  --ratio R         Mark as "noisy" when ignores/(hits+ignores) >= R (default 0.4)
  --top N           Show top N noisy/unscoped per collection (default 20)
  --json            Emit raw JSON
  --collections X,Y Filter to specific collections (comma-separated)
  --help, -h        Show this help

Examples:
  node exp-hint-stats.js
  node exp-hint-stats.js --min-ignore 5 --ratio 0.5 --top 30
  node exp-hint-stats.js --collections experience-behavioral --json`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const cfg = loadConfig();
  const base = cfg.serverBaseUrl;
  const token = cfg.serverAuthToken || cfg.serverReadAuthToken;
  if (!base || !token) {
    console.error('Missing serverBaseUrl / serverAuthToken in ~/.experience/config.json');
    process.exit(2);
  }
  const params = new URLSearchParams({
    minIgnoreCount: String(args.minIgnore),
    noiseRatio: String(args.ratio),
    topN: String(args.topN),
  });
  if (args.collections) params.set('collections', args.collections);

  const res = await fetch(`${base}/api/hint-stats?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Server returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Hint Stats — generated ${data.generatedAt}`);
  console.log(`Thresholds: minIgnore=${data.thresholds.minIgnoreCount} ratio=${data.thresholds.noiseRatio}`);
  console.log('═══════════════════════════════════════════════════════════');

  for (const [col, s] of Object.entries(data.stats)) {
    const langPct = (n) => s.total ? `${n} (${Math.round((n / s.total) * 100)}%)` : '0';
    console.log(`\n▎ ${col} — total=${s.total}`);
    console.log(`  scope.lang  c#=${langPct(s.byLang['c#'])} ts=${langPct(s.byLang.typescript)} js=${langPct(s.byLang.javascript)} unscoped=${langPct(s.byLang.unscoped)} other=${langPct(s.byLang.other)}`);
    const fwTop = Object.entries(s.byFramework).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (fwTop.length) console.log(`  framework   ${fwTop.map(([k, v]) => `${k}=${v}`).join(' ')}`);

    if (s.noisy.length) {
      console.log(`  noisy (${s.noisyCount} total, top ${Math.min(s.noisy.length, args.topN)}):`);
      for (const n of s.noisy.slice(0, args.topN)) {
        console.log(`    ${n.id}  hits=${n.hits} ign=${n.ignores} (${(n.ignoreRatio * 100).toFixed(0)}%)  lang=${n.lang || '-'} fw=${n.framework || '-'}`);
        console.log(`               ${n.solution}`);
      }
    }
    if (s.unscopedHigh.length) {
      console.log(`  unscoped-high-fire (${s.unscopedHighCount} total, top ${Math.min(s.unscopedHigh.length, args.topN)}):`);
      for (const u of s.unscopedHigh.slice(0, args.topN)) {
        console.log(`    ${u.id}  hits=${u.hits} ign=${u.ignores}`);
        console.log(`               ${u.solution}`);
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
