'use strict';
// Streams a folder as a .tar.gz without holding files in memory. Long or non-ASCII names use PAX
// "path" records (read by every modern tar), so nothing is cut short. Any read error aborts the
// stream, so a broken backup fails loudly instead of downloading as a truncated archive.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');

const BLOCK = 512;

function octal(n, width) { return n.toString(8).padStart(width - 1, '0') + '\0'; }

function header(name, size, mtime, type = '0') {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.max(0, Math.floor(mtime / 1000)), 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function paxRecord(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return len + body;
}

const pad = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

// Wait for room in the stream, but give up if the stream is closed (download cancelled).
async function put(out, buf) {
  if (out.destroyed) throw new Error('cancelled');
  if (out.write(buf)) return;
  await new Promise((resolve, reject) => {
    const done = () => { out.off('drain', onDrain); out.off('close', onClose); };
    const onDrain = () => { done(); resolve(); };
    const onClose = () => { done(); reject(new Error('cancelled')); };
    out.on('drain', onDrain);
    out.on('close', onClose);
  });
}

async function addFile(out, full, name) {
  let st;
  try { st = fs.statSync(full); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const size = st.size;
  const ascii = /^[\x20-\x7e]*$/.test(name);
  if (!ascii || Buffer.byteLength(name) > 100) {
    const rec = Buffer.from(paxRecord('path', name), 'utf8');
    await put(out, header('PaxHeader/' + name.replace(/[^\x20-\x7e]/g, '_').slice(-80), rec.length, st.mtimeMs, 'x'));
    await put(out, rec);
    await put(out, pad(rec.length));
  }
  const shortName = name.replace(/[^\x20-\x7e]/g, '_').slice(-100);
  await put(out, header(shortName, size, st.mtimeMs));
  // Write exactly `size` bytes even if the file changes while we read it.
  let written = 0;
  if (size > 0) {
    for await (const chunk of fs.createReadStream(full, { start: 0, end: size - 1 })) {
      const part = written + chunk.length > size ? chunk.subarray(0, size - written) : chunk;
      written += part.length;
      await put(out, part);
    }
  }
  if (written < size) await put(out, Buffer.alloc(size - written));
  await put(out, pad(size));
}

async function walk(out, dir, rel, skip) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (!rel && skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) await walk(out, full, r, skip);
    else if (e.isFile() && !e.name.endsWith('.tmp')) await addFile(out, full, 'bullpen/' + r);
  }
}

// Pipes a gzipped tar of `dir` into `res`. Resolves when done; rejects (and destroys res) on error.
async function streamBackup(dir, res, skip) {
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(res);
  res.on('close', () => { if (!res.writableFinished) gz.destroy(); });
  try {
    await walk(gz, dir, '', skip);
    await put(gz, Buffer.alloc(BLOCK * 2));
    gz.end();
    await require('stream/promises').finished(res).catch(() => { throw new Error('cancelled'); });
  } catch (e) {
    gz.destroy(e);
    res.destroy(e);
    throw e;
  }
}

module.exports = { streamBackup, paxRecord, put };
