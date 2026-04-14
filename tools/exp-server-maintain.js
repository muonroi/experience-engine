#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');

function parseArgs(argv) {
  return {
    trigger: argv.includes('--trigger') ? argv[argv.indexOf('--trigger') + 1] || 'scheduled' : 'scheduled',
    evolve: !argv.includes('--no-evolve'),
  };
}

async function runMaintenance(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const core = require(path.join(homeDir, '.experience', 'experience-core.js'));
  const result = {
    trigger: options.trigger || 'scheduled',
    evolved: null,
  };
  if (options.evolve !== false) {
    result.evolved = await core.evolve(result.trigger);
  }
  return result;
}

if (require.main === module) {
  runMaintenance(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write(`${error.message || String(error)}\n`);
      process.exit(1);
    });
}

module.exports = { runMaintenance };
