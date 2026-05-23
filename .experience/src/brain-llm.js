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
  const prompt = `You are an experience-hint relevance filter for an AI coding agent.

ACTION the agent is about to take:
  ${actionQuery.slice(0, 300)}${projectCtx}

Past experience hints retrieved from the brain:
${warnings.join('\n')}

Each hint has: what it advises (solution), WHEN it fires (trigger/conditions), and WHY (root cause).

Task: select which hints COULD help the agent avoid a mistake or follow a better pattern for THIS action.

Selection criteria:
- A hint is relevant if the action involves the SAME TOOL, COMMAND TYPE, or FILE PATTERN described in the hint's "Fires when" line
- A hint about "tail" output is relevant when the action pipes to "tail"
- A hint about "ssh" or "heredoc" is relevant when the action uses ssh
- A hint about "dotnet build" is relevant when building .NET projects
- A hint about test patterns is relevant when running tests
- When unsure, INCLUDE the hint — false negatives (missing a useful warning) are worse than false positives (showing an extra hint)
- Only reject hints that are clearly about a COMPLETELY DIFFERENT operation (e.g., a database hint when the action is git-only)

Reply with the relevant warning numbers separated by commas (e.g. "1,3"), or "none" ONLY if you are confident NO hint relates to this action.`;

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
        body: JSON.stringify({ model: getBrainModel(), messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 120 }),
        signal: signal || AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        logCostCall('brain', brainProvider, 'brain-filter', units, { ok: false, durationMs: Date.now() - startedAt });
        return null;
      }
      const brainJson = await res.json(); response = brainJson.choices?.[0]?.message?.content || brainJson.choices?.[0]?.message?.reasoning_content?.slice(-50) || '';
    }

    logCostCall('brain', brainProvider, 'brain-filter', units, { ok: true, durationMs: Date.now() - startedAt });

    const text = response.trim().toLowerCase();
    if (text === 'none' || text === '0' || text === '') {
      // Safe default: when brain says "none", KEEP all hints (return null)
      // rather than deleting them (return []). The vector search + scope
      // filter already selected relevant entries — brain filter should only
      // remove clearly wrong hits, not act as a second rejection gate.
      return null;
    }

    const nums = text.match(/\d+/g);
    if (!nums) return null;
    const validIndices = nums.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < suggestionLines.length);
    if (validIndices.length === 0) {
      return null; // keep all hints when brain response is ambiguous
    }
    return validIndices.map(i => suggestionLines[i]);
  } catch {
    return null;
  }
}

