#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findCurrentSession,
  runStopExtractor,
  buildCodexSessionData,
} = require('./stop-extractor');
const { compactTranscript, MAX_TRANSCRIPT_CHARS } = require('./extract-compact');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-stop-'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function writeCoreStub(homeDir) {
  const filePath = path.join(homeDir, '.experience', 'experience-core.js');
  writeFile(filePath, `
'use strict';
const fs = require('fs');
const path = require('path');
const home = ${JSON.stringify(homeDir)};
module.exports = {
  async extractFromSession(transcript, projectPath) {
    fs.writeFileSync(path.join(home, '.experience', 'captured.json'), JSON.stringify({ transcript, projectPath }));
    return 2;
  },
  async evolve() {
    fs.writeFileSync(path.join(home, '.experience', 'evolved.json'), JSON.stringify({ ok: true }));
    return { promoted: 0, abstracted: 0, demoted: 0, archived: 0 };
  },
};
`);
}

function writeCodexSession(homeDir, fileName, mtimeMs = Date.now()) {
  const filePath = path.join(homeDir, '.codex', 'sessions', '2026', '04', '14', fileName);
  const lines = [
    { timestamp: '2026-04-14T01:00:00.000Z', type: 'session_meta', payload: { cwd: '/repo/storyflow' } },
    { timestamp: '2026-04-14T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please fix failing tests' }] } },
    { timestamp: '2026-04-14T01:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"dotnet test /repo/storyflow/StoryFlow.sln"}' } },
    { timestamp: '2026-04-14T01:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'Chunk ID: 1\\nOutput:\\nerror: build failed\\nFAIL StoryFlow.Tests' } },
    { timestamp: '2026-04-14T01:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I found the failing assertion and will patch it.' } },
    { timestamp: '2026-04-14T01:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{"path":"/repo/storyflow/src/App.cs","patch":"*** Begin Patch"}' } },
    { timestamp: '2026-04-14T01:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'Chunk ID: 2\\nOutput:\\nSuccess. Updated the following files:\\nM /repo/storyflow/src/App.cs' } },
    { timestamp: '2026-04-14T01:00:07.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'no, use the other file instead' } },
    { timestamp: '2026-04-14T01:00:08.000Z', type: 'event_msg', payload: { type: 'exec_command_end', command: ['/bin/bash', '-lc', 'dotnet test /repo/storyflow/StoryFlow.sln'], aggregated_output: 'AssertionError at StoryFlow.Tests', exit_code: 1 } },
  ];
  writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

function writeClaudeSession(homeDir, relativePath, mtimeMs = Date.now()) {
  const filePath = path.join(homeDir, '.claude', 'projects', relativePath);
  const lines = Array.from({ length: 8 }, (_, index) => JSON.stringify({
    message: { content: `Claude line ${index + 1}` },
  }));
  writeFile(filePath, lines.join('\n'));
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

test('findCurrentSession prefers the newest Codex rollout over Claude session', () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const now = Date.now();
  writeClaudeSession(homeDir, path.join('sample-project', 'session.jsonl'), now - 5_000);
  const codexPath = writeCodexSession(homeDir, 'rollout-latest.jsonl', now - 1_000);

  const session = findCurrentSession(homeDir, now);
  assert.ok(session);
  assert.equal(session.runtime, 'codex');
  assert.equal(session.file, codexPath);
});

test('buildCodexSessionData normalizes Codex rollout into an extractable transcript', () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const filePath = writeCodexSession(homeDir, 'rollout-transcript.jsonl');

  const result = buildCodexSessionData(filePath, 0);
  assert.equal(result.projectPath, '/repo/storyflow');
  assert.match(result.transcript, /ToolCall Bash: dotnet test/);
  assert.match(result.transcript, /ToolCall Edit: \/repo\/storyflow\/src\/App\.cs/);
  assert.match(result.transcript, /ToolOutput: error: build failed FAIL StoryFlow\.Tests/);
  assert.match(result.transcript, /User: no, use the other file instead/);
});

test('runStopExtractor extracts from Codex sessions and preserves Claude fallback', async () => {
  const codexHome = makeTempHome();
  writeCoreStub(codexHome);
  writeCodexSession(codexHome, 'rollout-run.jsonl');

  const codexResult = await runStopExtractor({ homeDir: codexHome, now: Date.now() });
  assert.equal(codexResult.extracted, 2);
  assert.equal(codexResult.projectPath, '/repo/storyflow');

  const captured = JSON.parse(fs.readFileSync(path.join(codexHome, '.experience', 'captured.json'), 'utf8'));
  assert.equal(captured.projectPath, '/repo/storyflow');
  assert.match(captured.transcript, /ToolCall Bash: dotnet test/);

  const marker = JSON.parse(fs.readFileSync(path.join(codexHome, '.experience', '.stop-marker.json'), 'utf8'));
  assert.equal(marker.file, path.join(codexHome, '.codex', 'sessions', '2026', '04', '14', 'rollout-run.jsonl'));
  assert.ok(marker.line >= 8);

  const claudeHome = makeTempHome();
  writeCoreStub(claudeHome);
  writeClaudeSession(claudeHome, path.join('sample-project', 'session.jsonl'));

  const claudeResult = await runStopExtractor({ homeDir: claudeHome, now: Date.now() });
  assert.equal(claudeResult.extracted, 2);
  const claudeCaptured = JSON.parse(fs.readFileSync(path.join(claudeHome, '.experience', 'captured.json'), 'utf8'));
  assert.equal(claudeCaptured.projectPath, 'sample-project');
  assert.match(claudeCaptured.transcript, /Claude line 1/);
});

test('compactTranscript trims noisy repeated transcripts to a bounded payload', () => {
  const noisy = Array.from({ length: 200 }, (_, index) => (
    index % 3 === 0
      ? 'ToolOutput: Success. Updated the following files: M /repo/storyflow/src/App.cs'
      : index % 3 === 1
        ? 'Assistant: I will patch the file and rerun the tests.'
        : 'User: no, use the other file instead'
  )).join('\n');

  const compacted = compactTranscript(noisy);
  assert.ok(compacted.length <= MAX_TRANSCRIPT_CHARS);
  assert.match(compacted, /User: no, use the other file instead/);
  assert.match(compacted, /Assistant: I will patch the file/);
});
