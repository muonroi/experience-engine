#!/usr/bin/env node
'use strict';

/**
 * init.js — cross-platform, zero-bash Experience Engine installer.
 *
 * One command for the "just use it" path:
 *   npx @muonroi/experience-engine init
 *
 * Auto-detects a brain (local :8082 → offer Docker → remote thin-client),
 * installs the thin-client runtime into ~/.experience, wires agent hooks via
 * register-hooks.js (already Node, cross-platform), and injects the managed
 * agent-instruction block. No dependency on bash, so it runs natively on
 * Windows. The legacy bash wizard (setup.sh) stays for full local installs.
 *
 * Behavior mirrors .experience/setup-thin-client.sh — see that script for the
 * canonical file lists and config schema this ports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const { injectAgentInstructions } = require('../.experience/src/agent-md');

const DEFAULT_LOCAL_URL = 'http://localhost:8082';

// ── File sets (kept in sync with setup-thin-client.sh) ──────────────────────
const THIN_CLIENT_FILES = [
  'interceptor.js',
  'interceptor-post.js',
  'interceptor-prompt.js',
  'interceptor-session.js',
  'source-meta-enrich.js',
  'stop-extractor.js',
  'posttool-batch-hook.js',
  'remote-client.js',
  'extract-compact.js',
  'exp-client-drain.js',
  'health-check.sh',
  'exp-feedback.js',
  'exp-feedback',
  'exp-recall.js',
  'exp-bootstrap.sh',
  'exp-health-last',
  'exp-shell-init.sh',
  'sync-install.sh',
  'register-hooks.js',
  'inject-agent-instructions.sh',
  'AGENT_GUIDE.md',
];

const THIN_SAFE_SRC = [
  'config.js',
  'risk-triggers.js',
  'surface-trigger.js',
  'signal-detector.js',
  'profile-model.js',
];

const LOCAL_ONLY_FILES = [
  'experience-core.js',
  'judge-worker.js',
  'activity-watch.js',
  'exp-server-maintain.js',
  'exp-portable-backup.js',
  'exp-portable-restore.js',
  'exp-open-pane',
  'exp-watch',
  'exp-pane-bottom',
  'exp-pane-left',
  'exp-pane-right',
];

const EXECUTABLES = [
  'interceptor.js',
  'interceptor-post.js',
  'interceptor-prompt.js',
  'interceptor-session.js',
  'stop-extractor.js',
  'posttool-batch-hook.js',
  'remote-client.js',
  'extract-compact.js',
  'exp-client-drain.js',
  'health-check.sh',
  'exp-feedback.js',
  'exp-feedback',
  'exp-recall.js',
  'exp-bootstrap.sh',
  'exp-health-last',
  'exp-shell-init.sh',
  'sync-install.sh',
  'register-hooks.js',
];

const HELP = `Experience Engine — init (cross-platform installer)

Usage:
  npx @muonroi/experience-engine init [options]

Auto-detects a brain and installs the thin client + agent hooks. No bash, no
Docker required for the client itself.

Mode resolution (in order):
  1. --server URL given (or serverBaseUrl already in config.json) → remote
  2. ${DEFAULT_LOCAL_URL}/health responds → local (no token needed)
  3. Docker + docker-compose.yml present → offer to start the local stack
  4. otherwise → prompt for --server / --token (or fail under --yes)

Options:
  --server URL         Remote brain base URL (thin-client mode)
  --token TOKEN        Bearer token for POST endpoints (remote)
  --read-token TOKEN   Read-only token for /api/stats and /api/gates
  --org-name SLUG      Org slug for cross-project hint filter
  --org-patterns LIST  Comma-sep repo patterns (glob ok)
  --hook-timeout MS    Client hook abort timeout in ms
  --agents CSV         Subset of: claude,gemini,codex,opencode,antigravity
  --local              Force local mode (${DEFAULT_LOCAL_URL})
  --remote             Force remote mode (requires --server)
  --clean              Backup and remove old local brain state
  --yes, -y            Non-interactive; never prompt, never run Docker
  --help, -h           Show this help
`;

function parseArgs(argv) {
  const opts = {
    server: '',
    token: '',
    readToken: '',
    orgName: process.env.EXP_ORG_NAME || '',
    orgPatterns: process.env.EXP_ORG_PATTERNS || '',
    hookTimeout: '',
    agents: '',
    forceLocal: false,
    forceRemote: false,
    clean: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--server': opts.server = argv[++i] || ''; break;
      case '--token': opts.token = argv[++i] || ''; break;
      case '--read-token': opts.readToken = argv[++i] || ''; break;
      case '--org-name': opts.orgName = argv[++i] || ''; break;
      case '--org-patterns': opts.orgPatterns = argv[++i] || ''; break;
      case '--hook-timeout': opts.hookTimeout = argv[++i] || ''; break;
      case '--agents': opts.agents = argv[++i] || ''; break;
      case '--local': opts.forceLocal = true; break;
      case '--remote': opts.forceRemote = true; break;
      case '--clean': opts.clean = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** GET <baseUrl>/health with a timeout. Resolves true on a healthy response. */
