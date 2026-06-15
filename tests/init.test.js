#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const init = require('../bin/init');
const agentMd = require('../.experience/src/agent-md');

const silentIo = {
  prompt: async () => '',
};
const ctxBase = (existingConfig = null) => ({
  existingConfig,
  log: () => {},
  io: { prompt: async () => '' },
  probeHealth: async () => false, // deterministic: assume no local brain
});

test('parseArgs reads flags and aliases', () => {
  const o = init.parseArgs(['--server', 'https://x', '--token', 't', '-y', '--agents', 'claude,codex']);
  assert.equal(o.server, 'https://x');
  assert.equal(o.token, 't');
  assert.equal(o.yes, true);
  assert.equal(o.agents, 'claude,codex');
});

test('parseArgs rejects unknown options', () => {
  assert.throws(() => init.parseArgs(['--nope']), /Unknown option/);
});

test('resolveMode: --server flag → remote', async () => {
  const r = await init.resolveMode(
    init.parseArgs(['--server', 'https://brain.example.com']),
    ctxBase()
  );
  assert.equal(r.mode, 'remote');
  assert.equal(r.serverUrl, 'https://brain.example.com');
});

test('resolveMode: existing config serverBaseUrl → remote (no flags)', async () => {
  const r = await init.resolveMode(
    init.parseArgs([]),
    ctxBase({ serverBaseUrl: 'https://saved.example.com' })
  );
  assert.equal(r.mode, 'remote');
  assert.equal(r.serverUrl, 'https://saved.example.com');
});

test('resolveMode: --local forces localhost', async () => {
  const r = await init.resolveMode(init.parseArgs(['--local']), ctxBase());
  assert.equal(r.mode, 'local');
  assert.match(r.serverUrl, /localhost:8082/);
});

test('resolveMode: --remote without server URL errors', async () => {
  await assert.rejects(
    () => init.resolveMode(init.parseArgs(['--remote']), ctxBase()),
    /requires --server/
  );
});

test('resolveMode: --yes with no brain and no server fails clearly', async () => {
  // probeHealth will fail against localhost in CI (no brain), then --yes blocks prompts.
  await assert.rejects(
    () => init.resolveMode(init.parseArgs(['--yes']), ctxBase()),
    /No local brain found/
  );
});

test('buildConfig writes thin-client shape with trimmed URL', () => {
  const cfg = init.buildConfig(init.parseArgs(['--token', 'abc']), 'https://b.example.com/', null);
  assert.equal(cfg.serverBaseUrl, 'https://b.example.com');
  assert.equal(cfg.serverAuthToken, 'abc');
  assert.equal(cfg.version, 'thin-client');
  assert.equal(typeof cfg.installedAt, 'string');
});

test('buildConfig preserves prior org block + extra keys', () => {
  const existing = { org: { name: 'acme', repoPatterns: ['acme-*'], frameworkPackages: ['x'] } };
  const cfg = init.buildConfig(init.parseArgs([]), 'http://localhost:8082', existing);
  assert.deepEqual(cfg.org, existing.org);
});

test('buildConfig applies --org-name while preserving unknown org keys', () => {
  const existing = { org: { name: 'old', repoPatterns: [], globalScope: true } };
  const cfg = init.buildConfig(
    init.parseArgs(['--org-name', 'new', '--org-patterns', 'new-*, lib']),
    'http://localhost:8082',
    existing
  );
  assert.equal(cfg.org.name, 'new');
  assert.deepEqual(cfg.org.repoPatterns, ['new-*', 'lib']);
  assert.equal(cfg.org.globalScope, true);
});

test('agent-md applyBlock replaces an existing managed block', () => {
  const before = `# My config\n\nKeep this.\n\n${agentMd.START_MARKER}\nOLD STUFF\n${agentMd.END_MARKER}\n\nTrailing user notes.\n`;
  const after = agentMd.applyBlock(before);
  assert.ok(!after.includes('OLD STUFF'));
  assert.ok(after.includes('Keep this.'));
  // Exactly one managed block remains.
  assert.equal(after.split(agentMd.START_MARKER).length - 1, 1);
  assert.ok(after.includes('## Experience Engine'));
});

test('agent-md applyBlock appends when no block present', () => {
  const after = agentMd.applyBlock('# Existing\n');
  assert.ok(after.includes('# Existing'));
  assert.ok(after.includes(agentMd.START_MARKER));
});

void silentIo;
