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
  let classifyViaBrain, recordJudgeFeedback;
  try {
    const core = require(path.join(EXP_DIR, 'experience-core.js'));
    classifyViaBrain    = core.classifyViaBrain;
    recordJudgeFeedback = core.recordJudgeFeedback;
  } catch {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  if (typeof classifyViaBrain !== 'function' || typeof recordJudgeFeedback !== 'function') {
    try { fs.unlinkSync(normalised); } catch {}
    process.exit(0);
  }

  // Judge each suggestion in parallel — one LLM call per suggestion
  const VALID_VERDICTS = new Set(['FOLLOWED', 'IGNORED', 'IRRELEVANT', 'UNCLEAR']);

  await Promise.allSettled(surfacedIds.map(async ({ collection, id, solution }) => {
    if (!solution || !id || !collection) return;

    const prompt =
      `HINT: ${solution}\nTOOL: ${toolName}\nACTION: ${toolInput || ''}\n\n` +
      `Classify: did the agent follow this hint?\n` +
      `Reply with exactly one word: FOLLOWED, IGNORED, IRRELEVANT, or UNCLEAR.\n` +
      `- FOLLOWED: agent action aligns with hint\n` +
      `- IGNORED: hint was relevant but agent did not follow\n` +
      `- IRRELEVANT: hint does not apply to this tool/file/context\n` +
      `- UNCLEAR: cannot determine`;

    let verdict = 'UNCLEAR';
    try {
      const raw  = await classifyViaBrain(prompt, 8000);
      const word = (raw || '').trim().toUpperCase().split(/\s+/)[0];
      if (VALID_VERDICTS.has(word)) verdict = word;
    } catch {
      // Any exception → UNCLEAR
    }

    // Hybrid signal: error outcome + UNCLEAR → IGNORED
    if (verdict === 'UNCLEAR' && toolOutcome === 'error') verdict = 'IGNORED';

    // UNCLEAR → no feedback (neutral)
    if (verdict === 'UNCLEAR') return;

    try {
      await recordJudgeFeedback(collection, id, verdict);
    } catch {
      // Ignore — feedback failure must not crash worker
    }
  }));

  try { fs.unlinkSync(normalised); } catch {}
  process.exit(0);
})();
