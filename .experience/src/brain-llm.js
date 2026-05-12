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
const getBrainModelForSource = _config.getBrainModelForSource;
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

  // Source-aware model selection: extract+evolve get the larger pattern-abstraction
  // model; intercept-filter/judge/route stay on the cheaper hot-path model.
  const source = meta.source || 'general';
  const model = getBrainModelForSource(source);

  // Allow callers (e.g. route-task) to enforce tighter time budgets than the default 15s.
  const timeoutMs = Number(meta.timeoutMs ?? 0);
  const signal = meta.signal || (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

  let startedAt = Date.now();
  let result = await primary(prompt, { signal, model });
  logCostCall('brain', brainProvider, source, units, {
    ok: !!result,
    phase: 'primary',
    model,
    durationMs: Date.now() - startedAt,
  });
  if (result) return result;

  activityLog({ op: 'brain-failure', provider: brainProvider, phase: 'primary', model });
  if (fallbackProvider && BRAIN_FNS[fallbackProvider]) {
    startedAt = Date.now();
    result = await BRAIN_FNS[fallbackProvider](prompt, { signal, model });
    logCostCall('brain', fallbackProvider, source, units, {
      ok: !!result,
      phase: 'fallback',
      model,
      durationMs: Date.now() - startedAt,
    });
    if (result) {
      activityLog({ op: 'brain-fallback', provider: fallbackProvider, model });
      return result;
    }
    activityLog({ op: 'brain-failure', provider: fallbackProvider, phase: 'fallback', model });
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

async function extractQA(mistake, opts = {}) {
  // Lazy require to avoid circular deps (context.js imports utils which is fine,
  // but brain-llm sits next to context and we don't want a top-level loop).
  const { summarizeMistakeExcerpt } = require('./context');
  const summary = summarizeMistakeExcerpt(mistake) || String(mistake?.excerpt || '').slice(0, 1500);

  // Caller-supplied project context. Drives the 3-axis taxonomy:
  //   - scope.lang        — universal language rules
  //   - scope.framework   — framework/library-specific rules (use 'any' if generic)
  //   - _projectSlug      — set elsewhere from projectPath
  const callerFw = typeof opts.framework === 'string' && opts.framework.trim()
    ? opts.framework.trim() : null;
  const callerLang = typeof opts.lang === 'string' && opts.lang.trim()
    ? opts.lang.trim() : null;
  const callerSlug = typeof opts.projectSlug === 'string' && opts.projectSlug.trim()
    ? opts.projectSlug.trim() : null;

  const ctxLines = [];
  if (callerLang) ctxLines.push(`Caller language: ${callerLang}`);
  if (callerFw) ctxLines.push(`Caller framework/library: ${callerFw}`);
  if (callerSlug) ctxLines.push(`Caller project: ${callerSlug}`);
  const ctxBlock = ctxLines.length
    ? `\nProject context (use this to set scope.framework correctly):\n${ctxLines.map(l => '  - ' + l).join('\n')}\n`
    : '';

  const frameworkRule = callerFw
    ? `- scope.framework must be either "any" or "${callerFw}". Use "${callerFw}" ONLY if the lesson references identifiers, types, packages, or conventions tied to that framework (e.g. types from its packages, attributes from its API). Use "any" when the lesson is a plain language rule that would apply to any project using the same language.`
    : `- scope.framework must be "any" when the lesson is not tied to a specific framework. Set a specific framework label only if the lesson explicitly mentions framework-bound identifiers/packages.`;

  const prompt = `You are extracting ONE reusable lesson from a coding agent's failure. The summary below has already been pre-labelled.\n\n${summary}\n${ctxBlock}\nReturn JSON only (no markdown). Output a generalized PATTERN, not the literal log line.\n\nMandatory rules:\n- trigger MUST describe the failure PATTERN in the agent's own words. NEVER copy a ToolCall/ToolOutput/Bash line verbatim. NEVER start trigger with a path or filename. Bad: "ToolCall read_text_file: /mnt/d/.../config.json". Good: "config file read returns truncated content when output buffer is small".\n- question briefly names the mistake (one sentence).\n- solution is a concrete preventive action that another session would actually do — not "implement", "review", "debug" alone.\n- failureMode is the underlying class (e.g. "missing_validation", "wrong_lifetime_scope", "race_condition"), not the literal log.\n- why captures the root cause; evidence/symptoms go here, not in trigger.\n- judgment is the portable preventive judgment ("X must Y because Z"), reusable across files.\n- conditions: 2-4 short keywords for retrieval.\n- evidenceClass: one of log | test | runtime | review | user-correction | other.\n- scope.lang must be one of: C# | JavaScript | TypeScript | Python | Go | Rust | Java | Shell | all. Use "all" when the lesson is language-agnostic.\n${frameworkRule}\n- Skip when nothing portable can be extracted:\n  - {"skip":true,"reason":"meta_workflow"} if the excerpt is workflow/scope/lock/deploy plumbing\n  - {"skip":true,"reason":"no_reusable_lesson"} if there is no clear failure pattern\n  - {"skip":true,"reason":"raw_log_only"} if the only signal is a tool call header with no diagnosable cause\n\nReturn exactly:\n{"trigger":"...","question":"...","reasoning":["step1","step2"],"solution":"...","why":"...","failureMode":"...","judgment":"...","conditions":["k1","k2"],"evidenceClass":"log|test|runtime|review|user-correction|other","scope":{"lang":"all","framework":"any","repos":[],"filePattern":"*"}}`;
  const result = await callBrainWithFallback(prompt, { source: 'extract' });
  // Post-process: if brain forgot to set framework, default to 'any'. If brain
  // returned an unexpected framework value AND a caller hint was supplied,
  // narrow it to {'any', callerFw} to prevent the model inventing labels.
  if (result && !result.skip && result.scope && typeof result.scope === 'object') {
    if (typeof result.scope.framework !== 'string' || !result.scope.framework.trim()) {
      result.scope.framework = 'any';
    } else if (callerFw) {
      const fw = result.scope.framework.toLowerCase().trim();
      if (fw !== 'any' && fw !== callerFw.toLowerCase()) {
        result.scope.framework = 'any';
      }
    }
  }
  return result;
}

async function brainOllama(prompt, opts = {}) {
  const model = opts.model || getBrainModel();
  try {
    const res = await fetch(getOllamaGenerateUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3 } }),
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
  const model = opts.model || getBrainModel() || 'gpt-4o-mini';
  const body = { model, messages: [{ role:'user', content: prompt }], temperature: 0.3 };
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
    const model = opts.model || getBrainModel() || 'gemini-2.0-flash';
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
      body: JSON.stringify({ model: opts.model || getBrainModel() || 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role:'user', content: prompt }] }),
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
      body: JSON.stringify({ model: opts.model || getBrainModel() || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
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
