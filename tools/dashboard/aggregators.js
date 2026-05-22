'use strict';

/**
 * aggregators.js — pure functions producing each schema section.
 *
 * Each fn takes pre-collected events + Qdrant payload index and
 * returns a JSON-serializable object matching schema.md.
 *
 * Precision formula (matches exp-gates.js computeInterceptionPrecision):
 *   relevant   = count(verdict in {FOLLOWED, IGNORED})
 *   irrelevant = count(verdict == IRRELEVANT)
 *   precision  = relevant / (relevant + irrelevant)
 *
 * Returns `null` precision when denominator is 0 (insufficient data).
 */

// Bands cover the full [0, 1] range. Sub-0.65 buckets exist because
// entries decay below minConfidence via ignoreCount but their old
// feedback still references them — surface won't happen anymore but
// historical data is meaningful for "what bands were noisy before".
const CONF_BANDS = [
  [0.00, 0.50],   // very decayed — should not surface
  [0.50, 0.65],   // below minConfidence — surface-suppressed
  [0.65, 0.70],   // freshly above min — noisiest band per overview hypothesis
  [0.70, 0.75],
  [0.75, 0.80],
  [0.80, 0.85],
  [0.85, 1.01],   // high — should be most precise
];

const NOISE_REASONS = ['wrong_task', 'wrong_language', 'wrong_repo', 'stale_rule'];

function bandLabel(conf) {
  if (conf == null || !Number.isFinite(conf)) return null;
  for (const [lo, hi] of CONF_BANDS) {
    if (conf >= lo && conf < hi) return `${lo.toFixed(2)}-${hi === 1.01 ? '1.00' : hi.toFixed(2)}`;
  }
  return null;
}

function emptyBucket() {
  return { surfaced: 0, followed: 0, ignored: 0, noise: 0, precision: null };
}

function finalizePrecision(bucket) {
  const classified = bucket.followed + bucket.ignored + bucket.noise;
  bucket.precision = classified > 0 ? (bucket.followed + bucket.ignored) / classified : null;
  return bucket;
}

/**
 * Build a pointId → { collection, confidence, framework, lang, tier,
 * hitCount, ignoreCount, principle, noiseHistory[] } lookup from
 * Qdrant payloads.
 *
 * @param {Map<string, object>} payloadsByCollection — { collection → array of points }
 * @returns {Map<string, object>}
 */
function indexQdrantPoints(payloadsByCollection) {
  // Dual-keyed: full UUID AND 8-char prefix. Activity log records 8-char
  // prefixes (e.g. "e5cec2c8") while Qdrant uses full UUIDs. Looking up
  // either form must hit the same entry.
  const idx = new Map();
  for (const [collection, points] of payloadsByCollection.entries()) {
    for (const p of points) {
      const pl = p.payload || {};
      let j = pl.json;
      if (typeof j === 'string') {
        try { j = JSON.parse(j); } catch { j = {}; }
      }
      j = j || {};
      const fullId = String(p.id);
      const shortId = fullId.slice(0, 8);
      const entry = {
        id: fullId,
        collection,
        confidence: typeof j.confidence === 'number' ? j.confidence : null,
        tier: typeof j.tier === 'number' ? j.tier : null,
        framework: pl.scope_framework || (j.scope && j.scope.framework) || null,
        lang: pl.scope_lang || (j.scope && j.scope.lang) || null,
        hitCount: typeof j.hitCount === 'number' ? j.hitCount : 0,
        ignoreCount: typeof j.ignoreCount === 'number' ? j.ignoreCount : 0,
        principle: (j.principle || j.trigger || '').slice(0, 120),
        noiseHistory: Array.isArray(j.noiseContextHistory) ? j.noiseContextHistory : [],
        shortId,
      };
      idx.set(fullId, entry);
      // Only set short alias if it doesn't already collide — collisions
      // are statistically rare for 8-hex (1 in 4B) but real with seeded ids.
      if (!idx.has(shortId)) idx.set(shortId, entry);
    }
  }
  return idx;
}

