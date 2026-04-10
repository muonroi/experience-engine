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
const EDGE_COLLECTION = 'experience-edges';
const DEDUP_THRESHOLD = 0.85;
const RELATES_TO_THRESHOLD = 0.70;
const QUERY_MAX_CHARS = 500;

// --- Ignore tracking: consecutive suggestion detection (NOISE-04) ---
const _suggestionHistory = []; // Array of { id, collection, suggestedAt }
const MAX_SUGGESTION_HISTORY = 50;

function trackSuggestions(surfacedPoints) {
  const flagged = [];
  for (const sp of surfacedPoints) {
    _suggestionHistory.push({ id: sp.id, collection: sp.collection, suggestedAt: Date.now() });
  }
  // Trim to max size
  while (_suggestionHistory.length > MAX_SUGGESTION_HISTORY) {
    _suggestionHistory.shift();
  }
  // Check each surfaced point for 3+ consecutive appearances at the tail
  for (const sp of surfacedPoints) {
    let consecutive = 0;
    // Walk backwards from end of history
    for (let i = _suggestionHistory.length - 1; i >= 0; i--) {
      if (_suggestionHistory[i].id === sp.id) {
        consecutive++;
      } else {
        break; // streak broken
      }
    }
    if (consecutive >= 3) {
      flagged.push({ id: sp.id, collection: sp.collection, consecutive });
    }
  }
  return { flagged };
}

function incrementIgnoreCountData(data) {
  data.ignoreCount = (data.ignoreCount || 0) + 1;
  return data;
}

