#!/usr/bin/env node
// `node --check` every tracked .js/.cjs/.mjs file. Catches files that cannot even
// load (e.g. a `*/` inside a block comment) in code no test happens to require.
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');

const files = execFileSync('git', ['ls-files', '*.js', '*.cjs', '*.mjs'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const failed = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) failed.push(`${file}\n${r.stderr.trim()}`);
}

if (failed.length) {
  console.error(`Syntax errors in ${failed.length} file(s):\n\n${failed.join('\n\n')}`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length} files OK`);