async function probeHealth(baseUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body && body.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function dockerAvailable() {
  try {
    const r = spawnSync('docker', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Decide install mode + serverBaseUrl. Returns {mode, serverUrl}.
 * Pure-ish: side effects (docker, prompts) are gated by opts.
 */
async function resolveMode(opts, ctx) {
  const { existingConfig, log, io } = ctx;
  const probe = ctx.probeHealth || probeHealth; // injectable for tests
  const existingUrl = existingConfig && typeof existingConfig.serverBaseUrl === 'string'
    ? existingConfig.serverBaseUrl
    : '';

  if (opts.forceRemote && !opts.server && !existingUrl) {
    throw new Error('--remote requires --server URL');
  }
  if (opts.forceLocal) {
    return { mode: 'local', serverUrl: DEFAULT_LOCAL_URL };
  }
  // 1. Explicit / pre-configured remote URL.
  const explicitUrl = opts.server || existingUrl;
  if (explicitUrl) {
    return { mode: 'remote', serverUrl: explicitUrl };
  }
  // 2. Local brain already running?
  log(`  Probing ${DEFAULT_LOCAL_URL} …`);
  if (await probe(DEFAULT_LOCAL_URL)) {
    log('  ✓ Local brain detected (no token needed)');
    return { mode: 'local', serverUrl: DEFAULT_LOCAL_URL };
  }
  // 3. Offer to start the Docker stack (only from a repo checkout, interactive).
  const composeFile = path.join(packageRoot(), 'docker-compose.yml');
  if (!opts.yes && fs.existsSync(composeFile) && dockerAvailable()) {
    const ans = await io.prompt('  No local brain found. Start it now with Docker? [Y/n] ');
    if (ans === '' || /^y(es)?$/i.test(ans)) {
      log('  Starting Docker stack (docker compose up -d) …');
      const up = spawnSync('docker', ['compose', 'up', '-d'], {
        cwd: packageRoot(),
        stdio: 'inherit',
      });
      if (up.status === 0) {
        log('  Waiting for the brain to become healthy …');
        const ok = await waitForHealth(DEFAULT_LOCAL_URL, 120000, log);
        if (ok) return { mode: 'local', serverUrl: DEFAULT_LOCAL_URL };
        log('  ! Brain did not report healthy in time. You can re-run init once it is up.');
      } else {
        log('  ! docker compose failed — falling back to manual config.');
      }
    }
  }
  // 4. Remote thin-client: prompt for URL (+ token) unless non-interactive.
  if (opts.yes) {
    throw new Error(
      'No local brain found and no --server given. Re-run with --server URL [--token TOKEN], or start a local brain (docker compose up -d).'
    );
  }
  const url = await io.prompt('  Remote brain URL (e.g. https://experience.muonroi.com): ');
  if (!url) throw new Error('A server URL is required to finish setup.');
  const token = opts.token || (await io.prompt('  Bearer token (blank if the server has no auth): '));
  opts.token = token;
  return { mode: 'remote', serverUrl: url };
}

async function waitForHealth(baseUrl, totalMs, log) {
  const deadline = Date.now() + totalMs;
  let dots = 0;
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl, 2000)) return true;
    await new Promise((r) => setTimeout(r, 3000));
    if (log && ++dots % 5 === 0) log('  … still waiting');
  }
  return false;
}

function copyRuntime(installDir, log) {
  const srcExp = path.join(packageRoot(), '.experience');
  let copied = 0;
  for (const f of THIN_CLIENT_FILES) {
    const src = path.join(srcExp, f);
    if (!fs.existsSync(src)) {
      log(`  ! missing in package: .experience/${f}`);
      continue;
    }
    fs.copyFileSync(src, path.join(installDir, f));
    copied += 1;
  }
  fs.mkdirSync(path.join(installDir, 'src'), { recursive: true });
  for (const f of THIN_SAFE_SRC) {
    const src = path.join(srcExp, 'src', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(installDir, 'src', f));
      copied += 1;
    } else if (f === 'config.js') {
      log('  ! src/config.js missing in package — triviality gate falls open to inline defaults');
    }
  }
  if (process.platform !== 'win32') {
    for (const f of EXECUTABLES) {
      const p = path.join(installDir, f);
      if (fs.existsSync(p)) {
        try { fs.chmodSync(p, 0o755); } catch { /* best-effort */ }
      }
    }
  }
  return copied;
}

