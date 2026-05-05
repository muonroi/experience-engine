/**
 * brain-llm.js — LLM provider interface for Experience Engine.
 * Extracted from experience-core.js. Depends on config and embedding modules.
 */
'use strict';

const _config = require('./config');
const { estimateTextUnits, logCostCall } = require('./embedding');

const cfgValue = _config.cfgValue;
const getBrainProvider = _config.getBrainProvider;
const getBrainModel = _config.getBrainModel;
const getBrainEndpoint = _config.getBrainEndpoint;
const getBrainKey = _config.getBrainKey;
const getOllamaGenerateUrl = _config.getOllamaGenerateUrl;
const activityLog = _config.activityLog;

// ============================================================
//  Brain — LLM provider abstraction
// ============================================================

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
function getBrainFallback() {
  return cfgValue('brainFallback', 'EXPERIENCE_BRAIN_FALLBACK', getBrainProvider() === 'ollama' ? '' : 'ollama');
}

async function callBrainWithFallback(prompt, meta = {}) {
  const brainProvider = getBrainProvider();
  const fallbackProvider = getBrainFallback();
  const primary = BRAIN_FNS[brainProvider] || BRAIN_FNS.ollama;
  const units = estimateTextUnits(prompt, 4000);

  // Allow callers (e.g. route-task) to enforce tighter time budgets than the default 15s.
  const timeoutMs = Number(meta.timeoutMs ?? 0);
  const signal = meta.signal || (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

  let startedAt = Date.now();
  let result = await primary(prompt, { signal });
  logCostCall('brain', brainProvider, meta.source || 'general', units, {
    ok: !!result,
    phase: 'primary',
    durationMs: Date.now() - startedAt,
  });
  if (result) return result;

  activityLog({ op: 'brain-failure', provider: brainProvider, phase: 'primary' });
  if (fallbackProvider && BRAIN_FNS[fallbackProvider]) {
    startedAt = Date.now();
    result = await BRAIN_FNS[fallbackProvider](prompt, { signal });
    logCostCall('brain', fallbackProvider, meta.source || 'general', units, {
      ok: !!result,
      phase: 'fallback',
      durationMs: Date.now() - startedAt,
    });
    if (result) {
      activityLog({ op: 'brain-fallback', provider: fallbackProvider });
      return result;
    }
    activityLog({ op: 'brain-failure', provider: fallbackProvider, phase: 'fallback' });
  }
  return null;
}

// P6: Brain relevance filter — lightweight brain call to check if suggestions match the action
// Input: the action query + numbered warnings. Output: which numbers are relevant.
// Timeout: 3s (tight — fail-open if brain is slow). Cost: ~80 tokens input, ~5 tokens output.
async function brainRelevanceFilter(actionQuery, suggestionLines, signal, projectSlug) {
  if (!suggestionLines || suggestionLines.length === 0) return null;
  const hasClearHighConfidenceWarning = suggestionLines.some(line => /Experience - High Confidence \(([-\d.]+)\)/.test(line));

  const warnings = suggestionLines.map((line, i) => {
    const clean = line.replace(/^.*?\]:\s*/, '');
    return `${i + 1}. ${clean}`;
  });

  const projectCtx = projectSlug ? `\nPROJECT: ${projectSlug} — warnings about OTHER projects are NOT relevant.` : '';
  const prompt = `You are a relevance filter. An AI coding agent is about to perform this action:\n\nACTION: ${actionQuery.slice(0, 300)}${projectCtx}\n\nThese warnings were retrieved from past experience:\n${warnings.join('\n')}\n\nWhich warnings could help prevent a mistake in THIS SPECIFIC action?\nRules:\n- A warning is relevant ONLY if the action could actually trigger the mistake the warning describes\n- Generic advice that doesn't match the specific action is NOT relevant\n- Warnings about a DIFFERENT project/codebase than the current one are NOT relevant\n- "ls", "git log", "cat" commands reading files NEVER need warnings about code patterns\n\nReply with ONLY the relevant warning numbers separated by commas (e.g. "1,3"), or "none" if none are relevant.`;

  try {
    const brainProvider = getBrainProvider();
    const units = estimateTextUnits(prompt, 4000);
    const startedAt = Date.now();
    let response;

    if (brainProvider === 'ollama') {
      const res = await fetch(getOllamaGenerateUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: getBrainModel(), prompt, stream: false, options: { temperature: 0.1, num_predict: 20 } }),
        signal: signal || AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        logCostCall('brain', brainProvider, 'brain-filter', units, { ok: false, durationMs: Date.now() - startedAt });
        return null;
      }
      response = (await res.json()).response || '';
    } else {
      const endpoint = getBrainEndpoint() || 'https://api.openai.com/v1/chat/completions';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
        body: JSON.stringify({ model: getBrainModel(), messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 20 }),
        signal: signal || AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        logCostCall('brain', brainProvider, 'brain-filter', units, { ok: false, durationMs: Date.now() - startedAt });
        return null;
      }
      response = (await res.json()).choices?.[0]?.message?.content || '';
    }

    logCostCall('brain', brainProvider, 'brain-filter', units, { ok: true, durationMs: Date.now() - startedAt });

    const text = response.trim().toLowerCase();
    if (text === 'none' || text === '0' || text === '') {
      return hasClearHighConfidenceWarning ? null : [];
    }

    const nums = text.match(/\d+/g);
    if (!nums) return null;
    const validIndices = nums.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < suggestionLines.length);
    if (validIndices.length === 0) {
      return hasClearHighConfidenceWarning ? null : [];
    }
    return validIndices.map(i => suggestionLines[i]);
  } catch {
    return null;
  }
}

