'use strict';
// The updater (update.js) and the server's start/stop controls it relies on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const U = require('../update');
const { startServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const SHA = 'a'.repeat(40);
const realRename = U.hooks.rename;

// A minimal tar writer (ustar + pax), enough to build test archives.
function entry(name, data = Buffer.alloc(0), type = '0', mode = 0o644) {
  data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function paxRec(k, v) {
  const body = ' ' + k + '=' + v + '\n';
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return len + body;
}
function tarGz(parts, commit = SHA) {
  const head = commit ? [entry('pax_global_header', paxRec('comment', commit), 'g')] : [];
  return zlib.gzipSync(Buffer.concat([...head, ...parts, Buffer.alloc(1024)]));
}
// Every file Posse ships, from this checkout, as archive entries under posse-main/.
function repoEntries(edit = {}) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (!rel && ['.git', 'node_modules', 'tasks', 'data', '.update', '.posse-version', 'docs'].includes(d.name)) continue;
      if (d.name === '.DS_Store') continue;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push([r, fs.readFileSync(path.join(ROOT, r))]);
    }
  };
  walk('');
  const map = new Map(out);
  for (const [k, v] of Object.entries(edit)) { if (v === null) map.delete(k); else map.set(k, Buffer.from(v)); }
  return [...map].map(([r, d]) => entry('posse-main/' + r, d, '0', /\.command$/.test(r) ? 0o755 : 0o644));
}
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const minimal = () => [
  entry('posse-main/', '', '5', 0o755),
  entry('posse-main/package.json', JSON.stringify({ name: 'posse', version: '9.9.9' })),
  entry('posse-main/server.js', '// new server'),
  entry('posse-main/update.js', '// new updater'),
  entry('posse-main/lib/app.js', '// new app'),
  entry('posse-main/public/index.html', '<!doctype html>'),
];

test('reads GitHub-style archives: pax commit, long paths, links skipped', () => {
  const long = 'posse-main/public/' + 'x'.repeat(120) + '.txt';
  const gz = tarGz([
    ...minimal(),
    entry('PaxHeader', paxRec('path', long), 'x'),
    entry(long.slice(0, 100), 'long one'),
    entry('posse-main/link', '', '2'),
  ]);
  const { files, commit, pkg } = U.readArchive(gz);
  assert.strictEqual(commit, SHA);
  assert.strictEqual(pkg.version, '9.9.9');
  assert.ok(files.some((f) => f.rel === long.slice('posse-main/'.length) && f.data.toString() === 'long one'));
  assert.ok(!files.some((f) => f.rel === 'link'));
  assert.ok(files.every((f) => !f.rel.startsWith('posse-main')));
});

test('rejects archives that are not Posse or could write outside the folder', () => {
  const bad = (extra, msg) => assert.throws(() => U.readArchive(tarGz([...minimal(), ...extra])), msg);
  bad([entry('posse-main/../evil.js', 'x')], /Unsafe/);
  bad([entry('posse-main/lib/a\\..\\b.js', 'x')], /Unsafe/);
  bad([entry('posse-main/lib/CON.js', 'x')], /Unsafe/);
  bad([entry('posse-main/lib/ads.js:stream', 'x')], /Unsafe/);
  bad([entry('other-top/x.js', 'x')], /Unexpected/);
  bad([entry('posse-main/LIB/APP.JS', 'x')], /Duplicate/);
  assert.throws(() => U.readArchive(tarGz(minimal().filter((e) => !e.toString('utf8', 0, 100).includes('server.js')))), /not Posse/);
  const notUs = minimal();
  notUs[1] = entry('posse-main/package.json', JSON.stringify({ name: 'something-else' }));
  assert.throws(() => U.readArchive(tarGz(notUs)), /not Posse/);
  const broken = Buffer.concat(minimal());
  broken[600] ^= 0xff; // inside the second header
  assert.throws(() => U.readArchive(zlib.gzipSync(Buffer.concat([broken, Buffer.alloc(1024)]))), /damaged/);
  assert.throws(() => U.readArchive(Buffer.from('not gzip')), /damaged/);
});

