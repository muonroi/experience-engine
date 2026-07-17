#!/usr/bin/env node
'use strict';

/**
 * exp-mcp — expose the Experience Engine brain to ANY MCP-capable agent
 * (Claude Code, Codex, Gemini CLI, …) as ee_query / ee_feedback / ee_write /
 * ee_health over stdio.
 *
 * muonroi-cli does NOT use this: it calls the same brain natively, in-process.
 * This exists so every other CLI gets the same four tools without depending on
 * muonroi-cli — the brain is the product, the transport is not.
 *
 * Install:
 *   npm i -g @muonroi/experience-engine
 *
 * Register (Claude Code):
 *   claude mcp add experience-engine -- exp-mcp
 *
 * Register (any client reading mcpServers config):
 *   { "mcpServers": { "experience-engine": { "command": "exp-mcp" } } }
 *
 * Server URL + auth token come from ~/.experience/config.json
 * (serverBaseUrl / serverAuthToken), so this works against the hosted brain on a
 * thin client, not just a local one.
 *
 * Env:
 *   EXPERIENCE_RECALL_FEEDBACK_GATE       off | soft (default) | hard
 *   EXPERIENCE_RECALL_FEEDBACK_THRESHOLD  hard-mode debt threshold (default 3)
 */

const path = require('path');
const { serve } = require(path.join(__dirname, '..', 'mcp', 'server.js'));
const { buildTools, callTool, describeTools } = require(path.join(__dirname, '..', 'mcp', 'tools.js'));

function version() {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    // stdout is the JSON-RPC transport, but --help means no client is attached.
    console.log(
      [
        'exp-mcp — Experience Engine MCP server (stdio)',
        '',
        'Tools: ee_query, ee_feedback, ee_write, ee_health',
        '',
        'Register with Claude Code:',
        '  claude mcp add experience-engine -- exp-mcp',
        '',
        'Or in any mcpServers config:',
        '  { "mcpServers": { "experience-engine": { "command": "exp-mcp" } } }',
        '',
        'Config: ~/.experience/config.json (serverBaseUrl, serverAuthToken)',
      ].join('\n'),
    );
    return;
  }

  const ctx = { tools: buildTools(), callTool, describeTools, version: version() };
  // Diagnostics go to stderr — stdout carries the protocol.
  console.error(`[exp-mcp] experience-engine v${ctx.version} ready — ${ctx.tools.length} tools on stdio`);
  await serve(ctx);
}

main().catch((err) => {
  console.error(`[exp-mcp] fatal: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
