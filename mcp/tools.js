'use strict';

/**
 * mcp/tools.js — the ee_* MCP tool definitions.
 *
 * ee_query (active recall) · ee_feedback (rate an entry) · ee_write (record a new
 * lesson) · ee_health (reachability). Together they close the loop the brain runs
 * on: query recalls, feedback rates, write creates.
 *
 * Feedback gate: ee_query stamps every returned `[id col]` into a session-scoped
 * pending ledger. Later ee_query calls surface (soft) or refuse on (hard) the
 * accumulated unrated debt, so useful recalls actually get a verdict. Mode via
 * EXPERIENCE_RECALL_FEEDBACK_GATE = off|soft|hard (default soft); hard-mode
 * threshold via EXPERIENCE_RECALL_FEEDBACK_THRESHOLD.
 *
 * Dependencies are injected (deps) so tests never touch the network or the
 * process-wide ledger singleton.
 *
 * The descriptions are load-bearing — they are the only thing that teaches a
 * foreign agent WHEN to reach for the brain — and are carried over verbatim from
 * muonroi-cli's src/mcp/ee-tools.ts, where they were tuned against real agents.
 */

const { validate } = require('./validate');
const { sessionRecallLedger, resolveGate, formatPendingBlock } = require('./ledger');
const defaultApi = require('./ee-api');

const NOISE_REASONS = ['wrong_repo', 'wrong_language', 'wrong_task', 'stale_rule'];

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function okText(text) {
  return { content: [{ type: 'text', text }] };
}
function fail(error, message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true };
}

