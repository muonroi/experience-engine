'use strict';

/**
 * mcp/server.js — minimal MCP server over the stdio transport.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per line
 * on stdin, one per line on stdout. The surface a tools-only server owes a client
 * is three methods — `initialize`, `tools/list`, `tools/call` — plus `ping` and
 * the `notifications/initialized` handshake ack. That is small enough to own
 * outright, which is why this exists instead of @modelcontextprotocol/sdk:
 * experience-engine is zero-runtime-dependency by policy, and the SDK would drag
 * in zod and a transport layer to serve three methods.
 *
 * Rules that are easy to get wrong and are pinned by tests:
 *   - A NOTIFICATION (no `id`) gets NO response, ever. Replying to one is a
 *     protocol violation and some clients hard-fail on it.
 *   - `id` may legitimately be 0 or "" — test with `id === undefined`, never a
 *     truthiness check.
 *   - stdout is the transport. Anything else printed there corrupts the stream,
 *     so all diagnostics go to stderr.
 *   - A tool that throws must come back as a tool RESULT with isError, not a
 *     JSON-RPC error: JSON-RPC errors mean "the call failed", while a failing
 *     tool is a normal result the model is meant to read and react to.
 */

const readline = require('readline');

const SERVER_NAME = 'experience-engine';
// Versions whose tools surface we implement. If the client asks for one of these
// we echo it back; otherwise we answer with our newest and let the client decide.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/**
 * Handle one parsed JSON-RPC message.
 * @returns {Promise<object|null>} the response, or null for a notification.
 */
async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return errorResponse(null, JSONRPC_INVALID_REQUEST, 'invalid request');
  }
  const { id, method } = msg;
  const isNotification = id === undefined;

  if (typeof method !== 'string') {
    return isNotification ? null : errorResponse(id, JSONRPC_INVALID_REQUEST, 'method must be a string');
  }

  // Notifications: act, answer nothing.
  if (isNotification) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return result(id, {
          protocolVersion: negotiateProtocol(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: ctx.version },
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: ctx.describeTools(ctx.tools) });
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') {
          return errorResponse(id, JSONRPC_INVALID_REQUEST, 'params.name is required');
        }
        // A failing tool is a RESULT (isError), not a JSON-RPC error — the model
        // is supposed to see the failure and react to it.
        const out = await ctx.callTool(ctx.tools, name, msg.params?.arguments);
        return result(id, out);
      }
      default:
        return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  } catch (err) {
    // Never let a handler bug kill the process: the client would see the pipe
    // die with no explanation.
    console.error(`[exp-mcp] handler for ${method} threw:`, err?.stack || err?.message || err);
    return errorResponse(id, JSONRPC_INTERNAL_ERROR, err?.message || String(err));
  }
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Wire a line-based stdio loop. Exported with injectable streams so tests drive
 * it without spawning a process.
 */
function serve(ctx, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, terminal: false });

  const send = (obj) => {
    if (obj === null) return;
    output.write(`${JSON.stringify(obj)}\n`);
  };

  // Messages are processed in arrival order: a client may pipeline requests, and
  // a slow ee_query must not let a later ee_feedback answer ahead of it and
  // settle ledger debt the recall has not recorded yet.
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (err) {
        console.error(`[exp-mcp] malformed JSON on stdin: ${err?.message}`);
        return send(errorResponse(null, JSONRPC_PARSE_ERROR, 'parse error'));
      }
      send(await handleMessage(msg, ctx));
    });
  });

  return new Promise((resolve) => {
    rl.on('close', () => chain.then(resolve, resolve));
  });
}

module.exports = {
  serve,
  handleMessage,
  negotiateProtocol,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
};
