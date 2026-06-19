#!/usr/bin/env node
'use strict';

/**
 * signal-detector.test.js — pure rule-based signal extraction
 * (.experience/src/signal-detector.js). No LLM, no Qdrant, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sd = require('../.experience/src/signal-detector.js');

// --- classifyQuestion (vi + en) ---

test('classifyQuestion: directive / exploratory / debugging / comparison', () => {
  assert.equal(sd.classifyQuestion('fix lỗi build cho tôi'), 'debugging'); // "lỗi" wins over directive
  assert.equal(sd.classifyQuestion('làm giúp tôi cái counter'), 'directive');
  assert.equal(sd.classifyQuestion('cái này có khả thi không?'), 'exploratory');
  assert.equal(sd.classifyQuestion('should I use Redis or Postgres here?'), 'exploratory'); // "should i"
  assert.equal(sd.classifyQuestion('tại sao test không chạy?'), 'debugging');
  assert.equal(sd.classifyQuestion('dùng A hay B tốt hơn'), 'comparison');
  assert.equal(sd.classifyQuestion('   '), null);
});

// --- parseTranscriptTurns ---

test('parseTranscriptTurns: splits roles, keeps multiline, drops tool turns', () => {
  const t = [
    'User: hello',
    'continued line',
    'Assistant: hi there',
    'ToolOutput: some output',
    'User: ok',
  ].join('\n');
  const turns = sd.parseTranscriptTurns(t);
  assert.deepEqual(turns.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(turns[0].text, 'hello\ncontinued line');
  assert.equal(turns[2].text, 'ok');
});

// --- classifyResponse ---

test('classifyResponse: ack / correction / authoritative / experimental', () => {
  assert.deepEqual(sd.classifyResponse('ok'), [{ dimension: 'communication.feedback_style', value: 'implicit' }]);
  const corr = sd.classifyResponse('không, ý tôi là dùng cách khác');
  assert.ok(corr.some((v) => v.value === 'precise-correction'));
  assert.ok(corr.some((v) => v.value === 'direct-constructive'));
  assert.deepEqual(sd.classifyResponse('cứ thử đi xem sao'), [{ dimension: 'personality.risk_tolerance', value: 'experimental' }]);
  assert.deepEqual(sd.classifyResponse(''), []);
});

// --- detectSignals end-to-end (pure) ---

test('detectSignals: emits question_style + brevity + response votes from transcript', () => {
  const transcript = [
    'User: làm giúp tôi build cái API',
    'Assistant: done',
    'User: không, ý tôi là dùng REST',
    'Assistant: ok updated',
    'User: tại sao nó lỗi?',
  ].join('\n');
  const { signals, stats } = sd.detectSignals({ transcript, activityEvents: [], now: Date.parse('2026-06-10T10:00:00Z') });
  assert.equal(stats.userTurns, 3);
  const qs = signals.filter((s) => s.dimension === 'communication.question_style').map((s) => s.value);
  assert.ok(qs.includes('directive'));
  assert.ok(qs.includes('debugging'));
  assert.ok(signals.some((s) => s.dimension === 'communication.feedback_style' && s.value === 'precise-correction'));
  assert.ok(signals.some((s) => s.dimension === 'communication.brevity' && s.value === 'concise'));
});

test('detectSignals: decision_speed from interceptor-prompt gaps', () => {
  const base = Date.parse('2026-06-10T10:00:00Z');
  const activityEvents = [0, 30000, 60000, 90000].map((d) => ({ ts: new Date(base + d).toISOString(), op: 'hook', hook: 'interceptor-prompt' }));
  const { signals } = sd.detectSignals({ transcript: '', activityEvents, now: base });
  const ds = signals.find((s) => s.dimension === 'personality.decision_speed');
  assert.ok(ds, 'decision_speed signal present');
  assert.equal(ds.value, 'fast-intuitive'); // 30s median < 90s
});

test('detectSignals: cross-session gap (>1h) excluded from decision_speed', () => {
  const base = Date.parse('2026-06-10T10:00:00Z');
  // two prompts then a 3h gap then two more → only the two intra-session 30s gaps count (<3 → no signal)
  const ts = [0, 30000, 3 * 3600000, 3 * 3600000 + 30000].map((d) => ({ ts: new Date(base + d).toISOString(), op: 'hook', hook: 'interceptor-prompt' }));
  const { signals } = sd.detectSignals({ transcript: '', activityEvents: ts, now: base });
  assert.equal(signals.find((s) => s.dimension === 'personality.decision_speed'), undefined);
});

test('detectSignals: work_patterns energy + multitasking', () => {
  const base = Date.parse('2026-06-10T10:00:00Z');
  const events = [];
  for (let i = 0; i < 12; i++) events.push({ ts: new Date(base + i * 1000).toISOString(), op: 'relevance-gate', project: i % 5 === 0 ? `proj-${i}` : 'proj-main' });
  const { signals } = sd.detectSignals({ transcript: '', activityEvents: events, now: base });
  const energy = signals.find((s) => s.dimension === 'work_patterns.energy');
  assert.ok(energy && ['night-owl', 'daytime', 'mixed'].includes(energy.value));
  const multi = signals.find((s) => s.dimension === 'work_patterns.multitasking');
  assert.ok(multi, 'multitasking signal present');
});

test('detectSignals: session_length — one vote per session, bucketed, single-prompt skipped', () => {
  const base = Date.parse('2026-06-10T10:00:00Z');
  const at = (mins) => ({ ts: new Date(base + mins * 60000).toISOString(), op: 'hook', hook: 'interceptor-prompt' });
  // Session A: 0,5,10min → 10min span → short. Then >1h gap.
  // Session B: 130,150,170min → 40min span → medium. Then >1h gap.
  // Session C: 300,330,360,390min → 90min span → long. Then >1h gap.
  // Session D: single prompt at 500min → no duration → no vote.
  const events = [0, 5, 10, 130, 150, 170, 300, 330, 360, 390, 500].map(at);
  const { signals } = sd.detectSignals({ transcript: '', activityEvents: events, now: base });
  const lens = signals.filter((s) => s.dimension === 'work_patterns.session_length').map((s) => s.value);
  assert.deepEqual(lens, ['short', 'medium', 'long'], 'one vote per multi-prompt session, single-prompt skipped');
});

test('detectSignals: session_length absent when fewer than 2 prompts', () => {
  const base = Date.parse('2026-06-10T10:00:00Z');
  const events = [{ ts: new Date(base).toISOString(), op: 'hook', hook: 'interceptor-prompt' }];
  const { signals } = sd.detectSignals({ transcript: '', activityEvents: events, now: base });
  assert.equal(signals.find((s) => s.dimension === 'work_patterns.session_length'), undefined);
});

// --- readActivityEvents (I/O boundary) ---

test('readActivityEvents: skips+counts malformed lines, ENOENT → empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-act-'));
  const file = path.join(dir, 'activity.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ ts: '2026-06-10T10:00:00Z', op: 'hook' }),
    '{ this is not json',
    JSON.stringify({ ts: '2026-06-10T10:01:00Z', op: 'route' }),
  ].join('\n') + '\n');
  try {
    const { events, skipped } = sd.readActivityEvents(file, 0);
    assert.equal(events.length, 2);
    assert.equal(skipped, 1);
    const missing = sd.readActivityEvents(path.join(dir, 'nope.jsonl'), 0);
    assert.deepEqual(missing, { events: [], skipped: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readActivityEvents: since filter drops older rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-since-'));
  const file = path.join(dir, 'activity.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ ts: '2026-06-01T00:00:00Z', op: 'old' }),
    JSON.stringify({ ts: '2026-06-10T00:00:00Z', op: 'new' }),
  ].join('\n') + '\n');
  try {
    const { events } = sd.readActivityEvents(file, Date.parse('2026-06-05T00:00:00Z'));
    assert.deepEqual(events.map((e) => e.op), ['new']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
