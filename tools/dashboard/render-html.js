'use strict';

/**
 * render-html.js — single-file HTML report from dashboard snapshot.
 *
 * Renders Sections A (gate status), B (precision drill-down),
 * C (funnel), F (top offenders). No external runtime deps — Chart.js
 * loaded from CDN; entire HTML self-contained otherwise.
 *
 * The HTML is for human eyeballing. Agents read latest.json directly.
 */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

function num(n) {
  if (n == null) return '—';
  return String(n);
}

function statusBadge(status) {
  const cls = status === 'pass' ? 'badge-pass'
    : status === 'fail' ? 'badge-fail'
    : 'badge-pending';
  return `<span class="badge ${cls}">${status.toUpperCase()}</span>`;
}

function renderGates(g) {
  const mustRows = g.dogfood.must.items.map((it) => `
    <tr>
      <td>${escapeHtml(it.label)}</td>
      <td>${statusBadge(it.status)}</td>
      <td class="muted">${escapeHtml(num(it.current))}</td>
      <td class="muted">${escapeHtml(num(it.target))}</td>
    </tr>`).join('');
  const shouldRows = g.dogfood.should.items.map((it) => `
    <tr>
      <td>${escapeHtml(it.label)}</td>
      <td>${statusBadge(it.status)}</td>
      <td class="muted">${escapeHtml(num(it.current))}</td>
      <td class="muted">${escapeHtml(num(it.target))}</td>
    </tr>`).join('');

  return `
  <section>
    <h2>A. Gate Status</h2>
    <p class="verdict">${escapeHtml(g.verdict)}</p>
    <div class="grid-2">
      <div>
        <h3>Gate 2 — MUST (${g.dogfood.must.passed}/${g.dogfood.must.total})</h3>
        <table>
          <thead><tr><th>Criterion</th><th>Status</th><th>Current</th><th>Target</th></tr></thead>
          <tbody>${mustRows}</tbody>
        </table>
      </div>
      <div>
        <h3>Gate 2 — SHOULD (${g.dogfood.should.passed}/${g.dogfood.should.total})</h3>
        <table>
          <thead><tr><th>Criterion</th><th>Status</th><th>Current</th><th>Target</th></tr></thead>
          <tbody>${shouldRows}</tbody>
        </table>
        <h3 style="margin-top:1.5rem">Gate 3 — Acceptance</h3>
        <table>
          <tbody>
            <tr><td>Q1 mistake avoidance</td><td>${statusBadge(g.acceptance.Q1)}</td></tr>
            <tr><td>Q2 novel coverage</td><td>${statusBadge(g.acceptance.Q2)}</td></tr>
            <tr><td>Q3 memory shrinks</td><td>${statusBadge(g.acceptance.Q3)}</td></tr>
            <tr><td>Q4 auto-narrow</td><td>${statusBadge(g.acceptance.Q4)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderPrecisionSince(ps) {
  if (!ps) return '';
  const verdictClass = ps.verdict === 'PASS_TRENDING' ? 'good'
    : ps.verdict === 'BELOW_TARGET' ? 'warn'
    : ps.verdict === 'GATE_STALLED' ? 'bad'
    : 'muted';
  const reasonRows = Object.entries(ps.reasonMix || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${v}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="muted">No irrelevant feedback since gate went live.</td></tr>`;
  const precStr = ps.precision == null ? '—' : pct(ps.precision);
  const note = ps.verdict === 'INSUFFICIENT_DATA'
    ? `Need ${ps.minClassified} classified (have ${ps.classified}) for a confident read — keep using normally, recheck tomorrow.`
    : ps.verdict === 'GATE_STALLED'
      ? 'Pre-surface gate dropped 0 hints — fix not engaging, investigate now.'
      : ps.verdict === 'PASS_TRENDING'
        ? `At/above the ${pct(ps.target)} target — the 7-day gate will converge here.`
        : `Below the ${pct(ps.target)} target — investigate without waiting for the 7-day window.`;
  return `
  <section>
    <h2>A2. Post-Deploy Precision (early warning)</h2>
    <p class="muted">Precision over events since the pre-surface relevance gate went live${ps.gateLiveTs ? ` (${escapeHtml(ps.gateLiveTs)})` : ''}. Sidesteps the 7-day rolling window so a fix is visible in ~1–2 days.</p>
    <div class="kpi">
      <div class="kpi-label">Verdict</div>
      <div class="kpi-value ${verdictClass}">${escapeHtml(ps.verdict)}</div>
      <div class="kpi-sub">${escapeHtml(note)}</div>
    </div>
    <div class="grid-2">
      <div>
        <h3>Post-gate precision</h3>
        <table style="max-width:24rem">
          <tbody>
            <tr><td>Precision</td><td class="num ${verdictClass}">${precStr}</td></tr>
            <tr><td>Relevant</td><td class="num">${ps.relevant}</td></tr>
            <tr><td>Irrelevant</td><td class="num">${ps.irrelevant}</td></tr>
            <tr><td>Classified</td><td class="num">${ps.classified} / ${ps.minClassified} min</td></tr>
            <tr><td>Gate drops</td><td class="num">${ps.gateDropped} (${ps.gateEvents} events)</td></tr>
          </tbody>
        </table>
      </div>
      <div>
        <h3>Remaining irrelevant by reason</h3>
        <table style="max-width:24rem">
          <thead><tr><th>Reason</th><th class="num">Count</th></tr></thead>
          <tbody>${reasonRows}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderPrecisionTable(rows, keyName, keyLabel) {
  if (!rows || rows.length === 0) {
    return `<p class="muted">No data.</p>`;
  }
  const tbody = rows.map((r) => {
    const p = r.precision;
    const colorClass = p == null ? 'muted'
      : p >= 0.70 ? 'good'
      : p >= 0.40 ? 'warn'
      : 'bad';
    return `<tr>
      <td>${escapeHtml(r[keyName])}</td>
      <td class="num">${r.surfaced}</td>
      <td class="num">${r.followed}</td>
      <td class="num">${r.ignored}</td>
      <td class="num">${r.noise}</td>
      <td class="num ${colorClass}">${pct(p)}</td>
    </tr>`;
  }).join('');
  return `
    <table>
      <thead><tr>
        <th>${escapeHtml(keyLabel)}</th>
        <th class="num">Surfaced</th>
        <th class="num">Followed</th>
        <th class="num">Ignored</th>
        <th class="num">Noise</th>
        <th class="num">Precision</th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

function renderPrecision(p) {
  const noiseRows = Object.entries(p.noiseReasons)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${v}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="muted">No noise feedback recorded.</td></tr>`;

  const overallClass = p.overall.precision == null ? 'muted'
    : p.overall.precision >= 0.70 ? 'good'
    : p.overall.precision >= 0.40 ? 'warn'
    : 'bad';

  return `
  <section>
    <h2>B. Precision Drill-Down</h2>
    <div class="kpi">
      <div class="kpi-label">Overall precision</div>
      <div class="kpi-value ${overallClass}">${pct(p.overall.precision)}</div>
      <div class="kpi-sub">${p.overall.surfaced} surfaced · ${p.overall.followed} followed · ${p.overall.ignored} ignored · ${p.overall.noise} noise</div>
    </div>
    <div class="grid-2">
      <div>
        <h3>By Confidence Band</h3>
        ${renderPrecisionTable(p.byBand, 'band', 'Band')}
      </div>
      <div>
        <h3>By Collection</h3>
        ${renderPrecisionTable(p.byCollection, 'collection', 'Collection')}
      </div>
    </div>
    <div class="grid-2">
      <div>
        <h3>By Framework (top 10)</h3>
        ${renderPrecisionTable(p.byFramework, 'framework', 'Framework')}
      </div>
      <div>
        <h3>By Runtime</h3>
        ${renderPrecisionTable(p.byRuntime, 'runtime', 'Runtime')}
      </div>
    </div>
    <h3>Noise Reasons</h3>
    <table style="max-width:24rem">
      <thead><tr><th>Reason</th><th class="num">Count</th></tr></thead>
      <tbody>${noiseRows}</tbody>
    </table>
  </section>`;
}

function renderFunnel(f) {
  function row(label, w) {
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td class="num">${w.surfaced}</td>
      <td class="num">${w.followed}</td>
      <td class="num">${w.ignored}</td>
      <td class="num">${w.noise}</td>
      <td class="num muted">${w.noResponse}</td>
    </tr>`;
  }
  return `
  <section>
    <h2>C. Hit Funnel</h2>
    <table>
      <thead><tr>
        <th>Window</th>
        <th class="num">Surfaced</th>
        <th class="num good">Followed</th>
        <th class="num">Ignored</th>
        <th class="num bad">Noise</th>
        <th class="num muted">No response</th>
      </tr></thead>
      <tbody>
        ${row('7d', f['7d'])}
        ${row('30d', f['30d'])}
      </tbody>
    </table>
  </section>`;
}

