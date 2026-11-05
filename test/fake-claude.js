#!/usr/bin/env node
'use strict';
// A stand-in for the Claude Code CLI used by the tests. It speaks the same stream-json output,
// keeps sessions on disk, and starts the MCP servers from --mcp-config just like the real CLI,
// so tests exercise the real Bullpen tool path without spending tokens.
//
// It follows directives found at the start of lines in its input:
//   @@call <tool> <json>     call mcp__bullpen__<tool> with the JSON arguments
//   @@perm <Tool> <json>     ask the --permission-prompt-tool for approval
//   @@sleep <ms>             wait (to test Stop)
//   @@fail <message>         end the turn with an error
//   @@as <handle> <directive>  run the directive only when this bot's handle matches
//   @@ctx <tokens>           report this context size in usage
//   @@reply <text>           final reply text (default: "ok: <first line of input>"); {AT} becomes @
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
if (argv.includes('--help')) {
  console.log(['-p', '--output-format', '--verbose', '--model', '--effort', '--session-id', '--resume', '--append-system-prompt',
    '--append-system-prompt-file', '--mcp-config', '--strict-mcp-config', '--setting-sources', '--max-turns', '--add-dir',
    '--permission-mode', '--allowedTools', '--disallowedTools', '--permission-prompt-tool', '--dangerously-skip-permissions', '--settings'].join('\n'));
  process.exit(0);
}
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dir = process.env.FAKE_CLAUDE_DIR || path.join(os.tmpdir(), 'fake-claude');
fs.mkdirSync(dir, { recursive: true });
let priority = null;
try { priority = require('os').getPriority(process.pid); } catch {}
let flagSettings = null;
try { if (opt('--settings')) flagSettings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8')); } catch {}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), settings: flagSettings, priority }) + '\n');

const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => main().catch((e) => { process.stderr.write(String(e.stack || e)); process.exit(1); }));

function startMcp(cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const s = cfg.mcpServers.bullpen;
  fs.appendFileSync(path.join(dir, 'transports.log'), (s.type || 'stdio') + '\n');
  if (s.type === 'http') {
    let seq = 0;
    const rpc = async (method, params) => {
      const r = await fetch(s.url, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
      if (/event-stream/.test(r.headers.get('content-type') || '')) {
        fs.appendFileSync(path.join(dir, 'transports.log'), 'sse-response\n');
        const text = await r.text();
        const data = text.split('\n').filter((l) => l.startsWith('data: ')).pop();
        return JSON.parse(data.slice(6));
      }
      return r.json();
    };
    return { rpc, close: () => {} };
  }
  const child = spawn(s.command, s.args, { env: { ...process.env, ...(s.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { rpc, close: () => child.kill() };
}

async function main() {
  const resume = opt('--resume');
  let sid = opt('--session-id');
  const sessFile = (id) => path.join(dir, 'session-' + id + '.json');
  let history = [];
  if (resume) {
    if (!fs.existsSync(sessFile(resume))) { process.stderr.write('No conversation found with session ID: ' + resume + '\n'); process.exit(1); }
    sid = resume;
    history = JSON.parse(fs.readFileSync(sessFile(resume), 'utf8')).history;
  }
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: opt('--model') || 'fake' });
  const mcp = opt('--mcp-config') ? startMcp(opt('--mcp-config')) : null;
  if (mcp) { await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }); await mcp.rpc('tools/list', {}); }

  let reply = null;
  let ctx = 1010;
  const notes = [];
  let me = '';
  try { const sp = fs.readFileSync(opt('--append-system-prompt-file'), 'utf8'); const hm = /\(handle @([\w-]+)\)/.exec(sp); if (hm) me = hm[1]; } catch {}
  for (const raw0 of input.split('\n')) {
    let line = raw0.trim();
    let m;
    const as = /^@@as\s+([\w-]+)\s+(.*)$/.exec(line);
    if (as) { if (as[1] !== me) continue; line = '@@' + as[2]; }
    if ((m = /^@@ctx\s+(\d+)/.exec(line))) { ctx = +m[1]; continue; }
    if ((m = /^@@call\s+(\w+)\s*(.*)$/.exec(line))) {
      const args = m[2] ? JSON.parse(m[2]) : {};
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + Date.now(), name: 'mcp__bullpen__' + m[1], input: args }] } });
      const r = await mcp.rpc('tools/call', { name: m[1], arguments: args });
      const text = r.result.content[0].text;
      notes.push(m[1] + ' -> ' + (r.result.isError ? 'ERROR ' : '') + text);
      out({ type: 'user', message: { content: [{ type: 'tool_result', content: text, is_error: !!r.result.isError }] } });
    } else if ((m = /^@@perm\s+(\w+)\s*(.*)$/.exec(line))) {
      const toolInput = m[2] ? JSON.parse(m[2]) : {};
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p' + Date.now(), name: m[1], input: toolInput }] } });
      const pt = opt('--permission-prompt-tool');
      if (!pt) { notes.push('perm ' + m[1] + ' -> denied (no prompt tool)'); continue; }
      const r = await mcp.rpc('tools/call', { name: pt.replace(/^mcp__bullpen__/, ''), arguments: { tool_name: m[1], input: toolInput, tool_use_id: 'x' } });
      const decision = JSON.parse(r.result.content[0].text);
      notes.push('perm ' + m[1] + ' -> ' + decision.behavior);
    } else if ((m = /^@@touch\s+(.+)$/.exec(line))) {
      const f = path.resolve(process.cwd(), m[1].trim());
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w' + Date.now(), name: 'Write', input: { file_path: f, content: 'written by the bot' } }] } });
      fs.writeFileSync(f, 'written by the bot');
    } else if ((m = /^@@sleep\s+(\d+)/.exec(line))) {
      await new Promise((res) => setTimeout(res, +m[1]));
    } else if ((m = /^@@fail\s*(.*)$/.exec(line))) {
      if (mcp) mcp.close();
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: m[1] || 'fake failure', session_id: sid, total_cost_usd: 0, usage: {} });
      process.exit(1);
    } else if ((m = /^@@reply\s+(.*)$/.exec(line))) {
      reply = m[1].replace(/\{AT\}/g, '@');
    }
  }
  if (mcp) mcp.close();
  const firstLine = input.split('\n').find((l) => l.trim() && !l.startsWith('[')) || input.split('\n')[0] || '';
  const text = reply != null ? reply : 'ok: ' + firstLine.slice(0, 80) + (notes.length ? '\n' + notes.join('\n') : '');
  history.push({ in: input, out: text });
  fs.writeFileSync(sessFile(sid), JSON.stringify({ history }));
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: 5, iterations: [{ input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0 }] } });
}
