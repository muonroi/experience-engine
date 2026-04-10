#!/usr/bin/env node
/**
 * exp-stats.js — Experience Engine observability CLI
 *
 * Reads ~/.experience/activity.jsonl and prints human-readable stats.
 * Zero dependencies — uses only Node.js built-ins.
 *
 * Usage:
 *   node exp-stats.js              # last 7 days (default)
 *   node exp-stats.js --since 7d   # last 7 days
 *   node exp-stats.js --since 30d  # last 30 days
 *   node exp-stats.js --all        # all time
 *   node exp-stats.js --help       # show usage
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Pure functions (exported for testing) ---

/**
 * Parse --since argument (e.g. "7d", "30d") into a cutoff Date.
 * Returns null if input is invalid or null.
 */
function parseSince(sinceArg) {
  if (!sinceArg) return null;
  const match = String(sinceArg).match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return new Date(Date.now() - days * 86400000);
}

/**
 * Load events from activity.jsonl (and rotated .1 file) in given directory.
 * Malformed lines are silently skipped.
 */
function loadEvents(logDir) {
  const events = [];
  const files = ['activity.jsonl.1', 'activity.jsonl']; // .1 first (older)

  for (const file of files) {
    const filePath = path.join(logDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    } catch { /* file doesn't exist, skip */ }
  }

  return events;
}

/**
 * Filter events by cutoff date. If cutoff is null, return all.
 */
function filterEvents(events, cutoff) {
  if (!cutoff) return events;
  return events.filter(e => new Date(e.ts) >= cutoff);
}

/**
 * Normalize a project file path: replace backslashes, strip filename.
 * Returns "(unknown project)" for null/undefined.
 */
function normalizeProject(projectPath) {
  if (projectPath == null) return '(unknown project)';
  const normalized = String(projectPath).replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  return normalized.substring(0, lastSlash);
}

/**
 * Compute aggregate stats from events array (single pass).
 * Returns stats object with intercept, extract, evolve counters + per-project breakdown.
 */
function computeStats(events) {
  const stats = {
    // OBS-01: Summary
    totalIntercepts: 0,
    suggestions: 0,
    misses: 0,

    // OBS-02: Mistakes avoided
    totalMistakes: 0,
    totalStored: 0,
    extractSessions: 0,

    // OBS-03: Learning velocity
    evolveCount: 0,
    promoted: 0,
    demoted: 0,
    abstracted: 0,
    archived: 0,

    // OBS-04: Per-project
    projects: {},

    // OBS-05: Model Router
    routeCount: 0,
    routeByTier: { fast: 0, balanced: 0, premium: 0 },
    routeBySource: { history: 0, 'history-upgrade': 0, brain: 0, keyword: 0, default: 0 },
    routeFeedbackCount: 0,
    routeOutcomes: { success: 0, fail: 0, retry: 0, cancelled: 0 },
    routeDurations: [],   // raw ms values for avg computation
    routeSuccessByTier: { fast: 0, balanced: 0, premium: 0 },
    routeTotalByTier:   { fast: 0, balanced: 0, premium: 0 },
  };

  for (const e of events) {
    const proj = normalizeProject(e.project);

    if (e.op === 'intercept') {
      stats.totalIntercepts++;
      if (e.result === 'suggestion') {
        stats.suggestions++;
      } else {
        stats.misses++;
      }

      // Per-project intercept tracking
      if (!stats.projects[proj]) {
        stats.projects[proj] = { intercepts: 0, suggestions: 0, mistakes: 0, stored: 0 };
      }
      stats.projects[proj].intercepts++;
      if (e.result === 'suggestion') {
        stats.projects[proj].suggestions++;
      }
    } else if (e.op === 'extract') {
      stats.extractSessions++;
      stats.totalMistakes += (e.mistakes || 0);
      stats.totalStored += (e.stored || 0);

      // Per-project extract tracking
      if (!stats.projects[proj]) {
        stats.projects[proj] = { intercepts: 0, suggestions: 0, mistakes: 0, stored: 0 };
      }
      stats.projects[proj].mistakes += (e.mistakes || 0);
      stats.projects[proj].stored += (e.stored || 0);
    } else if (e.op === 'evolve') {
      stats.evolveCount++;
      stats.promoted += (e.promoted || 0);
      stats.demoted += (e.demoted || 0);
      stats.abstracted += (e.abstracted || 0);
      stats.archived += (e.archived || 0);
    } else if (e.op === 'route') {
      stats.routeCount++;
      const tier = e.tier || 'balanced';
      if (stats.routeByTier[tier] !== undefined) stats.routeByTier[tier]++;
      const src = e.source || 'default';
      if (stats.routeBySource[src] !== undefined) stats.routeBySource[src]++;
    } else if (e.op === 'route-feedback') {
      stats.routeFeedbackCount++;
      const outcome = e.outcome || 'success';
      if (stats.routeOutcomes[outcome] !== undefined) stats.routeOutcomes[outcome]++;
      if (typeof e.duration === 'number' && e.duration > 0) stats.routeDurations.push(e.duration);
      const fbTier = e.tier || 'balanced';
      if (stats.routeTotalByTier[fbTier] !== undefined) {
        stats.routeTotalByTier[fbTier]++;
        if (outcome === 'success') stats.routeSuccessByTier[fbTier]++;
      }
    }
  }

  return stats;
}