function renderOffenders(rows) {
  if (!rows || rows.length === 0) {
    return `<section><h2>F. Top Noise Offenders</h2><p class="muted">No entries meet inclusion threshold.</p></section>`;
  }
  const body = rows.map((r) => {
    const ratioClass = r.ignoreRatio >= 0.8 ? 'bad' : r.ignoreRatio >= 0.5 ? 'warn' : 'good';
    return `<tr>
      <td class="mono">${escapeHtml(String(r.id).slice(0, 8))}</td>
      <td>${escapeHtml(r.collection.replace('experience-', ''))}</td>
      <td class="num">T${r.tier ?? '?'}</td>
      <td class="num">${pct(r.confidence)}</td>
      <td class="num">${r.surfaceCount}</td>
      <td class="num ${ratioClass}">${pct(r.ignoreRatio)}</td>
      <td>${escapeHtml(r.framework || '—')}</td>
      <td>${escapeHtml((r.lastNoiseReasons || []).join(', ') || '—')}</td>
      <td title="${escapeHtml(r.principle)}">${escapeHtml((r.principle || '').slice(0, 60))}${(r.principle || '').length > 60 ? '…' : ''}</td>
    </tr>`;
  }).join('');
  return `
  <section>
    <h2>F. Top Noise Offenders (top ${rows.length})</h2>
    <table class="offenders">
      <thead><tr>
        <th>ID</th>
        <th>Coll</th>
        <th>Tier</th>
        <th>Conf</th>
        <th class="num">Surf</th>
        <th class="num">Ignore%</th>
        <th>Framework</th>
        <th>Last noise reasons</th>
        <th>Principle</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderSessions(sessions) {
  const items = sessions.items || [];
  if (items.length === 0) {
    return `<section><h2>S. Session Drill-Down</h2><p class="muted">No sessions with surfaced hints in window.</p></section>`;
  }

  // Build distinct values for filters
  const runtimes = [...new Set(items.map((s) => s.runtime).filter(Boolean))].sort();
  const projects = [...new Set(items.map((s) => s.projectSlug).filter(Boolean))].sort();

  const runtimeOpts = runtimes.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
  const projectOpts = projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

  const cards = items.map((s) => {
    const fbStats = s.stats.feedback;
    if (s.silent) {
      return `
      <details class="session silent" data-runtime="${escapeHtml(s.runtime)}" data-project="${escapeHtml(s.projectSlug || '')}" data-noise="0" data-followed="0">
        <summary>
          <span class="mono">${escapeHtml(s.sessionId)}</span>
          <span class="tag">${escapeHtml(s.runtime)}</span>
          <span class="proj">${escapeHtml(s.projectSlug || '?')}</span>
          <span class="muted">${escapeHtml((s.firstActivity || '').slice(0, 16))} · ${escapeHtml(s.duration)}</span>
          <span class="stats silent-stat">⚠ silent: ${s.stats.intercepts} intercepts · 0 surfaced</span>
        </summary>
        <div class="hints"><div class="silent-note muted">Brain saw ${s.stats.intercepts} tool calls in this session but never surfaced a hint. Possible causes: confidence below threshold, scope filters excluded all candidates, or no relevant principle exists for this project/language combination yet.</div></div>
      </details>`;
    }
    const hintRows = s.hints.map((h) => {
      const fbClass = !h.feedback ? 'fb-none'
        : h.feedback.verdict === 'FOLLOWED' ? 'fb-followed'
        : h.feedback.verdict === 'IGNORED' ? 'fb-ignored'
        : 'fb-noise';
      const fbLabel = !h.feedback ? 'no-feedback'
        : `${h.feedback.verdict}${h.feedback.reason ? ` (${h.feedback.reason})` : ''}`;
      const surfaces = h.surfaces.map((sf) => `
        <div class="surface">
          <span class="ts">${escapeHtml((sf.ts || '').slice(11, 19))}</span>
          <span class="tool">${escapeHtml(sf.tool || '?')}</span>
          <span class="query mono">${escapeHtml(sf.queryPreview || '')}</span>
        </div>`).join('');
      return `
        <details class="hint ${fbClass}">
          <summary>
            <span class="mono">${escapeHtml(h.pointId.slice(0, 8))}</span>
            <span class="hint-col">${escapeHtml(h.collection.replace('experience-', ''))}</span>
            ${h.framework ? `<span class="tag">${escapeHtml(h.framework)}</span>` : ''}
            <span class="hint-conf">${pct(h.confidence)}</span>
            <span class="hint-surf">${h.surfaceCount}×</span>
            <span class="fb-badge ${fbClass}">${escapeHtml(fbLabel)}</span>
            <span class="hint-principle">${escapeHtml((h.principleSnippet || '').slice(0, 80))}${(h.principleSnippet || '').length > 80 ? '…' : ''}</span>
          </summary>
          <div class="surfaces">${surfaces}</div>
        </details>`;
    }).join('');

    return `
      <details class="session" data-runtime="${escapeHtml(s.runtime)}" data-project="${escapeHtml(s.projectSlug || '')}" data-noise="${fbStats.noise}" data-followed="${fbStats.followed}">
        <summary>
          <span class="mono">${escapeHtml(s.sessionId)}</span>
          <span class="tag">${escapeHtml(s.runtime)}</span>
          <span class="proj">${escapeHtml(s.projectSlug || '?')}</span>
          <span class="muted">${escapeHtml((s.firstActivity || '').slice(0, 16))} · ${escapeHtml(s.duration)}</span>
          <span class="stats">
            ${s.stats.surfacedHints} surf
            · <span class="good">${fbStats.followed}✓</span>
            · ${fbStats.ignored}⊘
            · <span class="bad">${fbStats.noise}✗</span>
          </span>
        </summary>
        <div class="hints">${hintRows}</div>
      </details>`;
  }).join('');

  return `
  <section>
    <h2>S. Session Drill-Down (${items.length} sessions)</h2>
    <p class="muted">Per-session hint trace. Click a session row to expand its hints, click a hint to see the tool action(s) that triggered it.</p>

    <div class="filters">
      <input type="search" id="filter-q" placeholder="Search query / principle / hint id…">
      <select id="filter-runtime">
        <option value="">All runtimes</option>${runtimeOpts}
      </select>
      <select id="filter-project">
        <option value="">All projects</option>${projectOpts}
      </select>
      <select id="filter-feedback">
        <option value="">All feedback</option>
        <option value="followed">Has followed</option>
        <option value="noise">Has noise</option>
      </select>
      <button type="button" id="expand-all">Expand all</button>
      <button type="button" id="collapse-all">Collapse all</button>
    </div>

    <div id="sessions-list">${cards}</div>

    <script>
      (function () {
        const q = document.getElementById('filter-q');
        const rt = document.getElementById('filter-runtime');
        const pj = document.getElementById('filter-project');
        const fb = document.getElementById('filter-feedback');
        const sessions = document.querySelectorAll('#sessions-list > details.session');

        function apply() {
          const qv = (q.value || '').toLowerCase().trim();
          const rtv = rt.value;
          const pjv = pj.value;
          const fbv = fb.value;
          for (const s of sessions) {
            let show = true;
            if (rtv && s.dataset.runtime !== rtv) show = false;
            if (pjv && s.dataset.project !== pjv) show = false;
            if (fbv === 'followed' && parseInt(s.dataset.followed || '0', 10) === 0) show = false;
            if (fbv === 'noise' && parseInt(s.dataset.noise || '0', 10) === 0) show = false;
            if (qv) {
              const txt = s.textContent.toLowerCase();
              if (!txt.includes(qv)) show = false;
            }
            s.style.display = show ? '' : 'none';
          }
        }
        for (const el of [q, rt, pj, fb]) el.addEventListener('input', apply);
        document.getElementById('expand-all').addEventListener('click', () => {
          for (const s of sessions) if (s.style.display !== 'none') s.open = true;
        });
        document.getElementById('collapse-all').addEventListener('click', () => {
          for (const s of sessions) s.open = false;
        });
      })();
    </script>
  </section>`;
}

const CSS = `
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 1280px; margin: 1.5rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.45; }
  h1 { border-bottom: 2px solid #ddd; padding-bottom: 0.5rem; }
  h2 { margin-top: 2.5rem; color: #1f3a93; }
  h3 { margin-top: 1.5rem; font-size: 1.05rem; color: #555; }
  section { margin-bottom: 2.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  th { background: #fafafa; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.3rem; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; }
  .badge-pass { background: #d4edda; color: #155724; }
  .badge-fail { background: #f8d7da; color: #721c24; }
  .badge-pending { background: #fff3cd; color: #856404; }
  .good { color: #155724; font-weight: 600; }
  .warn { color: #856404; font-weight: 600; }
  .bad { color: #721c24; font-weight: 600; }
  .muted { color: #999; }
  .verdict { background: #f3f4f6; padding: 0.75rem 1rem; border-left: 4px solid #1f3a93; font-style: italic; }
  .kpi { padding: 1rem; background: #fafafa; border-radius: 0.5rem; margin-bottom: 1rem; }
  .kpi-label { font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
  .kpi-value { font-size: 2.5rem; font-weight: 700; margin: 0.2rem 0; }
  .kpi-sub { font-size: 0.85rem; color: #555; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85rem; }
  .meta { color: #999; font-size: 0.82rem; margin-top: 3rem; border-top: 1px solid #eee; padding-top: 1rem; }
  table.offenders { font-size: 0.85rem; }
  table.offenders td { padding: 0.3rem 0.5rem; }

  /* Session drill-down */
  .filters { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .filters input, .filters select, .filters button { padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 0.3rem; font-size: 0.9rem; background: #fff; cursor: pointer; }
  .filters input[type="search"] { min-width: 18rem; }
  .filters button:hover { background: #f3f4f6; }
  details.session { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 0.4rem; margin-bottom: 0.5rem; }
  details.session > summary { padding: 0.6rem 0.9rem; cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; font-size: 0.92rem; }
  details.session[open] > summary { background: #f3f4f6; border-bottom: 1px solid #e5e7eb; border-radius: 0.4rem 0.4rem 0 0; }
  details.session .stats { margin-left: auto; font-size: 0.85rem; }
  details.session .proj { color: #1f3a93; font-weight: 600; }
  details.session.silent { background: #fff8e1; border-color: #ffd54f; }
  details.session.silent[open] > summary { background: #fff3cd; }
  .silent-stat { color: #8a6d3b; font-weight: 600; }
  .silent-note { padding: 0.6rem 0.4rem; font-size: 0.86rem; color: #8a6d3b; }
  .hints { padding: 0.5rem 0.9rem; }
  details.hint { border-left: 3px solid #ddd; padding: 0.35rem 0.6rem; margin: 0.3rem 0; background: #fff; border-radius: 0.2rem; }
  details.hint.fb-followed { border-left-color: #28a745; }
  details.hint.fb-noise { border-left-color: #dc3545; }
  details.hint.fb-ignored { border-left-color: #ffc107; }
  details.hint.fb-none { border-left-color: #adb5bd; }
  details.hint > summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; font-size: 0.88rem; }
  .hint-col { color: #666; font-size: 0.82rem; }
  .hint-conf { color: #888; font-size: 0.82rem; }
  .hint-surf { background: #e7f1ff; color: #1f3a93; padding: 0.05rem 0.4rem; border-radius: 0.2rem; font-size: 0.78rem; }
  .hint-principle { color: #444; flex: 1 1 20rem; }
  .tag { display: inline-block; background: #e9ecef; color: #495057; padding: 0.05rem 0.4rem; border-radius: 0.2rem; font-size: 0.78rem; }
  .fb-badge { padding: 0.05rem 0.4rem; border-radius: 0.2rem; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; }
  .fb-badge.fb-followed { background: #d4edda; color: #155724; }
  .fb-badge.fb-noise    { background: #f8d7da; color: #721c24; }
  .fb-badge.fb-ignored  { background: #fff3cd; color: #856404; }
  .fb-badge.fb-none     { background: #e9ecef; color: #6c757d; }
  .surfaces { padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  .surface { display: flex; gap: 0.6rem; padding: 0.15rem 0; align-items: baseline; }
  .surface .ts { color: #888; min-width: 5rem; font-family: ui-monospace, "SF Mono", monospace; }
  .surface .tool { color: #1f3a93; min-width: 7rem; font-weight: 600; }
  .surface .query { color: #444; flex: 1; }
`;

/**
 * Render full HTML page from dashboard snapshot.
 *
 * @param {object} snapshot — matches schema.md top-level shape
 * @returns {string} self-contained HTML document
 */

function renderStore(store) {
  if (!store || !store.total) {
    return '<section><h2>D. Store Distribution</h2><p class="muted">No store data available.</p></section>';
  }

  const tierLabels = {
    t0_new: 'T0 \u2014 New (never surfaced)',
    t1_bootstrap: 'T1 \u2014 Bootstrap (surfaced 1-3x)',
    t2_active: 'T2 \u2014 Active (has follows)',
    t3_dying: 'T3 \u2014 Dying (surfaced >3x, 0 follows)',
  };

  const tierRows = Object.entries(store.tiers)
    .map(function(pair) {
      var k = pair[0], v = pair[1];
      var label = tierLabels[k] || k;
      var pctVal = store.total > 0 ? ((v / store.total) * 100).toFixed(1) + '%' : '\u2014';
      var cls = k === 't0_new' ? 'muted' : k === 't2_active' ? 'good' : k === 't3_dying' ? 'bad' : '';
      return '<tr><td>' + escapeHtml(label) + '</td><td class="num ' + cls + '">' + v + '</td><td class="num muted">' + pctVal + '</td></tr>';
    }).join('');

  var typeRows = Object.entries(store.types)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(pair) {
      var k = pair[0], v = pair[1];
      var pctVal = store.total > 0 ? ((v / store.total) * 100).toFixed(1) + '%' : '\u2014';
      return '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + v + '</td><td class="num muted">' + pctVal + '</td></tr>';
    }).join('');

  var q = store.quality;
  var qualityItems = [
    ['project_slug', q.withSlug],
    ['structured conditions', q.withStructuredCond],
    ['lang (not "all")', q.withLang],
    ['judgment', q.withJudgment],
  ];
  var qualityRows = qualityItems.map(function(item) {
    var label = item[0], v = item[1];
    var pctVal = store.total > 0 ? ((v / store.total) * 100).toFixed(1) + '%' : '\u2014';
    var cls = store.total > 0 && v / store.total >= 0.95 ? 'good' : store.total > 0 && v / store.total >= 0.7 ? 'warn' : 'bad';
    return '<tr><td>' + escapeHtml(label) + '</td><td class="num">' + v + '/' + store.total + '</td><td class="num ' + cls + '">' + pctVal + '</td></tr>';
  }).join('');

  var colRows = Object.entries(store.collections)
    .map(function(pair) {
      var col = pair[0], cs = pair[1];
      var topType = Object.entries(cs.types).sort(function(a, b) { return b[1] - a[1]; })[0];
      return '<tr><td>' + escapeHtml(col.replace('experience-', '')) + '</td><td class="num">' + cs.total + '</td><td class="num">' + cs.tiers.t0_new + '</td><td class="num">' + cs.tiers.t1_bootstrap + '</td><td class="num">' + cs.tiers.t2_active + '</td><td class="num">' + cs.tiers.t3_dying + '</td><td class="muted">' + (topType ? escapeHtml(topType[0]) + ' (' + topType[1] + ')' : '\u2014') + '</td></tr>';
    }).join('');

  return '<section>'
    + '<h2>D. Store Distribution</h2>'
    + '<div class="kpi">'
    + '<div class="kpi-label">Total entries in brain</div>'
    + '<div class="kpi-value">' + store.total + '</div>'
    + '<div class="kpi-sub">across ' + Object.keys(store.collections).length + ' collections</div>'
    + '</div>'
    + '<div class="grid-2">'
    + '<div>'
    + '<h3>By Lifecycle Tier</h3>'
    + '<table><thead><tr><th>Tier</th><th class="num">Count</th><th class="num">%</th></tr></thead>'
    + '<tbody>' + tierRows + '</tbody></table>'
    + '</div>'
    + '<div>'
    + '<h3>By Evidence Type</h3>'
    + '<table><thead><tr><th>Type</th><th class="num">Count</th><th class="num">%</th></tr></thead>'
    + '<tbody>' + typeRows + '</tbody></table>'
    + '</div>'
    + '</div>'
    + '<div class="grid-2">'
    + '<div>'
    + '<h3>Entry Quality</h3>'
    + '<table><thead><tr><th>Metric</th><th class="num">Coverage</th><th class="num">%</th></tr></thead>'
    + '<tbody>' + qualityRows + '</tbody></table>'
    + '</div>'
    + '<div>'
    + '<h3>By Collection</h3>'
    + '<table><thead><tr><th>Collection</th><th class="num">Total</th><th class="num">T0</th><th class="num">T1</th><th class="num">T2</th><th class="num">T3</th><th>Top type</th></tr></thead>'
    + '<tbody>' + colRows + '</tbody></table>'
    + '</div>'
    + '</div>'
    + '</section>';
}

function renderHtml(snapshot) {
  const generated = snapshot.generatedAt || new Date().toISOString();
  const win = snapshot.dataWindow || {};
  const meta = snapshot.meta || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Experience Engine Dashboard — v3.0 Effectiveness</title>
<style>${CSS}</style>
</head>
<body>
<h1>Experience Engine Dashboard</h1>
<p class="muted">Generated <strong>${escapeHtml(generated)}</strong> · window ${escapeHtml(win.days || '?')}d (${escapeHtml(win.since || '?')} → ${escapeHtml(win.until || '?')}) · schema v${escapeHtml(snapshot.version || '?')}</p>

${renderGates(snapshot.gates || {})}
${renderPrecisionSince(snapshot.precisionSince)}
${renderStore(snapshot.store || {})}
${renderPrecision(snapshot.precision || {})}
${renderFunnel(snapshot.funnel || {})}
${renderOffenders(snapshot.topOffenders || [])}
${renderSessions(snapshot.sessions || { items: [] })}

<div class="meta">
  Sources: ${escapeHtml((meta.sourceFiles || []).join(', '))} · lines scanned: ${meta.linesScanned ?? '?'} · qdrant points: ${meta.qdrantPoints ?? '?'} · build time: ${meta.buildMs ?? '?'}ms
</div>
</body>
</html>`;
}

module.exports = { renderHtml };
