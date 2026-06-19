#!/usr/bin/env node
'use strict';

/**
 * interceptor-session-profile.test.js — "Who Am I" v4.0 slice 2 wiring test (T6).
 *
 * Drives the real SessionStart hook end-to-end via spawnSync, hermetic + offline:
 * a mkdtemp HOME mirrors the install layout (~/.experience/interceptor-session.js
 * + ~/.experience/src/{config,profile-model,profile-render}.js), config.json points
 * Qdrant at an unreachable URL, and there is no source-meta-enrich.js so the slug is
 * null — exercising the PROFILE-ONLY emit path (no brief, no network).
 *
 * Privacy is driven via the config.json `privacyLevel` KEY (it wins over the
 * EXPERIENCE_PRIVACY_LEVEL env at config.js cfgValue order). Assert on exit code +
 * parsed stdout JSON, never timing (avoids Windows undici-drain flakiness).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pm = require('../.experience/src/profile-model');
const { PROFILE_START } = require('../.experience/src/profile-render');

const REPO_EXP = path.join(__dirname, '..', '.experience');
const HOOK = path.join(REPO_EXP, 'interceptor-session.js');
const SRC = path.join(REPO_EXP, 'src');

function committedProfileYaml() {
  return pm.serializeProfile({
    version: 1,
    updatedAt: null,
    dimensions: {
      'communication.brevity': { value: 'concise', confidence: 0.8, sampleCount: 20, distribution: { concise: 16, moderate: 4 }, evidence: null },
    },
  });
}

function setupHome({ privacyLevel, profileYaml, includeRenderer = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sess-prof-'));
  const expDir = path.join(home, '.experience');
  fs.mkdirSync(path.join(expDir, 'src'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(expDir, 'interceptor-session.js'));
  const mods = ['config.js', 'profile-model.js'].concat(includeRenderer ? ['profile-render.js'] : []);
  for (const m of mods) fs.copyFileSync(path.join(SRC, m), path.join(expDir, 'src', m));
  fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify({ privacyLevel, qdrantUrl: 'http://127.0.0.1:1' }), 'utf8');
  if (profileYaml != null) fs.writeFileSync(path.join(expDir, 'profile.yaml'), profileYaml, 'utf8');
  return home;
}

const homes = [];
function freshRun(opts) {
  const home = setupHome(opts);
  homes.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EXPERIENCE_PRIVACY_LEVEL; // drive privacy via the config.json key only
  return spawnSync(process.execPath, [path.join(home, '.experience', 'interceptor-session.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: home }),
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('privacyLevel off → hook emits no profile block', () => {
  const res = freshRun({ privacyLevel: 'off', profileYaml: committedProfileYaml() });
  assert.equal(res.status, 0);
  assert.ok(!String(res.stdout).includes(PROFILE_START), 'off must not emit the profile block');
});

test('privacyLevel standard + committed profile → emits the block on the profile-only path (no slug/brief)', () => {
  const res = freshRun({ privacyLevel: 'standard', profileYaml: committedProfileYaml() });
  assert.equal(res.status, 0);
  const out = String(res.stdout);
  assert.ok(out.includes(PROFILE_START), `expected profile block, got: ${out.slice(0, 240)}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Brevity/);
});

test('malformed profile.yaml → hook exits 0, no crash, no block (degrade, not drop)', () => {
  const res = freshRun({ privacyLevel: 'standard', profileYaml: 'garbage: : :\n\t- not valid\n%%%' });
  assert.equal(res.status, 0);
  assert.ok(!String(res.stdout).includes(PROFILE_START));
});

test('missing src/profile-render.js (thin-client shape) → hook exits 0, degrades, no crash', () => {
  const res = freshRun({ privacyLevel: 'standard', profileYaml: committedProfileYaml(), includeRenderer: false });
  assert.equal(res.status, 0);
  assert.ok(!String(res.stdout).includes(PROFILE_START));
});

test.after(() => {
  for (const h of homes) {
    try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
