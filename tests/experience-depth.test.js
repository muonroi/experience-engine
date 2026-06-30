#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INTERCEPTOR_PATH = path.join(__dirname, '..', '.experience', 'interceptor.js');
const INTERCEPTOR_PROMPT_PATH = path.join(__dirname, '..', '.experience', 'interceptor-prompt.js');

test('experience-depth: interceptor.js exits immediately with 0 if depth >= maxDepth', () => {
  // Spawn the child process with depth >= maxDepth. It should exit immediately
  // and NOT block waiting for stdin data (since stdin is empty, normally it would hang or wait for end)
  const child = spawnSync(process.execPath, [INTERCEPTOR_PATH], {
    env: {
      ...process.env,
      EXPERIENCE_DEPTH: '2',
      EXPERIENCE_MAX_DEPTH: '2'
    },
    timeout: 1000 // if it hangs/waits for stdin, it will timeout. But it should exit immediately!
  });

  assert.equal(child.status, 0);
  assert.equal(child.error, undefined, 'Should not timeout or fail');
});

test('experience-depth: interceptor.js proceeds if depth < maxDepth', () => {
  // If depth < maxDepth, it should wait for stdin or process it.
  // Since we provide empty stdin and immediately close it, it should parse empty json and exit.
  const child = spawnSync(process.execPath, [INTERCEPTOR_PATH], {
    env: {
      ...process.env,
      EXPERIENCE_DEPTH: '0',
      EXPERIENCE_MAX_DEPTH: '2'
    },
    input: '{}', // valid empty JSON input so it parses and exits
    timeout: 2000
  });

  assert.equal(child.status, 0);
});

test('experience-depth: interceptor-prompt.js exits immediately with 0 if depth >= maxDepth', () => {
  const child = spawnSync(process.execPath, [INTERCEPTOR_PROMPT_PATH], {
    env: {
      ...process.env,
      EXPERIENCE_DEPTH: '3',
      EXPERIENCE_MAX_DEPTH: '2'
    },
    timeout: 1000
  });

  assert.equal(child.status, 0);
  assert.equal(child.error, undefined);
});
