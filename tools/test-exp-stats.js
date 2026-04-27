#!/usr/bin/env node
/**
 * test-exp-stats.js — Unit tests for exp-stats.js (OBS-01 through OBS-05)
 *
 * Run: node experience-engine/tools/test-exp-stats.js
 * Exit 0 on success, exit 1 on failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSince,
  loadEvents,
  filterEvents,
  normalizeProject,
  dayKey,
  computeStats,
  loadTop5
} = require('./exp-stats.js');

// --- OBS-05: parseSince ---

describe('parseSince', () => {
  it('returns Date ~7 days ago for "7d"', () => {
    const result = parseSince('7d');
    assert.ok(result instanceof Date, 'should return a Date');
    const expected = Date.now() - 7 * 86400000;
    assert.ok(Math.abs(result.getTime() - expected) < 2000, 'within 2s tolerance');
  });

  it('returns Date ~30 days ago for "30d"', () => {
    const result = parseSince('30d');
    assert.ok(result instanceof Date);
    const expected = Date.now() - 30 * 86400000;
    assert.ok(Math.abs(result.getTime() - expected) < 2000);
  });

  it('returns null for null input', () => {
    assert.strictEqual(parseSince(null), null);
  });

  it('returns null for invalid input', () => {
    assert.strictEqual(parseSince('invalid'), null);
    assert.strictEqual(parseSince('7h'), null);
    assert.strictEqual(parseSince(''), null);
  });
});

// --- OBS-05: filterEvents ---

describe('filterEvents', () => {
  const events = [
    { ts: '2026-01-01T00:00:00.000Z', op: 'intercept' },
    { ts: '2026-04-08T00:00:00.000Z', op: 'intercept' },
    { ts: '2026-04-09T00:00:00.000Z', op: 'extract' }
  ];

  it('excludes events older than cutoff', () => {
    const cutoff = new Date('2026-04-07T00:00:00.000Z');
    const result = filterEvents(events, cutoff);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].ts, '2026-04-08T00:00:00.000Z');
  });

  it('returns all events when cutoff is null', () => {
    const result = filterEvents(events, null);
    assert.strictEqual(result.length, 3);
  });
});

// --- OBS-04: normalizeProject ---

describe('normalizeProject', () => {
  it('returns "(unknown project)" for null', () => {
    assert.strictEqual(normalizeProject(null), '(unknown project)');
  });

  it('returns "(unknown project)" for undefined', () => {
    assert.strictEqual(normalizeProject(undefined), '(unknown project)');
  });

  it('normalizes backslashes and strips filename', () => {
    const result = normalizeProject('D:\\sources\\Core\\file.ts');
    assert.strictEqual(result, 'D:/sources/Core');
  });

  it('handles forward-slash paths', () => {
    const result = normalizeProject('/home/user/project/src/index.js');
    assert.strictEqual(result, '/home/user/project/src');
  });

  it('handles path with no directory separator', () => {
    const result = normalizeProject('file.ts');
    assert.strictEqual(result, '.');
  });
});

describe('dayKey', () => {
  it('returns YYYY-MM-DD for valid timestamps', () => {
    assert.strictEqual(dayKey('2026-04-14T05:01:02.000Z'), '2026-04-14');
  });

  it('returns fallback for invalid timestamps', () => {
    assert.strictEqual(dayKey('not-a-date'), 'unknown-day');
  });
});

// --- OBS-01 + OBS-02 + OBS-03: computeStats ---

describe('computeStats', () => {
  it('computes correct stats for mixed events', () => {
    const events = [
      { ts: '2026-04-09T00:00:00Z', op: 'intercept', result: 'suggestion', project: 'D:/proj/a.ts', scores: [0.9] },
      { ts: '2026-04-09T00:01:00Z', op: 'intercept', result: null, project: 'D:/proj/b.ts', scores: [0.3] },
      { ts: '2026-04-09T00:02:00Z', op: 'intercept', result: 'suggestion', project: 'D:/proj/a.ts', scores: [0.8] },
      { ts: '2026-04-09T00:02:30Z', op: 'feedback', verdict: 'FOLLOWED' },
      { ts: '2026-04-09T00:02:40Z', op: 'judge-feedback', verdict: 'IRRELEVANT', reason: 'wrong_task' },
      { ts: '2026-04-09T00:02:50Z', op: 'implicit-unused', reason: 'wrong_task' },
      { ts: '2026-04-09T00:02:51Z', op: 'noise-disposition', disposition: 'unused', source: 'implicit-posttool', reason: 'wrong_language' },
      { ts: '2026-04-09T00:02:52Z', op: 'noise-disposition', disposition: 'irrelevant', source: 'manual', reason: 'wrong_repo' },
      { ts: '2026-04-09T00:02:53Z', op: 'noise-disposition', disposition: 'unused', source: 'prompt-stale', unused: 2 },
      { ts: '2026-04-09T00:02:54Z', op: 'noise-suppressed', reason: 'wrong_task', count: 2 },
      { ts: '2026-04-09T00:02:55Z', op: 'mistake-seen', type: 'test_fail_fix', count: 2, project: 'D:/proj/c.ts' },
      { ts: '2026-04-09T00:02:56Z', op: 'mistake-seen', type: 'user_correction', count: 1, project: 'D:/proj/c.ts' },
      { ts: '2026-04-09T00:03:00Z', op: 'extract', mistakes: 3, stored: 2, project: 'D:/proj/c.ts' },
      { ts: '2026-04-09T00:04:00Z', op: 'extract', mistakes: 1, stored: 0, project: null },
      { ts: '2026-04-09T00:04:10Z', op: 'cost-call', kind: 'embed', units: 120, provider: 'siliconflow', source: 'general' },
      { ts: '2026-04-09T00:04:20Z', op: 'cost-call', kind: 'brain', units: 240, provider: 'siliconflow', source: 'extract' },
      { ts: '2026-04-10T00:04:30Z', op: 'cost-call', kind: 'judge', units: 60, provider: 'siliconflow', source: 'judge' },
      { ts: '2026-04-10T00:04:40Z', op: 'cost-call', kind: 'extract', units: 800, provider: 'local', source: 'session-extract' },
      { ts: '2026-04-09T00:05:00Z', op: 'evolve', promoted: 2, demoted: 1, abstracted: 1, archived: 3 }
    ];
    const s = computeStats(events);

    // OBS-01: Intercept stats
    assert.strictEqual(s.totalIntercepts, 3);
    assert.strictEqual(s.suggestions, 2);
    assert.strictEqual(s.misses, 1);

    // OBS-02: Extract stats
    assert.strictEqual(s.extractSessions, 2);
    assert.strictEqual(s.totalMistakes, 4);
    assert.strictEqual(s.totalStored, 2);

    // OBS-03: Evolve stats
    assert.strictEqual(s.evolveCount, 1);
    assert.strictEqual(s.promoted, 2);
    assert.strictEqual(s.demoted, 1);
    assert.strictEqual(s.abstracted, 1);
    assert.strictEqual(s.archived, 3);

    // Feedback / noise stats
    assert.strictEqual(s.feedbackCount, 2);
    assert.strictEqual(s.judgeFeedbackCount, 1);
    assert.strictEqual(s.feedbackByVerdict.FOLLOWED, 1);
    assert.strictEqual(s.feedbackByVerdict.IRRELEVANT, 1);
    assert.strictEqual(s.noiseByReason.wrong_task, 1);
    assert.strictEqual(s.implicitUnusedCount, 1);
    assert.strictEqual(s.implicitUnusedByReason.wrong_task, 1);
    assert.strictEqual(s.noiseDispositionCount, 4);
    assert.strictEqual(s.noiseDispositionBySource['implicit-posttool'], 1);
    assert.strictEqual(s.noiseDispositionBySource.manual, 1);
    assert.strictEqual(s.noiseDispositionBySource['prompt-stale'], 2);
    assert.strictEqual(s.noiseDispositionByReason.wrong_language, 1);
    assert.strictEqual(s.noiseDispositionByReason.wrong_repo, 1);
    assert.strictEqual(s.noiseSuppressionCount, 2);
    assert.strictEqual(s.noiseSuppressionByReason.wrong_task, 2);
    assert.strictEqual(s.mistakeSeenCount, 3);
    assert.strictEqual(s.mistakeByType.test_fail_fix, 2);
    assert.strictEqual(s.mistakeByProjectType['D:/proj :: test_fail_fix'], 2);
    assert.strictEqual(s.costCallCount, 4);
    assert.strictEqual(s.costByKind.embed, 1);
    assert.strictEqual(s.costUnitsByKind.brain, 240);
    assert.strictEqual(s.dailyCostLedger['2026-04-09'].units, 360);
    assert.strictEqual(s.dailyCostLedger['2026-04-10'].byKind.extract, 800);
  });

  it('returns all zeros for empty array (no NaN)', () => {
    const s = computeStats([]);
    assert.strictEqual(s.totalIntercepts, 0);
    assert.strictEqual(s.suggestions, 0);
    assert.strictEqual(s.misses, 0);
    assert.strictEqual(s.totalMistakes, 0);
    assert.strictEqual(s.totalStored, 0);
    assert.strictEqual(s.extractSessions, 0);
    assert.strictEqual(s.evolveCount, 0);
    assert.strictEqual(s.promoted, 0);
    assert.strictEqual(s.demoted, 0);
    assert.strictEqual(s.abstracted, 0);
    assert.strictEqual(s.archived, 0);
    assert.strictEqual(s.feedbackCount, 0);
    assert.strictEqual(s.feedbackByVerdict.FOLLOWED, 0);
    assert.strictEqual(s.noiseByReason.wrong_repo, 0);
    assert.strictEqual(s.noiseDispositionCount, 0);
    assert.strictEqual(s.noiseSuppressionCount, 0);
    assert.strictEqual(s.implicitUnusedCount, 0);
    assert.strictEqual(s.mistakeSeenCount, 0);
    assert.strictEqual(s.costCallCount, 0);
    assert.strictEqual(Object.keys(s.projects).length, 0);
  });

  it('groups per-project correctly with null -> "(unknown project)"', () => {
    const events = [
      { ts: '2026-04-09T00:00:00Z', op: 'intercept', result: 'suggestion', project: 'D:\\proj\\a.ts' },
      { ts: '2026-04-09T00:01:00Z', op: 'intercept', result: null, project: 'D:\\proj\\b.ts' },
      { ts: '2026-04-09T00:02:00Z', op: 'extract', mistakes: 2, stored: 1, project: null }
    ];
    const s = computeStats(events);

    // Both intercepts normalize to D:/proj
    assert.ok(s.projects['D:/proj'], 'D:/proj should exist');
    assert.strictEqual(s.projects['D:/proj'].intercepts, 2);
    assert.strictEqual(s.projects['D:/proj'].suggestions, 1);

    // Null project grouped as unknown
    assert.ok(s.projects['(unknown project)'], 'unknown project should exist');
    assert.strictEqual(s.projects['(unknown project)'].mistakes, 2);
    assert.strictEqual(s.projects['(unknown project)'].stored, 1);
  });

  it('maps legacy feedback.followed to verdict buckets', () => {
    const events = [
      { ts: '2026-04-09T00:00:00Z', op: 'feedback', followed: true },
      { ts: '2026-04-09T00:01:00Z', op: 'feedback', followed: false },
    ];
    const s = computeStats(events);
    assert.strictEqual(s.feedbackCount, 2);
    assert.strictEqual(s.feedbackByVerdict.FOLLOWED, 1);
    assert.strictEqual(s.feedbackByVerdict.IGNORED, 1);
  });
});

// --- loadEvents with temp dir ---

describe('loadEvents', () => {
  it('reads valid JSONL and skips malformed lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-stats-test-'));
    const logFile = path.join(tmpDir, 'activity.jsonl');

    const lines = [
      JSON.stringify({ ts: '2026-04-09T00:00:00Z', op: 'intercept', result: 'suggestion' }),
      'this is not json',
      JSON.stringify({ ts: '2026-04-09T00:01:00Z', op: 'extract', mistakes: 1, stored: 1 }),
      JSON.stringify({ ts: '2026-04-09T00:02:00Z', op: 'evolve', promoted: 1 })
    ];
    fs.writeFileSync(logFile, lines.join('\n') + '\n');

    const events = loadEvents(tmpDir);
    assert.strictEqual(events.length, 3, 'should have 3 valid events (1 malformed skipped)');
    assert.strictEqual(events[0].op, 'intercept');
    assert.strictEqual(events[1].op, 'extract');
    assert.strictEqual(events[2].op, 'evolve');

    // Cleanup
    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('reads rotated .1 file too', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-stats-test-'));
    const logFile = path.join(tmpDir, 'activity.jsonl');
    const rotatedFile = logFile + '.1';

    fs.writeFileSync(rotatedFile, JSON.stringify({ ts: '2026-01-01T00:00:00Z', op: 'intercept', result: null }) + '\n');
    fs.writeFileSync(logFile, JSON.stringify({ ts: '2026-04-09T00:00:00Z', op: 'extract', mistakes: 1, stored: 1 }) + '\n');

    const events = loadEvents(tmpDir);
    assert.strictEqual(events.length, 2, 'should read from both files');

    // Cleanup
    fs.unlinkSync(logFile);
    fs.unlinkSync(rotatedFile);
    fs.rmdirSync(tmpDir);
  });

  it('returns empty array for missing directory', () => {
    const events = loadEvents('/nonexistent/path/that/does/not/exist');
    assert.strictEqual(events.length, 0);
  });
});

// --- loadTop5 ---

describe('loadTop5', () => {
  it('returns empty array when store dir missing', () => {
    const result = loadTop5('/nonexistent/store/path');
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });

  it('returns sorted top-5 from synthetic store files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-stats-store-'));

    // Create a synthetic behavioral store with 3 entries
    const behavioral = [
      { payload: { json: JSON.stringify({ trigger: 'Use IMLog', hitCount: 14, solution: 's1' }) } },
      { payload: { json: JSON.stringify({ trigger: 'Library first', hitCount: 11, solution: 's2' }) } },
      { payload: { json: JSON.stringify({ trigger: 'No hardcoded widths', hitCount: 3, solution: 's3' }) } }
    ];
    fs.writeFileSync(path.join(tmpDir, 'experience-behavioral.json'), JSON.stringify(behavioral));

    // Create a synthetic principles store with 2 entries
    const principles = [
      { payload: { json: JSON.stringify({ trigger: 'Core principle', hitCount: 20, solution: 's4' }) } },
      { payload: { json: JSON.stringify({ trigger: 'Another principle', hitCount: 5, solution: 's5' }) } }
    ];
    fs.writeFileSync(path.join(tmpDir, 'experience-principles.json'), JSON.stringify(principles));

    const result = loadTop5(tmpDir);
    assert.strictEqual(result.length, 5);
    assert.strictEqual(result[0].hitCount, 20);
    assert.strictEqual(result[0].tier, 'T0');
    assert.strictEqual(result[1].hitCount, 14);
    assert.strictEqual(result[1].tier, 'T1');
    assert.strictEqual(result[4].hitCount, 3);

    // Cleanup
    fs.unlinkSync(path.join(tmpDir, 'experience-behavioral.json'));
    fs.unlinkSync(path.join(tmpDir, 'experience-principles.json'));
    fs.rmdirSync(tmpDir);
  });
});
