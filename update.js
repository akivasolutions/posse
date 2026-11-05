#!/usr/bin/env node
'use strict';
// Posse updater. Gets the latest version, keeps your data, then starts Posse.
//   node update.js              update, then start Posse (what update.cmd / update.command run)
//   node update.js --no-start   update only
//   node update.js --check      only say whether an update is available
// A git checkout updates with git. Otherwise the latest code is downloaded from the project's
// GitHub page (the "repository" in package.json), or from POSSE_UPDATE_URL (a .tar.gz).
// Your bots, chats and settings live in the data folder (~/.posse), which an update never touches.
// Only Node's built-in modules are used, so this works even if the rest of the folder is damaged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_FILES = 5000;
// Top-level names an update never replaces or removes.
// Compared without case: Windows and macOS treat ".Git" and ".git" as the same folder.
const KEEP = new Set(['.git', '.update', '.posse-version', '.posse-update.lock', '.posse-update.sock', '.posse-update.sock.gate', 'data', 'node', 'node_modules']);
const kept = (top) => KEEP.has(String(top).toLowerCase());
// A download must contain these to count as Posse.
const REQUIRED = ['package.json', 'server.js', 'update.js', 'lib/app.js', 'public/index.html'];

const say = (s = '') => console.log('  ' + s);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64url');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Records written before the computer last started (a crash, then a reboot) name processes that are
// long gone, even if their numbers now belong to something else.
const beforeBoot = (t) => !Number.isFinite(t) || t < Date.now() - os.uptime() * 1000 - 60e3;
// The address to reach a copy that listens on host (as recorded in server.json or configured).
const reach = (h) => (!h || h === '0.0.0.0' || h === '::' || String(h).toLowerCase() === 'localhost' ? '127.0.0.1' : String(h));
// server.json of a copy that may still be running (not one left behind by a crash before a reboot).
const lastServer = (data) => { const s = readJSON(path.join(data, 'server.json')) || {}; return beforeBoot(s.startedAt) ? {} : s; };

function argVal(argv, name, env) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return (env && process.env[env]) || '';
}

// Same rules as server.js: --data, POSSE_DATA, else ~/.posse (or ./data from versions before 0.2).
function dataDir(app, argv) {
  const d = argVal(argv, 'data', 'POSSE_DATA');
  if (d) return path.resolve(d);
  const home = path.join(os.homedir(), '.posse');
  const old = path.join(app, 'data');
  return !fs.existsSync(path.join(home, 'config.json')) && fs.existsSync(path.join(old, 'config.json')) ? old : home;
}

// ---------------- reading the download (.tar.gz) ----------------

function untar(buf) {
  const str = (b, s, l) => { const x = b.subarray(s, s + l); const z = x.indexOf(0); return (z >= 0 ? x.subarray(0, z) : x).toString('utf8'); };
  const oct = (b, s, l) => { const v = str(b, s, l).trim(); if (v && !/^[0-7]+$/.test(v)) throw new Error('The download is damaged (bad tar header).'); return v ? parseInt(v, 8) : 0; };
  const pax = (data) => {
    const out = {};
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      if (sp < 0) break;
      const len = parseInt(data.subarray(i, sp).toString(), 10);
      if (!(len > 0) || i + len > data.length) break;
      const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
      const eq = rec.indexOf('=');
      if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return out;
  };
  const entries = [];
  let commit = '';
  let next = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== oct(h, 148, 8)) throw new Error('The download is damaged (bad tar header).');
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const size = oct(h, 124, 12);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (data.length < size) throw new Error('The download is incomplete.');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { const g = pax(data); if (/^[0-9a-f]{40,64}$/.test(g.comment || '')) commit = g.comment; continue; }
    if (type === 'x') { next = pax(data); continue; }
    if (type === 'L') { next = { path: str(data, 0, data.length) }; continue; }
    const prefix = str(h, 257, 5) === 'ustar' ? str(h, 345, 155) : '';
    const name = next.path || (prefix ? prefix + '/' : '') + str(h, 0, 100);
    next = {};
    if (type === '5') continue; // folders are made as needed
    if (type !== '0' && type !== '7') continue; // links and devices are never installed
    entries.push({ name, data, mode: oct(h, 100, 8) });
    if (entries.length > MAX_FILES) throw new Error('The download has too many files.');
  }
  return { entries, commit };
}

