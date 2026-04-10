#!/usr/bin/env node
/**
 * exp-demote.js — Interactive CLI for manually demoting/deleting experience entries
 *
 * Usage:
 *   node tools/exp-demote.js "query string"
 *
 * Searches all 3 experience collections for entries matching the query,
 * displays top 3 results, and prompts for interactive deletion.
 */

'use strict';

const path = require('path');
const os = require('os');
const readline = require('readline');

// Load experience-core from ~/.experience/ (same pattern as bulk-seed.js)
let getEmbeddingRaw, searchCollection, deleteEntry;
try {
  ({ getEmbeddingRaw, searchCollection, deleteEntry } = require(
    path.join(os.homedir(), '.experience', 'experience-core.js')
  ));
} catch (e) {
  console.error('[FAIL] Cannot load experience-core.js from ~/.experience/');
  console.error('Fix: Run setup.sh first to install the Experience Engine.');
  process.exit(1);
}

const COLLECTIONS = ['experience-principles', 'experience-behavioral', 'experience-selfqa'];

const query = process.argv[2];
if (!query) {
  console.log('Usage: node tools/exp-demote.js "<search query>"');
  console.log('');
  console.log('Searches all experience collections and allows interactive deletion.');
  console.log('');
  console.log('Examples:');
  console.log('  node tools/exp-demote.js "IMLog usage"');
  console.log('  node tools/exp-demote.js "library first principle"');
  process.exit(0);
}

function parsePayload(entry) {
  try { return JSON.parse(entry.payload?.json || '{}'); } catch { return null; }
}

function truncate(str, maxLen) {
  if (!str) return '(no text)';
  return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + '...';
}

async function main() {
  console.log(`Searching for: "${query}"`);
  console.log('');

  // Get embedding for query
  const vector = await getEmbeddingRaw(query);
  if (!vector) {
    console.error('[FAIL] Could not get embedding — embedding service unavailable.');
    process.exit(1);
  }

  // Search all 3 collections (topK=3 each)
  const allResults = [];
  for (const coll of COLLECTIONS) {
    try {
      const results = await searchCollection(coll, vector, 3);
      for (const r of results) {
        allResults.push({ ...r, _collection: coll });
      }
    } catch { /* skip collection on error */ }
  }

  if (allResults.length === 0) {
    console.log('No matches found.');
    process.exit(0);
  }

  // Sort by score descending, take top 3 overall
  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top3 = allResults.slice(0, 3);

  // Display numbered list
  console.log('Top matches:\n');
  for (let i = 0; i < top3.length; i++) {
    const entry = top3[i];
    const data = parsePayload(entry);
    const solution = data?.solution || data?.principle || '(unknown)';
    const hits = data?.hitCount || 0;
    const ignores = data?.ignoreCount || 0;
    const score = typeof entry.score === 'number' ? entry.score.toFixed(3) : '?';
    console.log(`[${i + 1}] ${entry._collection} | score: ${score} | "${truncate(solution, 80)}" | hits:${hits} ignores:${ignores}`);
    console.log(`    id: ${entry.id}`);
    console.log('');
  }

  // Interactive prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question("Select entry to delete (1-3) or 'q' to quit: ", async (answer) => {
    rl.close();

    if (answer === 'q' || answer === 'Q' || answer === '') {
      console.log('Aborted.');
      process.exit(0);
    }

    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= top3.length) {
      console.log('Invalid selection. Aborted.');
      process.exit(0);
    }

    const selected = top3[idx];
    const data = parsePayload(selected);
    const solution = data?.solution || data?.principle || '(unknown)';
    console.log(`\nDeleting: [${selected._collection}] "${truncate(solution, 80)}"`);
    console.log(`ID: ${selected.id}`);

    try {
      await deleteEntry(selected._collection, selected.id);
      console.log('Deleted successfully.');
    } catch (e) {
      console.error(`[FAIL] Delete failed: ${e.message}`);
      process.exit(1);
    }
  });
}

main().catch(e => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
