/**
 * signal-detector.js — "Who Am I" v4.0, slice 1.
 *
 * Rule-based (NO-LLM) extraction of behavioral signals from data the engine
 * ALREADY produces locally: the session transcript (User:/Assistant: lines,
 * assembled by stop-extractor.js) and ~/.experience/activity.jsonl (op + ts
 * per event). Emits many small weighted "votes"; profile-model.js aggregates
 * them with an N>=10 gate so a single session cannot define a dimension.
 *
 * Design contract: the core (detectSignals + classifiers) is PURE — caller
 * supplies the transcript string + parsed activity events. Only readActivityEvents
 * touches the filesystem, and it logs (never swallows) read failures.
 *
 * Signal shape: { dimension, value, weight, evidence }
 *   dimension — dotted path into the profile model (e.g. "communication.question_style")
 *   value     — the categorical label voted for
 *   weight    — vote strength (1 default; cadence/aggregate signals may differ)
 *   evidence  — short human-readable snippet (truncated) for the profile's audit trail
 */
'use strict';

const fs = require('node:fs');

const MAX_EVIDENCE = 120;
const SESSION_GAP_MS = 60 * 60 * 1000; // inter-prompt gaps beyond 1h are session boundaries, not "thinking time"

function trunc(s, n = MAX_EVIDENCE) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// --- transcript parsing -------------------------------------------------

/**
 * Parse the compacted transcript into ordered turns. Lines look like
 * "User: ...", "Assistant: ...", "ToolOutput: ...". A turn's text continues
 * on following lines until the next role label.
 * @returns {Array<{role:'user'|'assistant'|'tool', text:string}>}
 */
function parseTranscriptTurns(transcript) {
  const turns = [];
  const lines = String(transcript || '').split('\n');
  const LABEL = /^(User|Assistant|ToolOutput|ToolCall|Session cwd):\s?(.*)$/;
  let cur = null;
  for (const line of lines) {
    const m = line.match(LABEL);
    if (m) {
      if (cur) turns.push(cur);
      const role = m[1] === 'User' ? 'user' : m[1] === 'Assistant' ? 'assistant' : 'tool';
      cur = { role, text: m[2] || '' };
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line;
    }
  }
  if (cur) turns.push(cur);
  return turns.filter((t) => t.role === 'user' || t.role === 'assistant');
}

// --- classifiers (vi + en, the user mixes vi-en-technical) --------------

const QUESTION_RULES = [
  { value: 'comparison', re: /\b(hay|hoặc|vs\.?|so với)\b.*\b(tốt hơn|hơn|better|nên dùng)\b|\b(nên dùng|chọn) .* (hay|or) /i },
  { value: 'debugging', re: /\b(tại sao|vì sao|sao lại|why)\b.*\b(không|lỗi|fail|sai|broken|crash)\b|\b(lỗi|bug|error|exception|crash|fail(ed|ing)?)\b/i },
  { value: 'exploratory', re: /\b(có khả thi|khả thi|có nên|có thể|liệu|được không|ổn không|feasible|should i|can (i|we)|is it possible|what if)\b|\?\s*$/i },
  { value: 'directive', re: /\b(làm|fix|sửa|build|tạo|thêm|implement|add|create|refactor|viết|chạy|commit|push|xoá|xóa|remove|update|dựng)\b/i },
];

/** Classify a user prompt's question style. Returns a label or null. */
function classifyQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const rule of QUESTION_RULES) {
    if (rule.re.test(t)) return rule.value;
  }
  return null;
}

