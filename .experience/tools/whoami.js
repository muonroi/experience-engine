#!/usr/bin/env node
'use strict';

/**
 * whoami.js — "Who Am I" v4.0 profile viewer / rebuilder (slice 1).
 *
 * The profile is built passively on the Stop hook (when privacyLevel != off).
 * This CLI is the "View" right plus an offline rebuild for testing/backfill.
 *
 * Usage:
 *   node tools/whoami.js                  # print current profile.yaml
 *   node tools/whoami.js --json           # machine-readable model
 *   node tools/whoami.js --rebuild        # re-run detector over the activity window + latest transcript
 *   node tools/whoami.js --rebuild --since 2026-06-01T00:00:00Z
 *
 * Rebuild reads only local data (activity.jsonl + the latest session transcript)
 * and runs the rule-based detector — no LLM, no network.
 */

const fs = require('node:fs');
const config = require('../src/config');
const { detectSignals, readActivityEvents } = require('../src/signal-detector');
const { loadProfile, aggregateProfile, saveProfile, serializeProfile, emptyProfile } = require('../src/profile-model');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rebuild = args.includes('--rebuild');
const sinceArg = (() => {
  const i = args.indexOf('--since');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

function printProfile(profile) {
  if (asJson) { console.log(JSON.stringify(profile)); return; }
  process.stdout.write(serializeProfile(profile));
}

function doRebuild() {
  const level = config.getPrivacyLevel();
  if (level === 'off') {
    console.error('[whoami] privacyLevel is "off" — set EXPERIENCE_PRIVACY_LEVEL=minimal|standard (or config.json) to enable profiling.');
    process.exit(2);
  }
  const now = Date.now();
  const sinceMs = sinceArg ? Date.parse(sinceArg) : now - config.getSignalWindowDays() * 86400000;

  let transcript = '';
  if (level !== 'minimal') {
    try {
      const stop = require('../stop-extractor');
      const { compactTranscript } = require('../extract-compact');
      const session = stop.findCurrentSession();
      if (session) transcript = compactTranscript(stop.buildSessionData(session, 0).transcript || '');
    } catch (err) {
      console.error(`[whoami] could not load latest transcript (continuing with activity-only): ${err?.message}`);
    }
  }

  const { events, skipped } = readActivityEvents(config.getActivityLogPath(), Number.isFinite(sinceMs) ? sinceMs : 0);
  const { signals, stats } = detectSignals({ transcript, activityEvents: events, now });
  const profile = aggregateProfile(loadProfile(config.getProfilePath()), signals, { now });
  saveProfile(profile, config.getProfilePath());

  if (!asJson) {
    console.error(`[whoami] rebuilt: ${signals.length} signals from ${stats.activityRows} activity rows + ${stats.userTurns} user turns (${skipped} malformed lines skipped)`);
  }
  printProfile(profile);
}

function doView() {
  const p = config.getProfilePath();
  if (!fs.existsSync(p)) {
    if (asJson) { console.log(JSON.stringify(emptyProfile())); return; }
    console.error(`[whoami] no profile yet at ${p}. Enable with EXPERIENCE_PRIVACY_LEVEL=standard and finish a session, or run --rebuild.`);
    return;
  }
  printProfile(loadProfile(p));
}

if (rebuild) doRebuild();
else doView();
