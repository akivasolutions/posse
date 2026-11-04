#!/usr/bin/env node
'use strict';
// Stdio MCP server that Claude Code starts for each bot turn. It exposes the Bullpen tools and
// forwards every call to the running Bullpen app over loopback HTTP, authenticated with the
// per-turn token the app put in this process's environment. No dependencies.
const http = require('http');
const readline = require('readline');
const { TOOLS } = require('./tools-def');

const BASE = process.env.BULLPEN_URL || 'http://127.0.0.1:4747';
const TOKEN = process.env.BULLPEN_TOKEN || '';

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function call(tool, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ tool, args: args || {} });
    const u = new URL('/api/mcp/call', BASE);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-bullpen-run': TOKEN },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ isError: true, text: 'Bullpen returned an unreadable response (HTTP ' + res.statusCode + ').' }); }
      });
    });
    req.on('error', (e) => resolve({ isError: true, text: 'Could not reach Bullpen at ' + BASE + ': ' + e.message }));
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'bullpen', version: '0.1.0' },
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const r = await call(params.name, params.arguments);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(r.text == null ? '' : r.text) }], isError: !!r.isError } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
rl.on('close', () => process.exit(0));
