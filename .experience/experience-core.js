#!/usr/bin/env node
/**
 * experience-core.js — Shared Experience Engine logic
 * Used by Claude Code, Gemini CLI, and Codex CLI hooks.
 * Zero npm dependencies. Node.js 20 native fetch only.
 *
 * API:
 *   intercept(toolName, toolInput, signal) → string | null
 *   extractFromSession(sessionLog)        → void (stores to Qdrant)
 *
 * Config via env vars or ~/.experience/config.json (set by setup.sh):
 *   EXPERIENCE_QDRANT_URL      (default: http://localhost:6333)
 *   EXPERIENCE_QDRANT_KEY      (default: empty)
 *   EXPERIENCE_OLLAMA_URL      (default: http://localhost:11434)
 *   EXPERIENCE_EMBED_MODEL     (default: nomic-embed-text)
 *   EXPERIENCE_BRAIN_MODEL     (default: qwen2.5:3b)
 *   EXPERIENCE_BRAIN_ENDPOINT  (OpenAI-compatible URL override)
 *   EXPERIENCE_BRAIN_KEY       (API key for brain endpoint)
 *   OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY
 */

'use strict';

// --- Config ---

const QDRANT_BASE = process.env.EXPERIENCE_QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.EXPERIENCE_QDRANT_KEY || '';
const OLLAMA_BASE = process.env.EXPERIENCE_OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_URL = `${OLLAMA_BASE}/api/embed`;
const OLLAMA_GENERATE_URL = `${OLLAMA_BASE}/api/generate`;
const OLLAMA_EMBED_MODEL = process.env.EXPERIENCE_EMBED_MODEL || 'nomic-embed-text';
const OLLAMA_BRAIN_MODEL = process.env.EXPERIENCE_BRAIN_MODEL || 'qwen2.5:3b';

const COLLECTIONS = [
  { name: 'experience-principles', topK: 2, budgetChars: 800 },
  { name: 'experience-behavioral', topK: 3, budgetChars: 1200 },
  { name: 'experience-selfqa',     topK: 2, budgetChars: 1000 },
];

const SELFQA_COLLECTION = 'experience-selfqa';
const DEDUP_THRESHOLD = 0.85;
const HIGH_CONFIDENCE = 0.75;
const MIN_CONFIDENCE = 0.65;
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

  const lines = [
    ...applyBudget(formatPoints(t0), COLLECTIONS[0].budgetChars),
    ...applyBudget(formatPoints(t1), COLLECTIONS[1].budgetChars),
    ...applyBudget(formatPoints(t2), COLLECTIONS[2].budgetChars),
  ];

  return lines.length > 0 ? lines.join('\n---\n') : null;
}

// --- Extract: detect mistakes and store lessons ---

async function extractFromSession(transcript) {
  if (!transcript || transcript.length < 100) return 0;

  const mistakes = detectMistakes(transcript);
  if (mistakes.length === 0) return 0;

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
      body: JSON.stringify({ model: OLLAMA_BRAIN_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    const m = (await res.json()).response?.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainOpenAI(prompt) {
  // Reused for any OpenAI-compatible API (OpenAI, SiliconFlow, Together, Groq, etc.)
  // EXPERIENCE_BRAIN_ENDPOINT overrides base URL
  const endpoint = process.env.EXPERIENCE_BRAIN_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const apiKey = process.env.EXPERIENCE_BRAIN_KEY || process.env.OPENAI_API_KEY || '';
  const body = { model: process.env.EXPERIENCE_BRAIN_MODEL || 'gpt-4o-mini', messages: [{ role:'user', content: prompt }], temperature: 0.3 };
  // Only add json_object mode for known-supporting providers (OpenAI, DeepSeek)
  if (endpoint.includes('openai.com') || endpoint.includes('deepseek.com')) {
    body.response_format = { type: 'json_object' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
    const model = process.env.EXPERIENCE_BRAIN_MODEL || 'gemini-2.0-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.EXPERIENCE_BRAIN_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role:'user', content: prompt }] }),
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: process.env.EXPERIENCE_BRAIN_MODEL || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
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

async function storeExperience(qa) {
  const text = `${qa.trigger} ${qa.question} ${qa.solution}`;
  const vector = await getEmbedding(text);
  if (!vector) return;

  const id = crypto.randomUUID();
  const payload = {
    json: JSON.stringify({
      id, trigger: qa.trigger, question: qa.question,
      reasoning: qa.reasoning || [], solution: qa.solution,
      confidence: 0.5, hitCount: 0, tier: 2,
      createdAt: new Date().toISOString(), createdFrom: 'session-extractor',
    })
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

// --- Provider abstraction ---
// EXPERIENCE_EMBED_PROVIDER: ollama (default) | openai | gemini | voyageai
// EXPERIENCE_BRAIN_PROVIDER: ollama (default) | openai | gemini | claude | deepseek
//
// Each provider needs its own API key env var:
//   OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, VOYAGEAI_API_KEY

const EMBED_PROVIDER  = process.env.EXPERIENCE_EMBED_PROVIDER  || (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'ollama');
const BRAIN_PROVIDER  = process.env.EXPERIENCE_BRAIN_PROVIDER  || (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.EXPERIENCE_BRAIN_KEY ? 'openai' : 'ollama');

// Embedding providers config
const EMBED_PROVIDERS = {
  ollama:    { dim: 768,  fn: embedOllama },
  openai:    { dim: 1536, fn: embedOpenAI },
  gemini:    { dim: 768,  fn: embedGemini },
  voyageai:  { dim: 1024, fn: embedVoyageAI },
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
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings?.[0] || null;
  } catch { return null; }
}

async function embedOpenAI(text, signal) {
  // Supports OpenAI, SiliconFlow, and any OpenAI-compatible embedding API
  const endpoint = process.env.EXPERIENCE_EMBED_ENDPOINT || 'https://api.openai.com/v1/embeddings';
  const apiKey = process.env.EXPERIENCE_EMBED_KEY || process.env.OPENAI_API_KEY || '';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.EXPERIENCE_EMBED_MODEL || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

async function embedGemini(text, signal) {
  try {
    const model = process.env.EXPERIENCE_EMBED_MODEL || 'text-embedding-004';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${process.env.GEMINI_API_KEY}`, {
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGEAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.EXPERIENCE_EMBED_MODEL || 'voyage-code-3', input: [text.slice(0, 8000)] }),
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

// --- Formatting ---

function formatPoints(points) {
  const lines = [];
  for (const point of points) {
    const score = point.score ?? 0;
    if (score < MIN_CONFIDENCE) continue;
    let exp;
    try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
    if (!exp.solution) continue;
    if (score >= HIGH_CONFIDENCE) {
      lines.push(`⚠️ [Experience - High Confidence (${score.toFixed(2)})]: ${exp.solution}`);
    } else {
      lines.push(`💡 [Suggestion (${score.toFixed(2)})]: ${exp.solution}`);
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

async function recordHit(collection, pointId) {
  if (!(await checkQdrant())) {
    // FileStore: update hitCount in-place
    const entries = fileStoreRead(collection);
    const entry = entries.find(e => e.id === pointId);
    if (entry && entry.payload?.json) {
      const data = JSON.parse(entry.payload.json);
      data.hitCount = (data.hitCount || 0) + 1;
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
    data.hitCount = (data.hitCount || 0) + 1;
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

// --- Exports ---

module.exports = { intercept, extractFromSession, recordHit, syncToQdrant };
