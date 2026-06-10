/**
 * embedding.js — Embedding provider abstraction for Experience Engine.
 * Extracted from experience-core.js. Zero npm dependencies.
 */
'use strict';

const {
  getOllamaEmbedUrl,
  getEmbedProvider, getEmbedModel, getEmbedEndpoint, getEmbedKey, getEmbedTimeoutMs,
  activityLog,
} = require('./config');

// ============================================================
//  Failure classification (No-Silent-Catch)
//  Providers used to `catch { return null }` / `if(!res.ok) return null`, which
//  discarded the HTTP status + body + error name — the exact signals needed to
//  tell a transient timeout apart from a 4xx auth/quota error. We now return
//  { vector, err } so getEmbedding can log the cause and record it on the
//  cost-call (visible in activity.jsonl without a code change next incident).
// ============================================================

function classifyError(err) {
  const name = err?.name || '';
  // AbortSignal.timeout fires an AbortError / TimeoutError on deadline.
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (err?.cause?.code || /fetch failed|ECONN|ENOTFOUND|socket/i.test(err?.message || '')) return 'network';
  return 'error';
}

function logEmbedFailure(provider, err) {
  console.error(
    `[embedding] ${provider} embed failed (${err.kind}${err.status ? ' ' + err.status : ''}): ${err.message}`,
  );
}

// ============================================================
//  LRU embedding cache (server-side)
//  Hot prompts (e.g. PIL Layer 3 / 5 from CLI clients) are issued repeatedly
//  with identical text. Caching the vector avoids redundant SiliconFlow calls
//  and keeps p99 latency tight under burst load.
// ============================================================

const EMBED_CACHE_MAX = 500;
const EMBED_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const _embedCache = new Map();

function embedCacheKey(text) {
  // Collapse whitespace and bound to the same 8000-char window providers use.
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 8000);
}

function getCachedEmbedding(text) {
  const key = embedCacheKey(text);
  const entry = _embedCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _embedCache.delete(key);
    return null;
  }
  return entry.vector;
}

function setCachedEmbedding(text, vector) {
  const key = embedCacheKey(text);
  if (_embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = _embedCache.keys().next().value;
    if (oldest !== undefined) _embedCache.delete(oldest);
  }
  _embedCache.set(key, { vector, expiresAt: Date.now() + EMBED_CACHE_TTL_MS });
}

// ============================================================
//  Embedding Providers
// ============================================================

// Each provider returns { vector, err }. On HTTP non-2xx the status + a
// truncated body are captured; on throw the error is classified (timeout /
// network / error). err is null on success.
async function embedFetch(provider, url, init, extract, signal) {
  try {
    const res = await fetch(url, { ...init, signal: signal || AbortSignal.timeout(getEmbedTimeoutMs()) });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
      const err = { kind: res.status >= 500 ? 'http5xx' : 'http4xx', status: res.status, message: body || res.statusText };
      logEmbedFailure(provider, err);
      return { vector: null, err };
    }
    return { vector: extract(await res.json()) || null, err: null };
  } catch (e) {
    const err = { kind: classifyError(e), status: 0, message: e?.message || String(e) };
    logEmbedFailure(provider, err);
    return { vector: null, err };
  }
}

function embedOllama(text, signal) {
  return embedFetch('ollama', getOllamaEmbedUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: getEmbedModel(), input: text }),
  }, (j) => j.embeddings?.[0], signal);
}

function embedOpenAI(text, signal) {
  const endpoint = getEmbedEndpoint() || 'https://api.openai.com/v1/embeddings';
  return embedFetch('openai', endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
    body: JSON.stringify({ model: getEmbedModel() || 'text-embedding-3-small', input: text.slice(0, 8000) }),
  }, (j) => j.data?.[0]?.embedding, signal);
}

function embedGemini(text, signal) {
  const model = getEmbedModel() || 'text-embedding-004';
  return embedFetch('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${getEmbedKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
  }, (j) => j.embedding?.values, signal);
}

function embedVoyageAI(text, signal) {
  return embedFetch('voyageai', 'https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEmbedKey()}` },
    body: JSON.stringify({ model: getEmbedModel() || 'voyage-code-3', input: [text.slice(0, 8000)] }),
  }, (j) => j.data?.[0]?.embedding, signal);
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
  // Fast path: serve from in-memory LRU cache when available.
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const provider = getEmbedProvider();
  const p = EMBED_PROVIDERS[provider] || EMBED_PROVIDERS.ollama;
  const units = estimateTextUnits(text, 8000);

  // Records a cost-call with the failure cause (errKind/status) on miss, so an
  // incident is diagnosable from activity.jsonl without re-instrumenting.
  const attempt = async (prov, fn, source) => {
    const startedAt = Date.now();
    const { vector, err } = await fn(text, signal);
    logCostCall('embed', prov, meta.source || source, units, {
      ok: !!vector,
      durationMs: Date.now() - startedAt,
      ...(err ? { errKind: err.kind, status: err.status } : {}),
    });
    return vector;
  };

  let vector = await attempt(provider, p.fn, 'general');
  if (vector) { setCachedEmbedding(text, vector); return vector; }

  // Retry once after 500ms backoff
  await new Promise(r => setTimeout(r, 500));
  vector = await attempt(provider, p.fn, 'general-retry');
  if (vector) { setCachedEmbedding(text, vector); return vector; }

  // Fallback to Ollama if primary provider is not already Ollama
  if (provider !== 'ollama' && EMBED_PROVIDERS.ollama) {
    vector = await attempt('ollama', EMBED_PROVIDERS.ollama.fn, 'general-fallback');
    if (vector) setCachedEmbedding(text, vector);
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
  classifyError,
};