function buildTools(deps = {}) {
  const api = deps.api || defaultApi;
  const ledger = deps.ledger || sessionRecallLedger;
  const env = deps.env || process.env;

  return [
    {
      name: 'ee_query',
      description:
        'Active recall over the Experience Engine brain — prior decisions, gotchas, learned warnings/recipes, and ' +
        'task checkpoints for this codebase — via the recallMode pipeline (same path as exp-recall.js). ' +
        'CALL THIS PROACTIVELY, before acting: when starting work in an unfamiliar area, when unsure how something ' +
        'is done in this stack, before a risky or hard-to-reverse step, or to recall finished work after a ' +
        "compaction (e.g. query='recent compaction checkpoint Progress DONE for <subtask>'). A deliberate query " +
        'here is cheaper than re-deriving or repeating a past mistake. Returns a formatted index whose entries ' +
        'carry `[id col]` handles — after you act on a recall, rate each entry you used or judged with the ' +
        'ee_feedback tool (followed/ignored/noise) so the brain keeps what helped and prunes the rest; unrated ' +
        'recalls are surfaced back to you on the next ee_query. Optional project scopes the recall. Returns a ' +
        'compact ranked index (cosine-ranked, strongest first), capped at maxChars (default 6000, range ' +
        '500-20000) and truncated from the tail; raise maxChars to see more. Returns ee_unavailable if EE is ' +
        'down (then proceed without it).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 1000 },
          project: { type: 'string', maxLength: 200 },
          maxChars: { type: 'integer', minimum: 500, maximum: 20000 },
        },
        required: ['query'],
      },
      async handler({ query, project, maxChars }) {
        const gate = resolveGate(env);
        const pendingBefore = gate.mode === 'off' ? [] : ledger.pending();
        // Hard gate: refuse a NEW recall while unrated debt is at/over threshold —
        // do not even spend the brain call. Below threshold, fall through to soft.
        if (gate.mode === 'hard' && pendingBefore.length >= gate.threshold) {
          return fail('feedback_required', formatPendingBlock(pendingBefore, true));
        }
        try {
          const resp = await api.recall(query, { project });
          if (resp === null || resp === undefined) {
            return fail('ee_unavailable', 'EE recall returned no response (server down, timeout, or circuit open)');
          }
          if (gate.mode !== 'off') ledger.record(resp.entries, query);
          const index = api.formatRecallForAgent(resp, { query, maxChars });
          if (gate.mode !== 'off' && pendingBefore.length > 0) {
            return okText(`${formatPendingBlock(pendingBefore, false)}\n\n${index}`);
          }
          return okText(index);
        } catch (e) {
          return fail('ee_unavailable', e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      name: 'ee_feedback',
      description:
        'Rate an Experience Engine recall entry so the brain keeps what helped and prunes the rest. Call after ' +
        "acting on an ee_query result — once per `[id col]` you used or judged. verdict: 'followed' (you changed " +
        "your approach because of it), 'ignored' (topical but did not apply this time), 'noise' (wrong by category — " +
        'REQUIRES reason: wrong_repo | wrong_language | wrong_task | stale_rule). id may be a short prefix; the ' +
        "server resolves it. Clears the entry from this session's pending-feedback gate.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          collection: { type: 'string', minLength: 1, maxLength: 200 },
          verdict: { type: 'string', enum: ['followed', 'ignored', 'noise'] },
          reason: { type: 'string', enum: NOISE_REASONS },
        },
        required: ['id', 'collection', 'verdict'],
      },
      async handler({ id, collection, verdict, reason }) {
        if (verdict === 'noise' && !reason) {
          return fail('reason_required', `verdict 'noise' requires reason: ${NOISE_REASONS.join(' | ')}`);
        }
        try {
          const result = await api.feedback(id, collection, verdict, reason);
          if (!result.ok) return fail('feedback_failed', result.error ?? 'feedback POST failed');
          // Clear by the server-resolved full id AND the (possibly short) id the
          // agent passed, so a prefix-based call still settles the ledger debt.
          const clearedId = result.resolvedId ?? id;
          ledger.clear(clearedId);
          ledger.clear(id);
          return ok({
            ok: true,
            id: clearedId,
            verdict: result.verdict,
            ...(result.reason ? { reason: result.reason } : {}),
            pendingRemaining: ledger.pendingCount(),
          });
        } catch (e) {
          return fail('feedback_failed', e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      name: 'ee_health',
      description: 'Check Experience Engine server reachability.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        try {
          return ok(await api.health());
        } catch (e) {
          return fail('ee_unavailable', e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      name: 'ee_write',
      description:
        'Save a NEW lesson to the Experience Engine brain so you and future sessions recall it. Call the MOMENT you ' +
        'hit a mistake / error / dead-end and find the working fix: record the pitfall AND the fix in one concise, ' +
        'generalizable lesson (1-3 sentences — what to do or avoid next time, NOT a play-by-play of this turn). The ' +
        'lesson is embedded immediately (via /api/import-memory: dense + sparse) and becomes recallable via ee_query ' +
        'in this and future sessions. Use ee_query first if unsure a lesson already exists. collection defaults to ' +
        'experience-behavioral (use experience-principles only for a broad, project-independent principle); project ' +
        'scopes the lesson.',
      inputSchema: {
        type: 'object',
        properties: {
          lesson: { type: 'string', minLength: 12, maxLength: 4000 },
          title: { type: 'string', maxLength: 200 },
          collection: { type: 'string', enum: ['experience-behavioral', 'experience-principles'] },
          project: { type: 'string', maxLength: 200 },
        },
        required: ['lesson'],
      },
      async handler({ lesson, title, collection, project }) {
        const trimmed = lesson.trim();
        const text = trimmed.length > 1500 ? `${trimmed.slice(0, 1497)}...` : trimmed;
        const targetCollection = collection ?? 'experience-behavioral';
        try {
          const result = await api.write(text, {
            collection: targetCollection,
            title,
            projectSlug: project,
            confidence: 0.65,
          });
          if (!result.ok) return fail('write_failed', result.error ?? 'import-memory POST failed');
          return ok({ ok: true, id: result.id, collection: targetCollection, recallable: 'now via ee_query' });
        } catch (e) {
          return fail('write_failed', e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}

/** Run a tool by name with raw (unvalidated) MCP arguments. */
async function callTool(tools, name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail('unknown_tool', `no such tool: ${name}`);
  const checked = validate(tool.inputSchema, rawArgs);
  if (!checked.ok) return fail('invalid_arguments', checked.error);
  return tool.handler(checked.value);
}

/** Strip handlers — the wire form for tools/list. */
function describeTools(tools) {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

module.exports = { buildTools, callTool, describeTools, NOISE_REASONS };
