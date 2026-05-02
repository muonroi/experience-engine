#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const serverModule = require(path.join(__dirname, '..', 'server.js'));

test('resolvePointIdPrefix paginates until it finds the matching point', async (t) => {
  const responses = [
    {
      ok: true,
      json: async () => ({
        result: {
          points: [{ id: '11111111-0000-0000-0000-000000000000' }],
          next_page_offset: 'page-2',
        },
      }),
    },
    {
      ok: true,
      json: async () => ({
        result: {
          points: [{ id: 'abcd1234-0000-0000-0000-000000000000' }],
          next_page_offset: null,
        },
      }),
    },
  ];
  const calls = [];

  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return responses.shift();
  });

  const result = await serverModule.resolvePointIdPrefix('experience-selfqa', 'abcd1234');

  assert.deepEqual(result, { ok: true, id: 'abcd1234-0000-0000-0000-000000000000' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { limit: 100, with_payload: false });
  assert.deepEqual(calls[1].body, { limit: 100, with_payload: false, offset: 'page-2' });
});

test('resolvePointIdPrefix returns null after exhausting all pages', async (t) => {
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      result: {
        points: [{ id: '11111111-0000-0000-0000-000000000000' }],
        next_page_offset: null,
      },
    }),
  }));

  const result = await serverModule.resolvePointIdPrefix('experience-selfqa', 'abcd1234');
  assert.deepEqual(result, { ok: true, id: null });
});
