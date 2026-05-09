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

// Triggers that look like raw tool-call/log lines instead of generalized failure
// patterns. These come from the brain literally copying the excerpt header when
// the prompt asks for "trigger rooted in the excerpt". Such entries surface as
// path-specific noise (see e.g. trigger="ToolCall read_text_file: /mnt/d/.../appsettings.json"),
// promote to T0 once, then get demoted as ignored — pure noise churn.
const PATHISH_TRIGGER_RE = /^(toolcall\b|tooloutput\b|bash\s+exit\b|read\s+|write\s+|edit\s+|replace\s+|fetch\s+|curl\b)/;
const PATH_PREFIX_RE = /^([a-z]:[\\\/]|\/[a-z]+\/)/;

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
  if (PATHISH_TRIGGER_RE.test(trigger)) return { ok: false, reason: 'trigger_is_tool_call' };
  if (PATH_PREFIX_RE.test(trigger)) return { ok: false, reason: 'trigger_starts_with_path' };
  // Triggers dominated by path separators are almost always raw log lines, not patterns.
  const pathSepCount = (trigger.match(/[\\\/]/g) || []).length;
  if (pathSepCount >= 3) return { ok: false, reason: 'trigger_is_path' };
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

// Explicit failure markers that survive being embedded in an arbitrary log line.
// Matching plain "error" or "failed" anywhere in a line caused massive false
// positives (e.g. reading a log file containing "0 errors, 1 warning" or a test
// file named test_error_handler). These tokens carry concrete failure semantics:
// exit codes, exception names, network failure codes, OS error codes.
const FAILURE_KEYWORDS_RE = /\b(exit\s+code\s*[1-9]|exception|traceback|panic|FATAL|FAIL\b|FAILURE|assertion\s*(failed|error)|command\s+not\s+found|connection\s+refused|permission\s+denied|access\s+denied|operation\s+(timed\s+out|not\s+permitted)|HTTP\s+[45]\d\d|\d{3}\s+(internal\s+server\s+)?error|ENOENT|EACCES|EADDRINUSE|EPIPE|ETIMEDOUT|ECONNREFUSED|stack\s*trace|core\s+dump(ed)?|TypeError|ReferenceError|SyntaxError|NullPointerException|build\s+failed|test(s)?\s+failed)\b/i;

const ERROR_PREFIX_RE = /^(Error:|Exception:|Traceback|FATAL:|panic:|TypeError:|ReferenceError:|SyntaxError:)/i;

function isTranscriptErrorSignal(line) {
  const text = String(line || '');
  if (!text) return false;
  // User/Assistant turns are commentary, not raw signals — never treat as errors
  // (the previous code did skip these but then matched any tool output containing
  // failure-flavored words, which was the bigger problem).
  if (/^(User|Assistant):/i.test(text)) return false;

  // Bash explicit non-zero exit is a hard signal
  if (/^Bash\s+exit\s+[1-9]/i.test(text)) return true;

  // ToolOutput: ONLY counts as an error when it carries an explicit failure
  // marker. Previously, any line starting with "ToolOutput:" was treated as
  // an error signal — meaning every successful tool call also fired the
  // detector and any session was 1-2 lines away from a "mistake".
  if (/^ToolOutput:/i.test(text)) {
    const body = text.replace(/^ToolOutput:\s*/i, '');
    return FAILURE_KEYWORDS_RE.test(body) || ERROR_PREFIX_RE.test(body);
  }

  // Standalone error lines (rare in normal transcripts but possible from
  // unstructured stack-trace dumps).
  return ERROR_PREFIX_RE.test(text);
}

