/**
 * query-builder.js — Intent-based query construction for Experience Engine.
 *
 * Root cause fix: the old buildQuery sent raw code as the Qdrant search query.
 * Embedding models cannot bridge the semantic gap between "[CSS] .item { display:
 * flex; ..." and a principle like "Use semantic HTML elements for accessibility".
 *
 * This module extracts INTENT from tool actions — what the agent is DOING, not
 * the raw code it is writing. The resulting query embeds much closer to the
 * natural-language principles stored in the brain.
 *
 * Zero deps. Deterministic. No LLM. ~0.1ms per call.
 */
'use strict';

// Inline copies of detectContext and extractProjectSlug to avoid circular
// dependency (utils.js requires query-builder.js).

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
  const parts = filePath.replace(/\\/g, '/').split('.');
  if (parts.length < 2) return null;
  return LANG_MAP['.' + parts.pop().toLowerCase()] || null;
}

function extractProjectSlug(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const patterns = [
    /^[a-z]:\/personal\/core\/([^/]+)/i,
    /\/mnt\/[a-z]\/personal\/core\/([^/]+)/i,
    /^[a-z]:\/sources\/[^/]+\/([^/]+)/i,
    /\/sources\/[^/]+\/([^/]+)/i,
    /\/repos\/([^/]+)/i,
    /\/projects\/([^/]+)/i,
    /\/home\/[^/]+\/([^/]+)/i,
  ];
  for (const pat of patterns) {
    const m = normalized.match(pat);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ============================================================
//  Tool → action verb mapping
// ============================================================

const TOOL_ACTIONS = {
  // File operations
  write_file:    'creating file',
  Write:         'creating file',
  read_file:     'reading file',
  Read:          'reading file',
  Edit:          'modifying code',
  MultiEdit:     'modifying multiple sections',
  // Shell
  Bash:          'running command',
  PowerShell:    'running command',
  // Browsing / search
  Grep:          'searching codebase',
  Glob:          'finding files',
  WebFetch:      'fetching web page',
  WebSearch:     'searching web',
  // Git
  git_commit:    'committing changes',
  git_push:      'pushing to remote',
  git_diff:      'reviewing diff',
  // Catch-all for post-tool batch (Claude Code hook format)
  PostToolBatch: 'agent tool batch',
};

function getToolAction(toolName) {
  if (!toolName) return 'using tool';
  if (TOOL_ACTIONS[toolName]) return TOOL_ACTIONS[toolName];
  const stripped = toolName.replace(/^mcp__\w+__/, '');
  if (TOOL_ACTIONS[stripped]) return TOOL_ACTIONS[stripped];
  if (/^(bash|sh|shell|terminal)/i.test(toolName)) return 'running command';
  return 'using ' + toolName;
}

// ============================================================
//  Intent keyword extraction — language-aware
// ============================================================

const INTENT_EXTRACTORS = {
  css(content) {
    const kw = [];
    if (/display\s*:\s*flex/i.test(content)) kw.push('flexbox layout');
    if (/display\s*:\s*grid/i.test(content)) kw.push('CSS grid layout');
    if (/@media/i.test(content)) kw.push('responsive design');
    if (/@keyframes|animation/i.test(content)) kw.push('CSS animation');
    if (/position\s*:\s*(fixed|sticky)/i.test(content)) kw.push('fixed positioning');
    if (/z-index/i.test(content)) kw.push('stacking context');
    if (/var\s*\(--/i.test(content)) kw.push('CSS custom properties');
    if (/:hover|:focus|:active/i.test(content)) kw.push('interactive states');
    return kw;
  },
  typescript(content) {
    const kw = [];
    if (/\basync\b.*\bawait\b/s.test(content)) kw.push('async/await pattern');
    if (/\bimport\b.*\bfrom\b/i.test(content)) kw.push('module imports');
    if (/\bclass\s+\w+/i.test(content)) kw.push('class definition');
    if (/\binterface\s+\w+/i.test(content)) kw.push('interface definition');
    if (/\btype\s+\w+\s*=/i.test(content)) kw.push('type definition');
    if (/\buseState\b|\buseEffect\b|\buseRef\b|\buseMemo\b/i.test(content)) kw.push('React hooks');
    if (/\buse[A-Z]\w+/.test(content)) kw.push('custom hook');
    if (/<\w+[^>]*\/?>/.test(content)) kw.push('React component');
    if (/\bexport\s+(default\s+)?function/i.test(content)) kw.push('exported function');
    if (/\bdescribe\b.*\bit\b|\btest\b.*\bexpect\b/s.test(content)) kw.push('test suite');
    if (/\btry\s*\{[\s\S]*\bcatch\b/i.test(content)) kw.push('error handling');
    if (/\bfetch\b|\baxios\b|\bhttp/i.test(content)) kw.push('HTTP request');
    if (/\bPromise\b|\b\.then\b/i.test(content)) kw.push('promise handling');
    if (/\bEventEmitter\b|\b\.on\b.*\b\.emit\b/s.test(content)) kw.push('event handling');
    if (/\bReadStream\b|\bWriteStream\b|\bpipe\b/i.test(content)) kw.push('streaming I/O');
    if (/\bzod\b|\bz\.\w+/i.test(content)) kw.push('schema validation');
    return kw;
  },
  csharp(content) {
    const kw = [];
    if (/\basync\s+Task/i.test(content)) kw.push('async task pattern');
    if (/\bDbContext\b|\bDbSet\b/i.test(content)) kw.push('Entity Framework');
    if (/\bIServiceCollection\b|\bAddScoped\b|\bAddSingleton\b/i.test(content)) kw.push('dependency injection');
    if (/\bMiddleware\b|\bUseMiddleware\b/i.test(content)) kw.push('middleware pipeline');
    if (/\[ApiController\]|\[HttpGet\]|\[HttpPost\]/i.test(content)) kw.push('Web API controller');
    if (/\bMigration\b|\bUp\b.*\bDown\b/s.test(content)) kw.push('database migration');
    if (/\bSaga\b|\bMSaga/i.test(content)) kw.push('saga orchestration');
    if (/\bMRepository\b|\bIRepository\b/i.test(content)) kw.push('repository pattern');
    if (/\bIMDateTimeService\b/i.test(content)) kw.push('date/time service');
    if (/\bSignalR\b|\bHub\b/i.test(content)) kw.push('real-time communication');
    if (/\bHangfire\b|\bBackgroundJob\b/i.test(content)) kw.push('background job');
    if (/\bFluentValidation\b|\bAbstractValidator\b/i.test(content)) kw.push('input validation');
    if (/\bAutoMapper\b|\bProfile\b/i.test(content)) kw.push('object mapping');
    if (/\bxunit\b|\bFact\b|\bTheory\b/i.test(content)) kw.push('unit testing');
    return kw;
  },
  shell(content) {
    const kw = [];
    if (/\bgit\s+(commit|push|pull|merge|rebase|reset)/i.test(content)) kw.push('git operations');
    if (/\bgit\s+checkout\b|\bgit\s+switch\b/i.test(content)) kw.push('branch management');
    if (/\bnpm\s+(install|run|build|test)|\bbun\s+(install|run|test)|\byarn\b/i.test(content)) kw.push('package management');
    if (/\bdocker\b/i.test(content)) kw.push('container operations');
    if (/\bdotnet\s+(build|restore|test|publish|run)/i.test(content)) kw.push('dotnet CLI');
    if (/\bkubectl\b|\bhelm\b/i.test(content)) kw.push('Kubernetes operations');
    if (/\bssh\b/i.test(content)) kw.push('remote access');
    if (/\bcurl\b|\bwget\b/i.test(content)) kw.push('HTTP client');
    if (/\bsed\b|\bawk\b|\bgrep\b/i.test(content)) kw.push('text processing');
    if (/\bmkdir\b|\bcp\b|\bmv\b|\brm\b/i.test(content)) kw.push('file system operations');
    if (/\bsystemctl\b|\bservice\b/i.test(content)) kw.push('service management');
    return kw;
  },
  python(content) {
    const kw = [];
    if (/\bimport\s+(pandas|pd)\b/i.test(content)) kw.push('data analysis');
    if (/\bimport\s+(numpy|np)\b/i.test(content)) kw.push('numerical computing');
    if (/\bimport\s+torch\b|\bimport\s+tensorflow\b/i.test(content)) kw.push('machine learning');
    if (/\bFlask\b|\bFastAPI\b|\bDjango\b/i.test(content)) kw.push('web framework');
    if (/\bdef\s+test_\b|\bpytest\b|\bunittest\b/i.test(content)) kw.push('testing');
    if (/\basync\s+def\b|\bawait\b/i.test(content)) kw.push('async operations');
    return kw;
  },
};

const LANG_TO_EXTRACTOR = {
  'TypeScript':       'typescript',
  'TypeScript React': 'typescript',
  'JavaScript':       'typescript',
  'JavaScript React': 'typescript',
  'C#':               'csharp',
  'F#':               'csharp',
  'CSS':              'css',
  'SCSS':             'css',
  'Shell':            'shell',
  'PowerShell':       'shell',
  'Python':           'python',
};

function extractIntentKeywords(content, lang) {
  if (!content || typeof content !== 'string') return [];
  const key = LANG_TO_EXTRACTOR[lang];
  if (!key || !INTENT_EXTRACTORS[key]) return [];
  const scan = content.length > 4000 ? content.slice(0, 4000) : content;
  try {
    return INTENT_EXTRACTORS[key](scan).slice(0, 6);
  } catch { return []; }
}

// ============================================================
//  File-level context
// ============================================================

function extractFileName(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').split('/').pop() || '';
}

function extractDirContext(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const skip = new Set(['src','lib','app','dist','build','node_modules','bin','obj','.','..','D:','C:','sources','Core','Personal']);
  const parts = normalized.split('/');
  const meaningful = parts.filter(p =>
    p && !skip.has(p) && p.length > 1 && !/^[a-z]:$/i.test(p)
  );
  return meaningful.slice(-3).join(' ');
}

// ============================================================
//  Bash command intent extraction
// ============================================================

function extractBashIntent(command) {
  if (!command || typeof command !== 'string') return '';
  const first = command.split(/[|&;]/).map(s => s.trim()).filter(Boolean)[0] || command;
  const intents = extractIntentKeywords(first, 'Shell');
  if (intents.length > 0) return intents.join(', ');
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).join(' ');
  return first.slice(0, 40);
}

// ============================================================
//  Main: buildSemanticQuery
// ============================================================

/**
 * Build an intent-based semantic query for Qdrant embedding search.
 *
 * Instead of sending raw code like "[CSS] .item { display: flex; ..."
 * this produces:
 *   "creating file CSS TodoItem.module.css flexbox layout, interactive states"
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [opts] — { projectSlug, existingSymbols }
 * @returns {string}
 */
function buildSemanticQuery(toolName, toolInput, opts = {}) {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  const lang = detectContext(filePath);
  const action = getToolAction(toolName);
  const fileName = extractFileName(filePath);
  const dirContext = extractDirContext(filePath);
  const projectSlug = opts.projectSlug || extractProjectSlug(filePath) || '';

  let rawContent = '';
  if (toolName === 'Bash' || toolName === 'PowerShell' || /bash/i.test(toolName)) {
    rawContent = toolInput?.command || toolInput?.cmd || '';
  } else {
    rawContent = toolInput?.new_string || toolInput?.content || toolInput?.old_string || '';
  }

  let intentKeywords;
  if (toolName === 'Bash' || toolName === 'PowerShell' || /bash/i.test(toolName)) {
    const bashIntent = extractBashIntent(rawContent);
    intentKeywords = bashIntent ? [bashIntent] : [];
  } else {
    intentKeywords = extractIntentKeywords(rawContent, lang);
  }

  const symbols = opts.existingSymbols || [];

  const parts = [];
  parts.push(action);
  if (lang) parts.push(lang);
  if (fileName && fileName !== filePath) parts.push(fileName);
  if (dirContext) parts.push('in ' + dirContext);
  if (projectSlug) parts.push('project ' + projectSlug);
  if (intentKeywords.length > 0) parts.push(intentKeywords.join(', '));
  if (symbols.length > 0) parts.push('using ' + symbols.join(', '));

  const query = parts.join(' ').replace(/\s+/g, ' ').trim();

  // Fallback: if intent extraction yielded nothing, append truncated raw content
  if (intentKeywords.length === 0 && symbols.length === 0 && rawContent) {
    const snippet = rawContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    return (query + ' ' + snippet).slice(0, 500);
  }

  return query.slice(0, 500);
}

module.exports = {
  buildSemanticQuery,
  extractIntentKeywords,
  getToolAction,
  extractBashIntent,
  extractFileName,
  extractDirContext,
  TOOL_ACTIONS,
  INTENT_EXTRACTORS,
  LANG_TO_EXTRACTOR,
};