async function extractQA(experience, opts = {}) {
  const { summarizeExperienceExcerpt } = require('./context');
  const summary = summarizeExperienceExcerpt(experience) || String(experience?.excerpt || '').slice(0, 1500);
  const expType = experience?.type || 'unknown';

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

  const TYPE_INSTRUCTIONS = {
    recipe: `You are extracting a REUSABLE RECIPE — a successful multi-step pattern that another agent session should follow when facing a similar task. Focus on the SEQUENCE of steps, not the specific files.
- trigger: describe WHEN this recipe applies (e.g. "adding a new service class in an Angular + .NET project")
- question: what task does this recipe solve?
- solution: the step-by-step recipe (numbered steps, each concrete and actionable)
- failureMode: "none" (this is a success pattern)
- judgment: the portable principle (e.g. "always register new services in ServiceRegistration.cs after creating them")`,

    trap: `You are extracting a TRAP — something that looks right but fails, and what actually works. The agent tried the same operation, failed, then succeeded with a different approach.
- trigger: describe the situation that triggers the trap (e.g. "editing a file without reading it first in Claude Code")
- question: what trap did the agent fall into?
- solution: what to do INSTEAD to avoid the trap
- failureMode: the class of mistake (e.g. "stale_context", "wrong_tool_for_platform")
- judgment: the portable rule (e.g. "always Read a file before Edit, even after Grep")`,

    dependency: `You are extracting a hidden DEPENDENCY — editing file A broke file B, requiring a fix to B. This is about cross-file coupling that is not obvious.
- trigger: describe what change triggers the dependency (e.g. "adding a new exported type to a module")
- question: what hidden dependency exists?
- solution: what files must be updated together
- failureMode: "hidden_coupling"
- judgment: the portable rule about what must change together`,

    env_trap: `You are extracting an ENVIRONMENTAL TRAP — an OS/tool/platform error and its workaround. NOT a code logic bug.
- trigger: describe the environment condition (e.g. "running TypeScript check via Bash shell on Windows")
- question: what environmental trap exists?
- solution: the workaround or correct approach
- failureMode: "platform_mismatch" or "tool_limitation"
- judgment: the portable rule for the platform`,

    user_correction: `You are extracting a USER PREFERENCE — the user corrected the agent's approach. This captures what the user wants done differently.
- trigger: describe what the agent did that the user corrected
- question: what did the user want differently?
- solution: the corrected approach
- failureMode: "assumption_mismatch"
- judgment: the portable preference rule`,
  };

  const typeInstr = TYPE_INSTRUCTIONS[expType] || TYPE_INSTRUCTIONS.trap;

  const evidence = experience?.evidence || {};
  const hasEvidence = Object.keys(evidence).length > 0;
  console.log(`[brain-llm] extractQA evidence: hasEvidence=${hasEvidence} keys=${Object.keys(evidence).join(',') || 'none'}`);
  const evidenceBlock = hasEvidence
    ? `\nEVIDENCE (hard facts extracted from the session — use these to build conditions):\n${JSON.stringify(evidence, null, 2)}\n`
    : '';

  const prompt = `${typeInstr}\n\nThe summary below has been pre-labelled as type "${expType}".\n\n${summary}\n${ctxBlock}${evidenceBlock}\nReturn JSON only (no markdown). Output a generalized PATTERN, not the literal log line.\n\nMandatory rules:\n- trigger MUST describe the PATTERN. NEVER copy a ToolCall/ToolOutput/Bash line verbatim. NEVER start with a path or filename.\n- question briefly names the experience (one sentence).\n- solution is a concrete preventive/reusable action — not "implement", "review", "debug" alone.\n- why captures the root cause or rationale.\n- judgment is the portable reusable judgment ("X must Y because Z"), reusable across files.\n- conditions: a structured object describing WHEN this hint should fire. Build from the EVIDENCE above — do NOT invent patterns not present in evidence. Format: {"filePattern":["glob patterns"],"toolMatch":["Edit","Bash"],"commandMatch":["substrings"],"codePattern":["patterns in code being edited"],"errorMatch":["error type or message substring"]}. Include only fields with actual values from evidence. If no evidence, use {"keywords":["2-4 retrieval terms"]}.\n- evidenceClass: one of log | test | runtime | review | user-correction | recipe.\n- category: one of "code" | "git" | "deploy" | "infra" | "security" | "review-meta" | "testing-meta" | "shell-meta".\n- scope.lang must be one of: C# | JavaScript | TypeScript | Python | Go | Rust | Java | Shell | all.\n${frameworkRule}\n- Skip when nothing portable can be extracted:\n  - {"skip":true,"reason":"meta_workflow"}\n  - {"skip":true,"reason":"no_reusable_lesson"}\n  - {"skip":true,"reason":"raw_log_only"}\n\nReturn exactly:\n{"trigger":"...","question":"...","reasoning":["step1","step2"],"solution":"...","why":"...","failureMode":"...","judgment":"...","conditions":{},"evidenceClass":"...","category":"...","scope":{"lang":"all","framework":"any","repos":[],"filePattern":"*"}}`;
  const result = await callBrainWithFallback(prompt, { source: 'extract' });
  // Post-process: hard-set scope fields from caller context where available.
  // For "code" category, caller-derived hints (from on-disk markers) are
  // authoritative. For cross-stack categories (git/deploy/infra/security/
  // review-meta/testing-meta/shell-meta) we OVERRIDE to wildcard scope so
  // a git mistake recorded while editing TS files still surfaces when the
  // user later does git work from a C# project.
  if (result && !result.skip) {
    if (!result.scope || typeof result.scope !== 'object') result.scope = {};

    // Category detection: brain first, regex fallback when brain omits.
    // Regex is intentionally narrow — only catches signatures the brain
    // tends to miss (mistake summarized as a code change but the underlying
    // pattern is git/deploy/security).
    const CROSS_STACK_CATS = new Set(['git', 'deploy', 'infra', 'security', 'review-meta', 'testing-meta', 'shell-meta']);
    let category = typeof result.category === 'string' ? result.category.toLowerCase().trim() : '';
    if (!CROSS_STACK_CATS.has(category) && category !== 'code') {
      category = _inferCrossStackCategory(result) || 'code';
    }
    result.category = category;
    const isCrossStack = CROSS_STACK_CATS.has(category);

    if (isCrossStack) {
      // Cross-stack lesson — wildcard framework but keep caller lang + slug.
      // A "bash path error on Windows" is cross-framework but still scoped
      // to the language ecosystem where it was observed.
      result.scope.framework = 'any';
      if (callerLang) result.scope.lang = callerLang;
      else result.scope.lang = 'all';
      if (callerSlug) result.scope.project_slug = callerSlug;
    } else {
      // Code mistake — caller meta authoritative.
      if (callerFw) {
        result.scope.framework = callerFw;
      } else if (typeof result.scope.framework !== 'string' || !result.scope.framework.trim()) {
        result.scope.framework = 'any';
      }
      if (callerLang) {
        result.scope.lang = callerLang;
      } else if (typeof result.scope.lang !== 'string' || !result.scope.lang.trim()) {
        result.scope.lang = 'all';
      }
      if (callerSlug) result.scope.project_slug = callerSlug;
    }

    // Post-process conditions: if LLM returned array (DeepSeek ignores
    // structured format), build structured conditions FROM evidence.
    // Evidence is authoritative — LLM keywords are fallback only.
    const condIsArray = Array.isArray(result.conditions);
    const condMissing = !result.conditions || typeof result.conditions !== 'object';
    console.log(`[brain-llm] conditions post-process: isArray=${condIsArray} missing=${condMissing} evidenceKeys=${Object.keys(evidence).join(',') || 'none'}`);
    if (condIsArray || condMissing) {
      const ev = evidence;
      const structured = {};
      if (ev.file_patterns?.length) structured.filePattern = ev.file_patterns;
      else if (ev.files_touched?.length) structured.filePattern = ev.files_touched.map(f => {
        const parts = f.replace(/\\/g, '/').split('/');
        return parts.length > 1 ? parts[parts.length - 2] + '/' + parts[parts.length - 1] : f;
      });
      if (ev.tools_used?.length) structured.toolMatch = ev.tools_used;
      if (ev.commands_run?.length) structured.commandMatch = ev.commands_run.map(c => {
        const parts = c.split(/\s+/);
        return parts[0] || c;
      });
      if (ev.error_info?.type) structured.errorMatch = [ev.error_info.type, ev.error_info.message].filter(Boolean);
      if (ev.failed_approach?.name) {
        if (!structured.commandMatch) structured.commandMatch = [];
        structured.commandMatch.push(ev.failed_approach.name);
      }
      if (ev.user_said) structured.userSaid = ev.user_said;
      if (Object.keys(structured).length > 0) {
        result.conditions = structured;
      } else if (Array.isArray(result.conditions)) {
        result.conditions = { keywords: result.conditions.filter(k => k && k.length > 2) };
      }
    }
  }
  return result;
}

