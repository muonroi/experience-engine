// Unit tests for src/session-emit.js — the Antigravity transcript reconstruction
// path. Verifies: (1) emit is gated on runtime + EE opt-in, (2) the emitted
// JSONL is the exact Claude shape buildClaudeSessionData() parses into
// User:/ToolCall/ToolOutput lines, (3) findAllRecentSessions() discovers the
// antigravity-sessions dir tagged runtime:'antigravity'.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate HOME so emit writes under a throwaway dir, not the real ~/.experience.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-session-emit-'));
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const emit = require('./src/session-emit.js');
const stop = require('./stop-extractor.js');

const EXP_DIR = path.join(TMP_HOME, '.experience');
const CONFIG = path.join(EXP_DIR, 'config.json');

function enableOptIn() {
  fs.mkdirSync(EXP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ee: true }), 'utf8');
}
function disableOptIn() {
  try { fs.rmSync(CONFIG, { force: true }); } catch {}
}

before(() => { enableOptIn(); });
after(() => {
  process.env.HOME = ORIG.HOME;
  process.env.USERPROFILE = ORIG.USERPROFILE;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

describe('session-emit: guards', () => {
  it('no-ops for a non-antigravity runtime', () => {
    const r = emit.appendRuntimeEvent({ runtime: 'claude', sessionId: 'x', cwd: '/tmp/p', role: 'user', blocks: [emit.textBlock('hi there friend')] });
    assert.strictEqual(r, null);
  });

  it('no-ops when EE opt-in (config.json) is absent', () => {
    disableOptIn();
    const r = emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId: 'gate', cwd: '/tmp/p', role: 'user', blocks: [emit.textBlock('hello world here')] });
    assert.strictEqual(r, null);
    enableOptIn();
  });

  it('no-ops on empty/invalid blocks or role', () => {
    assert.strictEqual(emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId: 's', cwd: '/p', role: 'user', blocks: [] }), null);
    assert.strictEqual(emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId: 's', cwd: '/p', role: 'bogus', blocks: [emit.textBlock('x')] }), null);
  });
});

describe('session-emit: writes Claude-shaped JSONL', () => {
  const sessionId = 'sess-abc-123';
  const cwd = path.join('D:', 'sources', 'eBerth');
  let file;

  it('writes a session_meta head with top-level cwd on first append', () => {
    file = emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId, cwd, role: 'user', blocks: [emit.textBlock('build a planner export feature')] });
    assert.ok(file && fs.existsSync(file), 'file should be created');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const head = JSON.parse(lines[0]);
    assert.strictEqual(head.type, 'session_meta');
    assert.strictEqual(head.cwd, cwd);
    assert.strictEqual(head.runtime, 'antigravity');
  });

  it('appends structured tool_use + tool_result entries to the same session file', () => {
    const f2 = emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId, cwd, role: 'assistant', blocks: [emit.toolUseBlock('Bash', { command: 'npm run build' })] });
    const f3 = emit.appendRuntimeEvent({ runtime: 'antigravity', sessionId, cwd, role: 'tool', blocks: [emit.toolResultBlock('Build failed: TS2304 cannot find name Foo')] });
    assert.strictEqual(f2, file);
    assert.strictEqual(f3, file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    // session_meta + 3 message entries
    assert.strictEqual(lines.length, 4);
    const entry = JSON.parse(lines[1]);
    assert.strictEqual(entry.message.role, 'user');
    assert.strictEqual(entry.message.content[0].type, 'text');
    assert.strictEqual(JSON.parse(lines[2]).message.content[0].type, 'tool_use');
    assert.strictEqual(JSON.parse(lines[3]).message.content[0].type, 'tool_result');
  });

  it('round-trips through buildSessionData -> User/ToolCall/ToolOutput lines', () => {
    const data = stop.buildSessionData({ runtime: 'antigravity', file, projectPath: cwd }, 0);
    assert.match(data.transcript, /User: build a planner export feature/);
    assert.match(data.transcript, /ToolCall|Bash/);
    assert.match(data.transcript, /ToolOutput: .*Build failed/);
  });
});

describe('session-emit: discovery', () => {
  it('findAllRecentSessions picks up antigravity-sessions tagged runtime:antigravity', () => {
    const sessions = stop.findAllRecentSessions(TMP_HOME, Date.now(), 365 * 24 * 3600 * 1000);
    const ag = sessions.filter(s => s.runtime === 'antigravity');
    assert.ok(ag.length >= 1, 'expected at least one antigravity session');
    assert.ok(ag.every(s => typeof s.file === 'string' && s.file.includes('antigravity-sessions')));
  });
});

describe('session-emit: session id resolution', () => {
  it('falls back to a deterministic per-cwd daily bucket when no id', () => {
    const a = emit._resolveSessionId({ sessionId: null, cwd: '/work/x' });
    const b = emit._resolveSessionId({ sessionId: null, cwd: '/work/x' });
    assert.strictEqual(a, b);
    assert.match(a, /^ag-[0-9a-f]{12}-\d{8}$/);
  });
  it('sanitizes a provided id', () => {
    assert.strictEqual(emit._resolveSessionId({ sessionId: 'a/b c:d' }), 'a_b_c_d');
  });
});