/**
 * Build a feedbackPointId → mostRecentInterceptRuntime map.
 * Looks for intercept events where surfaced[].pointId.startsWith(feedback.pointId.slice(0,8))
 * — feedback events often use 8-char prefix IDs.
 */
function buildRuntimeIndex(events) {
  // surfacedShortId → list of { ts, sourceRuntime }
  const surfaceMap = new Map();
  for (const ev of events) {
    if (ev.kind !== 'intercept') continue;
    const surfaced = ev.raw.surfaced || [];
    for (const s of surfaced) {
      const shortId = String(s.pointId || '').slice(0, 8);
      if (!shortId) continue;
      if (!surfaceMap.has(shortId)) surfaceMap.set(shortId, []);
      surfaceMap.get(shortId).push({
        tsMs: ev.tsMs,
        sourceRuntime: ev.raw.sourceRuntime || 'unknown',
        project: ev.raw.project || null,
      });
    }
  }
  return surfaceMap;
}

function lookupRuntimeForFeedback(surfaceMap, feedbackPointId, feedbackTsMs) {
  const shortId = String(feedbackPointId).slice(0, 8);
  const surfaces = surfaceMap.get(shortId);
  if (!surfaces || surfaces.length === 0) return { runtime: 'unknown', project: null };
  // Most recent surface BEFORE feedback ts
  let best = null;
  for (const s of surfaces) {
    if (s.tsMs == null || feedbackTsMs == null) continue;
    if (s.tsMs > feedbackTsMs) continue;
    if (!best || s.tsMs > best.tsMs) best = s;
  }
  if (best) return { runtime: best.sourceRuntime, project: best.project };
  // Fall back to most recent surface regardless of timing
  const last = surfaces[surfaces.length - 1];
  return { runtime: last.sourceRuntime, project: last.project };
}

/**
 * Build runtime distribution over ALL intercept surface events (per
 * surfaced item — multi-surface events count multiple times). Used to
 * fill `surfaced` counts in `precision.byRuntime[]` even when feedback
 * coverage is sparse.
 */
function computeRuntimeSurfaceCounts(events) {
  const byRuntime = new Map();
  for (const ev of events) {
    if (ev.kind !== 'intercept') continue;
    const runtime = ev.raw.sourceRuntime || 'unknown';
    const surfaced = ev.raw.surfaced || [];
    if (!byRuntime.has(runtime)) byRuntime.set(runtime, 0);
    byRuntime.set(runtime, byRuntime.get(runtime) + surfaced.length);
  }
  return byRuntime;
}

function computeFrameworkSurfaceCounts(events, qdrantIdx) {
  const byFw = new Map();
  for (const ev of events) {
    if (ev.kind !== 'intercept') continue;
    const surfaced = ev.raw.surfaced || [];
    for (const s of surfaced) {
      const entry = qdrantIdx.get(String(s.pointId));
      const fw = entry?.framework || 'unknown';
      byFw.set(fw, (byFw.get(fw) || 0) + 1);
    }
  }
  return byFw;
}

function computeBandSurfaceCounts(events, qdrantIdx) {
  const byBand = new Map(); // band label → count
  for (const ev of events) {
    if (ev.kind !== 'intercept') continue;
    const surfaced = ev.raw.surfaced || [];
    for (const s of surfaced) {
      const entry = qdrantIdx.get(String(s.pointId));
      const band = bandLabel(entry?.confidence);
      if (!band) continue;
      byBand.set(band, (byBand.get(band) || 0) + 1);
    }
  }
  return byBand;
}

function computeCollectionSurfaceCounts(events) {
  const byCol = new Map();
  for (const ev of events) {
    if (ev.kind !== 'intercept') continue;
    const surfaced = ev.raw.surfaced || [];
    for (const s of surfaced) {
      const col = s.collection || 'unknown';
      byCol.set(col, (byCol.get(col) || 0) + 1);
    }
  }
  return byCol;
}

/**
 * Main precision computation. Returns Section B of the dashboard JSON.
 *
 * @param {Array} events — typed events from activity-parser
 * @param {Map} qdrantIdx — output of indexQdrantPoints
 */
