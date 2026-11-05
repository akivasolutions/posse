'use strict';
// Routines: saved instructions a bot runs on a schedule (daily at a time on chosen weekdays,
// every N minutes, once) or when its webhook URL is called. Times are the machine's local time.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function atTime(base, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function nextRun(s, now = Date.now(), lastRunAt = 0) {
  if (!s) return 0;
  if (s.type === 'daily') {
    const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    let d = atTime(now, s.time);
    for (let i = 0; i < 9; i++) {
      if (d.getTime() > now && days.includes(d.getDay())) return d.getTime();
      d = atTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime(), s.time);
    }
    return 0;
  }
  if (s.type === 'interval') {
    const ms = Math.max(15, s.minutes || 60) * 60e3;
    if (!lastRunAt) return now + ms;
    return Math.max(now, lastRunAt + ms);
  }
  if (s.type === 'once') {
    if (lastRunAt) return 0;
    const t = new Date(s.at).getTime();
    return Number.isFinite(t) ? Math.max(t, now) : 0;
  }
  return 0; // webhook
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

function describeSchedule(s) {
  if (!s) return '';
  if (s.type === 'daily') {
    const days = (s.days || []).slice().sort().join(',');
    let when = 'Every day';
    if (days === '1,2,3,4,5') when = 'Weekdays';
    else if (days === '0,6') when = 'Weekends';
    else if (days && days !== '0,1,2,3,4,5,6') when = s.days.slice().sort().map((d) => DAY[d]).join(', ');
    return when + ' at ' + fmtTime(s.time);
  }
  if (s.type === 'interval') {
    const m = s.minutes;
    if (m % 1440 === 0) return 'Every ' + (m / 1440 === 1 ? 'day' : m / 1440 + ' days');
    if (m % 60 === 0) return 'Every ' + (m / 60 === 1 ? 'hour' : m / 60 + ' hours');
    return 'Every ' + m + ' minutes';
  }
  if (s.type === 'once') {
    const d = new Date(s.at);
    return 'Once, ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (s.type === 'webhook') return 'When its webhook is called';
  if (s.type === 'folder') return 'When files change in ' + String(s.path || '').split(/[\\/]/).filter(Boolean).pop();
  return '';
}

// Folder routines: one fs.watch per watched folder. Changes are collected until the folder has
// been quiet for a while, then the routine runs once with the list of changed files.
const QUIET_MS = Number(process.env.BULLPEN_FOLDER_QUIET_MS) || 20e3;
const MIN_GAP_MS = Number(process.env.BULLPEN_FOLDER_GAP_MS) || 2 * 60e3;
const MAX_PER_DAY = 40;
// Compare real paths: the same folder can be spelled two ways (symlinks, /var vs /private/var).
function realPath(p) { try { return require('fs').realpathSync.native(p); } catch { return require('path').resolve(p); } }
const IGNORE = /(^|[\\/])(\.|~\$)|\.(tmp|swp|crdownload|part)$|desktop\.ini$|thumbs\.db$/i;

class Scheduler {
  constructor(app) { this.app = app; this.timer = null; this.watchers = new Map(); this.backoff = new Map(); this.kept = new Map(); this.present = new Map(); this.checking = new Map(); this.enoent = new Map(); this.stopped = false; }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 20e3);
    this.timer.unref();
    setTimeout(() => this.tick(), 3000).unref();
    this.syncWatchers();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) { try { w.watcher.close(); } catch {} clearTimeout(w.timer); }
    this.watchers.clear();
    this.present.clear();
    this.checking.clear();
  }

  syncWatchers() {
    if (this.stopped) return;
    const fs = require('fs');
    const want = new Map();
    for (const r of this.app.routines.values()) {
      if (r.enabled && !r.pendingApproval && r.schedule.type === 'folder') want.set(r.id, r);
    }
    for (const [rid, w] of this.watchers) {
      const r = want.get(rid);
      if (!r || r.schedule.path !== w.path) { try { w.watcher.close(); } catch {} clearTimeout(w.timer); this.watchers.delete(rid); }
    }
    for (const rid of new Set([...this.backoff.keys(), ...this.kept.keys(), ...this.present.keys(), ...this.enoent.keys()])) if (!want.has(rid)) { this.backoff.delete(rid); this.kept.delete(rid); this.present.delete(rid); this.enoent.delete(rid); }
    for (const [rid, r] of want) {
      if (this.watchers.has(rid)) continue;
      // Only try to watch a folder that exists, and back off after failures (a failed fs.watch
      // costs native memory every time).
      // A missing folder is checked with a cheap stat every tick; only failing fs.watch calls (which
      // cost native memory) back off, for 5 minutes at most. Backoff belongs to one path: editing the
      // routine starts fresh.
      let back = this.backoff.get(rid);
      if (back && back.path !== r.schedule.path) { this.backoff.delete(rid); back = null; }
      if (back && Date.now() < back.next) continue;
      let k = this.kept.get(rid);
      if (k && k.path !== r.schedule.path) { this.kept.delete(rid); k = null; } // catch-up belongs to one path
      // Missing folders (often network or external drives) are checked without blocking the server.
      // Results are tied to the path they checked; an edit in the meantime discards them.
      if (this.present.get(rid) !== r.schedule.path) {
        if (this.checking.get(rid) === r.schedule.path) continue;
        const checked = r.schedule.path;
        this.checking.set(rid, checked);
        fs.promises.stat(checked).then((st) => st.isDirectory(), () => false).then((ok) => {
          if (this.checking.get(rid) === checked) this.checking.delete(rid);
          if (this.stopped) return;
          const cur = this.app.routines.get(rid);
          if (!cur || cur.schedule.path !== checked) { this.syncWatchers(); return; }
          if (ok) { this.present.set(rid, checked); this.syncWatchers(); return; }
          cur.watchError = 'The folder is missing';
          const kk = this.kept.get(rid);
          if (!kk || kk.path !== checked || !kk.missingSince) this.kept.set(rid, { ...(kk && kk.path === checked ? kk : {}), path: checked, missingSince: Date.now() });
        });
        continue;
      }
      const kept = k || {};
      const w = { path: r.schedule.path, changed: new Set(), during: new Set(), carry: kept.carry || new Set(), timer: null, fires: kept.fires || [], watcher: null, selfRuns: 0, fromRun: false };
      const onChange = (ev, name) => this.folderEvent(rid, name);
      try { w.watcher = fs.watch(r.schedule.path, { recursive: true, persistent: false }, onChange); }
      catch (e1) {
        const fail = (msg, backOff = true) => { r.watchError = msg; this.present.delete(rid); this.kept.set(rid, { ...kept, path: r.schedule.path, missingSince: kept.missingSince || Date.now() }); if (backOff) this.backoff.set(rid, { path: r.schedule.path, next: Date.now() + 5 * 60e3 }); };
        if (e1.code === 'ENOENT') { // gone again: check again next tick, but back off if it keeps happening
          const prev = this.enoent.get(rid);
          const n = prev && prev.path === r.schedule.path ? prev.n + 1 : 1;
          this.enoent.set(rid, { path: r.schedule.path, n });
          fail(e1.message, n >= 2);
          continue;
        }
        if (e1.code === 'EACCES') { fail(e1.message); continue; }
        try { w.watcher = fs.watch(r.schedule.path, { persistent: false }, onChange); } catch (e) { fail(e.message); continue; }
      }
      this.backoff.delete(rid);
      this.kept.delete(rid);
      this.enoent.delete(rid);
      // Watching again after a gap: report files that arrived while nothing was watching.
      if (kept.missingSince) this.catchUp(rid, w, r.schedule.path, kept.missingSince).catch(() => {});
      // If the folder goes away the watch dies; drop it so the next sync re-creates it if the folder returns.
      w.watcher.on('error', (e) => { r.watchError = e.message; try { w.watcher.close(); } catch {} if (this.watchers.get(rid) === w) { this.kept.set(rid, { path: w.path, carry: w.carry, fires: w.fires, missingSince: Date.now() }); this.present.delete(rid); this.watchers.delete(rid); } });
      r.watchError = '';
      this.watchers.set(rid, w);
    }
  }

  // Report files that arrived (or were moved in) while nothing was watching. Async and capped, so a
  // big or slow folder never stalls the server.
  async catchUp(rid, w, dir, since) {
    const fsp = require('fs').promises;
    const path = require('path');
    const found = [];
    let visited = 0;
    const walk = async (d, rel, depth) => {
      if (found.length >= 200 || visited >= 5000 || depth > 4) return;
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found.length >= 200 || ++visited >= 5000) return;
        const r = rel ? rel + '/' + e.name : e.name;
        if (IGNORE.test(r)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, r, depth + 1);
        else {
          try {
            const st = await fsp.stat(full);
            // ctime too: a file moved or copied in keeps its old modified date.
            if (Math.max(st.mtimeMs, st.ctimeMs) >= since - 1000) found.push(r);
          } catch {}
        }
      }
    };
    await walk(dir, '', 0);
    if (this.watchers.get(rid) !== w) return;
    const own = w.recent && Date.now() < w.recent.until ? w.recent.paths : new Set();
    const fresh = found.filter((n) => !own.has(realPath(path.join(dir, n))));
    for (const n of w.carry) fresh.push(n);
    w.carry.clear();
    if (!fresh.length) return;
    w.lastEventAt = Date.now();
    for (const n of fresh) if (w.changed.size < 200) w.changed.add(n);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.folderFire(rid), QUIET_MS);
    w.timer.unref();
  }

  folderEvent(rid, name) {
    const w = this.watchers.get(rid);
    const r = this.app.routines.get(rid);
    if (!w || !r || !name || IGNORE.test(String(name))) return;
    // macOS reports a just-created or re-created watched folder under its own name. Only drop that
    // while the folder exists; if the folder itself is gone, let the event through so the check in
    // folderFire notices and the watch is re-created when the folder returns.
    const fsx = require('fs'); const px = require('path');
    if (String(name) === px.basename(w.path) && fsx.existsSync(w.path) && !fsx.existsSync(px.join(w.path, String(name)))) return;
    // While the routine's own bot is working on this routine, changes are held until the turn ends;
    // then only the files the bot didn't write itself count (see afterTurn).
    const run = this.app.runner.running.get(r.botId);
    if (run && run.inputs.some((i) => i.routineId === rid)) { if (w.during.size < 200) w.during.add(String(name)); return; }
    // File events can arrive a moment after the turn that caused them has ended.
    if (w.recent && Date.now() < w.recent.until && w.recent.paths.has(realPath(require('path').join(w.path, String(name))))) return;
    w.fromRun = false;
    w.selfRuns = 0;
    for (const n of w.carry) if (w.changed.size < 200) w.changed.add(n);
    w.carry.clear();
    w.lastEventAt = Date.now();
    if (w.changed.size < 200) w.changed.add(String(name));
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.folderFire(rid), QUIET_MS);
    w.timer.unref();
  }

  afterTurn(bot, run) {
    const path = require('path');
    for (const [rid, w] of this.watchers) {
      const r = this.app.routines.get(rid);
      if (!r || r.botId !== bot.id || !run.inputs.some((i) => i.routineId === rid)) continue;
      if (!w.during.size) { w.recent = { paths: new Set([...(run.written || [])].map(realPath)), until: Date.now() + 5000 }; continue; }
      const written = new Set([...(run.written || [])].map(realPath));
      w.recent = { paths: written, until: Date.now() + 5000 };
      const others = [...w.during].filter((n) => !written.has(realPath(path.join(w.path, n))));
      w.during.clear();
      if (!others.length) continue;
      // Changes we can't attribute (e.g. made by a shell command) could be the bot's own. Allow one
      // follow-up run from them, never a chain.
      // Don't chain self-triggered runs, but never drop a file: carry it into the next real event.
      if (w.selfRuns >= 1) { w.selfRuns = 0; for (const n of others) if (w.carry.size < 200) w.carry.add(n); continue; }
      w.selfRuns++;
      w.fromRun = true;
      w.lastEventAt = Date.now();
      for (const n of others) if (w.changed.size < 200) w.changed.add(n);
      clearTimeout(w.timer);
      w.timer = setTimeout(() => this.folderFire(rid), QUIET_MS);
      w.timer.unref();
    }
  }

  folderFire(rid, folderChecked = false) {
    const w = this.watchers.get(rid);
    const r = this.app.routines.get(rid);
    if (!w || !r || !w.changed.size) return;
    if (!folderChecked) {
      // Check the folder is still there without blocking (it may be on a slow network drive), then
      // come back here once, however long the check took.
      if (w.checking) return;
      w.checking = true;
      require('fs').promises.access(w.path).then(() => {
        w.checking = false;
        if (this.watchers.get(rid) !== w) return; // the routine was edited meanwhile
        if (Date.now() - (w.lastEventAt || 0) < QUIET_MS) return; // still changing; the pending timer fires later
        this.folderFire(rid, true);
      }, () => {
        w.checking = false;
        if (this.watchers.get(rid) !== w) return;
        r.watchError = 'The folder is missing';
        w.changed.clear();
        try { w.watcher.close(); } catch {}
        this.present.delete(rid);
        this.kept.set(rid, { path: w.path, carry: w.carry, fires: w.fires, missingSince: Date.now() }); // keep the daily cap and carried files
        this.watchers.delete(rid); // re-created by syncWatchers when the folder is back
      });
      return;
    }
    const now = Date.now();
    w.fires = w.fires.filter((t) => now - t < 86400e3);
    const last = w.fires[w.fires.length - 1] || 0;
    if (now - last < MIN_GAP_MS) { clearTimeout(w.timer); w.timer = setTimeout(() => this.folderFire(rid), MIN_GAP_MS - (now - last)); w.timer.unref(); return; }
    if (w.fires.length >= MAX_PER_DAY) return;
    const bot = this.app.bots.get(r.botId);
    if (bot && (bot._queue || []).some((i) => i.routineId === rid)) { clearTimeout(w.timer); w.timer = setTimeout(() => this.folderFire(rid), QUIET_MS); w.timer.unref(); return; }
    const files = [...w.changed].slice(0, 50);
    w.changed.clear();
    w.fires.push(now);
    this.app.fireRoutine(r, 'Files added or changed in ' + r.schedule.path + ':\n' + files.map((f) => '- ' + f).join('\n'));
  }

  tick(now = Date.now()) {
    const app = this.app;
    app.expireDeferred();
    this.syncWatchers(); // picks up folders that came back
    for (const r of app.routines.values()) {
      if (!r.enabled || r.pendingApproval || !r.nextRunAt || r.nextRunAt > now) continue;
      const bot = app.bots.get(r.botId);
      if (!bot) continue;
      // Don't stack runs: if the last one is still waiting, just move the schedule forward.
      const waiting = (bot._queue || []).some((i) => i.kind === 'routine' && i.routineId === r.id);
      if (waiting) {
        r.nextRunAt = r.schedule.type === 'once' ? 0 : nextRun(r.schedule, now, now);
        app.saveRoutines();
        continue;
      }
      app.fireRoutine(r);
    }
  }
}

module.exports = { Scheduler, nextRun, describeSchedule };
