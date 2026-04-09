#!/usr/bin/env node
/**
 * experience-core.js — Shared Experience Engine logic
 * Used by Claude Code, Gemini CLI, and Codex CLI hooks.
 * Zero npm dependencies. Node.js 20 native fetch only.
 *
 * API:
 *   intercept(toolName, toolInput, signal) → string | null
 *   extractFromSession(sessionLog)        → void (stores to Qdrant)
 *   getEmbeddingRaw(text, signal)         → number[] | null
 *
 * Config via ~/.experience/config.json (set by setup.sh). Fallback: EXPERIENCE_* env vars.
 */

'use strict';

// --- Native config loader (D-06) ---
// Reads ~/.experience/config.json BEFORE any other config.
// setup.sh writes this file. No injection, no env auto-detect.
const _cfg = (() => {
  try {
    return JSON.parse(
      require('fs').readFileSync(
        require('path').join(require('os').homedir(), '.experience', 'config.json'),
        'utf8'
      )
    );
  } catch { return {}; }
})();

// --- Config (D-07, D-11) ---
// Priority: config.json > EXPERIENCE_* env vars > defaults
// NEVER fall back to ambient env (OPENAI_API_KEY, GEMINI_API_KEY, etc.)

const QDRANT_BASE     = _cfg.qdrantUrl     || process.env.EXPERIENCE_QDRANT_URL     || 'http://localhost:6333';
const QDRANT_API_KEY  = _cfg.qdrantKey     || process.env.EXPERIENCE_QDRANT_KEY     || '';
const OLLAMA_BASE     = _cfg.ollamaUrl     || process.env.EXPERIENCE_OLLAMA_URL     || 'http://localhost:11434';
const EMBED_PROVIDER  = _cfg.embedProvider || process.env.EXPERIENCE_EMBED_PROVIDER || 'ollama';
const BRAIN_PROVIDER  = _cfg.brainProvider || process.env.EXPERIENCE_BRAIN_PROVIDER || 'ollama';
const EMBED_MODEL     = _cfg.embedModel    || process.env.EXPERIENCE_EMBED_MODEL    || 'nomic-embed-text';
const BRAIN_MODEL     = _cfg.brainModel    || process.env.EXPERIENCE_BRAIN_MODEL    || 'qwen2.5:3b';
const EMBED_ENDPOINT  = _cfg.embedEndpoint || process.env.EXPERIENCE_EMBED_ENDPOINT || '';
const EMBED_KEY       = _cfg.embedKey      || process.env.EXPERIENCE_EMBED_KEY      || '';
const BRAIN_ENDPOINT  = _cfg.brainEndpoint || process.env.EXPERIENCE_BRAIN_ENDPOINT || '';
const BRAIN_KEY       = _cfg.brainKey      || process.env.EXPERIENCE_BRAIN_KEY      || '';
const EMBED_DIM       = _cfg.embedDim      || 768;
const MIN_CONFIDENCE  = _cfg.minConfidence  || 0.42;
const HIGH_CONFIDENCE = _cfg.highConfidence || 0.60;

const OLLAMA_EMBED_URL = `${OLLAMA_BASE}/api/embed`;
const OLLAMA_GENERATE_URL = `${OLLAMA_BASE}/api/generate`;

const COLLECTIONS = [
  { name: 'experience-principles', topK: 2, budgetChars: 800 },
  { name: 'experience-behavioral', topK: 3, budgetChars: 1200 },
  { name: 'experience-selfqa',     topK: 2, budgetChars: 1000 },
];

const SELFQA_COLLECTION = 'experience-selfqa';
const DEDUP_THRESHOLD = 0.85;
const QUERY_MAX_CHARS = 500;

// --- Qdrant availability (per D-14) ---
let qdrantAvailable = null; // null = unchecked, true/false = checked
const FILESTORE_DIR = require('path').join(require('os').homedir(), '.experience', 'store');

