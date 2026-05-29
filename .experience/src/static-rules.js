/**
 * Deterministic static rules — fire BEFORE embedding-matched hints.
 *
 * Use when a rule is precise enough to be a code check, not a vibe match.
 * Static rules bypass ignoreCount auto-throttling and have no Qdrant footprint.
 *
 * Each rule returns either null (skip) or { id, line, meta } where:
 *   id   — stable string identifier (used for surfacedIds + feedback tracking)
 *   line — the hint text the agent sees (must include id at the end:
 *          "...[id:<slug> col:static-rules]" for the feedback helper)
 *   meta — { confidence: 0..1, ruleKind: string, advisory: boolean }
 */
"use strict";

const path = require("path");

// --- file-size-cap-1000 ----------------------------------------------------

const SIZE_CAP_LINES_WRITE = 1000;   // post-write line count
const SIZE_CAP_LINES_EDIT = 1500;    // existing-file line count when an Edit lands

// Files exempt from the size cap. Most are data/snapshot/generated.
function isSizeCapExempt(filePath) {
  if (!filePath || typeof filePath !== "string") return true;
  const p = filePath.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(p);
  if (base === "catalog.json") return true;
  if (base === "package-lock.json" || base === "bun.lockb" || base === "yarn.lock" || base === "pnpm-lock.yaml") return true;
  if (base.endsWith(".lock") || base.endsWith(".snap") || base.endsWith(".lockfile")) return true;
  if (p.includes("/__snapshots__/")) return true;
  if (p.includes("/tests/") && p.includes("/fixtures/")) return true;
  if (p.includes("/test/") && p.includes("/fixtures/")) return true;
  if (p.includes("/node_modules/")) return true;
  if (p.includes(".fixture.")) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  // Generated/data JSONs are unsplittable; user can override per-file later.
  if (base.endsWith(".json") && !base.endsWith("package.json")) {
    return true;
  }
  return false;
}

function countLines(text) {
  if (!text || typeof text !== "string") return 0;
  // Count line breaks + 1 for the final line (matches wc -l semantics within +-1).
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.length > 0 ? n + 1 : 0;
}

function evaluateFileSizeCap(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
  if (!filePath || isSizeCapExempt(filePath)) return null;

  if (toolName === "Write") {
    const lines = countLines(toolInput.content);
    if (lines > SIZE_CAP_LINES_WRITE) {
      return {
        id: "file-size-cap-1000-write",
        line:
          "⚠️ [Experience - Static Rule]: About to Write " + lines + " lines to " + path.basename(filePath) + ". " +
          "Files past " + SIZE_CAP_LINES_WRITE + " lines make diffs hard to review and tax every future read+edit. " +
          "Consider splitting along clear seams (types, helpers, io, ui) before continuing. " +
          "Why: bloat compounds across every downstream agent cycle. " +
          "[id:file-size-cap-1000-write col:static-rules]",
        meta: { confidence: 1.0, ruleKind: "file-size-cap", advisory: true },
      };
    }
    return null;
  }

  // For Edit: we do not have post-edit line count without reading the file.
  // The hint should fire only if the input file is itself already very large,
  // and only when the edit is a wholesale replacement (large new_string).
  if (toolName === "Edit" || toolName === "MultiEdit") {
    const newLines = countLines(toolInput.new_string || toolInput.content);
    const oldLines = countLines(toolInput.old_string);
    if (newLines > SIZE_CAP_LINES_EDIT && newLines > oldLines * 3) {
      return {
        id: "file-size-cap-1500-edit",
        line:
          "⚠️ [Experience - Static Rule]: Edit pasting " + newLines + " lines into " + path.basename(filePath) + ". " +
          "This looks like a whole-file rewrite. If the resulting file > " + SIZE_CAP_LINES_EDIT + " lines, " +
          "split into smaller modules before applying. " +
          "Why: large-file Edits compound diff cost. " +
          "[id:file-size-cap-1500-edit col:static-rules]",
        meta: { confidence: 1.0, ruleKind: "file-size-cap", advisory: true },
      };
    }
    return null;
  }
  return null;
}

// --- Rule registry --------------------------------------------------------

const RULES = [evaluateFileSizeCap];

function evaluateStaticRules(toolName, toolInput, _meta) {
  const out = [];
  for (const rule of RULES) {
    try {
      const r = rule(toolName, toolInput);
      if (r) out.push(r);
    } catch (err) {
      console.error("[static-rules] rule failed:", err && err.message ? err.message : err);
    }
  }
  return out;
}

module.exports = {
  evaluateStaticRules,
  // exported for unit tests:
  _internal: { evaluateFileSizeCap, isSizeCapExempt, countLines, SIZE_CAP_LINES_WRITE, SIZE_CAP_LINES_EDIT },
};
