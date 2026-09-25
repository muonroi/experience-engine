'use strict';

const { validateBody } = require('../../.experience/src/validate');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const logger = require('../../.experience/src/logger');
const { error, json, readBody, slog } = require('../http');
const { QDRANT_BASE, RUNTIME_JUDGE_WORKER_PATH, TMP_DIR, deriveCallerMeta, loadExperienceCore, qdrantHeaders } = require('../config');
const { KNOWN_COLLECTIONS } = require('./knowledge');

async function handleIntercept(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { toolName: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
    // Forward caller-side scope hints so applyScopeFilter() in experience-core.js
    // can gate cross-language/framework hints. For clients that pre-flatten
    // (Claude Code hook), top-level body.lang/framework wins; for native
    // clients (muonroi-cli) we derive from toolInput.file_path + cwd.
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
  };

  // --- Deterministic static rules (file-size cap, etc.) ---
  // These fire BEFORE embedding lookup, are not subject to ignoreCount
  // throttling, and surface alongside vector-matched suggestions. See
  // .experience/src/static-rules.js for rule definitions.
  let staticHints = [];
  try {
    const { evaluateStaticRules } = require('../../.experience/src/static-rules.js');
    staticHints = evaluateStaticRules(body.toolName, body.toolInput || {}, meta) || [];
  } catch (err) {
    console.error("[handleIntercept] static-rules failed:", err && err.message ? err.message : err);
  }

  // skipRoute=true lets latency-sensitive callers (e.g. CLI hook fast-path)
  // bypass the model-routing side-effect of intercept and only get suggestions.
  const options = { skipRoute: !!body.skipRoute };
  const { interceptWithMeta, intercept: interceptFresh } = loadExperienceCore();
  const resultMeta = typeof interceptWithMeta === 'function'
    ? await interceptWithMeta(body.toolName, body.toolInput || {}, undefined, meta, options)
    : {
      suggestions: await interceptFresh(body.toolName, body.toolInput || {}, undefined, meta),
      surfacedIds: [],
      route: null,
    };
  let result = resultMeta?.suggestions ?? null;
  let surfacedIds = resultMeta?.surfacedIds || [];
  if (staticHints.length) {
    const synthIds = staticHints.map((h) => ({ collection: "static-rules", id: h.id, solution: h.line, scope: { lang: "any", framework: "any", project_slug: "any" }, hitCount: 0, ignoreCount: 0, superseded: false, static: true }));
    surfacedIds = synthIds.concat(surfacedIds);
    const lines = staticHints.map((h) => h.line).join("\n");
    result = result ? (lines + "\n" + result) : lines;
  }
  // Server-side stash of surfaced hints so PostToolUse can reconcile them even
  // when the remote client does not echo surfacedIds back (codex-windows path).
  try {
    if (surfacedIds.length && meta.sourceSession) {
      const stashCore = loadExperienceCore();
      if (typeof stashCore._stashSurfacedHints === "function") stashCore._stashSurfacedHints(surfacedIds, meta);
    }
  } catch (stashErr) {
    slog("error", "intercept stash failed", { msg: stashErr?.message, session: meta.sourceSession });
  }
  json(res, {
    suggestions: result,
    hasSuggestions: result !== null,
    surfacedIds: surfacedIds,
    route: resultMeta?.route || null,
  });
}

// Aggregate batch of parallel tool calls into a single reflection-style hint.
// Fires from PostToolBatch Claude Code hook AFTER the batch resolves, BEFORE
// the next model call — so the hint can shape the next assistant turn.
//
// Strategy: concatenate tool commands/files/outputs into one query string,
// route through the standard intercept pipeline to surface scope-filtered
// hints, return the first non-null suggestion as `hint`. Per-tool feedback
// stays handled by /api/posttool — this endpoint is purely additive.
async function handlePostToolBatch(req, res) {
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return error(res, 'request body must be a JSON object');
  if (!Array.isArray(body.tools)) return error(res, 'tools is required and must be an array');
  const tools = body.tools;
  if (tools.length === 0) return json(res, { hint: null });

  const aggregatedCommand = tools
    .map((t) => {
      const ti = t?.tool_input || {};
      if (ti.command) return `${t.tool_name}: ${String(ti.command).slice(0, 200)}`;
      if (ti.file_path) return `${t.tool_name}: ${ti.file_path}`;
      return t.tool_name || '';
    })
    .filter(Boolean)
    .join(' | ');

  const reprToolInput = {
    command: aggregatedCommand,
    file_path: body.representativeFilePath || null,
    batchSize: tools.length,
  };
  const derived = deriveCallerMeta({ ...body, toolInput: reprToolInput });
  const meta = {
    sourceKind: body.sourceKind || 'hook-batch',
    sourceRuntime: body.sourceRuntime || 'claude-code',
    sourceSession: body.sessionId || null,
    cwd: body.cwd || null,
    lang: derived.lang,
    framework: derived.framework,
    project_slug: derived.project_slug,
  };
  const { interceptWithMeta } = loadExperienceCore();
  if (typeof interceptWithMeta !== 'function') return json(res, { hint: null });
  const resultMeta = await interceptWithMeta('PostToolBatch', reprToolInput, undefined, meta, { skipRoute: true });
  json(res, {
    hint: resultMeta?.suggestions ?? null,
    surfacedIds: resultMeta?.surfacedIds || [],
    batchSize: tools.length,
  });
}

