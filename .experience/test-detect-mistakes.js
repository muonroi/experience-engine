#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _detectMistakes } = require('./experience-core.js');

test('ignores read-only ssh and sed inspection loops in transcript retry detection', () => {
  const transcript = [
    'ToolCall Bash: ssh -i /tmp/key phila@72.61.127.154 \'tail -n 20 ~/.experience/activity.jsonl\'',
    'ToolCall Bash: ssh -i /tmp/key phila@72.61.127.154 \'tail -n 20 ~/.experience/activity.jsonl\'',
    'ToolCall Bash: ssh -i /tmp/key phila@72.61.127.154 \'tail -n 20 ~/.experience/activity.jsonl\'',
    'ToolCall Bash: sed -n \'1,40p\' .experience/stop-extractor.js',
    'ToolCall Bash: sed -n \'1,40p\' .experience/stop-extractor.js',
    'ToolCall Bash: sed -n \'1,40p\' .experience/stop-extractor.js',
  ].join('\n');

  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((item) => item.type === 'retry_loop'), false);
});

test('detects retry loops for repeated mutating edits on the same file', () => {
  const transcript = [
    'ToolCall Edit: /repo/server.js replace fetch timeout from 5000 to 3000',
    'ToolCall Edit: /repo/server.js replace fetch timeout from 3000 to 2000',
    'ToolCall Edit: /repo/server.js replace fetch timeout from 2000 to 1500',
  ].join('\n');

  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((item) => item.type === 'retry_loop'), true);
});

test('requires 2+ consecutive errors or user correction for error_fix detection', () => {
  // Single error without user correction should NOT trigger error_fix (v2 threshold)
  const singleError = [
    'Assistant: There was an error earlier but now I am still exploring.',
    'ToolCall Bash: rg -n "extract" .experience/experience-core.js',
    'ToolOutput: HTTP 500 from /api/gates during smoke test',
    'ToolCall Edit: /repo/tools/exp-gates.js update collection scroll arguments',
  ].join('\n');
  const noFix = _detectMistakes(singleError);
  assert.equal(noFix.some((item) => item.type === 'error_fix'), false);

  // Two consecutive errors followed by fix should trigger
  const doubleError = [
    'ToolOutput: HTTP 500 from /api/gates during smoke test',
    'ToolOutput: Error: ENOENT: no such file or directory',
    'ToolCall Edit: /repo/tools/exp-gates.js update collection scroll arguments',
  ].join('\n');
  const withFix = _detectMistakes(doubleError);
  assert.equal(withFix.some((item) => item.type === 'error_fix'), true);
});
