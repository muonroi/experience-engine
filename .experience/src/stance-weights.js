/**
 * Per-stance recall weighting (Sprint-2 deferred item 3).
 *
 * The council debate opens by recalling prior experience once per stance. Each
 * stance cares about a different slice of the brain, so this module maps a
 * stance/role to a per-collection weight vector aligned to the recall
 * COLLECTIONS order [experience-principles, experience-behavioral,
 * experience-selfqa]. The recall hot path scales each collection's output budget
 * by its weight, so a stance sees MORE of the collection it values and less (or,
 * at weight 0, none) of the rest — without changing which experiences exist.
 *
 * Design rules:
 *   - Default (unknown/absent stance) = [1,1,1] — behavior is unchanged, so this
 *     is a strict, opt-in enhancement.
 *   - Built-in stances never zero a collection (min 0.5) so no stance goes blind;
 *     weight 0 is supported by the mechanism for explicit deselection only.
 *   - Pure + synchronous — trivially unit-testable, zero I/O.
 *
 * COLLECTIONS order is fixed by intercept.js; the weight vectors below MUST stay
 * aligned to [principles, behavioral, selfqa].
 */

"use strict";

// Canonical stance keys → weight vector [principles, behavioral, selfqa].
const STANCE_WEIGHTS = {
  // Broad prior-art / first-principles framing → lean on principles.
  researcher: [1.4, 1.0, 0.6],
  planner: [1.3, 1.1, 0.8],
  architect: [1.3, 1.0, 0.8],
  // "How did we actually do this" → lean on behavioral how-to + gotchas.
  implementer: [0.8, 1.4, 1.0],
  executor: [0.8, 1.4, 1.0],
  coder: [0.8, 1.4, 1.0],
  // "What bit us last time" → lean on self-QA / past-mistake memory.
  verifier: [0.8, 0.9, 1.5],
  critic: [0.8, 0.9, 1.5],
  reviewer: [0.8, 0.9, 1.5],
  // Synthesis stays balanced.
  leader: [1.0, 1.0, 1.0],
  synthesizer: [1.0, 1.0, 1.0],
};

// Synonyms that normalize onto a canonical key above.
const STANCE_ALIASES = {
  research: "researcher",
  implement: "implementer",
  execution: "executor",
  execute: "executor",
  build: "implementer",
  builder: "implementer",
  verify: "verifier",
  verification: "verifier",
  review: "reviewer",
  qa: "verifier",
  plan: "planner",
  design: "architect",
  designer: "architect",
  lead: "leader",
  synthesis: "synthesizer",
};

const DEFAULT_WEIGHTS = [1.0, 1.0, 1.0];

/** Normalize a raw stance/role string to a canonical stance key, or null. */
function normalizeStance(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (STANCE_WEIGHTS[s]) return s;
  if (STANCE_ALIASES[s]) return STANCE_ALIASES[s];
  return null;
}

/**
 * Weight vector [w0, w1, w2] for a stance, aligned to COLLECTIONS order. Unknown
 * or absent stance → [1,1,1] (unchanged behavior). Returns a fresh array.
 */
function weightsForStance(stance) {
  const key = normalizeStance(stance);
  const v = key ? STANCE_WEIGHTS[key] : DEFAULT_WEIGHTS;
  return [v[0], v[1], v[2]];
}

/**
 * Scale a base per-collection budget by a stance weight. Weight 0 → 0 (the
 * collection is deselected from the fused output). Never negative.
 */
function scaleBudget(baseBudgetChars, weight) {
  const b = Number(baseBudgetChars) || 0;
  const w = Number.isFinite(weight) ? weight : 1;
  return Math.max(0, Math.round(b * w));
}

module.exports = {
  STANCE_WEIGHTS,
  STANCE_ALIASES,
  DEFAULT_WEIGHTS,
  normalizeStance,
  weightsForStance,
  scaleBudget,
};