// User turn that actually corrects the agent, vs. just any user message.
// Previously, /^User:/ alone counted as "user correction" — but in agent
// transcripts every turn starts with "User:", so the corrective filter never
// did anything. Match common correction language in EN + VN instead.
const USER_CORRECTION_KEYWORDS_RE = /\b(no|wrong|incorrect|fix|stop|undo|revert|instead|don'?t|doesn'?t\s+work|that'?s\s+not|sai|đừng|sửa|dừng|không\s+phải|không\s+đúng|làm\s+lại)\b/i;

function isUserCorrectionLine(line) {
  const text = String(line || '');
  if (!/^User:/i.test(text)) return false;
  const body = text.replace(/^User:\s*/i, '').trim();
  if (!body) return false;
  return USER_CORRECTION_KEYWORDS_RE.test(body);
}

// Build a structured summary instead of a raw 1500-char excerpt slice. The
// brain consistently copied the first ToolCall line as the trigger when fed
// raw excerpts, producing path-specific noise. A labelled summary points at
// the actual failure pattern.
function summarizeMistakeExcerpt(mistake) {
  const raw = String(mistake?.excerpt || '');
  if (!raw) return '';
  const lines = raw.split('\n').slice(0, 60);
  const errors = lines.filter((l) => /^(ToolOutput:|Bash\s+exit)/i.test(l) && isTranscriptErrorSignal(l)).slice(0, 3);
  const userCorrections = lines.filter((l) => isUserCorrectionLine(l)).slice(0, 2);
  const fixes = lines.filter((l) => /^ToolCall\s+(Edit|Write|replace|write_file|replace_in_file)\b/i.test(l)).slice(0, 2);

  const sections = [
    `MISTAKE TYPE: ${mistake?.type || 'unknown'}`,
    mistake?.context ? `CONTEXT: ${mistake.context}` : '',
    errors.length ? `FAILURE OUTPUT:\n${errors.join('\n')}` : '',
    userCorrections.length ? `USER CORRECTION:\n${userCorrections.join('\n')}` : '',
    fixes.length ? `SUBSEQUENT MUTATION:\n${fixes.join('\n')}` : '',
    `RAW WINDOW (first 600 chars):\n${raw.slice(0, 600)}`,
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 1500);
}

// Parse a transcript into structured tool events with success flags.
// Success is determined by: next ToolOutput line containing failure marker
// (failure), Bash exit non-zero (failure), otherwise success unless there's
// no terminal line (left undefined). Inspired by muonroi-cli's RingEntry
// model but reconstructed from text instead of recorded live.
function parseToolEvents(lines) {
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseTranscriptToolCall(lines[i]);
    if (!parsed) continue;
    let success;
    for (let k = i + 1; k <= Math.min(i + 3, lines.length - 1); k++) {
      const next = lines[k];
      if (parseTranscriptToolCall(next)) break;
      if (/^Bash\s+exit\s+0\b/i.test(next)) { success = true; break; }
      if (/^Bash\s+exit\s+[1-9]/i.test(next)) { success = false; break; }
      if (/^ToolOutput:/i.test(next)) {
        success = !isTranscriptErrorSignal(next);
        break;
      }
    }
    events.push({
      toolName: parsed.toolName,
      summary: parsed.summary,
      lineIdx: i,
      success,
    });
  }
  return events;
}

function tokenizeForSimilarity(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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

  // Retry-similarity pattern (ported from muonroi-cli mistake-detector).
  // Behavioral signal: a mutating tool call that failed, followed within 3
  // turns by a similar mutating call that succeeded — the warning should have
  // fired before the first attempt. This catches "first try wrong, second try
  // right" cases that the count-only retry_loop above misses (it requires 3+
  // calls on the same exact target).
  const events = parseToolEvents(lines);
  for (let i = 1; i < events.length; i++) {
    const cur = events[i];
    if (cur.success !== true) continue;
    if (!isMutatingTranscriptToolCall(`ToolCall ${cur.toolName}: ${cur.summary}`)) continue;
    const lookback = Math.max(0, i - 3);
    for (let j = i - 1; j >= lookback; j--) {
      const prior = events[j];
      if (prior.success !== false) continue;
      if (prior.toolName.toLowerCase() !== cur.toolName.toLowerCase()) continue;
      const sim = jaccardSimilarity(tokenizeForSimilarity(prior.summary), tokenizeForSimilarity(cur.summary));
      if (sim >= 0.7) {
        const window = lines.slice(Math.max(0, prior.lineIdx - 1), Math.min(lines.length, cur.lineIdx + 2)).join('\n');
        mistakes.push({
          type: 'retry_similarity',
          context: `${cur.toolName} retry succeeded after similar failed attempt (similarity=${sim.toFixed(2)}, ${i - j} turns apart)`,
          excerpt: window,
        });
        break;
      }
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
    // Check for user correction between error and fix.
    // v3: require corrective language ("no", "wrong", "fix this"...), not just
    // any User: turn — agent transcripts have a User: line every turn, which
    // made the previous filter no-op.
    let hasUserCorrection = false;
    for (let k = i + 1; k <= Math.min(errorEnd + 6, lines.length - 1); k++) {
      if (isUserCorrectionLine(lines[k])) { hasUserCorrection = true; break; }
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
  isTranscriptErrorSignal, isUserCorrectionLine, summarizeMistakeExcerpt,
  parseToolEvents, tokenizeForSimilarity, jaccardSimilarity,
  detectMistakes,
};
