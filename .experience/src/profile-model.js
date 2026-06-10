/**
 * profile-model.js — "Who Am I" v4.0, slice 1.
 *
 * Aggregates weighted signal votes (from signal-detector.js) into a small,
 * human-readable profile persisted at ~/.experience/profile.yaml.
 *
 * Poisoning defenses (WHO_AM_I_CONCEPT.md:278-286):
 *   - cumulative weighted counts: a 5-session burst is dwarfed by 50 sessions of history;
 *   - min N>=10 votes before a dimension emits a value (thin dimensions stay 'pending');
 *   - confidence decay when the winning value flips vs the stored value (instability penalty).
 *
 * aggregateProfile + (de)serialize are PURE (no Date.now, no I/O — caller pins opts.now).
 * Only loadProfile/saveProfile touch the filesystem and they log, never swallow, errors.
 */
'use strict';

const fs = require('node:fs');
const pathMod = require('node:path');

const DEFAULTS = { minSamples: 10, shiftDecay: 0.7, historyDecay: 1.0, version: 1 };

// dotted dimension → top-level YAML group, for the readable summary header.
function groupOf(dimension) {
  return String(dimension).split('.')[0] || 'other';
}

function emptyProfile() {
  return { version: DEFAULTS.version, updatedAt: null, dimensions: {} };
}

function argmax(distribution, prevValue) {
  let best = null;
  let bestN = -1;
  for (const [k, n] of Object.entries(distribution)) {
    if (n > bestN || (n === bestN && k === prevValue)) { best = k; bestN = n; }
  }
  return { value: best, count: bestN < 0 ? 0 : bestN };
}

/**
 * @param {object} existing  prior profile (or emptyProfile())
 * @param {Array}  newSignals  [{dimension, value, weight, evidence}]
 * @param {object} [opts]  { minSamples, shiftDecay, historyDecay, now (ms) }
 * @returns {object} a NEW profile (existing is not mutated)
 */
