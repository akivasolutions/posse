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
// Every file Bullpen ships, from this checkout, as archive entries under bullpen-main/.
function repoEntries(edit = {}) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (!rel && ['.git', 'node_modules', 'tasks', 'data', '.update', '.bullpen-version', 'docs'].includes(d.name)) continue;
      if (d.name === '.DS_Store') continue;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push([r, fs.readFileSync(path.join(ROOT, r))]);
    }
  };
  walk('');
  const map = new Map(out);
  for (const [k, v] of Object.entries(edit)) { if (v === null) map.delete(k); else map.set(k, Buffer.from(v)); }
  return [...map].map(([r, d]) => entry('bullpen-main/' + r, d, '0', /\.command$/.test(r) ? 0o755 : 0o644));
}
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const minimal = () => [
  entry('bullpen-main/', '', '5', 0o755),
  entry('bullpen-main/package.json', JSON.stringify({ name: 'bullpen', version: '9.9.9' })),
  entry('bullpen-main/server.js', '// new server'),
  entry('bullpen-main/update.js', '// new updater'),
  entry('bullpen-main/lib/app.js', '// new app'),
  entry('bullpen-main/public/index.html', '<!doctype html>'),
];

test('reads GitHub-style archives: pax commit, long paths, links skipped', () => {
  const long = 'bullpen-main/public/' + 'x'.repeat(120) + '.txt';
  const gz = tarGz([
    ...minimal(),
    entry('PaxHeader', paxRec('path', long), 'x'),
    entry(long.slice(0, 100), 'long one'),
    entry('bullpen-main/link', '', '2'),
  ]);
  const { files, commit, pkg } = U.readArchive(gz);
  assert.strictEqual(commit, SHA);
  assert.strictEqual(pkg.version, '9.9.9');
  assert.ok(files.some((f) => f.rel === long.slice('bullpen-main/'.length) && f.data.toString() === 'long one'));
  assert.ok(!files.some((f) => f.rel === 'link'));
  assert.ok(files.every((f) => !f.rel.startsWith('bullpen-main')));
});

test('rejects archives that are not Bullpen or could write outside the folder', () => {
  const bad = (extra, msg) => assert.throws(() => U.readArchive(tarGz([...minimal(), ...extra])), msg);
  bad([entry('bullpen-main/../evil.js', 'x')], /Unsafe/);
  bad([entry('bullpen-main/lib/a\\..\\b.js', 'x')], /Unsafe/);
  bad([entry('bullpen-main/lib/CON.js', 'x')], /Unsafe/);
  bad([entry('bullpen-main/lib/ads.js:stream', 'x')], /Unsafe/);
  bad([entry('other-top/x.js', 'x')], /Unexpected/);
  bad([entry('bullpen-main/LIB/APP.JS', 'x')], /Duplicate/);
  assert.throws(() => U.readArchive(tarGz(minimal().filter((e) => !e.toString('utf8', 0, 100).includes('server.js')))), /not Bullpen/);
  const notUs = minimal();
  notUs[1] = entry('bullpen-main/package.json', JSON.stringify({ name: 'something-else' }));
  assert.throws(() => U.readArchive(tarGz(notUs)), /not Bullpen/);
  const broken = Buffer.concat(minimal());
  broken[600] ^= 0xff; // inside the second header
  assert.throws(() => U.readArchive(zlib.gzipSync(Buffer.concat([broken, Buffer.alloc(1024)]))), /damaged/);
  assert.throws(() => U.readArchive(Buffer.from('not gzip')), /damaged/);
});

test('install swaps the code, keeps data, .git and old ./data, and can tell when nothing changed', () => {
  const app = tmpDir('bullpen-app-');
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), s); };
  w('server.js', '// old server');
  w('lib/app.js', '// old app');
  w('lib/removed.js', '// gone in the new version');
  w('data/config.json', '{"keep":true}');
  w('.git/HEAD', 'ref: refs/heads/main');
  w('dropped.txt', 'was shipped before');
  w('mine.txt', 'the user put this here');
  fs.writeFileSync(path.join(app, '.bullpen-version'), JSON.stringify({ commit: 'b'.repeat(40), top: ['server.js', 'lib', 'dropped.txt'] }));
  const { files, commit } = U.readArchive(tarGz([...minimal(), entry('bullpen-main/.GIT/hooks/post-merge', 'evil'), entry('bullpen-main/Data/config.json', '{}')]));
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
  const v = JSON.parse(r('.bullpen-version'));
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
    // The updater finds this Bullpen from its data folder and stops it.
    const data = path.join(s.tmp, 'data');
    const found = await U.findRunning(data, []);
    assert.strictEqual(found.port, s.port);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'server.json'), 'utf8')).port, s.port);
    assert.strictEqual(await U.stopRunning(data, []), true);
    assert.strictEqual(await U.findRunning(data, []), null);
    assert.ok(!fs.existsSync(path.join(data, 'server.json')), 'removed on a clean stop');
    const audit = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8');
    assert.match(audit, /"type":"stopped"/);
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
  const app = tmpDir('bullpen-install-');
  for (const e of repoEntries()) {
    const name = e.toString('utf8', 0, 100).replace(/\0.*$/s, '').slice('bullpen-main/'.length);
    const size = parseInt(e.toString('utf8', 124, 135), 8);
    fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
    fs.writeFileSync(path.join(app, name), e.subarray(512, 512 + size));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const gz = tarGz(repoEntries({ 'package.json': JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2), 'NEWFILE.md': 'new in this version' }));
  const srv = http.createServer((req, res) => { if (req.url === '/bullpen.tar.gz') { res.writeHead(200); res.end(gz); } else { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/bullpen.tar.gz';
  const data = tmpDir('bullpen-data-');
  const env = { ...process.env, CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), BULLPEN_UPDATE_URL: url, BULLPEN_DATA: data };
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
    assert.match(up.log, /Stopping the running Bullpen/);
    assert.match(up.log, /Updated to 9\.9\.9 \(aaaaaaa\): 2 files changed/);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    assert.notStrictEqual(running.exitCode, null, 'the running copy stopped\n' + rlog);
    assert.match(rlog, /stopping for an update/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '9.9.9');
    assert.strictEqual(fs.readFileSync(path.join(app, 'NEWFILE.md'), 'utf8'), 'new in this version');
    assert.strictEqual(fs.readFileSync(path.join(data, 'marker.txt'), 'utf8'), 'mine');
    assert.ok(fs.existsSync(path.join(data, 'config.json')));
    const again = await run(['--no-start']);
    assert.match(again.log, /up to date \(9\.9\.9, aaaaaaa\)/, again.log);
    assert.strictEqual(await U.stopRunning(data, []), false, 'nothing left to stop');
  } finally {
    running.kill();
    srv.close();
  }
});
