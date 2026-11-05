'use strict';
// Persistence. Everything lives under one data folder as plain JSON / JSONL / Markdown so it
// can be read, backed up and diffed without the app. One Node process owns the folder.
const fs = require('fs');
const path = require('path');

// Everything Bullpen stores is private to the user running it (POSIX modes; Windows relies on
// the user-profile ACLs, which is why the default data folder lives in the home directory).
function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); }

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    ensureDir(this.dir);
    if (process.platform !== 'win32') { try { fs.chmodSync(this.dir, 0o700); } catch {} }
  }

  p(...parts) { return path.join(this.dir, ...parts); }

  exists(rel) { return fs.existsSync(this.p(rel)); }

  readText(rel, fallback = '') {
    try { return fs.readFileSync(this.p(rel), 'utf8'); } catch { return fallback; }
  }

  writeText(rel, text) {
    const file = this.p(rel);
    ensureDir(path.dirname(file));
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    // Windows can refuse a rename while antivirus or an indexer holds the target open.
    for (let i = 0; i < 6; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i === 5) { fs.writeFileSync(file, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} return; }
        sleepSync(40 * (i + 1));
      }
    }
  }

  readJSON(rel, fallback) {
    const raw = this.readText(rel, null);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch {
      // Keep the unreadable file for the user instead of silently overwriting it later.
      try { fs.copyFileSync(this.p(rel), this.p(rel) + '.corrupt-' + Date.now()); } catch {}
      return fallback;
    }
  }

  writeJSON(rel, obj) { this.writeText(rel, JSON.stringify(obj, null, 2) + '\n'); }

  append(rel, obj) {
    const file = this.p(rel);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
  }

  readJSONL(rel) {
    const raw = this.readText(rel, '');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
    }
    return out;
  }

  list(rel) {
    try { return fs.readdirSync(this.p(rel)); } catch { return []; }
  }

  remove(rel) { fs.rmSync(this.p(rel), { recursive: true, force: true }); }

  // Deleting a bot or room moves its folder to data/trash so a mistake can be undone by hand.
  trash(rel) {
    const src = this.p(rel);
    if (!fs.existsSync(src)) return;
    const dest = this.p('trash', path.basename(rel) + '-' + Date.now());
    ensureDir(path.dirname(dest));
    try { fs.renameSync(src, dest); } catch {
      fs.cpSync(src, dest, { recursive: true });
      try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
    }
  }
}

// A channel is one conversation: a bot's direct chat ("dm:<botId>") or a group chat
// ("room:<roomId>"). Messages are appended to one file per month; edits (card answers,
// reactions) are appended to the message's own month as patch records and folded in on load.
// Only the newest month is read until older history is needed, and chats nobody has looked at
// for a while are dropped from memory, so months of history stay cheap on small machines.
const MONTH = /^\d{4}-\d{2}\.jsonl$/;
const IDLE_MS = 10 * 60e3;
const MAX_LOADED = 20000;

class Channels {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
    this.timer = setInterval(() => this.evict(), 60e3);
    this.timer.unref();
  }

  safe(ch) { return String(ch).replace(/[^a-z0-9_-]/gi, '-'); }
  dir(ch) { return path.join('channels', this.safe(ch)); }
  legacy(ch) { return path.join('channels', this.safe(ch) + '.jsonl'); }
  segFile(ch, seg) { return seg === 'legacy' ? this.legacy(ch) : path.join(this.dir(ch), seg + '.jsonl'); }
  month(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  entry(ch) {
    let e = this.cache.get(ch);
    if (!e) {
      const segs = this.store.list(this.dir(ch)).filter((f) => MONTH.test(f)).map((f) => f.slice(0, 7)).sort();
      if (this.store.exists(this.legacy(ch))) segs.unshift('legacy');
      e = { segs, next: segs.length, msgs: [], byId: new Map(), segOf: new Map(), used: Date.now() };
      this.cache.set(ch, e);
      this.loadOlder(ch, e);
    }
    e.used = Date.now();
    return e;
  }

  // Read the next older month into memory. Returns false when there is no older history.
  loadOlder(ch, e) {
    if (e.next <= 0) return false;
    const seg = e.segs[--e.next];
    const msgs = [];
    const patches = [];
    for (const rec of this.store.readJSONL(this.segFile(ch, seg))) {
      if (rec._patch) patches.push(rec);
      else if (rec.id && !e.byId.has(rec.id)) { msgs.push(rec); e.byId.set(rec.id, rec); e.segOf.set(rec.id, seg); }
    }
    for (const p of patches) { const m = e.byId.get(p._patch); if (m) deepAssign(m, p.set || {}); }
    e.msgs = msgs.concat(e.msgs);
    return true;
  }

  load(ch) { return this.entry(ch); }

  add(ch, msg) {
    const e = this.entry(ch);
    const seg = this.month(msg.ts);
    if (!e.segs.includes(seg)) e.segs.push(seg);
    e.msgs.push(msg);
    e.byId.set(msg.id, msg);
    e.segOf.set(msg.id, seg);
    this.store.append(this.segFile(ch, seg), msg);
    return msg;
  }

  get(ch, id, maxOlder = 3) {
    const e = this.entry(ch);
    for (let i = 0; !e.byId.has(id) && i < maxOlder && this.loadOlder(ch, e); i++);
    return e.byId.get(id) || null;
  }

  patch(ch, id, set) {
    const m = this.get(ch, id);
    if (!m) return null;
    const e = this.entry(ch);
    deepAssign(m, set);
    this.store.append(this.segFile(ch, e.segOf.get(id) || this.month(m.ts)), { _patch: id, set });
    return m;
  }

  page(ch, { before, limit = 80 } = {}) {
    const e = this.entry(ch);
    const idx = () => { if (!before) return e.msgs.length; const i = e.msgs.findIndex((m) => m.id === before); return i >= 0 ? i : -1; };
    let end = idx();
    while ((end < 0 || end < limit) && this.loadOlder(ch, e)) end = idx();
    if (end < 0) end = e.msgs.length;
    const start = Math.max(0, end - limit);
    return { messages: e.msgs.slice(start, end), more: start > 0 || e.next > 0 };
  }

  recent(ch, n) {
    const e = this.entry(ch);
    while (e.msgs.length < n && this.loadOlder(ch, e));
    return e.msgs.slice(-n);
  }

  // Move a chat's files to data/trash.
  trash(ch) {
    this.cache.delete(ch);
    this.store.trash(this.dir(ch));
    this.store.trash(this.legacy(ch));
  }

  evict(now = Date.now()) {
    for (const [ch, e] of this.cache) if (now - e.used > IDLE_MS) this.cache.delete(ch);
    let total = 0;
    for (const e of this.cache.values()) total += e.msgs.length;
    if (total <= MAX_LOADED) return;
    for (const [ch] of [...this.cache].sort((a, b) => a[1].used - b[1].used)) {
      total -= this.cache.get(ch).msgs.length;
      this.cache.delete(ch);
      if (total <= MAX_LOADED) break;
    }
  }
}

function deepAssign(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

module.exports = { Store, Channels, ensureDir, deepAssign };