test('install swaps the code, keeps data, .git and old ./data, and can tell when nothing changed', () => {
  const app = tmpDir('posse-app-');
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), s); };
  w('server.js', '// old server');
  w('lib/app.js', '// old app');
  w('lib/removed.js', '// gone in the new version');
  w('data/config.json', '{"keep":true}');
  w('.git/HEAD', 'ref: refs/heads/main');
  w('dropped.txt', 'was shipped before');
  w('mine.txt', 'the user put this here');
  fs.writeFileSync(path.join(app, '.posse-version'), JSON.stringify({ commit: 'b'.repeat(40), top: ['server.js', 'lib', 'dropped.txt'] }));
  const { files, commit } = U.readArchive(tarGz([...minimal(), entry('posse-main/.GIT/hooks/post-merge', 'evil'), entry('posse-main/Data/config.json', '{}')]));
  assert.ok(!files.some((f) => /^(\.git|data)\//i.test(f.rel)), 'kept folders are dropped from the download, whatever their case');
  const before = U.changes(app, files);
  assert.ok(before.changed.length >= 4);
  assert.deepStrictEqual(before.gone, ['dropped.txt']);
  U.install(app, files, commit);
  const r = (rel) => fs.readFileSync(path.join(app, rel), 'utf8');
  assert.strictEqual(r('server.js'), '// new server');
  assert.strictEqual(r('lib/app.js'), '// new app');
  assert.ok(!fs.existsSync(path.join(app, 'lib/removed.js')));
  assert.ok(!fs.existsSync(path.join(app, 'dropped.txt')));
  assert.strictEqual(r('.update/previous/lib/removed.js'), '// gone in the new version');
  assert.strictEqual(r('data/config.json'), '{"keep":true}');
  assert.strictEqual(r('.git/HEAD'), 'ref: refs/heads/main');
  assert.ok(!fs.existsSync(path.join(app, '.git/hooks')));
  assert.strictEqual(r('mine.txt'), 'the user put this here');
  const v = JSON.parse(r('.posse-version'));
  assert.strictEqual(v.commit, SHA);
  assert.ok(v.top.includes('lib') && v.top.includes('public'));
  const after = U.changes(app, files);
  assert.strictEqual(after.changed.length, 0);
  assert.strictEqual(after.gone.length, 0);
});

test('ping and stop: proof of the key without sending it; stop is signed and fresh', async () => {
  const s = await startServer();
  try {
    const key = s.secret.accessKey;
    const hm = (m) => crypto.createHmac('sha256', key).update(m).digest('base64url');
    const n = crypto.randomBytes(18).toString('base64url');
    const ping = await fetch(s.base + '/api/ping?n=' + n).then((r) => r.json());
    assert.strictEqual(ping.proof, hm('ping:' + n));
    assert.ok(!JSON.stringify(ping).includes(key));
    assert.strictEqual((await fetch(s.base + '/api/ping?n=short')).status, 400);
    const post = (b) => fetch(s.base + '/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.strictEqual((await post({ t: Date.now(), sig: 'wrong' })).status, 403);
    const old = Date.now() - 120e3;
    assert.strictEqual((await post({ t: old, sig: hm('stop:' + old) })).status, 403, 'stale');
    assert.strictEqual((await fetch(s.base + '/api/stop', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.strictEqual((await post(null)).status, 403);
    // The updater finds this Posse from its data folder and stops it.
    const data = path.join(s.tmp, 'data');
    const found = await U.findRunning(data, []);
    assert.strictEqual(found.port, s.port);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'server.json'), 'utf8')).port, s.port);
    const t1 = Date.now();
    assert.strictEqual(await U.stopRunning(data, []), true);
    assert.strictEqual(await U.findRunning(data, []), null);
    assert.ok(!fs.existsSync(path.join(data, 'server.json')), 'removed on a clean stop');
    const audit = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8');
    assert.match(audit, /"type":"stopped"/);
    // A stop request signed before a restart is refused by the restarted copy.
    const s2 = await startServer({ tmp: s.tmp });
    try {
      const replay = await fetch(s2.base + '/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: t1, sig: hm('stop:' + t1) }) });
      assert.strictEqual(replay.status, 403);
      assert.strictEqual((await s2.api('GET', '/api/state')).status, 200, 'still running');
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

test('starting a second copy on the same data opens the running one and touches nothing', async () => {
  const s = await startServer();
  try {
    const data = path.join(s.tmp, 'data');
    const cfg = path.join(data, 'config.json');
    const before = fs.statSync(cfg).mtimeMs;
    const pend = fs.existsSync(path.join(data, 'pending.json')) ? fs.readFileSync(path.join(data, 'pending.json'), 'utf8') : null;
    await new Promise((r) => setTimeout(r, 30));
    const other = 40000 + Math.floor(Math.random() * 20000);
    for (const port of [s.port, other]) {
      const out = await new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port), '--data', data], { env: { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js') }, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        c.stdout.on('data', (d) => { log += d; });
        c.stderr.on('data', (d) => { log += d; });
        const t = setTimeout(() => c.kill(), 8000);
        c.on('exit', (code) => { clearTimeout(t); resolve({ code, log }); });
      });
      assert.strictEqual(out.code, 0, out.log);
      assert.match(out.log, /already running/);
      assert.ok(out.log.includes('127.0.0.1:' + s.port + '/#key='), 'points at the running copy');
    }
    assert.strictEqual(fs.statSync(cfg).mtimeMs, before, 'config was not rewritten');
    if (pend !== null) assert.strictEqual(fs.readFileSync(path.join(data, 'pending.json'), 'utf8'), pend);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'server.json'), 'utf8')).port, s.port);
    const st = await s.api('GET', '/api/state');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.data.version, require('../package.json').version);
  } finally { await s.stop(); }
});