function classifyPostToolOutcome(toolName, toolOutput) {
  const tool = (toolName || '').toLowerCase();
  const isMutatingTool = /edit|write|bash|shell|replace|execute_command/i.test(tool);
  if (!isMutatingTool) return null;
  const exitCode = toolOutput?.exit_code ?? toolOutput?.exitCode ?? null;
  if (exitCode !== null && exitCode !== 0) return 'error';
  const hasError = !!(
    toolOutput?.error ||
    toolOutput?.is_error ||
    (typeof toolOutput === 'string' && /^error:/i.test(toolOutput)) ||
    (toolOutput?.output && /error|Error|ERROR|FAIL|fatal|exception/i.test(String(toolOutput.output).slice(0, 500)))
  );
  return hasError ? 'error' : 'success';
}

async function handlePostTool(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { toolName: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const core = loadExperienceCore();
  const reconcilePendingHints = core._reconcilePendingHints;
  const activityLog = core._activityLog;
  const toolName = body.toolName || '';
  const toolInput = body.toolInput || {};
  const toolOutput = body.toolOutput || body.output || body.result || {};
  const surfacedIds = Array.isArray(body.surfacedIds) ? body.surfacedIds : [];
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    cwd: body.cwd || null,
    lang: typeof body.lang === 'string' ? body.lang : null,
    framework: typeof body.framework === 'string' ? body.framework : null,
    project_slug: typeof body.project_slug === 'string' ? body.project_slug : null,
  };

  let reconcile = { touched: [], pending: [], implicitUnused: [], expired: [] };
  if (typeof reconcilePendingHints === 'function') {
    reconcile = await reconcilePendingHints(surfacedIds, toolName, toolInput, meta);
  }

  const toolOutcome = classifyPostToolOutcome(toolName, toolOutput);
  if (typeof activityLog === 'function') {
    activityLog({
      op: 'posttool',
      tool: toolName,
      surfacedCount: surfacedIds.length,
      toolOutcome,
      sourceKind: meta.sourceKind,
      sourceRuntime: meta.sourceRuntime,
      sourceSession: meta.sourceSession,
    });
  }

  if (surfacedIds.length > 0) {
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const queueFile = path.join(TMP_DIR, `judge-${Date.now()}.json`);
      fs.writeFileSync(queueFile, JSON.stringify({
        ts: new Date().toISOString(),
        surfacedIds,
        toolName,
        toolInputObj: toolInput || {},
        toolInput: JSON.stringify(toolInput || {}).slice(0, 300),
        toolOutcome,
      }));
      const worker = childProcess.spawn(process.execPath, [RUNTIME_JUDGE_WORKER_PATH, queueFile], {
        detached: true,
        stdio: 'ignore',
      });
      worker.unref();
    } catch (spawnErr) {
      if (typeof activityLog === 'function') {
        activityLog({
          op: 'posttool-spawn-error',
          tool: toolName,
          message: spawnErr?.message || String(spawnErr),
          sourceRuntime: meta.sourceRuntime,
        });
      }
    }
  }

  json(res, { ok: true, reconcile, judgeQueued: surfacedIds.length > 0, toolOutcome });
}

