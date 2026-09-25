'use strict';

const { validateBody } = require('../../.experience/src/validate');
const runtimeConfig = require('../../.experience/src/config');
const path = require('node:path');
const { CORS, error, json, readBody, slog } = require('../http');
const { QDRANT_BASE, RUNTIME_DIR, _cfg, loadExperienceCore, qdrantHeaders } = require('../config');
const { WORKFLOW_KIND_TO_COLLECTION } = require('./knowledge');

const VALID_OUTCOMES = new Set(['success', 'fail', 'retry', 'cancelled']);
const KNOWN_RUNTIMES = new Set(['claude', 'gemini', 'codex', 'opencode']);

async function handleRouteModel(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { task: { type: 'string', required: true, maxLength: 2000 } });
  if (!v.ok) return error(res, v.error);
  if (body.runtime !== undefined && body.runtime !== null && !KNOWN_RUNTIMES.has(body.runtime)) {
    return error(res, `runtime must be one of: ${[...KNOWN_RUNTIMES].join(', ')}, or null`);
  }
  const { routeModel } = loadExperienceCore();
  const result = await routeModel(body.task, body.context || null, body.runtime || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': result.source || 'default', ...CORS });
  res.end(JSON.stringify(result));
}

async function handleRouteTask(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, { task: { type: 'string', required: true, maxLength: 2000 } });
  if (!v.ok) return error(res, v.error);
  if (body.runtime !== undefined && body.runtime !== null && !KNOWN_RUNTIMES.has(body.runtime)) {
    return error(res, `runtime must be one of: ${[...KNOWN_RUNTIMES].join(', ')}, or null`);
  }
  const { routeTask } = loadExperienceCore();
  const result = await routeTask(body.task, body.context || null, body.runtime || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': result.source || 'default', ...CORS });
  res.end(JSON.stringify(result));
}

async function handleRouteFeedback(req, res) {
  const body = await readBody(req);
  const v = validateBody(body, {
    taskHash: { type: 'string', required: true },
    outcome: { type: 'string', required: true, oneOf: VALID_OUTCOMES },
  });
  if (!v.ok) return error(res, v.error);
  const { routeFeedback } = loadExperienceCore();
  const ok = await routeFeedback(body.taskHash, body.tier || null, body.model || null, body.outcome, body.retryCount || 0, body.duration || null);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Route-Source': 'feedback', ...CORS });
  res.end(JSON.stringify({ ok }));
}

async function handleSyncBuffers(req, res) {
  const body = await readBody(req);
  if (!body.buffers || typeof body.buffers !== 'object') {
    return error(res, 'buffers object is required');
  }
  const { syncIDEBuffers } = loadExperienceCore();
  const ok = syncIDEBuffers(body.buffers);
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ ok }));
}

// --- Brain Proxy (allows local clients to reach SiliconFlow via VPS) ---

async function handleBrainProxy(req, res) {
  const body = await readBody(req);
  if (!body.prompt) return error(res, 'prompt is required');
  const timeoutMs = body.timeoutMs || 8000;
  try {
    const { classifyViaBrain } = loadExperienceCore();
    // Forward optional classification overrides from SAMR/advanced callers.
    // The underlying classifyViaBrain already supports options.systemPrompt,
    // options.responseFormat, options.model, options.maxTokens, options.provider.
    const options = {};
    if (body.systemPrompt) options.systemPrompt = body.systemPrompt;
    if (body.responseFormat) options.responseFormat = body.responseFormat;
    if (body.model) options.model = body.model;
    if (body.maxTokens != null) options.maxTokens = body.maxTokens;
    if (body.provider) options.provider = body.provider;
    // WhoAmI / style structured extraction: use the stronger brainExtractModel, not the
    // hot-path brainModel which mis-spells the dim vocabulary. The extract model may live on
    // a DIFFERENT provider/key/endpoint than the hot-path brain (e.g. hot-path Qwen on
    // SiliconFlow, extract on DeepSeek's native API because SiliconFlow rate-limits DeepSeek
    // hard with 429s). Route provider+endpoint+key together so the call actually lands on the
    // extract provider. Each getter falls back to the hot-path brain when unconfigured, so a
    // single-provider box is unchanged. Explicit caller overrides (options.*) still win.
    if (body.useExtractModel) {
      // One resolver for provider+endpoint+key+model, and `=== undefined` checks: a
      // resolved-empty key means "this vendor has no key configured, fail closed", and
      // a `!options.key` test would discard that and let the hot-path key through.
      const extractTarget = runtimeConfig.resolveBrainTarget('extract');
      if (extractTarget.keySuppressed) {
        // Otherwise this path answers 200 {"result":null} with nothing in the log and
        // the operator has no console to read: /api/brain is the remote entry point.
        slog('warn', 'brain_extract_key_suppressed', {
          provider: extractTarget.provider,
          hotProvider: runtimeConfig.getBrainProvider(),
          reason: 'brainExtractKey unset while the extract path targets another provider/origin — refusing to send the hot-path key',
        });
      }
      if (options.model === undefined) options.model = extractTarget.model;
      if (options.provider === undefined) options.provider = extractTarget.provider;
      if (options.endpoint === undefined) options.endpoint = extractTarget.endpoint;
      if (options.key === undefined) options.key = extractTarget.key;
    }
    const result = await classifyViaBrain(body.prompt, timeoutMs, options);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: false, error: err.message || 'brain call failed' }));
  }
}

