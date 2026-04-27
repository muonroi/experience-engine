#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const probe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
const CHILD_BLOCKED = !!probe.error;
const TIMEOUT_ASSERT_MAX_MS = 4300;

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-hook-payload-'));
  fs.mkdirSync(path.join(homeDir, '.experience', 'tmp'), { recursive: true });
  return homeDir;
}

function copyRuntime(homeDir, files) {
  for (const file of files) {
    fs.copyFileSync(path.join(__dirname, file), path.join(homeDir, '.experience', file));
  }
}

function writeExperienceCore(homeDir, body) {
  fs.writeFileSync(path.join(homeDir, '.experience', 'experience-core.js'), body);
}

function runHook(homeDir, scriptName, input) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(homeDir, '.experience', scriptName)], {
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      EXPERIENCE_HOOK_DEBUG_LOG: path.join(homeDir, '.experience', 'tmp', 'debug.jsonl'),
    },
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 8000,
  });

  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - started,
  };
}

function noisyCoreFixture() {
  return `module.exports = {
  interceptWithMeta: async (tool, toolInput) => {
    process.stdout.write('[Model Router] -> balanced (claude-sonnet-4-6) — balanced complexity task [brain]\\n');
    console.log('noisy console log should be suppressed');
    return {
      suggestions: '⚠️ [Experience] Stub warning for ' + tool,
      surfacedIds: [{ collection: 'experience-selfqa', id: 'stub-1' }],
      route: { tier: 'balanced', model: 'claude-sonnet-4-6', confidence: 0.75, source: 'brain' },
    };
  },
  _activityLog: () => {},
};`;
}

function scoredPromptCoreFixture(score, label, id) {
  const prefix = score >= 0.60 ? '⚠️ [Experience - High Confidence' : '💡 [Suggestion';
  return `module.exports = {
  interceptWithMeta: async () => ({
    suggestions: '${prefix} (${score.toFixed(2)})]: ${label}\\n   [id:${id} col:experience-selfqa]',
    surfacedIds: [{ collection: 'experience-selfqa', id: '${id}', solution: '${label}' }],
    route: null,
  }),
  _activityLog: () => {},
};`;
}

function slowCoreFixture() {
  return `module.exports = {
  interceptWithMeta: async (_tool, _toolInput, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
    return { suggestions: 'late', surfacedIds: [], route: null };
  },
  _activityLog: () => {},
};`;
}

test('local PreToolUse emits valid JSON payload and suppresses stray stdout', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor.js']);
  writeExperienceCore(homeDir, noisyCoreFixture());

  const result = runHook(homeDir, 'interceptor.js', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-local-pre',
    tool_name: 'Bash',
    tool_input: { command: 'dotnet test' },
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout || '{}');
  assert.match(payload.systemMessage || '', /Stub warning for Bash/);
  assert.doesNotMatch(payload.systemMessage || '', /\[Model Route\] tier=balanced/);
  assert.doesNotMatch(result.stdout, /\[Model Router\] ->/);
  assert.doesNotMatch(result.stdout, /noisy console log/);
});

test('local PreToolUse fast-skips PowerShell read-only commands with valid allow payload', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor.js']);
  writeExperienceCore(homeDir, `module.exports = {
  interceptWithMeta: async () => {
    throw new Error('read-only commands should not invoke intercept');
  },
  _activityLog: () => {},
};`);

  const result = runHook(homeDir, 'interceptor.js', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-local-pre-readonly',
    tool_name: 'Bash',
    tool_input: { command: 'Get-Content .quick-codex-flow\\\\quick-codex-subagents-design.md -TotalCount 220' },
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('local UserPromptSubmit emits valid JSON payload and suppresses stray stdout', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-prompt.js']);
  writeExperienceCore(homeDir, noisyCoreFixture());

  const result = runHook(homeDir, 'interceptor-prompt.js', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-local-prompt',
    user_prompt: 'verify quick-codex should be preferred for codex cli',
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout || '{}');
  assert.equal(payload.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(payload.hookSpecificOutput?.additionalContext || '', /Stub warning for UserPrompt/);
  assert.doesNotMatch(payload.hookSpecificOutput?.additionalContext || '', /\[Model Route\] tier=balanced/);
  assert.doesNotMatch(result.stdout, /\[Model Router\] ->/);
  assert.doesNotMatch(result.stdout, /noisy console log/);

  const statePath = path.join(homeDir, '.experience', 'tmp', 'last-suggestions.json');
  assert.equal(fs.existsSync(statePath), true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.tool, 'UserPrompt');
  assert.equal(state.sourceHook, 'UserPromptSubmit');
  assert.equal(state.prompt, 'verify quick-codex should be preferred for codex cli');
  assert.equal(state.cwd, '/repo/experience-engine');
  assert.equal(state.sourceSession, 'sess-local-prompt');
  assert.equal(state.surfacedIds.length, 1);
  assert.equal(state.surfacedIds[0].id, 'stub-1');
});

test('local UserPromptSubmit suppresses low-score prompt suggestions', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-prompt.js']);
  writeExperienceCore(homeDir, scoredPromptCoreFixture(0.17, 'Low score prompt noise', 'lowscore'));

  const result = runHook(homeDir, 'interceptor-prompt.js', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-low-score-prompt',
    user_prompt: 'please inspect the repo and decide what to change',
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(homeDir, '.experience', 'tmp', 'last-suggestions.json')), false);
});

