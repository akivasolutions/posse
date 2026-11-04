#!/usr/bin/env node
'use strict';
// Bullpen — a local team of persistent AI bots powered by the Claude Code CLI.
// Usage: node server.js [--port 4747] [--data ./data] [--host 127.0.0.1] [--open]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { App, httpError } = require('./lib/app');
const { callTool } = require('./lib/tools');
const pkg = require('./package.json');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.env['BULLPEN_' + name.toUpperCase()] || dflt;
}

const PORT = parseInt(arg('port', '4747'), 10);
const HOST = arg('host', '127.0.0.1');
// Default data folder is per-user (~/.bullpen), so other accounts on a shared machine can't read it.
const DATA = path.resolve(arg('data', path.join(os.homedir(), '.bullpen')));
const PUBLIC = path.join(__dirname, 'public');
const BASE = 'http://127.0.0.1:' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/csv; charset=utf-8',
};

const app = new App({ dataDir: DATA, baseUrl: BASE });

// ---------------- access key ----------------
// Bullpen listens on loopback, but on a shared machine other accounts can reach loopback too.
// Every request needs the access key: as an HttpOnly cookie set by the sign-in page or by
// opening /?key=…, or as "Authorization: Bearer <key>" for scripts.
const crypto = require('crypto');
const SECRET_FILE = 'secret.json';
let secret = app.store.readJSON(SECRET_FILE, null);
if (!secret || !secret.accessKey || !secret.cookie) {
  secret = { accessKey: crypto.randomBytes(18).toString('base64url'), cookie: crypto.randomBytes(32).toString('base64url') };
  app.store.writeJSON(SECRET_FILE, secret);
}
const COOKIE = 'bp_session';
const OPEN_URL = BASE + '/?key=' + encodeURIComponent(secret.accessKey);
function same(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
function authed(req) {
  const h = String(req.headers.authorization || '');
  return same(cookieOf(req), secret.cookie) || (h.startsWith('Bearer ') && same(h.slice(7), secret.accessKey));
}
function setSession(res, location) {
  res.writeHead(302, { location, 'set-cookie': COOKIE + '=' + secret.cookie + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000', 'cache-control': 'no-store', ...SEC_HEADERS });
  res.end();
}
const loginFails = [];
function loginLimited() {
  const now = Date.now();
  while (loginFails.length && now - loginFails[0] > 10 * 60e3) loginFails.shift();
  return loginFails.length >= 10;
}
function loginPage(msg) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bullpen — sign in</title>' +
    '<style>body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f4f7;color:#1c1f24;display:grid;place-items:center;min-height:100vh;margin:0}' +
    'form{background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.1);width:min(380px,90vw)}h1{font-size:18px;margin:0 0 6px}p{color:#5b6370;font-size:13.5px;margin:0 0 14px}' +
    'input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cfd4dc;border-radius:8px;font:inherit;margin-bottom:12px}button{width:100%;padding:9px;border:0;border-radius:8px;background:#4f6bed;color:#fff;font:inherit;font-weight:600;cursor:pointer}' +
    '.err{color:#d23b3b}@media (prefers-color-scheme:dark){body{background:#121417;color:#e7e9ed}form{background:#1d2025}input{background:#17191d;color:#e7e9ed;border-color:#3a3f48}p{color:#9aa1ad}}</style></head>' +
    '<body><form method="post" action="/login"><h1>Bullpen</h1><p>Enter the access key. It\'s printed in the window where Bullpen is running, and saved in <code>secret.json</code> in your data folder.</p>' +
    (msg ? '<p class="err">' + msg + '</p>' : '') + '<input name="key" type="password" autocomplete="current-password" autofocus placeholder="Access key"><button>Sign in</button></form></body></html>';
}

// ---------------- helpers ----------------
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
// The app itself: only its own scripts, no remote images (a misled bot can't leak data through an
// image URL), no framing by other sites.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf || typeof body === 'string' ? (headers['content-type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': APP_CSP,
    'x-frame-options': 'DENY',
    ...SEC_HEADERS,
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req, limit = 2e6) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
}

// Only answer requests addressed to this machine by name or loopback address. Blocks DNS
// rebinding: a web page can't point its own hostname at 127.0.0.1 and drive the API.
function hostAllowed(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['127.0.0.1', 'localhost', '::1'].includes(h)) return true;
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return h === HOST.toLowerCase() || h === os.hostname().toLowerCase();
  return false;
}

