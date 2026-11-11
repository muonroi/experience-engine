/**
 * logger.js - zero-dependency structured runtime logger.
 */
'use strict';

// Structured diagnostics always go to stderr. stdout is reserved for a tool's
// own output (e.g. the JSON document of `exp-gates.js --json`), so a warn line
// emitted while a tool runs must never be interleaved with it.
const LEVEL_STREAM = {
  error: 'stderr',
  warn: 'stderr',
  info: 'stderr',
  debug: 'stderr',
};

const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getLogLevel() {
  const value = String(process.env.EXPERIENCE_LOG_LEVEL || 'info').toLowerCase().trim();
  return LEVEL_PRIORITY[value] === undefined ? 'info' : value;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack ? String(error.stack).split('\n').slice(0, 6).join('\n') : null,
  };
}

function log(level, msg, meta = {}) {
  const normalizedLevel = LEVEL_STREAM[level] ? level : 'info';
  if (LEVEL_PRIORITY[normalizedLevel] > LEVEL_PRIORITY[getLogLevel()]) return;
  const entry = {
    ts: new Date().toISOString(),
    level: normalizedLevel,
    msg,
    ...meta,
  };
  const streamName = LEVEL_STREAM[normalizedLevel];
  process[streamName].write(JSON.stringify(entry) + '\n');
}

module.exports = {
  log,
  serializeError,
};
