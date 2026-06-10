'use strict';

/**
 * memory-import.js — import already-curated agent memory markdown DIRECTLY into
 * the experience schema (NO LLM extraction). Agents write distilled, typed facts
 * to disk (e.g. ~/.claude/projects/<slug>/memory/*.md); re-mining them through the
 * extractQA LLM would re-noise + waste brain calls. Instead, map frontmatter →
 * experience and store seed-like (createdFrom 'seed-memory-import' → hit-discount
 * bypass), upsert-by-stable-id, mtime-incremental.
 *
 * EXTENSIBILITY IS THE POINT: every runtime is one self-contained MemoryAdapter.
 * Adding Codex/Gemini/Antigravity later = append one adapter object to ADAPTERS;
 * the core (scan/map/store/CLI) is runtime-agnostic. Only Claude has curated
 * memory on disk today (Codex format is untyped/semi-raw → deferred; Gemini &
 * Antigravity produce none) so they are registered as no-op stub adapters.
 *
 *   MemoryAdapter = {
 *     runtime: string,
 *     enumerate(homeDir) -> [{ file, mtimeMs }],
 *     parse(file) -> { runtime, name, type, description, body, projectSlug, file } | null
 *   }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractProjectSlug } = require('./utils');
const { log } = require('./logger');

const BEHAVIORAL_COLLECTION = 'experience-behavioral'; // T1
const SELFQA_COLLECTION = 'experience-selfqa';          // T2

// Cap the embedded/surfaced solution. Long bodies overflow the embedder input
// window (silent truncation) or muddy the vector across unrelated topics, and a
// multi-KB body can never render as a passive hint anyway.
const MAX_SOLUTION_CHARS = 1500;
// A `project` note bigger than this with NO distilled rationale (`**Why:**` /
// `**How to apply:**`) is a status/findings dump, not a reusable lesson — skip it
// by default (kept only with --include-reference).
const REFERENCE_DUMP_CHARS = 6000;

// Type → tier routing (per design). user = profile, not a surfacing experience;
// reference = URL/pointer, low surface value — both skipped by default.
const TYPE_ROUTING = {
  feedback: { collection: BEHAVIORAL_COLLECTION, tier: 1, confidence: 0.78, evidenceClass: 'user-correction' },
  project: { collection: SELFQA_COLLECTION, tier: 2, confidence: 0.70, evidenceClass: 'other' },
  user: null,
  reference: null,
};

// --- frontmatter ---

/**
 * Parse a leading `---\n ... \n---\n` YAML-ish frontmatter block. Tolerant of the
 * two observed shapes: full (`metadata:` nested block with `type`/`node_type`/
 * `originSessionId`) and older simplified (`type:` at top level). Returns
 * { frontmatter: {...flattened...}, body }. Never throws; logs malformed input.
 */
function parseFrontmatter(raw) {
  const text = String(raw || '');
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text.trim() };
  const fmBlock = m[1];
  const body = (m[2] || '').trim();
  const fm = {};
  let inMetadata = false;
  for (const line of fmBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'metadata' && val === '') { inMetadata = true; continue; }
    if (inMetadata && indented) {
      fm[key] = val; // flatten metadata.* to top level (type, node_type, originSessionId)
      continue;
    }
    inMetadata = false;
    fm[key] = val;
  }
  return { frontmatter: fm, body };
}

