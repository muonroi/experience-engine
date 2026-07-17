'use strict';

/**
 * mcp/ledger.js — in-memory, session-scoped ledger of recalled `[id col]` handles
 * that have NOT yet been rated via ee_feedback.
 *
 * One MCP server process = one agent session, so a module-level singleton IS the
 * session: every ee_query adds its returned entries as pending debt, every
 * ee_feedback clears one, and ee_query then surfaces (soft) or refuses on (hard)
 * the accumulated debt. That gate is what actually forces a verdict on useful
 * recalls — the signal the brain needs to keep good entries and prune noise,
 * because recall surfaces are deliberately excluded from the implicit-precision
 * reconcile path.
 *
 * Ported from muonroi-cli's src/ee/recall-ledger.ts. muonroi-cli keeps its own
 * copy: its PIL Layer 3 uses isPending()/wasCleared() to suppress re-injecting a
 * hint body it already showed this session, which is in-process state this
 * server can neither see nor own.
 */

function createRecallLedger() {
  const map = new Map();
  const cleared = new Set();

  return {
    /** Stamp the entries returned by a recall as pending debt (first sighting wins). */
    record(entries, query) {
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const e of entries) {
        const id = e && e.id != null ? String(e.id).trim() : '';
        if (!id) continue;
        // First sighting keeps the original ts + query so age-based reporting stays
        // honest; re-recalling an already-pending id must not reset its clock.
        if (!map.has(id)) {
          map.set(id, {
            id,
            collection: e.collection ?? null,
            query: String(query || '').slice(0, 120),
            ts: now,
          });
        }
      }
    },
    /** Clear one id once rated. Returns true if it was actually pending. */
    clear(id) {
      const nid = String(id ?? '').trim();
      const deleted = map.delete(nid);
      if (deleted) cleared.add(nid);
      return deleted;
    },
    wasCleared(id) {
      return cleared.has(String(id ?? '').trim());
    },
    isPending(id) {
      return map.has(String(id ?? '').trim());
    },
    /** Oldest-first list of still-unrated recalls. */
    pending() {
      return [...map.values()].sort((a, b) => a.ts - b.ts);
    },
    pendingCount() {
      return map.size;
    },
    reset() {
      map.clear();
      cleared.clear();
    },
  };
}

/** Process-scoped singleton = this MCP session's unrated-recall debt. */
const sessionRecallLedger = createRecallLedger();

/** Resolve the feedback-gate policy from env at call time (so tests can vary it). */
function resolveGate(env = process.env) {
  const raw = String(env.EXPERIENCE_RECALL_FEEDBACK_GATE ?? 'soft').trim().toLowerCase();
  const mode = raw === 'off' || raw === 'hard' ? raw : 'soft';
  const parsed = Number.parseInt(env.EXPERIENCE_RECALL_FEEDBACK_THRESHOLD ?? '', 10);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  return { mode, threshold };
}

/** One readable block naming the still-unrated recalls + how to clear them. */
function formatPendingBlock(pending, hard, max = 8) {
  const shown = pending.slice(0, max);
  const lines = shown.map((p) => `  - [${p.id} ${p.collection ?? '?'}]  (from recall: "${p.query}")`);
  const more = pending.length > max ? `\n  …and ${pending.length - max} more` : '';
  const head = hard
    ? `⚠️ FEEDBACK GATE — ${pending.length} earlier recall(s) are still unrated. Rate them with ` +
      `ee_feedback(id, collection, verdict) before pulling new recalls:`
    : `⚠️ ${pending.length} earlier recall(s) still unrated — call ` +
      `ee_feedback(id, collection, verdict=followed|ignored|noise) so the brain keeps what helped and prunes the rest:`;
  return `${head}\n${lines.join('\n')}${more}`;
}

module.exports = { createRecallLedger, sessionRecallLedger, resolveGate, formatPendingBlock };