function computePrecision(events, qdrantIdx) {
  const runtimeIdx = buildRuntimeIndex(events);

  const overall = emptyBucket();
  const byBand = new Map();
  const byCollection = new Map();
  const byFramework = new Map();
  const byRuntime = new Map();
  const noiseReasons = { wrong_task: 0, wrong_language: 0, wrong_repo: 0, stale_rule: 0, unspecified: 0 };

  // Pre-fill surface counts (so even buckets with 0 feedback show activity)
  for (const [band, n] of computeBandSurfaceCounts(events, qdrantIdx)) {
    if (!byBand.has(band)) byBand.set(band, emptyBucket());
    byBand.get(band).surfaced = n;
  }
  for (const [col, n] of computeCollectionSurfaceCounts(events)) {
    if (!byCollection.has(col)) byCollection.set(col, emptyBucket());
    byCollection.get(col).surfaced = n;
  }
  for (const [fw, n] of computeFrameworkSurfaceCounts(events, qdrantIdx)) {
    if (!byFramework.has(fw)) byFramework.set(fw, emptyBucket());
    byFramework.get(fw).surfaced = n;
  }
  for (const [rt, n] of computeRuntimeSurfaceCounts(events)) {
    if (!byRuntime.has(rt)) byRuntime.set(rt, emptyBucket());
    byRuntime.get(rt).surfaced = n;
  }

  // Walk feedback events; bucket each into all 4 dimensions + overall
  for (const ev of events) {
    if (ev.kind !== 'feedback') continue;
    const raw = ev.raw;
    const verdict = raw.verdict;
    if (!verdict) continue;
    const isFollowed = verdict === 'FOLLOWED';
    const isIgnored = verdict === 'IGNORED';
    const isNoise = verdict === 'IRRELEVANT';

    function applyTo(bucket) {
      if (isFollowed) bucket.followed++;
      else if (isIgnored) bucket.ignored++;
      else if (isNoise) bucket.noise++;
    }

    applyTo(overall);

    const entry = qdrantIdx.get(String(raw.pointId)) || null;
    const band = bandLabel(entry?.confidence);
    if (band) {
      if (!byBand.has(band)) byBand.set(band, emptyBucket());
      applyTo(byBand.get(band));
    }

    const col = raw.collection || entry?.collection || 'unknown';
    if (!byCollection.has(col)) byCollection.set(col, emptyBucket());
    applyTo(byCollection.get(col));

    const fw = entry?.framework || 'unknown';
    if (!byFramework.has(fw)) byFramework.set(fw, emptyBucket());
    applyTo(byFramework.get(fw));

    const { runtime } = lookupRuntimeForFeedback(runtimeIdx, raw.pointId, ev.tsMs);
    if (!byRuntime.has(runtime)) byRuntime.set(runtime, emptyBucket());
    applyTo(byRuntime.get(runtime));

    if (isNoise) {
      const reason = raw.reason && NOISE_REASONS.includes(raw.reason) ? raw.reason : 'unspecified';
      noiseReasons[reason]++;
    }
  }

  // Compute no-response (surface - classified) for overall
  const totalSurface = computeRuntimeSurfaceCounts(events);
  let surfacedTotal = 0;
  for (const n of totalSurface.values()) surfacedTotal += n;
  overall.surfaced = surfacedTotal;
  overall.noResponse = Math.max(0, surfacedTotal - overall.followed - overall.ignored - overall.noise);
  finalizePrecision(overall);

  function mapToArray(m, keyName) {
    return [...m.entries()]
      .map(([k, v]) => ({ [keyName]: k, ...finalizePrecision(v) }))
      .sort((a, b) => b.surfaced - a.surfaced);
  }

  return {
    overall,
    byBand: mapToArray(byBand, 'band').sort((a, b) => a.band.localeCompare(b.band)),
    byCollection: mapToArray(byCollection, 'collection'),
    byFramework: mapToArray(byFramework, 'framework').slice(0, 10),
    byRuntime: mapToArray(byRuntime, 'runtime'),
    noiseReasons,
  };
}

