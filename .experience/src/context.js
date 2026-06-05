/**
 * context.js — Context detection, transcript parsing, mistake detection.
 * Extracted verbatim from experience-core.js. Zero npm dependencies.
 */
'use strict';

const { detectContext, extractPathFromCommand } = require('./utils');

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
  if (qa.conditions && typeof qa.conditions === 'object' && !Array.isArray(qa.conditions)) {
    const conds = qa.conditions;
    const hasStructured = conds.filePattern || conds.toolMatch || conds.commandMatch || conds.codePattern || conds.errorMatch;
    if (!hasStructured && conds.keywords) {
      const kw = Array.isArray(conds.keywords) ? conds.keywords : [];
      const GENERIC_KW = new Set(['fix', 'error', 'bug', 'code', 'file', 'test', 'run', 'build', 'update', 'change', 'edit', 'shell', 'readme', 'demo', 'project']);
      const allGeneric = kw.length > 0 && kw.every(k => GENERIC_KW.has(String(k).toLowerCase()));
      if (allGeneric) return { ok: false, reason: 'conditions_too_generic' };
    }
  }
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

// Sanitize a raw transcript window before it is shown to the extractor LLM.
// The raw window is the dominant source of two defects observed on real
// sessions (TEP/eBerth dry-runs, 2026-06-05):
//   - non-English text (Vietnamese conversational lines) leaking into stored
//     hints, violating the English-only output rule;
//   - neighbouring failed-command output (e.g. "Exit code 2 grep ...") and raw
//     code dumps bleeding into recipe seeds, since the window is a raw slice of
//     surrounding lines regardless of per-event success.
// We drop conversational Assistant:/User: chatter (intent already lives in the
// structured fields) and any line that is >25% non-ASCII (diacritics), keeping
// ToolCall/ToolOutput/Bash evidence lines. Falls back to a non-ASCII-stripped
// slice of the original if filtering would remove everything.
function _sanitizeWindow(raw, maxChars) {
  const src = String(raw || '');
  if (!src) return '';
  const kept = [];
  for (const line of src.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (/^(Assistant|User):/i.test(l)) continue; // conversational chatter — not evidence
    const nonAscii = (l.match(/[^\x00-\x7F]/g) || []).length;
    if (l.length > 0 && nonAscii / l.length > 0.25) continue; // non-English line
    kept.push(l);
  }
  const out = kept.join('\n').slice(0, maxChars);
  // Fallback: never return empty — strip non-ASCII chars from the raw slice.
  return out || src.replace(/[^\x00-\x7F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

// Strip non-ASCII characters (e.g. Vietnamese diacritics) from a string while
// preserving newlines and structure. Applied to the WHOLE LLM-bound summary so
// non-English text cannot leak through ANY field (structured fields like
// failedApproach/error/before/after can carry non-English filenames or
// commands, not just the raw window). The extractQA prompt also instructs the
// model to translate meaning to English — this is the input-side belt.
function _stripNonAsciiPreserveNl(s) {
  return String(s || '').replace(/[^\x00-\x7F\n]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
}

// Public entry: structured per-type summary with all non-English text stripped.
function summarizeExperienceExcerpt(experience) {
  return _stripNonAsciiPreserveNl(_summarizeExperienceExcerptRaw(experience));
}

// Build a structured summary instead of a raw 1500-char excerpt slice. The
// brain consistently copied the first ToolCall line as the trigger when fed
// raw excerpts, producing path-specific noise. A labelled summary points at
// the actual failure pattern.
function _summarizeExperienceExcerptRaw(experience) {
  const raw = String(experience?.excerpt || '');
  if (!raw) return '';
  const type = experience?.type || 'unknown';
  const lines = raw.split('\n').slice(0, 60);
  const cleanWindow = _sanitizeWindow(raw, 600);

  if (type === 'recipe') {
    const steps = experience?.steps || [];
    const files = experience?.files || [];
    // A recipe is a SUCCESS pattern — drop any residual failure-marker lines
    // (e.g. "Exit code 2", error signals) that sit at the window boundary just
    // outside the success run, so the seed never implies the recipe failed.
    const recipeWindow = cleanWindow.split('\n').filter((l) => !isTranscriptErrorSignal(l)).join('\n');
    return [
      `EXPERIENCE TYPE: recipe (successful pattern)`,
      experience?.context ? `CONTEXT: ${experience.context}` : '',
      steps.length ? `STEPS:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      files.length ? `FILES: ${files.join(', ')}` : '',
      `RAW WINDOW (first 600 chars):\n${recipeWindow}`,
    ].filter(Boolean).join('\n\n').slice(0, 1500);
  }

  if (type === 'trap') {
    return [
      `EXPERIENCE TYPE: trap (same operation fail→succeed)`,
      experience?.context ? `CONTEXT: ${experience.context}` : '',
      experience?.failedApproach ? `FAILED APPROACH: ${experience.failedApproach}` : '',
      experience?.successApproach ? `WORKING APPROACH: ${experience.successApproach}` : '',
      `RAW WINDOW (first 600 chars):\n${cleanWindow}`,
    ].filter(Boolean).join('\n\n').slice(0, 1500);
  }

  if (type === 'dependency') {
    return [
      `EXPERIENCE TYPE: dependency (edit A breaks B)`,
      experience?.context ? `CONTEXT: ${experience.context}` : '',
      experience?.trigger ? `TRIGGER FILE: ${experience.trigger}` : '',
      experience?.affected ? `AFFECTED FILE: ${experience.affected}` : '',
      experience?.error ? `ERROR: ${experience.error}` : '',
      `RAW WINDOW (first 600 chars):\n${cleanWindow}`,
    ].filter(Boolean).join('\n\n').slice(0, 1500);
  }

  if (type === 'env_trap') {
    return [
      `EXPERIENCE TYPE: environmental trap (OS/tool error → workaround)`,
      experience?.context ? `CONTEXT: ${experience.context}` : '',
      experience?.error ? `ENV ERROR: ${experience.error}` : '',
      experience?.workaround ? `WORKAROUND: ${experience.workaround}` : '',
      `RAW WINDOW (first 600 chars):\n${cleanWindow}`,
    ].filter(Boolean).join('\n\n').slice(0, 1500);
  }

  if (type === 'user_correction') {
    return [
      `EXPERIENCE TYPE: user correction (user said no/wrong → agent adapted)`,
      experience?.context ? `CONTEXT: ${experience.context}` : '',
      experience?.correction ? `USER SAID: ${experience.correction}` : '',
      experience?.before ? `BEFORE: ${experience.before}` : '',
      experience?.after ? `AFTER: ${experience.after}` : '',
      `RAW WINDOW (first 600 chars):\n${cleanWindow}`,
    ].filter(Boolean).join('\n\n').slice(0, 1500);
  }

  // Fallback for unknown types
  const errors = lines.filter((l) => /^(ToolOutput:|Bash\s+exit)/i.test(l) && isTranscriptErrorSignal(l)).slice(0, 3);
  const userCorrections = lines.filter((l) => isUserCorrectionLine(l)).slice(0, 2);
  const fixes = lines.filter((l) => /^ToolCall\s+(Edit|Write|replace|write_file|replace_in_file)\b/i.test(l)).slice(0, 2);
  return [
    `EXPERIENCE TYPE: ${type}`,
    experience?.context ? `CONTEXT: ${experience.context}` : '',
    errors.length ? `FAILURE OUTPUT:\n${errors.join('\n')}` : '',
    userCorrections.length ? `USER CORRECTION:\n${userCorrections.join('\n')}` : '',
    fixes.length ? `SUBSEQUENT MUTATION:\n${fixes.join('\n')}` : '',
    `RAW WINDOW (first 600 chars):\n${raw.slice(0, 600)}`,
  ].filter(Boolean).join('\n\n').slice(0, 1500);
}

// Backward compat alias
function summarizeMistakeExcerpt(mistake) {
  return summarizeExperienceExcerpt(mistake);
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

// ============================================================
//  Environmental error detection
// ============================================================

const ENV_ERROR_RE = /\b(EPERM|ENOENT|EACCES|EADDRINUSE|ETIMEDOUT|ECONNREFUSED|uv_spawn|UV_HANDLE_CLOSING|cannot find module|no such file or directory|not recognized as|is not a cmdlet|command not found|permission denied|access denied|syntax error near unexpected token|SyntaxError|unexpected end of file|heredoc|unterminated string|invalid syntax)\b/i;

function isEnvError(line) {
  const text = String(line || '');
  return ENV_ERROR_RE.test(text);
}

// ============================================================
//  Edit old_string extraction from transcript summary
// ============================================================

function extractEditOldString(summary) {
  const m = String(summary || '').match(/\bold="([^"]*)"/);
  return m ? m[1] : null;
}

function extractEditTarget(summary) {
  const parts = String(summary || '').trim().split(/\s+/);
  const first = parts[0] || '';
  return first.includes('.') || first.includes('/') || first.includes('\\') ? first : null;
}

// ============================================================
//  Evidence extraction helpers — parse structured facts from raw text
// ============================================================

function _extractErrorInfo(text) {
  const s = String(text || '');
  const out = { type: null, message: null, file: null };
  const tsMatch = s.match(/error (TS\d+):\s*(.+?)(?:\n|$)/i);
  if (tsMatch) { out.type = tsMatch[1]; out.message = tsMatch[2].trim(); }
  const nodeMatch = s.match(/\b(Error|TypeError|RangeError|SyntaxError|ReferenceError):\s*(.+?)(?:\n|$)/);
  if (!out.type && nodeMatch) { out.type = nodeMatch[1]; out.message = nodeMatch[2].trim(); }
  const envMatch = s.match(/(EPERM|ENOENT|EACCES|EADDRINUSE|ETIMEDOUT|ECONNREFUSED|command not found|permission denied|cannot find module)\b[:\s]*(.{0,80})/i);
  if (!out.type && envMatch) { out.type = envMatch[1]; out.message = envMatch[2]?.trim() || null; }
  const exitMatch = s.match(/exit code (\d+)/i);
  if (!out.type && exitMatch && exitMatch[1] !== '0') { out.type = 'exit_' + exitMatch[1]; }
  const fileMatch = s.match(/(?:in |at |file )([^\s:]+\.\w{1,6})(?:[:\s(]|$)/);
  if (fileMatch) out.file = fileMatch[1];
  return out;
}

function _extractCommandInfo(summary) {
  const s = String(summary || '').trim();
  const bashMatch = s.match(/^(?:Bash|Shell|PowerShell)?:?\s*(.+)/i);
  const cmd = bashMatch ? bashMatch[1] : s;
  const parts = cmd.split(/\s+/);
  const name = parts[0] || null;
  const args = parts.slice(1).filter(a => a.startsWith('-') || a.startsWith('--')).slice(0, 5);
  return { full: cmd, name, args };
}

function _deriveFilePatterns(files) {
  const patterns = new Set();
  for (const f of files) {
    const s = String(f || '');
    const ext = s.match(/\.(\w{1,6})$/);
    if (ext) patterns.add('*.' + ext[1]);
    const dirMatch = s.replace(/\\/g, '/').match(/\/([^/]+)\/[^/]+$/);
    if (dirMatch) patterns.add(dirMatch[1] + '/*');
  }
  return [...patterns];
}

// ============================================================
//  Detector 1: RECIPE — successful multi-step task
// ============================================================

function detectRecipes(events, lines) {
  const recipes = [];
  const sequences = [];
  let current = [];

  for (const ev of events) {
    if (ev.success === false) {
      if (current.length >= 3) sequences.push([...current]);
      current = [];
      continue;
    }
    current.push(ev);
  }
  if (current.length >= 3) sequences.push(current);

  for (const seq of sequences) {
    const toolTypes = new Set(seq.map(e => e.toolName.toLowerCase()));
    if (toolTypes.size < 3) continue;

    const hasRead = [...toolTypes].some(t => ['read', 'grep', 'glob', 'read_file', 'read_text_file'].includes(t));
    const hasMutate = [...toolTypes].some(t => ['edit', 'write', 'write_file', 'replace'].includes(t));
    if (!hasRead || !hasMutate) continue;

    // A recipe is a SUCCESS pattern: require at least one event with a
    // confirmed success signal (Bash exit 0 or non-error ToolOutput). The
    // sequence loop only breaks on success===false; a run of success===undefined
    // events (unverified/incomplete work) would otherwise be mislabeled a recipe.
    if (!seq.some(e => e.success === true)) continue;

    const files = new Set();
    for (const ev of seq) {
      const target = extractEditTarget(ev.summary);
      if (target) files.add(target);
    }

    const startIdx = seq[0].lineIdx;
    const endIdx = seq[seq.length - 1].lineIdx;
    const window = lines.slice(Math.max(0, startIdx - 1), Math.min(lines.length, endIdx + 2));

    const toolsUsed = [...toolTypes];
    const fileList = [...files].slice(0, 5);
    const commands = seq.filter(e => ['bash','shell'].includes(e.toolName.toLowerCase())).map(e => e.summary.slice(0, 80)).slice(0, 5);
    recipes.push({
      type: 'recipe',
      context: `Successful ${seq.length}-step sequence using ${toolsUsed.join(', ')} on ${files.size} file(s)`,
      excerpt: window.join('\n').slice(0, 1500),
      steps: seq.map(e => `${e.toolName}: ${e.summary.slice(0, 80)}`).slice(0, 8),
      files: fileList,
      evidence: {
        files_touched: fileList,
        tools_used: toolsUsed,
        commands_run: commands,
        file_patterns: _deriveFilePatterns(fileList),
      },
    });

    if (recipes.length >= 3) break;
  }
  return recipes;
}

// ============================================================
//  Detector 2: TRAP — same operation fail→succeed
// ============================================================

function detectTraps(events, lines) {
  const traps = [];
  const MAX_TRAPS = 5;

  for (let i = 1; i < events.length; i++) {
    const cur = events[i];
    if (cur.success !== true) continue;
    const curTool = cur.toolName.toLowerCase();
    if (!['edit', 'write', 'write_file', 'replace', 'bash', 'shell'].includes(curTool)) continue;

    const lookback = Math.max(0, i - 5);
    for (let j = i - 1; j >= lookback; j--) {
      const prior = events[j];
      if (prior.success !== false) continue;
      // Allow cross-tool trap: fail with one tool, succeed with different approach
      const priorTool = prior.toolName.toLowerCase();
      const sameTool = priorTool === curTool;
      // Cross-tool: both are "shell-like" (bash/shell/powershell) or both are "edit-like"
      const shellLike = new Set(['bash', 'shell', 'execute_command', 'powershell']);
      const editLike = new Set(['edit', 'write', 'write_file', 'replace']);
      const crossTool = (shellLike.has(priorTool) && shellLike.has(curTool)) || (editLike.has(priorTool) && editLike.has(curTool));
      if (!sameTool && !crossTool) continue;

      let isSameOp = false;

      if (['edit', 'write', 'write_file', 'replace'].includes(curTool)) {
        const priorTarget = extractEditTarget(prior.summary);
        const curTarget = extractEditTarget(cur.summary);
        if (priorTarget !== curTarget) continue;

        const priorOld = extractEditOldString(prior.summary);
        const curOld = extractEditOldString(cur.summary);
        if (priorOld && curOld) {
          isSameOp = priorOld === curOld;
        } else {
          const sim = jaccardSimilarity(tokenizeForSimilarity(prior.summary), tokenizeForSimilarity(cur.summary));
          isSameOp = sim >= 0.8;
        }
      } else {
        const sim = jaccardSimilarity(tokenizeForSimilarity(prior.summary), tokenizeForSimilarity(cur.summary));
        // Lower threshold for bash — same error signature counts as same op
        const priorErr = lines.slice(prior.lineIdx, Math.min(lines.length, prior.lineIdx + 4)).join(' ');
        const priorSig = _extractErrorSignature ? _extractErrorSignature(priorErr) : null;
        const curContext = lines.slice(cur.lineIdx, Math.min(lines.length, cur.lineIdx + 4)).join(' ');
        isSameOp = sim >= 0.75 || (priorSig && curContext.includes(priorSig.split(':').pop()));
      }

      if (!isSameOp) continue;

      const window = lines.slice(Math.max(0, prior.lineIdx - 1), Math.min(lines.length, cur.lineIdx + 2));
      const trapFile = extractEditTarget(cur.summary);
    if (traps.length >= MAX_TRAPS) break;
      traps.push({
        type: 'trap',
        context: `${cur.toolName} on same target: failed then succeeded (${i - j} turns apart)`,
        excerpt: window.join('\n').slice(0, 1500),
        failedApproach: prior.summary.slice(0, 200),
        successApproach: cur.summary.slice(0, 200),
        evidence: {
          files_touched: trapFile ? [trapFile] : [],
          tools_used: [cur.toolName.toLowerCase()],
          failed_approach: _extractCommandInfo(prior.summary),
          success_approach: _extractCommandInfo(cur.summary),
          file_patterns: trapFile ? _deriveFilePatterns([trapFile]) : [],
        },
      });
      break;
    }
  }
  return traps;
}

// ============================================================
//  Detector 3: DEPENDENCY — edit A → break B → fix B
// ============================================================

function detectDependencies(events, lines) {
  const deps = [];

  for (let i = 0; i < events.length - 2; i++) {
    const editA = events[i];
    if (!['edit', 'write', 'write_file'].includes(editA.toolName.toLowerCase())) continue;
    if (editA.success === false) continue;

    const fileA = extractEditTarget(editA.summary);
    if (!fileA) continue;

    for (let j = i + 1; j <= Math.min(i + 4, events.length - 1); j++) {
      const errEv = events[j];
      if (errEv.success !== false) continue;

      const errText = lines.slice(errEv.lineIdx, Math.min(lines.length, errEv.lineIdx + 3)).join(' ');

      for (let k = j + 1; k <= Math.min(j + 4, events.length - 1); k++) {
        const fixB = events[k];
        if (!['edit', 'write', 'write_file'].includes(fixB.toolName.toLowerCase())) continue;
        if (fixB.success === false) continue;

        const fileB = extractEditTarget(fixB.summary);
        if (!fileB || fileB === fileA) continue;

        const window = lines.slice(Math.max(0, editA.lineIdx), Math.min(lines.length, fixB.lineIdx + 2));
        deps.push({
          type: 'dependency',
          context: `Edit ${fileA} → error → fix ${fileB}`,
          excerpt: window.join('\n').slice(0, 1500),
          trigger: fileA,
          affected: fileB,
          error: errText.slice(0, 200),
          evidence: {
            files_touched: [fileA, fileB],
            tools_used: ['edit'],
            error_info: _extractErrorInfo(errText),
            file_patterns: _deriveFilePatterns([fileA, fileB]),
          },
        });
        break;
      }
      if (deps.length > 0 && deps[deps.length - 1]?.trigger === fileA) break;
    }
    if (deps.length >= 5) break;
  }
  return deps;
}

// ============================================================
//  Detector 4: ENV_TRAP — environmental error → workaround
// ============================================================

function detectEnvTraps(events, lines) {
  const envTraps = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.success !== false) continue;

    const errLines = lines.slice(ev.lineIdx, Math.min(lines.length, ev.lineIdx + 3)).join(' ');
    if (!isEnvError(errLines)) continue;

    for (let j = i + 1; j <= Math.min(i + 6, events.length - 1); j++) {
      const fix = events[j];
      if (fix.success !== true) continue;
      if (!['bash', 'shell', 'edit', 'write', 'write_file'].includes(fix.toolName.toLowerCase())) continue;

      const window = lines.slice(Math.max(0, ev.lineIdx - 1), Math.min(lines.length, fix.lineIdx + 2));
      envTraps.push({
        type: 'env_trap',
        context: `Environmental error → workaround via ${fix.toolName}`,
        excerpt: window.join('\n').slice(0, 1500),
        error: errLines.slice(0, 200),
        workaround: fix.summary.slice(0, 200),
        evidence: {
          tools_used: [fix.toolName.toLowerCase()],
          error_info: _extractErrorInfo(errLines),
          workaround_command: ['bash', 'shell'].includes(fix.toolName.toLowerCase()) ? _extractCommandInfo(fix.summary) : null,
        },
      });
      break;
    }
    if (envTraps.length >= 3) break;
  }
  return envTraps;
}

// ============================================================
//  Detector 5: USER_CORRECTION — user says no/wrong → agent adapts
// ============================================================

// ============================================================
//  Detector 5b: REPEATED_ERROR — same error pattern hit >=2x then resolved
//  Catches: wrong path repeated, same syntax error repeated, permission errors
//  Key insight: extract the ERROR SIGNATURE, not the command, to match repeats
// ============================================================

function detectRepeatedErrors(events, lines) {
  const results = [];
  // Group consecutive failures by error signature
  const errorRuns = []; // [{signature, events: [...], startIdx, endIdx}]
  let currentSig = null;
  let currentRun = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.success === false) {
      const errLines = lines.slice(ev.lineIdx, Math.min(lines.length, ev.lineIdx + 5)).join(' ');
      const sig = _extractErrorSignature(errLines);
      if (sig) {
        if (currentSig === sig) {
          currentRun.events.push(ev);
          currentRun.endIdx = ev.lineIdx;
        } else {
          if (currentRun && currentRun.events.length >= 2) errorRuns.push(currentRun);
          currentSig = sig;
          currentRun = { signature: sig, events: [ev], startIdx: ev.lineIdx, endIdx: ev.lineIdx };
        }
      } else {
        if (currentRun && currentRun.events.length >= 2) errorRuns.push(currentRun);
        currentSig = null;
        currentRun = null;
      }
    } else if (ev.success === true) {
      if (currentRun && currentRun.events.length >= 2) {
        // The success AFTER repeated failures = the resolution
        currentRun.resolution = ev;
        errorRuns.push(currentRun);
      }
      currentSig = null;
      currentRun = null;
    }
  }
  if (currentRun && currentRun.events.length >= 2) errorRuns.push(currentRun);

  for (const run of errorRuns) {
    if (results.length >= 3) break;
    const resolution = run.resolution;
    if (!resolution) continue; // No resolution found = unresolved, skip

    const firstFail = run.events[0];
    const windowStart = Math.max(0, firstFail.lineIdx - 1);
    const windowEnd = Math.min(lines.length, resolution.lineIdx + 2);
    const window = lines.slice(windowStart, windowEnd);

    const failSummaries = run.events.map(e => e.summary.slice(0, 100));
    const failTools = [...new Set(run.events.map(e => e.toolName.toLowerCase()))];
    const files = [];
    for (const ev of [...run.events, resolution]) {
      const f = extractEditTarget(ev.summary);
      if (f) files.push(f);
    }

    results.push({
      type: 'trap',
      context: 'Repeated error "' + run.signature.slice(0, 60) + '" (' + run.events.length + 'x) then resolved via ' + resolution.toolName,
      excerpt: window.join('\n').slice(0, 1500),
      failedApproach: failSummaries.join(' | ').slice(0, 400),
      successApproach: resolution.summary.slice(0, 200),
      evidence: {
        files_touched: [...new Set(files)].slice(0, 5),
        tools_used: [...new Set([...failTools, resolution.toolName.toLowerCase()])],
        error_info: _extractErrorInfo(lines.slice(firstFail.lineIdx, firstFail.lineIdx + 5).join(' ')),
        failed_approach: { repeated: run.events.length, signature: run.signature },
        success_approach: _extractCommandInfo(resolution.summary),
        file_patterns: _deriveFilePatterns([...new Set(files)]),
      },
    });
  }
  return results;
}

// Extract a normalized error signature from error output
// Groups: path errors, permission errors, syntax errors, module errors
function _extractErrorSignature(text) {
  const s = String(text || '');
  const m1 = s.match(/(ENOENT|EACCES|EPERM)[^\n]{0,60}/);
  if (m1) return m1[1] + ':' + m1[0].slice(m1[1].length).trim().slice(0, 60);
  const m2 = s.match(/no such file or directory[^\n]{0,80}/i);
  if (m2) return 'ENOENT:' + m2[0].slice(25).trim().slice(0, 60);
  const m3 = s.match(/permission denied[^\n]{0,80}/i);
  if (m3) return 'EACCES:' + m3[0].slice(17).trim().slice(0, 60);
  const m4 = s.match(/syntax error near unexpected token[^\n]{0,40}/i);
  if (m4) return 'SYNTAX:' + m4[0].slice(0, 50);
  const m5 = s.match(/SyntaxError:\s*[^\n]{1,40}/);
  if (m5) return 'SYNTAX:' + m5[0].trim().slice(0, 50);
  if (/heredoc.*delimited by end-of-file/i.test(s)) return 'HEREDOC:unterminated';
  if (/unterminated string/i.test(s)) return 'SYNTAX:unterminated_string';
  const m6 = s.match(/cannot find module[^\n]{1,60}/i);
  if (m6) return 'MODULE:' + m6[0].slice(18).trim().slice(0, 50);
  const m7 = s.match(/exit code (\d+)/i);
  if (m7 && m7[1] !== '0') return 'EXIT:' + m7[1];
  return null;
}

function detectUserCorrections(lines) {
  const corrections = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isUserCorrectionLine(lines[i])) continue;

    const before = [];
    for (let k = Math.max(0, i - 4); k < i; k++) {
      if (isMutatingTranscriptToolCall(lines[k]) || /^Assistant:/i.test(lines[k])) {
        before.push(lines[k]);
      }
    }

    let after = null;
    for (let k = i + 1; k <= Math.min(i + 8, lines.length - 1); k++) {
      if (isMutatingTranscriptToolCall(lines[k])) {
        after = lines[k];
        break;
      }
    }
    if (!after) continue;

    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 10));
    const corrFiles = [];
    for (const l of [...before, after]) {
      const f = extractEditTarget(l);
      if (f) corrFiles.push(f);
    }
    // Extract structured evidence from the agent action the user is correcting
    const agentAction = before.length ? before[before.length - 1] : null;
    const parsedAction = agentAction ? parseTranscriptToolCall(agentAction) : null;
    const actionEvidence = {};
    if (parsedAction) {
      actionEvidence.tools_used = [parsedAction.toolName];
      const cmdInfo = _extractCommandInfo(parsedAction.summary);
      if (cmdInfo.executable) actionEvidence.commands = [cmdInfo.executable, ...(cmdInfo.subcommands || [])].filter(Boolean);
      if (cmdInfo.flags && cmdInfo.flags.length) actionEvidence.flags = cmdInfo.flags;
      const editFile = extractEditTarget(parsedAction.summary);
      if (editFile) corrFiles.push(editFile);
    }
    // Only keep user_correction if we found a concrete agent action to attach it to.
    // Generic "user said no" without a preceding tool call = noise, skip.
    if (!parsedAction) continue;

    corrections.push({
      type: 'user_correction',
      context: 'User correction: "' + lines[i].replace(/^User:\s*/i, '').slice(0, 100) + '" after agent: ' + parsedAction.toolName + ': ' + parsedAction.summary.slice(0, 80),
      excerpt: window.join('\n').slice(0, 1500),
      correction: lines[i].replace(/^User:\s*/i, '').slice(0, 200),
      before: before.map(l => l.slice(0, 100)).join(' | ').slice(0, 300),
      after: after.slice(0, 200),
      evidence: {
        files_touched: corrFiles,
        tools_used: actionEvidence.tools_used || [],
        commands: actionEvidence.commands || [],
        user_said: lines[i].replace(/^User:\s*/i, ''),
        agent_action: parsedAction.toolName + ': ' + parsedAction.summary.slice(0, 150),
        agent_did_after: after || null,
        file_patterns: _deriveFilePatterns(corrFiles),
      },
    });

    if (corrections.length >= 3) break;
  }
  return corrections;
}

// ============================================================
//  Main: detectExperience (replaces detectMistakes)
// ============================================================

function detectExperience(transcript) {
  const lines = transcript.split('\n');
  const events = parseToolEvents(lines);

  const recipes = detectRecipes(events, lines);
  const traps = detectTraps(events, lines);
  const dependencies = detectDependencies(events, lines);
  const envTraps = detectEnvTraps(events, lines);
  const repeatedErrors = detectRepeatedErrors(events, lines);
  const userCorrections = detectUserCorrections(lines);

  return [...recipes, ...traps, ...repeatedErrors, ...dependencies, ...envTraps, ...userCorrections];
}

// Deprecated alias — callers should migrate to detectExperience
function detectMistakes(transcript) {
  return detectExperience(transcript);
}

module.exports = {
  detectTranscriptDomain,
  normalizeExtractText, isPlaceholderExtractField, isMetaWorkflowExtract,
  assessExtractedQaQuality,
  detectNaturalLang,
  parseTranscriptToolCall, isTranscriptReadOnlyToolCall,
  isMutatingTranscriptToolCall, extractRetryTarget,
  isTranscriptErrorSignal, isUserCorrectionLine,
  summarizeExperienceExcerpt, summarizeMistakeExcerpt,
  parseToolEvents, tokenizeForSimilarity, jaccardSimilarity,
  detectExperience, detectMistakes,
  isEnvError, extractEditOldString, extractEditTarget, detectRepeatedErrors, _extractErrorSignature,
  detectRecipes, detectTraps, detectDependencies, detectEnvTraps, detectUserCorrections,
};
