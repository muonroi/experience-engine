#!/usr/bin/env node
'use strict';

/**
 * prompt-triviality.test.js — config-driven trivial-prompt gate.
 *
 * The UserPromptSubmit hook decides whether a prompt is worth retrieval +
 * nudge via src/config.js getMinPromptLength / getPromptSkipRegex. These were
 * hardcoded; here we cover the config/env overrides and the multilingual
 * default so the gate stays tunable without editing the hook.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG = require('../.experience/src/config.js');

// Keys this suite touches; restored after each case so order can't leak state.
const ENV_KEYS = [
  'EXPERIENCE_MIN_PROMPT_LENGTH',
  'EXPERIENCE_PROMPT_SKIP_WORDS',
  'EXPERIENCE_PROMPT_SKIP_PATTERN',
];
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('getMinPromptLength: default 10, env override, invalid → default', () => {
  withEnv({}, () => assert.equal(CONFIG.getMinPromptLength(), 10));
  withEnv({ EXPERIENCE_MIN_PROMPT_LENGTH: '3' }, () => assert.equal(CONFIG.getMinPromptLength(), 3));
  withEnv({ EXPERIENCE_MIN_PROMPT_LENGTH: 'abc' }, () => assert.equal(CONFIG.getMinPromptLength(), 10));
});

test('getPromptSkipRegex: default matches English + Vietnamese greetings + slash-commands', () => {
  withEnv({}, () => {
    const re = CONFIG.getPromptSkipRegex();
    for (const trivial of ['hi', 'OK', 'thanks', 'chào', 'cảm ơn', 'tiếp tục', '/clear']) {
      assert.ok(re.test(trivial.trim()), `expected "${trivial}" treated as trivial`);
    }
    for (const real of ['fix the auth bug', 'refactor deploy script', 'chào mừng tính năng mới rồi triển khai']) {
      assert.ok(!re.test(real.trim()), `expected "${real}" treated as non-trivial`);
    }
  });
});

test('getPromptSkipRegex: env word list overrides default', () => {
  withEnv({ EXPERIENCE_PROMPT_SKIP_WORDS: 'foo, bar baz' }, () => {
    const re = CONFIG.getPromptSkipRegex();
    assert.ok(re.test('foo'));
    assert.ok(re.test('bar baz'));
    assert.ok(!re.test('hi'), 'default words no longer apply when overridden');
  });
});

test('getPromptSkipRegex: full pattern override, and bad pattern fails open', () => {
  withEnv({ EXPERIENCE_PROMPT_SKIP_PATTERN: '^ping$' }, () => {
    const re = CONFIG.getPromptSkipRegex();
    assert.ok(re.test('ping'));
    assert.ok(!re.test('hi'));
  });
  // Invalid regex source must not throw — falls back to the word-list default.
  withEnv({ EXPERIENCE_PROMPT_SKIP_PATTERN: '([unterminated' }, () => {
    const re = CONFIG.getPromptSkipRegex();
    assert.ok(re.test('hi'), 'bad pattern should fail open to default words');
  });
});
