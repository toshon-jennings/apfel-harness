#!/usr/bin/env node
// Example MCP server for the Apfel Harness — a minimal, zero-dependency stdio
// server exposing two tools. Point the harness at it (Tune → MCP tools → Add):
//
//   /absolute/path/to/apfel-harness/examples/mcp-clock.js
//
// Make sure it's executable: chmod +x examples/mcp-clock.js
// Then ask the model: "what time is it?" or "what is 19 times 23?"
//
// apfel speaks MCP over stdio with newline-delimited JSON-RPC 2.0 and runs the
// whole tool loop itself — the model just decides when to call a tool.

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

const TOOLS = [
  {
    name: 'get_current_time',
    description: 'Get the current local date and time as an ISO 8601 string.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'calculate',
    description: 'Evaluate a basic arithmetic expression (+, -, *, /, parentheses).',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "19 * 23 + 4"' } },
      required: ['expression'],
    },
  },
];

function calculate(expr) {
  if (!/^[\d\s.+\-*/()]+$/.test(expr || '')) return 'ERROR: only numbers and + - * / ( ) are allowed';
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr});`)();
    return String(result);
  } catch {
    return 'ERROR: could not evaluate expression';
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'apfel-example-clock', version: '1.0.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    let text;
    if (name === 'get_current_time') text = new Date().toISOString();
    else if (name === 'calculate') text = calculate(params.arguments && params.arguments.expression);
    else return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } else if (method && method.startsWith('notifications/')) {
    // notifications get no reply
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
