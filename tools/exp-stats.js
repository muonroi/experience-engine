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

function dayKey(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return 'unknown-day';
  return date.toISOString().slice(0, 10);
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

    // OBS-04b: Feedback / noise
    feedbackCount: 0,
    judgeFeedbackCount: 0,
    feedbackByVerdict: { FOLLOWED: 0, IGNORED: 0, IRRELEVANT: 0 },
    noiseByReason: { wrong_repo: 0, wrong_language: 0, wrong_task: 0, stale_rule: 0 },
    noiseDispositionCount: 0,
    noiseDispositionBySource: { manual: 0, judge: 0, 'implicit-posttool': 0, 'prompt-stale': 0 },
    noiseDispositionByReason: { wrong_repo: 0, wrong_language: 0, wrong_task: 0, stale_rule: 0 },
    implicitUnusedCount: 0,
    implicitUnusedByReason: { wrong_repo: 0, wrong_language: 0, wrong_task: 0, stale_rule: 0 },
    noiseSuppressionCount: 0,
    noiseSuppressionByReason: { wrong_repo: 0, wrong_language: 0, wrong_task: 0, stale_rule: 0 },

    // OBS-04c: Recurrence telemetry
    mistakeSeenCount: 0,
    mistakeByType: {},
    mistakeByProjectType: {},

    // OBS-04d: Cost ledger
    costCallCount: 0,
    costByKind: { embed: 0, brain: 0, judge: 0, extract: 0 },
    costUnitsByKind: { embed: 0, brain: 0, judge: 0, extract: 0 },
    dailyCostLedger: {},

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
    } else if (e.op === 'feedback' || e.op === 'judge-feedback') {
      stats.feedbackCount++;
      if (e.op === 'judge-feedback') stats.judgeFeedbackCount++;
      const verdict = e.verdict || (e.followed === true ? 'FOLLOWED' : e.followed === false ? 'IGNORED' : null);
      if (verdict && stats.feedbackByVerdict[verdict] !== undefined) {
        stats.feedbackByVerdict[verdict]++;
      }
      if (verdict === 'IRRELEVANT' && e.reason && stats.noiseByReason[e.reason] !== undefined) {
        stats.noiseByReason[e.reason]++;
      }
    } else if (e.op === 'implicit-unused') {
      stats.implicitUnusedCount++;
      if (e.reason && stats.implicitUnusedByReason[e.reason] !== undefined) {
        stats.implicitUnusedByReason[e.reason]++;
      }
    } else if (e.op === 'noise-disposition') {
      const count = Math.max(1, Number(e.unused || e.count || 1) || 1);
      stats.noiseDispositionCount += count;
      const source = String(e.source || 'manual');
      if (stats.noiseDispositionBySource[source] !== undefined) stats.noiseDispositionBySource[source] += count;
      const reason = String(e.reason || '');
      if (stats.noiseDispositionByReason[reason] !== undefined) stats.noiseDispositionByReason[reason] += count;
    } else if (e.op === 'noise-suppressed') {
      const count = Math.max(1, Number(e.count || 1) || 1);
      stats.noiseSuppressionCount += count;
      if (e.reason && stats.noiseSuppressionByReason[e.reason] !== undefined) {
        stats.noiseSuppressionByReason[e.reason] += count;
      }
    } else if (e.op === 'mistake-seen') {
      const count = Math.max(0, Number(e.count) || 0);
      const type = String(e.type || 'unknown');
      const projectKey = `${normalizeProject(e.project)} :: ${type}`;
      stats.mistakeSeenCount += count;
      stats.mistakeByType[type] = (stats.mistakeByType[type] || 0) + count;
      stats.mistakeByProjectType[projectKey] = (stats.mistakeByProjectType[projectKey] || 0) + count;
    } else if (e.op === 'cost-call') {
      const kind = String(e.kind || 'unknown');
      const units = Math.max(0, Math.round(Number(e.units) || 0));
      const day = dayKey(e.ts);
      stats.costCallCount++;
      if (stats.costByKind[kind] !== undefined) stats.costByKind[kind]++;
      if (stats.costUnitsByKind[kind] !== undefined) stats.costUnitsByKind[kind] += units;
      if (!stats.dailyCostLedger[day]) {
        stats.dailyCostLedger[day] = {
          calls: 0,
          units: 0,
          byKind: { embed: 0, brain: 0, judge: 0, extract: 0 },
          callsByKind: { embed: 0, brain: 0, judge: 0, extract: 0 },
        };
      }
      stats.dailyCostLedger[day].calls++;
      stats.dailyCostLedger[day].units += units;
      if (stats.dailyCostLedger[day].byKind[kind] !== undefined) {
        stats.dailyCostLedger[day].byKind[kind] += units;
      }
      if (stats.dailyCostLedger[day].callsByKind[kind] !== undefined) {
        stats.dailyCostLedger[day].callsByKind[kind]++;
      }
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
  if (stats.totalIntercepts + stats.extractSessions + stats.evolveCount + stats.routeCount + stats.mistakeSeenCount + stats.costCallCount + stats.noiseDispositionCount + stats.noiseSuppressionCount === 0) {
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
  if (stats.feedbackCount > 0) {
    const irrelevant = stats.feedbackByVerdict.IRRELEVANT;
    console.log('');
    console.log('Feedback Loop');
    printStat('Feedback events:', String(stats.feedbackCount),
      `(judge=${stats.judgeFeedbackCount} manual=${stats.feedbackCount - stats.judgeFeedbackCount})`);
    printStat('By verdict:', `followed=${stats.feedbackByVerdict.FOLLOWED} ignored=${stats.feedbackByVerdict.IGNORED} irrelevant=${irrelevant}`);
    printStat('Noise rate:', pct(irrelevant, stats.feedbackCount),
      `(${irrelevant}/${stats.feedbackCount} feedback events)`);
    const noiseParts = Object.entries(stats.noiseByReason)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`);
    if (noiseParts.length > 0) {
      printStat('Noise reasons:', noiseParts.join(' '));
    }
  }
  if (stats.implicitUnusedCount > 0) {
    const implicitParts = Object.entries(stats.implicitUnusedByReason)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`);
    printStat('Implicit unused:', String(stats.implicitUnusedCount));
    if (implicitParts.length > 0) {
      printStat('Unused reasons:', implicitParts.join(' '));
    }
  }
  if (stats.noiseDispositionCount > 0 || stats.noiseSuppressionCount > 0) {
    console.log('');
    console.log('Noise Learning');
    if (stats.noiseDispositionCount > 0) {
      const sourceParts = Object.entries(stats.noiseDispositionBySource)
        .filter(([, count]) => count > 0)
        .map(([source, count]) => `${source}=${count}`);
      const reasonParts = Object.entries(stats.noiseDispositionByReason)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`);
      printStat('Dispositions:', String(stats.noiseDispositionCount));
      if (sourceParts.length > 0) printStat('By source:', sourceParts.join(' '));
      if (reasonParts.length > 0) printStat('By reason:', reasonParts.join(' '));
    }
    if (stats.noiseSuppressionCount > 0) {
      const suppressedParts = Object.entries(stats.noiseSuppressionByReason)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`);
      printStat('Suppressed:', String(stats.noiseSuppressionCount));
      if (suppressedParts.length > 0) printStat('Suppressed reasons:', suppressedParts.join(' '));
    }
  }

  // Mistakes Avoided (OBS-02)
  console.log('');
  console.log('Mistakes Avoided');
  printStat('Patterns detected:', String(stats.totalMistakes));
  printStat('Stored as lessons:', String(stats.totalStored),
    `(${pct(stats.totalStored, stats.totalMistakes)} extraction rate)`);
  printStat('Warnings ignored:', String(stats.totalMistakes - stats.totalStored));
  if (stats.mistakeSeenCount > 0) {
    const topMistakes = Object.entries(stats.mistakeByType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => `${type}=${count}`);
    printStat('Mistakes seen:', String(stats.mistakeSeenCount));
    if (topMistakes.length > 0) {
      printStat('By type:', topMistakes.join(' '));
    }
  }

  // Learning Velocity (OBS-03)
  console.log('');
  console.log('Learning Velocity');
  printStat('Evolution runs:', String(stats.evolveCount));
  printStat('Promoted (T2->T1):', String(stats.promoted));
  printStat('Abstracted (T1->T0):', String(stats.abstracted));
  printStat('Demoted:', String(stats.demoted));
  printStat('Archived:', String(stats.archived));

  if (stats.costCallCount > 0) {
    console.log('');
    console.log('Cost Ledger');
    printStat('Cost calls:', String(stats.costCallCount));
    printStat('Calls by kind:', `embed=${stats.costByKind.embed} brain=${stats.costByKind.brain} judge=${stats.costByKind.judge} extract=${stats.costByKind.extract}`);
    printStat('Units by kind:', `embed=${stats.costUnitsByKind.embed} brain=${stats.costUnitsByKind.brain} judge=${stats.costUnitsByKind.judge} extract=${stats.costUnitsByKind.extract}`);
    const recentDays = Object.keys(stats.dailyCostLedger).sort().slice(-7);
    if (recentDays.length > 0) {
      console.log('  Recent daily units:');
      for (const day of recentDays) {
        const row = stats.dailyCostLedger[day];
        console.log(`    ${day}: total=${row.units} embed=${row.byKind.embed} brain=${row.byKind.brain} judge=${row.byKind.judge} extract=${row.byKind.extract}`);
      }
    }
  }

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
  module.exports = { parseSince, loadEvents, filterEvents, normalizeProject, dayKey, computeStats, loadTop5 };
}
