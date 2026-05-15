#!/usr/bin/env node
/**
 * scripts/split-bb-behavioral.mjs
 * Phase 2.3 + 2.4 — Copy BB-relevant points from experience-behavioral → bb-behavioral,
 * then dedup within bb-behavioral (archive near-duplicates by payload flag).
 *
 * Phase 2.2b — --rollback flag deletes bb-behavioral + bb-recipes and clears state file.
 *
 * Usage:
 *   node scripts/split-bb-behavioral.mjs [--dry-run] [--rollback] [--skip-dedup] [--batch=100]
 *
 * Env:
 *   QDRANT_URL   — Qdrant base URL (default: http://localhost:6333)
 *   QDRANT_KEY   — Qdrant API key (optional)
 *
 * State file: scripts/.split-bb-state.json (tracks migrated point IDs, re-runnable).
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { canonicalizeProjectSlug } = require('../lib/path-canonical.js');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ROLLBACK = args.includes('--rollback');
const SKIP_DEDUP = args.includes('--skip-dedup');
const batchArg = args.find(a => a.startsWith('--batch='));
const BATCH_SIZE = batchArg ? parseInt(batchArg.split('=')[1], 10) : 100;

const STATE_FILE = join(__dirname, '.split-bb-state.json');

// --- BB markers (text-level heuristics) ---
const BB_TEXT_MARKERS = [
  '[MExtractAsRule]',
  'MDbContext',
  'MTokenInfo',
  'IRule<TContext>',
  'RuleResult',
  'MRepository',
  'Muonroi.',
];

// --- Config ---
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(homedir(), '.experience', 'config.json'), 'utf8'));
} catch { /* ignore */ }

const QDRANT_BASE = process.env.QDRANT_URL || cfg.qdrantUrl || 'http://localhost:6333';
const QDRANT_KEY = process.env.QDRANT_KEY || cfg.qdrantKey || '';

function qdrantHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(QDRANT_KEY ? { 'api-key': QDRANT_KEY } : {}),
  };
}

