'use strict';

const PROMPT_INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b.*\binstructions\b/i,
  /\b(ignore|disregard|forget)\b.*\b(rules|guidelines)\b/i,
  /system\s+prompt/i,
  /instead,\s*output/i,
  /\byou\s+(are\s+now|will\s+act|must\s+play\s+the\s+role\s+of)\s+a(n)?\b/i,
  /\b(assistant|user|system):/i
];

function isSafeText(text) {
  if (typeof text !== 'string') return true;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) return false;
  }
  return true;
}

function isSafePayload(payload) {
  if (!payload || typeof payload !== 'object') return true;
  const fields = ['solution', 'trigger', 'why', 'judgment', 'principle'];
  for (const f of fields) {
    if (payload[f] && !isSafeText(payload[f])) return false;
  }
  return true;
}

module.exports = {
  isSafeText,
  isSafePayload,
  PROMPT_INJECTION_PATTERNS
};
