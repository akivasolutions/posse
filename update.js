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
const KEEP = new Set(['.git', '.update', '.posse-version', 'data', 'node', 'node_modules']);
const kept = (top) => KEEP.has(String(top).toLowerCase());
// A download must contain these to count as Posse.
const REQUIRED = ['package.json', 'server.js', 'update.js', 'lib/app.js', 'public/index.html'];

const say = (s = '') => console.log('  ' + s);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64url');

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

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 3000, agent: false, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (s.length < 65536) s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end(data);
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

// The Posse using this data folder, if one is running. It must prove it knows the access key,
// and the key itself is never sent, so whatever else might be on the port learns nothing.
async function findRunning(data, argv) {
  const key = (readJSON(path.join(data, 'secret.json')) || {}).accessKey;
  if (!key) return null;
  const ports = [(readJSON(path.join(data, 'server.json')) || {}).port, parseInt(argVal(argv, 'port', 'POSSE_PORT'), 10), 4747];
  for (const port of [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))]) {
    const n = crypto.randomBytes(18).toString('base64url');
    const r = await request(port, 'GET', '/api/ping?n=' + n);
    if (r.status === 200 && r.json && typeof r.json.proof === 'string' && r.json.proof === hmac(key, 'ping:' + n)) return { port, key };
  }
  return null;
}

async function stopRunning(data, argv) {
  const run = await findRunning(data, argv);
  if (!run) {
    const port = parseInt(argVal(argv, 'port', 'POSSE_PORT'), 10) || 4747;
    if (await listening(port)) say('Note: something is using port ' + port + '. If it is an older Posse, close its window before it starts again.');
    return false;
  }
  say('Stopping the running Posse (bots that were working pick up again after the restart)…');
  const t = Date.now();
  const r = await request(run.port, 'POST', '/api/stop', { t, sig: hmac(run.key, 'stop:' + t), reason: 'update' });
  if (r.status !== 200) throw new Error('Posse did not stop (HTTP ' + r.status + '). Close its window, then run the update again.');
  for (let i = 0; i < 150; i++) {
    if (!(await listening(run.port))) return true;
    await sleep(200);
  }
  throw new Error('Posse is still running. Close its window, then run the update again.');
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
  const gone = (Array.isArray(before) ? before : []).filter((t) => typeof t === 'string' && !tops.includes(t) && !kept(t) && !t.includes('/') && !t.includes('\\') && t !== '..' && t !== '.' && fs.existsSync(path.join(app, t)));
  return { changed, tops, gone };
}

// Stage the new version next to the old one, then swap each top-level entry with a rename.
// If any swap fails, the ones already done are put back. The old version is kept in
// .update/previous until the next update.
function install(app, files, commit) {
  const stage = path.join(app, '.update');
  const NEW = path.join(stage, 'new');
  const PREV = path.join(stage, 'previous');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(NEW, { recursive: true });
  fs.mkdirSync(PREV, { recursive: true });
  for (const f of files) {
    if (kept(f.rel.split('/')[0])) continue;
    const dest = path.join(NEW, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
    if (process.platform !== 'win32') fs.chmodSync(dest, f.mode & 0o111 ? 0o755 : 0o644);
  }
  const { tops, gone } = changes(app, files);
  const done = [];
  try {
    for (const t of [...tops, ...gone]) {
      const cur = path.join(app, t);
      if (fs.existsSync(cur)) { renameRetry(cur, path.join(PREV, t)); done.push(['moved', t]); }
      if (tops.includes(t)) { renameRetry(path.join(NEW, t), cur); done.push(['placed', t]); }
    }
  } catch (e) {
    for (const [what, t] of done.reverse()) {
      try {
        if (what === 'placed') renameRetry(path.join(app, t), path.join(NEW, t));
        else renameRetry(path.join(PREV, t), path.join(app, t));
      } catch {}
    }
    throw new Error('Could not replace ' + (e.path ? path.basename(e.path) : 'a file') + ' (' + e.code + '). Nothing was changed. Close any program using the Posse folder and try again.');
  }
  fs.writeFileSync(path.join(app, '.posse-version'), JSON.stringify({ commit: commit || '', top: tops, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.rmSync(NEW, { recursive: true, force: true });
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
  await stopRunning(data, argv);
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
      await stopRunning(data, argv);
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
    console.error('  Starting the version you already have.\n');
    require(path.join(__dirname, 'server.js'));
  });
}

module.exports = { untar, cleanPaths, checkPosse, readArchive, changes, install, findRunning, stopRunning, dataDir, source };
