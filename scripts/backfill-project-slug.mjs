#!/usr/bin/env node
/**
 * scripts/backfill-project-slug.mjs
 * Phase 1.5 — Backfill project_slug on existing Qdrant points that lack it.
 *
 * Scrolls experience-behavioral (and optionally other collections), derives
 * project_slug from payload.path or payload.project using canonicalizeProjectSlug,
 * and PATCHes the payload. Idempotent: skips points that already have project_slug.
 *
 * Usage:
 *   node scripts/backfill-project-slug.mjs [--dry-run] [--collections=c1,c2] [--batch=100]
 *
 * Env:
 *   QDRANT_URL   — Qdrant base URL (default: http://localhost:6333)
 *   QDRANT_KEY   — Qdrant API key (optional)
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { canonicalizeProjectSlug } = require('../lib/path-canonical.js');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const batchArg = args.find(a => a.startsWith('--batch='));
const BATCH_SIZE = batchArg ? parseInt(batchArg.split('=')[1], 10) : 100;
const collectionsArg = args.find(a => a.startsWith('--collections='));
const COLLECTIONS = collectionsArg
  ? collectionsArg.split('=')[1].split(',').map(c => c.trim()).filter(Boolean)
  : ['experience-behavioral'];

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

/**
 * Scroll all points in a collection (with_payload: true).
 * Yields batches of points.
 */
async function* scrollCollection(collection, batchSize) {
  let offset = null;
  while (true) {
    const body = { limit: batchSize, with_payload: true };
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

/**
 * Set payload fields on a list of points (Qdrant set-payload API).
 * The set-payload endpoint preserves keys not in the payload object —
 * we are not overwriting the whole payload, only adding `project_slug`.
 */
async function patchPayloads(collection, updates) {
  // Qdrant set-payload requires a single payload object + list of point IDs.
  // Group by slug to minimize requests.
  const bySlug = {};
  for (const { id, slug } of updates) {
    bySlug[slug] = bySlug[slug] || [];
    bySlug[slug].push(id);
  }
  for (const [slug, ids] of Object.entries(bySlug)) {
    const res = await qdrantFetch(`/collections/${collection}/points/payload`, {
      method: 'POST',
      body: JSON.stringify({
        payload: { project_slug: slug },
        points: ids,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`PATCH failed for slug ${slug}: ${res.status} ${text}`);
    } else {
      console.log(`  Patched ${ids.length} points → project_slug=${slug}`);
    }
  }
}

async function backfillCollection(collection) {
  console.log(`\n=== Collection: ${collection} ===`);
  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let failedDerive = 0;

  for await (const points of scrollCollection(collection, BATCH_SIZE)) {
    scanned += points.length;
    const updates = [];
    for (const point of points) {
      const payload = point.payload || {};
      // Skip if already has project_slug
      if (typeof payload.project_slug === 'string' && payload.project_slug) {
        skipped++;
        continue;
      }
      // Derive slug from path or project field
      const rawPath = payload.path || payload.file_path || payload.project || null;
      const slug = rawPath ? canonicalizeProjectSlug(String(rawPath)) : null;
      if (!slug) {
        failedDerive++;
        continue;
      }
      updates.push({ id: point.id, slug });
      updated++;
    }

    if (updates.length > 0) {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would patch ${updates.length} points in ${collection}`);
        for (const u of updates.slice(0, 5)) {
          console.log(`    id=${u.id} → project_slug=${u.slug}`);
        }
        if (updates.length > 5) console.log(`    ... and ${updates.length - 5} more`);
      } else {
        await patchPayloads(collection, updates);
      }
    }
  }

  console.log(`  Scanned: ${scanned}, Skipped (already have slug): ${skipped}, Updated: ${updated}, No match: ${failedDerive}`);
  return { scanned, skipped, updated, failedDerive };
}

async function main() {
  console.log('=== Backfill project_slug ===');
  console.log(`Qdrant: ${QDRANT_BASE}`);
  console.log(`Collections: ${COLLECTIONS.join(', ')}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(DRY_RUN ? '[DRY-RUN MODE — no writes]' : '[WRITE MODE]');

  const results = {};
  for (const col of COLLECTIONS) {
    results[col] = await backfillCollection(col);
  }

  console.log('\n=== Summary ===');
  for (const [col, r] of Object.entries(results)) {
    console.log(`${col}: scanned=${r.scanned} updated=${r.updated} skipped=${r.skipped} no_match=${r.failedDerive}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No data was modified. Remove --dry-run to apply changes.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
