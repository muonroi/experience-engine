#!/usr/bin/env node
'use strict';

/**
 * purge-imported-memory.js — delete every entry created by the memory importer
 * (payload.createdFrom === 'seed-memory-import') from the T1/T2 collections.
 *
 * Why this exists: the importer's stable id is sha1(runtime:projectSlug:name), so
 * when a re-import changes an entry's derived scope (e.g. the workspace-root
 * global-scope fix maps `d:/sources` → null), the id changes and a plain re-import
 * ORPHANS the old point instead of upserting it. It also cannot remove entries the
 * new mapper now skips (status dumps). The clean correction is: purge all imported
 * entries here, then re-run `import-memory.js --reset-marker` to repopulate from the
 * corrected mapper.
 *
 * Runs where Qdrant is reachable (server-local). Reuses the server's configured
 * Qdrant url/key via config.js — NO hardcoded credentials.
 *
 * Usage (on the box that hosts Qdrant):
 *   node .experience/tools/purge-imported-memory.js            # DRY-RUN (default)
 *   node .experience/tools/purge-imported-memory.js --apply    # actually delete
 */

const { getQdrantBase, getQdrantApiKey } = require('../src/config');

const COLLECTIONS = ['experience-behavioral', 'experience-selfqa'];
const IMPORT_MARK = 'seed-memory-import';
const apply = process.argv.includes('--apply');

function headers() {
  const key = getQdrantApiKey();
  return { 'Content-Type': 'application/json', ...(key ? { 'api-key': key } : {}) };
}

async function collectImportedIds(collection) {
  const ids = [];
  let offset = null;
  for (;;) {
    const body = { limit: 256, with_payload: ['json'], with_vector: false };
    if (offset) body.offset = offset;
    let res;
    try {
      res = await fetch(`${getQdrantBase()}/collections/${collection}/points/scroll`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`[purge] scroll ${collection} failed: ${err?.message}`);
      return ids;
    }
    if (!res.ok) { console.error(`[purge] scroll ${collection} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return ids; }
    const j = await res.json();
    const pts = (j.result && j.result.points) || [];
    for (const p of pts) {
      let d;
      try { d = JSON.parse(p.payload.json); } catch { continue; }
      if (d && d.createdFrom === IMPORT_MARK) ids.push(p.id);
    }
    offset = j.result && j.result.next_page_offset;
    if (!offset) break;
  }
  return ids;
}

async function deleteIds(collection, ids) {
  const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/delete?wait=true`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ points: ids }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

(async () => {
  console.log(`[purge] mode=${apply ? 'APPLY' : 'DRY-RUN'} qdrant=${getQdrantBase()} mark=${IMPORT_MARK}`);
  let total = 0;
  for (const coll of COLLECTIONS) {
    const ids = await collectImportedIds(coll);
    total += ids.length;
    console.log(`  ${coll}: ${ids.length} imported entr${ids.length === 1 ? 'y' : 'ies'}`);
    if (apply && ids.length) {
      try { await deleteIds(coll, ids); console.log(`    deleted ${ids.length}`); }
      catch (err) { console.error(`    DELETE failed: ${err?.message}`); }
    }
  }
  console.log(`[purge] ${apply ? 'deleted' : 'would delete'} ${total} imported entries across ${COLLECTIONS.length} collections.`);
  if (!apply) console.log('[purge] DRY-RUN only — re-run with --apply to delete, then re-import with --reset-marker.');
})().catch((err) => { console.error('[purge] FATAL', err); process.exit(1); });
