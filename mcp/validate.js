'use strict';

/**
 * mcp/validate.js — tiny JSON-Schema-subset validator.
 *
 * Stands in for zod. experience-engine is zero-runtime-dependency by policy
 * ("Zero npm dependencies. Node.js 20 native fetch only." — experience-core.js),
 * and MCP tool inputs are a handful of flat scalars, so a dependency that pulls
 * a whole schema engine to check `typeof x === 'string'` is not a trade worth
 * making.
 *
 * Supports exactly what the ee_* tools declare, and nothing more:
 *   type: string | number | integer | boolean
 *   string: minLength, maxLength, enum
 *   number/integer: minimum, maximum
 *   required (per-property flag), plus top-level `required: []`
 *
 * Deliberately STRICT about absent-vs-empty: an optional key that is absent is
 * fine; an optional key present as null/undefined is treated as absent, because
 * MCP clients serialise "no value" both ways.
 */

/**
 * @param {object} schema  { type:'object', properties:{...}, required:[...] }
 * @param {unknown} args
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
function validate(schema, args) {
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments must be an object' };
  }
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  const out = {};

  for (const [key, spec] of Object.entries(props)) {
    const raw = args[key];
    const absent = raw === undefined || raw === null;

    if (absent) {
      if (required.has(key)) return { ok: false, error: `${key} is required` };
      continue;
    }

    const checked = checkOne(key, spec, raw);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }

  return { ok: true, value: out };
}

function checkOne(key, spec, raw) {
  const type = spec.type;

  if (type === 'string') {
    if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
    if (Array.isArray(spec.enum) && !spec.enum.includes(raw)) {
      return { ok: false, error: `${key} must be one of: ${spec.enum.join(' | ')}` };
    }
    if (typeof spec.minLength === 'number' && raw.length < spec.minLength) {
      return { ok: false, error: `${key} must be at least ${spec.minLength} characters` };
    }
    if (typeof spec.maxLength === 'number' && raw.length > spec.maxLength) {
      return { ok: false, error: `${key} must be at most ${spec.maxLength} characters` };
    }
    return { ok: true, value: raw };
  }

  if (type === 'number' || type === 'integer') {
    // Clients occasionally send a numeric string for a number field; accept it
    // rather than failing a tool call over transport formatting.
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
    if (type === 'integer' && !Number.isInteger(n)) return { ok: false, error: `${key} must be an integer` };
    if (typeof spec.minimum === 'number' && n < spec.minimum) {
      return { ok: false, error: `${key} must be >= ${spec.minimum}` };
    }
    if (typeof spec.maximum === 'number' && n > spec.maximum) {
      return { ok: false, error: `${key} must be <= ${spec.maximum}` };
    }
    return { ok: true, value: n };
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
    return { ok: true, value: raw };
  }

  // Unknown type in a schema we wrote ourselves = a bug in the tool definition,
  // not in the caller's input. Pass it through rather than rejecting a valid call.
  return { ok: true, value: raw };
}

module.exports = { validate };
