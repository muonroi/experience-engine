/**
 * profile-render.js — "Who Am I" v4.0, slice 2 (profile consumption / injection).
 *
 * PURE renderer: turns the committed dimensions of a profile model (the shape
 * loadProfile() returns, see profile-model.js) into the marker-delimited
 * "## Developer Profile (live)" block that the SessionStart hook injects as
 * hookSpecificOutput.additionalContext.
 *
 * Purity contract (mirrors profile-model.js's aggregate/serialize split): NO fs,
 * NO wall-clock, NO getPrivacyLevel() call inside. The caller (interceptor-session.js)
 * does all I/O and passes `level` + `now` in. This keeps the renderer deterministically
 * golden-testable and lets it later ride agent-md.js byte-identically if needed.
 *
 * Privacy is enforced HERE at injection time, not trusted from the file: the write
 * path (stop-extractor.js maybeUpdateProfile) keeps committed values regardless of
 * privacyLevel, so a standard→minimal downgrade leaves stale Tang-2 values physically
 * in profile.yaml. The reader MUST re-filter by the LIVE level via a POSITIVE
 * per-dimension-NAME allowlist on top of the value!=null committed gate.
 */
'use strict';

// markers — DISTINCT from agent-md.js's experience-engine:* block so applyBlock
// (which keys only on those) can never strip the profile block.
const PROFILE_START = '<!-- experience-profile:start -->';
const PROFILE_END = '<!-- experience-profile:end -->';

// Hard second-defense guard: only these top-level namespaces can ever render.
// A future emotional.* (Tang 3) dim is excluded by construction, even if it were
// mistakenly added to an allowlist.
const ELIGIBLE_NAMESPACES = new Set(['work_patterns', 'communication', 'personality']);

// Tang 1 (work patterns + activity-derived decision_speed). decision_speed is
// namespaced personality.* but its SOURCE is activity (signal-detector.js), so it
// belongs to the minimal tier — the allowlist keys on NAME, never on namespace.
const TIER_MINIMAL = ['work_patterns.energy', 'work_patterns.multitasking', 'work_patterns.session_length', 'personality.decision_speed'];
// Tang 2 (decision + communication style), added at standard.
const TIER_STANDARD = TIER_MINIMAL.concat([
  'communication.question_style', 'communication.feedback_style', 'communication.brevity',
  'personality.conflict_style', 'personality.risk_tolerance',
]);
// `full` is DEFAULT-DENY (same positive allowlist as standard) — no Tang-3 dims
// exist yet, and the polarity guarantees one can never auto-leak when added.
const TIER_ALLOWLIST = { off: [], minimal: TIER_MINIMAL, standard: TIER_STANDARD, full: TIER_STANDARD };

// The coarse work dims commit over 2-3-way splits → confidence routinely 0.45-0.6.
// They get a lower floor so the minimal tier isn't perpetually empty.
const WORK_DIMS = new Set(TIER_MINIMAL);

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_WORK_MIN_CONFIDENCE = 0.45;
const DEFAULT_MAX_DIMS = 10;  // headroom for all 9 emittable dims (was 8 — capped before session_length landed)
const DEFAULT_STALE_DAYS = 60;

const LABELS = {
  'communication.question_style': 'Question style',
  'communication.feedback_style': 'Feedback style',
  'communication.brevity': 'Brevity',
  'personality.conflict_style': 'Conflict style',
  'personality.risk_tolerance': 'Risk tolerance',
  'personality.decision_speed': 'Decision speed',
  'work_patterns.energy': 'Energy',
  'work_patterns.multitasking': 'Multitasking',
  'work_patterns.session_length': 'Session length',
};

// Static, human-reviewed imperative directives (mirrors the GSD "Directives" style).
// Every enumerated value of every allowlisted dimension MUST have an entry — an
// unmapped committed value is skipped with a console.error, never rendered.
// (Phrasing is intentionally first-draft; refine in code review.)
const DIRECTIVES = {
  'communication.question_style': {
    comparison: 'When options are weighed, lead with a decisive recommendation, not an exhaustive survey',
    debugging: 'When a prompt reports a failure, lead with the fix and a one-line root cause',
    exploratory: 'Treat open-ended prompts as investigations — surface feasibility and trade-offs before committing',
    directive: 'Act on clear directives immediately; do not re-confirm what was already asked',
  },
  'communication.feedback_style': {
    implicit: 'Read short acknowledgements as approval; an explicit correction means stop and adjust',
    'precise-correction': 'Expect exact corrections — prioritize accuracy and quote evidence',
  },
  'communication.brevity': {
    concise: 'Keep responses concise and action-first; lead with the change, then a short rationale',
    moderate: 'Use moderate detail — enough context to justify the action without padding',
    verbose: 'Provide thorough, structured explanations with trade-offs',
  },
  'personality.conflict_style': {
    'direct-constructive': 'Disagree openly and constructively; propose the better path with evidence',
    authoritative: 'When the user is decisive, follow their stated approach; flag concerns as brief notes',
    cautious: 'Validate before irreversible steps; confirm assumptions rather than assume',
  },
  'personality.risk_tolerance': {
    experimental: 'Bias toward trying a fix and iterating; do not over-plan low-risk changes',
  },
  'personality.decision_speed': {
    'fast-intuitive': 'Expect fast decisions — present a recommendation, not a menu',
    measured: 'Allow deliberate decisions — lay out the key trade-offs before recommending',
    deliberate: 'Support careful decision-making — surface risks and alternatives explicitly',
  },
  'work_patterns.energy': {
    'night-owl': 'User often works late hours — keep momentum, avoid unnecessary round-trips',
    daytime: 'User works standard daytime hours',
    mixed: 'User works variable hours',
  },
  'work_patterns.multitasking': {
    'task-switcher': 'User juggles multiple projects — keep context self-contained, re-state where needed',
    'sequential-deep': 'User works one thing deeply at a time — go deep, avoid context-switching tangents',
  },
  'work_patterns.session_length': {
    short: 'User works in short bursts — keep answers tight and self-contained; avoid long multi-step detours',
    medium: 'User works in moderate sessions — balance depth with momentum',
    long: 'User runs long deep-work sessions — sustained multi-step work is welcome; keep continuity across steps',
  },
};