/**
 * Load top-5 most triggered experiences from FileStore JSON files.
 * Returns array of { tier, trigger, hitCount } sorted by hitCount desc.
 */
function loadTop5(storeDir) {
  const collections = [
    { name: 'experience-principles', tier: 'T0' },
    { name: 'experience-behavioral', tier: 'T1' },
    { name: 'experience-selfqa', tier: 'T2' }
  ];
  const all = [];

  for (const { name, tier } of collections) {
    try {
      const filePath = path.join(storeDir, `${name}.json`);
      const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const entry of entries) {
        try {
          const data = JSON.parse(entry.payload?.json || '{}');
          all.push({
            tier,
            trigger: data.trigger || '(unknown)',
            hitCount: data.hitCount || 0
          });
        } catch { /* skip malformed entry */ }
      }
    } catch { /* file missing, skip */ }
  }

  return all.sort((a, b) => b.hitCount - a.hitCount).slice(0, 5);
}

// --- Formatting helpers ---

function pct(numerator, denominator) {
  if (denominator === 0) return '0.0%';
  return (numerator / denominator * 100).toFixed(1) + '%';
}

function padLabel(label, width) {
  return label.padEnd(width || 22);
}

function printStat(label, value, detail) {
  console.log('  ' + padLabel(label) + value + (detail ? '  ' + detail : ''));
}

// --- CLI entry point ---