// Regex fallback for cross-stack category inference. Only fires when the
// brain didn't return a valid category. Narrow patterns by design — we want
// false negatives (default to "code") over false positives that lock
// legitimate code lessons to wildcard scope.
function _inferCrossStackCategory(qa) {
  const text = `${qa?.trigger || ''} ${qa?.solution || ''} ${qa?.why || ''} ${qa?.failureMode || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/\bgit\s+(push|pull|reset|rebase|merge|stash|cherry-pick|reflog|commit|branch|checkout|revert|tag)\b/.test(text)) return 'git';
  if (/\b(force[- ]push|force push|lost commits|detached head|merge conflict)\b/.test(text)) return 'git';
  if (/\b(kubectl|kubernetes|k8s|helm chart|docker build|dockerfile|docker[- ]compose|rollout|canary release|blue[- ]green|ci\/cd|pipeline yaml|github actions|gitlab ci|jenkins pipeline)\b/.test(text)) return 'deploy';
  if (/\b(terraform|cloudformation|pulumi|ansible|nginx config)\b/.test(text)) return 'infra';
  if (/\b(hardcoded secret|secret in code|env(ironment)? var leak|sql injection|xss|csrf|missing auth|unsanitized input|cors misconfiguration)\b/.test(text)) return 'security';
  if (/\b(test pyramid|tdd discipline|fixture lifecycle|test isolation|flaky test pattern|mocking strategy)\b/.test(text)) return 'testing-meta';
  if (/\b(posix vs bash|bashism|word splitting|unquoted variable|set[ -]e pitfall)\b/.test(text)) return 'shell-meta';
  if (/\b(code review process|pr review checklist|review approval)\b/.test(text)) return 'review-meta';
  return null;
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
  if (endpoint.includes('openai.com') || endpoint.includes('deepseek.com') || endpoint.includes('freemodel.dev')) {
    body.response_format = { type: 'json_object' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify(body),
      signal: opts.signal || AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[brain-openai] HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.error(`[brain-openai] ${err?.message}`);
    return null;
  }
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
    const endpoint = getBrainEndpoint() || 'https://api.deepseek.com/chat/completions';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getBrainKey()}` },
      body: JSON.stringify({ model: opts.model || getBrainModel() || 'deepseek-chat', messages: [{ role:'user', content: prompt }], temperature: 0.3, response_format: { type:'json_object' } }),
      signal: opts.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[brain-deepseek] HTTP ${res.status} ${res.statusText} from ${endpoint} body=${errBody.slice(0, 500)}`);
      return null;
    }
    const dsResp = await res.json();
    const dsMsg = dsResp.choices?.[0]?.message || {};
    const text = dsMsg.content || '{}';
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.error(`[brain-deepseek] error: ${err?.message}`);
    return null;
  }
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
