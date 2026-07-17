'use strict';

/**
 * mcp/ee-api.js — the brain calls behind the ee_* MCP tools.
 *
 * Deliberately thin: recall and feedback delegate to `.experience/exp-recall.js`
 * and `.experience/exp-feedback.js`, the same modules the CLI helpers use. That
 * is not code-golf — those already resolve serverBaseUrl + serverAuthToken from
 * ~/.experience/config.json (so this works on thin clients pointed at the hosted
 * brain, not just localhost:8082), and exp-recall additionally mirrors the recall
 * into the LOCAL activity.jsonl, which is what the session-end runbook-candidate
 * nudge reads. Re-implementing the transport here would silently drop both.
 */

const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const RUNTIME = path.join(__dirname, '..', '.experience');
const { recall: recallViaCli, resolveServerConfig } = require(path.join(RUNTIME, 'exp-recall.js'));
const { sendFeedback } = require(path.join(RUNTIME, 'exp-feedback.js'));

// Char-budget bounds for the agent-facing recall index.
const RECALL_FORMAT_MIN_CHARS = 500;
const RECALL_FORMAT_MAX_CHARS = 20000;
const RECALL_FORMAT_DEFAULT_CHARS = 6000;

const VERDICT_WIRE = { followed: 'FOLLOWED', ignored: 'IGNORED', noise: 'IRRELEVANT' };

function clampRecallChars(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return RECALL_FORMAT_DEFAULT_CHARS;
  return Math.min(RECALL_FORMAT_MAX_CHARS, Math.max(RECALL_FORMAT_MIN_CHARS, Math.floor(n)));
}

/**
 * Render a recall response into the compact `[id col]` index the agent consumes,
 * NOT a JSON dump.
 *
 * recallMode casts a wide net (recallBudgetChars sums to ~30k across the three
 * collections), so `resp.text` is routinely ~31k — enough to blow the MCP
 * per-result token cap, at which point the client spills it to a file and the
 * agent reads nothing. Cut on a line boundary so no `[id col]` handle is ever
 * split; the text is cosine-ranked strongest-first, so the tail is the safe end
 * to drop.
 */
function formatRecallForAgent(resp, opts = {}) {
  const maxChars = clampRecallChars(opts.maxChars);
  const q = opts.query ? ` for "${String(opts.query).slice(0, 80)}"` : '';
  if (!resp || !resp.text || resp.count === 0) {
    return `[recall: 0 entries${q} — the brain has nothing here; proceed without it.]`;
  }
  const full = resp.text.length;
  let body = resp.text;
  let truncated = false;
  if (full > maxChars) {
    truncated = true;
    const slice = resp.text.slice(0, maxChars);
    const lastNl = slice.lastIndexOf('\n');
    // Unless cutting at the newline would throw away more than half the budget,
    // in which case keep the hard slice.
    body = lastNl > maxChars * 0.5 ? slice.slice(0, lastNl) : slice;
  }
  const footer = truncated
    ? `[recall: ${resp.count} entries${q} · truncated ${body.length}/${full} chars — narrow the query or raise maxChars; entries are cosine-ranked, strongest first]`
    : `[recall: ${resp.count} entries${q}]`;
  return `${body}\n\n${footer}`;
}

/**
 * The `[id col]` handles an agent can actually SEE in a rendered index.
 *
 * formatRecallForAgent drops the tail, so `resp.entries` (what the brain
 * returned) and what the agent was shown are different sets — routinely by 5x,
 * since a recall renders ~30k chars against a 6000-char default budget. The
 * rendered text is the only honest record of what was surfaced: an entry whose
 * handle got truncated away cannot be rated, because the agent never saw the id
 * to pass to ee_feedback.
 */
const RECALL_HANDLE_RE = /\[id:([^\s\]]+) col:([^\]]+)\]/g;

function extractRenderedIds(text) {
  const ids = new Set();
  for (const m of String(text || '').matchAll(RECALL_HANDLE_RE)) ids.add(m[1].trim());
  return ids;
}

/** Subset of `entries` whose handle survived truncation into `index`. */
function visibleEntries(entries, index) {
  if (!Array.isArray(entries)) return [];
  const shown = extractRenderedIds(index);
  if (shown.size === 0) return [];
  return entries.filter((e) => {
    const id = e && e.id != null ? String(e.id).trim() : '';
    if (!id) return false;
    // format.js renders `[id:<8-char prefix> …]`; entries carry the full UUID.
    for (const s of shown) if (id === s || id.startsWith(s)) return true;
    return false;
  });
}

/** Active recall via POST /api/recall (recallMode). Throws on transport failure. */
async function recall(query, opts = {}) {
  return recallViaCli(query, { project: opts.project || null, cwd: opts.cwd || process.cwd() });
}

/** Reachability probe. Never throws — {ok:false,status:0} means "no response". */
async function health(homeDir = os.homedir()) {
  const { baseUrl } = resolveServerConfig(homeDir);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    // status:0 says "no response" but not why, so the reason has to travel
    // separately or the agent is left with an unfalsifiable symptom.
    return { ok: false, status: 0, error: `${err?.name || 'Error'}: ${err?.message || String(err)}` };
  }
}

/** Record a verdict on a recalled entry. Never throws; returns {ok,...}. */
async function feedback(pointId, collection, verdict, reason) {
  const wire = VERDICT_WIRE[verdict];
  if (!wire) return { ok: false, error: `unknown verdict: ${verdict}` };
  const payload = { pointId, collection, verdict: wire };
  if (wire === 'IRRELEVANT') payload.reason = reason;
  try {
    const result = await sendFeedback(payload);
    return {
      ok: true,
      resolvedId: result?.resolvedId || pointId,
      verdict: result?.verdict || wire,
      ...(reason ? { reason } : {}),
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), ...(err?.status ? { status: err.status } : {}) };
  }
}

/**
 * Write a NEW lesson so it is RECALLABLE. Goes through /api/import-memory →
 * storeImportedExperience → upsertEntry, which writes BOTH the dense vector and
 * the `text_bm25` sparse vector. That dense+sparse pair is what makes a lesson
 * reliably recallable (dense and lexical legs can both match it).
 *
 * NB: /api/ingest-point writes DENSE-ONLY. Its points are lexically invisible and
 * only surface on a strong dense match — do not use it for recall-critical writes.
 */
async function write(lesson, opts = {}, homeDir = os.homedir()) {
  const { baseUrl, authToken } = resolveServerConfig(homeDir);
  const collection = opts.collection || 'experience-behavioral';
  const id = randomUUID();
  // storeImportedExperience embeds `${qa.trigger} ${qa.question} ${qa.solution}`,
  // so the lesson goes in solution and the title in question to anchor the vector.
  const qa = {
    trigger: '',
    question: opts.title || '',
    solution: lesson,
    scope: opts.projectSlug ? { project_slug: opts.projectSlug } : {},
  };
  const body = {
    experiences: [
      { id, collection, qa, tier: 2, confidence: opts.confidence ?? 0.65, runtime: 'exp-mcp' },
    ],
  };
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(`${baseUrl}/api/import-memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON error body — fall through to status */ }
    if (!res.ok) return { ok: false, error: parsed?.error || text || `HTTP ${res.status}` };
    const r0 = parsed?.results?.[0];
    if (!parsed?.stored || r0?.ok !== true) return { ok: false, error: r0?.reason ?? 'not_stored' };
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = {
  recall, health, feedback, write,
  formatRecallForAgent, clampRecallChars, extractRenderedIds, visibleEntries,
};
