#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTranscriptErrorSignal,
  isUserCorrectionLine,
  summarizeMistakeExcerpt,
  parseToolEvents,
  jaccardSimilarity,
  tokenizeForSimilarity,
} = require('./src/context');
const { _detectMistakes, _assessExtractedQaQuality } = require('./experience-core.js');

// ─── isTranscriptErrorSignal ─────────────────────────────────────────────

test('isTranscriptErrorSignal: ToolOutput without failure marker is NOT an error', () => {
  // Reading a config file successfully — used to fire the detector for ANY output
  assert.equal(isTranscriptErrorSignal('ToolOutput: {"port": 8082, "ok": true}'), false);
  assert.equal(isTranscriptErrorSignal('ToolOutput: read 250 bytes from /path/file.json'), false);
});

test('isTranscriptErrorSignal: ToolOutput containing word "error" in passing is NOT an error', () => {
  // Used to fire on log files containing "0 errors, 1 warning" or test files
  // named "error_handler". These were the most common false positives.
  assert.equal(isTranscriptErrorSignal('ToolOutput: 0 errors, 1 warning in build output'), false);
  assert.equal(isTranscriptErrorSignal('ToolOutput: opened test/error_handler.test.ts'), false);
  assert.equal(isTranscriptErrorSignal('ToolOutput: 5 tests passed, 0 failed'), false);
});

test('isTranscriptErrorSignal: ToolOutput WITH explicit failure marker IS an error', () => {
  assert.equal(isTranscriptErrorSignal('ToolOutput: HTTP 500 from /api/gates'), true);
  assert.equal(isTranscriptErrorSignal('ToolOutput: Error: ENOENT: no such file or directory'), true);
  assert.equal(isTranscriptErrorSignal('ToolOutput: TypeError: Cannot read properties of undefined'), true);
  assert.equal(isTranscriptErrorSignal('ToolOutput: Traceback (most recent call last)'), true);
  assert.equal(isTranscriptErrorSignal('ToolOutput: connection refused'), true);
  assert.equal(isTranscriptErrorSignal('ToolOutput: build failed: 3 compile errors'), true);
});

test('isTranscriptErrorSignal: Bash exit non-zero IS an error', () => {
  assert.equal(isTranscriptErrorSignal('Bash exit 1'), true);
  assert.equal(isTranscriptErrorSignal('Bash exit 127'), true);
  assert.equal(isTranscriptErrorSignal('Bash exit 0'), false);
});

test('isTranscriptErrorSignal: User/Assistant lines never error-signal', () => {
  // Even containing failure language — these are commentary
  assert.equal(isTranscriptErrorSignal('User: that test is failing because of timeout'), false);
  assert.equal(isTranscriptErrorSignal('Assistant: I see an error in the stack trace'), false);
});

// ─── isUserCorrectionLine ────────────────────────────────────────────────

test('isUserCorrectionLine: plain User: turn without correction language is NOT a correction', () => {
  // Old code treated ANY User: line as correction → bypassed every filter
  assert.equal(isUserCorrectionLine('User: continue please'), false);
  assert.equal(isUserCorrectionLine('User: ok thanks'), false);
  assert.equal(isUserCorrectionLine('User: now check the database'), false);
});

test('isUserCorrectionLine: User: turn with correction keywords IS a correction', () => {
  assert.equal(isUserCorrectionLine("User: no, that's wrong, undo it"), true);
  assert.equal(isUserCorrectionLine('User: stop, that approach is incorrect'), true);
  assert.equal(isUserCorrectionLine('User: revert that change please'), true);
  assert.equal(isUserCorrectionLine('User: that doesn\'t work, try a different way'), true);
  // Vietnamese
  assert.equal(isUserCorrectionLine('User: sai rồi, làm lại đi'), true);
  assert.equal(isUserCorrectionLine('User: đừng sửa file đó'), true);
});

// ─── assessExtractedQaQuality (path/tool-call rejection) ─────────────────

test('assessExtractedQaQuality: rejects ToolCall-shaped trigger', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'ToolCall read_text_file: /mnt/d/Personal/Core/storyflow/appsettings.json',
    question: 'config truncated',
    solution: 'ensure full content read without truncation in the buffer',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trigger_is_tool_call');
});

test('assessExtractedQaQuality: rejects path-leading trigger (Windows)', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'C:/Users/phila/.experience/config.json missing field',
    question: 'config missing',
    solution: 'add serverBaseUrl when running thin client behind firewall',
  });
  assert.equal(result.ok, false);
  // could match path_starts_with_path or path_is_path depending on slash count
  assert.match(result.reason, /trigger_(starts_with_path|is_path)/);
});