test('full update: downloads, stops the running copy, swaps files, keeps data; then says up to date', async () => {
  // A copy of this checkout without .git, like a ZIP download.
  const app = tmpDir('posse-install-');
  for (const e of repoEntries()) {
    const name = e.toString('utf8', 0, 100).replace(/\0.*$/s, '').slice('posse-main/'.length);
    const size = parseInt(e.toString('utf8', 124, 135), 8);
    fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
    fs.writeFileSync(path.join(app, name), e.subarray(512, 512 + size));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const gz = tarGz(repoEntries({ 'package.json': JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2), 'NEWFILE.md': 'new in this version' }));
  const srv = http.createServer((req, res) => { if (req.url === '/posse.tar.gz') { res.writeHead(200); res.end(gz); } else { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/posse.tar.gz';
  const data = tmpDir('posse-data-');
  const env = { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), POSSE_UPDATE_URL: url, POSSE_DATA: data };
  const port = 40000 + Math.floor(Math.random() * 20000);
  const running = spawn(process.execPath, [path.join(app, 'server.js'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let rlog = '';
  running.stdout.on('data', (d) => { rlog += d; });
  running.stderr.on('data', (d) => { rlog += d; });
  const exited = new Promise((r) => running.on('exit', r));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'server.json')); i++) await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(data, 'marker.txt'), 'mine');
    const run = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(app, 'update.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      c.stdout.on('data', (d) => { log += d; });
      c.stderr.on('data', (d) => { log += d; });
      c.on('exit', (code) => resolve({ code, log }));
    });
    const chk = await run(['--check']);
    assert.strictEqual(chk.code, 0, chk.log);
    assert.match(chk.log, /An update is available \(9\.9\.9, aaaaaaa, 2 changed files\)/);
    const up = await run(['--no-start']);
    assert.strictEqual(up.code, 0, up.log);
    assert.match(up.log, /Stopping the running Posse/);
    assert.match(up.log, /Updated to 9\.9\.9 \(aaaaaaa\): 2 files changed/);
    // The updater waits for the old process itself to exit before touching files or starting.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
    assert.ok(running.exitCode !== null || running.signalCode !== null, 'the running copy had exited\n' + rlog);
    assert.match(rlog, /stopping for an update/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '9.9.9');
    assert.strictEqual(fs.readFileSync(path.join(app, 'NEWFILE.md'), 'utf8'), 'new in this version');
    assert.strictEqual(fs.readFileSync(path.join(data, 'marker.txt'), 'utf8'), 'mine');
    assert.ok(fs.existsSync(path.join(data, 'config.json')));
    const again = await run(['--no-start']);
    assert.match(again.log, /up to date \(9\.9\.9, aaaaaaa\)/, again.log);
    assert.strictEqual(await U.stopRunning(data, []), false, 'nothing left to stop');
    // Cut off the next update mid-swap, then let the real updater finish it, as start.cmd does.
    const next = U.readArchive(tarGz(repoEntries({ 'package.json': JSON.stringify({ ...pkg, version: '9.9.10' }, null, 2), 'NEWFILE.md': 'v10' }), 'b'.repeat(40)));
    let n = 0;
    U.hooks.rename = (a, b) => { if (++n > 3) throw Object.assign(new Error('killed'), { code: 'EINTR' }); return realRename(a, b); };
    try { assert.throws(() => U.install(app, next.files, next.commit), /run the update again/); } finally { U.hooks.rename = realRename; }
    assert.ok(fs.existsSync(path.join(app, '.update', 'journal.json')));
    const chk2 = await run(['--check']);
    assert.match(chk2.log, /An update was interrupted/, 'only reported');
    assert.ok(fs.existsSync(path.join(app, '.update', 'journal.json')));
    const direct = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(app, 'server.js'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      c.stdout.on('data', (d) => { log += d; });
      c.stderr.on('data', (d) => { log += d; });
      c.on('exit', (code) => resolve({ code, log }));
    });
    assert.strictEqual(direct.code, 1);
    assert.match(direct.log, /update of Posse was interrupted.*--finish/s, 'server.js will not start a half-updated folder');
    const fin = await run(['--finish', '--no-start']);
    assert.strictEqual(fin.code, 0, fin.log);
    assert.match(fin.log, /Finishing an update that was interrupted/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '9.9.10');
    assert.strictEqual(fs.readFileSync(path.join(app, 'NEWFILE.md'), 'utf8'), 'v10');
    assert.ok(!fs.existsSync(path.join(app, '.update', 'journal.json')));
    // Another update holding the lock: this one starts nothing at all.
    fs.writeFileSync(path.join(app, '.update.lock'), String(process.pid));
    const locked = await run([]);
    fs.rmSync(path.join(app, '.update.lock'), { force: true });
    assert.strictEqual(locked.code, 1, locked.log);
    assert.match(locked.log, /Another update is already running/);
    assert.doesNotMatch(locked.log, /Starting the version|open this link/);
    // A journal that can't be read (cut off while being written) is cleared without stopping anything.
    fs.mkdirSync(path.join(app, '.update'), { recursive: true });
    fs.writeFileSync(path.join(app, '.update', 'journal.json'), '');
    const bad = await run(['--finish', '--no-start']);
    assert.strictEqual(bad.code, 0, bad.log);
    assert.match(bad.log, /Cleared an update that was cut off before it changed anything/);
    assert.doesNotMatch(bad.log, /Stopping/);
    assert.ok(!fs.existsSync(path.join(app, '.update', 'journal.json')));
  } finally {
    running.kill();
    srv.close();
  }
});

