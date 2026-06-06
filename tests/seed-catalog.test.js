#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RUNTIME_PROVIDER_MAP,
  pickModel,
  buildModelTiersFromCatalog,
  seedCatalog,
} = require('../scripts/seed-catalog.js');

// A catalog shaped like the real one: openai + google + an unrelated provider.
const CATALOG = [
  { id: 'gpt-5.4-mini', provider: 'openai', tier: 'fast' },
  { id: 'gpt-5.3-codex', provider: 'openai', tier: 'balanced' },
  { id: 'gpt-5.4', provider: 'openai', tier: 'premium' },
  { id: 'gemini-3.5-flash', provider: 'google', tier: 'fast' },
  { id: 'gemini-2.5-flash', provider: 'google', tier: 'balanced' },
  { id: 'gemini-2.5-pro', provider: 'google', tier: 'premium' },
  { id: 'deepseek-v4-flash', provider: 'deepseek', tier: 'fast' },
];

// Mirrors router.js hardcoded default (anthropic-backed claude/opencode + stale gemini).
const BASE = {
  claude: { fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' },
  gemini: { fast: 'gemini-3-flash', balanced: 'gemini-3-pro', premium: 'gemini-3.1-pro' },
  codex: { fast: 'gpt-5.4-mini', balanced: 'gpt-5.3-codex', premium: 'gpt-5.4' },
  opencode: { fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' },
  antigravity: { fast: 'gemini-3-flash', balanced: 'gemini-3-pro', premium: 'gemini-3.1-pro' },
};

test('pickModel returns first provider+tier match, else null', () => {
  assert.equal(pickModel(CATALOG, 'openai', 'fast'), 'gpt-5.4-mini');
  assert.equal(pickModel(CATALOG, 'google', 'premium'), 'gemini-2.5-pro');
  assert.equal(pickModel(CATALOG, 'anthropic', 'fast'), null);
});

test('build overlays gemini from catalog (fixes drift) and preserves anthropic runtimes', () => {
  const { tiers } = buildModelTiersFromCatalog(CATALOG, BASE);
  // gemini sourced from catalog (was stale gemini-3-*).
  assert.deepEqual(tiers.gemini, {
    fast: 'gemini-3.5-flash',
    balanced: 'gemini-2.5-flash',
    premium: 'gemini-2.5-pro',
  });
  // antigravity also google-backed.
  assert.equal(tiers.antigravity.premium, 'gemini-2.5-pro');
  // claude/opencode (anthropic, NOT in catalog) preserved verbatim — never invented.
  assert.deepEqual(tiers.claude, BASE.claude);
  assert.deepEqual(tiers.opencode, BASE.opencode);
});

test('codex already matches catalog → no spurious change for it', () => {
  const { changes } = buildModelTiersFromCatalog(CATALOG, BASE);
  const codexChanges = changes.filter((c) => c.runtime === 'codex');
  assert.equal(codexChanges.length, 0);
  const geminiChanges = changes.filter((c) => c.runtime === 'gemini');
  assert.equal(geminiChanges.length, 3); // all three tiers drifted
});

test('does not mutate the caller base object', () => {
  const base = JSON.parse(JSON.stringify(BASE));
  buildModelTiersFromCatalog(CATALOG, base);
  assert.deepEqual(base, BASE);
});

test('missing catalog tier keeps the base value (never blanked)', () => {
  const partial = [{ id: 'gpt-5.4-mini', provider: 'openai', tier: 'fast' }];
  const { tiers } = buildModelTiersFromCatalog(partial, BASE);
  assert.equal(tiers.codex.fast, 'gpt-5.4-mini');
  assert.equal(tiers.codex.premium, 'gpt-5.4'); // preserved from base
});

test('RUNTIME_PROVIDER_MAP excludes anthropic-backed runtimes', () => {
  assert.equal(RUNTIME_PROVIDER_MAP.claude, undefined);
  assert.equal(RUNTIME_PROVIDER_MAP.opencode, undefined);
  assert.equal(RUNTIME_PROVIDER_MAP.codex, 'openai');
  assert.equal(RUNTIME_PROVIDER_MAP.gemini, 'google');
});

// ── seedCatalog integration (injected fetch + temp config, no network) ──
function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-seed-'));
  return path.join(dir, 'config.json');
}

function fakeFetch(models) {
  return async () => ({ ok: true, json: async () => ({ version: '9', updated_at: 'x', models }) });
}

test('seedCatalog writes merged modelTiers, preserving other config keys', async () => {
  const p = tmpConfig();
  fs.writeFileSync(p, JSON.stringify({ user: 'alice', routing: true, modelTiers: BASE }, null, 2));
  const r = await seedCatalog({ url: 'x', fetchImpl: fakeFetch(CATALOG), path: p, baseTiers: BASE });
  assert.equal(r.seeded, true);
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(written.user, 'alice'); // untouched
  assert.equal(written.routing, true);
  assert.equal(written.modelTiers.gemini.premium, 'gemini-2.5-pro');
  assert.deepEqual(written.modelTiers.claude, BASE.claude);
});

test('seedCatalog is idempotent (no rewrite when unchanged)', async () => {
  const p = tmpConfig();
  // First seed.
  await seedCatalog({ url: 'x', fetchImpl: fakeFetch(CATALOG), path: p, baseTiers: BASE });
  const firstMtime = fs.statSync(p).mtimeMs;
  // Second seed with same catalog + the now-seeded tiers as base → unchanged.
  const seeded = JSON.parse(fs.readFileSync(p, 'utf8')).modelTiers;
  const r2 = await seedCatalog({ url: 'x', fetchImpl: fakeFetch(CATALOG), path: p, baseTiers: seeded });
  assert.equal(r2.seeded, false);
  assert.equal(r2.reason, 'unchanged');
  assert.equal(fs.statSync(p).mtimeMs, firstMtime); // file not rewritten
});

test('seedCatalog is offline-safe: fetch failure leaves config untouched', async () => {
  const p = tmpConfig();
  fs.writeFileSync(p, JSON.stringify({ user: 'bob' }, null, 2));
  const failing = async () => { throw new Error('ENET'); };
  const r = await seedCatalog({ url: 'x', fetchImpl: failing, path: p, baseTiers: BASE });
  assert.equal(r.seeded, false);
  assert.equal(r.reason, 'catalog-unavailable');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { user: 'bob' }); // untouched
});

test('seedCatalog no-ops on empty catalog (no models)', async () => {
  const p = tmpConfig();
  const r = await seedCatalog({ url: 'x', fetchImpl: fakeFetch([]), path: p, baseTiers: BASE });
  assert.equal(r.seeded, false);
  assert.equal(r.reason, 'catalog-unavailable');
  assert.equal(fs.existsSync(p), false); // nothing written
});