function pruneLocalOnly(installDir, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(installDir, 'backup-thin-client', `${stamp}-prune`);
  let pruned = 0;
  const moveOut = (rel) => {
    const from = path.join(installDir, rel);
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
    fs.renameSync(from, path.join(backup, rel));
    pruned += 1;
  };
  for (const f of LOCAL_ONLY_FILES) moveOut(f);
  // Remove any local-only src module a prior full install left behind.
  const srcDir = path.join(installDir, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir)) {
      if (!THIN_SAFE_SRC.includes(f)) moveOut(path.join('src', f));
    }
  }
  if (pruned > 0) log(`  ✓ Pruned ${pruned} local-only artefact(s) (backup: ${backup})`);
  return pruned;
}

/** Build the thin-client config object, preserving prior org/* + timeout. */
function buildConfig(opts, serverUrl, existingConfig) {
  const cfg = {
    serverBaseUrl: serverUrl.replace(/\/$/, ''),
    serverAuthToken: opts.token || (existingConfig && existingConfig.serverAuthToken) || '',
    serverReadAuthToken: opts.readToken || (existingConfig && existingConfig.serverReadAuthToken) || '',
    serverTimeoutMs: 5000,
    serverExtractTimeoutMs: 60000,
    version: 'thin-client',
    installedAt: new Date().toISOString(),
  };
  const hookTimeout = parseInt(
    opts.hookTimeout || (existingConfig && existingConfig.serverHookTimeoutMs) || '',
    10
  );
  if (Number.isFinite(hookTimeout) && hookTimeout > 0) cfg.serverHookTimeoutMs = hookTimeout;

  const existingOrg = existingConfig && existingConfig.org && typeof existingConfig.org === 'object'
    ? existingConfig.org
    : null;
  if (opts.orgName && opts.orgName.trim()) {
    const patterns = opts.orgPatterns
      ? opts.orgPatterns.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const preserved = {};
    if (existingOrg) {
      for (const [k, v] of Object.entries(existingOrg)) {
        if (k !== 'name' && k !== 'repoPatterns') preserved[k] = v;
      }
    }
    cfg.org = Object.assign({ name: opts.orgName.trim(), repoPatterns: patterns }, preserved);
  } else if (existingOrg && typeof existingOrg.name === 'string' && existingOrg.name.trim()) {
    cfg.org = existingOrg;
  }
  return cfg;
}

function writeConfigAtomic(file, cfg) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

function installPosixShellHelpers(installDir, home, log) {
  if (process.platform === 'win32') return; // hooks use absolute node paths; not needed
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const link = (target, name) => {
    const linkPath = path.join(binDir, name);
    try { fs.rmSync(linkPath, { force: true }); } catch { /* ignore */ }
    try { fs.symlinkSync(path.join(installDir, target), linkPath); } catch { /* best-effort */ }
  };
  link('exp-feedback', 'exp-feedback');
  link('exp-health-last', 'exp-health-last');

  const ensureLine = (rcFile, line) => {
    try {
      let content = '';
      try { content = fs.readFileSync(rcFile, 'utf8'); } catch { /* new file */ }
      const lines = content.split(/\r?\n/);
      if (!lines.includes(line)) {
        fs.appendFileSync(rcFile, `\n${line}\n`);
      }
    } catch (err) {
      log(`  ! could not update ${rcFile}: ${err.message}`);
    }
  };
  const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';
  const sourceLine = '[ -f "$HOME/.experience/exp-shell-init.sh" ] && . "$HOME/.experience/exp-shell-init.sh"';
  for (const rc of ['.bashrc', '.zshrc']) {
    const rcFile = path.join(home, rc);
    ensureLine(rcFile, pathLine);
    ensureLine(rcFile, sourceLine);
  }
}

