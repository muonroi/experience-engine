#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function usage(out = process.stdout) {
  out.write(`Experience Engine CLI

Usage:
  experience-engine setup [args...]
  experience-engine setup-thin-client [args...]
  experience-engine sync-install [args...]
  experience-engine server [args...]
  experience-engine health [args...]
  experience-engine help

Commands:
  setup               Run the full installer from this package
  setup-thin-client   Convert the current machine into a thin client
  sync-install        Sync packaged runtime files into ~/.experience
  server              Start the Experience Engine API server
  health              Run the installed ~/.experience health check
  help                Show this help
`);
}

function resolveCommand(command, args = []) {
  const root = packageRoot();
  switch (command) {
    case 'setup':
      return { cmd: 'bash', args: [path.join(root, '.experience', 'setup.sh'), ...args] };
    case 'setup-thin-client':
      return { cmd: 'bash', args: [path.join(root, '.experience', 'setup-thin-client.sh'), ...args] };
    case 'sync-install':
      return { cmd: 'bash', args: [path.join(root, '.experience', 'sync-install.sh'), ...args] };
    case 'server':
      return { cmd: process.execPath, args: [path.join(root, 'server.js'), ...args] };
    case 'health':
      return { cmd: 'bash', args: [path.join(root, '.experience', 'health-check.sh'), ...args] };
    case 'help':
    case undefined:
      return null;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage(io.stdout);
    return 0;
  }

  let spec;
  try {
    spec = resolveCommand(command, args);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n`);
    usage(io.stderr);
    return 1;
  }

  const child = spawnSync(spec.cmd, spec.args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (child.error) {
    io.stderr.write(`${child.error.message}\n`);
    return 1;
  }
  if (typeof child.status === 'number') return child.status;
  return 1;
}

module.exports = {
  main,
  resolveCommand,
  usage,
};
