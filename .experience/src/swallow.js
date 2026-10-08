/**
 * swallow.js — record an error that is deliberately not propagated.
 *
 * Hooks and background paths must never fail the agent, so many errors are
 * caught and dropped. A bare `catch {}` also hides a path that breaks for good
 * (the embed cost log that was never written, /health stuck at "unknown").
 * `swallow(where, err)` keeps the don't-throw contract but appends one
 * `{op:'swallowed'}` line to activity.jsonl, which /metrics counts per `where`.
 *
 * Writes to a file only, never stdout: a hook's stdout is its protocol with the
 * agent. Node built-ins only, so it is thin-client safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_MSG = 300;

function activityLogPath() {
  return process.env.EXPERIENCE_ACTIVITY_LOG || path.join(os.homedir(), '.experience', 'activity.jsonl');
}

function isMissing(err) {
  return !!err && err.code === 'ENOENT';
}

function swallow(where, err) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      op: 'swallowed',
      where: String(where || 'unknown'),
      code: err && err.code ? String(err.code) : null,
      msg: String((err && err.message) || err || '').slice(0, MAX_MSG),
    };
    fs.appendFileSync(activityLogPath(), JSON.stringify(entry) + '\n');
  } catch { /* the activity log itself is unwritable — nothing left to report to */ }
}

// Unlink that treats "already gone" as success and records anything else.
function safeUnlink(file, where = 'unlink') {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (!isMissing(err)) swallow(where, err);
    return false;
  }
}

module.exports = { swallow, safeUnlink, isMissing };
