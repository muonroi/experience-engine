/**
 * experiment.js — session-level holdout assignment and the experiment log.
 *
 * Why session-level (spec §0, §3 A2): randomising per (session, point) made the
 * two arms share one outcome window — a control exposure and a treatment exposure
 * in the same session both "own" the next failure — which dilutes any effect
 * toward zero, and later exposures are conditioned on earlier treatment. So the
 * SESSION is the unit of randomisation and of analysis: a control session gets no
 * passive engine output at all (hints, the risk-gate nudge, prompt auto-recall,
 * the SessionStart brief), a treatment session gets exactly today's behaviour.
 *
 * Assignment is a pure hash of (salt, session id), so every hook process, the
 * server and local mode agree on a session's arm without shared state:
 *   u = fmix32(fnv1a32(salt + "|holdout|" + sessionId)) / 2^32;  control iff u < share.
 * No session id → not in the experiment → today's behaviour.
 *
 * The experiment log (EXPERIENCE_EXPERIMENT_LOG, default ~/.experience/experiment.jsonl)
 * is append-only and written ONLY while an experiment is active. It rotates into
 * date-stamped siblings that are never overwritten; activity.jsonl keeps a single
 * overwritten .1, which a multi-week experiment would outrun.
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');

const _config = require('./config');
const { unitHash, fnv1a32 } = require('./bayes');

const HOLDOUT_EXPERIMENT = 'holdout';
const MODEL_EXPERIMENT = 'confidence-model';
const MAX_EXPERIMENT_LOG_BYTES = 10 * 1024 * 1024;
const ARM_MARKER_DIR = 'experiment-arms';
const ARM_MARKER_KEEP_DAYS = 2;

// --- assignment ----------------------------------------------------------------

// '', 'null' and 'undefined' are what a missing id looks like after a String()
// somewhere upstream (exp-recall's null bucket, see experience-core.js); none of
// them identifies a session, so none may be randomised.
function normalizeSessionId(sessionId) {
  if (sessionId === null || sessionId === undefined) return null;
  const s = String(sessionId).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

/**
 * Holdout arm for a session, or null when the session is not in the experiment
 * (no session id, or share 0). Pure given opts; reads config for missing opts.
 * @returns {{experiment: string, arm: 'control'|'treatment', salt: string, share: number, u: number}|null}
 */
function holdoutArm(sessionId, opts = {}) {
  const share = Number.isFinite(opts.share) ? opts.share : _config.getExperimentHoldoutShare();
  const salt = typeof opts.salt === 'string' ? opts.salt : _config.getExperimentSalt();
  const sid = normalizeSessionId(sessionId);
  if (!sid || !(share > 0)) return null;
  const u = unitHash(`${salt}|holdout|${sid}`);
  return { experiment: HOLDOUT_EXPERIMENT, arm: u < share ? 'control' : 'treatment', salt, share, u };
}

/**
 * confidenceModel 'ab' arm for a session (spec §3 B4): legacy or beta, with the
 * same experiment salt under a separate "|model|" tag, so the model arm is
 * independent of the holdout arm. null without a session id.
 * @returns {{experiment: string, arm: 'beta'|'legacy', salt: string, share: number, u: number}|null}
 */
function modelArm(sessionId, opts = {}) {
  const share = Number.isFinite(opts.share) ? opts.share : _config.getConfidenceAbShare();
  const salt = typeof opts.salt === 'string' ? opts.salt : _config.getExperimentSalt();
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const u = unitHash(`${salt}|model|${sid}`);
  return { experiment: MODEL_EXPERIMENT, arm: u < share ? 'beta' : 'legacy', salt, share, u };
}

/** Is any experiment flag on? Everything experiment-related is a no-op when not. */
function isExperimentActive() {
  return _config.getExperimentHoldoutShare() > 0 || _config.getConfidenceModel() !== 'legacy';
}

