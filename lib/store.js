'use strict';
// Persistence. Everything lives under one data folder as plain JSON / JSONL / Markdown so it
// can be read, backed up and diffed without the app. One Node process owns the folder.
const fs = require('fs');
const path = require('path');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    ensureDir(this.dir);
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
    fs.writeFileSync(tmp, text);
    // Windows can refuse a rename while antivirus or an indexer holds the target open.
    for (let i = 0; i < 6; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i === 5) { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch {} return; }
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
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
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
    try { fs.renameSync(src, dest); } catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
  }
}

// A channel is one conversation: a bot's direct chat ("dm:<botId>") or a group chat
// ("room:<roomId>"). Messages are appended; edits (card answers, reactions) are appended
// as patch records and folded in on load, so the file never needs rewriting.
class Channels {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }

  file(ch) { return path.join('channels', ch.replace(/[^a-z0-9_-]/gi, '-') + '.jsonl'); }

  load(ch) {
    if (this.cache.has(ch)) return this.cache.get(ch);
    const msgs = [];
    const byId = new Map();
    for (const rec of this.store.readJSONL(this.file(ch))) {
      if (rec._patch) {
        const m = byId.get(rec._patch);
        if (m) deepAssign(m, rec.set || {});
      } else if (rec.id) {
        msgs.push(rec);
        byId.set(rec.id, rec);
      }
    }
    const entry = { msgs, byId };
    this.cache.set(ch, entry);
    return entry;
  }

  add(ch, msg) {
    const entry = this.load(ch);
    entry.msgs.push(msg);
    entry.byId.set(msg.id, msg);
    this.store.append(this.file(ch), msg);
    return msg;
  }

  patch(ch, id, set) {
    const entry = this.load(ch);
    const m = entry.byId.get(id);
    if (!m) return null;
    deepAssign(m, set);
    this.store.append(this.file(ch), { _patch: id, set });
    return m;
  }

  get(ch, id) { return this.load(ch).byId.get(id) || null; }

  page(ch, { before, limit = 80 } = {}) {
    const { msgs } = this.load(ch);
    let end = msgs.length;
    if (before) {
      const i = msgs.findIndex((m) => m.id === before);
      if (i >= 0) end = i;
    }
    const start = Math.max(0, end - limit);
    return { messages: msgs.slice(start, end), more: start > 0 };
  }

  recent(ch, n) { const { msgs } = this.load(ch); return msgs.slice(-n); }

  drop(ch) {
    this.cache.delete(ch);
    this.store.remove(this.file(ch));
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

module.exports = { Store, Channels, ensureDir };
