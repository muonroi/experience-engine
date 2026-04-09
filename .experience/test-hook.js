#!/usr/bin/env node
// Quick test for experience interceptor — used by setup.sh
'use strict';
const { intercept } = require('./experience-core.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const result = await intercept(
      data.tool_name || 'Edit',
      data.tool_input || {},
      AbortSignal.timeout(10000)
    );
    if (result) console.log(result);
  } catch (e) {
    console.error(e.message);
  }
  process.exit(0);
});