test('local UserPromptSubmit keeps high-score prompt suggestions', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-prompt.js']);
  writeExperienceCore(homeDir, scoredPromptCoreFixture(0.72, 'High score prompt guidance', 'highscor'));

  const result = runHook(homeDir, 'interceptor-prompt.js', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-high-score-prompt',
    user_prompt: 'please implement the prompt stale feedback loop',
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout || '{}');
  assert.match(payload.hookSpecificOutput?.additionalContext || '', /High score prompt guidance/);
  const state = JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'tmp', 'last-suggestions.json'), 'utf8'));
  assert.equal(state.surfacedIds[0].id, 'highscor');
});

test('local UserPromptSubmit reconciles stale prompt-only state before next prompt', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor-prompt.js']);
  writeExperienceCore(homeDir, `module.exports = {
  interceptWithMeta: async () => ({ suggestions: null, surfacedIds: [], route: null }),
  _reconcileStalePromptSuggestions: async (state, nextPromptMeta) => {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(process.env.HOME, '.experience', 'tmp', 'reconciled.json'), JSON.stringify({ state, nextPromptMeta }, null, 2));
    return { ok: true, unused: [{ collection: 'experience-selfqa', id: 'oldhint' }], irrelevant: [], expired: [] };
  },
  _activityLog: () => {},
};`);
  const statePath = path.join(homeDir, '.experience', 'tmp', 'last-suggestions.json');
  fs.writeFileSync(statePath, JSON.stringify({
    ts: new Date(Date.now() - 11_000).toISOString(),
    tool: 'UserPrompt',
    sourceHook: 'UserPromptSubmit',
    surfacedIds: [{ collection: 'experience-selfqa', id: 'oldhint' }],
    prompt: 'previous prompt that showed a hint',
    cwd: '/repo/experience-engine',
    sourceSession: 'sess-old-prompt',
  }, null, 2));

  const result = runHook(homeDir, 'interceptor-prompt.js', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-next-prompt',
    user_prompt: 'continue with the implementation now',
    cwd: '/repo/experience-engine',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(statePath), false);
  const reconciled = JSON.parse(fs.readFileSync(path.join(homeDir, '.experience', 'tmp', 'reconciled.json'), 'utf8'));
  assert.equal(reconciled.state.prompt, 'previous prompt that showed a hint');
  assert.equal(reconciled.nextPromptMeta.prompt, 'continue with the implementation now');
  assert.equal(reconciled.nextPromptMeta.sourceSession, 'sess-next-prompt');
});

test('local hooks exit cleanly on timeout without emitting partial payload', { skip: CHILD_BLOCKED ? 'sandbox blocks child node processes' : false }, () => {
  const homeDir = makeTempHome();
  copyRuntime(homeDir, ['interceptor.js', 'interceptor-prompt.js']);
  writeExperienceCore(homeDir, slowCoreFixture());

  const pre = runHook(homeDir, 'interceptor.js', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-timeout-pre',
    tool_name: 'Bash',
    tool_input: { command: 'dotnet test' },
    cwd: '/repo/experience-engine',
  });
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '');
  assert.ok(pre.durationMs < TIMEOUT_ASSERT_MAX_MS, `expected fast timeout for PreToolUse, got ${pre.durationMs}ms`);

  const prompt = runHook(homeDir, 'interceptor-prompt.js', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-timeout-prompt',
    user_prompt: 'verify hooks time out without leaking partial output',
    cwd: '/repo/experience-engine',
  });
  assert.equal(prompt.status, 0);
  assert.equal(prompt.stdout, '');
  assert.ok(prompt.durationMs < TIMEOUT_ASSERT_MAX_MS, `expected fast timeout for UserPromptSubmit, got ${prompt.durationMs}ms`);
});