// An app folder with an old version, and an archive of a new one, for the swap tests.
function swapFixture() {
  const app = tmpDir('posse-swap-');
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), txt); };
  w('package.json', JSON.stringify({ name: 'posse', version: '1.0.0' }));
  w('server.js', '// old server');
  w('update.js', '// old updater');
  w('lib/app.js', '// old app');
  w('public/index.html', 'old page');
  w('README.md', 'old readme');
  w('Docs/guide.md', 'old guide');
  w('data/config.json', '{"keep":true}');
  fs.writeFileSync(path.join(app, '.posse-version'), JSON.stringify({ commit: '', top: ['package.json', 'server.js', 'update.js', 'lib', 'public', 'README.md', 'Docs'] }));
  const { files, commit } = U.readArchive(tarGz([...minimal(), entry('posse-main/Readme.md', 'new readme'), entry('posse-main/docs/guide.md', 'new guide')]));
  const r = (rel) => { try { return fs.readFileSync(path.join(app, rel), 'utf8'); } catch { return null; } };
  return { app, files, commit, r };
}

test('a top-level entry renamed only in case is replaced, not lost', () => {
  const { app, files, commit, r } = swapFixture();
  assert.deepStrictEqual(U.changes(app, files).gone, [], 'Readme.md and docs replace README.md and Docs');
  U.install(app, files, commit);
  const names = fs.readdirSync(app);
  assert.ok(names.includes('Readme.md') && !names.includes('README.md') || process.platform === 'linux', names.join(','));
  assert.strictEqual(r('Readme.md'), 'new readme');
  assert.strictEqual(r('docs/guide.md'), 'new guide');
  assert.strictEqual(r('server.js'), '// new server');
  assert.strictEqual(r('data/config.json'), '{"keep":true}');
});