// Short responses to a prior assistant turn → feedback / conflict / risk signals.
// NB: avoid \b anchors — JS \b is ASCII-only and fails around Vietnamese
// diacritics (e.g. \b before "ý" never matches). Use explicit edge guards instead.
const SHORT_ACK = /^(ok(e|ay)?|oké|được|ngon|good|perfect|tuyệt|chuẩn|đúng rồi|yep|👍|thanks|cảm ơn)[\s.!]*$/i;
const CORRECTION = /(không[,\s]|ý tôi là|ý mình là|nhầm|not what|i meant|that'?s wrong|incorrect|chưa đúng|(^|[\s.,!])sai([\s.,!]|$))/i;
const AUTHORITATIVE = /(làm theo cách (tôi|mình)|do it my way|cứ làm|phải làm)/i;
const CAUTIOUS = /(bạn có chắc|có chắc không|are you sure|chắc chưa|kiểm tra lại|double check)/i;
const EXPERIMENTAL = /(thử đi|cứ thử|thử xem|try it|just try)/i;

/**
 * Classify a short user response. Returns an array of {dimension,value} votes
 * (a turn can vote for more than one, e.g. correction → feedback + conflict).
 */
function classifyResponse(text) {
  const t = String(text || '').trim();
  const out = [];
  if (!t) return out;
  if (SHORT_ACK.test(t)) out.push({ dimension: 'communication.feedback_style', value: 'implicit' });
  if (CORRECTION.test(t)) {
    out.push({ dimension: 'communication.feedback_style', value: 'precise-correction' });
    out.push({ dimension: 'personality.conflict_style', value: 'direct-constructive' });
  }
  if (AUTHORITATIVE.test(t)) out.push({ dimension: 'personality.conflict_style', value: 'authoritative' });
  if (CAUTIOUS.test(t)) out.push({ dimension: 'personality.conflict_style', value: 'cautious' });
  if (EXPERIMENTAL.test(t)) out.push({ dimension: 'personality.risk_tolerance', value: 'experimental' });
  return out;
}

// --- core: detectSignals (pure) -----------------------------------------

/**
 * @param {object} args
 * @param {string} args.transcript        compacted transcript (User:/Assistant: lines)
 * @param {Array<object>} args.activityEvents  parsed activity.jsonl rows ({ts, op, ...})
 * @returns {{signals:Array, stats:object}}
 * Note: timestamps are read from the events themselves; no wall-clock "now" is needed.
 */
function detectSignals({ transcript = '', activityEvents = [] } = {}) {
  const signals = [];
  const stats = { userTurns: 0, classifiedQuestions: 0, responseVotes: 0, activityRows: activityEvents.length };

  // 1. Transcript-derived: question_style + feedback/conflict/risk (Tang 2).
  const turns = parseTranscriptTurns(transcript);
  let prevWasAssistant = false;
  let brevitySum = 0;
  let brevityN = 0;
  for (const turn of turns) {
    if (turn.role !== 'user') { prevWasAssistant = turn.role === 'assistant'; continue; }
    stats.userTurns++;
    brevitySum += turn.text.length; brevityN++;

    const q = classifyQuestion(turn.text);
    if (q) {
      stats.classifiedQuestions++;
      signals.push({ dimension: 'communication.question_style', value: q, weight: 1, evidence: trunc(turn.text) });
    }
    // Response signals only make sense as a reply to a prior assistant turn.
    if (prevWasAssistant) {
      for (const vote of classifyResponse(turn.text)) {
        stats.responseVotes++;
        signals.push({ ...vote, weight: 1, evidence: trunc(turn.text) });
      }
    }
    prevWasAssistant = false;
  }
  // Brevity as a single aggregate vote (avg user-prompt length): <240 chars → concise.
  if (brevityN > 0) {
    const avg = brevitySum / brevityN;
    signals.push({
      dimension: 'communication.brevity',
      value: avg < 240 ? 'concise' : avg < 700 ? 'moderate' : 'verbose',
      weight: 1,
      evidence: `avg user-prompt length ${Math.round(avg)} chars over ${brevityN} turns`,
    });
  }

  // 2. Activity-derived: decision_speed + work_patterns (Tang 1).
  const prompts = activityEvents
    .filter((e) => e && e.op === 'hook' && e.hook === 'interceptor-prompt' && e.ts)
    .map((e) => Date.parse(e.ts))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  // decision_speed: median inter-prompt gap, excluding cross-session gaps.
  const gaps = [];
  for (let i = 1; i < prompts.length; i++) {
    const d = prompts[i] - prompts[i - 1];
    if (d > 0 && d < SESSION_GAP_MS) gaps.push(d);
  }
  if (gaps.length >= 3) {
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    signals.push({
      dimension: 'personality.decision_speed',
      value: median < 90 * 1000 ? 'fast-intuitive' : median < 6 * 60 * 1000 ? 'measured' : 'deliberate',
      weight: 1,
      evidence: `median inter-prompt gap ${Math.round(median / 1000)}s over ${gaps.length} gaps`,
    });
  }

  // work_patterns.energy: hour-of-day histogram across all timestamped events.
  const hours = new Array(24).fill(0);
  let tsCount = 0;
  for (const e of activityEvents) {
    if (!e || !e.ts) continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    hours[new Date(ms).getHours()]++;
    tsCount++;
  }
  if (tsCount >= 10) {
    const night = hours.slice(22).concat(hours.slice(0, 5)).reduce((a, b) => a + b, 0); // 22:00–04:59
    const ratio = night / tsCount;
    signals.push({
      dimension: 'work_patterns.energy',
      value: ratio > 0.4 ? 'night-owl' : ratio < 0.1 ? 'daytime' : 'mixed',
      weight: 1,
      evidence: `${Math.round(ratio * 100)}% of ${tsCount} events in 22:00–05:00`,
    });
  }

  // work_patterns.multitasking: distinct projects touched in the window.
  const projects = new Set();
  for (const e of activityEvents) {
    const p = e && (e.project || e.projectSlug);
    if (p && typeof p === 'string') projects.add(p);
  }
  if (projects.size > 0) {
    signals.push({
      dimension: 'work_patterns.multitasking',
      value: projects.size >= 4 ? 'task-switcher' : 'sequential-deep',
      weight: 1,
      evidence: `${projects.size} distinct projects in window`,
    });
  }

  // work_patterns.session_length (Tang 1): segment the prompt stream into sessions
  // using the SAME SESSION_GAP_MS boundary as decision_speed, then bucket each
  // session's first→last duration. detectSignals runs over a MULTI-session window
  // (stop-extractor passes ~30 days of activity), so we emit ONE vote per session —
  // never a single naive last-minus-first — which feeds the N>=10 aggregation gate
  // with one sample per session. Single-prompt sessions have no duration → skipped.
  if (prompts.length >= 2) {
    let runStart = prompts[0];
    let prevTs = prompts[0];
    let runCount = 1;
    const flushSession = () => {
      if (runCount >= 2) {
        const durMin = (prevTs - runStart) / 60000;
        if (durMin > 0) {
          signals.push({
            dimension: 'work_patterns.session_length',
            value: durMin < 15 ? 'short' : durMin < 60 ? 'medium' : 'long',
            weight: 1,
            evidence: `session ~${Math.round(durMin)}min over ${runCount} prompts`,
          });
        }
      }
    };
    for (let i = 1; i < prompts.length; i++) {
      if (prompts[i] - prevTs >= SESSION_GAP_MS) {
        flushSession();
        runStart = prompts[i];
        runCount = 1;
      } else {
        runCount++;
      }
      prevTs = prompts[i];
    }
    flushSession();
  }

  return { signals, stats };
}

// --- runbook-candidate detection (pure) ---------------------------------

const RUNBOOK_STITCH_MIN_DEFAULT = 3;

/**
 * Detect a "you stitched N recalls and should crystallize a runbook" signal
 * from recorded op:'recall' activity rows (see activity.buildRecallEvent). Pure:
 * the caller supplies the parsed events + an optional isRunbookId predicate so
 * the function never touches the filesystem or the brain.
 *
 * A candidate fires when, within one session (opts.sessionId), the agent ran
 * >= minStitch DISTINCT recalls whose surfaced entries overlap (>= 2 atomic
 * ids recur across >= 2 recalls) AND none of the surfaced ids is already a
 * runbook (isRunbookId). This mirrors proposal §3.3 — the engine only PROPOSES
 * the candidate (observed ids + queries); ordering/causality is left to the
 * agent/human (§3.5), so we never synthesize a body here.
 *
 * isRunbookId defaults to () => false: activity rows carry only ids, not
 * nodeKind, so without an injected resolver we conservatively assume no runbook
 * is present and still propose. That is the intended bias — a spurious "want a
 * runbook?" prompt is cheap; a missed one is the gap we are closing.
 *
 * @param {Array<object>} activityEvents  parsed activity.jsonl rows
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId]  restrict to rows with this sourceSession
 * @param {number} [opts.minStitch=3]     distinct-recall threshold
 * @param {(id:string)=>boolean} [opts.isRunbookId]  true if an id is a runbook entry
 * @returns {null | {sessionId, recallCount, queries:string[], recurringIds:string[], project_slug:(string|null), topic:string}}
 */
function detectRunbookCandidates(activityEvents = [], opts = {}) {
  const minStitch = Number.isFinite(opts.minStitch) && opts.minStitch >= 2
    ? Math.round(opts.minStitch)
    : RUNBOOK_STITCH_MIN_DEFAULT;
  const isRunbookId = typeof opts.isRunbookId === 'function' ? opts.isRunbookId : () => false;
  const sessionId = opts.sessionId != null ? String(opts.sessionId) : null;

  let rows = (Array.isArray(activityEvents) ? activityEvents : []).filter((e) => e && e.op === 'recall');
  if (sessionId) {
    rows = rows.filter((e) => e && e.sourceSession != null && String(e.sourceSession) === sessionId);
  }
  if (rows.length < minStitch) return null;

  // Collapse exact-duplicate recalls (same query + same surfaced set) — a re-run
  // is not a separate stitch. Each distinct recall votes once per id it surfaced.
  const seen = new Set();
  const distinct = [];
  for (const e of rows) {
    const ids = Array.isArray(e.surfacedIds)
      ? Array.from(new Set(e.surfacedIds.map((x) => String(x)).filter(Boolean)))
      : [];
    const sig = `${String(e.query || '')} ${ids.slice().sort().join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    distinct.push({ query: e.query ? String(e.query) : '', ids, project_slug: e.project_slug || null });
  }
  if (distinct.length < minStitch) return null;

  const idRowCount = new Map();   // id -> # distinct recalls that surfaced it
  const projectCounts = new Map();
  const queries = [];
  let runbookPresent = false;
  for (const r of distinct) {
    for (const id of r.ids) {
      idRowCount.set(id, (idRowCount.get(id) || 0) + 1);
      if (isRunbookId(id)) runbookPresent = true;
    }
    if (r.query) queries.push(r.query);
    if (r.project_slug) projectCounts.set(r.project_slug, (projectCounts.get(r.project_slug) || 0) + 1);
  }

  // A runbook already covers this stitch → nothing to crystallize (§3.3).
  if (runbookPresent) return null;

  const recurringIds = [...idRowCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
  if (recurringIds.length < 2) return null;   // §3.3 "≥2 distinct atomic entries recur"

  let project_slug = null;
  let best = 0;
  for (const [p, n] of projectCounts) {
    if (n > best) { best = n; project_slug = p; }
  }

  return {
    sessionId,
    recallCount: distinct.length,
    queries,
    recurringIds,
    project_slug,
    topic: project_slug || trunc(queries[0] || '', 80),
  };
}

// --- I/O boundary -------------------------------------------------------

/**
 * Read activity.jsonl into parsed rows, optionally filtered to >= sinceMs.
 * Malformed lines are skipped but COUNTED (never silently swallowed): the count
 * is returned so the caller can log an activity 'signal-skip' op.
 * @returns {{events:Array, skipped:number}}
 */
function readActivityEvents(logPath, sinceMs = 0) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { events: [], skipped: 0 };
    console.error(`[signal-detector] cannot read ${logPath}: ${err?.message}`);
    return { events: [], skipped: 0 };
  }
  const events = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { skipped++; continue; }
    if (sinceMs && e.ts) {
      const ms = Date.parse(e.ts);
      if (Number.isFinite(ms) && ms < sinceMs) continue;
    }
    events.push(e);
  }
  return { events, skipped };
}

module.exports = {
  detectSignals,
  detectRunbookCandidates,
  parseTranscriptTurns,
  classifyQuestion,
  classifyResponse,
  readActivityEvents,
  SESSION_GAP_MS,
  RUNBOOK_STITCH_MIN_DEFAULT,
};
