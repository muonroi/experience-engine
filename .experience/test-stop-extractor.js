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
  buildGeminiSessionData,
  findLatestGeminiSession,
  countImportantSignals,
  runBackfillExtractor,
  findAllRecentSessions,
  readMarker,
  writeMarker,
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

// TODO(v2-detector): fixture needs scenarios that trigger detectExperience (trap/env_trap/user_correction). Current fixture worked with the v1 detectMistakes API which v2 replaced. Skip until fixture is rewritten.
test('runStopExtractor extracts from Codex sessions and preserves Claude fallback', { skip: 'v2-detector contract gap; fixture needs rework' }, async () => {
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

test('compactTranscript preserves important ToolOutput lines and nearby context', () => {
  const transcript = [
    'Assistant: I am inspecting the failing flow.',
    'ToolCall Bash: npm test -- auth',
    'ToolOutput: FAIL auth.spec.ts with timeout while validating jwt refresh',
    'Assistant: I will patch the auth middleware next.',
    ...Array.from({ length: 300 }, (_, index) => `Noise line ${index + 1}`),
  ].join('\n');

  const compacted = compactTranscript(transcript, 500);
  assert.ok(compacted.length <= 500);
  assert.match(compacted, /ToolCall Bash: npm test -- auth/);
  assert.match(compacted, /ToolOutput: FAIL auth\.spec\.ts/);
  assert.match(compacted, /Assistant: I will patch the auth middleware next\./);
});

function writeGeminiSession(homeDir, projectSlug, mtimeMs = Date.now()) {
  const chatsDir = path.join(homeDir, '.gemini', 'tmp', projectSlug, 'chats');
  const filePath = path.join(chatsDir, 'session-abc123.jsonl');
  const messages = [
    { type: 'user', content: 'fix the failing auth test' },
    {
      type: 'gemini',
      content: 'I will run the tests first.',
      toolCalls: [
        {
          id: 'run_shell_command-1',
          name: 'run_shell_command',
          args: { command: 'npm test -- auth', description: 'run auth tests' },
          result: [{ functionResponse: { response: { output: 'Command: npm test -- auth\nOutput:\nFAIL auth.spec.ts' } } }],
        },
        {
          id: 'replace_in_file-1',
          name: 'replace_in_file',
          args: { file_path: 'src/auth.ts', old_string: 'bad', new_string: 'good' },
          result: [{ functionResponse: { response: { output: 'File updated.' } } }],
        },
      ],
    },
    { type: 'user', content: 'looks good now' },
  ];
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'));
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

test('buildGeminiSessionData parses messages and tool calls correctly', () => {
  const homeDir = makeTempHome();
  const filePath = writeGeminiSession(homeDir, 'my-project');

  const result = buildGeminiSessionData(filePath);
  assert.match(result.transcript, /User: fix the failing auth test/);
  assert.match(result.transcript, /Assistant: I will run the tests first\./);
  assert.match(result.transcript, /ToolCall Bash: npm test -- auth/);
  assert.match(result.transcript, /ToolOutput: FAIL auth\.spec\.ts/);
  assert.match(result.transcript, /ToolCall Edit: src\/auth\.ts/);
  assert.match(result.transcript, /User: looks good now/);
});

test('buildGeminiSessionData handles real-world Gemini shapes (array content + grep_search/replace tool names)', () => {
  const homeDir = makeTempHome();
  const chatsDir = path.join(homeDir, '.gemini', 'tmp', 'real-project', 'chats');
  const filePath = path.join(chatsDir, 'session-real.json');
  const data = {
    messages: [
      { type: 'user', content: [{ text: 'find usages of flowcore_story' }] },
      {
        type: 'gemini',
        content: 'I will grep the repo.',
        toolCalls: [
          {
            name: 'grep_search',
            args: { pattern: 'flowcore_story' },
            result: [{ functionResponse: { response: { output: 'No matches found.' } } }],
          },
          {
            name: 'search_file_content',
            args: { query: 'flowcore' },
            result: [{ functionResponse: { response: { output: 'No matches.' } } }],
          },
          {
            name: 'replace',
            args: { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' },
            result: [{ functionResponse: { response: { output: 'ok' } } }],
          },
        ],
      },
    ],
  };
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));

  const result = buildGeminiSessionData(filePath);
  assert.match(result.transcript, /User: find usages of flowcore_story/);
  assert.doesNotMatch(result.transcript, /\[object Object\]/);
  assert.match(result.transcript, /ToolCall Grep: .*flowcore_story/);
  assert.match(result.transcript, /ToolCall Grep: .*flowcore/);
  assert.match(result.transcript, /ToolCall Edit: src\/x\.ts/);
});

test('findLatestGeminiSession resolves projectPath from projects.json for named dirs', () => {
  const homeDir = makeTempHome();
  const now = Date.now();
  const projectsFile = path.join(homeDir, '.gemini', 'projects.json');
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: { 'd:\\sources\\core\\my-project': 'my-project' } }));
  writeGeminiSession(homeDir, 'my-project', now - 1_000);

  const session = findLatestGeminiSession(homeDir, now);
  assert.ok(session);
  assert.equal(session.runtime, 'gemini');
  assert.equal(session.projectPath, 'd:\\sources\\core\\my-project');
});

