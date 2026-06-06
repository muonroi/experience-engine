#!/usr/bin/env node
'use strict';

/**
 * seed-catalog.js — offline-safe seeding of model tiers from the shared catalog.
 *
 * The Experience Engine historically HARDCODED its model ladders in
 * .experience/src/router.js (getModelTiers). Those drift from the real catalog
 * (e.g. gemini-3-pro vs the catalog's gemini-2.5-pro). This script fetches the
 * shared catalog (services/catalog-api, default https://catalog.muonroi.com)
 * ONCE at install/update time and writes a resolved `modelTiers` into
 * ~/.experience/config.json. At runtime EE keeps reading config (no network),
 * so the zero-dependency / offline-with-Ollama property is preserved — the
 * hardcoded ladder in router.js stays only as a last-resort fallback when no
 * config and no catalog are available.
 *
 * Design contract:
 *  - OFFLINE-SAFE: any fetch/parse failure is a no-op (config untouched).
 *  - IDEMPOTENT: re-running with the same catalog does not rewrite the file.
 *  - HONEST about coverage: only runtimes whose provider exists in the catalog
 *    are sourced from it (see RUNTIME_PROVIDER_MAP). Anthropic-backed runtimes
 *    (claude, opencode) are NOT in the catalog, so their base tiers are
 *    preserved verbatim — we never invent a model id.
 *
 * Usage:
 *   node scripts/seed-catalog.js            # seed from default/env catalog URL
 *   MUONROI_CATALOG_URL=http://localhost:8083/api/v1/models node scripts/seed-catalog.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CATALOG_URL = 'https://catalog.muonroi.com/api/v1/models';
const FETCH_TIMEOUT_MS = 5000;

// EE runtimes are keyed by agent runtime, the catalog is keyed by provider.
// Only runtimes whose provider is present in the catalog get sourced from it.
// claude/opencode map to "anthropic" which the catalog does NOT carry, so they
// are intentionally omitted here and preserved from the base tiers.
const RUNTIME_PROVIDER_MAP = Object.freeze({
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
});

const TIERS = ['fast', 'balanced', 'premium'];

/**
 * Pick the first catalog model id matching a provider + tier (mirrors the
 * CLI's getModelByTier "first match wins" behavior).
 * @returns {string|null}
 */
function pickModel(catalogModels, provider, tier) {
  for (const m of catalogModels) {
    if (m && m.provider === provider && m.tier === tier && typeof m.id === 'string') {
      return m.id;
    }
  }
  return null;
}

/**
 * Build a full modelTiers map: start from baseTiers (preserving every runtime,
 * notably anthropic-backed claude/opencode) and overlay catalog-derived ids for
 * the runtimes in RUNTIME_PROVIDER_MAP. A tier is only overwritten when the
 * catalog actually has a model for that provider+tier — otherwise the base
 * value is kept (never blanked, never invented).
 *
 * Pure function — no I/O, no network. This is the unit-tested core.
 *
 * @param {Array<{id:string,provider:string,tier:string}>} catalogModels
 * @param {Record<string, Record<string,string>>} baseTiers
 * @returns {{ tiers: Record<string, Record<string,string>>, changes: Array<{runtime:string,tier:string,from:string|null,to:string}> }}
 */
function buildModelTiersFromCatalog(catalogModels, baseTiers) {
  const models = Array.isArray(catalogModels) ? catalogModels : [];
  // Deep clone base so callers' objects are not mutated.
  const tiers = {};
  for (const [runtime, ladder] of Object.entries(baseTiers || {})) {
    tiers[runtime] = { ...(ladder || {}) };
  }

  const changes = [];
  for (const [runtime, provider] of Object.entries(RUNTIME_PROVIDER_MAP)) {
    const ladder = tiers[runtime] ? { ...tiers[runtime] } : {};
    for (const tier of TIERS) {
      const picked = pickModel(models, provider, tier);
      if (picked && ladder[tier] !== picked) {
        changes.push({ runtime, tier, from: ladder[tier] ?? null, to: picked });
        ladder[tier] = picked;
      }
    }
    tiers[runtime] = ladder;
  }

  return { tiers, changes };
}

function configPath() {
  return path.join(os.homedir(), '.experience', 'config.json');
}

function readConfig(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function resolveBaseTiers(existingConfig) {
  // Prefer tiers already in config; else the hardcoded router default.
  if (existingConfig && existingConfig.modelTiers && typeof existingConfig.modelTiers === 'object') {
    return existingConfig.modelTiers;
  }
  try {
    // Light require — router.js only defines functions at load time.
    return require('../.experience/src/router.js').getModelTiers();
  } catch {
    return {};
  }
}

async function fetchCatalog(url, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return Array.isArray(data && data.models) ? data.models : null;
  } catch {
    return null; // offline-safe
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seed modelTiers into the EE config from the shared catalog.
 * All side effects are injectable for testing.
 *
 * @param {object} [opts]
 * @param {string} [opts.url] catalog URL (default env MUONROI_CATALOG_URL or DEFAULT_CATALOG_URL)
 * @param {Function} [opts.fetchImpl] fetch implementation (default global fetch)
 * @param {string} [opts.path] config.json path (default ~/.experience/config.json)
 * @param {Record<string,Record<string,string>>} [opts.baseTiers] override base (default config or router default)
 * @returns {Promise<{seeded:boolean, reason?:string, changes?:Array, path?:string}>}
 */
async function seedCatalog(opts = {}) {
  const url = opts.url || process.env.MUONROI_CATALOG_URL || DEFAULT_CATALOG_URL;
  const p = opts.path || configPath();

  const models = await fetchCatalog(url, opts.fetchImpl);
  if (!models || models.length === 0) {
    return { seeded: false, reason: 'catalog-unavailable' };
  }

  const existing = readConfig(p);
  const baseTiers = opts.baseTiers || resolveBaseTiers(existing);
  const { tiers, changes } = buildModelTiersFromCatalog(models, baseTiers);

  // Idempotent: skip write when nothing changed.
  const before = JSON.stringify(existing.modelTiers || null);
  const after = JSON.stringify(tiers);
  if (before === after) {
    return { seeded: false, reason: 'unchanged', changes: [] };
  }

  const next = { ...existing, modelTiers: tiers };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { seeded: true, changes, path: p };
}

module.exports = {
  RUNTIME_PROVIDER_MAP,
  pickModel,
  buildModelTiersFromCatalog,
  seedCatalog,
  DEFAULT_CATALOG_URL,
};

// CLI entrypoint.
if (require.main === module) {
  seedCatalog()
    .then((r) => {
      if (r.seeded) {
        console.log(`[seed-catalog] updated ${r.path} (${r.changes.length} tier change(s))`);
        for (const c of r.changes) {
          console.log(`  ${c.runtime}.${c.tier}: ${c.from ?? '(none)'} -> ${c.to}`);
        }
      } else {
        console.log(`[seed-catalog] no change (${r.reason}) — config left intact`);
      }
    })
    .catch((err) => {
      // Never fail the installer over an optional seed.
      console.error('[seed-catalog] skipped:', err && err.message ? err.message : err);
    });
}
