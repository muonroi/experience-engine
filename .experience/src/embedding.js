/**
 * embedding.js — Embedding provider abstraction for Experience Engine.
 * Extracted from experience-core.js. Zero npm dependencies.
 */
'use strict';

const {
  getOllamaEmbedUrl, getOllamaBase,
  getEmbedProvider, getEmbedModel, getEmbedEndpoint, getEmbedKey,
  getEmbedDim, activityLog,
} = require('./config');

// ============================================================
//  Embedding Providers
// ============================================================

async function embedOllama(text, signal) {
  try {
    const res = await fetch(getOllamaEmbedUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getEmbedModel(), input: text }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings?.[0] || null;
  } catch { return null; }
}

async function embedOpenAI(text, signal) {
  const endpoint = getEmbedEndpoint() || 'https://api.openai.com/v1/embeddings';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
      body: JSON.stringify({ model: getEmbedModel() || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

async function embedGemini(text, signal) {
  try {
    const model = getEmbedModel() || 'text-embedding-004';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${getEmbedKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).embedding?.values || null;
  } catch { return null; }
}

async function embedVoyageAI(text, signal) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
      body: JSON.stringify({ model: getEmbedModel() || 'voyage-code-3', input: [text.slice(0, 8000)] }),
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

const EMBED_PROVIDERS = {
  ollama: { fn: embedOllama },
  openai: { fn: embedOpenAI },
  siliconflow: { fn: embedOpenAI },
  gemini: { fn: embedGemini },
  voyageai: { fn: embedVoyageAI },
  custom: { fn: embedOpenAI },
};

// ============================================================
//  Cost Logging (used by getEmbedding)
// ============================================================

function estimateTextUnits(text, cap = 12000) {
  return Math.min(String(text || '').length, cap);
}

function logCostCall(kind, provider, source, units, extra = {}) {
  activityLog({
    op: 'cost-call',
    kind,
    provider: provider || 'unknown',
    source: source || 'unknown',
    units: Math.max(0, Math.round(Number(units) || 0)),
    ...extra,
  });
}

// ============================================================
//  Main getEmbedding function
// ============================================================

async function getEmbedding(text, signal, meta = {}) {
  const provider = getEmbedProvider();
  const p = EMBED_PROVIDERS[provider] || EMBED_PROVIDERS.ollama;
  const units = estimateTextUnits(text, 8000);
  const startedAt = Date.now();
  let vector = await p.fn(text, signal);
  logCostCall('embed', provider, meta.source || 'general', units, {
    ok: !!vector,
    durationMs: Date.now() - startedAt,
  });
  if (vector) return vector;

  // Retry once after 500ms backoff
  await new Promise(r => setTimeout(r, 500));
  const retryStart = Date.now();
  vector = await p.fn(text, signal);
  logCostCall('embed', provider, meta.source || 'general-retry', units, {
    ok: !!vector,
    durationMs: Date.now() - retryStart,
  });
  if (vector) return vector;

  // Fallback to Ollama if primary provider is not already Ollama
  if (provider !== 'ollama' && EMBED_PROVIDERS.ollama) {
    const fallbackStart = Date.now();
    vector = await EMBED_PROVIDERS.ollama.fn(text, signal);
    logCostCall('embed', 'ollama', meta.source || 'general-fallback', units, {
      ok: !!vector,
      durationMs: Date.now() - fallbackStart,
    });
  }
  return vector;
}

async function getEmbeddingRaw(text, signal) {
  return getEmbedding(text, signal);
}

// ============================================================
//  Exports
// ============================================================

module.exports = {
  getEmbedding,
  getEmbeddingRaw,
  EMBED_PROVIDERS,
  embedOllama,
  embedOpenAI,
  embedGemini,
  embedVoyageAI,
  estimateTextUnits,
  logCostCall,
};