async function extractQA(mistake) {
  const prompt = `Given this session excerpt where something went wrong:\n${mistake.excerpt.slice(0, 1500)}\n\nExtract ONE reusable lesson as JSON (no markdown).\nRules:\n- trigger must be a concrete condition rooted in the excerpt, never placeholders like "when this fires"\n- question must briefly name the mistake being prevented\n- solution must be a concrete preventive action, never placeholders like "what to do"\n- failureMode must name the underlying class of failure, not the literal log line\n- judgment must express the portable preventive judgment, not just a one-off fix\n- conditions must be 2-4 short applicability keywords\n- evidenceClass must be one of: log, test, runtime, review, user-correction, other\n- if the excerpt is mainly about workflow management, lock artifacts, planning scope, deploy checklist, or AI execution process rather than a reusable coding/runtime mistake, return {"skip":true,"reason":"meta_workflow"}\n- if there is no concrete reusable lesson, return {"skip":true,"reason":"no_reusable_lesson"}\n\nReturn JSON only:\n{"trigger":"specific trigger from the excerpt","question":"brief mistake description","reasoning":["step1","step2"],"solution":"specific preventive action","why":"root cause or incident that created this rule","failureMode":"underlying failure family","judgment":"portable preventive judgment","conditions":["keyword1","keyword2"],"evidenceClass":"log|test|runtime|review|user-correction|other","scope":{"lang":"C#|JavaScript|all","repos":[],"filePattern":"*.cs"}}`;
  return callBrainWithFallback(prompt, { source: 'extract' });
}

async function brainOllama(prompt, opts = {}) {
  try {
    const res = await fetch(getOllamaGenerateUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getBrainModel(), prompt, stream: false, options: { temperature: 0.3 } }),
      signal: opts.signal || AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    const m = (await res.json()).response?.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainOpenAI(prompt, opts = {}) {
  // Reused for any OpenAI-compatible API (OpenAI, SiliconFlow, Together, Groq, etc.)
  const endpoint = getBrainEndpoint() || 'https://api.openai.com/v1/chat/completions';
  const body = { model: getBrainModel() || 'gpt-4o-mini', messages: [{ role:'user', content: prompt }], temperature: 0.3 };
  // Only add json_object mode for known-supporting providers (OpenAI, DeepSeek)
  if (endpoint.includes('openai.com') || endpoint.includes('deepseek.com')) {
    body.response_format = { type: 'json_object' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify(body),
      signal: opts.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    // Try direct parse, fallback to regex extract
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainGemini(prompt, opts = {}) {
  try {
    const model = getBrainModel() || 'gemini-2.0-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getBrainKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
      signal: opts.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch { return null; }
}

async function brainClaude(prompt, opts = {}) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': getBrainKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: getBrainModel() || 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role:'user', content: prompt }] }),
      signal: opts.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).content?.[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function brainDeepSeek(prompt, opts = {}) {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify({ model: getBrainModel() || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
      signal: opts.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
  } catch { return null; }
}

// ============================================================
//  Exports
// ============================================================

module.exports = {
  BRAIN_FNS,
  getBrainFallback,
  callBrainWithFallback,
  brainRelevanceFilter,
  extractQA,
  brainOllama,
  brainOpenAI,
  brainGemini,
  brainClaude,
  brainDeepSeek,
};
