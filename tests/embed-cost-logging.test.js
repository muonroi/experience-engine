#!/usr/bin/env node
'use strict';

/**
 * embed-cost-logging.test.js — config.activityLog wiring.
 *
 * src/config.js exposes activityLog as a setter-guarded no-op to avoid a
 * require cycle with src/activity.js. src/embedding.js logs embed cost-calls
 * through config.activityLog, so until something calls config.setActivityLog()
 * those events are silently dropped — which left /health embed status stuck at
 * "unknown" (no cost-call/embed entries ever reached activity.jsonl).
 *
 * experience-core.js is the shared entry the server loads; it must wire the
 * real file logger. These tests pin that contract.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Must be set before src/activity.js is required — it captures ACTIVITY_LOG at
// module load. Route writes to a throwaway file so we don't touch the real log.
const TMP_LOG = path.join(os.tmpdir(), `ee-embed-cost-${process.pid}-${Date.now()}.jsonl`);
process.env.EXPERIENCE_ACTIVITY_LOG = TMP_LOG;

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../.experience/src/config');

test.after(() => { try { fs.unlinkSync(TMP_LOG); } catch { /* best-effort cleanup */ } });

test('config.activityLog is a no-op before wiring', () => {
  config.activityLog({ op: 'cost-call', kind: 'embed', probe: 'pre-wire' });
  const wrote = fs.existsSync(TMP_LOG) && fs.readFileSync(TMP_LOG, 'utf8').includes('pre-wire');
  assert.equal(wrote, false, 'unwired config.activityLog must not persist anything');
});

test('requiring experience-core wires config.activityLog so embed cost-calls persist', () => {
  // Requiring the shared entry runs `_config.setActivityLog(_activity.activityLog)`.
  require('../.experience/experience-core.js');
  config.activityLog({ op: 'cost-call', kind: 'embed', provider: 'test', probe: 'post-wire' });
  const content = fs.readFileSync(TMP_LOG, 'utf8');
  assert.ok(content.includes('"kind":"embed"'), 'embed cost-call must be written after wiring');
  assert.ok(content.includes('post-wire'), 'the specific event must be persisted');
});
