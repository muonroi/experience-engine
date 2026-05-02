#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function requireTestsFrom(dirPath) {
  const entries = fs.readdirSync(dirPath)
    .filter(name => name.startsWith('test-') && name.endsWith('.js'))
    .sort();

  for (const entry of entries) {
    require(path.join(dirPath, entry));
  }
}

requireTestsFrom(path.join(REPO_ROOT, '.experience'));
for (const toolTest of ['test-exp-gates.js', 'test-exp-portable.js', 'test-exp-stats.js']) {
  require(path.join(REPO_ROOT, 'tools', toolTest));
}