function registerHooks(installDir, opts, mode, log) {
  const reg = path.join(installDir, 'register-hooks.js');
  if (!fs.existsSync(reg)) {
    log('  ! register-hooks.js not installed — skipping hook wiring');
    return;
  }
  const fwd = (p) => p.replace(/\\/g, '/');
  const env = Object.assign({}, process.env, {
    EXP_INTERCEPTOR: fwd(path.join(installDir, 'interceptor.js')),
    EXP_INTERCEPTOR_POST: fwd(path.join(installDir, 'interceptor-post.js')),
    EXP_INTERCEPTOR_PROMPT: fwd(path.join(installDir, 'interceptor-prompt.js')),
    EXP_INTERCEPTOR_SESSION: fwd(path.join(installDir, 'interceptor-session.js')),
    EXP_INTERCEPTOR_BATCH: fwd(path.join(installDir, 'posttool-batch-hook.js')),
    EXP_STOP: fwd(path.join(installDir, 'stop-extractor.js')),
    EXP_REGISTER_MODE: mode,
  });
  if (opts.agents) env.EXP_SELECTED_AGENTS = opts.agents;
  const r = spawnSync(process.execPath, [reg], { env, stdio: 'inherit' });
  if (r.status !== 0) log('  (non-fatal: register-hooks exited non-zero)');
}

async function run(argv, io) {
  const out = io.stdout;
  const log = (msg) => out.write(`${msg}\n`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err.message}\n\n${HELP}`);
    return 1;
  }
  if (opts.help) {
    out.write(HELP);
    return 0;
  }

  const home = os.homedir();
  const installDir = path.join(home, '.experience');
  const configPath = path.join(installDir, 'config.json');
  const existingConfig = safeReadJson(configPath);
  const freshInstall = !existingConfig;

  log('');
  log('Experience Engine — init');

  let resolved;
  try {
    resolved = await resolveMode(opts, { existingConfig, log, io });
  } catch (err) {
    io.stderr.write(`\n  [ERROR] ${err.message}\n`);
    return 1;
  }
  log(`  Mode: ${resolved.mode} → ${resolved.serverUrl}`);

  // Install runtime.
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(path.join(installDir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(installDir, 'offline-queue'), { recursive: true });
  try { fs.rmSync(path.join(installDir, 'tmp', 'bootstrap.lock'), { force: true }); } catch { /* ignore */ }

  if (opts.clean) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(installDir, 'backup-thin-client', stamp);
    for (const t of ['config.json', 'activity.jsonl', 'store', '.evolve-marker', '.stop-marker.json', path.join('tmp', 'last-suggestions.json')]) {
      const from = path.join(installDir, t);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(path.join(backup, t)), { recursive: true });
        fs.renameSync(from, path.join(backup, t));
      }
    }
    log(`  ✓ Backed up local state to ${backup}`);
  }

  const copied = copyRuntime(installDir, log);
  log(`  ✓ Installed ${copied} runtime file(s) to ${installDir}`);
  pruneLocalOnly(installDir, log);

  const cfg = buildConfig(opts, resolved.serverUrl, existingConfig);
  writeConfigAtomic(configPath, cfg);
  log('  ✓ Wrote config.json');

  installPosixShellHelpers(installDir, home, log);

  log('  Wiring agent hooks …');
  // Fresh install → 'full' so we wire detected agents; re-run → 'existing-only'
  // so we never auto-wire an agent the user removed.
  registerHooks(installDir, opts, freshInstall ? 'full' : 'existing-only', log);

  const inj = injectAgentInstructions({ home, log });
  if (inj.injected > 0) log(`  ✓ Refreshed agent instructions in ${inj.injected} file(s)`);

  // Final health summary.
  const healthy = await probeHealth(resolved.serverUrl, 3000);
  log('');
  log(`Done. Brain: ${resolved.serverUrl} (${healthy ? 'healthy' : 'unreachable — start it, then re-run init'})`);
  log('Try it: node ~/.experience/exp-recall.js "how do I set up X"');
  return 0;
}

async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, prompt }) {
  if (!io.prompt) io.prompt = prompt;
  return run(argv, io);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  main,
  run,
  parseArgs,
  resolveMode,
  buildConfig,
  probeHealth,
  THIN_CLIENT_FILES,
  THIN_SAFE_SRC,
  LOCAL_ONLY_FILES,
};