async function checkQdrant() {
  if (qdrantAvailable !== null) return qdrantAvailable;
  try {
    const res = await fetch(`${QDRANT_BASE}/collections`, {
      headers: QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    qdrantAvailable = res.ok;
  } catch { qdrantAvailable = false; }
  return qdrantAvailable;
}

// --- FileStore: JSON-based fallback (per D-13) ---
const fs = require('fs');
const pathMod = require('path');

// --- Activity logging (Phase 102) ---
const ACTIVITY_LOG = process.env.EXPERIENCE_ACTIVITY_LOG || pathMod.join(require('os').homedir(), '.experience', 'activity.jsonl');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function activityLog(event) {
  try {
    try {
      const stat = fs.statSync(ACTIVITY_LOG);
      if (stat.size >= MAX_LOG_SIZE) {
        try { fs.renameSync(ACTIVITY_LOG, ACTIVITY_LOG + '.1'); } catch { /* race-safe */ }
      }
    } catch { /* file may not exist yet — fine */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(ACTIVITY_LOG, line + '\n');
  } catch { /* never crash the engine */ }
}

function extractProjectPath(toolInput) {
  const raw = toolInput?.file_path || toolInput?.path || '';
  if (!raw) return null;
  return raw.replace(/\\/g, '/');
}

function fileStorePath(collection) {
  return pathMod.join(FILESTORE_DIR, `${collection}.json`);
}

function fileStoreRead(collection) {
  try {
    return JSON.parse(fs.readFileSync(fileStorePath(collection), 'utf8'));
  } catch { return []; }
}

function fileStoreWrite(collection, entries) {
  fs.mkdirSync(FILESTORE_DIR, { recursive: true });
  const tmp = fileStorePath(collection) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2)); // pretty-printed per specifics
  fs.renameSync(tmp, fileStorePath(collection)); // atomic per D-16
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function fileStoreSearch(collection, vector, topK) {
  const entries = fileStoreRead(collection);
  const scored = entries
    .filter(e => e.vector && e.vector.length === vector.length)
    .map(e => ({ ...e, score: cosineSimilarity(vector, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  // Return in Qdrant-compatible format
  return scored.map(e => ({ id: e.id, score: e.score, payload: e.payload }));
}

function fileStoreUpsert(collection, id, vector, payload) {
  const entries = fileStoreRead(collection);
  const idx = entries.findIndex(e => e.id === id);
  const entry = { id, vector, payload };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  fileStoreWrite(collection, entries);
}

// --- Intercept: query experience before tool call ---

async function intercept(toolName, toolInput, signal) {
  const query = buildQuery(toolName, toolInput);
  const vector = await getEmbedding(query, signal);
  if (!vector) return null;

  const [t0, t1, t2] = await Promise.all([
    searchCollection(COLLECTIONS[0].name, vector, COLLECTIONS[0].topK, signal),
    searchCollection(COLLECTIONS[1].name, vector, COLLECTIONS[1].topK, signal),
    searchCollection(COLLECTIONS[2].name, vector, COLLECTIONS[2].topK, signal),
  ]);

  // Rerank by quality score before formatting (Phase 103)
  const r0 = rerankByQuality(t0);
  const r1 = rerankByQuality(t1);
  const r2 = rerankByQuality(t2);

  const lines = [
    ...applyBudget(formatPoints(r0), COLLECTIONS[0].budgetChars),
    ...applyBudget(formatPoints(r1), COLLECTIONS[1].budgetChars),
    ...applyBudget(formatPoints(r2), COLLECTIONS[2].budgetChars),
  ];

  // Fire-and-forget recordHit for each surfaced point (Phase 103)
  const allReranked = [
    ...r0.map(p => ({ ...p, _collection: COLLECTIONS[0].name })),
    ...r1.map(p => ({ ...p, _collection: COLLECTIONS[1].name })),
    ...r2.map(p => ({ ...p, _collection: COLLECTIONS[2].name })),
  ];
  const surfaced = allReranked.filter(p => {
    try {
      const exp = JSON.parse(p.payload?.json || '{}');
      return exp.solution && computeEffectiveConfidence(exp) >= MIN_CONFIDENCE;
    } catch { return false; }
  });
  if (surfaced.length > 0) {
    Promise.all(surfaced.map(p => recordHit(p._collection, p.id))).catch(() => {});
  }

  activityLog({ op: 'intercept', query: query.slice(0, 120), scores: [...r0, ...r1, ...r2].map(p => p._effectiveScore ?? p.score).sort((a, b) => b - a).slice(0, 3), result: lines.length > 0 ? 'suggestion' : null, project: extractProjectPath(toolInput) });

  return lines.length > 0 ? lines.join('\n---\n') : null;
}

// --- Extract: detect mistakes and store lessons ---

async function extractFromSession(transcript, projectPath) {
  if (!transcript || transcript.length < 100) return 0;

  const mistakes = detectMistakes(transcript);
  if (mistakes.length === 0) {
    activityLog({ op: 'extract', mistakes: 0, stored: 0, project: projectPath || null });
    return 0;
  }

  let stored = 0;
  for (const mistake of mistakes.slice(0, 5)) {
    try {
      const qa = await extractQA(mistake);
      if (!qa || !qa.trigger || !qa.solution) continue;
      if (await isDuplicate(qa)) continue;
      await storeExperience(qa);
      stored++;
    } catch { /* skip */ }
  }
  activityLog({ op: 'extract', mistakes: mistakes.length, stored, project: projectPath || null });
  return stored;
}

// --- Query construction ---

function buildQuery(toolName, toolInput) {
  let raw;
  // Normalize tool names across agents
  const tool = (toolName || '').toLowerCase();

  if (tool === 'bash' || tool === 'shell' || tool === 'execute_command') {
    raw = `Command: ${(toolInput.command || toolInput.cmd || '').slice(0, 200)}`;
  } else if (tool === 'edit' || tool === 'replace' || tool === 'replace_in_file') {
    raw = `Edit: ${toolInput.file_path || toolInput.path || ''} — ${(toolInput.new_string || toolInput.content || '').slice(0, 300)}`;
  } else if (tool === 'write' || tool === 'write_file' || tool === 'create_file') {
    raw = `Write: ${toolInput.file_path || toolInput.path || ''} — ${(toolInput.content || '').slice(0, 300)}`;
  } else {
    raw = `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  }
  return raw.slice(0, QUERY_MAX_CHARS);
}

// --- Mistake detection ---

function detectMistakes(transcript) {
  const mistakes = [];
  const lines = transcript.split('\n');

  // Retry loops
  const toolCalls = {};
  for (const line of lines) {
    const match = line.match(/(Edit|Write|Bash|shell|replace|write_file).*?([\w./]+\.\w+)/i);
    if (match) {
      const key = `${match[1]}:${match[2]}`;
      toolCalls[key] = (toolCalls[key] || 0) + 1;
    }
  }
  for (const [key, count] of Object.entries(toolCalls)) {
    if (count >= 3) {
      mistakes.push({
        type: 'retry_loop',
        context: `Tool ${key} called ${count} times`,
        excerpt: lines.filter(l => l.includes(key.split(':')[1])).slice(0, 10).join('\n')
      });
    }
  }

  // Error → fix patterns
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].match(/error|Error|ERROR|fail|FAIL|exception/i)
        && lines[i + 1] && !lines[i + 1].match(/error|Error|fail/i)) {
      mistakes.push({
        type: 'error_fix',
        context: 'Error followed by correction',
        excerpt: lines.slice(Math.max(0, i - 2), i + 4).join('\n')
      });
    }
  }

  // User correction (per D-10, D-12) — proximity window after tool call
  const toolCallPattern = /Tool(Use|Call)|tool_name|toolName|>\s*(Edit|Write|Bash|Read)/i;
  const correctionPattern = /\b(no[,.]?\s|wrong|don't|instead|not that|stop|undo|revert this)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (toolCallPattern.test(lines[i])) {
      // Check next 5 lines for user correction
      for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
        if (correctionPattern.test(lines[j])) {
          mistakes.push({
            type: 'user_correction',
            context: `User corrected agent after tool call at line ${i}`,
            excerpt: lines.slice(Math.max(0, i - 1), j + 2).join('\n')
          });
          break;
        }
      }
    }
  }

  // Test fail -> fix (per D-10)
  const testFailPattern = /\bFAIL\b|test\s+failed|AssertionError|AssertError|FAILED|assert\.|expect\(.*\)\.to/i;
  const fixActionPattern = /(Edit|Write|write_file|replace|replace_in_file)/i;
  for (let i = 0; i < lines.length; i++) {
    if (testFailPattern.test(lines[i])) {
      for (let j = i + 1; j <= Math.min(i + 10, lines.length - 1); j++) {
        if (fixActionPattern.test(lines[j])) {
          mistakes.push({
            type: 'test_fail_fix',
            context: `Test failure at line ${i} followed by fix at line ${j}`,
            excerpt: lines.slice(Math.max(0, i - 1), j + 3).join('\n')
          });
          break;
        }
      }
    }
  }

  // Git revert (per D-10)
  const gitRevertPattern = /git\s+(revert|reset\s+--hard|checkout\s+--\s|restore\s)/i;
  for (let i = 0; i < lines.length; i++) {
    if (gitRevertPattern.test(lines[i])) {
      mistakes.push({
        type: 'git_revert',
        context: `Git revert/reset detected at line ${i}`,
        excerpt: lines.slice(Math.max(0, i - 3), i + 3).join('\n')
      });
    }
  }

  return mistakes;
}

// --- Brain extraction ---

async function extractQA(mistake) {
  const prompt = `Given this session excerpt where something went wrong:\n${mistake.excerpt.slice(0, 1500)}\n\nExtract in JSON (no markdown):\n{"trigger":"one line","question":"one line","reasoning":["step1","step2"],"solution":"one line"}`;
  const brains = {
    ollama:   brainOllama,
    openai:   brainOpenAI,
    gemini:   brainGemini,
    claude:   brainClaude,
    deepseek: brainDeepSeek,
  };
  const fn = brains[BRAIN_PROVIDER] || brains.ollama;
  return fn(prompt);
}

async function brainOllama(prompt) {
  try {
    const res = await fetch(OLLAMA_GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: BRAIN_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    const m = (await res.json()).response?.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainOpenAI(prompt) {
  // Reused for any OpenAI-compatible API (OpenAI, SiliconFlow, Together, Groq, etc.)
  const endpoint = BRAIN_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const body = { model: BRAIN_MODEL || 'gpt-4o-mini', messages: [{ role:'user', content: prompt }], temperature: 0.3 };
  // Only add json_object mode for known-supporting providers (OpenAI, DeepSeek)
  if (endpoint.includes('openai.com') || endpoint.includes('deepseek.com')) {
    body.response_format = { type: 'json_object' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BRAIN_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    // Try direct parse, fallback to regex extract
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainGemini(prompt) {
  try {
    const model = BRAIN_MODEL || 'gemini-2.0-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${BRAIN_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch { return null; }
}

async function brainClaude(prompt) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': BRAIN_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: BRAIN_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role:'user', content: prompt }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).content?.[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainDeepSeek(prompt) {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BRAIN_KEY}` },
      body: JSON.stringify({ model: BRAIN_MODEL || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
  } catch { return null; }
}

// --- Dedup ---

async function isDuplicate(qa) {
  const vector = await getEmbedding(`${qa.trigger} ${qa.question}`);
  if (!vector) return false;

  if (!(await checkQdrant())) {
    const results = fileStoreSearch(SELFQA_COLLECTION, vector, 1);
    return (results[0]?.score ?? 0) > DEDUP_THRESHOLD;
  }

  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${SELFQA_COLLECTION}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ query: vector, limit: 1, with_payload: false }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.result?.points?.[0]?.score ?? 0) > DEDUP_THRESHOLD;
  } catch { return false; }
}

// --- Store ---

function buildStorePayload(id, qa) {
  return {
    id, trigger: qa.trigger, question: qa.question,
    reasoning: qa.reasoning || [], solution: qa.solution,
    confidence: 0.5, hitCount: 0, tier: 2,
    lastHitAt: null, ignoreCount: 0,
    createdAt: new Date().toISOString(), createdFrom: 'session-extractor',
  };
}

async function storeExperience(qa) {
  const text = `${qa.trigger} ${qa.question} ${qa.solution}`;
  const vector = await getEmbedding(text);
  if (!vector) return;

  const id = crypto.randomUUID();
  const payload = {
    json: JSON.stringify(buildStorePayload(id, qa))
  };

  if (!(await checkQdrant())) {
    fileStoreUpsert(SELFQA_COLLECTION, id, vector, payload);
    return;
  }

  await fetch(`${QDRANT_BASE}/collections/${SELFQA_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
    signal: AbortSignal.timeout(5000),
  });
}

// --- Provider abstraction (D-08, D-09, D-10) ---
// EMBED_PROVIDER / BRAIN_PROVIDER come from config.json (set by setup.sh).
// Dim is ALWAYS read from config.json (EMBED_DIM constant) — never hardcoded here.
// siliconflow and custom are first-class providers (reuse OpenAI-compatible fn).

const EMBED_PROVIDERS = {
  ollama:       { fn: embedOllama },
  openai:       { fn: embedOpenAI },
  gemini:       { fn: embedGemini },
  voyageai:     { fn: embedVoyageAI },
  siliconflow:  { fn: embedOpenAI },
  custom:       { fn: embedOpenAI },
};

async function getEmbedding(text, signal) {
  const p = EMBED_PROVIDERS[EMBED_PROVIDER] || EMBED_PROVIDERS.ollama;
  return p.fn(text, signal);
}

async function embedOllama(text, signal) {
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings?.[0] || null;
  } catch { return null; }
}

async function embedOpenAI(text, signal) {
  // Supports OpenAI, SiliconFlow, custom, and any OpenAI-compatible embedding API
  const endpoint = EMBED_ENDPOINT || 'https://api.openai.com/v1/embeddings';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${EMBED_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

async function embedGemini(text, signal) {
  try {
    const model = EMBED_MODEL || 'text-embedding-004';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${EMBED_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).embedding?.values || null;
  } catch { return null; }
}

async function embedVoyageAI(text, signal) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${EMBED_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL || 'voyage-code-3', input: [text.slice(0, 8000)] }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

// --- Qdrant search ---

async function searchCollection(name, vector, topK, signal) {
  if (!(await checkQdrant())) return fileStoreSearch(name, vector, topK);
  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${name}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ query: vector, limit: topK, with_payload: true }),
      signal,
    });
    if (!res.ok) return fileStoreSearch(name, vector, topK);
    return (await res.json()).result?.points ?? [];
  } catch { return fileStoreSearch(name, vector, topK); }
}

// --- Anti-Noise Scoring (Phase 103) ---

function computeEffectiveConfidence(data) {
  const base = data.confidence || 0.5;
  const hits = data.hitCount || 0;
  const ageFactor = Math.min(1.0, 0.7 + (hits * 0.06));
  return base * ageFactor;
}

function computeEffectiveScore(point, data) {
  const cosine = point.score || 0;
  const hitBoost = Math.log2(1 + (data.hitCount || 0)) * 0.05;
  const daysSinceHit = data.lastHitAt
    ? (Date.now() - new Date(data.lastHitAt).getTime()) / 86400000
    : 0;
  const recencyPenalty = daysSinceHit > 30
    ? Math.min(0.15, (daysSinceHit - 30) / 335 * 0.15)
    : 0;
  const ignorePenalty = (data.ignoreCount || 0) >= 3 ? 0.10 : 0;
  return cosine + hitBoost - recencyPenalty - ignorePenalty;
}

function rerankByQuality(points) {
  return points
    .map(p => {
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      return { ...p, _effectiveScore: computeEffectiveScore(p, data) };
    })
    .sort((a, b) => b._effectiveScore - a._effectiveScore);
}

// --- Formatting ---

function formatPoints(points) {
  const lines = [];
  for (const point of points) {
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    // Use effective confidence for the MIN_CONFIDENCE filter (NOISE-03)
    const effConf = computeEffectiveConfidence(exp);
    if (effConf < MIN_CONFIDENCE) continue;
    // Use _effectiveScore (from rerankByQuality) for display, fallback to raw score
    const displayScore = point._effectiveScore ?? point.score ?? 0;
    if (displayScore >= HIGH_CONFIDENCE) {
      lines.push(`⚠️ [Experience - High Confidence (${displayScore.toFixed(2)})]: ${exp.solution}`);
    } else {
      lines.push(`💡 [Suggestion (${displayScore.toFixed(2)})]: ${exp.solution}`);
    }
  }
  return lines;
}

function applyBudget(lines, maxChars) {
  const result = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > maxChars) break;
    result.push(line);
    total += line.length;
  }
  return result;
}

// --- recordHit: increment hitCount on experience entries ---

function applyHitUpdate(data) {
  data.hitCount = (data.hitCount || 0) + 1;
  data.lastHitAt = new Date().toISOString();
  data.ignoreCount = 0;
  return data;
}

async function recordHit(collection, pointId) {
  if (!(await checkQdrant())) {
    // FileStore: update hitCount in-place
    const entries = fileStoreRead(collection);
    const entry = entries.find(e => e.id === pointId);
    if (entry && entry.payload?.json) {
      const data = JSON.parse(entry.payload.json);
      applyHitUpdate(data);
      entry.payload.json = JSON.stringify(data);
      fileStoreWrite(collection, entries);
    }
    return;
  }
  try {
    // Qdrant: scroll to get current payload, increment, update
    const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const point = (await res.json()).result;
    if (!point?.payload?.json) return;
    const data = JSON.parse(point.payload.json);
    applyHitUpdate(data);
    await fetch(`${QDRANT_BASE}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent */ }
}

// --- syncToQdrant: migrate FileStore data to Qdrant (per D-17) ---

async function syncToQdrant() {
  if (!(await checkQdrant())) throw new Error('Qdrant not available');
  const collections = COLLECTIONS.map(c => c.name);
  let synced = 0;
  for (const coll of collections) {
    const entries = fileStoreRead(coll);
    if (entries.length === 0) continue;
    // Batch upsert in chunks of 50
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50).map(e => ({
        id: e.id, vector: e.vector, payload: e.payload,
      }));
      await fetch(`${QDRANT_BASE}/collections/${coll}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
        body: JSON.stringify({ points: batch }),
        signal: AbortSignal.timeout(30000),
      });
      synced += batch.length;
    }
  }
  return synced;
}

// --- Evolution Engine (per D-03) ---

async function evolve(trigger) {
  const results = { promoted: 0, abstracted: 0, demoted: 0, archived: 0 };

  // Step 1: Promote T2 -> T1 (per D-04)
  // Read all T2 entries, filter hitCount >= 3, write to T1, delete from T2
  const t2Entries = await getAllEntries('experience-selfqa');
  for (const entry of t2Entries) {
    const data = parsePayload(entry);
    if (!data || (data.hitCount || 0) < 3) continue;
    data.tier = 1;
    data.promotedAt = new Date().toISOString();
    const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
    if (!vector) continue;
    await upsertEntry('experience-behavioral', entry.id, vector, data);
    await deleteEntry('experience-selfqa', entry.id);
    results.promoted++;
  }

  // Step 2: Abstract T2 clusters -> T0 (per D-05)
  // Cluster T2 by cosine > 0.80, groups of 3+ -> brain abstract -> T0 principle
  const remainingT2 = await getAllEntries('experience-selfqa');
  const clustered = clusterByCosine(remainingT2, 0.80);
  for (const cluster of clustered) {
    if (cluster.length < 3) continue;
    const summaries = cluster.map(e => {
      const d = parsePayload(e);
      return d ? `${d.trigger}: ${d.solution}` : '';
    }).filter(Boolean);

    const prompt = `Given these ${summaries.length} related experiences, extract ONE general principle covering all cases. Format as JSON: {"principle":"When [condition], always [action] because [reason]"}\n\n${summaries.join('\n')}`;

    const brains = { ollama: brainOllama, openai: brainOpenAI, gemini: brainGemini, claude: brainClaude, deepseek: brainDeepSeek };
    const fn = brains[BRAIN_PROVIDER] || brains.ollama;
    const result = await fn(prompt);
    if (!result?.principle) continue;

    const vector = await getEmbedding(result.principle);
    if (!vector) continue;

    const id = crypto.randomUUID();
    await upsertEntry('experience-principles', id, vector, {
      id, principle: result.principle, solution: result.principle,
      tier: 0, confidence: 0.85, hitCount: 0,
      createdAt: new Date().toISOString(), createdFrom: 'evolution-abstraction',
      sourceCount: cluster.length,
    });

    // Delete source entries from T2
    for (const e of cluster) {
      await deleteEntry('experience-selfqa', e.id);
    }
    results.abstracted++;
  }

  // Step 3: Demote T1 -> T2 (per D-06)
  const t1Entries = await getAllEntries('experience-behavioral');
  for (const entry of t1Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    if (data.contradiction || (data.hitCount || 0) < 0) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.2);
      data.demotedAt = new Date().toISOString();
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-behavioral', entry.id);
      results.demoted++;
    }
  }

  // Step 4: Archive stale T2 (per D-07)
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const allT2 = await getAllEntries('experience-selfqa');
  for (const entry of allT2) {
    const data = parsePayload(entry);
    if (!data) continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age > NINETY_DAYS && (data.hitCount || 0) === 0) {
      await deleteEntry('experience-selfqa', entry.id);
      results.archived++;
    }
  }

  activityLog({ op: 'evolve', ...results, trigger: trigger || 'auto' });

  return results;
}

// --- Evolution helpers ---

function parsePayload(entry) {
  try { return JSON.parse(entry.payload?.json || '{}'); } catch { return null; }
}

function clusterByCosine(entries, threshold) {
  // Simple pairwise greedy clustering
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i) || !entries[i].vector) continue;
    const cluster = [entries[i]];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j) || !entries[j].vector) continue;
      if (cosineSimilarity(entries[i].vector, entries[j].vector) > threshold) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

async function getAllEntries(collection) {
  if (!(await checkQdrant())) {
    return fileStoreRead(collection);
  }
  // Qdrant: scroll all points
  const points = [];
  let offset = null;
  do {
    try {
      const body = { limit: 100, with_payload: true, with_vector: true };
      if (offset) body.offset = offset;
      const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.result?.points || [];
      points.push(...batch);
      offset = data.result?.next_page_offset || null;
    } catch { break; }
  } while (offset);
  return points;
}

async function upsertEntry(collection, id, vector, data) {
  const payload = { json: JSON.stringify(data) };
  if (!(await checkQdrant())) {
    fileStoreUpsert(collection, id, vector, payload);
    return;
  }
  await fetch(`${QDRANT_BASE}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
    signal: AbortSignal.timeout(5000),
  });
}

async function deleteEntry(collection, id) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    fileStoreWrite(collection, entries.filter(e => e.id !== id));
    return;
  }
  await fetch(`${QDRANT_BASE}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    body: JSON.stringify({ points: [id] }),
    signal: AbortSignal.timeout(5000),
  });
}

// --- getEmbeddingRaw: exported for external callers (e.g. bulk-seed.js) (D-16) ---

async function getEmbeddingRaw(text, signal) {
  return getEmbedding(text, signal);
}

// --- Exports ---

module.exports = { intercept, extractFromSession, recordHit, syncToQdrant, evolve, getEmbeddingRaw, _activityLog: activityLog, _computeEffectiveScore: computeEffectiveScore, _computeEffectiveConfidence: computeEffectiveConfidence, _rerankByQuality: rerankByQuality, _formatPoints: formatPoints, _storeExperiencePayload: (qa) => buildStorePayload(require('crypto').randomUUID(), qa), _recordHitUpdatesFields: applyHitUpdate };
