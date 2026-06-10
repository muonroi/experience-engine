#!/usr/bin/env node
'use strict';

/**
 * remediate-negsignal.js — one-time death-spiral recovery.
 *
 * Root cause (evidence 2026-06-10): entries that surfaced during the broken
 * pre-relevance-gate era accrued ignore/irrelevant/noise signals because of
 * BAD SURFACING CONTEXT, not bad content. That negativeSignal>0 voids the
 * clean-but-unvalidated grace in scoring.js:52, dropping effective confidence
 * to base*0.7 — pushing ~65% of the organic corpus below minConfidence so it
 * can no longer surface. With the relevance gate now live (2026-06-09), those
 * negatives are stale: a revived entry will only surface on matching context.
 *
 * This script resets ignoreCount / irrelevantCount / noiseReasonCounts to 0 for
 * NON-SEED, hitCount===0 entries carrying negativeSignal>0. Entries with hits>0
 * (runtime-validated) are left untouched. Seeds bypass confidence so are skipped.
 *
 * Usage:
 *   node tools/remediate-negsignal.js                 # dry-run (default)
 *   node tools/remediate-negsignal.js --apply         # write to Qdrant
 *   node tools/remediate-negsignal.js --collection experience-selfqa --apply
 *
 * Reads Qdrant URL/key from ~/.experience/config.json (qdrantUrl/qdrantKey).
 * Effective-confidence math mirrors .experience/src/scoring.js exactly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_CONFIDENCE = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8'));
    return typeof cfg.minConfidence === 'number' ? cfg.minConfidence : 0.5;
  } catch (err) {
    console.error('[remediate] config read failed, defaulting minConfidence=0.5:', err.message);
    return 0.5;
  }
})();

function loadQdrant() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8'));
    return { url: cfg.qdrantUrl || 'http://localhost:6333', key: cfg.qdrantKey || null };
  } catch (err) {
    console.error('[remediate] config read failed:', err.message);
    return { url: 'http://localhost:6333', key: null };
  }
}

function isSeedEntry(data) {
  if (typeof data?.createdFrom !== 'string') return false;
  return data.createdFrom.startsWith('seed-') || data.createdFrom === 'evolution-abstraction';
}

function negativeSignal(e) {
  return (e.ignoreCount || 0) + (e.irrelevantCount || 0)
    + Object.values(e.noiseReasonCounts || {}).reduce((a, c) => a + (Number(c) || 0), 0);
}

// Mirror of .experience/src/scoring.js computeEffectiveConfidence (non-seed paths).
function effConf(e) {
  const base = e.confidence || 0.5;
  const hits = e.hitCount || 0;
  if (isSeedEntry(e)) return base;
  const sc = e.surfaceCount || 0;
  if (sc <= 3 && hits <= sc) return Math.max(base, 0.50 + Math.min(0.20, hits * 0.05));
  if (hits === 0 && negativeSignal(e) === 0) return base;
  return base * Math.min(1.0, 0.7 + hits * 0.06);
}

async function scrollAll(url, key, name) {
  const out = [];
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['api-key'] = key;
  let offset;
  for (;;) {
    const body = { limit: 256, with_payload: true };
    if (offset) body.offset = offset;
    const res = await fetch(`${url}/collections/${name}/points/scroll`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`scroll ${name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    out.push(...j.result.points);
    offset = j.result.next_page_offset;
    if (!offset) break;
  }
  return out;
}

async function setPayloadJson(url, key, name, id, jsonStr) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['api-key'] = key;
  const res = await fetch(`${url}/collections/${name}/points/payload`, {
    method: 'POST', headers,
    body: JSON.stringify({ payload: { json: jsonStr }, points: [id] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`set-payload ${name}/${id} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function processCollection(url, key, name, apply) {
  const pts = await scrollAll(url, key, name);
  let targeted = 0, revived = 0, applied = 0, failed = 0;
  const samples = [];
  for (const p of pts) {
    let e;
    try { e = JSON.parse(p.payload?.json || '{}'); }
    catch (err) { console.error(`[remediate] parse fail ${name}/${p.id}: ${err.message}`); continue; }
    if (isSeedEntry(e)) continue;
    if ((e.hitCount || 0) !== 0) continue;
    if (negativeSignal(e) === 0) continue;

    const effBefore = effConf(e);
    const cleared = { ...e, ignoreCount: 0, irrelevantCount: 0, noiseReasonCounts: {} };
    const effAfter = effConf(cleared);
    targeted++;
    if (effBefore < MIN_CONFIDENCE && effAfter >= MIN_CONFIDENCE) revived++;
    if (samples.length < 6) {
      samples.push({ id: String(p.id).slice(0, 8), base: (e.confidence || 0.5).toFixed(3), neg: negativeSignal(e), effBefore: effBefore.toFixed(3), effAfter: effAfter.toFixed(3) });
    }
    if (apply) {
      try { await setPayloadJson(url, key, name, p.id, JSON.stringify(cleared)); applied++; }
      catch (err) { failed++; console.error(`[remediate] ${err.message}`); }
    }
  }
  return { name, total: pts.length, targeted, revived, applied, failed, samples };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const collArg = (() => { const i = argv.indexOf('--collection'); return i >= 0 ? argv[i + 1] : null; })();
  const collections = collArg ? [collArg] : ['experience-selfqa', 'experience-behavioral'];
  const { url, key } = loadQdrant();

  console.log(`[remediate-negsignal] mode=${apply ? 'APPLY' : 'DRY-RUN'} minConfidence=${MIN_CONFIDENCE} qdrant=${url}`);
  console.log(`[remediate-negsignal] collections=${collections.join(', ')}\n`);

  for (const name of collections) {
    const r = await processCollection(url, key, name, apply);
    console.log(`== ${r.name} ==`);
    console.log(`  total points:        ${r.total}`);
    console.log(`  targeted (hits=0, neg>0, non-seed): ${r.targeted}`);
    console.log(`  would cross floor (eff: <${MIN_CONFIDENCE} -> >=${MIN_CONFIDENCE}): ${r.revived}`);
    if (apply) console.log(`  applied=${r.applied} failed=${r.failed}`);
    console.log('  samples (id base neg effBefore->effAfter):');
    for (const s of r.samples) console.log(`    ${s.id}  base=${s.base} neg=${s.neg}  ${s.effBefore} -> ${s.effAfter}`);
    console.log('');
  }
  if (!apply) console.log('[remediate-negsignal] DRY-RUN only — re-run with --apply to write.');
}

main().catch((err) => { console.error('[remediate-negsignal] FATAL', err); process.exit(1); });