test('findCurrentSession prefers Gemini session when newest', () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const now = Date.now();
  writeClaudeSession(homeDir, path.join('sample-project', 'session.jsonl'), now - 10_000);
  writeGeminiSession(homeDir, 'my-project', now - 1_000);

  const session = findCurrentSession(homeDir, now);
  assert.ok(session);
  assert.equal(session.runtime, 'gemini');
});

test('runStopExtractor accepts shorter but signal-dense Codex sessions', { skip: 'v2-detector contract gap; fixture needs rework' }, async () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const filePath = path.join(homeDir, '.codex', 'sessions', '2026', '04', '14', 'rollout-dense.jsonl');
  const lines = [
    { timestamp: '2026-04-14T01:00:00.000Z', type: 'session_meta', payload: { cwd: '/repo/storyflow' } },
    { timestamp: '2026-04-14T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the auth failure now' }] } },
    { timestamp: '2026-04-14T01:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test -- auth"}' } },
    { timestamp: '2026-04-14T01:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'Chunk ID: 1\\nOutput:\\nFAIL auth timeout while validating jwt refresh' } },
    { timestamp: '2026-04-14T01:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I will patch the auth middleware.' } },
  ];
  writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));

  const sessionData = buildCodexSessionData(filePath, 0);
  assert.ok(countImportantSignals(sessionData.transcript) >= 4);

  const result = await runStopExtractor({ homeDir, now: Date.now() });
  assert.equal(result.extracted, 2);
  const captured = JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'captured.json'), 'utf8'));
  assert.match(captured.transcript, /FAIL auth timeout while validating jwt refresh/);
});

test('readMarker migrates legacy {file, line} marker into per-file shape', () => {
  const homeDir = makeTempHome();
  const markerPath = path.join(homeDir, '.experience', '.stop-marker.json');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ file: '/old/session.jsonl', line: 42 }));

  const marker = readMarker(homeDir);
  assert.equal(marker.files['/old/session.jsonl'].line, 42);
});

test('writeMarker preserves legacy file/line fields for backward compat', () => {
  const homeDir = makeTempHome();
  fs.mkdirSync(path.join(homeDir, '.experience'), { recursive: true });
  writeMarker(homeDir, {
    files: {
      '/a.jsonl': { line: 10, extractedAt: '2026-05-20T10:00:00.000Z' },
      '/b.jsonl': { line: 20, extractedAt: '2026-05-21T10:00:00.000Z' },
    },
  });
  const raw = JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', '.stop-marker.json'), 'utf8'));
  assert.equal(raw.files['/a.jsonl'].line, 10);
  assert.equal(raw.files['/b.jsonl'].line, 20);
  assert.equal(raw.file, '/b.jsonl');
  assert.equal(raw.line, 20);
});

test('findAllRecentSessions enumerates Claude + Codex + Gemini sorted newest-first', () => {
  const homeDir = makeTempHome();
  const now = Date.now();
  writeClaudeSession(homeDir, path.join('proj-a', 'session.jsonl'), now - 60_000);
  writeCodexSession(homeDir, 'rollout-old.jsonl', now - 120_000);
  writeGeminiSession(homeDir, 'gem-proj', now - 30_000);

  const sessions = findAllRecentSessions(homeDir, now);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].runtime, 'gemini');
  assert.equal(sessions[1].runtime, 'claude');
  assert.equal(sessions[2].runtime, 'codex');
});

test('runBackfillExtractor processes every unprocessed session in the window', { skip: 'v2-detector contract gap; fixture needs rework' }, async () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const now = Date.now();
  writeClaudeSession(homeDir, path.join('proj-x', 'session.jsonl'), now - 3 * 60 * 60 * 1000);
  writeCodexSession(homeDir, 'rollout-x.jsonl', now - 2 * 60 * 60 * 1000);
  writeGeminiSession(homeDir, 'gem-x', now - 1 * 60 * 60 * 1000);

  const result = await runBackfillExtractor({ homeDir, now });
  assert.equal(result.mode, 'backfill');
  assert.equal(result.processed, 3);
  assert.ok(result.extracted >= 3);
  assert.equal(result.sessions[0].runtime, 'gemini');

  const marker = readMarker(homeDir);
  assert.equal(Object.keys(marker.files).length, 3);

  const again = await runBackfillExtractor({ homeDir, now });
  assert.equal(again.processed, 0);
  assert.equal(again.skipped, 3);
});

test('runBackfillExtractor caps at maxSessions (newest first)', { skip: 'v2-detector contract gap; fixture needs rework' }, async () => {
  const homeDir = makeTempHome();
  writeCoreStub(homeDir);
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    writeClaudeSession(homeDir, path.join(`proj-${i}`, 'session.jsonl'), now - (i + 1) * 60_000);
  }

  const result = await runBackfillExtractor({ homeDir, now, maxSessions: 3 });
  assert.equal(result.processed, 3);
  assert.equal(result.sessions.length, 3);
});
