#!/usr/bin/env node
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { server } = require('../server.js');

const {
  detectEnvironment,
  injectEnvironmentContext,
  syncIDEBuffers,
  readBufferOrDisk,
  getDirtyGitDiff
} = require('../.experience/src/sync-utils');

const { routeModel } = require('../.experience/src/router');

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

after(() => {
  listening?.close();
  // Cleanup test sync file if it exists
  const syncFile = path.join(os.homedir(), '.experience', 'tmp', 'ide-buffers.json');
  try {
    fs.unlinkSync(syncFile);
  } catch (e) {}
});

describe('Phase 4: Environment Handshake & Git-Diff Preservation', () => {
  it('detectEnvironment detects host OS, shell, and active paths', () => {
    const env = detectEnvironment();
    assert.ok(env.hostOS, 'should detect host OS');
    assert.ok(env.shellType, 'should detect shell type');
    assert.ok(Array.isArray(env.activePaths), 'should return active paths');
  });

  it('injectEnvironmentContext appends OS specs to system prompt if missing', () => {
    const originalPrompt = 'You are a helpful coding assistant.';
    const enriched = injectEnvironmentContext(originalPrompt);
    assert.ok(enriched.includes('[Client Environment]'), 'should inject environment details');
    assert.ok(enriched.includes('OS:'), 'should include OS detail');
  });

  it('injectEnvironmentContext leaves system prompt untouched if OS specs exist', () => {
    const originalPrompt = 'You are a helpful assistant. client host OS: Windows/PowerShell';
    const enriched = injectEnvironmentContext(originalPrompt);
    assert.equal(enriched, originalPrompt, 'should not double inject');
  });

  it('getDirtyGitDiff runs gracefully without throwing', () => {
    const diff = getDirtyGitDiff(process.cwd());
    // Since this runs in a git repo, it may return string or null depending on clean/dirty
    if (diff !== null) {
      assert.equal(typeof diff, 'string');
    }
  });

  it('routeModel injects systemPrompt, systemContext, and gitDiff into returned object', async () => {
    const context = { cwd: process.cwd(), systemPrompt: 'Test system prompt' };
    const res = await routeModel('test task classification', context, 'claude');
    
    assert.ok(res.systemContext, 'should return systemContext');
    assert.ok(res.systemPrompt, 'should return systemPrompt');
    assert.ok(res.systemPrompt.includes('[Client Environment]'), 'systemPrompt should be enriched');
    assert.ok(res.hasOwnProperty('gitDiff'), 'should have gitDiff field');
  });
});

describe('Phase 5: IDE Buffer Sync & Integration', () => {
  it('syncIDEBuffers saves dirty buffers and readBufferOrDisk retrieves them', () => {
    const testFile = path.resolve('./temp-test-buffer-file.txt');
    const mockContent = 'Dirty IDE buffer content';
    
    // Write original file to disk
    fs.writeFileSync(testFile, 'Disk content', 'utf8');
    
    try {
      // Sync it as dirty editor buffer
      const syncObj = {};
      syncObj[testFile] = mockContent;
      const syncResult = syncIDEBuffers(syncObj);
      assert.ok(syncResult, 'sync should return true');
      
      // Read buffer
      const readContent = readBufferOrDisk(testFile, 'utf8');
      assert.equal(readContent, mockContent, 'should read from dirty IDE buffer instead of disk');
      
      // Try a different non-existent path - should read from disk (fail-open or throw if file missing)
      assert.throws(() => readBufferOrDisk('non-existent-file-path-xyz.txt', 'utf8'));
    } finally {
      try {
        fs.unlinkSync(testFile);
      } catch (e) {}
    }
  });

  it('POST /api/sync-buffers updates editor buffers in the cache', async () => {
    const testFile = path.resolve('./temp-api-test-file.txt');
    const mockContent = 'API Dirty buffer content';
    fs.writeFileSync(testFile, 'Disk content 2', 'utf8');
    
    try {
      const buffers = {};
      buffers[testFile] = mockContent;
      
      const config = require('../.experience/src/config').getConfig();
      const token = config.server?.authToken || config.serverAuthToken || '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const res = await fetch(`${baseUrl}/api/sync-buffers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ buffers })
      });
      
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.ok);
      
      // Read buffer and check it updated
      const readContent = readBufferOrDisk(testFile, 'utf8');
      assert.equal(readContent, mockContent, 'buffer should sync via server endpoint');
    } finally {
      try {
        fs.unlinkSync(testFile);
      } catch (e) {}
    }
  });
});