/**
 * Section C — hit funnel at 7d + 30d windows.
 * Each window: surface attempts → outcomes split by verdict.
 *
 * @param {Array} events — already-filtered to widest window (caller passes 30d)
 * @returns {{ "7d": object, "30d": object }}
 */
function computeFunnel(events) {
  const now = Date.now();
  const windows = {
    '7d': now - 7 * 86_400_000,
    '30d': now - 30 * 86_400_000,
  };

  const out = {};
  for (const [label, cutoff] of Object.entries(windows)) {
    let surfaced = 0, followed = 0, ignored = 0, noise = 0;
    for (const ev of events) {
      if (ev.tsMs == null || ev.tsMs < cutoff) continue;
      if (ev.kind === 'intercept') {
        const arr = ev.raw.surfaced || [];
        surfaced += arr.length;
      } else if (ev.kind === 'feedback') {
        if (ev.raw.verdict === 'FOLLOWED') followed++;
        else if (ev.raw.verdict === 'IGNORED') ignored++;
        else if (ev.raw.verdict === 'IRRELEVANT') noise++;
      }
    }
    const noResponse = Math.max(0, surfaced - followed - ignored - noise);
    out[label] = {
      surfaced,
      followed,
      ignored,
      noise,
      noResponse,
      totalEvents: surfaced + followed + ignored + noise,
    };
  }
  return out;
}

/**
 * Section F — top noise offenders sorted by ignoreRatio desc.
 *
 * @param {Map} qdrantIdx — output of indexQdrantPoints (dual-keyed)
 * @param {{ minSurfaceCount?: number, limit?: number }} opts
 */
function computeTopOffenders(qdrantIdx, opts = {}) {
  const minSurface = opts.minSurfaceCount ?? 5;
  const limit = opts.limit ?? 20;

  // De-dup by full id (idx is dual-keyed)
  const seen = new Set();
  const candidates = [];
  for (const entry of qdrantIdx.values()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const surfaceCount = entry.hitCount + entry.ignoreCount;
    if (surfaceCount < minSurface) continue;
    const denom = entry.hitCount + entry.ignoreCount;
    const ignoreRatio = denom > 0 ? entry.ignoreCount / denom : 0;
    const lastNoiseReasons = (entry.noiseHistory || [])
      .slice(-5)
      .map((h) => h.reason || h.r || 'unspecified');
    candidates.push({
      id: entry.id,
      collection: entry.collection,
      tier: entry.tier,
      confidence: entry.confidence,
      surfaceCount,
      ignoreCount: entry.ignoreCount,
      hitCount: entry.hitCount,
      ignoreRatio,
      framework: entry.framework,
      lang: entry.lang,
      principle: entry.principle,
      lastNoiseReasons,
    });
  }

  candidates.sort((a, b) => (b.ignoreRatio - a.ignoreRatio) || (b.surfaceCount - a.surfaceCount));
  return candidates.slice(0, limit);
}

/**
 * Section A — gate status, adapted from exp-gates.js --json output.
 *
 * Maps each check's `name` (e.g. "4. Interception accurate") to a stable
 * machine ID per schema.md. Unknown checks fall through with `id` derived
 * from the leading numeric prefix.
 *
 * @param {object} expGatesJson — parsed output of `node tools/exp-gates.js --json`
 */