/**
 * Which confidence model decides this session's passive path.
 *   mode 'legacy' | 'shadow' → arm 'legacy' (shadow also runs beta, logging only);
 *   mode 'beta' → arm 'beta';
 *   mode 'ab' → the session's hashed arm; no session id → 'legacy', unassigned.
 */
function resolveModel(sessionId) {
  const mode = _config.getConfidenceModel();
  if (mode === 'beta') return { mode, arm: 'beta', assigned: null };
  if (mode === 'ab') {
    const assigned = modelArm(sessionId);
    return { mode, arm: assigned ? assigned.arm : 'legacy', assigned };
  }
  return { mode, arm: 'legacy', assigned: null };
}

/**
 * Resolve once per intercept. Null (and nothing beyond a few config reads) when
 * no experiment is active, so the default path does no extra work.
 */
function resolveInterceptExperiment(sourceMeta) {
  if (!isExperimentActive()) return null;
  const sessionId = normalizeSessionId(sourceMeta?.sourceSession);
  const holdout = holdoutArm(sessionId);
  return {
    active: true,
    sessionId,
    holdout,
    model: resolveModel(sessionId),
    runtime: sourceMeta?.sourceRuntime || null,
  };
}

// --- log -----------------------------------------------------------------------

function logPath() {
  return _config.getExperimentLogPath();
}

function nowIso() {
  // Date.now() rather than new Date(): tests pin Date.now for determinism.
  return new Date(Date.now()).toISOString();
}

function rotationStamp() {
  return nowIso().replace(/[-:.]/g, '');
}

function rotateIfNeeded(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < MAX_EXPERIMENT_LOG_BYTES) return;
  const base = `${file}.${rotationStamp()}`;
  let target = base;
  for (let n = 1; fs.existsSync(target); n++) target = `${base}-${n}`;
  try { fs.renameSync(file, target); } catch { /* another process rotated first */ }
}

/** Append one event. Never throws: the experiment must never break a hook. */
function appendExperimentEvent(event) {
  try {
    const file = logPath();
    fs.mkdirSync(pathMod.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify({ ts: nowIso(), ...event }) + '\n');
    return true;
  } catch {
    return false;
  }
}