async function handlePromptStale(req, res) {
  const body = await readBody(req);
  const core = loadExperienceCore();
  const reconcileStalePromptSuggestions = core._reconcileStalePromptSuggestions;
  const empty = { ok: true, unused: [], irrelevant: [], expired: [] };
  if (typeof reconcileStalePromptSuggestions !== 'function') {
    return json(res, empty);
  }
  const result = await reconcileStalePromptSuggestions(body.state || {}, body.nextPromptMeta || {});
  json(res, {
    ok: result?.ok !== false,
    unused: result?.unused || [],
    irrelevant: result?.irrelevant || [],
    expired: result?.expired || [],
  });
}

async function handleExtract(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { transcript: { type: 'string', required: true } });
  if (!v.ok) return error(res, v.error);
  const { extractFromSession, evolve } = loadExperienceCore();
  const derived = deriveCallerMeta(body);
  const meta = {
    sourceKind: body.sourceKind || 'manual-api',
    sourceRuntime: body.sourceRuntime || 'api',
    sourceSession: body.sourceSession || null,
    framework: body.framework || derived.framework || null,
    lang: body.lang || derived.lang || null,
    project_slug: body.project_slug || derived.project_slug || null,
    _preDetectedExperiences: Array.isArray(body.preDetectedExperiences) ? body.preDetectedExperiences : null,
  };
  slog('info', 'extract_api_start', {
    project: body.projectPath || null,
    transcriptLen: (body.transcript || '').length,
    lang: meta.lang,
    framework: meta.framework,
    projectSlug: meta.project_slug,
    sourceRuntime: meta.sourceRuntime,
  });
  // Extraction runs up to MAX_EXTRACTIONS_PER_SESSION per-experience LLM calls
  // (extractQA uses the slow extract model, ~9s each) + embed + Qdrant upsert. That is
  // far too long to keep a client blocked on at cli-exit — the old synchronous await
  // meant a 2s client deadline killed the request and nothing was ever learned.
  // ACK immediately; the long-lived server finishes extraction + consolidation in the
  // background. Clients wait only for this ACK, so no timeout can starve the work.
  json(res, { accepted: true, async: true, success: true });
  extractFromSession(body.transcript, body.projectPath || null, meta)
    .then((stored) => {
      slog('info', 'extract_api_done', {
        project: body.projectPath || null,
        stored,
        sourceRuntime: meta.sourceRuntime,
        async: true,
      });
      // Consolidate only when something new landed. Run it here (after the background
      // extraction) rather than trusting the client to time evolve correctly.
      if (stored > 0) {
        return evolve('post-extract').catch((err) =>
          slog('error', 'extract_evolve_error', { project: body.projectPath || null, error: logger.serializeError(err) }),
        );
      }
    })
    .catch((err) => {
      slog('error', 'extract_api_error', {
        project: body.projectPath || null,
        error: logger.serializeError(err),
        async: true,
      });
    });
}

async function handleEvolve(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const { evolve } = loadExperienceCore();
  const results = await evolve(body.trigger || 'api');
  json(res, { ...results, success: true });
}

// Direct structured-point ingestion — used by backfill scripts (e.g. ingest-bb-to-ee.mts)
// that have curated content + payload to upsert without going through the extraction
// pipeline. Embeds the text via experience-core and upserts to Qdrant directly.
// KNOWN_COLLECTIONS still gates which collections are writable.
async function handleIngestPoint(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    id: { type: 'string', required: true },
    text: { type: 'string', required: true },
    collection: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);
  if (!KNOWN_COLLECTIONS.has(body.collection)) {
    return error(res, `unknown collection: ${body.collection}`);
  }
  try {
    const { getEmbeddingRaw } = loadExperienceCore();
    const vector = await getEmbeddingRaw(body.text);
    if (!Array.isArray(vector) || vector.length === 0) {
      return error(res, 'embedding_failed');
    }
    const point = {
      id: body.id,
      vector,
      payload: { ...(body.payload || {}), text: body.text },
    };
    const upsert = await fetch(`${QDRANT_BASE}/collections/${body.collection}/points?wait=true`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ points: [point] }),
    });
    if (!upsert.ok) {
      const errBody = await upsert.text();
      return error(res, `qdrant_upsert_failed: ${upsert.status} ${errBody.slice(0, 200)}`);
    }
    json(res, { id: body.id, collection: body.collection, success: true });
  } catch (err) {
    slog('error', 'ingest_point_error', { error: String(err) });
    return error(res, String(err));
  }
}

module.exports = {
  handleIntercept,
  handlePostToolBatch,
  classifyPostToolOutcome,
  handlePostTool,
  handlePromptStale,
  handleExtract,
  handleEvolve,
  handleIngestPoint,
};
