'use strict';

const { requireAuth } = require('../auth');
const { error, json, readBody } = require('../http');
const { loadExperienceCore } = require('../config');

const PIL_CONTEXT_CACHE = new Map(); // key → { value, expiresAt }
const PIL_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const PIL_CONTEXT_CACHE_MAX = 200;

function pilCacheKey(prompt, locale) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${locale || ''}\0${prompt}`).digest('hex');
}

function pilCacheGet(key) {
  const entry = PIL_CONTEXT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { PIL_CONTEXT_CACHE.delete(key); return null; }
  // refresh LRU order
  PIL_CONTEXT_CACHE.delete(key);
  PIL_CONTEXT_CACHE.set(key, entry);
  return entry.value;
}

function pilCacheSet(key, value) {
  if (PIL_CONTEXT_CACHE.size >= PIL_CONTEXT_CACHE_MAX) {
    const oldest = PIL_CONTEXT_CACHE.keys().next().value;
    PIL_CONTEXT_CACHE.delete(oldest);
  }
  PIL_CONTEXT_CACHE.set(key, { value, expiresAt: Date.now() + PIL_CONTEXT_CACHE_TTL_MS });
}

async function handlePilContext(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.prompt || typeof body.prompt !== 'string') {
    return error(res, 'prompt is required');
  }
  if (body.prompt.length > 10_000) {
    return error(res, 'prompt exceeds 10KB');
  }

  const cacheKey = pilCacheKey(body.prompt, body.locale_hint);
  const cached = pilCacheGet(cacheKey);
  if (cached) {
    return json(res, { ...cached, cache_hit: true, inference_ms: 0 });
  }

  const startMs = Date.now();
  const core = loadExperienceCore();

  // 1+2. Classification AND embedding run in parallel — they have no data
  // dependency on each other. Previously these were sequential (classify then
  // embed+search), which stacked p95 classifier (3000ms) on top of p95 embed
  // (~600ms). Running them concurrently caps total at max(classifier, embed)
  // which is classifier-bound. For taskType=general we waste the embedding
  // work, but embedding is cheap relative to classifier.
  let taskType = null;
  let outputStyle = 'balanced';
  let intentKind = null;
  let confidence = 0;
  let t0_principles = [];
  let t2_patterns = [];
  let retrieval_skipped_reason = null;

  const classifierSystem =
    'You are an intent classifier for a developer CLI. ' +
    'Given a user prompt (English, Vietnamese, or mixed), output ONLY a JSON object: ' +
    '{"category":"<one>","style":"<one>"}. ' +
    'category ∈ {refactor, debug, plan, analyze, documentation, generate, none}. ' +
    'style ∈ {concise, balanced, detailed}. ' +
    'No prose, no markdown fences, just the JSON.';
  // 4 few-shot pairs cover the category space without inflating input tokens.
  const fewShot = [
    { role: 'system', content: classifierSystem },
    { role: 'user', content: 'refactor this function to be async' },
    { role: 'assistant', content: '{"category":"refactor","style":"concise"}' },
    { role: 'user', content: 'tại sao test fail?' },
    { role: 'assistant', content: '{"category":"debug","style":"concise"}' },
    { role: 'user', content: 'thiết kế hệ thống auth cho team' },
    { role: 'assistant', content: '{"category":"plan","style":"detailed"}' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '{"category":"none","style":"concise"}' },
    { role: 'user', content: body.prompt.slice(0, 500) },
  ];
  const classifierModel = process.env.EE_PIL_CLASSIFIER_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

  // Kick off both in parallel. Use allSettled so a failed embedding does not
  // abort the classifier and vice versa.
  const [classifyResult, embedResult] = await Promise.allSettled([
    core.classifyViaBrain(body.prompt, 3500, {
      model: classifierModel,
      messages: fewShot,
      maxTokens: 40,
      responseFormat: { type: 'json_object' },
    }),
    core.getEmbeddingRaw(body.prompt, AbortSignal.timeout(2000)),
  ]);

  // Parse classifier result.
  if (classifyResult.status === 'fulfilled' && classifyResult.value) {
    const raw = classifyResult.value;
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    let parsed = null;
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
    const cats = ['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'];
    const styles = ['concise', 'balanced', 'detailed'];
    if (parsed && typeof parsed === 'object') {
      const cat = String(parsed.category || '').toLowerCase().trim();
      const sty = String(parsed.style || '').toLowerCase().trim();
      if (cats.includes(cat)) { taskType = cat; intentKind = 'task'; confidence = 0.8; }
      else if (cat === 'none') { taskType = 'general'; intentKind = 'chitchat'; confidence = 0.7; outputStyle = 'concise'; }
      if (styles.includes(sty)) outputStyle = sty;
    } else {
      // Fallback for non-JSON responses — keep prior substring match.
      const lower = raw.toLowerCase();
      const matched = cats.find((c) => lower.includes(c));
      if (matched) { taskType = matched; intentKind = 'task'; confidence = 0.6; }
      else if (/\bnone\b/.test(lower)) { taskType = 'general'; intentKind = 'chitchat'; confidence = 0.5; outputStyle = 'concise'; }
      const styleMatched = styles.find((s) => lower.includes(s));
      if (styleMatched) outputStyle = styleMatched;
    }
  }

  // Use embedding for retrieval — gated by classifier result.
  const skipRetrievalFor = new Set(['general']);
  if (skipRetrievalFor.has(taskType)) {
    retrieval_skipped_reason = `task_type:${taskType}`;
  } else if (embedResult.status !== 'fulfilled' || !embedResult.value) {
    retrieval_skipped_reason = 'embedding_unavailable';
  } else {
    try {
      const vector = embedResult.value;
      const [principles, behavioral, selfqa] = await Promise.all([
        core.searchCollection('experience-principles', vector, 3),
        core.searchCollection('experience-behavioral', vector, 4),
        core.searchCollection('experience-selfqa', vector, 4),
      ]);
      // Tag each point with its SOURCE collection before merging selfqa into the
      // behavioral bucket — a selfqa hit is not 'experience-behavioral', and the
      // id/collection pair must point at the real collection so the CLI's
      // ee_feedback(id, collection, verdict) resolves the right entry.
      const tag = (arr, collection) => (arr || []).map((p) => ({ point: p, collection }));
      const principlesTagged = tag(principles, 'experience-principles');
      const behavioralTagged = [
        ...tag(behavioral, 'experience-behavioral'),
        ...tag(selfqa, 'experience-selfqa'),
      ];
      // Emit id + collection alongside text/score (schema_version 1.1) so
      // muonroi-cli's unified PIL injection path (layer3 formatter mode) can record
      // the point as rateable recall debt and the agent can credit it via
      // ee_feedback. Without these the unified path is unrateable and the EE recall
      // loop stays half-open there. Additive + backward compatible (older CLIs strip
      // the unknown fields at schema parse).
      const toScoredText = ({ point: p, collection }) => {
        const payload = p.payload || {};
        const j = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
        return {
          id: p.id != null ? String(p.id) : undefined,
          collection,
          text: payload.text || j.solution || '',
          score: p.score || 0,
        };
      };
      const SCORE_FLOOR = 0.55;
      t0_principles = principlesTagged.map(toScoredText).filter((p) => p.score >= 0.40 && p.text);
      t2_patterns = behavioralTagged.map(toScoredText).filter((p) => p.score >= SCORE_FLOOR && p.text);
    } catch (err) {
      retrieval_skipped_reason = 'retrieval_error';
      console.error(`[pil-context] retrieval failed: ${err?.message}`, { stack: err?.stack?.split('\n').slice(0, 3) });
    }
  }

  // 3. T1 rules: high-score behavioral patterns (>=0.75) treated as "proven" proxy.
  const t1_rules = [];
  for (const p of t2_patterns) {
    if (p.score >= 0.75) t1_rules.push(p.text);
  }

  const response = {
    taskType,
    intentKind,
    outputStyle,
    confidence,
    domain: null,
    gsd_phase: null,
    gsd_route_source: 'none',
    t0_principles,
    t1_rules,
    t2_patterns,
    retrieval_skipped_reason,
    cache_hit: false,
    inference_ms: Date.now() - startMs,
    // 1.1: t0_principles / t2_patterns items now carry id + collection so the CLI
    // unified injection path can record them as rateable recall debt (ee_feedback).
    schema_version: '1.1',
  };
  pilCacheSet(cacheKey, response);
  json(res, response);
}

module.exports = {
  PIL_CONTEXT_CACHE,
  PIL_CONTEXT_CACHE_TTL_MS,
  PIL_CONTEXT_CACHE_MAX,
  pilCacheKey,
  pilCacheGet,
  pilCacheSet,
  handlePilContext,
};
