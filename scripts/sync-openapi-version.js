#!/usr/bin/env node
// Copy package.json "version" into docs/openapi.yaml info.version.
// Runs from the npm "version" lifecycle, so `npm version <x>` keeps them in step.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const specPath = path.join(root, 'docs', 'openapi.yaml');
const spec = fs.readFileSync(specPath, 'utf8');
const next = spec.replace(/^(info:\n(?:[ \t].*\n)*?\s+version:\s*)\S+/m, `$1${version}`);
if (next === spec && !spec.includes(`version: ${version}`)) {
  console.error('sync-openapi-version: info.version not found in docs/openapi.yaml');
  process.exit(1);
}
fs.writeFileSync(specPath, next);
console.log(`docs/openapi.yaml info.version = ${version}`);