// Paths inside the archive, minus its top folder ("posse-main/"). Anything that could land
// outside the Posse folder, or that Windows treats specially, rejects the whole download.
function cleanPaths(entries) {
  let top = null;
  const files = [];
  for (const e of entries) {
    const parts = e.name.split('/').filter((x) => x && x !== '.');
    const first = parts.shift();
    if (top === null) top = first;
    if (first !== top || e.name.startsWith('/')) throw new Error('Unexpected file in the download: ' + e.name);
    if (!parts.length) continue;
    for (const p of parts) {
      if (p === '..' || /[\\:*?"<>|\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) throw new Error('Unsafe file name in the download: ' + e.name);
    }
    files.push({ rel: parts.join('/'), data: e.data, mode: e.mode });
  }
  const seen = new Set();
  for (const f of files) {
    const k = f.rel.toLowerCase(); // Windows and macOS folders ignore case
    if (seen.has(k)) throw new Error('Duplicate file in the download: ' + f.rel);
    seen.add(k);
  }
  return files;
}

function checkPosse(files) {
  const have = new Map(files.map((f) => [f.rel, f]));
  for (const r of REQUIRED) if (!have.has(r)) throw new Error('The download is not Posse (no ' + r + ').');
  let pkg;
  try { pkg = JSON.parse(have.get('package.json').data.toString('utf8')); } catch { throw new Error('The download is not Posse (bad package.json).'); }
  if (pkg.name !== 'posse') throw new Error('The download is not Posse (package name "' + pkg.name + '").');
  return pkg;
}

function readArchive(gz) {
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }); } catch (e) { throw new Error('The download is damaged or too large (' + e.message + ').'); }
  const { entries, commit } = untar(tar);
  const files = cleanPaths(entries).filter((f) => !kept(f.rel.split('/')[0]));
  const pkg = checkPosse(files);
  return { files, commit, pkg };
}

// ---------------- downloading ----------------

function source(app, argv) {
  const from = argVal(argv, 'from', 'POSSE_UPDATE_URL');
  if (from) return from;
  const pkg = readJSON(path.join(app, 'package.json')) || {};
  const repo = String((pkg.repository && (pkg.repository.url || pkg.repository)) || '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('No update source. Set POSSE_UPDATE_URL to the address of a .tar.gz of the latest version.');
  return repo + '/archive/refs/heads/main.tar.gz';
}

function fetchNode(url, allowHttp, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad update address: ' + url)); }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return reject(new Error('Refusing to download over ' + u.protocol + ' (use https).'));
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'user-agent': 'posse-updater' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Too many redirects.'));
        return resolve(fetchNode(new URL(res.headers.location, u).href, allowHttp && u.protocol === 'http:', redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error('The download failed (HTTP ' + res.statusCode + ').'), { status: res.statusCode })); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_DOWNLOAD) req.destroy(new Error('The download is too large.')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The download timed out.')));
    req.on('error', reject);
  });
}

// Work networks often inspect HTTPS with their own certificate, which Node doesn't know but
// Windows and curl do. If Node can't download, try curl (built into Windows 10 and macOS).
function fetchCurl(url, allowHttp) {
  const tmp = path.join(os.tmpdir(), 'posse-update-' + crypto.randomBytes(6).toString('hex') + '.tar.gz');
  try {
    execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fsSL', '--max-redirs', '5', '--max-filesize', String(MAX_DOWNLOAD), '--proto', allowHttp ? '=http,https' : '=https', '--proto-redir', allowHttp ? '=http,https' : '=https', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    return fs.readFileSync(tmp);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

async function download(url) {
  const allowHttp = /^http:\/\//i.test(url); // only when someone set an http address on purpose
  try { return await fetchNode(url, allowHttp); } catch (e) {
    if (e.status === 404) throw new Error('Nothing found at ' + url + ' (HTTP 404). Is the repository public?');
    if (e.status) throw e;
    try { return fetchCurl(url, allowHttp); } catch { throw e; }
  }
}

// ---------------- the running Posse ----------------

// Always settles within 3 seconds, even if whatever is on the port sends headers and then stalls.
function request(port, method, p, body, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const fail = { status: 0, json: null };
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const req = http.request({ host, port, method, path: p, agent: false, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (s.length < 65536) s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: res.statusCode, json: j }); });
      res.on('error', () => done(fail));
      res.on('close', () => done(fail));
    });
    const timer = setTimeout(() => { req.destroy(); done(fail); }, 3000);
    req.on('error', () => done(fail));
    req.end(data);
  });
}

