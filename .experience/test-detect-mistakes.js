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

// Detector v2 (wondrous-twirling-finch): retry_loop replaced by trap
// (same old_string attempted twice). Different replacements on the same
// file are iterative dev, NOT a trap — correctly ignored.
test('iterative dev (3 distinct edits, different replacements) is NOT a trap', () => {
  const transcript = [
    'ToolCall Edit: /repo/server.js replace fetch timeout from 5000 to 3000',
    'ToolCall Edit: /repo/server.js replace fetch timeout from 3000 to 2000',
    'ToolCall Edit: /repo/server.js replace fetch timeout from 2000 to 1500',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((item) => item.type === 'trap' || item.type === 'retry_loop'), false);
});

test('detects trap when same edit fails then succeeds with different replacement', () => {
  const transcript = [
    'ToolCall Edit: file_path=/repo/server.js old_string=timeout: 5000 new_string=timeout: 3000',
    'ToolOutput: Error: string not found',
    'ToolCall Edit: file_path=/repo/server.js old_string=timeout: 5000 new_string=timeout: 2000',
    'ToolOutput: Successfully edited',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((item) => item.type === 'trap'), true);
});

// Detector v2: error_fix replaced by env_trap (env error -> workaround pair)
// and user_correction (user said no -> next mutating tool call). Single
// errors followed by an edit no longer trigger anything by themselves.
test('single error without env workaround does NOT trigger env_trap', () => {
  const singleError = [
    'Assistant: There was an error earlier but now I am still exploring.',
    'ToolCall Bash: rg -n extract .experience/experience-core.js',
    'ToolOutput: HTTP 500 from /api/gates during smoke test',
    'ToolCall Edit: /repo/tools/exp-gates.js update collection scroll arguments',
  ].join('\n');
  const out = _detectMistakes(singleError);
  assert.equal(out.some((item) => item.type === 'env_trap' || item.type === 'error_fix'), false);
});

test('detects env_trap when env error is followed by a workaround command', () => {
  const transcript = [
    'ToolCall Bash: rm -rf /tmp/x',
    'ToolOutput: EPERM operation not permitted, uv_spawn',
    'ToolCall Bash: rmdir tmp/x',
    'ToolOutput: ok done',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((item) => item.type === 'env_trap'), true);
});
