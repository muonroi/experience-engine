'use strict';

// docs/openapi.yaml must describe exactly what api/routes.js serves, and carry
// the package version. Parsed by indentation (zero deps): paths are the
// two-space keys under `paths:`, operations the four-space method keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const { ROUTES } = require('../api/routes');
const { isReadOnlyApiPath, isProtectedGetPath } = require('../api/auth');

function documentedOperations(yamlText) {
  const ops = new Set();
  let inPaths = false;
  let current = null;
  for (const line of yamlText.split('\n')) {
    if (/^\S/.test(line)) { inPaths = line.startsWith('paths:'); current = null; continue; }
    if (!inPaths) continue;
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) { current = p[1]; continue; }
    const m = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (m && current) ops.add(`${m[1].toUpperCase()} ${current}`);
  }
  return ops;
}

const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'openapi.yaml'), 'utf8');
const documented = documentedOperations(spec);
const served = new Set(ROUTES.map(r => `${r.method} ${r.path}`));

test('every served route is documented in openapi.yaml', () => {
  const missing = [...served].filter(op => !documented.has(op));
  assert.deepEqual(missing, [], `add these to docs/openapi.yaml: ${missing.join(', ')}`);
});

test('openapi.yaml documents no route the server does not serve', () => {
  const extra = [...documented].filter(op => !served.has(op));
  assert.deepEqual(extra, [], `not served by api/routes.js: ${extra.join(', ')}`);
});

test('openapi.yaml info.version matches package.json', () => {
  const { version } = require('../package.json');
  const m = spec.match(/^info:\n(?:[ \t].*\n)*?\s+version:\s*(\S+)/m);
  assert.equal(m && m[1], version, 'run `node scripts/sync-openapi-version.js`');
});

test('route access levels agree with the auth rules', () => {
  for (const r of ROUTES) {
    if (r.access === 'public') {
      assert.equal(r.method, 'GET', `${r.path}: public routes are GET`);
      continue;
    }
    if (r.method === 'GET') {
      assert.ok(isProtectedGetPath(r.path), `${r.path} should be protected`);
      assert.equal(isReadOnlyApiPath(r.path), r.access === 'read', `${r.path}: access '${r.access}' disagrees with isReadOnlyApiPath`);
    } else {
      assert.equal(r.access, 'write', `${r.method} ${r.path}: non-GET routes need the full token`);
    }
  }
});

test('route table has no duplicate method + path', () => {
  assert.equal(served.size, ROUTES.length);
});