function computeGateStatus(expGatesJson) {
  const NAME_TO_ID = {
    '1. Extraction works':      'extraction_works',
    '2. Dedup / hygiene works': 'dedup_hygiene',
    '3. Interception fires':    'interception_fires',
    '4. Interception accurate': 'interception_precision',
    '5. Non-blocking':          'non_blocking',
    '6. Error recurrence drops':'error_recurrence',
    '7. Evolution works':       'evolution_works',
    '8. Memory shrinks':        'memory_shrinks',
    '9. Novel coverage':        'novel_coverage',
    '10. Cost stable':          'cost_stable',
    '11. Noise self-correction':'auto_narrow_scope',
    '12. Cross-CLI parity':     'cross_cli_parity',
    '13. Brain filter precision': 'brain_filter_precision',
    '14. Surface->follow ratio':'surface_follow_ratio_p75',
  };

  function classify(check) {
    if (check.pass === true) return 'pass';
    if (check.pass === false) return 'fail';
    if (/no data|pending|tba|tbd|n\/?a/i.test(String(check.actual || ''))) return 'pending';
    return 'fail';
  }

  function mapCheck(c) {
    const id = NAME_TO_ID[c.name] || (c.name || '').split('.')[0].trim() || 'unknown';
    return {
      id,
      label: c.name,
      status: classify(c),
      current: c.actual ?? null,
      target: c.target ?? null,
      must: c.must === true,
    };
  }

  const gate1Pass = expGatesJson?.gate1?.pass === true;
  const gate2Checks = (expGatesJson?.gate2?.checks || []).map(mapCheck);
  const must = gate2Checks.filter((c) => c.must);
  const should = gate2Checks.filter((c) => !c.must);
  const mustPassed = must.filter((c) => c.status === 'pass').length;
  const shouldPassed = should.filter((c) => c.status === 'pass').length;

  // Gate 3 — acceptance Q1-Q4 (exp-gates.js doesn't expose these directly today;
  // mirror its `gate3` block if present, else compute from gate2 signals).
  const gate3Raw = expGatesJson?.gate3 || {};
  const acceptance = {
    Q1: gate3Raw.Q1 || 'pending',
    Q2: gate3Raw.Q2 || 'pending',
    Q3: gate3Raw.Q3 || 'pending',
    Q4: gate3Raw.Q4 || 'pending',
  };

  const failingMust = must.filter((c) => c.status === 'fail').map((c) => c.id);
  const verdict = gate1Pass
    ? `Gate 1 OK, Gate 2 ${mustPassed}/${must.length} MUST + ${shouldPassed}/${should.length} SHOULD${failingMust.length ? ` — failing: ${failingMust.join(', ')}` : ''}`
    : 'Gate 1 build FAILING — fix before dogfood metrics matter';

  return {
    build: gate1Pass ? 'pass' : 'fail',
    dogfood: {
      must: { passed: mustPassed, total: must.length, items: must },
      should: { passed: shouldPassed, total: should.length, items: should },
      failing: failingMust,
    },
    acceptance,
    verdict,
  };
}

function shortenQuery(q) {
  if (!q) return '';
  const s = String(q).replace(/\s+/g, ' ').trim();
  if (s.length <= 80) return s;
  return s.slice(0, 77) + '…';
}

