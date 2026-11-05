'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(opts = {}) {
  const port = await freePort();
  const tmp = opts.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'posse-test-'));
  const fake = path.join(__dirname, 'fake-claude.js'); // run with this Node on every platform
  const env = { ...process.env, CLAUDE_BIN: fake, FAKE_CLAUDE_DIR: path.join(tmp, 'fake'), POSSE_FOLDER_QUIET_MS: '400', POSSE_FOLDER_GAP_MS: '600', POSSE_LIVE_APPROVAL_MS: '3000' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port), '--data', path.join(tmp, 'data')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/login'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const secret = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'secret.json'), 'utf8'));
  const auth = { authorization: 'Bearer ' + secret.accessKey };
  const api = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'X-Posse': '1', 'content-type': 'application/json', ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
  const msgs = async (ch) => (await api('GET', '/api/channels/' + encodeURIComponent(ch) + '/messages?limit=200')).data.messages;
  const waitFor = async (fn, ms = 15000, what = 'condition') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 80)); }
    throw new Error('Timed out waiting for ' + what + '\n--- server log ---\n' + log);
  };
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'fake', 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.argv.includes('-p')); } catch { return []; } };
  const stop = () => new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGTERM'); setTimeout(resolve, 1500); });
  return { base, api, msgs, waitFor, calls, stop, tmp, port, auth, secret, pid: child.pid, child, log: () => log };
}

module.exports = { startServer };
