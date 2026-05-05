#!/usr/bin/env node
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { server } = require('../server.js');

let baseUrl;
let listening;

before(async () => {
  await new Promise((resolve) => {
    listening = server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => { listening?.close(); });

async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.json().catch(() => null), text: null };
}

async function fetchText(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, text: await res.text() };
}

describe('health endpoint', () => {
  it('returns ok with qdrant, embed, and fileStore fields', async () => {
    const { status, body } = await fetchJson('/health');
    assert.equal(status, 200);
    assert.ok(body.status, 'should have status field');
    assert.ok(body.qdrant, 'should have qdrant field');
    assert.ok(body.embed, 'should have embed field');
    assert.ok(body.fileStore, 'should have fileStore field');
    assert.ok(typeof body.uptime === 'number', 'should have uptime');
  });

  it('includes alerts array when services are degraded', async () => {
    const { body } = await fetchJson('/health');
    // alerts is optional — only present when degraded
    if (body.alerts) {
      assert.ok(Array.isArray(body.alerts));
    }
  });
});

describe('metrics endpoint', () => {
  it('returns Prometheus text format', async () => {
    const { status, text } = await fetchText('/metrics');
    assert.equal(status, 200);
    assert.ok(text.includes('experience_uptime_seconds'), 'should have uptime metric');
    assert.ok(text.includes('experience_memory_rss_bytes'), 'should have memory metric');
    assert.ok(text.includes('experience_rate_limit_buckets'), 'should have rate limit metric');
    assert.ok(text.includes('experience_qdrant_consecutive_failures'), 'should have qdrant failure metric');
    assert.ok(text.includes('experience_embed_consecutive_failures'), 'should have embed failure metric');
  });

  it('includes 24h activity counters', async () => {
    const { text } = await fetchText('/metrics');
    assert.ok(text.includes('experience_intercepts_24h'), 'should have intercepts counter');
    assert.ok(text.includes('experience_embed_ok_24h'), 'should have embed ok counter');
  });
});

describe('rate limiting', () => {
  it('returns X-RateLimit headers on API requests', async () => {
    const res = await fetch(`${baseUrl}/api/user`);
    assert.ok(res.headers.get('x-ratelimit-limit'), 'should have X-RateLimit-Limit header');
    assert.ok(res.headers.get('x-ratelimit-remaining') !== null, 'should have X-RateLimit-Remaining header');
  });

  it('does not rate limit /health endpoint', async () => {
    // Health should always work regardless of rate limit
    for (let i = 0; i < 5; i++) {
      const { status } = await fetchJson('/health');
      assert.equal(status, 200);
    }
  });
});

describe('CORS', () => {
  it('returns CORS headers on regular requests', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`${baseUrl}/api/intercept`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  });
});
