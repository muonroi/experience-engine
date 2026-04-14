#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _shouldPromoteBehavioralToPrinciple,
  _buildPrincipleText,
} = require('./experience-core.js');

test('promotes mature high-hit behavioral entries to principles', () => {
  const now = new Date('2026-04-14T07:00:00Z').getTime();
  const result = _shouldPromoteBehavioralToPrinciple({
    createdFrom: 'bulk-seed',
    hitCount: 27,
    confidence: 0.92,
    createdAt: '2026-04-09T03:50:28.668Z',
    trigger: 'Never use hardcoded px widths for table columns',
    solution: 'Use responsive CSS instead.',
  }, now);
  assert.equal(result, true);
});

test('does not promote immature or low-confidence behavioral entries', () => {
  const now = new Date('2026-04-14T07:00:00Z').getTime();
  assert.equal(_shouldPromoteBehavioralToPrinciple({
    createdFrom: 'bulk-seed',
    hitCount: 5,
    confidence: 0.92,
    createdAt: '2026-04-09T03:50:28.668Z',
  }, now), false);
  assert.equal(_shouldPromoteBehavioralToPrinciple({
    createdFrom: 'bulk-seed',
    hitCount: 27,
    confidence: 0.5,
    createdAt: '2026-04-09T03:50:28.668Z',
  }, now), false);
});

test('buildPrincipleText derives a principle sentence from trigger and solution', () => {
  const text = _buildPrincipleText({
    trigger: 'Never use hardcoded px widths for table columns',
    solution: 'Use responsive CSS instead.',
  });
  assert.equal(text, 'Never use hardcoded px widths for table columns Use responsive CSS instead.');
});