async function qdrantFetch(path, opts = {}) {
  const res = await fetch(`${QDRANT_BASE}${path}`, {
    ...opts,
    headers: { ...qdrantHeaders(), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  return res;
}

// --- State helpers ---
function loadState() {
  if (!existsSync(STATE_FILE)) return { migratedIds: [], version: 1 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { return { migratedIds: [], version: 1 }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// --- Scroll helper ---
async function* scrollCollection(collection, batchSize) {
  let offset = null;
  while (true) {
    const body = { limit: batchSize, with_payload: true, with_vector: true };
    if (offset !== null) body.offset = offset;
    const res = await qdrantFetch(`/collections/${collection}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Scroll failed for ${collection}: ${res.status} ${text}`);
    }
    const data = await res.json();
    const points = data.result?.points || [];
    if (points.length > 0) yield points;
    const next = data.result?.next_page_offset;
    if (!next || points.length === 0) break;
    offset = next;
  }
}

// --- BB detection ---
function isBbPoint(point) {
  const payload = point.payload || {};

  // Check project_slug
  const slug = payload.project_slug || canonicalizeProjectSlug(
    payload.path || payload.file_path || payload.project || ''
  );
  if (slug === 'muonroi-building-block') return true;

  // Check text markers
  const text = String(payload.text || payload.json || '');
  return BB_TEXT_MARKERS.some(marker => text.includes(marker));
}

// --- Cosine similarity ---
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Normalize text for dedup ---
function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- Upsert points into target collection ---
async function upsertPoints(collection, points) {
  const res = await qdrantFetch(`/collections/${collection}/points`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upsert failed: ${res.status} ${text}`);
  }
  return res;
}

// --- Mark archived in payload ---
async function markArchived(collection, ids) {
  if (ids.length === 0) return;
  const res = await qdrantFetch(`/collections/${collection}/points/payload`, {
    method: 'POST',
    body: JSON.stringify({ payload: { archived: true }, points: ids }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mark archived failed: ${res.status} ${text}`);
  }
}

// --- Delete collection ---
async function deleteCollection(name) {
  const res = await qdrantFetch(`/collections/${name}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Delete collection ${name} failed: ${res.status} ${text}`);
  }
  console.log(`  Deleted collection: ${name}`);
}

// === ROLLBACK ===
async function rollback() {
  console.log('=== ROLLBACK: deleting bb-behavioral + bb-recipes ===');
  if (DRY_RUN) {
    console.log('[DRY-RUN] Would delete bb-behavioral and bb-recipes collections');
    console.log('[DRY-RUN] Would remove state file:', STATE_FILE);
    return;
  }
  await deleteCollection('bb-behavioral');
  await deleteCollection('bb-recipes');
  // Clear state file
  saveState({ migratedIds: [], version: 1, rolledBackAt: new Date().toISOString() });
  console.log('Rollback complete. State file reset.');
}

// === MIGRATION ===
async function migrate() {
  console.log('=== Phase 2.3 — Copy BB points: experience-behavioral → bb-behavioral ===');
  const state = loadState();
  const alreadyMigrated = new Set(state.migratedIds || []);

  let scanned = 0;
  let matched = 0;
  let alreadyDone = 0;
  let upserted = 0;

  for await (const points of scrollCollection('experience-behavioral', BATCH_SIZE)) {
    scanned += points.length;
    const bbPoints = points.filter(p => isBbPoint(p));
    const newPoints = bbPoints.filter(p => !alreadyMigrated.has(String(p.id)));
    matched += bbPoints.length;
    alreadyDone += bbPoints.length - newPoints.length;

    if (newPoints.length > 0) {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would upsert ${newPoints.length} points → bb-behavioral`);
        for (const p of newPoints.slice(0, 3)) {
          const text = String((p.payload || {}).text || '').slice(0, 80);
          console.log(`    id=${p.id}: ${text}`);
        }
      } else {
        // Use new UUIDs to avoid collisions with experience-behavioral IDs.
        const mapped = newPoints.map(p => ({
          id: randomUUID(),
          vector: p.vector,
          payload: {
            ...(p.payload || {}),
            source_id: p.id,
            source_collection: 'experience-behavioral',
            migrated_at: new Date().toISOString(),
          },
        }));
        await upsertPoints('bb-behavioral', mapped);
        for (const orig of newPoints) alreadyMigrated.add(String(orig.id));
        state.migratedIds = [...alreadyMigrated];
        saveState(state);
        upserted += mapped.length;
      }
    }
  }

  console.log(`  Scanned: ${scanned}, BB matched: ${matched}, Already migrated: ${alreadyDone}, Upserted: ${upserted}`);
  return { scanned, matched, alreadyDone, upserted };
}

// === DEDUP ===
async function dedupBbBehavioral() {
  console.log('\n=== Phase 2.4 — Dedup within bb-behavioral (cosine sim ≥ 0.97 → archive) ===');

  // Load all points with vectors
  const allPoints = [];
  for await (const batch of scrollCollection('bb-behavioral', 200)) {
    allPoints.push(...batch);
  }

  console.log(`  Loaded ${allPoints.length} points from bb-behavioral`);
  if (allPoints.length === 0) {
    console.log('  Nothing to dedup.');
    return;
  }

  // Group by normalized text similarity using vector cosine
  // O(n^2) but collections are small (<10k). For large sets, use Qdrant's own search.
  const SIMILARITY_THRESHOLD = 0.97;
  const keepIds = new Set();
  const archiveIds = [];
  const visited = new Set();

  // Sort by evidence count descending so we keep highest-evidence point in each cluster.
  allPoints.sort((a, b) => {
    const ea = Number((a.payload || {}).evidence || 0);
    const eb = Number((b.payload || {}).evidence || 0);
    return eb - ea;
  });

  for (let i = 0; i < allPoints.length; i++) {
    const p = allPoints[i];
    const pid = String(p.id);
    if (visited.has(pid)) continue;
    if ((p.payload || {}).archived) { visited.add(pid); continue; }

    keepIds.add(pid);
    visited.add(pid);

    for (let j = i + 1; j < allPoints.length; j++) {
      const q = allPoints[j];
      const qid = String(q.id);
      if (visited.has(qid)) continue;
      if ((q.payload || {}).archived) { visited.add(qid); continue; }

      const sim = cosineSim(p.vector, q.vector);
      if (sim >= SIMILARITY_THRESHOLD) {
        // Also confirm text similarity to guard against embedding hash collisions.
        const normP = normalizeText((p.payload || {}).text);
        const normQ = normalizeText((q.payload || {}).text);
        // Only archive if text isn't radically different (cheap check: shared prefix).
        const shorter = Math.min(normP.length, normQ.length);
        const prefixMatch = shorter > 0 && normP.slice(0, Math.min(50, shorter)) === normQ.slice(0, Math.min(50, shorter));
        if (sim >= 0.99 || prefixMatch) {
          archiveIds.push(qid);
          visited.add(qid);
        }
      }
    }
  }

  console.log(`  Keep: ${keepIds.size}, Archive: ${archiveIds.length}`);

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would mark ${archiveIds.length} points archived in bb-behavioral`);
  } else if (archiveIds.length > 0) {
    await markArchived('bb-behavioral', archiveIds);
    console.log(`  Marked ${archiveIds.length} points as archived`);
  } else {
    console.log('  No duplicates found.');
  }
}

async function main() {
  console.log(`Qdrant: ${QDRANT_BASE}`);
  console.log(DRY_RUN ? '[DRY-RUN MODE — no writes]' : '[WRITE MODE]');

  if (ROLLBACK) {
    await rollback();
    return;
  }

  await migrate();

  if (!SKIP_DEDUP) {
    await dedupBbBehavioral();
  }

  console.log('\n=== Done ===');
  if (DRY_RUN) console.log('Re-run without --dry-run to apply changes.');
}

main().catch(err => { console.error(err); process.exit(1); });