function serveStatic(res, file) {
  fs.readFile(file, (e, buf) => {
    if (e) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

// Bot-made pages run scripts but can't reach the network, Bullpen's API, navigate away, open
// windows or submit forms, so a page can't carry data out even if a bot was misled.
const PAGE_CSP = "sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data:; media-src data: blob:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'";

function pageShell(title, markdown) {
  const data = JSON.stringify(markdown).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title.replace(/[<>&"]/g, '') + '</title><link rel="stylesheet" href="/page.css"></head><body><main id="doc"></main>' +
    '<script src="/md.js"></script><script>document.getElementById("doc").innerHTML = window.renderMarkdown(' + data + ');</script></body></html>';
}

// ---------------- SSE ----------------
const clients = new Set();
app.on('ev', (ev) => { const line = 'data: ' + JSON.stringify(ev) + '\n\n'; for (const c of clients) c.write(line); });
app.on('activity', (a) => { const line = 'data: ' + JSON.stringify({ type: 'activity', ...a }) + '\n\n'; for (const c of clients) c.write(line); });
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25e3).unref();

// ---------------- routes ----------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, open: !!opts.open });
}

route('GET', '/api/state', () => app.publicState());

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return undefined;
});

route('GET', '/api/channels/:ch/messages', (req, res, p, url) => {
  app.checkChannel(p.ch);
  return app.channels.page(p.ch, { before: url.searchParams.get('before'), limit: Math.min(200, parseInt(url.searchParams.get('limit') || '80', 10) || 80) });
});
route('POST', '/api/channels/:ch/messages', async (req, res, p) => {
  const b = await json(req);
  return { msg: app.userSend(p.ch, b.text, b.files) };
});
route('POST', '/api/channels/:ch/read', (req, res, p) => { app.markRead(p.ch); return { ok: true }; });
route('POST', '/api/channels/:ch/cards/:id', async (req, res, p) => app.answerCard(p.ch, p.id, await json(req)));

route('POST', '/api/bots', async (req) => ({ bot: app.publicBot(app.createBot(await json(req))) }));
route('PATCH', '/api/bots/:id', async (req, res, p) => ({ bot: app.publicBot(app.updateBot(p.id, await json(req))) }));
route('DELETE', '/api/bots/:id', (req, res, p) => { app.deleteBot(p.id); return { ok: true }; });
route('POST', '/api/bots/:id/stop', (req, res, p) => ({ stopped: app.runner.stop(p.id) }));
route('POST', '/api/bots/:id/reset-session', (req, res, p) => { app.resetSession(p.id); return { ok: true }; });
route('POST', '/api/bots/:id/clear-queue', (req, res, p) => {
  const b = app.bots.get(p.id);
  if (!b) throw httpError(404, 'No such bot');
  const dropped = b._queue || [];
  b._queue = [];
  app.runner.saveQueue(b);
  for (const i of dropped) if (i.kind === 'task') { const t = app.tasks.get(i.taskId); if (t) app.closeTask(t, 'cancelled', 'Cleared from the queue by ' + app.config.userName + '.'); }
  app.emitBot(b);
  return { cleared: dropped.length };
});
route('GET', '/api/bots/:id/memory', (req, res, p) => { if (!app.bots.has(p.id)) throw httpError(404, 'No such bot'); return { text: app.readMemory(p.id) }; });
route('PUT', '/api/bots/:id/memory', async (req, res, p) => { app.writeMemory(p.id, (await json(req)).text); return { ok: true }; });
route('GET', '/api/memory', () => ({ text: app.readMemory(null) }));
route('PUT', '/api/memory', async (req) => { app.writeMemory(null, (await json(req)).text); return { ok: true }; });

route('POST', '/api/rooms', async (req) => ({ room: app.createRoom(await json(req)) }));
route('PATCH', '/api/rooms/:id', async (req, res, p) => ({ room: app.updateRoom(p.id, await json(req)) }));
route('DELETE', '/api/rooms/:id', (req, res, p) => { app.deleteRoom(p.id); return { ok: true }; });

route('POST', '/api/tasks/:id/cancel', (req, res, p) => ({ task: app.cancelTask(Number(p.id)) }));

route('GET', '/api/skills/:slug', (req, res, p) => { const s = app.readSkill(p.slug); if (!s) throw httpError(404, 'No such skill'); return s; });
route('POST', '/api/skills', async (req) => { const b = await json(req); return { slug: app.saveSkill(b, b.prevSlug) }; });
route('DELETE', '/api/skills/:slug', (req, res, p) => { app.deleteSkill(p.slug); return { ok: true }; });

route('POST', '/api/routines', async (req) => app.publicRoutine(app.createRoutine({ ...(await json(req)), createdBy: 'user' })));
route('PATCH', '/api/routines/:id', async (req, res, p) => app.publicRoutine(app.updateRoutine(p.id, await json(req))));
route('DELETE', '/api/routines/:id', (req, res, p) => { app.deleteRoutine(p.id); return { ok: true }; });
route('POST', '/api/routines/:id/run', (req, res, p) => {
  const r = app.routines.get(p.id);
  if (!r) throw httpError(404, 'No such routine');
  app.fireRoutine(r);
  return { ok: true };
});

route('DELETE', '/api/pages/:id', (req, res, p) => { app.deletePage(p.id); return { ok: true }; });

route('PATCH', '/api/config', async (req) => ({ config: app.updateConfig(await json(req)) }));
route('POST', '/api/cli/check', () => { const cli = require('./lib/claude-cli'); const i = cli.detect(app.config.claudePath, { force: true }); return { found: i.found, path: i.path, version: i.version, error: i.error }; });

route('POST', '/api/upload', async (req, res, p, url) => {
  const name = decodeURIComponent(String(req.headers['x-filename'] || url.searchParams.get('name') || 'upload'));
  const data = await readBody(req, 200 * 1024 * 1024);
  const f = app.addFile({ name, data, kind: 'upload' });
  return { id: f.id, name: f.name, size: f.size };
});

// Webhook trigger for routines (authenticated by the routine's secret in the URL).
route('POST', '/api/hooks/:id/:secret', async (req, res, p) => {
  const r = app.routines.get(p.id);
  if (!r || r.secret !== p.secret || r.schedule.type !== 'webhook') throw httpError(404, 'Not found');
  if (!r.enabled) throw httpError(409, 'Routine is paused');
  const body = (await readBody(req, 256 * 1024)).toString('utf8');
  app.fireRoutine(r, body || '(empty body)');
  return { ok: true };
}, { open: true });

// Called by lib/mcp-server.js on behalf of a running bot turn.
route('POST', '/api/mcp/call', async (req) => {
  const run = app.runner.byToken.get(String(req.headers['x-bullpen-run'] || ''));
  if (!run) return { isError: true, text: 'This turn has ended; Bullpen tools are unavailable.' };
  const b = await json(req, 8e6);
  try { return await callTool(app, run, String(b.tool || ''), b.args || {}); } catch (e) { return { isError: true, text: e.message }; }
}, { open: true });

// Bullpen's tools over MCP "Streamable HTTP", answered with plain JSON. Claude Code connects to
// this directly, so a bot turn needs no extra helper process. Auth: the per-turn bearer token.
const { TOOLS } = require('./lib/tools-def');
async function handleMcp(req, res) {
  if (req.method !== 'POST') return send(res, 405, '', { allow: 'POST' });
  const auth = String(req.headers.authorization || '');
  const run = app.runner.byToken.get(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  let body;
  try { body = JSON.parse((await readBody(req, 8e6)).toString('utf8')); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (!run) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This turn has ended or the token is invalid.' } });
  const one = async (m) => {
    if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return null; // notification
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bullpen', version: pkg.version } });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = m.params || {};
        let r;
        try { r = await callTool(app, run, String(p.name || ''), p.arguments || {}); } catch (e) { r = { isError: true, text: e.message }; }
        return reply({ content: [{ type: 'text', text: String(r.text == null ? '' : r.text) }], isError: !!r.isError });
      }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  return send(res, 200, out);
}

// ---------------- server ----------------
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!(e instanceof URIError) && !e.status) console.error('[bullpen]', req.method, req.url, e);
    if (!res.headersSent) send(res, e instanceof URIError ? 400 : e.status || 500, { error: e instanceof URIError ? 'Bad request' : e.message || 'Server error' });
    else res.end();
  });
});

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, BASE); } catch { return send(res, 400, 'Bad request'); }
  if (!hostAllowed(req)) return send(res, 403, 'Forbidden host');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/mcp') {
    try { return await handleMcp(req, res); } catch (e) { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); return; }
  }

  // Requests that change something must come from this app's own pages.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if ((origin && origin !== 'null' && origin !== 'http://' + req.headers.host) || site === 'cross-site') return send(res, 403, { error: 'Cross-site request refused' });
  }

  if (pathname === '/login') {
    if (req.method === 'POST') {
      if (loginLimited()) return send(res, 429, loginPage('Too many attempts. Wait a few minutes.'), { 'content-type': 'text/html; charset=utf-8' });
      const key = new URLSearchParams((await readBody(req, 4096).catch(() => Buffer.alloc(0))).toString('utf8')).get('key');
      if (same(key, secret.accessKey)) return setSession(res, '/');
      loginFails.push(Date.now());
      app.audit('login.failed', {});
      return send(res, 401, loginPage('That key didn\'t match.'), { 'content-type': 'text/html; charset=utf-8' });
    }
    return send(res, 200, loginPage(''), { 'content-type': 'text/html; charset=utf-8' });
  }

  const openRoute = req.method === 'POST' && (pathname === '/api/mcp/call' || pathname.startsWith('/api/hooks/'));
  if (!openRoute && !authed(req)) {
    if (req.method === 'GET' && pathname === '/' && url.searchParams.get('key')) {
      if (!loginLimited() && same(url.searchParams.get('key'), secret.accessKey)) return setSession(res, '/');
      loginFails.push(Date.now());
    }
    if (pathname.startsWith('/api/')) return send(res, 401, { error: 'Sign in required' });
    if (req.method === 'GET') { res.writeHead(302, { location: '/login', 'cache-control': 'no-store' }); return res.end(); }
    return send(res, 401, 'Sign in required');
  }

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      // Browsers can't add custom headers cross-origin without a CORS preflight we never grant,
      // so requiring one on every write blocks other websites from driving the API.
      if (req.method !== 'GET' && !r.open && req.headers['x-bullpen'] !== '1') return send(res, 403, { error: 'Missing X-Bullpen header' });
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const out = await r.handler(req, res, params, url);
        if (out !== undefined && !res.headersSent) send(res, 200, out);
      } catch (e) {
        if (!e.status) console.error('[bullpen]', req.method, pathname, e);
        if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Server error' });
      }
      return;
    }
    return send(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  // Pages (bot-made reports/dashboards) are served sandboxed: no access to this app or the network.
  let m = /^\/pages\/([\w-]+)$/.exec(pathname);
  if (m) {
    const p = app.pages.get(m[1]);
    if (!p) return send(res, 404, 'Not found');
    const body = p.format === 'markdown'
      ? pageShell(p.title, app.store.readText(path.join('pages', p.id + '.md')))
      : app.store.readText(path.join('pages', p.id + '.html'));
    return send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'SAMEORIGIN' });
  }

  m = /^\/files\/([\w-]+)(?:\/.*)?$/.exec(pathname);
  if (m) {
    const f = app.fileById(m[1]);
    if (!f) return send(res, 404, 'Not found');
    const file = app.store.p(f.rel);
    const ext = path.extname(f.name).toLowerCase();
    const inline = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.md', '.json'].includes(ext) && url.searchParams.get('download') !== '1';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-disposition': (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'cache-control': 'no-store',
      ...SEC_HEADERS,
    });
    return fs.createReadStream(file).on('error', () => res.end()).pipe(res);
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveStatic(res, file);
  return serveStatic(res, path.join(PUBLIC, 'index.html'));
}
process.on('unhandledRejection', (e) => console.error('[bullpen] unhandled:', e));

// Approval prompts hold a request open while the user decides.
server.requestTimeout = 0;
server.headersTimeout = 60e3;
server.keepAliveTimeout = 65e3;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('\nPort ' + PORT + ' is in use. Is Bullpen already running? Open ' + BASE + ' or start with --port <another>.\n');
  else console.error(e);
  process.exit(1);
});

app.load();
server.listen(PORT, HOST, () => {
  const info = app.publicState().cli;
  console.log('\n  Bullpen ' + pkg.version + ' — open this link to sign in:\n  ' + OPEN_URL);
  console.log('  Data:   ' + DATA);
  console.log('  Claude: ' + (info.found ? info.version + ' (' + info.path + ')' : 'NOT FOUND — ' + info.error));
  console.log('');
  if (process.argv.includes('--open')) openBrowser(OPEN_URL);
});

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch {}
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  app.scheduler.stop();
  server.close();
  for (const c of clients) c.end();
  await app.runner.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
