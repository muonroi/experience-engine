/**
 * intercept.js — Main intercept pipeline, reconciliation, and extract for Experience Engine.
 * Extracted from experience-core.js. Zero dependencies.
 */
'use strict';

const _config = require('./config');
const _utils = require('./utils');
const _qdrant = require('./qdrant');
const _session = require('./session');
const _context = require('./context');
const _noise = require('./noise');
const _brainllm = require('./brain-llm');
const _evolution = require('./evolution');
const _activity = require('./activity');
const _hittrack = require('./hittrack');
const _logger = require('./logger');

// --- Constants ---
// This is the COLLECTIONS array experience-core.js actually destructures
// (`const { COLLECTIONS } = _intercept`), so recall's wide-net (recallTopK) and
// depth (recallBudgetChars) fields MUST live here. They were previously only on
// config.js's separate COLLECTIONS copy — which core never reads — so core's
// `recallTopK || topK` / `recallBudgetChars || budgetChars` always fell back to
// the tight passive values, silently capping active recall at the passive topK
// and an ~800-1200 char budget (one ~2000-char recall line per leg). That made
// recall surface ≤1 entry regardless of how many strong matches existed.
// budgetChars/topK = passive hints (precision-tuned, interruptive). recall* =
// active recall (deliberate query → wider net + room for several full entries).
const COLLECTIONS = [
  { name: 'experience-principles', topK: 2,  recallTopK: 10, budgetChars: 800,  recallBudgetChars: 6000 },
  { name: 'experience-behavioral', topK: 3,  recallTopK: 15, budgetChars: 1200, recallBudgetChars: 12000 },
  { name: 'experience-selfqa',     topK: 10, recallTopK: 20, budgetChars: 1000, recallBudgetChars: 12000 },
];

const ROUTES_COLLECTION = 'experience-routes';
const SELFQA_COLLECTION = 'experience-selfqa';
const EDGE_COLLECTION = 'experience-edges';
const UNUSED_NO_TOUCH_THRESHOLD = 3;
const PENDING_HINT_TTL_MS = 20 * 60 * 1000;
const PROMPT_STALE_RECONCILE_MS = 10 * 1000;

const DOMAIN_KEYWORDS = {
  javascript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  typescript: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'vite', 'vitest', 'jest', 'tsx', 'ts-node', 'eslint'],
  python: ['python', 'pip', 'pytest', 'poetry', 'uv', 'ruff'],
  'c#': ['dotnet', 'nuget', 'msbuild', 'csc'],
  java: ['java', 'javac', 'mvn', 'gradle'],
  rust: ['cargo', 'rustc'],
  go: ['go test', 'go build', 'gofmt'],
  ruby: ['bundle', 'bundler', 'rspec', 'ruby'],
  shell: ['bash', 'sh ', 'zsh'],
};

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

const PLACEHOLDER_EXTRACT_FIELDS = {
  trigger: new Set(['when this fires', 'when this happens', 'if this happens', 'when it fires', 'when it happens']),
  question: new Set(['one line', 'one-line', 'one line question']),
  solution: new Set(['what to do', 'fix it', 'do the fix', 'apply a fix']),
};

const ORGANIC_SUPPORT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'before', 'after', 'ensure', 'always', 'should', 'must', 'have', 'has', 'are',
  'was', 'were', 'will', 'using', 'used', 'file', 'files', 'command',
]);

const READ_ONLY_CMD = /^(ls|dir|cat|head|tail|wc|file|stat|find|tree|which|where|echo|printf|pwd|whoami|hostname|date|uptime|type|less|more|sort|uniq|tee|realpath|basename|dirname|env|printenv|id|groups|df|du|free|top|htop|lsof|ps|pgrep|mount|uname)\b|^git\s+(log|status|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|shortlog|blame|reflog|ls-files|ls-tree|name-rev|cherry)\b|^(grep|rg|ag|ack)\b|^diff\b|^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why)\b|^(dotnet)\s+(--list-sdks|--list-runtimes|--info)\b|^(docker|podman)\s+(ps|images|inspect|logs|stats|top|port|volume\s+ls|network\s+ls)\b|^(get-content|select-string|measure-object|get-childitem|get-item|get-location|resolve-path|test-path|get-command)\b/i;

// --- Helper functions ---

