#!/usr/bin/env node
'use strict';

const { main } = require('./cli');

process.exitCode = main();
