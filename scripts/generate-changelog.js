#!/usr/bin/env node
/**
 * generate-changelog.js — Auto-generate CHANGELOG.md from conventional commits.
 * Zero npm dependencies. Uses git log directly.
 *
 * Usage: node scripts/generate-changelog.js [--since=v0.1.0]
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sinceArg = process.argv.find(a => a.startsWith('--since='));
const since = sinceArg ? sinceArg.split('=')[1] : '';
const range = since ? `${since}..HEAD` : 'HEAD~50..HEAD';

const raw = execSync(`git log ${range} --format="%H %s" --no-merges`, { encoding: 'utf8' }).trim();
if (!raw) { console.log('No commits found.'); process.exit(0); }

const categories = {
  feat: { label: 'Features', items: [] },
  fix: { label: 'Bug Fixes', items: [] },
  refactor: { label: 'Refactoring', items: [] },
  perf: { label: 'Performance', items: [] },
  docs: { label: 'Documentation', items: [] },
  test: { label: 'Tests', items: [] },
  chore: { label: 'Chores', items: [] },
};

for (const line of raw.split('\n')) {
  const match = line.match(/^([a-f0-9]+)\s+(feat|fix|refactor|perf|docs|test|chore)(?:\(([^)]*)\))?:\s*(.+)/);
  if (!match) continue;
  const [, hash, type, scope, message] = match;
  const short = hash.slice(0, 7);
  const entry = scope ? `**${scope}:** ${message} (${short})` : `${message} (${short})`;
  if (categories[type]) categories[type].items.push(entry);
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const date = new Date().toISOString().split('T')[0];

let md = `# Changelog\n\n## [${pkg.version}] - ${date}\n\n`;
for (const cat of Object.values(categories)) {
  if (cat.items.length === 0) continue;
  md += `### ${cat.label}\n\n`;
  for (const item of cat.items) md += `- ${item}\n`;
  md += '\n';
}

const outPath = path.join(__dirname, '..', 'CHANGELOG.md');
const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
const merged = existing.startsWith('# Changelog')
  ? md + existing.replace(/^# Changelog\n\n/, '')
  : md;

fs.writeFileSync(outPath, merged);
console.log(`CHANGELOG.md updated (${pkg.version})`);