// P1 Item 3: phase-outcome endpoint, gated by ENABLE_PHASE_OUTCOME=1.
async function handlePhaseOutcome(req, res) {
  if (process.env.ENABLE_PHASE_OUTCOME !== '1' && _cfg.enablePhaseOutcome !== true) {
    return error(res, 'phase-outcome endpoint is disabled (set ENABLE_PHASE_OUTCOME=1)', 404);
  }
  const body = await readBody(req);
  const v = validateBody(body, {
    sessionId: { type: 'string', required: true },
    phaseName: { type: 'string', required: true },
    outcome: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);

  let phaseModule;
  try {
    phaseModule = require(path.join(RUNTIME_DIR, 'src', 'phase-outcome.js'));
  } catch (err) {
    return error(res, `phase-outcome module unavailable: ${err.message}`, 503);
  }

  const core = loadExperienceCore();
  const result = await phaseModule.applyPhaseOutcome(body, {
    recordFeedback: core.recordFeedback,
    activityLog: core._activityLog,
  });
  if (!result.ok) return error(res, result.error || 'phase-outcome failed', 400);
  json(res, result);
}

// Sprint-2 Part D: write-during-execution channel. Unlike /api/phase-outcome
// (which only REINFORCES existing point IDs), this CREATES a new experience
// entry in a workflow_* collection so council rounds / sprint outcomes /
// decisions / mistakes captured mid-run are recallable in later runs. Gated by
// ENABLE_WORKFLOW_EVENT=1 (or _cfg.enableWorkflowEvent). Fire-and-forget from
// the client's side; here we embed + upsert directly (handleIngestPoint pattern)
// so no recall-hot-path code is touched.
async function handleWorkflowEvent(req, res) {
  if (process.env.ENABLE_WORKFLOW_EVENT !== '1' && _cfg.enableWorkflowEvent !== true) {
    return error(res, 'workflow-event endpoint is disabled (set ENABLE_WORKFLOW_EVENT=1)', 404);
  }
  const body = await readBody(req);
  const v = validateBody(body, {
    kind: { type: 'string', required: true },
    phaseRef: { type: 'string', required: true },
  });
  if (!v.ok) return error(res, v.error);

  const collection = WORKFLOW_KIND_TO_COLLECTION[body.kind];
  if (!collection) {
    return error(res, `unknown workflow kind: ${body.kind} (expected one of ${Object.keys(WORKFLOW_KIND_TO_COLLECTION).join(', ')})`);
  }

  // Build the embeddable text. Prefer an explicit `text`/`summary`; else derive
  // a compact string from the payload so recall has something meaningful.
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const text =
    (typeof body.text === 'string' && body.text.trim()) ||
    (typeof payload.summary === 'string' && payload.summary.trim()) ||
    `${body.kind} ${body.phaseRef} ${JSON.stringify(payload).slice(0, 800)}`;

  try {
    const { getEmbeddingRaw } = loadExperienceCore();
    const vector = await getEmbeddingRaw(text);
    if (!Array.isArray(vector) || vector.length === 0) {
      return error(res, 'embedding_failed', 503);
    }
    const crypto = require('node:crypto');
    const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();
    const point = {
      id,
      vector,
      payload: {
        kind: body.kind,
        phaseRef: body.phaseRef,
        sessionId: body.sessionId || null,
        tier: 'intra-session', // hot experience — not yet promoted to a long-term principle
        createdAt: new Date().toISOString(),
        ...payload,
        text,
        // Full-text leg parity with the experience-* collections.
        text_search: text.toLowerCase(),
      },
    };
    const upsert = await fetch(`${QDRANT_BASE}/collections/${collection}/points?wait=true`, {
      method: 'PUT',
      headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ points: [point] }),
    });
    if (!upsert.ok) {
      const errBody = await upsert.text();
      return error(res, `qdrant_upsert_failed: ${upsert.status} ${errBody.slice(0, 200)}`);
    }
    json(res, { ok: true, id, collection, kind: body.kind });
  } catch (err) {
    slog('error', 'workflow_event_error', { error: String(err), kind: body.kind });
    return error(res, String(err), 500);
  }
}

module.exports = {
  VALID_OUTCOMES,
  KNOWN_RUNTIMES,
  handleRouteModel,
  handleRouteTask,
  handleRouteFeedback,
  handleSyncBuffers,
  handleBrainProxy,
  handlePhaseOutcome,
  handleWorkflowEvent,
};