async function incrementIgnoreCount(collection, pointId) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const entry = entries.find(e => e.id === pointId);
    if (entry && entry.payload?.json) {
      const data = JSON.parse(entry.payload.json);
      incrementIgnoreCountData(data);
      entry.payload.json = JSON.stringify(data);
      fileStoreWrite(collection, entries);
    }
    return;
  }
  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const point = (await res.json()).result;
    if (!point?.payload?.json) return;
    const data = JSON.parse(point.payload.json);
    incrementIgnoreCountData(data);
    await fetch(`${QDRANT_BASE}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent */ }
}

// --- Qdrant availability (per D-14) ---
let qdrantAvailable = null; // null = unchecked, true/false = checked
// Phase 109: Multi-user support — user-namespaced store directory
const EXP_USER = _cfg.user || process.env.EXP_USER || 'default';
const FILESTORE_BASE = require('path').join(require('os').homedir(), '.experience', 'store');
const FILESTORE_DIR = require('path').join(FILESTORE_BASE, EXP_USER);

// Auto-migrate: if old-style files exist at base and user is 'default', move them
(() => {
  if (EXP_USER !== 'default') return;
  try {
    const oldFiles = fs.readdirSync(FILESTORE_BASE).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    if (oldFiles.length > 0 && !fs.existsSync(FILESTORE_DIR)) {
      fs.mkdirSync(FILESTORE_DIR, { recursive: true });
      for (const f of oldFiles) {
        const src = pathMod.join(FILESTORE_BASE, f);
        const dst = pathMod.join(FILESTORE_DIR, f);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
    }
  } catch { /* migration is best-effort */ }
})();

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

async function interceptWithMeta(toolName, toolInput, signal) {
  const query = buildQuery(toolName, toolInput);
  const filePath = toolInput?.file_path || toolInput?.path || '';
  const queryDomain = detectContext(filePath);
  const vector = await getEmbedding(query, signal);
  if (!vector) return null;

  const [t0, t1, t2] = await Promise.all([
    searchCollection(COLLECTIONS[0].name, vector, COLLECTIONS[0].topK, signal),
    searchCollection(COLLECTIONS[1].name, vector, COLLECTIONS[1].topK, signal),
    searchCollection(COLLECTIONS[2].name, vector, COLLECTIONS[2].topK, signal),
  ]);

  // Rerank by quality score before formatting (Phase 103, 104)
  const r0 = rerankByQuality(t0, queryDomain);
  const r1 = rerankByQuality(t1, queryDomain);
  const r2 = rerankByQuality(t2, queryDomain);

  const lines = [
    ...applyBudget(formatPoints(r0), COLLECTIONS[0].budgetChars),
    ...applyBudget(formatPoints(r1), COLLECTIONS[1].budgetChars),
    ...applyBudget(formatPoints(r2), COLLECTIONS[2].budgetChars),
  ];

  // Phase 107: 1-hop graph-augmented retrieval
  try {
    const allIds = [...r0, ...r1, ...r2].map(p => p.id).filter(Boolean);
    const seenIds = new Set(allIds);
    for (const rid of allIds) {
      const edges = getEdgesForId(rid);
      for (const edge of edges) {
        const targetId = edge.source === rid ? edge.target : edge.source;
        if (seenIds.has(targetId)) continue;
        seenIds.add(targetId);
        for (const coll of COLLECTIONS) {
          const found = await fetchPointById(coll.name, targetId);
          if (found) {
            const graphPoint = { ...found, score: (found.score || 0.5) * edge.weight * 0.8, _collection: coll.name, _graphEdge: edge.type };
            const graphFormatted = formatPoints([graphPoint]);
            const graphBudgeted = applyBudget(graphFormatted, 600);
            lines.push(...graphBudgeted);
            break;
          }
        }
      }
    }
  } catch { /* never block intercept on graph failures */ }

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

  // Track suggestions for ignore detection (NOISE-04)
  const surfacedMeta = surfaced.map(p => ({ collection: p._collection, id: p.id }));
  if (surfacedMeta.length > 0) {
    const { flagged } = trackSuggestions(surfacedMeta);
    if (flagged.length > 0) {
      Promise.all(flagged.map(f => incrementIgnoreCount(f.collection, f.id))).catch(() => {});
    }
  }

  activityLog({ op: 'intercept', query: query.slice(0, 120), scores: [...r0, ...r1, ...r2].map(p => p._effectiveScore ?? p.score).sort((a, b) => b - a).slice(0, 3), result: lines.length > 0 ? 'suggestion' : null, project: extractProjectPath(toolInput) });

  return { suggestions: lines.length > 0 ? lines.join('\n---\n') : null, surfacedIds: surfacedMeta };
}

// --- intercept: backward-compatible wrapper returning string|null ---

async function intercept(toolName, toolInput, signal) {
  const result = await interceptWithMeta(toolName, toolInput, signal);
  return result ? result.suggestions : null;
}

// --- Extract: detect mistakes and store lessons ---

function detectTranscriptDomain(transcript) {
  if (!transcript) return null;
  const pattern = /[\w/\\.-]+\.(ts|tsx|js|jsx|cs|py|rs|go|java|kt|swift|cpp|c|rb|lua|sh|ps1|sql)\b/gi;
  const counts = {};
  let match;
  while ((match = pattern.exec(transcript)) !== null) {
    const ext = '.' + match[1].toLowerCase();
    counts[ext] = (counts[ext] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return detectContext(entries[0][0]) || null;
}

async function extractFromSession(transcript, projectPath) {
  if (!transcript || transcript.length < 100) return 0;

  const domain = detectTranscriptDomain(transcript);

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
      await storeExperience(qa, domain);
      stored++;
    } catch { /* skip */ }
  }
  activityLog({ op: 'extract', mistakes: mistakes.length, stored, project: projectPath || null });
  return stored;
}

// --- Language/context detection ---

const LANG_MAP = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.cs': 'C#', '.fs': 'F#',
  '.py': 'Python', '.rb': 'Ruby',
  '.rs': 'Rust', '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.cpp': 'C++', '.c': 'C',
  '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
  '.xml': 'XML', '.proto': 'Protobuf',
  '.dockerfile': 'Docker', '.tf': 'Terraform',
};

function detectContext(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  const ext = '.' + parts.pop().toLowerCase();
  return LANG_MAP[ext] || null;
}

// Wave 2: Natural language detection for cross-lingual matching
function detectNaturalLang(text) {
  if (!text) return 'en';
  // Vietnamese detection: Latin diacritics + combining marks + Vietnamese-specific block
  const viPattern = /[\u00C0-\u00FF\u0100-\u024F\u0300-\u036F\u1EA0-\u1EFF]/g;
  const viCount = (text.match(viPattern) || []).length;
  return viCount >= 2 ? 'vi' : 'en';
}

// --- Query construction ---

function buildQuery(toolName, toolInput) {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  const context = detectContext(filePath);
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
  if (context) {
    raw = `[${context}] ${raw}`;
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

// --- Brain fallback chain (Wave 1) ---
const BRAIN_FNS = {
  ollama:      brainOllama,
  openai:      brainOpenAI,
  gemini:      brainGemini,
  claude:      brainClaude,
  deepseek:    brainDeepSeek,
  siliconflow: brainOpenAI,   // OpenAI-compatible API
  custom:      brainOpenAI,   // OpenAI-compatible API
};

// Fallback config: primary provider → fallback provider
const BRAIN_FALLBACK = _cfg.brainFallback || process.env.EXPERIENCE_BRAIN_FALLBACK || (BRAIN_PROVIDER === 'ollama' ? '' : 'ollama');

async function callBrainWithFallback(prompt) {
  const primary = BRAIN_FNS[BRAIN_PROVIDER] || BRAIN_FNS.ollama;
  let result = await primary(prompt);
  if (result) return result;
  activityLog({ op: 'brain-failure', provider: BRAIN_PROVIDER, phase: 'primary' });
  if (BRAIN_FALLBACK && BRAIN_FNS[BRAIN_FALLBACK]) {
    result = await BRAIN_FNS[BRAIN_FALLBACK](prompt);
    if (result) {
      activityLog({ op: 'brain-fallback', provider: BRAIN_FALLBACK });
      return result;
    }
    activityLog({ op: 'brain-failure', provider: BRAIN_FALLBACK, phase: 'fallback' });
  }
  return null;
}

async function extractQA(mistake) {
  const prompt = `Given this session excerpt where something went wrong:\n${mistake.excerpt.slice(0, 1500)}\n\nExtract in JSON (no markdown):\n{"trigger":"one line","question":"one line","reasoning":["step1","step2"],"solution":"one line"}`;
  return callBrainWithFallback(prompt);
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

function buildStorePayload(id, qa, domain) {
  // Wave 2: Tag natural language for cross-lingual matching
  const naturalLang = detectNaturalLang(`${qa.trigger} ${qa.solution}`);
  return {
    id, trigger: qa.trigger, question: qa.question,
    reasoning: qa.reasoning || [], solution: qa.solution,
    confidence: 0.5, hitCount: 0, tier: 2,
    lastHitAt: null, ignoreCount: 0,
    confirmedAt: [],  // Phase 108: temporal trace
    domain: domain || null,
    naturalLang,
    createdAt: new Date().toISOString(), createdFrom: 'session-extractor',
  };
}

async function storeExperience(qa, domain) {
  const text = `${qa.trigger} ${qa.question} ${qa.solution}`;
  const vector = await getEmbedding(text);
  if (!vector) return;

  const id = crypto.randomUUID();
  const payload = {
    json: JSON.stringify(buildStorePayload(id, qa, domain))
  };

  if (!(await checkQdrant())) {
    fileStoreUpsert(SELFQA_COLLECTION, id, vector, payload);
  } else {
    await fetch(`${QDRANT_BASE}/collections/${SELFQA_COLLECTION}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
      signal: AbortSignal.timeout(5000),
    });
  }

  // Phase 107: Create relates-to and supersedes edges
  if (vector) {
    try {
      const existing = await getAllEntries(SELFQA_COLLECTION);
      for (const entry of existing) {
        if (entry.id === id) continue;
        if (!entry.vector || entry.vector.length !== vector.length) continue;
        const sim = cosineSimilarity(vector, entry.vector);
        if (sim > DEDUP_THRESHOLD) {
          const d = parsePayload(entry);
          if (d && d.trigger && qa.trigger && d.trigger === qa.trigger) {
            createEdge(id, entry.id, 'supersedes', parseFloat(sim.toFixed(3)), 'store-supersedes');
          }
        }
        if (sim > RELATES_TO_THRESHOLD && sim <= DEDUP_THRESHOLD) {
          createEdge(id, entry.id, 'relates-to', parseFloat(sim.toFixed(3)), 'store-similarity');
        }
      }
    } catch { /* never block store on edge creation */ }
  }
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