function connects(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
// Anything listening on this port on either loopback address (Posse may be on ::1 via "localhost").
const listening = async (port) => (await connects(port, '127.0.0.1')) || (await connects(port, '::1'));


// The Posse using this data folder, if one is running. It must prove it knows the access key,
// and the key itself is never sent, so whatever else might be on the port learns nothing.
async function findRunning(data, argv) {
  const key = (readJSON(path.join(data, 'secret.json')) || {}).accessKey;
  if (!key) return null;
  const last = lastServer(data);
  const tries = [];
  const add = (port, h) => { if (Number.isInteger(port) && port > 0 && port < 65536 && !tries.some((t) => t.port === port && t.host === h)) tries.push({ port, host: h }); };
  add(last.port, reach(last.host)); // exactly where it said it listens (a LAN address too)
  if (String(last.host).toLowerCase() === 'localhost') add(last.port, '::1'); // older builds bound ::1 for it
  add(parseInt(argVal(argv, 'port', 'POSSE_PORT'), 10) || 4747, reach(argVal(argv, 'host', 'POSSE_HOST')));
  add(4747, '127.0.0.1');
  for (const t of tries) {
    const n = crypto.randomBytes(18).toString('base64url');
    const r = await request(t.port, 'GET', '/api/ping?n=' + n, undefined, t.host);
    if (!r.json || typeof r.json.proof !== 'string' || r.json.proof !== hmac(key, 'ping:' + n)) continue;
    if (r.status === 200) return { ...t, key };
    if (r.status === 503 && r.json.closing) return { ...t, key, closing: true }; // already shutting down
  }
  return null;
}

// Stops this data folder's Posse and waits until its process has exited (it stops its bots before
// letting go of the port), so two copies never share the data. Returns false if none was running.
async function stopRunning(data, argv) {
  const run = await findRunning(data, argv);
  if (!run) return false;
  const pid = lastServer(data).pid;
  say(run.closing ? 'Waiting for Posse to finish stopping…' : 'Stopping the running Posse (bots that were working pick up again after the restart)…');
  if (!run.closing) {
    const t = Date.now();
    const r = await request(run.port, 'POST', '/api/stop', { t, sig: hmac(run.key, 'stop:' + t), reason: 'update' }, run.host);
    if (r.status !== 200) throw new Error('Posse did not stop (HTTP ' + r.status + '). Close its window, then run the update again.');
  }
  for (let i = 0; i < 150; i++) {
    const up = (await connects(run.port, run.host)) || (await listening(run.port));
    if (!up && !(Number.isInteger(pid) && pid !== process.pid && alive(pid))) return true;
    await sleep(200);
  }
  throw new Error('Posse is still running. Close its window, then run the update again.');
}

// Before changing any files: stop our Posse, and refuse if something we can't identify holds the
// port Posse will start on (an older Posse, or one using another data folder).
async function clearTheWay(data, argv) {
  if (await stopRunning(data, argv)) return;
  const busy = (port) => new Error('Something else is using port ' + port + '. If it is Posse, close its window, then run the update again. Nothing was changed.');
  const port = parseInt(argVal(argv, 'port', 'POSSE_PORT'), 10) || 4747;
  if (await listening(port)) throw busy(port);
  // A copy that recorded itself in server.json, still alive, and still listening where it said.
  const last = lastServer(data);
  if (Number.isInteger(last.port) && Number.isInteger(last.pid) && last.pid !== process.pid && alive(last.pid) && await connects(last.port, reach(last.host))) throw busy(last.port);
}

// One update at a time in this folder. The lock lives inside the Posse folder, where other
// accounts can't create anything, and the operating system releases it when the updater ends,
// however it ends.
//   Windows: .posse-update.lock opened in exclusive-share mode (a second open gets EBUSY).
//   macOS/Linux: a socket .posse-update.sock that only a running updater answers on; a leftover
//   from a killed updater is taken over, one updater at a time.
// If the lock can't be set up at all (an unusual file system), the update goes ahead without it.
const LOCK_FILE = process.platform === 'win32' ? '.posse-update.lock' : '.posse-update.sock';
const UV_FS_O_EXLOCK = 0x10000000; // libuv: open with exclusive sharing (Windows)
const lockHooks = { listen: (srv, addr, cb) => srv.listen(addr, cb), mkdir: (p) => fs.mkdirSync(p), open: (f, flags) => fs.openSync(f, flags) }; // tests simulate races

function busyError() { return Object.assign(new Error('Another update is already running in this folder. Wait for it to finish.'), { noStart: true }); }
function noLock(e) { say('Note: could not set up the update lock (' + (e.code || e.message) + '); going ahead without it.'); return () => {}; }

async function lockWindows(dir) {
  const f = path.join(dir, LOCK_FILE);
  for (let i = 0; ; i++) {
    try {
      // Read-only access is enough for exclusive sharing, and works on a read-only file too.
      const fd = lockHooks.open(f, fs.constants.O_RDONLY | fs.constants.O_CREAT | UV_FS_O_EXLOCK);
      return () => { try { fs.closeSync(fd); } catch {} };
    } catch (e) {
      if (e.code !== 'EBUSY') return noLock(e);
      if (i >= 15) throw busyError(); // held by another updater (a virus scanner lets go within a second)
      await sleep(100);
    }
  }
}

// The socket is bound by its short relative name from inside the folder, so a deep folder never
// hits the ~104-byte socket path limit (and nothing ever goes to a shared temp folder).
function inFolder(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}
async function lockSocket(dir) {
  const taken = (e) => e.code === 'EADDRINUSE' || e.code === 'EEXIST'; // both mean "someone is there"
  const hold = () => new Promise((resolve, reject) => {
    const srv = net.createServer((c) => c.destroy());
    srv.once('error', reject);
    inFolder(dir, () => lockHooks.listen(srv, LOCK_FILE, () => {
      srv.unref();
      resolve(() => { try { inFolder(dir, () => srv.close()); } catch {} }); // closing removes the socket file
    }));
  });
  const answers = () => new Promise((resolve) => {
    const c = inFolder(dir, () => net.connect(LOCK_FILE));
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await hold(); } catch (e) { if (!taken(e)) return noLock(e); }
    if (await answers()) throw busyError();
    // A leftover from an updater that was killed. Take it over through a "gate" folder that only
    // one updater can create. A gate older than 10 s was left by a crash: remove it, wait, start over.
    const gate = path.join(dir, LOCK_FILE + '.gate');
    try { lockHooks.mkdir(gate); } catch (e) {
      if (e.code !== 'EEXIST') return noLock(e);
      let age = 0;
      try { age = Date.now() - fs.statSync(gate).mtimeMs; } catch {}
      if (age < 10e3) throw busyError();
      try { fs.rmdirSync(gate); } catch {}
      await sleep(300);
      continue;
    }
    try {
      if (await answers()) throw busyError();
      try { fs.unlinkSync(path.join(dir, LOCK_FILE)); } catch (e) { if (e.code !== 'ENOENT') return noLock(e); } // not ours to remove
      try { return await hold(); } catch (e) { if (taken(e)) throw busyError(); return noLock(e); }
    } finally { try { fs.rmdirSync(gate); } catch {} }
  }
  throw busyError();
}

async function lock(app) {
  // The real path, so the same folder reached through a link or another spelling shares one lock.
  let dir = path.resolve(app);
  try { dir = fs.realpathSync.native(dir); } catch {}
  return process.platform === 'win32' ? lockWindows(dir) : lockSocket(dir);
}

// ---------------- installing ----------------

// Windows virus scanners briefly lock new files; retry renames for a few seconds.
function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(a, b); } catch (e) {
      if (i >= 30 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleepSync(100);
    }
  }
}

