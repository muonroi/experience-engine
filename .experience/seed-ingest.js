#!/usr/bin/env node
'use strict';

/**
 * seed-ingest.js — Bulk-seed Experience Engine from org-doc JSONL.
 *
 * Input shape per JSONL line (from Colab notebook):
 *   {
 *     id_hint, tier ("T0"|"T1"|"T2"),
 *     trigger_main, trigger_variants[],
 *     guidance, why, alternatives_to_avoid[], see_also[],
 *     scope: {lang, framework, org}, evidenceClass: "org-doc",
 *     source: {file, section}, code_refs[], confidence
 *   }
 *
 * Behavior:
 *   - For each entry: embed trigger_main + every trigger_variant separately,
 *     upsert one Qdrant point per trigger pointing to the same canonical payload.
 *     This is route amplification — diverse phrasings all retrieve the same lesson.
 *   - Writes a batch manifest to .experience/seed-batches/<batchId>.json so
 *     --rollback can delete every point this batch created.
 *   - Skips assessExtractedQaQuality entirely: seed entries have a different
 *     schema (trigger_main/guidance/why) than runtime-extracted Q/A
 *     (trigger/question/solution), and quality control was already done in
 *     the Colab extraction prompt.
 *
 * Usage:
 *   node seed-ingest.js seed-entries.jsonl --dry-run
 *   node seed-ingest.js seed-entries.jsonl --batch-id=2026-05-09-bb-v1
 *   node seed-ingest.js seed-entries.jsonl --limit=20            # ingest only first 20
 *   node seed-ingest.js --rollback 2026-05-09-bb-v1
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getEmbedding } = require('./src/embedding');
const { upsertEntry } = require('./src/evolution');
const { deleteEntry } = require('./src/qdrant');

const TIER_COLLECTION = {
  T0: 'experience-principles',
  T1: 'experience-behavioral',
  T2: 'experience-selfqa',
};

const TIER_NUM = { T0: 0, T1: 1, T2: 2 };

const BATCH_DIR = path.join(__dirname, 'seed-batches');

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { jsonl: null, dryRun: false, batchId: null, limit: null, rollback: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rollback') args.rollback = argv[++i];
    else if (a.startsWith('--batch-id=')) args.batchId = a.slice('--batch-id='.length);
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.slice('--limit='.length), 10);
    else if (!a.startsWith('--') && !args.jsonl) args.jsonl = a;
  }
  return args;
}

// ---------- entry validation ----------

const REQUIRED_KEYS = ['id_hint', 'tier', 'trigger_main', 'trigger_variants', 'guidance', 'why', 'source', 'evidenceClass'];

const ALLOWED_EVIDENCE_CLASSES = new Set(['org-doc', 'common-doc']);

function validateEntry(e, idx) {
  for (const k of REQUIRED_KEYS) {
    if (e[k] === undefined || e[k] === null) return `entry[${idx}] missing key: ${k}`;
  }
  if (!TIER_COLLECTION[e.tier]) return `entry[${idx}] invalid tier: ${e.tier}`;
  if (!ALLOWED_EVIDENCE_CLASSES.has(e.evidenceClass)) return `entry[${idx}] unexpected evidenceClass: ${e.evidenceClass}`;
  if (typeof e.trigger_main !== 'string' || e.trigger_main.length < 8) return `entry[${idx}] trigger_main too short`;
  if (!Array.isArray(e.trigger_variants)) return `entry[${idx}] trigger_variants not array`;
  if (typeof e.guidance !== 'string' || e.guidance.length < 12) return `entry[${idx}] guidance too short`;
  if (!e.scope || typeof e.scope !== 'object') return `entry[${idx}] missing scope object`;
  // scope.org is the cross-repo gate. REQUIRED for org-doc (otherwise it leaks
  // into non-org repos). FORBIDDEN for common-doc (which is meant to be universal).
  if (e.evidenceClass === 'org-doc') {
    if (!e.scope.org || typeof e.scope.org !== 'string') return `entry[${idx}] scope.org required for org-doc entries`;
  } else if (e.evidenceClass === 'common-doc') {
    if (e.scope.org) return `entry[${idx}] common-doc must NOT set scope.org (would gate as org-specific)`;
    if (!e.scope.lang) return `entry[${idx}] common-doc must set scope.lang (use "all" for language-agnostic)`;
  }
  return null;
}

// ---------- payload construction ----------

function buildPayload(entry, canonicalId, batchId) {
  const tierNum = TIER_NUM[entry.tier];
  return {
    id: canonicalId,
    // Mirror existing schema where possible so reads via parsePayload work
    principle: entry.guidance,
    solution: entry.guidance,
    trigger: entry.trigger_main,
    triggerVariants: entry.trigger_variants,
    why: entry.why,
    alternativesToAvoid: entry.alternatives_to_avoid || [],
    seeAlso: entry.see_also || [],
    scope: entry.scope || {},
    failureMode: 'misapplied_pattern',         // closest fixed enum for "raw API instead of wrapper"
    judgment: 'follow',
    evidenceClass: entry.evidenceClass,
    tier: tierNum,
    confidence: Math.min(0.85, Math.max(0.5, entry.confidence || 0.7)),
    hitCount: 0,
    confirmedAt: [],
    createdAt: new Date().toISOString(),
    createdFrom: entry.evidenceClass === 'common-doc' ? 'seed-common-doc' : 'seed-org-doc',
    seedBatchId: batchId,
    seedSource: entry.source,
    seedCodeRefs: entry.code_refs || [],
    seedIdHint: entry.id_hint,
  };
}

// ---------- main ingest ----------

async function runIngest(args) {
  const raw = fs.readFileSync(args.jsonl, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try { entries.push(JSON.parse(lines[i])); }
    catch (e) { console.error(`Line ${i + 1}: JSON parse error — ${e.message}`); process.exit(1); }
  }

  const limited = args.limit ? entries.slice(0, args.limit) : entries;

  // Validate all before any write
  const validationErrors = [];
  for (let i = 0; i < limited.length; i++) {
    const err = validateEntry(limited[i], i);
    if (err) validationErrors.push(err);
  }
  if (validationErrors.length) {
    console.error(`Validation failed: ${validationErrors.length} errors`);
    validationErrors.slice(0, 10).forEach((e) => console.error('  ' + e));
    if (validationErrors.length > 10) console.error(`  ... and ${validationErrors.length - 10} more`);
    process.exit(1);
  }

  const batchId = args.batchId || `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const tierCounts = { T0: 0, T1: 0, T2: 0 };
  let totalPoints = 0;
  for (const e of limited) {
    tierCounts[e.tier]++;
    totalPoints += 1 + (e.trigger_variants?.length || 0);
  }

  console.log('━'.repeat(60));
  console.log(`Mode:         ${args.dryRun ? 'DRY-RUN' : 'INGEST'}`);
  console.log(`Batch ID:     ${batchId}`);
  console.log(`Entries:      ${limited.length}  (T0=${tierCounts.T0} T1=${tierCounts.T1} T2=${tierCounts.T2})`);
  console.log(`Points (with variants): ${totalPoints}`);
  console.log('━'.repeat(60));

  if (args.dryRun) {
    console.log('\n--- Sample payload preview (first entry) ---');
    const sample = buildPayload(limited[0], 'preview-id', batchId);
    console.log(JSON.stringify(sample, null, 2));
    console.log('\nDry-run complete. No writes performed.');
    return;
  }

  if (!fs.existsSync(BATCH_DIR)) fs.mkdirSync(BATCH_DIR, { recursive: true });
  const manifestPath = path.join(BATCH_DIR, `${batchId}.json`);
  if (fs.existsSync(manifestPath)) {
    console.error(`Batch manifest already exists: ${manifestPath}`);
    console.error('Pick a new --batch-id or remove the existing manifest first.');
    process.exit(1);
  }

  const manifest = { batchId, createdAt: new Date().toISOString(), source: path.resolve(args.jsonl), points: [] };
  // Flush manifest periodically so a crash mid-run is still rollback-able
  const flushManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  flushManifest();

  let ingestedEntries = 0;
  let ingestedPoints = 0;
  let failedEntries = 0;

  for (let i = 0; i < limited.length; i++) {
    const e = limited[i];
    const collection = TIER_COLLECTION[e.tier];
    const canonicalId = crypto.randomUUID();
    const payload = buildPayload(e, canonicalId, batchId);

    const triggers = [e.trigger_main, ...(e.trigger_variants || [])];
    let pointsThisEntry = 0;
    let entryFailed = false;

    for (let v = 0; v < triggers.length; v++) {
      const triggerText = triggers[v];
      try {
        const vector = await getEmbedding(triggerText);
        if (!vector) { entryFailed = true; break; }
        const pointId = crypto.randomUUID();
        const pointPayload = { ...payload, triggerText, variantIndex: v, canonicalEntryId: canonicalId };
        await upsertEntry(collection, pointId, vector, pointPayload);
        manifest.points.push({ collection, pointId, tier: e.tier, variantIndex: v });
        pointsThisEntry++;
      } catch (err) {
        console.error(`  entry[${i}] variant[${v}] failed: ${err.message}`);
        entryFailed = true;
        break;
      }
    }

    if (entryFailed) { failedEntries++; }
    else { ingestedEntries++; ingestedPoints += pointsThisEntry; }

    if ((i + 1) % 10 === 0) {
      flushManifest();
      console.log(`[${i + 1}/${limited.length}] entries-ok=${ingestedEntries} points=${ingestedPoints} failed=${failedEntries}`);
    }
  }

  flushManifest();
  console.log('━'.repeat(60));
  console.log(`DONE. entries-ok=${ingestedEntries}/${limited.length} points=${ingestedPoints} failed=${failedEntries}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Rollback: node seed-ingest.js --rollback ${batchId}`);
}

// ---------- rollback ----------

async function runRollback(batchId) {
  const manifestPath = path.join(BATCH_DIR, `${batchId}.json`);
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Rolling back batch: ${batchId}`);
  console.log(`Points to delete: ${manifest.points.length}`);

  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < manifest.points.length; i++) {
    const p = manifest.points[i];
    try {
      await deleteEntry(p.collection, p.pointId);
      deleted++;
    } catch (e) {
      failed++;
    }
    if ((i + 1) % 50 === 0) console.log(`  [${i + 1}/${manifest.points.length}] deleted=${deleted} failed=${failed}`);
  }

  const archivePath = manifestPath + '.rolled-back-' + Date.now();
  fs.renameSync(manifestPath, archivePath);
  console.log(`DONE. deleted=${deleted} failed=${failed}`);
  console.log(`Manifest archived: ${archivePath}`);
}

// ---------- entry point ----------

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) {
    await runRollback(args.rollback);
    return;
  }
  if (!args.jsonl) {
    console.error('Usage:');
    console.error('  node seed-ingest.js <file.jsonl> [--dry-run] [--batch-id=ID] [--limit=N]');
    console.error('  node seed-ingest.js --rollback <batchId>');
    process.exit(1);
  }
  await runIngest(args);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
