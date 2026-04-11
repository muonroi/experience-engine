#!/usr/bin/env node
'use strict';
/**
 * judge-worker.js — detached LLM judge for experience feedback
 *
 * Called by interceptor-post.js via:
 *   spawn(process.execPath, [__filename, queueFile], { detached: true, stdio: 'ignore' })
 *
 * Reads a queue JSON file, calls classifyViaBrain() for each surfaced suggestion,
 * records feedback via recordFeedback(), then deletes the queue file.
 *
 * All errors are swallowed — a crashing judge must never affect agent flow.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXP_DIR   = path.join(os.homedir(), '.experience');
const queueFile = process.argv[2];

// Validate path to prevent path traversal (T-b3s-01)
// Must reside inside ~/.experience/tmp/ and match judge-*.json pattern
if (!queueFile) process.exit(0);
const tmpDir     = path.join(EXP_DIR, 'tmp');
const normalised = path.resolve(queueFile);
if (!normalised.startsWith(path.resolve(tmpDir) + path.sep) &&
    normalised !== path.resolve(tmpDir)) {
  process.exit(0);
}
const basename = path.basename(normalised);
if (!/^judge-\d+\.json$/.test(basename)) process.exit(0);
if (!fs.existsSync(normalised)) process.exit(0);

(async () => {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(normalised, 'utf8'));
  } catch {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  const { surfacedIds = [], toolName = '', toolInput = '', toolOutcome = null } = data;

  // Load core functions from experience-core.js
  let classifyViaBrain, recordFeedback;
  try {
    const core = require(path.join(EXP_DIR, 'experience-core.js'));
    classifyViaBrain = core.classifyViaBrain;
    recordFeedback   = core.recordFeedback;
  } catch {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  if (typeof classifyViaBrain !== 'function' || typeof recordFeedback !== 'function') {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  // Judge each suggestion in parallel — one LLM call per suggestion
  await Promise.allSettled(surfacedIds.map(async ({ collection, id, solution }) => {
    if (!solution || !id || !collection) return;

    const prompt =
      `HINT: ${solution}\nTOOL: ${toolName}\nACTION: ${toolInput || ''}\n\n` +
      `Did the agent follow this hint? Reply with exactly one word: FOLLOWED, IGNORED, or UNCLEAR.`;

    let result = null;
    try {
      // classifyViaBrain signature: (prompt, timeoutMs) — no options object
      const raw  = await classifyViaBrain(prompt, 8000);
      // Parse strictly: take first word only (T-b3s-04)
      const word = (raw || '').trim().toUpperCase().split(/\s+/)[0];
      if (word === 'FOLLOWED') result = true;
      else if (word === 'IGNORED') result = false;
      // UNCLEAR or anything else → result stays null → no feedback recorded
    } catch {
      // Any exception → treat as UNCLEAR
    }

    // Hybrid signal (per D-decision): error outcome + UNCLEAR → followed=false
    if (result === null && toolOutcome === 'error') result = false;

    if (result !== null) {
      try {
        await recordFeedback(collection, id, result);
      } catch {
        // Ignore — feedback failure must not crash worker
      }
    }
  }));

  try { fs.unlinkSync(normalised); } catch {}
  process.exit(0);
})();