// Files in the download that differ from what's installed (new or changed), plus installed
// top-level entries the new version no longer has.
function changes(app, files) {
  const changed = files.filter((f) => {
    try { return !fs.readFileSync(path.join(app, f.rel)).equals(f.data); } catch { return true; }
  });
  const tops = [...new Set(files.map((f) => f.rel.split('/')[0]))].filter((t) => !kept(t));
  const before = (readJSON(path.join(app, '.posse-version')) || {}).top;
  const shipped = new Set(tops.map((t) => t.toLowerCase())); // a case-only rename is not a removal
  const gone = (Array.isArray(before) ? before : []).filter((t) => typeof t === 'string' && !shipped.has(t.toLowerCase()) && !kept(t) && !t.includes('/') && !t.includes('\\') && t !== '..' && t !== '.' && fs.existsSync(path.join(app, t)));
  return { changed, tops, gone };
}

// The swap. Every step can be repeated after an interruption: an entry still in .update/new
// hasn't been placed yet (if the old one is still in place, it moves to .update/previous first).
// update.js goes last, so an interrupted update can always be finished by running it again.
const hooks = { rename: renameRetry }; // tests replace this to simulate a locked file
const stageDir = (app) => path.join(app, '.update');
const journalFile = (app) => path.join(app, '.update', 'journal.json');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// Copy to a fresh temporary name (a leftover from an interrupted run, possibly read-only, is removed).
const copyFresh = (src, dest) => { fs.rmSync(dest, { force: true }); fs.copyFileSync(src, dest); };
// Replace dest with src in one step. Windows refuses to replace a read-only file, so clear that first.
function replaceFile(src, dest) {
  if (process.platform === 'win32') { try { fs.chmodSync(dest, 0o666); } catch {} }
  hooks.rename(src, dest);
}
// The name as it is on disk (macOS and Windows match names regardless of case).
const onDisk = (dir, name) => { try { return fs.readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase()); } catch { return undefined; } };