// Fixed emit order. Only groups with >=1 selected dim are rendered.
const GROUPS = [
  { title: 'Communication', ns: 'communication' },
  { title: 'Decision & personality', ns: 'personality' },
  { title: 'Work patterns', ns: 'work_patterns' },
];

function groupOf(name) {
  return String(name).split('.')[0] || 'other';
}

/**
 * Select the dimensions eligible for injection at `level`, applying (in order):
 * eligible-namespace guard → positive name allowlist → committed (value!=null) →
 * per-tier confidence floor → directive must exist. Returns a NEW ordered array
 * (confidence desc, then name asc), capped at maxDims. Pure.
 * @returns {Array<{name,value,confidence,samples,label,directive}>}
 */
function selectInjectableDims(profile, level, opts = {}) {
  const allowlist = TIER_ALLOWLIST[level] || [];
  if (!allowlist.length) return [];
  const allow = new Set(allowlist);
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
  const workMinConfidence = Number.isFinite(opts.workMinConfidence) ? opts.workMinConfidence : DEFAULT_WORK_MIN_CONFIDENCE;
  const maxDims = Number.isFinite(opts.maxDims) ? opts.maxDims : DEFAULT_MAX_DIMS;

  const dims = (profile && profile.dimensions) || {};
  const out = [];
  for (const [name, d] of Object.entries(dims)) {
    if (!ELIGIBLE_NAMESPACES.has(groupOf(name))) continue;   // hard Tang-3 guard
    if (!allow.has(name)) continue;                          // positive allowlist
    if (!d || d.value == null) continue;                     // committed-only (N>=10)
    const confidence = Number(d.confidence) || 0;
    const floor = WORK_DIMS.has(name) ? workMinConfidence : minConfidence;
    if (confidence < floor) continue;
    const directive = DIRECTIVES[name] && DIRECTIVES[name][d.value];
    if (!directive) {
      // No-Silent-Catch: a committed value with no directive is a detector/table
      // drift — log it, never inject "undefined".
      console.error(`[profile-render] unmapped dim/value, skipped: ${name}=${d.value}`);
      continue;
    }
    out.push({
      name,
      value: d.value,
      confidence,
      samples: Math.round(Number(d.sampleCount != null ? d.sampleCount : d.samples) || 0),
      label: LABELS[name] || name,
      directive,
    });
  }
  out.sort((a, b) => (b.confidence - a.confidence) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.length > maxDims ? out.slice(0, maxDims) : out;
}

function fmtConfidence(c) {
  return (Number(c) || 0).toFixed(2);
}

/**
 * Render the marker-delimited profile block, or '' when nothing is injectable.
 * Pure: the only clock is `opts.now` (ms), passed in by the caller. Pass it to
 * enable the staleness note; omit it to suppress staleness logic entirely.
 * @param {object} profile  loadProfile() shape
 * @param {object} opts  { level, minConfidence, workMinConfidence, maxDims, now, staleDays }
 * @returns {string}
 */
function renderProfileBlock(profile, opts = {}) {
  const level = opts.level || 'off';
  const dims = selectInjectableDims(profile, level, opts);
  if (!dims.length) return '';

  const lines = [];
  lines.push(PROFILE_START);
  lines.push('## Developer Profile (live — Experience Engine)');
  lines.push('');
  lines.push('Live profile learned from your local sessions. These directives SUPERSEDE any static "## Developer Profile" block. Each line ends with (confidence, n=samples).');

  const updatedAt = profile && profile.updatedAt;
  if (updatedAt) {
    let note = '';
    if (Number.isFinite(opts.now)) {
      const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : DEFAULT_STALE_DAYS;
      const ageMs = opts.now - Date.parse(updatedAt);
      if (Number.isFinite(ageMs) && ageMs > staleDays * 86400000) note = ' (stale — may not reflect recent sessions)';
    }
    lines.push(`Profile last updated: ${updatedAt}${note}.`);
  }

  const byNs = {};
  for (const d of dims) (byNs[groupOf(d.name)] || (byNs[groupOf(d.name)] = [])).push(d);
  for (const g of GROUPS) {
    const list = byNs[g.ns];
    if (!list || !list.length) continue;
    lines.push('');
    lines.push(`**${g.title}**`);
    for (const d of list) {
      lines.push(`- **${d.label}:** ${d.directive}. (${fmtConfidence(d.confidence)}, n=${d.samples})`);
    }
  }

  lines.push(PROFILE_END);
  return lines.join('\n');
}

module.exports = {
  selectInjectableDims,
  renderProfileBlock,
  groupOf,
  PROFILE_START,
  PROFILE_END,
  ELIGIBLE_NAMESPACES,
  TIER_ALLOWLIST,
  WORK_DIMS,
  LABELS,
  DIRECTIVES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_WORK_MIN_CONFIDENCE,
  DEFAULT_STALE_DAYS,
};