test('a locked file: the update is undone and says so; if undoing fails too, the next run finishes it', () => {
  // 1. The swap fails partway and the undo works: everything is as before.
  let f = swapFixture();
  U.hooks.rename = (a, b) => { if (path.basename(a) === 'public' && a.includes(path.sep + 'new' + path.sep)) throw Object.assign(new Error('busy'), { code: 'EBUSY', path: a }); return realRename(a, b); };
  try {
    assert.throws(() => U.install(f.app, f.files, f.commit), /Could not replace public \(EBUSY\)\. Nothing was changed/);
  } finally { U.hooks.rename = realRename; }
  assert.strictEqual(f.r('server.js'), '// old server');
  assert.strictEqual(f.r('public/index.html'), 'old page');
  assert.strictEqual(f.r('lib/app.js'), '// old app');
  assert.ok(!fs.existsSync(path.join(f.app, '.update', 'journal.json')));

  // 2. The swap fails and so does the undo: the message is honest and the journal stays.
  f = swapFixture();
  let failing = true;
  const inNew = (x) => x.includes(path.sep + '.update' + path.sep + 'new');
  // Placing public fails; then putting the old server.js back fails too.
  U.hooks.rename = (a, b) => {
    if (failing && ((path.basename(a) === 'public' && inNew(a)) || (b === path.join(f.app, 'server.js') && a.includes(path.sep + 'previous' + path.sep)))) throw Object.assign(new Error('busy'), { code: 'EBUSY', path: b });
    return realRename(a, b);
  };
  try {
    assert.throws(() => U.install(f.app, f.files, f.commit), /could not put the old files back.*run the update again/);
  } finally { U.hooks.rename = realRename; }
  assert.ok(fs.existsSync(path.join(f.app, '.update', 'journal.json')), 'journal kept');
  // 3. The next run finishes the update from the journal, without downloading anything.
  failing = false;
  assert.strictEqual(U.recover(f.app), true);
  assert.strictEqual(f.r('server.js'), '// new server');
  assert.strictEqual(f.r('public/index.html'), '<!doctype html>');
  assert.strictEqual(f.r('update.js'), '// new updater');
  assert.strictEqual(f.r('data/config.json'), '{"keep":true}');
  assert.ok(!fs.existsSync(path.join(f.app, '.update', 'journal.json')));
  assert.strictEqual(JSON.parse(f.r('.posse-version')).commit, SHA);
  assert.strictEqual(U.recover(f.app), false, 'nothing left to finish');
});

test('an update cut off mid-swap (window closed) is finished on the next run', async () => {
  const f = swapFixture();
  // Simulate the window closing after the third rename: stage and journal as install does, then stop.
  let n = 0;
  U.hooks.rename = (a, b) => { if (++n > 3) throw Object.assign(new Error('killed'), { code: 'EINTR' }); return realRename(a, b); };
  try { assert.throws(() => U.install(f.app, f.files, f.commit)); } catch {} finally { U.hooks.rename = realRename; }
  // install's own undo also hit the "kill", so the journal is left for the next start to finish.
  assert.ok(fs.existsSync(path.join(f.app, '.update', 'journal.json')));
  // Top-level files are replaced in one step, so they are never missing, even half way.
  for (const file of ['server.js', 'update.js', 'package.json']) assert.ok(fs.existsSync(path.join(f.app, file)), file + ' present');
  assert.strictEqual(U.recover(f.app), true);
  for (const [rel, want] of [['server.js', '// new server'], ['lib/app.js', '// new app'], ['update.js', '// new updater'], ['public/index.html', '<!doctype html>']]) assert.strictEqual(f.r(rel), want, rel);
});

test('probes settle even when the port answers headers and then stalls', async () => {
  const hang = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await U.request(hang.address().port, 'GET', '/api/ping?n=' + 'x'.repeat(20));
    assert.strictEqual(r.status, 0);
    assert.ok(Date.now() - t0 < 4500, 'gave up after about 3 s');
    // A data folder whose server.json points at the stalled port: start says so instead of quietly exiting.
    const data = tmpDir('posse-hang-');
    fs.writeFileSync(path.join(data, 'secret.json'), JSON.stringify({ accessKey: 'k'.repeat(24) }));
    fs.writeFileSync(path.join(data, 'server.json'), JSON.stringify({ port: hang.address().port, pid: 1 }));
    assert.strictEqual(await U.findRunning(data, ['--port', String(hang.address().port)]), null);
    await assert.rejects(U.clearTheWay(data, ['--port', String(hang.address().port)]), /Something else is using port .*Nothing was changed/);
    const port = 40000 + Math.floor(Math.random() * 20000);
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port), '--data', data], { env: { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      c.stdout.on('data', (d) => { log += d; if (/sign in/.test(log)) c.kill(); });
      c.stderr.on('data', (d) => { log += d; });
      setTimeout(() => c.kill(), 10000);
      c.on('exit', () => resolve(log));
    });
    assert.match(out, /open this link to sign in/, 'started normally after the probe gave up');
  } finally { hang.close(); hang.closeAllConnections && hang.closeAllConnections(); }
});

