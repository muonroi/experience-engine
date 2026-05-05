/**
 * validate.js — Zero-dep request body validation for Experience Engine API.
 */
'use strict';

function validateBody(body, schema) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'request body must be a JSON object' };
  for (const [field, rules] of Object.entries(schema)) {
    const val = body[field];
    if (rules.required && (val === undefined || val === null)) {
      return { ok: false, error: `${field} is required` };
    }
    if (val === undefined || val === null) continue;
    if (rules.type && typeof val !== rules.type) {
      return { ok: false, error: `${field} must be a ${rules.type}` };
    }
    if (rules.maxLength && typeof val === 'string' && val.length > rules.maxLength) {
      return { ok: false, error: `${field} must be at most ${rules.maxLength} characters` };
    }
    if (rules.oneOf && !rules.oneOf.has(val) && !rules.oneOf.includes?.(val)) {
      return { ok: false, error: `${field} must be one of: ${[...rules.oneOf].join(', ')}` };
    }
  }
  return { ok: true };
}

module.exports = { validateBody };