/** Extract the `**Why:**` rationale line(s) if present (curated feedback shape). */
function extractWhy(body) {
  const m = String(body || '').match(/\*\*Why:\*\*\s*([\s\S]*?)(?:\n\s*\n|\n\*\*How|\n##|$)/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// --- Claude dir-slug → project slug ---

/**
 * Claude encodes a project cwd as a dir name by replacing `:`/`\`/`/` (and `.`)
 * with `-`, which is LOSSY when the project name itself contains `-`
 * (`D:\sources\Core\muonroi-cli` → `D--sources-Core-muonroi-cli`, ambiguous vs
 * `.../muonroi/cli`). Disambiguate against the real filesystem (the importer runs
 * locally where these dirs exist): join tokens with `/`, and where that path does
 * not exist, greedily re-merge the rightmost split points with `-` until a real
 * directory is found. Then derive the canonical EE slug via extractProjectSlug
 * (which matches what session-extraction stored — verified: muonroi-cli entries
 * are scoped `muonroi-cli`). Falls back to the slug tail when no path resolves.
 */
function dirSlugToRealPath(dirSlug) {
  const drive = dirSlug.match(/^([A-Za-z])--(.*)$/);
  let base = '';
  let rest = dirSlug;
  if (drive) { base = `${drive[1]}:`; rest = drive[2]; }
  const tokens = rest.split('-').filter(Boolean);
  if (tokens.length === 0) return base || null;

  // Try the all-slash path, then progressively merge adjacent tokens with '-'
  // (right-to-left) testing existence. Covers the common single-hyphenated-name
  // case (e.g. muonroi-cli) without exploding combinatorially.
  const tryPath = (segs) => `${base}/${segs.join('/')}`;
  if (fileExists(tryPath(tokens))) return tryPath(tokens);
  for (let mergeAt = tokens.length - 2; mergeAt >= 0; mergeAt--) {
    const merged = [...tokens.slice(0, mergeAt), `${tokens[mergeAt]}-${tokens[mergeAt + 1]}`, ...tokens.slice(mergeAt + 2)];
    if (fileExists(tryPath(merged))) return tryPath(merged);
  }
  return tryPath(tokens); // best-effort; extractProjectSlug/basename still yields a slug
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/**
 * A real project slug is a single path segment (no `/`, `:`, `\`) and longer than
 * one char. extractProjectSlug returns a path-like value (e.g. `d:/sources`) when it
 * CANNOT resolve a real project root — that is the signal for "workspace root / home
 * dir", which should be GLOBAL scope (null), not pinned to a bogus slug that no
 * action's derived slug will ever match.
 */
function isCanonicalSlug(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length <= 1) return false;
  return s.indexOf('/') < 0 && s.indexOf(':') < 0 && s.indexOf('\\') < 0;
}

function dirSlugToProjectSlug(dirSlug) {
  const realPath = dirSlugToRealPath(dirSlug);
  const viaExtract = realPath ? extractProjectSlug(realPath) : null;
  if (isCanonicalSlug(viaExtract)) return viaExtract; // resolved to a real repo slug
  // A path-like result (e.g. `d:/sources`) means extractProjectSlug hit its
  // 2-segment fallback — the memory dir is a workspace root / home dir, not a
  // project → GLOBAL scope (null), never a bogus slug.
  if (viaExtract) return null;
  // Path didn't resolve at all → fall back to the dir-slug tail (covers a bare
  // single-name project dir), but only if it is itself a canonical slug.
  const tail = String(dirSlug || '').split('-').filter(Boolean).pop();
  const tailSlug = tail ? tail.toLowerCase() : null;
  return isCanonicalSlug(tailSlug) ? tailSlug : null;
}

// --- adapters ---

const claudeAdapter = {
  runtime: 'claude',
  enumerate(homeDir) {
    const projectsDir = path.join(homeDir, '.claude', 'projects');
    const out = [];
    let slugs;
    try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch (err) {
      log('debug', 'memory_import_enumerate_skip', { runtime: 'claude', dir: projectsDir, error: err?.message });
      return out;
    }
    for (const ent of slugs) {
      if (!ent.isDirectory()) continue;
      const memDir = path.join(projectsDir, ent.name, 'memory');
      let files;
      try { files = fs.readdirSync(memDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        const file = path.join(memDir, f);
        try { out.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); }
        catch (err) { log('debug', 'memory_import_stat_fail', { file, error: err?.message }); }
      }
    }
    return out;
  },
  parse(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { log('warn', 'memory_import_read_fail', { file, error: err?.message }); return null; }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = frontmatter.name || path.basename(file, '.md');
    const type = (frontmatter.type || '').toLowerCase() || null;
    const description = frontmatter.description || name;
    if (!body) { log('debug', 'memory_import_empty_body', { file }); return null; }
    // dirSlug = parent of the memory/ dir
    const dirSlug = path.basename(path.dirname(path.dirname(file)));
    const projectSlug = dirSlugToProjectSlug(dirSlug);
    return { runtime: 'claude', name, type, description, body, projectSlug, file };
  },
};

// Stub adapters — registered so the registry/CLI already cover these runtimes;
// they enumerate nothing until a real parser is added (Codex format is untyped/
// semi-raw → deferred; Gemini/Antigravity produce no curated memory today).
function stubAdapter(runtime) {
  return {
    runtime,
    enumerate() { return []; },
    parse() { return null; },
  };
}

const ADAPTERS = [
  claudeAdapter,
  stubAdapter('codex'),
  stubAdapter('gemini'),
  stubAdapter('antigravity'),
];

// --- core (runtime-agnostic) ---

/** Deterministic UUID-shaped id so re-import is an UPSERT, never a duplicate. */
function stableId(runtime, projectSlug, name) {
  const h = crypto.createHash('sha1').update(`memory:${runtime}:${projectSlug || ''}:${name}`).digest('hex');
  // Format 32 hex chars as 8-4-4-4-12 (UUID-shaped string; Qdrant accepts it).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Scan the selected runtime adapters and return normalized memory records.
 * @param {{ homeDir?: string, runtimes?: string[] }} opts
 */
function scanMemorySources(opts = {}) {
  const homeDir = opts.homeDir || require('os').homedir();
  const want = opts.runtimes && opts.runtimes.length ? new Set(opts.runtimes) : null;
  const records = [];
  for (const adapter of ADAPTERS) {
    if (want && !want.has(adapter.runtime)) continue;
    let files;
    try { files = adapter.enumerate(homeDir) || []; }
    catch (err) { log('warn', 'memory_import_enumerate_error', { runtime: adapter.runtime, error: err?.message }); continue; }
    for (const { file, mtimeMs } of files) {
      let rec;
      try { rec = adapter.parse(file); }
      catch (err) { log('warn', 'memory_import_parse_error', { runtime: adapter.runtime, file, error: err?.message }); continue; }
      if (rec) records.push({ ...rec, mtimeMs });
    }
  }
  return records;
}

/**
 * Map a normalized record → { id, collection, tier, confidence, qa } ready for
 * storeImportedExperience, or null if the type is skipped (user/reference/unknown).
 * @param {object} record
 * @param {{ includeReference?: boolean }} [opts]
 */
function mapMemoryToExperience(record, opts = {}) {
  const type = record.type || 'project'; // untyped curated note → treat as project-scoped lesson
  let route = TYPE_ROUTING[type];
  if (route === undefined) {
    log('debug', 'memory_import_unknown_type', { file: record.file, type });
    route = null;
  }
  if (route === null) {
    if (type === 'reference' && opts.includeReference) {
      route = { collection: SELFQA_COLLECTION, tier: 2, confidence: 0.55, evidenceClass: 'other' };
    } else {
      return null; // user / reference / unknown → skip
    }
  }
  const body = String(record.body || '');
  const why = extractWhy(body);
  const hasHowTo = /\*\*How to apply:\*\*/i.test(body);
  // Whole-status-dump guard: a big project note with no distilled rationale is
  // reference material, not a reusable experience — skip unless includeReference.
  const isStatusDump = type === 'project' && body.length > REFERENCE_DUMP_CHARS && !why && !hasHowTo;
  if (isStatusDump && !opts.includeReference) {
    log('debug', 'memory_import_skip_status_dump', { file: record.file, len: body.length });
    return null;
  }
  // Cap the embedded/surfaced solution to keep the vector focused and the hint usable.
  const solution = body.length > MAX_SOLUTION_CHARS
    ? `${body.slice(0, MAX_SOLUTION_CHARS)}\n\n[…truncated ${body.length - MAX_SOLUTION_CHARS} chars on import — full text in the source memory file]`
    : body;

  const id = stableId(record.runtime, record.projectSlug, record.name);
  const scope = record.projectSlug ? { project_slug: record.projectSlug } : undefined;
  const qa = {
    trigger: record.description,
    question: record.description,
    solution,
    why,
    scope,
    evidenceClass: route.evidenceClass,
    conditions: [],
    failureMode: null,
    judgment: null,
    sourceSession: null,
  };
  return { id, collection: route.collection, tier: route.tier, confidence: route.confidence, type, qa, record };
}

/** Shape a mapped experience for the /api/import-memory wire payload (thin client). */
function toWireExperience(mapped, record) {
  return {
    id: mapped.id,
    collection: mapped.collection,
    tier: mapped.tier,
    confidence: mapped.confidence,
    runtime: record.runtime,
    qa: mapped.qa,
  };
}

module.exports = {
  ADAPTERS,
  toWireExperience,
  claudeAdapter,
  stubAdapter,
  scanMemorySources,
  mapMemoryToExperience,
  parseFrontmatter,
  extractWhy,
  dirSlugToRealPath,
  dirSlugToProjectSlug,
  isCanonicalSlug,
  stableId,
  TYPE_ROUTING,
  BEHAVIORAL_COLLECTION,
  SELFQA_COLLECTION,
  MAX_SOLUTION_CHARS,
  REFERENCE_DUMP_CHARS,
};
