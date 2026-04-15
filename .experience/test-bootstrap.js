#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const probe = spawnSync('/bin/bash', ['-lc', 'exit 0'], { encoding: 'utf8' });
const BASH_BLOCKED = !!probe.error;

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-bootstrap-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.experience', 'status'), { recursive: true });
  return homeDir;
}

function repoScript(name) {
  return path.join(__dirname, name);
}

test('bootstrap persists latest health snapshot', { skip: BASH_BLOCKED ? 'sandbox blocks bash child processes' : false }, () => {
  const homeDir = makeHome();
  const expDir = path.join(homeDir, '.experience');

  fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify({
    qdrantUrl: 'http://127.0.0.1:1',
    tunnelSsh: '',
  }, null, 2));

  fs.writeFileSync(path.join(expDir, 'health-check.sh'), `#!/bin/bash
echo '{"config":{"status":"ok","detail":"config.json","fix":""},"summary":{"pass":2,"warn":1,"fail":0}}'
exit 0
`);
  fs.chmodSync(path.join(expDir, 'health-check.sh'), 0o755);

  const scriptPath = repoScript('exp-bootstrap.sh');
  const run = spawnSync('/bin/bash', [scriptPath, '--reason', 'test'], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0);
  const latest = path.join(expDir, 'status', 'boot-health-latest.meta.json');
  assert.equal(fs.existsSync(latest), true);

  const snapshot = JSON.parse(fs.readFileSync(latest, 'utf8'));
  assert.equal(snapshot.reason, 'test');
  assert.equal(snapshot.overall, 'degraded');
  assert.equal(snapshot.health.summary.pass, 2);
  assert.equal(snapshot.health.summary.warn, 1);
  assert.equal(snapshot.health.summary.fail, 0);
});

test('exp-health-last prints concise status line', { skip: BASH_BLOCKED ? 'sandbox blocks bash child processes' : false }, () => {
  const homeDir = makeHome();
  const expDir = path.join(homeDir, '.experience');
  const snapshotPath = path.join(expDir, 'status', 'boot-health-latest.meta.json');

  fs.writeFileSync(snapshotPath, JSON.stringify({
    ts: new Date().toISOString(),
    reason: 'test',
    overall: 'unhealthy',
    bootstrap: { tunnelConfigured: true, tunnelReachable: false, tunnelStarted: true, tunnelError: 'timeout' },
    health: { summary: { pass: 1, warn: 0, fail: 2 } },
  }, null, 2));

  const cmdPath = repoScript('exp-health-last');
  const run = spawnSync('/bin/bash', [cmdPath, '--brief'], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Experience Engine UNHEALTHY/);
  assert.match(run.stdout, /1 pass, 0 warn, 2 fail/);
});