function projectSlug(projectPath) {
  if (!projectPath) return null;
  const parts = String(projectPath).replace(/\\/g, '/').split('/').filter(Boolean);
  // Pick the last segment that looks like a repo root (drop file/dir tail)
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (/\.(cs|ts|tsx|js|jsx|md|json|css)$/i.test(seg)) continue;
    if (seg.length > 50) continue;
    return seg.toLowerCase();
  }
  return parts[parts.length - 1] ? parts[parts.length - 1].toLowerCase() : null;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h${r}m` : `${h}h`;
}

/**
 * Section S — per-session drill-down.
 *
 * Groups intercept/posttool/feedback events by sourceSession. For each
 * session: list unique hints surfaced, each with the action(s) that
 * triggered them and the matching feedback verdict (if any).
 *
 * Output is consumed BOTH by agents (JSON shape) AND humans (HTML render
 * walks the same structure).
 *
 * @param {Array} events — typed events from activity-parser
 * @param {Map} qdrantIdx — output of indexQdrantPoints (dual-keyed)
 * @param {{ limit?: number, minHints?: number }} opts
 */
function computeSessions(events, qdrantIdx, opts = {}) {
  const limit = opts.limit ?? 50;
  const minHints = opts.minHints ?? 1;
  // Include silent sessions (intercepts ≥ this, but 0 surfaced hints) — surface
  // them with empty hints[] + silent:true so the dashboard can show "brain
  // never fired for this big session" as a v3.0 effectiveness signal.
  const silentSessionMinIntercepts = opts.silentSessionMinIntercepts ?? 50;

  // Index feedback events by pointId for fast lookup.
  // Multiple feedbacks per pointId possible; we keep the closest-in-time
  // one to each surface (best match per session).
  const feedbacksByPid = new Map();
  for (const ev of events) {
    if (ev.kind !== 'feedback') continue;
    const pid = String(ev.raw.pointId || '');
    if (!pid) continue;
    if (!feedbacksByPid.has(pid)) feedbacksByPid.set(pid, []);
    feedbacksByPid.get(pid).push({
      tsMs: ev.tsMs,
      verdict: ev.raw.verdict,
      reason: ev.raw.reason || null,
      collection: ev.raw.collection || null,
    });
  }

  // Group events by session
  const bySession = new Map();
  for (const ev of events) {
    if (ev.kind !== 'intercept' && ev.kind !== 'posttool') continue;
    const sid = ev.raw.sourceSession;
    if (!sid) continue;
    if (!bySession.has(sid)) {
      bySession.set(sid, {
        sessionId: String(sid).slice(0, 8),
        fullSessionId: String(sid),
        runtime: ev.raw.sourceRuntime || 'unknown',
        project: null,
        projectSlug: null,
        firstMs: ev.tsMs,
        lastMs: ev.tsMs,
        intercepts: 0,
        posttools: 0,
        surfaces: [],            // per-action surface records (flat)
      });
    }
    const s = bySession.get(sid);
    if (ev.tsMs != null) {
      if (s.firstMs == null || ev.tsMs < s.firstMs) s.firstMs = ev.tsMs;
      if (s.lastMs == null || ev.tsMs > s.lastMs) s.lastMs = ev.tsMs;
    }
    if (ev.raw.project && !s.project) {
      s.project = ev.raw.project;
      s.projectSlug = projectSlug(ev.raw.project);
    }
    if (ev.kind === 'intercept') {
      s.intercepts++;
      const surfaced = ev.raw.surfaced || [];
      for (const sf of surfaced) {
        s.surfaces.push({
          ts: ev.ts,
          tsMs: ev.tsMs,
          tool: ev.raw.tool || null,
          query: ev.raw.query || null,
          pointId: String(sf.pointId || ''),
          collection: sf.collection || null,
          project: ev.raw.project || null,
        });
      }
    } else if (ev.kind === 'posttool') {
      s.posttools++;
    }
  }

  // Build session items: roll up surfaces into per-hint blocks
  const items = [];
  for (const s of bySession.values()) {
    // Silent session: had intercepts but brain never surfaced anything.
    // Emit a stub so the v3.0 silence is visible in the dashboard.
    if (s.surfaces.length === 0) {
      if (s.intercepts < silentSessionMinIntercepts) continue;
      items.push({
        sessionId: s.sessionId,
        fullSessionId: s.fullSessionId,
        runtime: s.runtime,
        project: s.project,
        projectSlug: s.projectSlug,
        firstActivity: s.firstMs ? new Date(s.firstMs).toISOString() : null,
        lastActivity: s.lastMs ? new Date(s.lastMs).toISOString() : null,
        duration: s.firstMs && s.lastMs ? fmtDuration(s.lastMs - s.firstMs) : '?',
        silent: true,
        stats: {
          intercepts: s.intercepts,
          surfacedHints: 0,
          uniqueHints: 0,
          posttools: s.posttools,
          feedback: { followed: 0, ignored: 0, noise: 0 },
        },
        hints: [],
      });
      continue;
    }

    // Group surfaces by pointId
    const byHint = new Map();
    for (const sf of s.surfaces) {
      if (!sf.pointId) continue;
      if (!byHint.has(sf.pointId)) byHint.set(sf.pointId, []);
      byHint.get(sf.pointId).push(sf);
    }

    const hints = [];
    let followed = 0, ignored = 0, noise = 0;
    for (const [pid, surfaces] of byHint.entries()) {
      const entry = qdrantIdx.get(pid) || null;
      surfaces.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

      // Find the closest feedback within the session window
      const fbList = feedbacksByPid.get(pid) || [];
      const sessFb = fbList.filter((fb) =>
        fb.tsMs != null && s.firstMs != null && s.lastMs != null &&
        fb.tsMs >= s.firstMs && fb.tsMs <= s.lastMs + 30 * 60_000); // +30min grace
      const feedback = sessFb[0] || null;

      if (feedback) {
        if (feedback.verdict === 'FOLLOWED') followed++;
        else if (feedback.verdict === 'IGNORED') ignored++;
        else if (feedback.verdict === 'IRRELEVANT') noise++;
      }

      hints.push({
        pointId: pid,
        collection: entry?.collection || surfaces[0].collection || 'unknown',
        framework: entry?.framework || null,
        lang: entry?.lang || null,
        confidence: entry?.confidence ?? null,
        tier: entry?.tier ?? null,
        principleSnippet: entry?.principle || '',
        surfaceCount: surfaces.length,
        surfaces: surfaces.map((sf) => ({
          ts: sf.ts,
          tool: sf.tool,
          query: sf.query,
          queryPreview: shortenQuery(sf.query),
        })),
        feedback: feedback
          ? { verdict: feedback.verdict, reason: feedback.reason, ts: new Date(feedback.tsMs).toISOString() }
          : null,
      });
    }
    if (hints.length < minHints) continue;

    hints.sort((a, b) => b.surfaceCount - a.surfaceCount);

    items.push({
      sessionId: s.sessionId,
      fullSessionId: s.fullSessionId,
      runtime: s.runtime,
      project: s.project,
      projectSlug: s.projectSlug,
      firstActivity: s.firstMs ? new Date(s.firstMs).toISOString() : null,
      lastActivity: s.lastMs ? new Date(s.lastMs).toISOString() : null,
      duration: s.firstMs && s.lastMs ? fmtDuration(s.lastMs - s.firstMs) : '?',
      stats: {
        intercepts: s.intercepts,
        surfacedHints: s.surfaces.length,
        uniqueHints: hints.length,
        posttools: s.posttools,
        feedback: { followed, ignored, noise },
      },
      hints,
    });
  }

  // Sort by lastActivity desc — most recent sessions first
  items.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

  return {
    windowDays: opts.windowDays || 30,
    totalSessions: items.length,
    items: items.slice(0, limit),
  };
}

/**
 * Flat CSV export — one row per surface action, joining hint + feedback.
 * Easy to load into spreadsheets or pandas.
 */
function exportSessionsToCsv(sessions) {
  const header = [
    'session_id', 'runtime', 'project_slug', 'project', 'first_activity',
    'surface_ts', 'tool', 'query_preview',
    'point_id', 'collection', 'framework', 'lang', 'confidence', 'tier',
    'principle_snippet',
    'feedback_verdict', 'feedback_reason', 'feedback_ts',
  ];

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const lines = [header.join(',')];
  for (const sess of sessions.items) {
    for (const hint of sess.hints) {
      for (const sf of hint.surfaces) {
        const row = [
          sess.sessionId,
          sess.runtime,
          sess.projectSlug,
          sess.project,
          sess.firstActivity,
          sf.ts,
          sf.tool,
          sf.queryPreview,
          hint.pointId,
          hint.collection,
          hint.framework,
          hint.lang,
          hint.confidence,
          hint.tier,
          hint.principleSnippet,
          hint.feedback?.verdict || '',
          hint.feedback?.reason || '',
          hint.feedback?.ts || '',
        ];
        lines.push(row.map(csvEscape).join(','));
      }
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  CONF_BANDS,
  NOISE_REASONS,
  bandLabel,
  emptyBucket,
  finalizePrecision,
  indexQdrantPoints,
  buildRuntimeIndex,
  lookupRuntimeForFeedback,
  computePrecision,
  computeFunnel,
  computeTopOffenders,
  computeGateStatus,
  computeSessions,
  exportSessionsToCsv,
  projectSlug,
  shortenQuery,
  fmtDuration,
};