function readJsonl(filePath) {
  const out = [];
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * The live log plus every rotated sibling (`<name>.<stamp>[-n]`), oldest first.
 */
function listLogFiles(basePath = logPath()) {
  const dir = pathMod.dirname(basePath);
  const base = pathMod.basename(basePath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names.filter((n) => n.startsWith(base + '.')).sort().map((n) => pathMod.join(dir, n));
  if (names.includes(base)) files.push(basePath);
  return files;
}

function readExperimentLog(basePath = logPath()) {
  return listLogFiles(basePath).flatMap(readJsonl);
}

// --- session-arm (once per session and experiment) ----------------------------

const _armsLogged = new Set();

function utcDay() {
  return nowIso().slice(0, 10);
}

function pruneOldMarkerDays(root, today) {
  try {
    const cutoff = Date.parse(today) - ARM_MARKER_KEEP_DAYS * 86400000;
    for (const name of fs.readdirSync(root)) {
      const t = Date.parse(name);
      if (Number.isFinite(t) && t < cutoff) fs.rmSync(pathMod.join(root, name), { recursive: true, force: true });
    }
  } catch { /* best-effort */ }
}

/**
 * First time this (experiment, salt, session) is seen: log `session-arm`.
 * Hooks run one process per event, so an in-process Set is not enough: an
 * exclusive-create marker file makes "first" hold across processes. Markers live
 * in per-UTC-day directories (old days pruned), so a session spanning midnight
 * may log its arm twice — harmless, the arm is deterministic and the analyzer
 * dedupes.
 */
/**
 * @param {{sessionId?: string|null, experiment?: string, arm?: string, salt?: string|null, runtime?: string|null}} args
 */
function noteSessionArm({ sessionId, experiment, arm, salt, runtime }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid || !experiment || !arm) return false;
  const key = `${experiment}|${salt || ''}|${sid}`;
  if (_armsLogged.has(key)) return false;
  _armsLogged.add(key);
  try {
    const root = pathMod.join(pathMod.dirname(logPath()), ARM_MARKER_DIR);
    const today = utcDay();
    const dayDir = pathMod.join(root, today);
    if (!fs.existsSync(dayDir)) {
      fs.mkdirSync(dayDir, { recursive: true });
      pruneOldMarkerDays(root, today);
    }
    const marker = pathMod.join(dayDir, `${fnv1a32(key).toString(16)}-${sid.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40)}`);
    fs.writeFileSync(marker, '', { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    // Any other marker failure: log anyway — a duplicate beats a missing arm.
  }
  return appendExperimentEvent({ event: 'session-arm', sourceSession: sid, experiment, arm, salt: salt || null, runtime: runtime || null });
}

// --- event builders --------------------------------------------------------------

function hookEventForTool(toolName, explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  const t = String(toolName || '');
  if (t === 'UserPrompt') return 'UserPromptSubmit';
  if (t === 'PostToolBatch') return 'PostToolBatch';
  return 'PreToolUse';
}

/**
 * @param {{sessionId?: string|null, interceptId?: string, tool?: string, toolUseId?: string|null,
 *   hookEvent?: string|null, shown?: string[], graphShown?: string[], runtime?: string|null,
 *   arm?: string|null, extra?: object}} args
 */
function logExposure({ sessionId, interceptId, tool, toolUseId, hookEvent, shown, graphShown, runtime, arm, extra }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return false;
  return appendExperimentEvent({
    event: 'exposure',
    sourceSession: sid,
    interceptId,
    tool: tool || null,
    toolUseId: toolUseId || null,
    hookEvent: hookEventForTool(tool, hookEvent),
    arm: arm || null,
    shown: Array.isArray(shown) ? shown.map(String) : [],
    graphShown: Array.isArray(graphShown) ? graphShown.map(String) : [],
    runtime: runtime || null,
    ...(extra || {}),
  });
}

/**
 * @param {{sessionId?: string|null, toolUseId?: string|null, tool?: string, inputHash?: string|null,
 *   failure?: string|null, toolOutcome?: string|null, clientTs?: string|null, runtime?: string|null,
 *   hookEvent?: string|null}} args
 */
function logOutcome({ sessionId, toolUseId, tool, inputHash, failure, toolOutcome, clientTs, runtime, hookEvent }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return false;
  return appendExperimentEvent({
    event: 'outcome',
    sourceSession: sid,
    toolUseId: toolUseId || null,
    tool: tool || null,
    inputHash: inputHash || null,
    failure: failure || null,
    toolOutcome: toolOutcome || null,
    clientTs: clientTs || null,
    runtime: runtime || null,
    hookEvent: hookEvent || null,
  });
}

/**
 * Record the holdout arm for a session seen outside interceptWithMeta (posttool,
 * the brief), so a session with outcomes but no logged intercept still has one.
 * Returns the arm object (or null).
 */
function noteHoldoutFor(sessionId, runtime) {
  if (!isExperimentActive()) return null;
  const arm = holdoutArm(sessionId);
  if (arm) noteSessionArm({ sessionId, experiment: arm.experiment, arm: arm.arm, salt: arm.salt, runtime });
  return arm;
}

function _resetForTests() {
  _armsLogged.clear();
}

module.exports = {
  HOLDOUT_EXPERIMENT,
  MODEL_EXPERIMENT,
  modelArm,
  resolveModel,
  MAX_EXPERIMENT_LOG_BYTES,
  normalizeSessionId,
  holdoutArm,
  isExperimentActive,
  resolveInterceptExperiment,
  appendExperimentEvent,
  readJsonl,
  listLogFiles,
  readExperimentLog,
  noteSessionArm,
  noteHoldoutFor,
  hookEventForTool,
  logExposure,
  logOutcome,
  _resetForTests,
};
