'use strict';

// Strict outcome classifier for the lift experiment (spec §3 A0.2, §5
// "Classifier"). The property that matters: explicit signals only — output text
// is never read, so keyword-only output can be 'ok' or 'unknown' but never 'fail'.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  classifyToolFailure, inputHash, isMutatingTool, detectHookRuntime, stableStringify,
} = require(path.join(__dirname, '..', '..', '.experience', 'src', 'tool-outcome.js'));

const CASES = [
  // [label, input, expected]
  ['Claude Code PostToolUseFailure event', { hookEvent: 'PostToolUseFailure', toolName: 'Bash', toolResponse: {} }, 'fail'],
  ['Claude Code Bash success with exit_code 0', { hookEvent: 'PostToolUse', toolName: 'Bash', toolResponse: { stdout: 'ok', stderr: '', exit_code: 0 }, runtime: 'claude-code' }, 'ok'],
  ['Bash non-zero exit_code', { hookEvent: 'PostToolUse', toolName: 'Bash', toolResponse: { stdout: '', stderr: 'boom', exit_code: 2 } }, 'fail'],
  ['camelCase exitCode non-zero', { toolName: 'Bash', toolResponse: { exitCode: 1 } }, 'fail'],
  ['numeric-string exit code', { toolName: 'Bash', toolResponse: { exit_code: '127' } }, 'fail'],
  ['non-numeric exit code is no signal', { toolName: 'Bash', toolResponse: { exit_code: 'n/a' } }, 'unknown'],
  ['is_error true', { toolName: 'Edit', toolResponse: { is_error: true } }, 'fail'],
  ['is_error false', { toolName: 'Edit', toolResponse: { is_error: false } }, 'ok'],
  ['interrupted true', { toolName: 'Bash', toolResponse: { interrupted: true, stdout: '' } }, 'fail'],
  ['non-empty error field', { toolName: 'Write', toolResponse: { error: 'EACCES: permission denied' } }, 'fail'],
  ['empty error field is no signal', { toolName: 'Write', toolResponse: { error: '   ' } }, 'unknown'],
  ['Codex {output} with failure words only', { hookEvent: 'PostToolUse', toolName: 'Bash', toolResponse: { output: 'Error: FAILED fatal exception' } }, 'unknown'],
  ['Codex nested metadata.exit_code', { toolName: 'shell', toolResponse: { output: 'x', metadata: { exit_code: 1 } } }, 'fail'],
  ['Codex JSON string with exit 0', { toolName: 'shell', toolResponse: '{"output":"error: none","metadata":{"exit_code":0}}' }, 'ok'],
  ['plain keyword string', { toolName: 'Bash', toolResponse: 'error: something' }, 'unknown'],
  ['keyword output under Claude PostToolUse is ok by contract', { hookEvent: 'PostToolUse', toolName: 'Bash', toolResponse: { stdout: 'ERROR: 3 tests failed' }, runtime: 'claude-code' }, 'ok'],
  ['Claude Edit success shape', { hookEvent: 'PostToolUse', toolName: 'Edit', toolResponse: { filePath: '/x.ts', structuredPatch: [] }, runtime: 'claude-code' }, 'ok'],
  ['same shape from a non-Claude runtime', { hookEvent: 'PostToolUse', toolName: 'Edit', toolResponse: { filePath: '/x.ts' }, runtime: 'codex' }, 'unknown'],
  ['success true', { toolName: 'Write', toolResponse: { success: true } }, 'ok'],
  ['nothing at all', {}, 'unknown'],
];

for (const [label, input, expected] of CASES) {
  test(`classifyToolFailure: ${label} → ${expected}`, () => {
    assert.equal(classifyToolFailure(input), expected);
  });
}

test('classifyToolFailure never returns fail for keyword-only output', () => {
  for (const out of ['error', 'Error:', 'FAIL', 'fatal', 'exception', 'Traceback (most recent call last)']) {
    for (const shape of [out, { output: out }, { stdout: out }, { stderr: out }]) {
      assert.notEqual(classifyToolFailure({ hookEvent: 'PostToolUse', toolName: 'Bash', toolResponse: shape }), 'fail', JSON.stringify(shape));
    }
  }
});

test('inputHash is stable, key-order independent and input-sensitive', () => {
  const a = inputHash('Bash', { command: 'npm test', timeout: 5 });
  assert.equal(a, inputHash('Bash', { timeout: 5, command: 'npm test' }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, inputHash('Bash', { command: 'npm test -- -x', timeout: 5 }));
  assert.notEqual(a, inputHash('Shell', { command: 'npm test', timeout: 5 }));
  assert.equal(inputHash('Edit', undefined), inputHash('Edit', {}));
});

test('stableStringify sorts nested keys and skips undefined', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
});

test('isMutatingTool matches the legacy mutating family', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'Bash', 'shell', 'replace_in_file', 'execute_command', 'write_file']) assert.ok(isMutatingTool(t), t);
  for (const t of ['Read', 'Grep', 'UserPrompt', '']) assert.ok(!isMutatingTool(t), t);
});

test('detectHookRuntime: override wins, then Claude/Gemini/Codex env, else null', () => {
  assert.equal(detectHookRuntime('Antigravity', { CLAUDE_PROJECT_DIR: '/x' }), 'antigravity');
  assert.equal(detectHookRuntime(null, { CLAUDE_PROJECT_DIR: '/x' }), 'claude-code');
  assert.equal(detectHookRuntime(null, { CLAUDE_CODE_SESSION_ID: 's' }), 'claude-code');
  assert.equal(detectHookRuntime(null, { GEMINI_SESSION_ID: 's' }), 'gemini');
  assert.equal(detectHookRuntime(null, { CODEX_SESSION_ID: 's' }), 'codex');
  assert.equal(detectHookRuntime(null, {}), null);
});