async function fetchPointById(collection, pointId) {
  if (!(await checkQdrant())) {
    const entries = fileStoreRead(collection);
    const found = entries.find(e => e.id === pointId);
    return found ? { id: found.id, score: 1.0, payload: found.payload } : null;
  }
  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/${pointId}`, {
      headers: { 'Content-Type': 'application/json', ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}) },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? { id: data.result.id, score: 1.0, payload: data.result.payload } : null;
  } catch { return null; }
}

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

function computeEffectiveScore(point, data, queryDomain) {
  const cosine = point.score || 0;
  const hitBoost = Math.log2(1 + (data.hitCount || 0)) * 0.08;
  const daysSinceHit = data.lastHitAt
    ? (Date.now() - new Date(data.lastHitAt).getTime()) / 86400000
    : 0;
  const recencyPenalty = daysSinceHit > 30
    ? Math.min(0.15, (daysSinceHit - 30) / 335 * 0.15)
    : 0;
  const ignorePenalty = Math.min(0.30, (data.ignoreCount || 0) * 0.05);
  const domainPenalty = (queryDomain && data.domain && queryDomain !== data.domain) ? 0.08
    : (queryDomain && !data.domain) ? 0.03 : 0;
  // Phase 108: temporal boost/penalty from confirmedAt trace
  let temporalAdj = 0;
  const confirmed = Array.isArray(data.confirmedAt) ? data.confirmedAt : [];
  if (confirmed.length > 0) {
    const mostRecent = new Date(confirmed[confirmed.length - 1]).getTime();
    const daysSinceConfirm = (Date.now() - mostRecent) / 86400000;
    if (daysSinceConfirm <= 7) temporalAdj = 0.05;       // recently confirmed — boost
    else if (daysSinceConfirm > 60) temporalAdj = -0.08;  // stale — penalty
  }
  // Phase 108: superseded experience penalty
  const supersededPenalty = data.superseded ? 0.15 : 0;
  // Wave 3: Confidence weighting — low-confidence entries rank lower
  const confWeight = computeEffectiveConfidence(data);
  const rawScore = cosine + hitBoost - recencyPenalty - ignorePenalty - domainPenalty + temporalAdj - supersededPenalty;
  return rawScore * (0.6 + 0.4 * confWeight); // scale: 0.6 floor to avoid zeroing out
}

function rerankByQuality(points, queryDomain) {
  return points
    .map(p => {
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      return { ...p, _effectiveScore: computeEffectiveScore(p, data, queryDomain) };
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
  // Phase 108: temporal trace — append to confirmedAt (cap at 50)
  if (!Array.isArray(data.confirmedAt)) data.confirmedAt = [];
  data.confirmedAt.push(data.lastHitAt);
  if (data.confirmedAt.length > 50) data.confirmedAt = data.confirmedAt.slice(-50);
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

// --- recordFeedback: explicit agent feedback on surfaced suggestions ---

async function recordFeedback(collection, pointId, followed) {
  if (followed === true) {
    // Same logic as recordHit: increment hitCount, reset ignoreCount, append confirmedAt
    if (!(await checkQdrant())) {
      const entries = fileStoreRead(collection);
      const entry = entries.find(e => e.id === pointId);
      if (entry && entry.payload?.json) {
        const data = JSON.parse(entry.payload.json);
        applyHitUpdate(data);
        entry.payload.json = JSON.stringify(data);
        fileStoreWrite(collection, entries);
      }
    } else {
      try {
        const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/${pointId}`, {
          headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const point = (await res.json()).result;
          if (point?.payload?.json) {
            const data = JSON.parse(point.payload.json);
            applyHitUpdate(data);
            await fetch(`${QDRANT_BASE}/collections/${collection}/points/payload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
              body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
              signal: AbortSignal.timeout(5000),
            });
          }
        }
      } catch { /* silent */ }
    }
  } else {
    // followed === false: only increment ignoreCount (do NOT reset it unlike recordHit)
    if (!(await checkQdrant())) {
      const entries = fileStoreRead(collection);
      const entry = entries.find(e => e.id === pointId);
      if (entry && entry.payload?.json) {
        const data = JSON.parse(entry.payload.json);
        incrementIgnoreCountData(data);
        entry.payload.json = JSON.stringify(data);
        fileStoreWrite(collection, entries);
      }
    } else {
      try {
        const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/${pointId}`, {
          headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const point = (await res.json()).result;
          if (point?.payload?.json) {
            const data = JSON.parse(point.payload.json);
            incrementIgnoreCountData(data);
            await fetch(`${QDRANT_BASE}/collections/${collection}/points/payload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
              body: JSON.stringify({ points: [pointId], payload: { json: JSON.stringify(data) } }),
              signal: AbortSignal.timeout(5000),
            });
          }
        }
      } catch { /* silent */ }
    }
  }
  activityLog({ op: 'feedback', collection, pointId: pointId.slice(0, 8), followed });
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

// --- Edge graph (Phase 107) ---

function createEdge(source, target, type, weight = 1.0, createdBy = 'auto') {
  const edge = {
    id: crypto.randomUUID(),
    source, target,
    type, // 'generalizes' | 'contradicts' | 'supersedes' | 'relates-to'
    weight,
    createdAt: new Date().toISOString(),
    createdBy,
  };
  const edges = fileStoreRead(EDGE_COLLECTION);
  const exists = edges.some(e => {
    try {
      const d = JSON.parse(e.payload?.json || '{}');
      return d.source === source && d.target === target && d.type === type;
    } catch { return false; }
  });
  if (exists) return null;
  fileStoreUpsert(EDGE_COLLECTION, edge.id, [], { json: JSON.stringify(edge) });
  upsertEdgeToQdrant(edge).catch(() => {});
  activityLog({ op: 'edge-create', type, source: source.slice(0, 8), target: target.slice(0, 8) });
  return edge;
}

async function upsertEdgeToQdrant(edge) {
  if (!(await checkQdrant())) return;
  try {
    const check = await fetch(`${QDRANT_BASE}/collections/${EDGE_COLLECTION}`, {
      headers: QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!check.ok) {
      await fetch(`${QDRANT_BASE}/collections/${EDGE_COLLECTION}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
        body: JSON.stringify({ vectors: { size: 1, distance: 'Cosine' } }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch { return; }
  await fetch(`${QDRANT_BASE}/collections/${EDGE_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    body: JSON.stringify({ points: [{ id: edge.id, vector: [0], payload: { json: JSON.stringify(edge) } }] }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

function getEdgesForId(experienceId) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && (e.source === experienceId || e.target === experienceId));
}

function getEdgesOfType(type) {
  const edges = fileStoreRead(EDGE_COLLECTION);
  return edges
    .map(e => { try { return JSON.parse(e.payload?.json || '{}'); } catch { return null; } })
    .filter(e => e && e.type === type);
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
    // Wave 1: Minimum 7-day age before promotion — prevent rapid-fire poisoning
    const ageMs = Date.now() - new Date(data.createdAt || 0).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) continue;
    data.tier = 1;
    data.promotedAt = new Date().toISOString();
    const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
    if (!vector) continue;
    await upsertEntry('experience-behavioral', entry.id, vector, data);
    await deleteEntry('experience-selfqa', entry.id);
    results.promoted++;
  }

  // Step 1b: Promote probationary principles T1 -> T0 (Wave 1: principle probation)
  // Principles created by abstraction start at T1; promote to T0 after 3 confirmed hits
  const t1PrincipleEntries = await getAllEntries('experience-behavioral');
  for (const entry of t1PrincipleEntries) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'evolution-abstraction') continue;
    if ((data.hitCount || 0) >= 3) {
      data.tier = 0;
      data.promotedToT0At = new Date().toISOString();
      const vector = entry.vector || await getEmbedding(`${data.principle || data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-principles', entry.id, vector, data);
      await deleteEntry('experience-behavioral', entry.id);
      results.promoted++;
    }
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

    // Wave 3: Structured conditions[] — principle carries preconditions for constraint checking
    const prompt = `Given these ${summaries.length} related experiences, extract ONE general principle covering all cases. Format as JSON: {"principle":"When [condition], always [action] because [reason]","conditions":["keyword1","keyword2","keyword3"]}\nConditions = 2-4 keywords that MUST be present for this principle to apply.\n\n${summaries.join('\n')}`;

    const result = await callBrainWithFallback(prompt);
    if (!result?.principle) continue;

    const vector = await getEmbedding(result.principle);
    if (!vector) continue;

    // Wave 2: Round-trip validation — principle must match ≥60% of source cluster members
    let matchCount = 0;
    for (const e of cluster) {
      if (!e.vector || e.vector.length !== vector.length) continue;
      if (cosineSimilarity(vector, e.vector) >= 0.65) matchCount++;
    }
    if (matchCount / cluster.length < 0.6) {
      activityLog({ op: 'evolve-reject', reason: 'round-trip-fail', matchRate: matchCount / cluster.length, principle: result.principle.slice(0, 80) });
      continue;
    }

    const id = crypto.randomUUID();
    // Wave 1: Principle probation — start at T1 (behavioral), promote to T0 after 3 hits
    await upsertEntry('experience-behavioral', id, vector, {
      id, principle: result.principle, solution: result.principle,
      conditions: Array.isArray(result.conditions) ? result.conditions.slice(0, 4) : [],
      tier: 1, confidence: Math.min(0.80, 0.50 + (cluster.length / 10) * 0.30), hitCount: 0,
      createdAt: new Date().toISOString(), createdFrom: 'evolution-abstraction',
      sourceCount: cluster.length,
    });

    // Phase 107: Create generalizes edges (T2 sources -> T0 principle)
    for (const e of cluster) {
      createEdge(e.id, id, 'generalizes', 1.0, 'evolve-abstraction');
    }

    // Delete source entries from T2
    for (const e of cluster) {
      await deleteEntry('experience-selfqa', e.id);
    }
    results.abstracted++;
  }

  // Step 2b: Demote T0 -> T2 on contradiction (Wave 2: principle rollback)
  const t0Entries = await getAllEntries('experience-principles');
  for (const entry of t0Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = (data.ignoreCount || 0) >= 5
      || (data.contradiction && (data.contradictionCount || 1) >= 2);
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.3);
      data.demotedFromT0At = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction' : 'ignored';
      createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-t0-demotion');
      const vector = entry.vector || await getEmbedding(`${data.principle || data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-principles', entry.id);
      results.demoted++;
      activityLog({ op: 'evolve-t0-demote', id: entry.id.slice(0, 8), reason: data.demoteReason });
    }
  }

  // Step 3: Demote T1 -> T2 (per D-06)
  // Demotion triggers:
  //   - ignoreCount >= 3: agent repeatedly ignores this suggestion (tracked by NOISE-04)
  //   - confidence decayed below MIN_CONFIDENCE after aging
  //   - contradiction flag set externally (future: user override)
  const t1Entries = await getAllEntries('experience-behavioral');
  for (const entry of t1Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = data.contradiction
      || (data.ignoreCount || 0) >= 3
      || computeEffectiveConfidence(data) < MIN_CONFIDENCE;
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.2);
      data.demotedAt = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction'
        : (data.ignoreCount || 0) >= 3 ? 'ignored'
        : 'confidence_decay';
      // Phase 107: Create contradicts edge on demotion
      if (data.demoteReason === 'contradiction' || data.demoteReason === 'ignored') {
        createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-demotion');
      }
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

  // Step 4b: TTL cleanup for bulk-seeded T1 entries (60-day expiry if no organic confirmation)
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  const t1All = await getAllEntries('experience-behavioral');
  for (const entry of t1All) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'bulk-seed') continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age <= SIXTY_DAYS) continue;
    // No organic confirmations = confirmedAt is empty or missing
    const hasOrganic = Array.isArray(data.confirmedAt) && data.confirmedAt.length > 0;
    if (!hasOrganic) {
      await deleteEntry('experience-behavioral', entry.id);
      results.archived++;
      activityLog({ op: 'evolve-seed-ttl', id: entry.id.slice(0, 8), age: Math.round(age / (24 * 60 * 60 * 1000)) });
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
  // Greedy clustering with centroid outlier rejection (Wave 2)
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
    // Wave 2: Centroid outlier rejection — compute centroid, reject members < 0.75 vs centroid
    if (cluster.length >= 3) {
      const dim = cluster[0].vector.length;
      const centroid = new Array(dim).fill(0);
      for (const e of cluster) {
        for (let d = 0; d < dim; d++) centroid[d] += e.vector[d];
      }
      for (let d = 0; d < dim; d++) centroid[d] /= cluster.length;
      const filtered = cluster.filter(e => cosineSimilarity(e.vector, centroid) >= 0.75);
      clusters.push(filtered.length >= 3 ? filtered : cluster); // keep original if filtering drops below 3
    } else {
      clusters.push(cluster);
    }
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

// --- Phase 109: Share/Import principles ---

function sharePrinciple(principleId) {
  const entries = fileStoreRead('experience-principles');
  const entry = entries.find(e => e.id === principleId);
  if (!entry) return null;
  const data = parsePayload(entry);
  if (!data) return null;
  return {
    principle: data.principle || data.solution,
    solution: data.solution,
    confidence: data.confidence,
    domain: data.domain || null,
    sharedAt: new Date().toISOString(),
    sharedBy: EXP_USER,
  };
}

async function importPrinciple(shared) {
  if (!shared?.solution) return null;
  const vector = await getEmbedding(shared.solution);
  if (!vector) return null;
  const id = crypto.randomUUID();
  const payload = {
    id, principle: shared.principle || shared.solution, solution: shared.solution,
    tier: 0, confidence: Math.min(shared.confidence || 0.7, 0.8), // imported = slightly lower confidence
    hitCount: 0, confirmedAt: [],
    domain: shared.domain || null,
    createdAt: new Date().toISOString(), createdFrom: 'imported',
    importedFrom: shared.sharedBy || 'unknown',
  };
  await upsertEntry('experience-principles', id, vector, payload);
  activityLog({ op: 'principle-import', id: id.slice(0, 8), from: shared.sharedBy || 'unknown' });
  return { id, principle: payload.principle };
}

// --- getEmbeddingRaw: exported for external callers (e.g. bulk-seed.js) (D-16) ---

async function getEmbeddingRaw(text, signal) {
  return getEmbedding(text, signal);
}

// --- Exports ---

module.exports = { intercept, interceptWithMeta, recordFeedback, extractFromSession, recordHit, syncToQdrant, evolve, getEmbeddingRaw, searchCollection, deleteEntry, createEdge, getEdgesForId, getEdgesOfType, EDGE_COLLECTION, sharePrinciple, importPrinciple, EXP_USER, _activityLog: activityLog, _detectContext: detectContext, _buildQuery: buildQuery, _computeEffectiveScore: computeEffectiveScore, _computeEffectiveConfidence: computeEffectiveConfidence, _rerankByQuality: rerankByQuality, _formatPoints: formatPoints, _storeExperiencePayload: (qa) => buildStorePayload(require('crypto').randomUUID(), qa, null), _recordHitUpdatesFields: applyHitUpdate, _trackSuggestions: trackSuggestions, _suggestionHistory, _incrementIgnoreCountData: incrementIgnoreCountData, _detectTranscriptDomain: detectTranscriptDomain, _detectNaturalLang: detectNaturalLang, _callBrainWithFallback: callBrainWithFallback };