function aggregateProfile(existing, newSignals, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const base = existing && existing.dimensions ? existing : emptyProfile();
  // deep-ish clone of dimension state
  const dims = {};
  for (const [name, d] of Object.entries(base.dimensions)) {
    dims[name] = {
      value: d.value ?? null,
      confidence: Number(d.confidence) || 0,
      sampleCount: Number(d.sampleCount || d.samples) || 0,
      distribution: { ...(d.distribution || {}) },
      evidence: d.evidence || null,
    };
  }

  // optional recency decay of prior counts (default 1.0 = off, keeps tests deterministic)
  if (o.historyDecay !== 1.0) {
    for (const d of Object.values(dims)) {
      for (const k of Object.keys(d.distribution)) d.distribution[k] *= o.historyDecay;
      d.sampleCount *= o.historyDecay;
    }
  }

  for (const sig of newSignals || []) {
    if (!sig || !sig.dimension || sig.value == null) continue;
    const w = Number(sig.weight) || 1;
    const d = dims[sig.dimension] || (dims[sig.dimension] = { value: null, confidence: 0, sampleCount: 0, distribution: {}, evidence: null });
    d.distribution[sig.value] = (d.distribution[sig.value] || 0) + w;
    d.sampleCount += w;
    if (sig.evidence) d.evidence = sig.evidence;
  }

  // recompute winner + confidence per dimension
  for (const d of Object.values(dims)) {
    const prev = d.value;
    const { value: winner, count } = argmax(d.distribution, prev);
    const rawConf = d.sampleCount > 0 ? count / d.sampleCount : 0;
    if (d.sampleCount >= o.minSamples) {
      const shifted = prev != null && winner !== prev;
      d.value = winner;
      d.confidence = round2(shifted ? rawConf * o.shiftDecay : rawConf);
    } else {
      d.value = null; // pending — not enough evidence to commit
      d.confidence = round2(rawConf);
    }
  }

  return {
    version: o.version,
    updatedAt: o.now ? new Date(o.now).toISOString() : (base.updatedAt || null),
    dimensions: dims,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- YAML (de)serialization — targeted to the exact emit format ---------

function serializeProfile(profile) {
  const p = profile && profile.dimensions ? profile : emptyProfile();
  const out = [];
  out.push('# Who Am I — personality/work profile (Experience Engine v4.0)');
  out.push('# Auto-generated from local signals. Safe to read; edit `value:` to override.');
  // readable summary of committed dimensions, grouped
  const committed = Object.entries(p.dimensions).filter(([, d]) => d.value != null);
  if (committed.length) {
    out.push('# summary:');
    const byGroup = {};
    for (const [name, d] of committed) (byGroup[groupOf(name)] ||= []).push([name, d]);
    for (const g of Object.keys(byGroup).sort()) {
      out.push(`#   ${g}:`);
      for (const [name, d] of byGroup[g]) out.push(`#     ${name.split('.').slice(1).join('.') || name} = ${d.value} (${d.confidence})`);
    }
  }
  out.push(`version: ${p.version || 1}`);
  out.push(`updatedAt: ${p.updatedAt ? `"${p.updatedAt}"` : 'null'}`);
  out.push('dimensions:');
  for (const name of Object.keys(p.dimensions).sort()) {
    const d = p.dimensions[name];
    out.push(`  ${name}:`);
    out.push(`    value: ${d.value == null ? 'null' : yamlScalar(d.value)}`);
    out.push(`    confidence: ${round2(d.confidence)}`);
    out.push(`    samples: ${Math.round(d.sampleCount || 0)}`);
    out.push(`    distribution: ${flowMap(d.distribution)}`);
    if (d.evidence) out.push(`    evidence: ${yamlScalar(d.evidence)}`);
  }
  return out.join('\n') + '\n';
}

function yamlScalar(v) {
  const s = String(v);
  return /^[A-Za-z0-9_.\-]+$/.test(s) ? s : JSON.stringify(s);
}

function flowMap(dist) {
  const parts = Object.entries(dist || {}).map(([k, n]) => `${yamlScalar(k)}: ${round2(n)}`);
  return `{${parts.join(', ')}}`;
}

function parseFlowMap(s) {
  const out = {};
  const inner = String(s || '').trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return out;
  for (const pair of inner.split(',')) {
    const idx = pair.lastIndexOf(':');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim().replace(/^"(.*)"$/, '$1');
    const n = Number(pair.slice(idx + 1).trim());
    if (k) out[k] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function parseScalar(s) {
  const t = String(s || '').trim();
  if (t === 'null' || t === '') return null;
  if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  return t;
}

/** Parse profile.yaml back into the model (only the keys serializeProfile emits). */
function parseProfile(text) {
  const profile = emptyProfile();
  const lines = String(text || '').split('\n');
  let curName = null;
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    let m;
    if ((m = line.match(/^version:\s*(\d+)/))) { profile.version = Number(m[1]) || 1; continue; }
    if ((m = line.match(/^updatedAt:\s*(.+)$/))) { profile.updatedAt = parseScalar(m[1]); continue; }
    if (/^dimensions:\s*$/.test(line)) { curName = null; continue; }
    if ((m = line.match(/^ {2}([^\s:][^:]*):\s*$/))) { // "  <dimension>:"
      curName = m[1].trim();
      profile.dimensions[curName] = { value: null, confidence: 0, sampleCount: 0, distribution: {}, evidence: null };
      continue;
    }
    if (!curName) continue;
    const d = profile.dimensions[curName];
    if ((m = line.match(/^ {4}value:\s*(.+)$/))) d.value = parseScalar(m[1]);
    else if ((m = line.match(/^ {4}confidence:\s*(.+)$/))) d.confidence = Number(parseScalar(m[1])) || 0;
    else if ((m = line.match(/^ {4}samples:\s*(.+)$/))) d.sampleCount = Number(parseScalar(m[1])) || 0;
    else if ((m = line.match(/^ {4}distribution:\s*(\{.*\})\s*$/))) d.distribution = parseFlowMap(m[1]);
    else if ((m = line.match(/^ {4}evidence:\s*(.+)$/))) d.evidence = parseScalar(m[1]);
  }
  return profile;
}

// --- I/O boundary -------------------------------------------------------

function loadProfile(profilePath) {
  let raw;
  try {
    raw = fs.readFileSync(profilePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyProfile();
    console.error(`[profile-model] cannot read ${profilePath}: ${err?.message}`);
    return emptyProfile();
  }
  try {
    return parseProfile(raw);
  } catch (err) {
    console.error(`[profile-model] parse failed for ${profilePath}: ${err?.message}`);
    return emptyProfile();
  }
}

function saveProfile(profile, profilePath) {
  try {
    fs.mkdirSync(pathMod.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, serializeProfile(profile));
    return true;
  } catch (err) {
    console.error(`[profile-model] cannot write ${profilePath}: ${err?.message}`);
    return false;
  }
}

module.exports = {
  emptyProfile,
  aggregateProfile,
  serializeProfile,
  parseProfile,
  loadProfile,
  saveProfile,
  DEFAULTS,
};