function swapAll(app, plan) {
  const NEW = path.join(stageDir(app), 'new');
  const PREV = path.join(stageDir(app), 'previous');
  for (const t of plan.tops) {
    const staged = path.join(NEW, t);
    if (!fs.existsSync(staged)) continue; // already placed
    const cur = path.join(app, t);
    const back = path.join(PREV, t);
    if (isFile(staged) && isFile(cur) && onDisk(app, t) === t) {
      // Files (server.js, update.js, the launchers…) are replaced in one step, so they are never
      // missing, even if the window closes mid-update. The old one is copied to previous first.
      // (A file renamed only in case takes the two-step path below, or it would keep the old case.)
      if (!fs.existsSync(back)) { copyFresh(cur, back + '.part'); hooks.rename(back + '.part', back); }
      replaceFile(staged, cur);
      continue;
    }
    if (fs.existsSync(cur)) {
      // A backup from an earlier attempt (the old files were put back by hand meanwhile).
      if (fs.existsSync(back)) fs.rmSync(back, { recursive: true, force: true });
      hooks.rename(cur, back);
    }
    hooks.rename(staged, cur);
  }
  for (const t of plan.gone) {
    const cur = path.join(app, t);
    if (fs.existsSync(cur) && !fs.existsSync(path.join(PREV, t))) hooks.rename(cur, path.join(PREV, t));
  }
}

// Undo a partial swap: placed entries go back to .update/new, old ones come back from previous.
function rollBack(app, plan) {
  const NEW = path.join(stageDir(app), 'new');
  const PREV = path.join(stageDir(app), 'previous');
  for (const t of [...plan.gone].reverse()) {
    if (fs.existsSync(path.join(PREV, t)) && !fs.existsSync(path.join(app, t))) hooks.rename(path.join(PREV, t), path.join(app, t));
  }
  for (const t of [...plan.tops].reverse()) {
    const cur = path.join(app, t);
    const staged = path.join(NEW, t);
    const back = path.join(PREV, t);
    if (!fs.existsSync(staged) && fs.existsSync(cur)) {
      if (isFile(cur) && isFile(back)) {
        // A replaced file: keep the new one staged and put the old one back in one step.
        copyFresh(cur, staged + '.part'); hooks.rename(staged + '.part', staged);
        copyFresh(back, back + '.part'); replaceFile(back + '.part', cur);
        continue;
      }
      hooks.rename(cur, staged);
    }
    if (!fs.existsSync(cur) && fs.existsSync(back)) hooks.rename(back, cur);
  }
}

