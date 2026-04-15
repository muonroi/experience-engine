#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveCommand, main } = require('../bin/cli');

test('resolveCommand maps setup to packaged setup script', () => {
  const spec = resolveCommand('setup', ['--help']);
  assert.equal(spec.cmd, 'bash');
  assert.equal(spec.args[1], '--help');
  assert.equal(spec.args[0], path.resolve(__dirname, '..', '.experience', 'setup.sh'));
});

test('resolveCommand maps thin client and server commands', () => {
  const thin = resolveCommand('setup-thin-client', ['--server', 'http://example']);
  assert.equal(thin.cmd, 'bash');
  assert.equal(thin.args[0], path.resolve(__dirname, '..', '.experience', 'setup-thin-client.sh'));

  const server = resolveCommand('server');
  assert.equal(server.cmd, process.execPath);
  assert.equal(server.args[0], path.resolve(__dirname, '..', 'server.js'));
});

test('main prints help for empty command', () => {
  let output = '';
  const code = main([], {
    stdout: { write(chunk) { output += chunk; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.match(output, /Experience Engine CLI/);
  assert.match(output, /setup-thin-client/);
});

test('main rejects unknown commands', () => {
  let stderr = '';
  const code = main(['unknown'], {
    stdout: { write() {} },
    stderr: { write(chunk) { stderr += chunk; } },
  });
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command: unknown/);
});