function classifyActionKind(toolName, toolInput, actionPath) {
  const raw = `${toolName || ''} ${toolInput?.command || toolInput?.cmd || ''} ${toolInput?.file_path || toolInput?.path || ''}`.toLowerCase();
  const pathText = String(actionPath || '').toLowerCase();
  if (/(^|\/)(readme|session_start|repo_deep_map|plan|state|agents)\.md$/.test(pathText) || /(^|\/)docs?\//.test(pathText) || /\.md\b/.test(raw)) return 'docs';
  if (/\.(json|ya?ml|toml|ini|env|lock)\b/.test(pathText) || /\b(docker-compose|package-lock|pnpm-lock|poetry\.lock)\b/.test(raw)) return 'config';
  if (/\.(sh|ps1|bat)\b/.test(pathText) || /\b(deploy|docker|kubectl|helm|systemctl)\b/.test(raw)) return 'ops';
  if (_utils.detectContext(actionPath || '')) return 'code';
  return 'unknown';
}

function isAbsolutePath(p) {
  if (!p) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('/')) return true;
  return false;
}

function extractPathFromCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const cdMatch = cmd.match(/\bcd\s+["']?([^"';&|$\n]+?)["']?\s*(?:[;&|]|\s*$)/);
  if (cdMatch) {
    const p = cdMatch[1].trim();
    if (isAbsolutePath(p)) return p;
  }
  const candidates = [];
  const winMatches = cmd.matchAll(/[A-Za-z]:[\\/][^\s"';&|$*?<>]+/g);
  for (const m of winMatches) candidates.push(m[0]);
  const unixMatches = cmd.matchAll(/(?:^|\s|["'=])(\/{1}(?!dev\/null)[A-Za-z][^\s"';&|$*?<>]*\/[^\s"';&|$*?<>]*)/g);
  for (const m of unixMatches) candidates.push(m[1]);
  const msysMatches = cmd.matchAll(/\/([a-z])\/[^\s"';&|$*?<>]+/g);
  for (const m of msysMatches) candidates.push(m[0]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function isReadOnlyCommand(toolName, toolInput) {
  const tool = (toolName || '').toLowerCase();
  if (tool !== 'bash' && tool !== 'shell' && tool !== 'execute_command') return false;
  const cmd = (toolInput?.command || toolInput?.cmd || '').trim();
  const parts = cmd.split(/\s*(?:&&|\|\||;)\s*/);
  return parts.every(p => READ_ONLY_CMD.test(p.trim()));
}

function isHookRealtimeFastPath(toolName, sourceMeta) {
  const runtime = String(sourceMeta?.sourceRuntime || '').trim().toLowerCase();
  return sourceMeta?.sourceKind === 'codex-hook'
    || (String(toolName || '') === 'UserPrompt' && runtime.startsWith('codex'));
}

function isPromptHookPrecisionGate(toolName, sourceMeta) {
  return String(toolName || '') === 'UserPrompt' && sourceMeta?.sourceKind === 'codex-hook';
}

function promptHookScoreThreshold() {
  const getPromptHookMinScore = () => _config.cfgValue('promptHookMinScore', 'EXPERIENCE_PROMPT_HOOK_MIN_SCORE', _config.getHighConfidence() ? String(_config.getHighConfidence()) : '0.6');
  const configured = Number(getPromptHookMinScore());
  const fallback = Number(_config.getHighConfidence()) || 0.60;
  return Number.isFinite(configured) && configured > 0 ? Math.max(configured, Number(_config.getMinConfidence()) || 0) : fallback;
}

function filterPromptHookPoints(points, toolName, sourceMeta) {
  if (!isPromptHookPrecisionGate(toolName, sourceMeta)) return { kept: points || [], removed: [] };
  const threshold = promptHookScoreThreshold();
  const kept = [];
  const removed = [];
  for (const point of points || []) {
    const score = Number(point?._effectiveScore ?? point?.score ?? 0);
    if (Number.isFinite(score) && score >= threshold) kept.push(point);
    else removed.push(point);
  }
  return { kept, removed };
}

function assessHintUsage(surface, toolName, toolInput, runtimeMeta = {}) {
  const cwdPath = runtimeMeta.cwd || process.cwd() || '';
  const actionPath = _utils.extractProjectPath(toolInput || {}) || cwdPath || '';
  const actionProject = _utils.extractProjectSlug(actionPath || '') || _utils.extractProjectSlug(cwdPath || '');
  const actionDomain = _utils.detectContext(actionPath || '') || null;
  const actionKind = classifyActionKind(toolName, toolInput || {}, actionPath || cwdPath);
  const actionText = _utils.buildQuery(toolName || '', toolInput || {}).toLowerCase();
  const projectSlug = surface?.projectSlug || null;
  const scopeLang = _utils.normalizeTechLabel(surface?.scope?.lang);

  if (projectSlug && actionProject && projectSlug !== actionProject) {
    return { touched: false, reason: 'wrong_repo', actionProject, actionDomain, actionKind };
  }
  if (_noise.inferLanguageMismatch(surface, actionDomain)) {
    return { touched: false, reason: 'wrong_language', actionProject, actionDomain, actionKind };
  }
  if (scopeLang && scopeLang !== 'all') {
    if (actionDomain && _utils.normalizeTechLabel(actionDomain) === scopeLang) {
      return { touched: true, reason: 'language_match', actionProject, actionDomain, actionKind };
    }
    if (_utils.commandSuggestsDomain(actionText, scopeLang)) {
      return { touched: true, reason: 'domain_command_match', actionProject, actionDomain, actionKind };
    }
    return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
  }
  if (actionKind === 'docs' || actionKind === 'config' || actionKind === 'ops') {
    return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
  }
  if (projectSlug && actionProject && projectSlug === actionProject) {
    return { touched: true, reason: 'project_match', actionProject, actionDomain, actionKind };
  }
  if (actionProject || actionPath) {
    return { touched: true, reason: 'path_match', actionProject, actionDomain, actionKind };
  }
  return { touched: false, reason: 'wrong_task', actionProject, actionDomain, actionKind };
}

// Pre-surface relevance gate. On PreToolUse hooks the action (tool + input +
// cwd) is fully known at surface time, so we can run the SAME relevance check
// the post-hoc reconciler uses (assessHintUsage) BEFORE surfacing — dropping
// candidate points that would later be classified wrong_repo / wrong_language /
// wrong_task. This closes the surface-vs-classify gap that drove 87% of
// irrelevant surfaces (58/67, Bash-dominated) and pinned interception precision
// at 57%. Evidence: ~/.experience/activity.jsonl 7d window (2026-06-09) —
// IRRELEVANT by tool: Bash 46 / Edit 8 / Write 4 / prompt 9; inside Bash:
// wrong_task 28, wrong_repo 18.
// UserPromptSubmit (toolName 'UserPrompt') has no concrete action yet — the
// gate is a no-op there so prompt-time surfacing is unaffected.
function isActionKnownHook(toolName) {
  const t = String(toolName || '');
  return t !== '' && t !== 'UserPrompt';
}

function filterByActionRelevance(points, collectionName, toolName, toolInput, runtimeMeta = {}) {
  if (!isActionKnownHook(toolName)) return { kept: points || [], removed: [] };
  const kept = [];
  const removed = [];
  for (const point of points || []) {
    let exp = {};
    try {
      exp = JSON.parse(point?.payload?.json || '{}');
    } catch (err) {
      // Fail-open: a malformed payload must not silently vanish from surfacing.
      // Keep it and log per the No-Silent-Catch rule.
      _logger.log('debug', 'relevance_gate_parse_fail', { id: point?.id, collection: collectionName, error: err?.message });
      kept.push(point);
      continue;
    }
    const surface = {
      projectSlug: exp.scope?.project_slug || exp.scope?.projectSlug || null,
      scope: exp.scope || {},
      collection: collectionName,
    };
    const verdict = assessHintUsage(surface, toolName, toolInput, runtimeMeta);
    if (verdict.touched) kept.push(point);
    else removed.push({ id: point?.id, reason: verdict.reason });
  }
  return { kept, removed };
}

function promptStateSurfacedIds(state) {
  return Array.isArray(state?.surfacedIds)
    ? state.surfacedIds.filter(surface => surface?.collection && surface?.id)
    : [];
}

function isPromptOnlySuggestionState(state) {
  if (!state || typeof state !== 'object') return false;
  return state.sourceHook === 'UserPromptSubmit' || state.tool === 'UserPrompt';
}

// Server-side stash: persist surfaced hint ids into the session pending track
// at intercept time, keyed by sourceSession via getSessionTrackFile. This lets
// PostToolUse reconciliation (reconcilePendingHints) assess them even when a
// remote client (e.g. codex-windows) does not echo surfacedIds back at posttool
// time, which was leaving 100% of posttool calls with surfacedCount:0 and
// emitting zero FOLLOWED/IGNORED/IRRELEVANT verdicts (Gate 4 starvation).
function stashSurfacedHints(surfacedPoints, meta = {}) {
  const incoming = Array.isArray(surfacedPoints) ? surfacedPoints : [];
  if (incoming.length === 0) return { stashed: 0 };
  const track = _session.readSessionTrack(meta);
  if (!track.pending || typeof track.pending !== "object" || Array.isArray(track.pending)) track.pending = {};
  const nowIso = new Date().toISOString();
  let stashed = 0;
  for (const surface of incoming) {
    if (!surface?.id || !surface?.collection) continue;
    const key = `${surface.collection}:${surface.id}`;
    if (!track.pending[key]) { track.pending[key] = { ...surface, surfacedAt: nowIso, noTouchCount: 0 }; stashed++; }
  }
  _session.writeSessionTrack(track, meta);
  return { stashed };
}

async function reconcilePendingHints(surfacedPoints, toolName, toolInput, meta = {}) {
  const track = _session.readSessionTrack(meta);
  if (!track.pending || typeof track.pending !== 'object' || Array.isArray(track.pending)) track.pending = {};
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const incoming = Array.isArray(surfacedPoints) ? surfacedPoints : [];
  const results = { touched: [], pending: [], implicitUnused: [], expired: [] };

  for (const surface of incoming) {
    if (!surface?.id || !surface?.collection) continue;
    const key = `${surface.collection}:${surface.id}`;
    if (!track.pending[key]) {
      track.pending[key] = { ...surface, surfacedAt: nowIso, noTouchCount: 0 };
    }
  }

  for (const [key, pending] of Object.entries(track.pending)) {
    const surfacedAtMs = pending?.surfacedAt ? new Date(pending.surfacedAt).getTime() : 0;
    if (surfacedAtMs && (nowMs - surfacedAtMs) > PENDING_HINT_TTL_MS) {
      delete track.pending[key];
      results.expired.push({ collection: pending.collection, id: pending.id });
      continue;
    }

    const assessment = assessHintUsage(pending, toolName, toolInput, meta);
    if (assessment.touched) {
      await _qdrant.updatePointPayload(
        pending.collection, pending.id,
        _hittrack.applyHitUpdateWithContext({
          projectSlug: assessment.actionProject || null,
          sourceSession: meta.sourceSession || null,
          sourceKind: meta.sourceKind || null,
        })
      );
      _activity.activityLog({
        op: 'implicit-touch', collection: pending.collection,
        pointId: _session.shortPointId(pending.id), reason: assessment.reason,
        tool: toolName, ..._utils.normalizeSourceMeta(meta),
      });
      // Emit explicit feedback event so dashboard precision aggregator counts
      // this deterministic touch as FOLLOWED. Payload already updated above
      // via applyHitUpdateWithContext — this is a metric-visibility signal
      // only, no double-write.
      _activity.activityLog({
        op: 'feedback', source: 'implicit',
        collection: pending.collection,
        pointId: _session.shortPointId(pending.id),
        verdict: 'FOLLOWED', reason: assessment.reason,
        tool: toolName, ..._utils.normalizeSourceMeta(meta),
      });
      delete track.pending[key];
      results.touched.push({ collection: pending.collection, id: pending.id, reason: assessment.reason });
      continue;
    }

    pending.noTouchCount = (pending.noTouchCount || 0) + 1;
    pending.lastNoTouchAt = nowIso;
    pending.lastNoTouchReason = assessment.reason;
    pending.lastToolName = toolName || '';
    track.pending[key] = pending;

    if (pending.noTouchCount >= UNUSED_NO_TOUCH_THRESHOLD) {
      const deterministicNoise = assessment.reason === 'wrong_repo' || assessment.reason === 'wrong_language' || assessment.reason === 'wrong_task';
      await _qdrant.updatePointPayload(
        pending.collection, pending.id,
        _hittrack.applyNoiseDispositionData('unused', 'implicit-posttool', assessment.reason, { countIrrelevant: deterministicNoise })
      );
      _activity.activityLog({ op: 'noise-disposition', collection: pending.collection, pointId: _session.shortPointId(pending.id), disposition: 'unused', source: 'implicit-posttool', noTouchCount: pending.noTouchCount, reason: assessment.reason, tool: toolName, ..._utils.normalizeSourceMeta(meta) });
      _activity.activityLog({ op: 'implicit-unused', collection: pending.collection, pointId: _session.shortPointId(pending.id), count: pending.noTouchCount, reason: assessment.reason, tool: toolName, ..._utils.normalizeSourceMeta(meta) });
      // Determine the precision-visible verdict from the same heuristic used
      // to decide whether to also bump irrelevantCount: deterministic noise
      // reasons → IRRELEVANT (counts as noise on dashboard), otherwise the
      // entry was simply not used in time → IGNORED.
      _activity.activityLog({
        op: 'feedback', source: 'implicit',
        collection: pending.collection,
        pointId: _session.shortPointId(pending.id),
        verdict: deterministicNoise ? 'IRRELEVANT' : 'IGNORED',
        reason: assessment.reason,
        tool: toolName, ..._utils.normalizeSourceMeta(meta),
      });
      delete track.pending[key];
      results.implicitUnused.push({ collection: pending.collection, id: pending.id, reason: assessment.reason });
      continue;
    }

    results.pending.push({ collection: pending.collection, id: pending.id, count: pending.noTouchCount, reason: assessment.reason });
  }

  _session.writeSessionTrack(track, meta);
  return results;
}

async function reconcileStalePromptSuggestions(state, nextPromptMeta = {}) {
  const surfacedIds = promptStateSurfacedIds(state);
  const result = { ok: true, unused: [], irrelevant: [], expired: [] };
  if (!isPromptOnlySuggestionState(state) || surfacedIds.length === 0) return result;

  const surfacedAtMs = state?.ts ? new Date(state.ts).getTime() : 0;
  const ageMs = surfacedAtMs ? Date.now() - surfacedAtMs : Number.POSITIVE_INFINITY;
  if (Number.isFinite(ageMs) && ageMs < PROMPT_STALE_RECONCILE_MS) return result;

  if (Number.isFinite(ageMs) && ageMs > PENDING_HINT_TTL_MS) {
    result.expired.push(...surfacedIds.map(surface => ({ collection: surface.collection, id: surface.id })));
    _activity.activityLog({ op: 'prompt-stale-expired', surfacedCount: surfacedIds.length, ageMs, ..._utils.normalizeSourceMeta(nextPromptMeta) });
    return result;
  }

  const meta = {
    ..._utils.normalizeSourceMeta({
      sourceKind: nextPromptMeta.sourceKind || state.sourceKind || 'codex-hook',
      sourceRuntime: nextPromptMeta.sourceRuntime || state.sourceRuntime || null,
      sourceSession: nextPromptMeta.sourceSession || state.sourceSession || null,
    }),
    cwd: nextPromptMeta.cwd || state.cwd || null,
  };
  const prompt = String(nextPromptMeta.prompt || nextPromptMeta.userPrompt || nextPromptMeta.user_prompt || '');
  const toolInput = { command: prompt, _promptHook: true };

  for (const surface of surfacedIds) {
    let assessment = { touched: false, reason: 'unused' };
    try { assessment = assessHintUsage(surface, 'UserPrompt', toolInput, meta); } catch {}
    const normalizedReason = _session.normalizeNoiseReason(assessment?.reason);
    await _qdrant.updatePointPayload(surface.collection, surface.id, (data) => {
      _hittrack.applyNoiseDispositionData('unused', 'prompt-stale', normalizedReason, { countIrrelevant: !!normalizedReason })(data);
      return data;
    });
    result.unused.push({ collection: surface.collection, id: surface.id, reason: assessment?.reason || 'unused' });
    if (normalizedReason) {
      result.irrelevant.push({ collection: surface.collection, id: surface.id, reason: normalizedReason });
    }
  }

  _activity.activityLog({ op: 'noise-disposition', disposition: 'unused', source: 'prompt-stale', unused: result.unused.length, irrelevant: result.irrelevant.length, expired: result.expired.length, ...meta });
  _activity.activityLog({ op: 'prompt-stale-reconcile', unused: result.unused.length, irrelevant: result.irrelevant.length, expired: result.expired.length, ...meta });
  return result;
}

const _crypto = require('crypto');

function _dedupHash(exp) {
  const key = `${exp.type || ''}:${exp.context || ''}:${(exp.excerpt || '').slice(0, 200)}`;
  return _crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

const _recentHashes = new Map();

function _isDuplicate(hash) {
  const now = Date.now();
  const DEDUP_WINDOW = 24 * 60 * 60 * 1000;
  for (const [k, ts] of _recentHashes) {
    if (now - ts > DEDUP_WINDOW) _recentHashes.delete(k);
  }
  if (_recentHashes.has(hash)) return true;
  _recentHashes.set(hash, now);
  return false;
}

const MAX_EXTRACTIONS_PER_SESSION = 10;

async function extractFromSession(transcript, projectPath, meta = {}) {
  const _log = (msg, data) => {
    const metaData = data || {};
    _logger.log('debug', 'extract_debug', { detail: msg, ...metaData });
    _activity.activityLog({ op: 'extract-debug', msg, ...metaData });
  };
  if (!transcript || transcript.length < 100) {
    _log('transcript too short', { len: transcript?.length || 0, project: projectPath });
    return 0;
  }
  _log('start', { transcriptLen: transcript.length, project: projectPath, meta: { lang: meta?.lang, fw: meta?.framework, slug: meta?.project_slug, runtime: meta?.runtime, sourceKind: meta?.sourceKind }, preDetected: meta?._preDetectedExperiences?.length || 0 });
  const domain = _context.detectTranscriptDomain(transcript);
  _log('domain detected', { domain, project: projectPath });
  // Use pre-detected experiences from client when available (client detects
  // on full transcript; server only sees compact 18KB which loses ~96% of
  // experiences on large sessions).
  const experiences = Array.isArray(meta?._preDetectedExperiences) && meta._preDetectedExperiences.length > 0
    ? meta._preDetectedExperiences
    : (_context.detectExperience
      ? _context.detectExperience(transcript)
      : _context.detectMistakes(transcript));
  _activity.logCostCall('extract', 'local', 'session-extract', _activity.estimateTextUnits(transcript, 12000), { project: projectPath || null, experiences: experiences.length });
  if (experiences.length === 0) {
    _log('no experiences detected', { project: projectPath });
    _activity.activityLog({ op: 'extract', experiences: 0, stored: 0, project: projectPath || null });
    return 0;
  }
  _log('experiences detected', { count: experiences.length, types: experiences.map(e => e.type), project: projectPath });
  _activity.logMistakeSeen(experiences, projectPath);
  let stored = 0;
  const capped = experiences.slice(0, MAX_EXTRACTIONS_PER_SESSION);
  // Dedup SYNCHRONOUSLY up-front. _isDuplicate both checks AND registers the hash, so
  // doing it before any async work also collapses within-batch duplicates and avoids a
  // check-then-register race once the per-experience work runs concurrently below.
  const pending = [];
  for (let i = 0; i < capped.length; i++) {
    const exp = capped[i];
    const hash = _dedupHash(exp);
    if (_isDuplicate(hash)) {
      _log('dedup skip', { i, type: exp.type, hash, project: projectPath });
      _activity.activityLog({ op: 'extract-skip', reason: 'dedup', type: exp.type, hash, project: projectPath || null });
      continue;
    }
    pending.push({ i, exp });
  }

  // Each surviving experience is independent: extractQA (a slow ~9s extract-model LLM
  // call) + quality gate + store. The old fully-sequential loop meant N experiences
  // took N×~9s. Run them with BOUNDED concurrency instead — bounded (not unbounded
  // Promise.all) so a 10-experience session can't hammer the brain provider's rate
  // limit or Qdrant. `stored++` is safe: single-threaded, only mutated synchronously
  // between awaits.
  async function processOne({ i, exp }) {
    try {
      // Per-experience slug (client-resolved from this experience's own touched
      // files) wins over the session-level slug, so a session spanning multiple
      // repos stores each experience scoped to its actual repo instead of NONE.
      // Gate every candidate: extractProjectSlug answers with a PATH-LIKE value
      // (`c:/users`, `d:/personal`, `e:/tiennv`) when it cannot resolve a repo
      // root, and storing that pins the lesson to a slug no caller will ever
      // derive — the passive-hint project gate then hides it from every project,
      // including the one it came from. Unknown must mean global, not a bogus pin.
      const slugCandidate = exp._projectSlug || meta?.project_slug || _utils.extractProjectSlug(projectPath);
      const projectSlug = _utils.isCanonicalProjectSlug(slugCandidate) ? slugCandidate : null;
      if (slugCandidate && !projectSlug) {
        _log('rejected non-canonical project slug → global scope', { i, candidate: slugCandidate });
      }
      _log('calling extractQA', { i, type: exp.type, lang: meta?.lang, fw: meta?.framework, slug: projectSlug, excerptLen: exp?.excerpt?.length });
      const qa = await _brainllm.extractQA(exp, {
        framework: meta?.framework || null,
        lang: meta?.lang || null,
        projectSlug,
      });
      if (!qa) {
        _log('brain returned null', { i, type: exp.type, project: projectPath });
        _activity.activityLog({ op: 'extract-skip', reason: 'brain_null', type: exp.type, project: projectPath || null });
        return;
      }
      if (qa.skip) {
        _log('brain returned skip', { i, type: exp.type, reason: qa.reason, project: projectPath });
        _activity.activityLog({ op: 'extract-skip', reason: qa.reason || 'brain_skip', type: exp.type, project: projectPath || null });
        return;
      }
      _log('QA extracted', { i, type: exp.type, trigger: (qa.trigger || '').slice(0, 80), lang: qa.scope?.lang, fw: qa.scope?.framework, category: qa.category });
      if (meta?.sourceSession && !qa.sourceSession) qa.sourceSession = meta.sourceSession;
      if (exp.type) qa._experienceType = exp.type;
      const quality = _context.assessExtractedQaQuality(qa);
      if (!quality.ok) {
        _log('quality gate rejected', { i, type: exp.type, reason: quality.reason, project: projectPath });
        _activity.activityLog({ op: 'extract-skip', reason: quality.reason, type: exp.type, project: projectPath || null });
        return;
      }
      _log('storing', { i, type: exp.type, domain, slug: projectSlug });
      const result = await _evolution.storeExperience(qa, domain, projectSlug);
      _log('store result', { i, type: exp.type, result: { stored: result?.stored, merged: result?.merged, id: result?.id } });
      if (result?.stored || result?.merged) stored++;
    } catch (err) {
      _log('extract error', { i, type: exp.type, error: err?.message, stack: (err?.stack || '').split('\n').slice(0, 3).join(' | '), project: projectPath });
    }
  }

  const EXTRACT_CONCURRENCY = 4;
  for (let start = 0; start < pending.length; start += EXTRACT_CONCURRENCY) {
    await Promise.all(pending.slice(start, start + EXTRACT_CONCURRENCY).map(processOne));
  }
  _activity.activityLog({ op: 'extract', experiences: experiences.length, capped: capped.length, stored, project: projectPath || null });
  _log('complete', { experiences: experiences.length, stored, project: projectPath });
  return stored;
}

// interceptWithMeta and intercept are exported but remain in experience-core.js
// because they have deep cross-cutting dependencies that would create circular imports.
// This module exports the helper functions they depend on.

module.exports = {
  COLLECTIONS,
  ROUTES_COLLECTION,
  SELFQA_COLLECTION,
  EDGE_COLLECTION,
  DOMAIN_KEYWORDS,
  LANG_MAP,
  PLACEHOLDER_EXTRACT_FIELDS,
  ORGANIC_SUPPORT_STOPWORDS,
  classifyActionKind,
  isAbsolutePath,
  extractPathFromCommand,
  isReadOnlyCommand,
  isHookRealtimeFastPath,
  isPromptHookPrecisionGate,
  promptHookScoreThreshold,
  filterPromptHookPoints,
  isActionKnownHook,
  filterByActionRelevance,
  assessHintUsage,
  promptStateSurfacedIds,
  isPromptOnlySuggestionState,
  reconcilePendingHints,
  stashSurfacedHints,
  reconcileStalePromptSuggestions,
  extractFromSession,
};