function finishSwap(app, plan) {
  // Every file is in place now. The version note is informational: a failure to write it (a
  // read-only file, say) must not leave the update looking unfinished.
  try {
    const v = path.join(app, '.posse-version');
    fs.writeFileSync(v + '.part', JSON.stringify({ commit: plan.commit || '', top: plan.tops, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    replaceFile(v + '.part', v);
  } catch {}
  fs.rmSync(journalFile(app), { force: true });
  fs.rmSync(path.join(stageDir(app), 'new'), { recursive: true, force: true });
}

const which = (e) => (e.path ? path.basename(e.path) : 'a file') + ' (' + (e.code || e.message) + ')';

// The journal is written (and flushed to disk) before the first rename, so one that can't be read
// means the update stopped before changing anything.
function writeJournal(app, plan) {
  const fd = fs.openSync(journalFile(app), 'w');
  try { fs.writeSync(fd, JSON.stringify(plan)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJournal(app) {
  if (!fs.existsSync(journalFile(app))) return null;
  const plan = readJSON(journalFile(app));
  const ok = plan && Array.isArray(plan.tops) && Array.isArray(plan.gone) &&
    ![...plan.tops, ...plan.gone].some((t) => typeof t !== 'string' || !t || t.includes('/') || t.includes('\\') || t === '.' || t === '..' || kept(t));
  return ok ? plan : 'bad';
}
function clearBadJournal(app) {
  fs.rmSync(journalFile(app), { force: true });
  fs.rmSync(path.join(stageDir(app), 'new'), { recursive: true, force: true });
  say('Cleared an update that was cut off before it changed anything.');
}

// An update that was interrupted (window closed, power cut, a file locked) is finished here.
function recover(app, plan = readJournal(app)) {
  if (plan === 'bad') { clearBadJournal(app); return false; }
  if (!plan) return false;
  say('Finishing an update that was interrupted…');
  try { swapAll(app, plan); } catch (e) {
    throw new Error('Could not finish the interrupted update: ' + which(e) + '. Close any program using the Posse folder (or restart the computer), then run the update again.');
  }
  finishSwap(app, plan);
  say('Done.');
  return true;
}

// Stage the new version next to the old one, write the journal, then swap. If a swap fails, the
// steps already done are undone; if even that fails, the journal stays and the next start or
// update finishes the job.
function install(app, files, commit) {
  const stage = stageDir(app);
  const NEW = path.join(stage, 'new');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(NEW, { recursive: true });
  fs.mkdirSync(path.join(stage, 'previous'), { recursive: true });
  for (const f of files) {
    if (kept(f.rel.split('/')[0])) continue;
    const dest = path.join(NEW, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
    if (process.platform !== 'win32') fs.chmodSync(dest, f.mode & 0o111 ? 0o755 : 0o644);
  }
  const { tops, gone } = changes(app, files);
  const plan = { tops: [...tops.filter((t) => t !== 'update.js'), ...tops.filter((t) => t === 'update.js')], gone, commit: commit || '' };
  writeJournal(app, plan);
  try { swapAll(app, plan); } catch (e) {
    try { rollBack(app, plan); } catch (e2) {
      throw new Error('Could not replace ' + which(e) + ', and could not put the old files back: ' + which(e2) + '. Close any program using the Posse folder, then run the update again; it finishes the update.');
    }
    fs.rmSync(journalFile(app), { force: true });
    throw new Error('Could not replace ' + which(e) + '. Nothing was changed. Close any program using the Posse folder and try again.');
  }
  finishSwap(app, plan);
}

// ---------------- git checkouts ----------------

function isGitCheckout(app) {
  if (!fs.existsSync(path.join(app, '.git'))) return false;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch {
    say('This folder is a git checkout, but git is not installed. Downloading instead.');
    return false;
  }
}

async function updateGit(app, argv, data) {
  const git = (...a) => execFileSync('git', a, { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  say('Checking for updates with git…');
  try { git('fetch', '--quiet'); } catch (e) { throw new Error('git could not reach the repository: ' + String(e.stderr || e.message).trim().split('\n').pop()); }
  let upstream;
  try { upstream = git('rev-parse', '@{u}'); } catch { throw new Error('This git branch has no upstream to update from.'); }
  const head = git('rev-parse', 'HEAD');
  const behind = parseInt(git('rev-list', '--count', 'HEAD..@{u}'), 10) || 0;
  if (!behind) { say('Posse is up to date (' + head.slice(0, 7) + ').'); return false; }
  if (argv.includes('--check')) { say('An update is available (' + behind + ' new change' + (behind === 1 ? '' : 's') + ').'); return false; }
  await clearTheWay(data, argv);
  try { git('merge', '--ff-only', '--quiet', '@{u}'); } catch (e) {
    throw new Error('git could not update this folder (local changes?): ' + String(e.stderr || e.message).trim().split('\n').pop() + ' Posse was not changed.');
  }
  say('Updated ' + head.slice(0, 7) + ' → ' + upstream.slice(0, 7) + '.');
  return true;
}

// ---------------- main ----------------

async function main(argv) {
  const app = __dirname;
  const data = dataDir(app, argv);
  console.log('\n  Posse update');
  const unlock = await lock(app);
  try { return await run(app, data, argv); } finally { unlock(); }
}

async function run(app, data, argv) {
  const pending = readJournal(app);
  if (pending && argv.includes('--check')) {
    say('An update was interrupted. Double-click start (or run the update) to finish it.');
    return false;
  } else if (pending === 'bad') {
    clearBadJournal(app);
  } else if (pending) {
    await clearTheWay(data, argv);
    recover(app, pending);
  }
  if (argv.includes('--finish')) return !argv.includes('--no-start'); // start.cmd after an interrupted update
  if (isGitCheckout(app)) {
    await updateGit(app, argv, data);
  } else {
    const url = source(app, argv);
    say('Downloading the latest version…');
    const { files, commit, pkg } = readArchive(await download(url));
    const { changed, gone } = changes(app, files);
    if (!changed.length && !gone.length) {
      say('Posse is up to date (' + pkg.version + (commit ? ', ' + commit.slice(0, 7) : '') + ').');
    } else if (argv.includes('--check')) {
      say('An update is available (' + pkg.version + (commit ? ', ' + commit.slice(0, 7) : '') + ', ' + changed.length + ' changed file' + (changed.length === 1 ? '' : 's') + ').');
    } else {
      await clearTheWay(data, argv);
      install(app, files, commit);
      say('Updated to ' + pkg.version + (commit ? ' (' + commit.slice(0, 7) + ')' : '') + ': ' + changed.length + ' file' + (changed.length === 1 ? '' : 's') + ' changed. Your data was not touched.');
    }
  }
  return !argv.includes('--check') && !argv.includes('--no-start');
}

if (require.main === module) {
  main(process.argv.slice(2)).then((start) => {
    if (!start) return;
    console.log('');
    require(path.join(__dirname, 'server.js')); // the version now on disk
  }, (e) => {
    console.error('\n  Update failed: ' + e.message + '\n');
    if (process.argv.includes('--check') || process.argv.includes('--no-start')) process.exit(1);
    // Another update is running, or this one is half done: don't start anything.
    if (e.noStart || fs.existsSync(journalFile(__dirname)) || !fs.existsSync(path.join(__dirname, 'server.js'))) process.exit(1);
    console.error('  Starting the version you already have.\n');
    require(path.join(__dirname, 'server.js'));
  });
}

module.exports = { lockHooks, untar, cleanPaths, checkPosse, readArchive, changes, install, recover, rollBack, hooks, lock, request, listening, findRunning, stopRunning, clearTheWay, dataDir, source };
