#!/usr/bin/env node
'use strict';

/**
 * backfill-text-search.js — one-time migration to populate the top-level
 * `text_search` payload field on existing points so the hybrid-recall lexical
 * leg can match them. New writes get text_search automatically (upsertEntry);
 * this fills in the back catalogue.
 *
 * Idempotent: skips points that already have a non-empty text_search. Safe to
 * re-run. Paginates the Qdrant scroll API. Server-side only (needs Qdrant).
 *
 * Usage:
 *   node tools/backfill-text-search.js            # apply
 *   node tools/backfill-text-search.js --dry-run  # report only, write nothing
 */

const path = require('path');
const EXP = path.join(__dirname, '..', '.experience', 'src');
const { getQdrantBase, getQdrantApiKey } = require(path.join(EXP, 'config'));
const { setPayloadFields, checkQdrant } = require(path.join(EXP, 'qdrant'));
const { buildTextSearch } = require(path.join(EXP, 'format'));

const COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 256;

function headers() {
  const k = getQdrantApiKey();
  return { 'Content-Type': 'application/json', ...(k ? { 'api-key': k } : {}) };
}

async function scrollPage(collection, offset) {
  const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ limit: PAGE, with_payload: true, with_vector: false, offset }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`scroll ${collection} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()).result || {};
  return { points: body.points || [], next: body.next_page_offset ?? null };
}

async function backfillCollection(collection) {
  let offset = null;
  let scanned = 0, updated = 0, skipped = 0, failed = 0;
  do {
    let page;
    try {
      page = await scrollPage(collection, offset);
    } catch (err) {
      console.error(`[backfill] ${collection} scroll error: ${err?.message || err}`);
      break;
    }
    for (const p of page.points) {
      scanned += 1;
      const existing = p.payload?.text_search;
      if (typeof existing === 'string' && existing.trim()) { skipped += 1; continue; }
      let data = {};
      try { data = JSON.parse(p.payload?.json || '{}'); } catch { /* default */ }
      const text = buildTextSearch(data);
      if (!text) { skipped += 1; continue; } // nothing to index
      if (DRY_RUN) { updated += 1; continue; }
      const ok = await setPayloadFields(collection, p.id, { text_search: text });
      if (ok) updated += 1; else failed += 1;
    }
    offset = page.next;
  } while (offset !== null && offset !== undefined);
  console.log(`[backfill] ${collection}: scanned=${scanned} ${DRY_RUN ? 'would-update' : 'updated'}=${updated} skipped=${skipped} failed=${failed}`);
  return { scanned, updated, skipped, failed };
}

(async () => {
  if (!(await checkQdrant())) {
    console.error('[backfill] Qdrant not available — aborting (this tool is server-side only).');
    process.exitCode = 1;
    return;
  }
  console.log(`[backfill] text_search backfill${DRY_RUN ? ' (DRY RUN)' : ''} across ${COLLECTIONS.length} collections`);
  const totals = { scanned: 0, updated: 0, skipped: 0, failed: 0 };
  for (const c of COLLECTIONS) {
    const r = await backfillCollection(c);
    for (const k of Object.keys(totals)) totals[k] += r[k];
  }
  console.log(`[backfill] DONE — scanned=${totals.scanned} ${DRY_RUN ? 'would-update' : 'updated'}=${totals.updated} skipped=${totals.skipped} failed=${totals.failed}`);
  if (totals.failed > 0) process.exitCode = 1;
})();
