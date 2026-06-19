#!/usr/bin/env node
'use strict';

/**
 * update.js — cross-platform "check for updates" + "run the update".
 *
 * Two subcommands, dispatched from bin/cli.js:
 *   experience-engine check-update   → compare installed vs npm registry latest,
 *                                       print, exit 0 (up-to-date) / 10 (behind) /
 *                                       1 (check failed). No side effects.
 *   experience-engine update [-f]    → check, then (if behind, or --force) run the
 *                                       right updater for the install mode:
 *                                         git checkout → bash upgrade.sh
 *                                         npm-global   → npm i -g @latest, then
 *                                                        `init --yes` to refresh
 *                                                        ~/.experience runtime.
 *
 * The installed version is this package's own package.json version (the code that
 * is actually running). The latest is the registry dist-tags.latest — the same
 * source the release process verifies against. No dependency on bash for the
 * check or the npm-global update path, so it runs natively on Windows.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_NAME = '@muonroi/experience-engine';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}`;

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function installedVersion(root = packageRoot()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch (err) {
    // No package.json next to the running code is unrecoverable — surface it.
    throw new Error(`cannot read installed version: ${err.message}`);
  }
}

/**
 * Compare two semver-ish strings. Returns -1 (a<b), 0 (a==b), 1 (a>b).
 * Build metadata is ignored; a prerelease (1.0.0-rc1) sorts BELOW its release
 * (1.0.0). Good enough for the 0.x line this package ships.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).trim().replace(/^v/, '').split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** GET the registry dist-tags.latest with a timeout. Throws on any failure. */
async function fetchLatest(url = REGISTRY_URL, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Abbreviated metadata document — smaller payload, still carries dist-tags.
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const body = await res.json();
    const latest = body && body['dist-tags'] && body['dist-tags'].latest;
    if (!latest) throw new Error('registry response missing dist-tags.latest');
    return latest;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve installed + latest and whether the install is behind.
 * @param {object} [opts] {installed, url, timeoutMs} — overrides for testing.
 */
async function checkUpdate(opts = {}) {
  const installed = opts.installed || installedVersion();
  const latest = await fetchLatest(opts.url, opts.timeoutMs);
  const behind = compareVersions(installed, latest) < 0;
  return { installed, latest, behind, upToDate: !behind };
}

/** A git checkout updates via upgrade.sh; everything else via npm-global. */
function detectMode(root = packageRoot()) {
  return fs.existsSync(path.join(root, '.git')) ? 'git' : 'npm';
}

/** Run the updater for the detected mode. Returns the spawnSync result. */
function runUpdate(mode, io = { stdout: process.stdout }, root = packageRoot()) {
  const win = process.platform === 'win32';
  if (mode === 'git') {
    io.stdout.write('[update] git checkout detected → bash upgrade.sh\n');
    return spawnSync('bash', [path.join(root, 'upgrade.sh')], {
      stdio: 'inherit',
      env: process.env,
    });
  }
  io.stdout.write(`[update] npm-global install detected → npm i -g ${PKG_NAME}@latest\n`);
  // npm + experience-engine are .cmd shims on Windows → must go through the shell.
  const inst = spawnSync('npm', ['install', '-g', `${PKG_NAME}@latest`], {
    stdio: 'inherit',
    env: process.env,
    shell: win,
  });
  if (inst.error || (typeof inst.status === 'number' && inst.status !== 0)) return inst;
  io.stdout.write('[update] refreshing ~/.experience (experience-engine init --yes)\n');
  // Resolves via PATH to the freshly-installed global binary; init reuses the
  // serverBaseUrl/token already in config.json (non-interactive --yes).
  return spawnSync('experience-engine', ['init', '--yes'], {
    stdio: 'inherit',
    env: process.env,
    shell: win,
  });
}

async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const sub = argv[0];
  const checkOnly = sub === 'check-update' || sub === 'check';
  const force = argv.includes('--force') || argv.includes('-f');

  let result;
  try {
    result = await checkUpdate();
  } catch (err) {
    io.stderr.write(`[update] update check failed: ${err.message}\n`);
    return 1;
  }
  const { installed, latest, behind } = result;

  if (checkOnly) {
    io.stdout.write(`Installed: ${installed}   Latest: ${latest}\n`);
    io.stdout.write(behind
      ? `↑ Update available — run 'experience-engine update'\n`
      : `✓ Up to date\n`);
    return behind ? 10 : 0;
  }

  if (!behind && !force) {
    io.stdout.write(`✓ Already up to date (${installed})\n`);
    return 0;
  }
  io.stdout.write(behind
    ? `Installed ${installed} → latest ${latest} available\n`
    : `Re-running update (forced) — installed ${installed}, latest ${latest}\n`);

  const mode = detectMode();
  const child = runUpdate(mode, io);
  if (!child || child.error) {
    io.stderr.write(`[update] update failed: ${(child && child.error && child.error.message) || 'unknown error'}\n`);
    return 1;
  }
  if (typeof child.status === 'number' && child.status !== 0) {
    io.stderr.write(`[update] updater exited with status ${child.status}\n`);
    return child.status;
  }
  io.stdout.write(mode === 'git'
    ? `✓ Update complete (git pull + runtime sync)\n`
    : `✓ Updated to ${latest}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  PKG_NAME,
  REGISTRY_URL,
  packageRoot,
  installedVersion,
  compareVersions,
  fetchLatest,
  checkUpdate,
  detectMode,
  runUpdate,
  main,
};