test('assessExtractedQaQuality: rejects path-heavy trigger (POSIX)', () => {
  const result = _assessExtractedQaQuality({
    trigger: '/home/phila/.experience/store/default/config.json placeholder',
    question: 'config defaults',
    solution: 'replace placeholders with real values before deploy',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /trigger_(starts_with_path|is_path)/);
});

test('assessExtractedQaQuality: still accepts pattern-style triggers', () => {
  const result = _assessExtractedQaQuality({
    trigger: 'config file read returns truncated content when output buffer is below file size',
    question: 'truncated config read',
    solution: 'increase buffer size or stream the file in chunks before parsing',
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

// ─── detectMistakes integration ──────────────────────────────────────────

test('detectMistakes: ignores normal session with successful tool calls and chatter', () => {
  const transcript = [
    'User: read the config and tell me the port',
    'ToolCall read_text_file: /home/phila/.experience/config.json',
    'ToolOutput: {"port": 8082, "ok": true}',
    'Assistant: port is 8082',
    'User: thanks',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.length, 0, 'normal session should produce 0 mistakes');
});

test('detectMistakes: ignores reading a file that contains the word error', () => {
  const transcript = [
    'ToolCall read_text_file: /repo/test/error_handler.test.ts',
    'ToolOutput: import { describe, it } from "vitest"; describe("error handler", () => { ... })',
    'Assistant: looked at the test file',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.length, 0, 'reading a file named error_* should not count as a mistake');
});

test('detectMistakes: detects 2 consecutive real failures followed by fix', () => {
  const transcript = [
    'ToolCall Bash: npm test',
    'ToolOutput: build failed: ENOENT package.json',
    'ToolOutput: TypeError: Cannot read properties of undefined',
    'ToolCall Edit: /repo/src/index.ts add missing import',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((m) => m.type === 'error_fix'), true);
});

test('detectMistakes: requires explicit user-correction language now', () => {
  // Old behavior: any User: line after error → "user correction" → mistake fires
  // New behavior: User: line must contain corrective language
  const transcript = [
    'ToolCall Bash: curl http://api.example.com',
    'ToolOutput: HTTP 500 internal server error',
    'User: ok keep going',  // not a correction
    'ToolCall Edit: /repo/retry.ts adjust timeout',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((m) => m.type === 'error_fix'), false,
    'plain User: turn without correction keywords should not trigger error_fix');
});

test('detectMistakes: real user-correction language DOES trigger', () => {
  const transcript = [
    'ToolCall Bash: curl http://api.example.com',
    'ToolOutput: HTTP 500 internal server error',
    "User: no, that's the wrong endpoint, fix it",
    'ToolCall Edit: /repo/retry.ts adjust endpoint',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((m) => m.type === 'error_fix'), true);
});

// ─── retry-similarity (ported from muonroi-cli) ──────────────────────────

test('detectMistakes: retry_similarity fires when failed Edit is followed by similar successful Edit', () => {
  const transcript = [
    'ToolCall Edit: /repo/src/server.ts replace fetch timeout 5000 with 3000',
    'ToolOutput: SyntaxError: Unexpected token',
    'ToolCall Edit: /repo/src/server.ts replace fetch timeout 5000 with 3000 properly',
    'ToolOutput: applied successfully',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((m) => m.type === 'retry_similarity'), true,
    'retry_similarity should detect failed→success on same target with similar input');
});

test('detectMistakes: retry_similarity does NOT fire when both calls succeed', () => {
  const transcript = [
    'ToolCall Edit: /repo/server.ts adjust timeout to 3000',
    'ToolOutput: applied successfully',
    'ToolCall Edit: /repo/server.ts adjust timeout to 2000',
    'ToolOutput: applied successfully',
  ].join('\n');
  const mistakes = _detectMistakes(transcript);
  assert.equal(mistakes.some((m) => m.type === 'retry_similarity'), false,
    'two successful edits should not be a mistake');
});

// ─── jaccardSimilarity sanity ────────────────────────────────────────────

test('jaccardSimilarity: identical sets = 1', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c'])), 1);
});

test('jaccardSimilarity: disjoint sets = 0', () => {
  assert.equal(jaccardSimilarity(new Set(['a']), new Set(['b'])), 0);
});

test('tokenizeForSimilarity: filters short tokens', () => {
  const t = tokenizeForSimilarity('a bb ccc dddd');
  assert.equal(t.has('a'), false);
  assert.equal(t.has('bb'), true);
  assert.equal(t.has('ccc'), true);
});

// ─── parseToolEvents ─────────────────────────────────────────────────────

test('parseToolEvents: marks success/failure based on subsequent ToolOutput', () => {
  const lines = [
    'ToolCall Bash: npm test',
    'ToolOutput: 5 tests passed',
    'ToolCall Bash: deploy.sh',
    'ToolOutput: build failed: missing image',
    'ToolCall Bash: ls /tmp',
    'Bash exit 0',
  ];
  const events = parseToolEvents(lines);
  assert.equal(events.length, 3);
  assert.equal(events[0].success, true);
  assert.equal(events[1].success, false);
  assert.equal(events[2].success, true);
});

// ─── summarizeMistakeExcerpt ─────────────────────────────────────────────

test('summarizeMistakeExcerpt: structures by labelled section', () => {
  const summary = summarizeMistakeExcerpt({
    type: 'error_fix',
    context: '2 errors followed by correction',
    excerpt: [
      'ToolCall Bash: npm test',
      'ToolOutput: TypeError: undefined',
      'ToolOutput: 1 test failed',
      "User: no, that's wrong, fix the import",
      'ToolCall Edit: /repo/src/index.ts add import',
    ].join('\n'),
  });
  assert.match(summary, /MISTAKE TYPE: error_fix/);
  assert.match(summary, /CONTEXT:/);
  assert.match(summary, /FAILURE OUTPUT:/);
  assert.match(summary, /USER CORRECTION:/);
  assert.match(summary, /SUBSEQUENT MUTATION:/);
});
