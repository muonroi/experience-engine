#!/usr/bin/env node
/**
 * backfill-why-scope.js — One-time migration script
 *
 * Reads all entries from Qdrant experience-behavioral collection, then for each
 * entry whose source matches a feedback_*.md file, updates the payload with:
 *   - why: extracted from "**Why:**" line in the memory file
 *   - scope: derived from context (language, repos, filePattern)
 *
 * Run once: node experience-engine/.experience/backfill-why-scope.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// --- Config from ~/.experience/config.json ---
const _cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')); }
  catch { return {}; }
})();

const QDRANT_BASE    = _cfg.qdrantUrl || process.env.EXPERIENCE_QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = _cfg.qdrantKey || process.env.EXPERIENCE_QDRANT_KEY || '';
const COLLECTION     = 'experience-behavioral';
const MEMORY_DIR     = path.join(os.homedir(), '.claude', 'projects', 'D--sources-Core', 'memory');

// --- Scope map: derived from CONTEXT.md task 3 specification ---
const SCOPE_MAP = {
  'feedback_e2e_testing_rules':          { lang: 'all',        repos: ['muonroi-ui-engine'] },
  'feedback_security_endpoint_checklist':{ lang: 'C#',         repos: ['muonroi-building-block', 'muonroi-control-plane'] },
  'feedback_verify_before_fix':          { lang: 'all' },
  'feedback_library_first_strict':       { lang: 'all' },
  'feedback_library_first':              { lang: 'all',        repos: ['muonroi-ui-engine', 'muonroi-building-block'] },
  'feedback_exception_guard_standard':   { lang: 'C#',         repos: ['muonroi-building-block'] },
  'feedback_single_better_together':     { lang: 'C#',         repos: ['muonroi-building-block'] },
  'feedback_auto_gsd_skills':            { lang: 'all' },
  'feedback_use_imlog':                  { lang: 'C#',         repos: ['muonroi-building-block'] },
  'feedback_multi_repo_structure':       { lang: 'all' },
  'feedback_fcd_session_continuity':     { lang: 'all' },
  'feedback_no_hardcode_widths':         { lang: 'CSS',        repos: ['muonroi-ui-engine'], filePattern: '*.scss,*.css,*.tsx' },
  'feedback_token_system_professional':  { lang: 'CSS',        repos: ['muonroi-ui-engine'] },
};

/** Extract **Why:** line from a memory file. */
function extractWhy(sourceKey) {
  // sourceKey may be "feedback_foo.md" or "feedback_foo"
  const base = sourceKey.replace(/\.md$/, '');
  const filePath = path.join(MEMORY_DIR, base + '.md');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const m = content.match(/\*\*Why:\*\*\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Normalize source field to the scope map key. */
function toScopeKey(source) {
  if (!source) return null;
  // Strip path, keep filename without extension
  const base = path.basename(source, '.md');
  return base.startsWith('feedback_') ? base : null;
}

async function qdrantGet(url) {
  const res = await fetch(url, {
    headers: { 'api-key': QDRANT_API_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function qdrantPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': QDRANT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function qdrantPut(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'api-key': QDRANT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Scroll all points from a collection using Qdrant scroll API. */
async function scrollAll(collection) {
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: 100, with_payload: true, with_vector: false };
    if (offset !== null) body.offset = offset;
    const data = await qdrantPost(`${QDRANT_BASE}/collections/${collection}/points/scroll`, body);
    const batch = data.result?.points || [];
    points.push(...batch);
    offset = data.result?.next_page_offset;
    if (!offset || batch.length === 0) break;
  }
  return points;
}

async function main() {
  console.log(`Connecting to Qdrant at ${QDRANT_BASE}`);
  console.log(`Collection: ${COLLECTION}`);
  console.log(`Memory dir: ${MEMORY_DIR}`);
  console.log('');

  // Verify collection exists
  try {
    await qdrantGet(`${QDRANT_BASE}/collections/${COLLECTION}`);
  } catch (err) {
    console.error(`Collection check failed: ${err.message}`);
    process.exit(1);
  }

  const points = await scrollAll(COLLECTION);
  console.log(`Found ${points.length} entries in ${COLLECTION}`);

  let updated = 0;
  let skipped = 0;
  let noWhy   = 0;
  let noScope = 0;

  for (const point of points) {
    // Payload stored in json field (string) or directly
    let payload;
    try { payload = JSON.parse(point.payload?.json || '{}'); } catch { payload = {}; }

    // Skip if already has both why and scope
    if (payload.why !== undefined && payload.scope !== undefined) {
      skipped++;
      continue;
    }

    const source = payload.source || point.payload?.source || null;
    const scopeKey = toScopeKey(source);

    const why   = scopeKey ? extractWhy(scopeKey) : null;
    const scope = scopeKey ? (SCOPE_MAP[scopeKey] || null) : null;

    if (!why)   noWhy++;
    if (!scope) noScope++;

    // Update payload with why + scope
    const updatedPayload = { ...payload, why: why || null, scope: scope || null };

    // Store back: Qdrant PATCH /collections/{name}/points/payload sets fields
    // We need to update the `json` string field in the payload wrapper
    const newPointPayload = { ...point.payload, json: JSON.stringify(updatedPayload) };

    try {
      await qdrantPut(`${QDRANT_BASE}/collections/${COLLECTION}/points/payload`, {
        payload: newPointPayload,
        points: [point.id],
      });
      updated++;
      const label = scopeKey || source || point.id;
      console.log(`  [OK] ${label}: why=${why ? why.slice(0, 60) + '...' : 'null'}, scope.lang=${scope?.lang || 'null'}`);
    } catch (err) {
      console.error(`  [ERR] ${point.id}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Summary:`);
  console.log(`  Total entries:   ${points.length}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already current: ${skipped}`);
  console.log(`  Missing why:     ${noWhy}`);
  console.log(`  Missing scope:   ${noScope}`);

  // Verification: re-read a sample entry to confirm
  if (points.length > 0) {
    console.log('');
    console.log('Verifying sample entry...');
    const sampleId = points[0].id;
    const check = await qdrantPost(`${QDRANT_BASE}/collections/${COLLECTION}/points`, {
      ids: [sampleId], with_payload: true, with_vector: false,
    });
    const sample = check.result?.[0];
    if (sample) {
      let sPayload;
      try { sPayload = JSON.parse(sample.payload?.json || '{}'); } catch { sPayload = {}; }
      console.log(`  Sample point ${sampleId}:`);
      console.log(`    why:   ${sPayload.why ? sPayload.why.slice(0, 80) : 'null'}`);
      console.log(`    scope: ${sPayload.scope ? JSON.stringify(sPayload.scope) : 'null'}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