if (require.main === module) {
  const args = process.argv.slice(2);
  const HELP = args.includes('--help') || args.includes('-h');
  const ALL = args.includes('--all');
  const SINCE = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;

  if (HELP) {
    console.log('Usage: node exp-stats.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --since <Nd>   Filter events to last N days (default: 7d)');
    console.log('  --all          Show all-time stats (no time filter)');
    console.log('  --help, -h     Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node exp-stats.js              # last 7 days');
    console.log('  node exp-stats.js --since 30d  # last 30 days');
    console.log('  node exp-stats.js --all        # all time');
    process.exit(0);
  }

  // Resolve paths
  const logDir = path.join(os.homedir(), '.experience');
  const storeDir = path.join(logDir, 'store');

  // Determine time range
  let cutoff = null;
  let rangeLabel = 'all time';
  if (!ALL) {
    const sinceArg = SINCE || '7d';
    cutoff = parseSince(sinceArg);
    if (cutoff) {
      rangeLabel = 'last ' + sinceArg;
    } else {
      rangeLabel = 'last 7d';
      cutoff = parseSince('7d');
    }
  }

  // Load and filter events
  const allEvents = loadEvents(logDir);
  const events = filterEvents(allEvents, cutoff);
  const stats = computeStats(events);

  // Check for empty
  if (stats.totalIntercepts + stats.extractSessions + stats.evolveCount + stats.routeCount === 0) {
    console.log(`Experience Engine Stats (${rangeLabel})`);
    console.log('======================================');
    console.log('');
    console.log('No activity recorded.');
    console.log('');
    console.log('The experience engine logs events to ~/.experience/activity.jsonl');
    console.log('as you use Claude. Try running some queries first.');
    process.exit(0);
  }

  // Print report
  const title = `Experience Engine Stats (${rangeLabel})`;
  console.log(title);
  console.log('='.repeat(title.length));

  // Summary (OBS-01)
  console.log('');
  console.log('Summary');
  printStat('Suggestions fired:', String(stats.suggestions));
  printStat('Hit rate:', pct(stats.suggestions, stats.totalIntercepts),
    `(${stats.suggestions}/${stats.totalIntercepts} intercepts)`);
  printStat('Misses:', String(stats.misses));

  // Mistakes Avoided (OBS-02)
  console.log('');
  console.log('Mistakes Avoided');
  printStat('Patterns detected:', String(stats.totalMistakes));
  printStat('Stored as lessons:', String(stats.totalStored),
    `(${pct(stats.totalStored, stats.totalMistakes)} extraction rate)`);
  printStat('Warnings ignored:', String(stats.totalMistakes - stats.totalStored));

  // Learning Velocity (OBS-03)
  console.log('');
  console.log('Learning Velocity');
  printStat('Evolution runs:', String(stats.evolveCount));
  printStat('Promoted (T2->T1):', String(stats.promoted));
  printStat('Abstracted (T1->T0):', String(stats.abstracted));
  printStat('Demoted:', String(stats.demoted));
  printStat('Archived:', String(stats.archived));

  // Top 5 Experiences (OBS-01)
  console.log('');
  console.log('Top 5 Experiences');
  const top5 = loadTop5(storeDir);
  if (top5.length === 0) {
    console.log('  No local store found');
  } else {
    for (let i = 0; i < top5.length; i++) {
      const e = top5[i];
      console.log(`  ${i + 1}. [${e.tier}] "${e.trigger}" (hitCount: ${e.hitCount})`);
    }
  }

  // Model Router (OBS-05)
  if (stats.routeCount > 0) {
    console.log('');
    console.log('Model Router');
    printStat('Routes:', String(stats.routeCount));
    printStat('By tier:', `fast=${stats.routeByTier.fast} balanced=${stats.routeByTier.balanced} premium=${stats.routeByTier.premium}`);
    const historyHits = stats.routeBySource.history + stats.routeBySource['history-upgrade'];
    printStat('By source:', `history=${stats.routeBySource.history} upgrade=${stats.routeBySource['history-upgrade']} keyword=${stats.routeBySource.keyword} brain=${stats.routeBySource.brain} default=${stats.routeBySource.default}`);
    printStat('History hit rate:', pct(historyHits, stats.routeCount),
      `(${historyHits}/${stats.routeCount} from cache)`);
    if (stats.routeFeedbackCount > 0) {
      printStat('Feedback:', String(stats.routeFeedbackCount),
        `(success=${stats.routeOutcomes.success} fail=${stats.routeOutcomes.fail} retry=${stats.routeOutcomes.retry} cancelled=${stats.routeOutcomes.cancelled})`);
      // Accuracy by tier
      const tiers = ['fast', 'balanced', 'premium'];
      const accuracyParts = tiers
        .filter(t => stats.routeTotalByTier[t] > 0)
        .map(t => `${t}=${pct(stats.routeSuccessByTier[t], stats.routeTotalByTier[t])}`);
      if (accuracyParts.length > 0) {
        printStat('Accuracy by tier:', accuracyParts.join(' '));
      }
      // Avg duration
      if (stats.routeDurations.length > 0) {
        const avgMs = Math.round(stats.routeDurations.reduce((a, b) => a + b, 0) / stats.routeDurations.length);
        printStat('Avg duration:', `${avgMs}ms`, `(${stats.routeDurations.length} timed completions)`);
      }
    }
  }

  // Per-Project Breakdown (OBS-04)
  const projectKeys = Object.keys(stats.projects).sort();
  if (projectKeys.length > 0) {
    console.log('');
    console.log('Per-Project Breakdown');
    for (const proj of projectKeys) {
      const p = stats.projects[proj];
      const hitRate = pct(p.suggestions, p.intercepts);
      console.log(`  ${proj}`);
      console.log(`    Intercepts: ${p.intercepts}  |  Hit rate: ${hitRate}  |  Mistakes: ${p.mistakes}  |  Stored: ${p.stored}`);
    }
  }

  console.log('');
}

// --- Module exports for testing ---

if (typeof module !== 'undefined') {
  module.exports = { parseSince, loadEvents, filterEvents, normalizeProject, computeStats, loadTop5 };
}
