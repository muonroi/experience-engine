#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  pickDogfoodCandidate,
  buildDogfoodToolInput,
} = require('./exp-dogfood-loop.js');

test('parseArgs reads point id and iteration overrides', () => {
  const args = parseArgs(['--point-id', 'abc', '--iterations', '6', '--dry-run']);
  assert.equal(args.pointId, 'abc');
  assert.equal(args.iterations, 6);
  assert.equal(args.dryRun, true);
});

test('pickDogfoodCandidate ignores meta workflow organic lessons', () => {
  const points = [
    {
      id: 'meta',
      payload: {
        json: JSON.stringify({
          id: 'meta',
          createdFrom: 'session-extractor',
          tier: 2,
          createdAt: '2026-04-22T10:00:00Z',
          trigger: 'narrow locked scope for wave 2 artifact locking',
          question: 'risk of unintended scope expansion',
          solution: 'strictly adhere to the locked scope by only touching stop-extractor and related tests',
        }),
      },
    },
    {
      id: 'real',
      payload: {
        json: JSON.stringify({
          id: 'real',
          createdFrom: 'session-extractor',
          tier: 2,
          createdAt: '2026-04-22T11:00:00Z',
          trigger: 'when the same failing path is rerun without changing state',
          question: 'retry loop hides the real cause',
          solution: 'inspect the failure and change code, fixture, or command input before rerunning',
          scope: { lang: 'JavaScript' },
        }),
      },
    },
  ];

  const picked = pickDogfoodCandidate(points);
  assert.equal(picked.point.id, 'real');
});

test('buildDogfoodToolInput uses the candidate language to choose a file extension', () => {
  const input = buildDogfoodToolInput({
    id: 'abc12345',
    trigger: 'when x',
    solution: 'do y',
    scope: { lang: 'TypeScript' },
  }, 2);
  assert.match(input.file_path, /\.ts$/);
  assert.match(input.new_string, /dogfood confirmation 2/);
  assert.match(input.new_string, /when x/);
});
