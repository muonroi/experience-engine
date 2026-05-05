/**
 * context.js — Context detection, transcript parsing, mistake detection.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const { detectContext, extractPathFromCommand } = require('./utils');
const { QUERY_MAX_CHARS } = require('./config');

// ============================================================
//  Transcript domain detection
// ============================================================

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

// ============================================================
//  Placeholder field detection
// ============================================================

const PLACEHOLDER_EXTRACT_FIELDS = {
  trigger: new Set([
    'when this fires',
    'when this happens',
    'if this happens',
    'when it fires',
    'when it happens',
  ]),
  question: new Set([
    'one line',
    'one-line',
    'one line question',
  ]),
  solution: new Set([
    'what to do',
    'fix it',
    'do the fix',
    'apply a fix',
  ]),
};

function normalizeExtractText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isPlaceholderExtractField(field, value) {
  const normalized = normalizeExtractText(value);
  if (!normalized) return false;
  const placeholders = PLACEHOLDER_EXTRACT_FIELDS[field];
  return !!placeholders && placeholders.has(normalized);
}

function isMetaWorkflowExtract(qa) {
  if (!qa || typeof qa !== 'object') return false;
  const trigger = normalizeExtractText(qa.trigger);
  const question = normalizeExtractText(qa.question);
  const solution = normalizeExtractText(qa.solution);
  const why = normalizeExtractText(qa.why);
  const combined = [trigger, question, solution, why].filter(Boolean).join(' ');

  if (!combined) return false;
  if (/^(narrow )?locked scope\b/.test(trigger)) return true;
  if (/\brisk of unintended scope expansion\b/.test(question)) return true;
  if (/\bstrictly adhere to the locked scope\b/.test(solution)) return true;

  return /\b(qc-lock|qc-flow|artifact locking|scope expansion|protected boundaries|affected area|phase purpose|covers requirements|execution mode|relock)\b/.test(combined)
    || (/\blocked scope\b/.test(combined) && /\b(related tests|deploy|verify|artifact)\b/.test(combined));
}

function assessExtractedQaQuality(qa) {
  if (!qa || typeof qa !== 'object') return { ok: false, reason: 'missing_qa' };
  const trigger = normalizeExtractText(qa.trigger);
  const question = normalizeExtractText(qa.question);
  const solution = normalizeExtractText(qa.solution);

  if (!trigger || !solution) return { ok: false, reason: 'missing_required' };
  if (isPlaceholderExtractField('trigger', trigger)) return { ok: false, reason: 'placeholder_trigger' };
  if (isPlaceholderExtractField('question', question)) return { ok: false, reason: 'placeholder_question' };
  if (isPlaceholderExtractField('solution', solution)) return { ok: false, reason: 'placeholder_solution' };
  if (/^(session excerpt indicates|execution of commands|deploy fixes?|direct call into)\b/.test(trigger)) {
    return { ok: false, reason: 'generic_trigger' };
  }
  if (/^(implement|update|debug|review)\b/.test(solution) && solution.length < 80) {
    return { ok: false, reason: 'generic_solution' };
  }
  if (isMetaWorkflowExtract(qa)) return { ok: false, reason: 'meta_workflow_extract' };
  if (trigger.length < 8) return { ok: false, reason: 'trigger_too_short' };
  if (solution.length < 12) return { ok: false, reason: 'solution_too_short' };
  return { ok: true, reason: null };
}

// ============================================================
//  Natural language detection
// ============================================================

function detectNaturalLang(text) {
  if (!text) return 'en';
  // Vietnamese detection: Latin diacritics + combining marks + Vietnamese-specific block
  const viPattern = /[\u00C0-\u00FF\u0100-\u024F\u0300-\u036F\u1EA0-\u1EFF]/g;
  const viCount = (text.match(viPattern) || []).length;
  return viCount >= 2 ? 'vi' : 'en';
}

// ============================================================
//  Transcript parsing
// ============================================================

const READ_ONLY_CMD = /^(ls|dir|cat|head|tail|wc|file|stat|find|tree|which|where|echo|printf|pwd|whoami|hostname|date|uptime|type|less|more|sort|uniq|tee|realpath|basename|dirname|env|printenv|id|groups|df|du|free|top|htop|lsof|ps|pgrep|mount|uname)\b|^git\s+(log|status|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|shortlog|blame|reflog|ls-files|ls-tree|name-rev|cherry)\b|^(grep|rg|ag|ack)\b|^diff\b|^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why)\b|^(dotnet)\s+(--list-sdks|--list-runtimes|--info)\b|^(docker|podman)\s+(ps|images|inspect|logs|stats|top|port|volume\s+ls|network\s+ls)\b|^(get-content|select-string|measure-object|get-childitem|get-item|get-location|resolve-path|test-path|get-command)\b/i;

function parseTranscriptToolCall(line) {
  const match = String(line || '').match(/^ToolCall\s+([^:]+):\s*([\s\S]*)$/i);
  if (!match) return null;
  return {
    toolName: match[1].trim(),
    summary: match[2].trim(),
  };
}

function isTranscriptReadOnlyToolCall(line) {
  const parsed = parseTranscriptToolCall(line);
  if (!parsed) return false;
  const tool = parsed.toolName.toLowerCase();
  if (tool !== 'bash' && tool !== 'shell' && tool !== 'execute_command') return false;
  let normalized = parsed.summary.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/^ssh\b/i.test(normalized)) return true;
  normalized = normalized.replace(/^\s*cd\s+["']?[^"';&|]+["']?\s*&&\s*/i, '');
  const parts = normalized.split(/\s*(?:&&|\|\||;)\s*/);
  return parts.every((part) => {
    const trimmed = part.trim();
    if (!trimmed || /^cd\s+/i.test(trimmed)) return true;
    return READ_ONLY_CMD.test(trimmed)
      || /^sed\s+-n\b/.test(trimmed)
      || /^curl\b(?!.*\b(-X|--request)\s+(POST|PUT|PATCH|DELETE)\b)/i.test(trimmed);
  });
}

