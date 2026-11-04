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
const DATA = path.resolve(arg('data', path.join(__dirname, 'data')));
const PUBLIC = path.join(__dirname, 'public');
const BASE = 'http://127.0.0.1:' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/csv; charset=utf-8',
};

const app = new App({ dataDir: DATA, baseUrl: BASE });

// ---------------- helpers ----------------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf || typeof body === 'string' ? (headers['content-type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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

async function json(req) {
  const buf = await readBody(req);
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

const PAGE_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data:; media-src data: blob:";

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
  const b = await json(req);
  try { return await callTool(app, run, String(b.tool || ''), b.args || {}); } catch (e) { return { isError: true, text: e.message }; }
}, { open: true });

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, BASE); } catch { return send(res, 400, 'Bad request'); }
  if (!hostAllowed(req)) return send(res, 403, 'Forbidden host');
  const pathname = decodeURIComponent(url.pathname);

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
    return send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP });
  }

  m = /^\/files\/([\w-]+)(?:\/.*)?$/.exec(pathname);
  if (m) {
    const f = app.files[m[1]];
    if (!f) return send(res, 404, 'Not found');
    const file = app.store.p(f.rel);
    const ext = path.extname(f.name).toLowerCase();
    const inline = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.md', '.json'].includes(ext) && url.searchParams.get('download') !== '1';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-disposition': (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    return fs.createReadStream(file).on('error', () => res.end()).pipe(res);
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveStatic(res, file);
  return serveStatic(res, path.join(PUBLIC, 'index.html'));
});

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
  console.log('\n  Bullpen ' + pkg.version + ' — ' + BASE);
  console.log('  Data:   ' + DATA);
  console.log('  Claude: ' + (info.found ? info.version + ' (' + info.path + ')' : 'NOT FOUND — ' + info.error));
  console.log('');
  if (process.argv.includes('--open')) openBrowser(BASE);
});

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch {}
}

function shutdown() {
  app.runner.shutdown();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
