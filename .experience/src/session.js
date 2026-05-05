/**
 * session.js — Session-persistent tracking for Experience Engine.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 * Each hook invocation is a NEW process, so in-memory arrays are useless.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');

const {
  MAX_SESSION_UNIQUE,
  VALID_FEEDBACK_VERDICTS, VALID_NOISE_REASONS,
  VALID_NOISE_DISPOSITIONS, VALID_NOISE_SOURCES,
} = require('./config');

// --- Session-persistent tracking (file-based, survives process restarts) ---
const SESSION_TRACK_DIR = pathMod.join(require('os').tmpdir(), 'experience-session');

function sanitizeSessionToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function getSessionTrackFile(meta) {
  try { fs.mkdirSync(SESSION_TRACK_DIR, { recursive: true }); } catch {}
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sessionToken = sanitizeSessionToken(
    meta?.sourceSession
    || process.env.CODEX_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.GEMINI_SESSION_ID
  );
  if (sessionToken) {
    return pathMod.join(SESSION_TRACK_DIR, `session-${today}-${sessionToken}.json`);
  }
  // Fallback: YYYYMMDD + CWD hash when no runtime session id is available.
  const cwd = process.cwd() || '';
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) { hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0; }
  const sessionKey = `${today}-${(hash >>> 0).toString(36)}`;
  return pathMod.join(SESSION_TRACK_DIR, `session-${sessionKey}.json`);
}

function readSessionTrack(meta) {
  try {
    const raw = fs.readFileSync(getSessionTrackFile(meta), 'utf8');
    const data = JSON.parse(raw);
    // Expire after 2 hours (session likely ended)
    if (Date.now() - (data.startedAt || 0) > 2 * 60 * 60 * 1000) return { startedAt: Date.now(), seen: {}, counts: {}, pending: {} };
    if (!data.pending || typeof data.pending !== 'object' || Array.isArray(data.pending)) data.pending = {};
    return data;
  } catch {
    return { startedAt: Date.now(), seen: {}, counts: {}, pending: {} };
  }
}

function writeSessionTrack(track, meta) {
  try { fs.writeFileSync(getSessionTrackFile(meta), JSON.stringify(track)); } catch {}
}

/**
 * Track surfaced suggestions in persistent session file.
 * Returns: { filtered: ids to skip (already shown), flagged: ids with 3+ repeats }
 */
function trackSuggestions(surfacedPoints, meta) {
  const track = readSessionTrack(meta);
  const flagged = [];
  const filtered = [];

  for (const sp of surfacedPoints) {
    const key = sp.id;
    track.counts[key] = (track.counts[key] || 0) + 1;

    // NOISE-04: flag for ignore-count increment after 3+ repeats
    if (track.counts[key] >= 3) {
      flagged.push({ id: sp.id, collection: sp.collection, consecutive: track.counts[key] });
    }

    // P4: Dedup — skip if already shown in this session
    if (track.seen[key]) {
      filtered.push(sp);
      continue;
    }
    track.seen[key] = Date.now();
  }

  writeSessionTrack(track, meta);
  return { flagged, filtered };
}

/**
 * P2: Check if session budget is exhausted (max unique experiences).
 * Returns number of unique experiences already shown.
 */
function sessionUniqueCount(meta) {
  const track = readSessionTrack(meta);
  return Object.keys(track.seen).length;
}

function incrementIgnoreCountData(data) {
  data.ignoreCount = (data.ignoreCount || 0) + 1;
  return data;
}

function incrementIrrelevantData(data) {
  data.irrelevantCount = (data.irrelevantCount || 0) + 1;
  data.lastIrrelevantAt = new Date().toISOString();
  return data;
}

function incrementUnusedData(data) {
  data.unusedCount = (data.unusedCount || 0) + 1;
  data.lastUnusedAt = new Date().toISOString();
  return data;
}

function normalizeNoiseDisposition(disposition) {
  const normalized = String(disposition || '').trim().toLowerCase();
  return VALID_NOISE_DISPOSITIONS.has(normalized) ? normalized : null;
}

function normalizeNoiseSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  return VALID_NOISE_SOURCES.has(normalized) ? normalized : null;
}

function normalizeFeedbackVerdict(verdictOrFollowed) {
  if (typeof verdictOrFollowed === 'boolean') {
    return verdictOrFollowed ? 'FOLLOWED' : 'IGNORED';
  }
  const verdict = String(verdictOrFollowed || '').trim().toUpperCase();
  return VALID_FEEDBACK_VERDICTS.has(verdict) ? verdict : null;
}

function normalizeNoiseReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return VALID_NOISE_REASONS.has(normalized) ? normalized : null;
}

function shortPointId(pointId) {
  return String(pointId || '').slice(0, 8);
}

function dedupeSuggestionLines(lines) {
  const seen = new Set();
  const unique = [];
  for (const line of lines || []) {
    const normalized = String(line || '').trim();
    if (!normalized) continue;
    const idMatch = normalized.match(/\[id:([^\s\]]+)\s+col:([^\]]+)\]/);
    const key = idMatch ? `${idMatch[2]}:${idMatch[1]}` : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique;
}

module.exports = {
  sanitizeSessionToken, getSessionTrackFile,
  readSessionTrack, writeSessionTrack,
  trackSuggestions, sessionUniqueCount,
  incrementIgnoreCountData, incrementIrrelevantData, incrementUnusedData,
  normalizeNoiseDisposition, normalizeNoiseSource,
  normalizeFeedbackVerdict, normalizeNoiseReason,
  shortPointId, dedupeSuggestionLines,
};