function isMutatingTranscriptToolCall(line) {
  const parsed = parseTranscriptToolCall(line);
  if (!parsed) return false;
  const tool = parsed.toolName.toLowerCase();
  if (tool === 'edit' || tool === 'write' || tool === 'replace' || tool === 'write_file' || tool === 'replace_in_file') {
    return true;
  }
  if (tool === 'bash' || tool === 'shell' || tool === 'execute_command') {
    return !isTranscriptReadOnlyToolCall(line);
  }
  return false;
}

function extractRetryTarget(line) {
  const parsed = parseTranscriptToolCall(line);
  if (!parsed) return null;
  const tool = parsed.toolName.toLowerCase();
  if (tool === 'edit' || tool === 'write' || tool === 'replace' || tool === 'write_file' || tool === 'replace_in_file') {
    const target = parsed.summary.split(/\s+/)[0] || '';
    return target.includes('.') ? `${parsed.toolName}:${target}` : null;
  }
  if (tool === 'bash' || tool === 'shell' || tool === 'execute_command') {
    const target = extractPathFromCommand(parsed.summary);
    return target ? `${parsed.toolName}:${target}` : null;
  }
  return null;
}

function isTranscriptErrorSignal(line) {
  const text = String(line || '');
  if (!text || /^(User|Assistant):/i.test(text)) return false;
  return /^ToolOutput:/i.test(text)
    || /^Bash exit\s+[1-9]/i.test(text)
    || /\b(error|exception|fatal|assertionerror|failed|denied|not found|timeout)\b/i.test(text);
}

function detectMistakes(transcript) {
  const mistakes = [];
  const lines = transcript.split('\n');

  // Retry loops
  const toolCalls = {};
  for (const line of lines) {
    if (!isMutatingTranscriptToolCall(line)) continue;
    const key = extractRetryTarget(line);
    if (!key) continue;
    toolCalls[key] = (toolCalls[key] || 0) + 1;
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

  // Error → fix patterns (v2: require 2+ consecutive errors OR user correction nearby)
  for (let i = 0; i < lines.length; i++) {
    if (!isTranscriptErrorSignal(lines[i])) continue;
    // Count consecutive error signals starting at i
    let errorCount = 1;
    let errorEnd = i;
    for (let k = i + 1; k <= Math.min(i + 6, lines.length - 1); k++) {
      if (isTranscriptErrorSignal(lines[k])) { errorCount++; errorEnd = k; }
      else if (isMutatingTranscriptToolCall(lines[k])) break;
    }
    // Check for user correction between error and fix
    let hasUserCorrection = false;
    for (let k = i + 1; k <= Math.min(errorEnd + 6, lines.length - 1); k++) {
      if (/^User:/i.test(lines[k])) { hasUserCorrection = true; break; }
    }
    // Only count as mistake if repeated errors or user had to intervene
    if (errorCount < 2 && !hasUserCorrection) continue;
    for (let j = errorEnd + 1; j <= Math.min(errorEnd + 6, lines.length - 1); j++) {
      if (!isMutatingTranscriptToolCall(lines[j])) continue;
      mistakes.push({
        type: 'error_fix',
        context: `${errorCount} error(s) followed by correction${hasUserCorrection ? ' (user intervened)' : ''}`,
        excerpt: lines.slice(Math.max(0, i - 2), j + 3).join('\n')
      });
      break;
    }
  }
  return mistakes;
}

module.exports = {
  detectTranscriptDomain,
  normalizeExtractText, isPlaceholderExtractField, isMetaWorkflowExtract,
  assessExtractedQaQuality,
  detectNaturalLang,
  parseTranscriptToolCall, isTranscriptReadOnlyToolCall,
  isMutatingTranscriptToolCall, extractRetryTarget,
  isTranscriptErrorSignal, detectMistakes,
};