test('one update at a time; a lock left by a closed update is taken over', () => {
  const app = tmpDir('posse-lock-');
  const unlock = U.lock(app);
  // Another process holding the lock (this test runner's parent is alive).
  fs.writeFileSync(path.join(app, '.update.lock'), String(process.ppid));
  assert.throws(() => U.lock(app), /Another update is already running/);
  // A lock from a process that no longer exists.
  fs.writeFileSync(path.join(app, '.update.lock'), '999999');
  const again = U.lock(app);
  assert.strictEqual(fs.readFileSync(path.join(app, '.update.lock'), 'utf8'), String(process.pid));
  again();
  assert.ok(!fs.existsSync(path.join(app, '.update.lock')));
  unlock();
});

test('recovery still works after the old files were put back by hand', () => {
  const f = swapFixture();
  let n = 0;
  // Stop right after lib was moved aside (before the new lib was placed); the undo fails as well.
  U.hooks.rename = (a, b) => { if (++n > 5) throw Object.assign(new Error('killed'), { code: 'EINTR' }); return realRename(a, b); };
  try { assert.throws(() => U.install(f.app, f.files, f.commit)); } finally { U.hooks.rename = realRename; }
  assert.ok(!fs.existsSync(path.join(f.app, 'lib')) && fs.existsSync(path.join(f.app, '.update', 'previous', 'lib')), 'lib moved aside');
  fs.cpSync(path.join(f.app, '.update', 'previous', 'lib'), path.join(f.app, 'lib'), { recursive: true }); // the user restored it
  assert.strictEqual(U.recover(f.app), true);
  assert.strictEqual(f.r('lib/app.js'), '// new app');
  assert.strictEqual(f.r('server.js'), '// new server');
  assert.ok(!fs.existsSync(path.join(f.app, '.update', 'journal.json')));
});

test('a Posse bound to "localhost" is found and stopped through server.json', async () => {
  const data = tmpDir('posse-lh-');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const c = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--host', 'localhost', '--port', String(port), '--data', data], { env: { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js') }, stdio: 'ignore' });
  const exited = new Promise((r) => c.on('exit', r));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'server.json')); i++) await new Promise((r) => setTimeout(r, 100));
    const found = await U.findRunning(data, []);
    assert.ok(found && found.port === port && found.host === 'localhost', JSON.stringify(found));
    assert.strictEqual(await U.stopRunning(data, []), true);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
    assert.ok(c.exitCode !== null || c.signalCode !== null);
  } finally { c.kill(); }
});

test('a restart during shutdown waits for the old copy, and no bot outlives it', { skip: process.platform === 'win32' && 'needs a graceful signal' }, async () => {
  const s = await startServer();
  try {
    const chief = (await s.api('GET', '/api/state')).data.bots.find((b) => b.primary);
    await s.api('POST', '/api/channels/dm:' + chief.id + '/messages', { text: 'stuck\n@@ignore-term\n@@sleep 30000' });
    await s.waitFor(() => s.calls().length >= 1, 10000, 'the bot to start');
    await new Promise((r) => setTimeout(r, 300)); // let it install its SIGTERM handler
    const botPid = s.calls()[0].pid;
    process.kill(s.pid, 'SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    // The dying copy says it is closing (with a proof), not "here I am".
    const n = crypto.randomBytes(18).toString('base64url');
    const ping = await fetch(s.base + '/api/ping?n=' + n);
    assert.strictEqual(ping.status, 503);
    assert.strictEqual((await ping.json()).closing, true);
    // A copy started now waits, then starts for real.
    const t0 = Date.now();
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(s.port), '--data', path.join(s.tmp, 'data')], { env: { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), FAKE_CLAUDE_DIR: path.join(s.tmp, 'fake2') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      c.stdout.on('data', (d) => { log += d; if (/sign in/.test(log)) { c.kill(); } });
      c.stderr.on('data', (d) => { log += d; });
      setTimeout(() => c.kill(), 20000);
      c.on('exit', () => resolve(log));
    });
    assert.match(out, /open this link to sign in/, out);
    assert.doesNotMatch(out, /already running/);
    assert.ok(Date.now() - t0 > 2000, 'it waited for the old copy');
    let botAlive = true;
    try { process.kill(botPid, 0); } catch { botAlive = false; }
    assert.strictEqual(botAlive, false, 'the stuck bot was killed with the old copy');
  } finally { await s.stop(); }
});
