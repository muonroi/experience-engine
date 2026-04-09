#!/usr/bin/env node
/**
 * experience-bulk-seed.js — Bootstrap experience brain from existing memory files
 *
 * Reads feedback_*.md from memory dir, converts to T1 behavioral rules.
 * Bypasses T3→T2→T1→T0 pipeline — directly seeds validated rules.
 *
 * Usage:
 *   node .claude/hooks/experience-bulk-seed.js
 *   node .claude/hooks/experience-bulk-seed.js --dry-run
 *   node .claude/hooks/experience-bulk-seed.js --memory-dir /custom/path
 *   node .claude/hooks/experience-bulk-seed.js --tier 0   (seed as principles instead)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Config ---
// Load config from ~/.experience/config.json if available
let _cfg = {};
try { _cfg = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(), '.experience', 'config.json'), 'utf8')); } catch {}

const QDRANT_BASE = process.env.EXPERIENCE_QDRANT_URL || _cfg.qdrantUrl || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.EXPERIENCE_QDRANT_KEY || _cfg.qdrantKey || '';
const OLLAMA_BASE = process.env.EXPERIENCE_OLLAMA_URL || _cfg.ollamaUrl || 'http://localhost:11434';
const EMBED_MODEL = process.env.EXPERIENCE_EMBED_MODEL || 'nomic-embed-text';

const COLLECTION_T1 = 'experience-behavioral';
const COLLECTION_T0 = 'experience-principles';
const DEDUP_THRESHOLD = 0.90;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TIER = args.includes('--tier') ? parseInt(args[args.indexOf('--tier') + 1]) : 1;
const MEMORY_DIR_ARG = args.includes('--memory-dir') ? args[args.indexOf('--memory-dir') + 1] : null;

// Auto-detect memory dir: try Claude project memory, fallback to ~/.experience/memory
const DEFAULT_MEMORY_DIR = (() => {
  const home = process.env.USERPROFILE || process.env.HOME;
  // Try to find the Claude project memory dir for current working directory
  const cwd = process.cwd().replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
  const claudeProjectDir = path.join(home, '.claude', 'projects', cwd, 'memory');
  if (require('fs').existsSync(claudeProjectDir)) return claudeProjectDir;
  // Fallback: generic experience memory dir
  return path.join(home, '.experience', 'memory');
})();
const MEMORY_DIR = MEMORY_DIR_ARG || DEFAULT_MEMORY_DIR;

// --- Parse markdown memory file ---
function parseMemoryFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // Extract frontmatter
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const fm = {};
  for (const line of fmMatch[1].split('\n')) {
    const [k, ...v] = line.split(':');
    if (k && v.length) fm[k.trim()] = v.join(':').trim();
  }

  const body = fmMatch[2].trim();
  if (!body) return null;

  // Extract sections
  const whyMatch = body.match(/\*\*Why:\*\*\s*([\s\S]*?)(?=\*\*How to apply:\*\*|$)/);
  const howMatch = body.match(/\*\*How to apply:\*\*\s*([\s\S]*?)$/);

  const firstLine = body.split('\n')[0].replace(/\*\*/g, '').trim();
  const why = whyMatch ? whyMatch[1].trim() : '';
  const how = howMatch ? howMatch[1].trim() : '';

  return {
    name: fm.name || path.basename(filePath, '.md'),
    description: fm.description || '',
    type: fm.type || 'feedback',
    trigger: fm.description || firstLine,
    solution: firstLine,
    reasoning: [why, how].filter(Boolean),
    rawBody: body,
  };
}

// --- Embed ---
async function embed(text) {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  return (await res.json()).embeddings?.[0];
}

// --- Dedup check ---
async function isDuplicate(vector, collection) {
  try {
    const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
      body: JSON.stringify({ query: vector, limit: 1, with_payload: false }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    const score = body.result?.points?.[0]?.score ?? 0;
    return score > DEDUP_THRESHOLD;
  } catch { return false; }
}

// --- Store ---
async function store(vector, payload, collection) {
  const id = crypto.randomUUID();
  const res = await fetch(`${QDRANT_BASE}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    body: JSON.stringify({
      points: [{ id, vector, payload: { json: JSON.stringify({ id, ...payload }) } }]
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Store failed: ${res.status}`);
  return id;
}

// --- Main ---
async function main() {
  console.log(`\n🧠 Experience Bulk Seed`);
  console.log(`   Memory dir: ${MEMORY_DIR}`);
  console.log(`   Target tier: T${TIER} (${TIER === 0 ? 'principles' : 'behavioral'})`);
  console.log(`   Dry run: ${DRY_RUN}\n`);

  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(`✗ Memory dir not found: ${MEMORY_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(MEMORY_DIR)
    .filter(f => f.startsWith('feedback_') && f.endsWith('.md'))
    .map(f => path.join(MEMORY_DIR, f));

  console.log(`Found ${files.length} feedback files\n`);

  const collection = TIER === 0 ? COLLECTION_T0 : COLLECTION_T1;
  let seeded = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const name = path.basename(file);
    const parsed = parseMemoryFile(file);

    if (!parsed) {
      console.log(`  ⚠ ${name} — could not parse, skipping`);
      skipped++;
      continue;
    }

    const embedText = `${parsed.trigger} ${parsed.solution}`;
    const payload = {
      trigger: parsed.trigger,
      solution: parsed.solution,
      reasoning: parsed.reasoning,
      source: name,
      confidence: 0.92,
      hitCount: 10,  // pre-validated = high hitCount
      tier: TIER,
      createdAt: new Date().toISOString(),
      createdFrom: 'bulk-seed',
    };

    if (TIER === 0) {
      payload.principle = parsed.solution;
    }

    console.log(`  ◆ ${parsed.name}`);
    console.log(`    trigger: ${parsed.trigger.slice(0, 80)}...`);

    if (DRY_RUN) {
      console.log(`    → [dry-run] would store in ${collection}`);
      seeded++;
      continue;
    }

    try {
      const vector = await embed(embedText);
      if (!vector) { console.log(`    ✗ embed failed`); failed++; continue; }

      const dup = await isDuplicate(vector, collection);
      if (dup) { console.log(`    → duplicate, skipping`); skipped++; continue; }

      const id = await store(vector, payload, collection);
      console.log(`    ✓ stored → ${id.slice(0, 8)}...`);
      seeded++;
    } catch (e) {
      console.log(`    ✗ error: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` Seeded:  ${seeded}`);
  console.log(` Skipped: ${skipped} (duplicate or parse fail)`);
  console.log(` Failed:  ${failed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
