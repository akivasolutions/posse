'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Store, Channels, deepAssign } = require('./store');
const { Runner } = require('./runner');
const { Scheduler, describeSchedule, nextRun } = require('./scheduler');
const cli = require('./claude-cli');
const { id, token, slugify, truncate, clampInt, localDateKey, timeZone, mentions } = require('./util');

const PERMISSIONS = ['ask', 'edits', 'auto', 'full', 'readonly'];
const RANK = { readonly: 0, ask: 1, edits: 2, auto: 2, full: 3 };
// Claude Code gives up on a permission request after 5 minutes, so a bot waits at most this long
// for a live answer; after that it moves on and the card stays open (see deferApproval).
const LIVE_APPROVAL_MS = Number(process.env.BULLPEN_LIVE_APPROVAL_MS) || 270e3;
const PERM_LABEL = { readonly: 'Read only', ask: 'Ask me', edits: 'Auto-edit', auto: 'Auto-review', full: 'Full access' };
const COLORS = ['#4f6bed', '#0e9f6e', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];

const DEFAULT_CONFIG = {
  userName: '',
  theme: 'system',
  accent: '#4f6bed',
  claudePath: '',
  defaultModel: 'opus',
  defaultPermission: 'ask',
  maxConcurrent: 2,
  maxTurnsPerDay: 300,
  maxTurnsPerBotHour: 40,
  maxDepth: 4,
  maxChainTurns: 30,
  turnTimeoutMin: 30,
  maxToolTurns: 80,
  approvalTimeoutMin: 1440,
  sessionMaxTokens: 150000,
  mcpTransport: 'http',
  escalationGuard: true,
  lowPriority: true,
  paused: false,
  sections: [],
  collapsed: [],
};

const LIMITS = {
  maxConcurrent: [1, 8], maxTurnsPerDay: [1, 5000], maxTurnsPerBotHour: [1, 500], maxDepth: [1, 10],
  maxChainTurns: [2, 500], turnTimeoutMin: [2, 240], maxToolTurns: [5, 500], approvalTimeoutMin: [5, 10080], sessionMaxTokens: [50000, 1000000],
};

class App extends EventEmitter {
  constructor({ dataDir, baseUrl }) {
    super();
    this.setMaxListeners(100);
    this.store = new Store(dataDir);
    this.channels = new Channels(this.store);
    this.baseUrl = baseUrl;
    this.bots = new Map();
    this.rooms = new Map();
    this.tasks = new Map();
    this.routines = new Map();
    this.pages = new Map();
    this.files = {};
    this.approvals = new Map();
    this.pending = new Map(); // msgId -> { ch, msgId, type, botId, ts } for cards waiting on the user
    this.deferred = new Map(); // approvalId -> an approval the bot stopped waiting for; still answerable
    this.usage = {};
    this.runner = new Runner(this);
    this.scheduler = new Scheduler(this);
  }

  // ---------------- load / save ----------------
  load() {
    const s = this.store;
    this.config = { ...DEFAULT_CONFIG, ...s.readJSON('config.json', {}) };
    if (!this.config.userName) this.config.userName = guessName();
    for (const dir of s.list('bots')) {
      const b = s.readJSON(path.join('bots', dir, 'bot.json'), null);
      if (b && b.id) { this.bots.set(b.id, normalizeBot(b)); this.runner.loadQueue(this.bots.get(b.id)); }
    }
    for (const r of s.readJSON('rooms.json', [])) this.rooms.set(r.id, r);
    for (const t of s.readJSON('tasks.json', [])) this.tasks.set(t.id, t);
    for (const r of s.readJSON('routines.json', [])) this.routines.set(r.id, r);
    for (const p of s.readJSON('pages.json', [])) this.pages.set(p.id, p);
    this.files = s.readJSON('files.json', {});
    for (const p of s.readJSON('pending.json', [])) this.pending.set(p.msgId, p);
    for (const d of s.readJSON('deferred.json', [])) if (Date.now() < d.expiresAt) this.deferred.set(d.id, d);
    // Live approval cards from before a restart can't be answered (their turn is re-run and will
    // ask again). Cards the bot had already moved on from ("later") stay answerable.
    for (const p of [...this.pending.values()]) {
      if (p.type !== 'approval') continue;
      const m = this.channels.get(p.ch, p.msgId);
      if (m && m.card && this.deferred.has(m.card.approvalId)) continue;
      try { this.channels.patch(p.ch, p.msgId, { card: { status: 'expired' } }); } catch {}
      this.pending.delete(p.msgId);
    }
    this.savePending();
    this.usage = s.readJSON('usage.json', {});
    // Tasks that were mid-flight when the app stopped are re-delivered by the queue; mark them queued.
    for (const t of this.tasks.values()) if (t.status === 'working') t.status = 'queued';
    if (!s.exists('shared/memory.md')) {
      s.writeText('shared/memory.md', '# Shared memory\n\n- The user\'s name is ' + this.config.userName + '.\n' + (timeZone() ? '- Time zone: ' + timeZone() + '.\n' : ''));
    }
    if (!this.bots.size) this.seed();
    this.saveConfig();
    this.scheduler.start();
    this.runner.kick();
  }

  seed() {
    this.createBot({
      name: 'Chief of Staff', title: 'Primary bot', avatar: '⭐', primary: true,
      description: 'Takes any request, hands it to the right specialist, follows up and reports back.',
      instructions: 'Keep the user\'s priorities straight. Route work to the specialist whose role fits, track what you handed out, and close the loop: every request ends with a clear result or a clear next step.',
    });
  }

  saveConfig() { this.store.writeJSON('config.json', this.config); }
  saveBot(b) {
    if (b._deleted) return;
    const { _queue, _inflight, _blocked, _deleted, ...rest } = b;
    this.store.writeJSON(path.join('bots', b.id, 'bot.json'), rest);
  }
  saveRooms() { this.store.writeJSON('rooms.json', [...this.rooms.values()]); }
  saveTasks() {
    // Keep every open task and the most recent 1500 closed ones.
    const all = [...this.tasks.values()].sort((a, b) => a.id - b.id);
    const closed = all.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
    const drop = new Set(closed.slice(0, Math.max(0, closed.length - 1500)).map((t) => t.id));
    for (const idn of drop) this.tasks.delete(idn);
    this.store.writeJSON('tasks.json', all.filter((t) => !drop.has(t.id)));
  }
  saveRoutines() {
    this.store.writeJSON('routines.json', [...this.routines.values()].map(({ watchError, ...r }) => r));
    if (this.scheduler && this.scheduler.timer) this.scheduler.syncWatchers();
  }
  savePages() { this.store.writeJSON('pages.json', [...this.pages.values()]); }
  saveFiles() { this.store.writeJSON('files.json', this.files); }
  savePending() { this.store.writeJSON('pending.json', [...this.pending.values()]); }
  saveDeferred() { this.store.writeJSON('deferred.json', [...this.deferred.values()]); }

  trackCard(ch, m) {
    if (!m || m.kind !== 'card' || !m.card) return;
    const waiting = ['pending', 'open', 'later'].includes(m.card.status) && ['approval', 'question', 'routine', 'callin'].includes(m.card.type);
    const had = this.pending.has(m.id);
    if (waiting && !had) this.pending.set(m.id, { ch, msgId: m.id, type: m.card.type, botId: m.botId, ts: m.ts });
    else if (!waiting && had) this.pending.delete(m.id);
    else return;
    this.savePending();
    this.emit('ev', { type: 'pending', count: this.pending.size });
  }

  pendingCards() {
    const out = [];
    for (const p of [...this.pending.values()].sort((a, b) => b.ts - a.ts)) {
      if (!this.channelExists(p.ch)) { this.pending.delete(p.msgId); continue; }
      const m = this.channels.get(p.ch, p.msgId);
      if (m) out.push({ ch: p.ch, msg: m });
    }
    return out;
  }

  // Security-relevant events, append-only (Settings → Security shows the latest). Rotated at 5 MB.
  audit(type, detail) {
    const rec = { ts: Date.now(), type, ...detail };
    try {
      const f = this.store.p('audit.jsonl');
      if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, this.store.p('audit.1.jsonl'));
      this.store.append('audit.jsonl', rec);
    } catch {}
  }

  readAudit(limit = 200) {
    const recs = this.store.readJSONL('audit.jsonl');
    return recs.slice(-limit).reverse();
  }

  permOf(b) { return (b && (b.permission || this.config.defaultPermission)) || 'ask'; }

  // How much a bot can do on its own: its permission level, raised to Auto-edit level if it has
  // standing rules for commands or edits, extra connectors, or the user's own settings.
  effRank(b) {
    let r = RANK[this.permOf(b)];
    // Broad standing rules count; one exact command doesn't.
    const broad = (x) => /^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit)$/.test(x) || /^(Edit|Write)\(/.test(x) || (/^(Bash|PowerShell)\(/.test(x) && x.includes('*'));
    const strong = (b.alwaysAllow || []).some(broad) || Object.keys(b.mcpServers || {}).length || b.useMyClaudeSettings || b.trustFolderSettings;
    if (strong) r = Math.max(r, 2);
    return r;
  }

  needsSharedWriteOk(bot) {
    if (!this.config.escalationGuard) return false;
    const mine = RANK[this.permOf(bot)]; // extra connectors make a sender less trustworthy, not more
    return [...this.bots.values()].some((o) => o.id !== bot.id && this.effRank(o) > mine && this.effRank(o) >= 2);
  }

  // Do an approved, exactly-described action (used live and when a card is answered later).
  performAction(a) {
    const from = this.bots.get(a.from);
    if (a.kind === 'delegate') {
      const to = this.bots.get(a.to);
      if (!to) throw httpError(404, 'That bot is gone');
      const t = {
        id: this.nextTaskId(), title: truncate(String(a.title || 'Task').trim(), 120), instructions: String(a.instructions).trim(),
        from: a.from, to: to.id, status: 'queued', result: '', note: '', createdAt: Date.now(), updatedAt: Date.now(),
        replyCh: a.ch && this.channelExists(a.ch) ? a.ch : 'dm:' + a.from, depth: a.depth, rootId: a.rootId,
      };
      this.tasks.set(t.id, t);
      this.saveTasks();
      this.emit('ev', { type: 'task', task: t });
      this.postMessage(t.replyCh, { role: 'bot', botId: a.from, kind: 'card', card: { type: 'task', taskId: t.id } });
      const msg = this.postMessage('dm:' + to.id, {
        role: 'incoming', text: '**' + t.title + '**\n\n' + t.instructions,
        meta: { label: 'Task #' + t.id + ' from ' + (from ? from.name : 'a teammate'), from: a.from, taskId: t.id },
      });
      this.runner.enqueue(to.id, { ch: 'dm:' + to.id, kind: 'task', taskId: t.id, depth: a.depth, rootId: a.rootId, msgId: msg.id });
      return t;
    }
    if (a.kind === 'message') {
      const to = this.bots.get(a.to);
      if (!to) throw httpError(404, 'That bot is gone');
      const msg = this.postMessage('dm:' + to.id, { role: 'incoming', text: a.text, meta: { label: 'Message from ' + (from ? from.name : 'a teammate'), from: a.from } });
      this.runner.enqueue(to.id, { ch: 'dm:' + to.id, kind: 'message', from: a.from, text: a.text, depth: a.depth, rootId: a.rootId, msgId: msg.id });
      return true;
    }
    if (a.kind === 'memory_add') { const cur = this.readMemory(null).replace(/\s+$/, ''); this.writeMemory(null, (cur ? cur + '\n' : '') + '- ' + a.text.replace(/\n+/g, ' ') + '\n'); return true; }
    if (a.kind === 'memory_replace') { this.writeMemory(null, a.content.trim() + '\n'); return true; }
    if (a.kind === 'skill') { this.saveSkill({ name: a.name, description: a.description, body: a.body }); return true; }
    throw httpError(400, 'Unknown action');
  }

  // Handing work to a teammate with more power than you (Auto-edit/Auto-review/Full access) is how
  // a bot misled by something it read could get dangerous actions done. With the guard on, the
  // user approves such hand-offs on a card.
  needsEscalationOk(fromBot, toBot) {
    if (!this.config.escalationGuard || !fromBot || !toBot) return false;
    const a = RANK[this.permOf(fromBot)]; const b = this.effRank(toBot);
    return b > a && b >= 2;
  }

  // ---------------- events ----------------
  spentToday(botId) {
    const u = this.usage[localDateKey()];
    return (u && u.costByBot && u.costByBot[botId]) || 0;
  }

  publicBot(b) {
    const { _queue, _inflight, _blocked, _deleted, ...rest } = b;
    return { ...rest, status: this.runner.status(b), routines: [...this.routines.values()].filter((r) => r.botId === b.id).length, spentToday: this.spentToday(b.id) };
  }
  emitBot(b) {
    if (b._deleted || !this.bots.has(b.id)) return;
    const { mcpServers, ...pub } = this.publicBot(b); // connector settings can hold tokens; /api/state has them
    this.emit('ev', { type: 'bot', bot: pub });
  }

  publicState() {
    const info = cli.detect(this.config.claudePath);
    return {
      config: this.config,
      cli: { found: info.found, path: info.path, version: info.version, error: info.error },
      bots: this.listBots(true).map((b) => this.publicBot(b)),
      rooms: [...this.rooms.values()],
      tasks: [...this.tasks.values()].sort((a, b) => b.id - a.id).slice(0, 300),
      routines: [...this.routines.values()].map((r) => this.publicRoutine(r)),
      pages: [...this.pages.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      skills: this.listSkills(),
      usage: { today: this.usage[localDateKey()] || { turns: 0, costUsd: 0 } },
      pendingCount: this.pending.size,
      dataDir: this.store.dir,
      platform: process.platform,
    };
  }

  publicRoutine(r) {
    const { secret, ...rest } = r;
    return { ...rest, scheduleText: describeSchedule(r.schedule), webhook: r.schedule.type === 'webhook' ? this.baseUrl + '/api/hooks/' + r.id + '/' + secret : '' };
  }

  // ---------------- bots ----------------
  listBots(includeHidden = true) {
    return [...this.bots.values()].filter((b) => includeHidden || !b.hidden)
      .sort((a, b) => (b.primary - a.primary) || a.createdAt - b.createdAt);
  }

  primaryBot() { return [...this.bots.values()].find((b) => b.primary) || null; }

  botByHandle(h) {
    h = String(h || '').trim().replace(/^@/, '').toLowerCase();
    for (const b of this.bots.values()) if (b.handle === h) return b;
    for (const b of this.bots.values()) if (b.name.toLowerCase() === h || slugify(b.name) === slugify(h)) return b;
    return null;
  }

  uniqueHandle(name, exceptId) {
    const base = slugify(name);
    let h = base;
    let n = 2;
    while ([...this.bots.values()].some((b) => b.handle === h && b.id !== exceptId)) h = base + '-' + n++;
    return h;
  }

  botCwd(b) {
    return b.cwd && b.cwd.trim() ? path.resolve(b.cwd.trim().replace(/^~(?=$|[\\/])/, os.homedir())) : this.store.p('bots', b.id, 'workspace');
  }

  createBot(fields) {
    const b = normalizeBot({
      id: id('b_'),
      color: COLORS[this.bots.size % COLORS.length],
      createdAt: Date.now(),
      ...pickBotFields(fields),
    });
    b.handle = this.uniqueHandle(fields.handle || b.name, b.id);
    if (b.primary || !this.primaryBot()) { for (const o of this.bots.values()) if (o.primary) { o.primary = false; this.saveBot(o); this.emitBot(o); } b.primary = true; }
    b._queue = [];
    b._inflight = [];
    this.bots.set(b.id, b);
    this.saveBot(b);
    this.runner.saveQueue(b);
    this.audit('bot.created', { bot: b.name, detail: 'permissions ' + PERM_LABEL[this.permOf(b)] + (b.cwd ? '; folder ' + b.cwd : '') });
    if (!this.store.exists(path.join('bots', b.id, 'memory.md'))) this.store.writeText(path.join('bots', b.id, 'memory.md'), '');
    this.emitBot(b);
    this.teamChanged();
    return b;
  }

  updateBot(botId, fields) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    const f = pickBotFields(fields);
    const before = { name: b.name, cwd: b.cwd, perm: this.permOf(b), mcp: JSON.stringify(b.mcpServers), user: b.useMyClaudeSettings, trust: b.trustFolderSettings, rules: JSON.stringify(b.alwaysAllow) };
    Object.assign(b, f);
    normalizeBot(b);
    if (fields.handle !== undefined || f.name !== before.name) b.handle = this.uniqueHandle(fields.handle || b.handle || b.name, b.id);
    if (f.primary === true) for (const o of this.bots.values()) if (o.id !== b.id && o.primary) { o.primary = false; this.saveBot(o); this.emitBot(o); }
    if (!this.primaryBot()) b.primary = true;
    // Claude Code keys sessions by working folder; a new folder means a new session.
    if (f.cwd !== undefined && path.resolve(this.botCwd({ ...b, cwd: before.cwd })) !== path.resolve(this.botCwd(b))) {
      b.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
      b.sessionGen = (b.sessionGen || 0) + 1;
    }
    b.updatedAt = Date.now();
    const changes = [];
    if (this.permOf(b) !== before.perm) changes.push('permissions ' + PERM_LABEL[before.perm] + ' → ' + PERM_LABEL[this.permOf(b)]);
    if (JSON.stringify(b.mcpServers) !== before.mcp) changes.push('extra MCP servers changed');
    if (b.useMyClaudeSettings !== before.user) changes.push('use my Claude settings ' + (b.useMyClaudeSettings ? 'on' : 'off'));
    if (b.trustFolderSettings !== before.trust) changes.push('trust folder settings ' + (b.trustFolderSettings ? 'on' : 'off'));
    if (JSON.stringify(b.alwaysAllow) !== before.rules) changes.push('always-allowed rules: ' + truncate(b.alwaysAllow.join(' | ') || '(none)', 300));
    if (b.cwd !== before.cwd) changes.push('working folder → ' + (b.cwd || '(own workspace)'));
    if (changes.length) this.audit('bot.changed', { bot: b.name, detail: changes.join('; ') });
    this.saveBot(b);
    this.emitBot(b);
    this.teamChanged();
    if (f.paused === false) { b.failures = 0; this.saveBot(b); this.runner.kick(); }
    return b;
  }

  deleteBot(botId) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    b._deleted = true;
    this.bots.delete(botId);
    this.forgetChannel('dm:' + botId);
    for (const x of [...this.deferred.values()]) {
      if (x.botId !== botId) continue;
      this.deferred.delete(x.id);
      if (x.ch.startsWith('room:')) { try { this.patchMessage(x.ch, x.msgId, { card: { status: 'expired' } }); } catch {} }
    }
    this.saveDeferred();
    for (const p of [...this.pending.values()]) if (p.botId === botId) this.pending.delete(p.msgId);
    this.savePending();
    this.emit('ev', { type: 'pending', count: this.pending.size });
    // A running turn still has its working folder open (Windows won't move it), so the files go
    // to the trash once that turn has ended.
    if (!this.runner.stop(botId)) this.trashBotFiles(botId);
    this.audit('bot.deleted', { bot: b.name });
    for (const r of [...this.routines.values()]) if (r.botId === botId) this.routines.delete(r.id);
    this.saveRoutines();
    for (const room of this.rooms.values()) room.members = room.members.filter((m) => m !== botId);
    this.saveRooms();
    for (const t of this.tasks.values()) {
      if (t.to === botId && !isClosed(t)) this.closeTask(t, 'failed', 'The bot this was assigned to was deleted.');
    }
    if (b.primary) {
      const next = this.listBots()[0];
      if (next) { next.primary = true; this.saveBot(next); this.emitBot(next); }
    }
    this.emit('ev', { type: 'bot:removed', id: botId });
    this.emit('ev', { type: 'rooms', rooms: [...this.rooms.values()] });
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((r) => this.publicRoutine(r)) });
    this.teamChanged();
  }

  forgetChannel(ch) {
    let changed = false;
    for (const p of [...this.pending.values()]) if (p.ch === ch) { this.pending.delete(p.msgId); changed = true; }
    if (changed) { this.savePending(); this.emit('ev', { type: 'pending', count: this.pending.size }); }
    let d = false;
    for (const x of [...this.deferred.values()]) if (x.ch === ch) { this.deferred.delete(x.id); d = true; }
    if (d) this.saveDeferred();
  }

  trashBotFiles(botId) {
    try { this.store.trash(path.join('bots', botId)); } catch (e) { console.error('[bullpen] could not move bot folder to trash:', e.message); }
    try { this.channels.trash('dm:' + botId); } catch (e) { console.error('[bullpen] could not move chat to trash:', e.message); }
  }

  resetSession(botId) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    b.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
    b.sessionGen = (b.sessionGen || 0) + 1;
    this.saveBot(b);
    this.postMessage('dm:' + b.id, { role: 'system', text: 'Started a fresh session. The bot keeps its memory and gets the recent chat as a recap on its next turn.' });
    this.emitBot(b);
  }

  teamChanged() { /* prompts pick up the roster on each turn via context hashes */ }

  // ---------------- messages ----------------
  postMessage(ch, m) {
    const msg = { id: id('m_'), ts: Date.now(), ch, kind: 'text', ...m };
    this.channels.add(ch, msg);
    this.trackCard(ch, msg);
    if (['bot', 'incoming', 'system'].includes(msg.role) && !(msg.meta && msg.meta.quiet)) this.bumpUnread(ch);
    this.emit('ev', { type: 'message', ch, msg });
    return msg;
  }

  patchMessage(ch, msgId, set) {
    const m = this.channels.patch(ch, msgId, set);
    if (m) { this.trackCard(ch, m); this.emit('ev', { type: 'message:update', ch, msg: m }); }
    return m;
  }

  bumpUnread(ch) {
    const [kind, oid] = ch.split(':');
    const o = kind === 'dm' ? this.bots.get(oid) : this.rooms.get(oid);
    if (!o) return;
    o.unread = (o.unread || 0) + 1;
    if (kind === 'dm') { this.saveBot(o); this.emitBot(o); } else { this.saveRooms(); this.emit('ev', { type: 'room', room: o }); }
  }

  markRead(ch) {
    const [kind, oid] = ch.split(':');
    const o = kind === 'dm' ? this.bots.get(oid) : this.rooms.get(oid);
    if (!o || !o.unread) return;
    o.unread = 0;
    if (kind === 'dm') { this.saveBot(o); this.emitBot(o); } else { this.saveRooms(); this.emit('ev', { type: 'room', room: o }); }
  }

  systemNotice(botId, text) {
    const b = (botId && this.bots.get(botId)) || this.primaryBot();
    if (b) this.postMessage('dm:' + b.id, { role: 'system', text });
  }

  checkChannel(ch) {
    const [kind, oid] = String(ch).split(':');
    if (kind === 'dm' && this.bots.has(oid)) return { kind, bot: this.bots.get(oid) };
    if (kind === 'room' && this.rooms.has(oid)) return { kind, room: this.rooms.get(oid) };
    throw httpError(404, 'No such chat');
  }

  userSend(ch, text, fileIds = []) {
    const c = this.checkChannel(ch);
    text = String(text || '').trim();
    const files = (Array.isArray(fileIds) ? fileIds : []).map((fid) => this.fileById(String(fid))).filter(Boolean)
      .map((f) => ({ id: f.id, name: f.name, path: this.store.p(f.rel), size: f.size }));
    if (!text && !files.length) throw httpError(400, 'Empty message');
    const msg = this.postMessage(ch, { role: 'user', text, files: files.map(({ id: fid, name, size }) => ({ id: fid, name, size })) });
    if (c.kind === 'dm') {
      this.runner.enqueue(c.bot.id, { ch, kind: 'user', text, files, msgId: msg.id });
    } else {
      const room = c.room;
      let targets = mentions(text).map((h) => this.botByHandle(h)).filter((b) => b && room.members.includes(b.id));
      if (!targets.length) {
        const lead = room.members.map((m) => this.bots.get(m)).find(Boolean);
        if (lead) targets = [lead];
      }
      if (!targets.length) this.postMessage(ch, { role: 'system', text: 'Add a bot to this group chat first.' });
      const rootId = id('root_');
      for (const b of targets) this.runner.enqueue(b.id, { ch, kind: 'room', roomId: room.id, files, msgId: msg.id, rootId });
    }
    return msg;
  }

  // A bot already waiting to speak in a room will see the newest messages when its turn comes.
  queuedInRoom(bot, roomId) {
    return (bot._queue || []).some((i) => i.ch === 'room:' + roomId && i.kind === 'room');
  }

  // Full-text search over every chat (newest first). Reads the chat files directly, month by month,
  // so it costs nothing until used.
  async search(q, limit = 60) {
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const chans = [...[...this.bots.keys()].map((b) => 'dm:' + b), ...[...this.rooms.keys()].map((r) => 'room:' + r)];
    const hits = [];
    for (const ch of chans) {
      const segs = this.store.list(this.channels.dir(ch)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse()
        .map((f) => path.join(this.channels.dir(ch), f));
      if (this.store.exists(this.channels.legacy(ch))) segs.push(this.channels.legacy(ch));
      let found = 0;
      for (const f of segs) {
        if (found >= limit) break;
        await new Promise((r) => setImmediate(r)); // let other requests through between files
        for (const m of this.store.readJSONL(f).reverse()) {
          if (m._patch || !m.id) continue;
          const text = m.kind === 'card' && m.card ? [m.card.question, m.card.body, m.card.title, m.card.answer].filter(Boolean).join(' ') : m.text || '';
          const i = text.toLowerCase().indexOf(needle);
          if (i < 0) continue;
          hits.push({ ch, id: m.id, ts: m.ts, role: m.role, botId: m.botId || (m.meta && m.meta.from) || null, snippet: truncate(text.slice(Math.max(0, i - 60), i + 140).replace(/\s+/g, ' '), 220) });
          if (++found >= limit) break;
        }
      }
    }
    return hits.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // Writes the whole chat as Markdown, one month file at a time (nothing large is held in memory).
  async exportChannel(ch, write) {
    const c = this.checkChannel(ch);
    const title = c.kind === 'dm' ? c.bot.name : c.room.name;
    await write(['# ' + title, '', '_Exported from Bullpen on ' + new Date().toLocaleString() + '_', '', ''].join('\n'));
    const segs = this.store.list(this.channels.dir(ch)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(this.channels.dir(ch), f));
    if (this.store.exists(this.channels.legacy(ch))) segs.unshift(this.channels.legacy(ch));
    const { cardSummary } = require('./prompt');
    for (const f of segs) {
      const msgs = [];
      const byId = new Map();
      for (const rec of this.store.readJSONL(f)) {
        if (rec._patch) { const m = byId.get(rec._patch); if (m) deepAssign(m, rec.set || {}); }
        else if (rec.id) { msgs.push(rec); byId.set(rec.id, rec); }
      }
      const out = [];
      for (const m of msgs) {
        const who = m.role === 'user' ? this.config.userName : m.role === 'bot' ? ((this.bots.get(m.botId) || {}).name || 'Bot') : m.role === 'incoming' ? ((m.meta && m.meta.label) || 'Incoming') : 'System';
        const body = m.kind === 'card' && m.card ? '_' + cardSummary(m.card) + '_' : m.text || '';
        out.push('**' + who + '** · ' + new Date(m.ts).toLocaleString(), '', body, '');
      }
      await write(out.join('\n') + '\n');
    }
    return title;
  }

  // ---------------- tasks ----------------
  nextTaskId() {
    this.config.taskSeq = (this.config.taskSeq || 0) + 1;
    this.saveConfig();
    return this.config.taskSeq;
  }

  updateTask(tid, set) {
    const t = this.tasks.get(tid);
    if (!t) return null;
    Object.assign(t, set, { updatedAt: Date.now() });
    this.saveTasks();
    this.emit('ev', { type: 'task', task: t });
    return t;
  }

  closeTask(t, status, result) {
    if (isClosed(t)) return t;
    this.updateTask(t.id, { status, result: String(result || '').trim() || '(no result)' });
    const from = this.bots.get(t.from);
    if (from) {
      const ch = t.replyCh && this.channelExists(t.replyCh) ? t.replyCh : 'dm:' + from.id;
      const to = this.bots.get(t.to);
      const msg = this.postMessage(ch, {
        role: 'incoming', text: t.result,
        meta: { label: 'Report on task #' + t.id + ' from ' + (to ? to.name : 'a teammate'), from: t.to, taskId: t.id, status },
      });
      this.runner.enqueue(from.id, { ch, kind: 'report', taskId: t.id, depth: Math.max(0, (t.depth || 1) - 1), rootId: t.rootId, msgId: msg.id, roomId: ch.startsWith('room:') ? ch.slice(5) : undefined });
    }
    return t;
  }

  channelExists(ch) { try { this.checkChannel(ch); return true; } catch { return false; } }

  cancelTask(tid) {
    const t = this.tasks.get(tid);
    if (!t) throw httpError(404, 'No such task');
    if (isClosed(t)) return t;
    const to = this.bots.get(t.to);
    if (to) { to._queue = (to._queue || []).filter((i) => i.taskId !== t.id); this.runner.saveQueue(to); this.emitBot(to); }
    return this.closeTask(t, 'cancelled', 'Cancelled by ' + this.config.userName + '.');
  }

  chainStopped(bot, item) {
    const label = item.kind === 'task' ? 'task #' + item.taskId : item.kind;
    this.systemNotice(null, 'Stopped a chain of bot-to-bot work at ' + this.config.maxChainTurns + ' turns (' + label + ' for ' + bot.name + ' was not run). Raise "Turns per request chain" in Settings → Limits if this work needs more room.');
    if (item.kind === 'task') { const t = this.tasks.get(item.taskId); if (t && !isClosed(t)) this.closeTask(t, 'failed', 'Not run: the request chain hit its turn budget (' + this.config.maxChainTurns + ' turns).'); }
  }

  // ---------------- end of a turn ----------------
  turnFinished(bot, run, outcome) {
    const cfg = this.config;
    if (bot._deleted || !this.bots.has(bot.id)) return;
    try { this.scheduler.afterTurn(bot, run); } catch (e) { console.error('[bullpen] folder routine bookkeeping:', e.message); }
    const day = localDateKey();
    const u = this.usage[day] || (this.usage[day] = { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byBot: {} });
    const r = outcome.result || {};
    const cost = Number(r.total_cost_usd) || 0;
    u.turns++;
    u.costUsd += cost;
    if (r.usage) { u.inputTokens += (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0); u.outputTokens += r.usage.output_tokens || 0; }
    u.byBot[bot.id] = (u.byBot[bot.id] || 0) + 1;
    u.costByBot = u.costByBot || {};
    u.costByBot[bot.id] = (u.costByBot[bot.id] || 0) + cost;
    const keys = Object.keys(this.usage).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete this.usage[k];
    this.store.writeJSON('usage.json', this.usage);
    this.emit('ev', { type: 'usage', today: u });

    const routineInput = run.inputs.find((i) => i.kind === 'routine');
    const routine = routineInput && this.routines.get(routineInput.routineId);

    const sessionKept = (bot.sessionGen || 0) === run.sessionGen; // false if reset during the turn
    if (outcome.ok) {
      // Keep the session going.
      if (sessionKept) bot.session = {
        id: run.sessionId,
        turns: (run.newSession ? 0 : bot.session.turns || 0) + 1,
        startedAt: run.newSession ? Date.now() : bot.session.startedAt || Date.now(),
        ctx: run.ctx,
        contextTokens: contextSize(r),
      };
      bot.stats = { turns: (bot.stats.turns || 0) + 1, costUsd: (bot.stats.costUsd || 0) + cost };
      const handoff = run.inputs.some((i) => i.handoff);
      bot.lastActiveAt = Date.now();
      bot.failures = 0;

      let text = String(outcome.text || '').trim();
      const quiet = routine && routine.notify !== 'always' && /^NO_UPDATE\b/.test(text);
      // In a group chat a bot with nothing to add stays silent instead of posting "nothing from me".
      const silent = run.ch.startsWith('room:') && /^NO_REPLY\b/.test(text);
      if (silent) text = '';
      const meta = { steps: run.steps.slice(-40), costUsd: cost, ms: Date.now() - run.startedAt, model: bot.model || cfg.defaultModel };
      if (handoff && run.inputs.every((i) => i.handoff)) meta.quiet = true;
      if (quiet) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: 'Routine "' + routine.title + '" ran — nothing to report.', meta: { ...meta, quiet: true } });
      } else if (text) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text, meta });
      } else if (!run.cardCount && !silent) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: '_(finished without a reply)_', meta });
      }
      for (const tid of run.taskIds) {
        const t = this.tasks.get(tid);
        if (!t || isClosed(t) || run.completed.has(tid)) continue;
        if (run.held.has(tid)) { this.updateTask(tid, { status: 'held' }); continue; }
        this.closeTask(t, 'done', text || '(finished without a written report)');
      }
      if (routine) this.routineRan(routine, quiet ? 'quiet' : 'ok', text);
      this.maybeRollSession(bot, handoff);
      // Group chat: bring in teammates the bot @mentioned.
      if (run.ch.startsWith('room:') && text) {
        const room = this.rooms.get(run.ch.slice(5));
        if (room) {
          const targets = mentions(text).map((h) => this.botByHandle(h)).filter((b) => b && b.id !== bot.id && room.members.includes(b.id));
          for (const t of targets) {
            if (this.queuedInRoom(t, room.id)) continue;
            if (run.depth + 1 > cfg.maxDepth) { this.postMessage(run.ch, { role: 'system', text: 'Did not call in @' + t.handle + ': the group chat reached the hand-off limit (' + cfg.maxDepth + ').' }); continue; }
            if (this.needsEscalationOk(bot, t)) {
              this.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'callin', botId: t.id, fromBotId: bot.id, roomId: room.id, depth: run.depth + 1, rootId: run.rootId, perm: PERM_LABEL[this.permOf(t)], status: 'pending' } });
              continue;
            }
            if (run.depth + 1 > cfg.maxDepth) { this.postMessage(run.ch, { role: 'system', text: 'Did not call in @' + t.handle + ': the group chat reached the hand-off limit (' + cfg.maxDepth + ').' }); continue; }
            this.runner.enqueue(t.id, { ch: run.ch, kind: 'room', roomId: room.id, depth: run.depth + 1, rootId: run.rootId });
          }
        }
      }
    } else {
      if (!outcome.stopped) bot.failures = (bot.failures || 0) + 1;
      const why = outcome.stopped ? 'Stopped.' : 'Turn failed: ' + truncate(outcome.error || 'unknown error', 1500);
      if (outcome.partial && !outcome.stopped) this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: outcome.partial, meta: { partial: true, steps: run.steps.slice(-40) } });
      // Keep what the turn was given (small inputs only) so the user can retry it in one click.
      const retry = outcome.stopped ? null : run.inputs.filter((i) => ['user', 'answer', 'message', 'routine', 'system'].includes(i.kind) && JSON.stringify(i).length < 40000)
        .map(({ id: _id, seq, restarted, ...rest }) => rest);
      this.postMessage(run.ch, { role: 'system', text: why, meta: { error: !outcome.stopped, retry: retry && retry.length ? retry : undefined, botId: bot.id } });
      if (outcome.result && outcome.result.session_id && !run.newSession) bot.session.contextTokens = contextSize(outcome.result) || bot.session.contextTokens;
      // A failed first turn never created the session; make sure the next try starts clean.
      if (run.newSession) bot.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
      for (const tid of run.taskIds) {
        const t = this.tasks.get(tid);
        if (t && !isClosed(t) && !run.completed.has(tid)) this.closeTask(t, 'failed', outcome.stopped ? 'Stopped by ' + cfg.userName + '.' : 'The bot\'s turn failed: ' + truncate(outcome.error, 600));
      }
      if (routine) this.routineRan(routine, 'failed', outcome.error || 'stopped');
      if (bot.failures >= 3 && !outcome.stopped) {
        bot.paused = true;
        this.postMessage(run.ch, { role: 'system', text: bot.name + ' was paused after 3 failed turns in a row. Fix the cause, then resume it from its info pane.' });
      }
    }
    this.saveBot(bot);
  }

  // Long conversations: once a session's context passes the limit, the bot gets one turn to save
  // what it needs to memory, then its next turn starts a fresh session with memory + a chat recap.
  maybeRollSession(bot, handoffDone) {
    const cfg = this.config;
    if (handoffDone) {
      const size = bot.session.contextTokens;
      bot.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
      this.postMessage('dm:' + bot.id, { role: 'system', text: 'Session refreshed (context had reached about ' + Math.round((size || 0) / 1000) + 'k tokens). ' + bot.name + ' kept its memory and gets a recap of this chat on its next turn.', meta: { quiet: true } });
      return;
    }
    if ((bot.session.contextTokens || 0) < cfg.sessionMaxTokens) return;
    if ((bot._queue || []).some((i) => i.handoff)) return;
    const msg = this.postMessage('dm:' + bot.id, { role: 'system', text: 'Context is large (about ' + Math.round(bot.session.contextTokens / 1000) + 'k tokens). ' + bot.name + ' is saving notes before starting a fresh session.', meta: { quiet: true } });
    this.runner.enqueue(bot.id, {
      ch: 'dm:' + bot.id, kind: 'system', handoff: true, msgId: msg.id,
      text: 'Your session context is getting large, so it will restart after this turn. Your memory file carries over; this conversation will not, except for a short recap of the recent chat. Now save everything you would need to continue your work cold: open tasks and who they are with, decisions made, client and project details, preferences you learned. Use memory_add, or memory_replace to reorganize and remove stale facts. Then reply with one line saying what you saved.',
    }, { front: true });
  }

  retryTurn(ch, msgId) {
    this.checkChannel(ch);
    const m = this.channels.get(ch, msgId);
    if (!m || !m.meta || !m.meta.retry || m.meta.retried) throw httpError(409, 'Nothing to retry');
    const bot = this.bots.get(m.meta.botId);
    if (!bot) throw httpError(404, 'That bot is gone');
    if (bot.paused) { bot.paused = false; bot.failures = 0; this.saveBot(bot); }
    for (const input of m.meta.retry) this.runner.enqueue(bot.id, { ...input, ch: input.ch || ch });
    this.patchMessage(ch, msgId, { meta: { retried: true } });
    return { ok: true };
  }

  rememberMessage(ch, msgId) {
    const c = this.checkChannel(ch);
    const m = this.channels.get(ch, msgId);
    if (!m) throw httpError(404, 'No such message');
    const botId = c.kind === 'dm' ? c.bot.id : m.botId;
    if (!botId || !this.bots.has(botId)) throw httpError(400, 'Open the bot\'s own chat to save this to its memory');
    const text = (m.text || '').trim();
    if (!text) throw httpError(400, 'Nothing to remember');
    const cur = this.readMemory(botId).replace(/\s+$/, '');
    this.writeMemory(botId, (cur ? cur + '\n' : '') + '- (saved ' + new Date().toLocaleDateString() + ') ' + truncate(text.replace(/\s+/g, ' '), 2000) + '\n');
    return { ok: true, botId };
  }

  // ---------------- approvals ----------------
  requestApproval(run, toolName, input, opts = {}) {
    const bot = this.bots.get(run.botId);
    const cfg = this.config;
    if (cardSize(input) > CARD_MAX) {
      // Too big to show in full, so too big to approve.
      return Promise.resolve({ behavior: 'deny', refused: true, message: 'That is too large for the user to review on an approval card (over ' + CARD_MAX + ' characters). Split it into smaller steps, or put the content in a file in your working folder and refer to it.' });
    }
    return new Promise((resolve) => {
      const aid = id('ap_');
      const msg = this.postMessage(run.ch, {
        role: 'bot', botId: run.botId, kind: 'card',
        card: { type: 'approval', approvalId: aid, tool: opts.label || toolName, input: previewInput(input), status: 'pending', rule: opts.noRule ? '' : suggestRule(toolName, input), escalation: opts.escalation || false },
      });
      const timer = setTimeout(() => this.deferApproval(aid), Math.min(LIVE_APPROVAL_MS, cfg.approvalTimeoutMin * 60e3));
      this.approvals.set(aid, { id: aid, run, msg, toolName, input, resolve, timer, noRule: !!opts.noRule, action: opts.action || null, label: opts.label || toolName });
      run.approvals.add(aid);
      run.waiting = true;
      run.waitText = 'Waiting for your approval: ' + toolName;
      run.cardCount++;
      if (bot) { this.runner.activity(bot, run, run.activity); this.emitBot(bot); }
    });
  }

  // The bot stops waiting (Claude Code won't wait over 5 minutes); the card stays answerable.
  // Answering it later gives the bot a new turn and, if approved, a one-time permission.
  deferApproval(aid) {
    const a = this.approvals.get(aid);
    if (!a) return false;
    this.approvals.delete(aid);
    clearTimeout(a.timer);
    a.run.approvals.delete(aid);
    a.run.waiting = a.run.approvals.size > 0;
    const d = {
      id: aid, botId: a.run.botId, ch: a.run.ch, msgId: a.msg.id, toolName: a.toolName, label: a.label, input: a.input,
      noRule: a.noRule, action: a.action, createdAt: Date.now(), expiresAt: Date.now() + this.config.approvalTimeoutMin * 60e3,
    };
    this.deferred.set(aid, d);
    this.saveDeferred();
    this.patchMessage(a.run.ch, a.msg.id, { card: { status: 'later' } });
    const bot = this.bots.get(a.run.botId);
    if (bot) { this.runner.activity(bot, a.run, 'Moved on; approval still open'); this.emitBot(bot); }
    a.resolve({ behavior: 'deny', message: 'The user has not answered yet. Do not retry this now. Finish your turn: tell the user, in one line, that you are waiting for their approval of this and what it is for. The approval card stays on their screen; when they answer you will get a new turn to continue.' });
    return true;
  }

  expireApproval(aid) {
    const a = this.approvals.get(aid);
    if (!a) return;
    this.approvals.delete(aid);
    clearTimeout(a.timer);
    a.run.approvals.delete(aid);
    try { this.patchMessage(a.run.ch, a.msg.id, { card: { status: 'expired' } }); } catch {}
    a.resolve({ behavior: 'deny', message: 'Bullpen is restarting.' });
  }

  answerDeferred(d, decision) {
    this.deferred.delete(d.id);
    this.saveDeferred();
    const bot = this.bots.get(d.botId);
    const allowed = decision === 'allow' || (decision === 'always' && !d.noRule);
    this.patchMessage(d.ch, d.msgId, { card: { status: allowed ? (decision === 'always' ? 'always' : 'allowed') : 'denied' } });
    this.audit('approval', { bot: bot ? bot.name : '?', tool: d.label, decision, detail: truncate(JSON.stringify(d.input || {}), 300), note: 'answered after the bot moved on' });
    if (!bot) return;
    const what = d.label + ' ' + truncate(JSON.stringify(d.input || {}), 400);
    if (!allowed) {
      this.runner.enqueue(bot.id, { ch: d.ch, kind: 'system', text: 'The user declined your earlier request: ' + what + '. Do not do it.', roomId: d.ch.startsWith('room:') ? d.ch.slice(5) : undefined });
      return;
    }
    const roomId = d.ch.startsWith('room:') ? d.ch.slice(5) : undefined;
    if (d.action) {
      // A guarded Bullpen action: do exactly what was approved, then tell the bot.
      let done = '';
      try {
        const r = this.performAction(d.action);
        done = d.action.kind === 'delegate' ? ' Bullpen handed it off: task #' + r.id + ' is now with that teammate; its report will come to you.' : ' Bullpen has done it.';
      } catch (e) { done = ' But it could not be done: ' + e.message; }
      this.runner.enqueue(bot.id, { ch: d.ch, kind: 'system', text: 'The user approved your earlier request: ' + what + '.' + done + ' Do not repeat it.', roomId });
      return;
    }
    // A Claude Code permission: a one-time rule for exactly that action, attached to the turn that
    // carries the approval (no other turn can use it).
    let grant = '';
    if (decision === 'always') {
      const rule = suggestRule(d.toolName, d.input);
      if (rule && !bot.alwaysAllow.includes(rule)) { bot.alwaysAllow.push(rule); this.saveBot(bot); }
    } else grant = exactRule(d.toolName, d.input);
    this.runner.enqueue(bot.id, { ch: d.ch, kind: 'system', text: 'The user approved your earlier request: ' + what + '. Go ahead and do it now.', roomId, grants: grant ? [grant] : [] });
  }

  expireDeferred() {
    let changed = false;
    for (const d of [...this.deferred.values()]) {
      if (Date.now() < d.expiresAt) continue;
      this.deferred.delete(d.id);
      changed = true;
      try { this.patchMessage(d.ch, d.msgId, { card: { status: 'expired' } }); } catch {}
    }
    if (changed) this.saveDeferred();
  }

  resolveApproval(aid, decision, note) {
    const a = this.approvals.get(aid);
    if (!a) return false;
    this.approvals.delete(aid);
    clearTimeout(a.timer);
    a.run.approvals.delete(aid);
    a.run.waiting = a.run.approvals.size > 0;
    const bot = this.bots.get(a.run.botId);
    if (bot && !a.run.waiting) this.runner.activity(bot, a.run, a.toolName + ' ' + (decision === 'deny' ? 'declined' : 'approved'));
    this.audit('approval', { bot: bot ? bot.name : '?', tool: a.toolName, decision, detail: truncate(JSON.stringify(a.input || {}), 300), note: note || '' });
    if (decision === 'always' && bot && !a.noRule) {
      const rule = suggestRule(a.toolName, a.input);
      if (rule && !bot.alwaysAllow.includes(rule)) { bot.alwaysAllow.push(rule); this.saveBot(bot); }
    }
    const allowed = decision === 'allow' || (decision === 'always' && !a.noRule);
    this.patchMessage(a.run.ch, a.msg.id, { card: { status: allowed ? (decision === 'always' ? 'always' : 'allowed') : 'denied', note: note || '' } });
    if (bot) this.emitBot(bot);
    a.resolve(allowed
      ? { behavior: 'allow', updatedInput: a.input || {} }
      : { behavior: 'deny', message: 'The user declined this action' + (note ? ': ' + note : '.') + ' Do not retry it another way; explain what you needed.' });
    return true;
  }

  // ---------------- cards ----------------
  answerCard(ch, msgId, body) {
    this.checkChannel(ch);
    const m = this.channels.get(ch, msgId);
    if (!m || m.kind !== 'card') throw httpError(404, 'No such card');
    const card = m.card;
    if (card.type === 'question') {
      if (card.status === 'answered') throw httpError(409, 'Already answered');
      const picks = Array.isArray(body.choices) ? body.choices.map(String) : [];
      const typed = String(body.text || '').trim();
      const answer = [picks.join(', '), typed].filter(Boolean).join(' — ');
      if (!answer) throw httpError(400, 'Pick an option or type an answer');
      this.patchMessage(ch, msgId, { card: { status: 'answered', answer } });
      this.runner.enqueue(m.botId, { ch, kind: 'answer', question: card.question, text: answer, msgId, roomId: ch.startsWith('room:') ? ch.slice(5) : undefined });
      return { ok: true };
    }
    if (card.type === 'approval') {
      if (!['allow', 'always', 'deny'].includes(body.decision)) throw httpError(400, 'Decision must be allow, always or deny');
      const d = this.deferred.get(card.approvalId);
      if (d) { this.answerDeferred(d, body.decision); return { ok: true }; }
      if (!this.resolveApproval(card.approvalId, body.decision, body.note)) {
        if (card.status === 'pending' || card.status === 'later') this.patchMessage(ch, msgId, { card: { status: 'expired' } });
        throw httpError(409, 'This request is no longer waiting (the turn ended).');
      }
      return { ok: true };
    }
    if (card.type === 'routine') {
      const r = this.routines.get(card.routineId);
      if (!r) { this.patchMessage(ch, msgId, { card: { status: 'deleted' } }); throw httpError(404, 'Routine is gone'); }
      if (body.decision === 'approve') {
        r.pendingApproval = false; r.enabled = true; r.nextRunAt = nextRun(r.schedule, Date.now(), null);
        this.patchMessage(ch, msgId, { card: { status: 'approved' } });
      } else {
        this.routines.delete(r.id);
        this.patchMessage(ch, msgId, { card: { status: 'declined' } });
      }
      this.saveRoutines();
      this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
      return { ok: true };
    }
    if (card.type === 'callin') {
      if (card.status !== 'pending') throw httpError(409, 'Already decided');
      const t = this.bots.get(card.botId);
      const room = this.rooms.get(card.roomId);
      const ok = body.decision === 'approve' && t && room && room.members.includes(t.id);
      this.patchMessage(ch, msgId, { card: { status: ok ? 'approved' : 'declined' } });
      this.audit('escalation', { bot: (this.bots.get(card.fromBotId) || {}).name || '?', tool: 'call in ' + (t ? t.name : '?') + ' (' + card.perm + ')', decision: ok ? 'allow' : 'deny' });
      if (ok) this.runner.enqueue(t.id, { ch, kind: 'room', roomId: room.id, depth: card.depth, rootId: card.rootId });
      return { ok: true };
    }
    throw httpError(400, 'This card has no actions');
  }

  // ---------------- memory / skills ----------------
  memFile(botId) { return botId ? path.join('bots', botId, 'memory.md') : path.join('shared', 'memory.md'); }
  readMemory(botId) { return this.store.readText(this.memFile(botId), ''); }
  writeMemory(botId, text) {
    if (botId && !this.bots.has(botId)) throw httpError(404, 'No such bot');
    this.store.writeText(this.memFile(botId), String(text || ''));
    this.emit('ev', { type: 'memory', botId: botId || null });
  }

  listSkills() {
    return this.store.list('skills').filter((f) => f.endsWith('.md')).map((f) => {
      const s = parseSkill(this.store.readText(path.join('skills', f)));
      return { slug: f.slice(0, -3), name: s.name || f.slice(0, -3), description: s.description || '', updated: s.updated || '' };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  readSkill(name) {
    const slug = slugify(name, 'skill');
    const raw = this.store.readText(path.join('skills', slug + '.md'), null);
    if (raw == null) {
      const hit = this.listSkills().find((s) => s.name.toLowerCase() === String(name).toLowerCase());
      if (!hit) return null;
      return { slug: hit.slug, ...parseSkill(this.store.readText(path.join('skills', hit.slug + '.md'))) };
    }
    return { slug, ...parseSkill(raw) };
  }

  saveSkill({ name, description, body }, prevSlug) {
    name = String(name || '').trim();
    if (!name) throw httpError(400, 'A skill needs a name');
    const slug = slugify(name, 'skill');
    const prev = prevSlug ? slugify(prevSlug, '') : '';
    if (prev && prev !== slug) this.store.remove(path.join('skills', prev + '.md'));
    const text = '---\nname: ' + name.replace(/\n/g, ' ') + '\ndescription: ' + String(description || '').replace(/\n/g, ' ') + '\nupdated: ' + new Date().toISOString() + '\n---\n\n' + String(body || '').trim() + '\n';
    this.store.writeText(path.join('skills', slug + '.md'), text);
    this.emit('ev', { type: 'skills', skills: this.listSkills() });
    return slug;
  }

  deleteSkill(slug) {
    this.store.remove(path.join('skills', slugify(slug, 'skill') + '.md'));
    this.emit('ev', { type: 'skills', skills: this.listSkills() });
  }

  // ---------------- pages / files ----------------
  savePage({ title, content, format, pageId, botId }) {
    format = format === 'markdown' ? 'markdown' : 'html';
    let p = pageId && this.pages.get(pageId);
    const now = Date.now();
    if (!p) { p = { id: id('pg_'), createdAt: now, botId }; this.pages.set(p.id, p); }
    Object.assign(p, { title: truncate(String(title || 'Untitled'), 120), format, updatedAt: now, botId: p.botId || botId, size: String(content || '').length });
    this.store.writeText(path.join('pages', p.id + (format === 'markdown' ? '.md' : '.html')), String(content || ''));
    const other = path.join('pages', p.id + (format === 'markdown' ? '.html' : '.md'));
    if (this.store.exists(other)) this.store.remove(other);
    this.savePages();
    this.emit('ev', { type: 'page', page: p });
    return p;
  }

  deletePage(pid) {
    const p = this.pages.get(pid);
    if (!p) throw httpError(404, 'No such page');
    this.pages.delete(pid);
    this.store.remove(path.join('pages', pid + '.html'));
    this.store.remove(path.join('pages', pid + '.md'));
    this.savePages();
    this.emit('ev', { type: 'page:removed', id: pid });
  }

  fileById(fid) { return Object.prototype.hasOwnProperty.call(this.files, fid) && /^f_[a-z0-9]+$/.test(fid) ? this.files[fid] : null; }

  addFile({ name, src, data, botId, kind }) {
    const fid = id('f_');
    const safe = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const rel = path.join('files', fid, safe);
    fs.mkdirSync(this.store.p('files', fid), { recursive: true });
    if (src) fs.copyFileSync(src, this.store.p(rel)); else fs.writeFileSync(this.store.p(rel), data);
    const size = fs.statSync(this.store.p(rel)).size;
    this.files[fid] = { id: fid, name: safe, rel, size, botId: botId || null, kind: kind || 'upload', createdAt: Date.now() };
    this.saveFiles();
    return this.files[fid];
  }

  // ---------------- rooms ----------------
  createRoom({ name, members }) {
    const r = { id: id('r_'), name: truncate(String(name || 'Group chat').trim() || 'Group chat', 60), members: (members || []).filter((m) => this.bots.has(m)), createdAt: Date.now(), unread: 0 };
    this.rooms.set(r.id, r);
    this.saveRooms();
    this.emit('ev', { type: 'room', room: r });
    return r;
  }

  updateRoom(rid, { name, members }) {
    const r = this.rooms.get(rid);
    if (!r) throw httpError(404, 'No such group chat');
    if (name !== undefined) r.name = truncate(String(name).trim() || r.name, 60);
    if (members !== undefined) r.members = members.filter((m) => this.bots.has(m));
    this.saveRooms();
    this.emit('ev', { type: 'room', room: r });
    return r;
  }

  deleteRoom(rid) {
    if (!this.rooms.has(rid)) throw httpError(404, 'No such group chat');
    this.rooms.delete(rid);
    this.forgetChannel('room:' + rid);
    this.channels.trash('room:' + rid);
    for (const b of this.bots.values()) {
      const before = (b._queue || []).length;
      const kept = [];
      for (const i of b._queue || []) {
        if (i.ch !== 'room:' + rid) kept.push(i);
        else if (i.kind === 'report' || i.kind === 'task') kept.push({ ...i, ch: 'dm:' + b.id, roomId: undefined }); // still owed an answer
      }
      b._queue = kept;
      if (b._queue.length !== before || kept.some((i) => i.ch === 'dm:' + b.id)) { this.runner.saveQueue(b); this.emitBot(b); }
    }
    this.saveRooms();
    this.emit('ev', { type: 'room:removed', id: rid });
  }

  // ---------------- routines ----------------
  createRoutine({ botId, title, instructions, schedule, notify, createdBy, pending }) {
    if (!this.bots.has(botId)) throw httpError(400, 'Pick a bot for this routine');
    const sched = validateSchedule(schedule);
    const r = {
      id: id('rt_'), botId, title: truncate(String(title || 'Routine').trim(), 80), instructions: String(instructions || '').trim(),
      schedule: sched, notify: notify === 'always' ? 'always' : 'smart', enabled: !pending, pendingApproval: !!pending,
      secret: token().slice(0, 32), createdBy: createdBy || 'user', createdAt: Date.now(), lastRunAt: 0, nextRunAt: 0, runs: [],
    };
    if (!r.instructions) throw httpError(400, 'A routine needs instructions');
    r.nextRunAt = r.enabled ? nextRun(sched, Date.now(), null) : 0;
    this.routines.set(r.id, r);
    this.saveRoutines();
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
    return r;
  }

  updateRoutine(rid, f) {
    const r = this.routines.get(rid);
    if (!r) throw httpError(404, 'No such routine');
    if (f.title !== undefined) r.title = truncate(String(f.title).trim() || r.title, 80);
    if (f.instructions !== undefined) r.instructions = String(f.instructions).trim() || r.instructions;
    if (f.botId !== undefined && this.bots.has(f.botId)) r.botId = f.botId;
    if (f.notify !== undefined) r.notify = f.notify === 'always' ? 'always' : 'smart';
    if (f.schedule !== undefined) r.schedule = validateSchedule(f.schedule);
    if (f.enabled !== undefined) { r.enabled = !!f.enabled; if (r.enabled) r.pendingApproval = false; }
    // A one-time routine that already ran is re-armed by editing or resuming it.
    const last = r.schedule.type === 'once' && (f.schedule !== undefined || f.enabled) ? 0 : r.lastRunAt;
    r.nextRunAt = r.enabled ? nextRun(r.schedule, Date.now(), last) : 0;
    this.saveRoutines();
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
    return r;
  }

  deleteRoutine(rid) {
    if (!this.routines.delete(rid)) throw httpError(404, 'No such routine');
    this.saveRoutines();
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
  }

  fireRoutine(r, payload) {
    if (payload && r.schedule.type === 'webhook') this.audit('webhook', { detail: r.title + ' (' + payload.length + ' bytes)' });
    const msg = this.postMessage('dm:' + r.botId, {
      role: 'incoming', text: payload ? (r.schedule.type === 'folder' ? payload : 'Webhook event received.') : r.instructions,
      meta: { label: 'Routine: ' + r.title, routineId: r.id, quiet: true },
    });
    this.runner.enqueue(r.botId, { ch: 'dm:' + r.botId, kind: 'routine', routineId: r.id, payload: payload || '', msgId: msg.id });
    r.lastRunAt = Date.now();
    r.nextRunAt = r.enabled && r.schedule.type !== 'once' ? nextRun(r.schedule, Date.now(), r.lastRunAt) : 0;
    if (r.schedule.type === 'once') r.enabled = false;
    this.saveRoutines();
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
  }

  routineRan(r, status, text) {
    r.runs = [{ ts: Date.now(), status, summary: truncate(String(text || '').replace(/\s+/g, ' '), 240) }, ...(r.runs || [])].slice(0, 30);
    this.saveRoutines();
    this.emit('ev', { type: 'routines', routines: [...this.routines.values()].map((x) => this.publicRoutine(x)) });
  }

  // ---------------- config ----------------
  updateConfig(f) {
    const c = this.config;
    const prev = { ...c };
    if (f.userName !== undefined) c.userName = truncate(String(f.userName).trim(), 60) || c.userName;
    if (f.theme !== undefined && ['system', 'light', 'dark'].includes(f.theme)) c.theme = f.theme;
    if (f.accent !== undefined && /^#[0-9a-f]{6}$/i.test(f.accent)) c.accent = f.accent;
    if (f.claudePath !== undefined) { c.claudePath = String(f.claudePath).trim(); cli.detect(c.claudePath, { force: true }); }
    if (f.defaultModel !== undefined) c.defaultModel = String(f.defaultModel).trim().slice(0, 80) || 'opus';
    if (f.defaultPermission !== undefined && PERMISSIONS.includes(f.defaultPermission)) c.defaultPermission = f.defaultPermission;
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (f[k] !== undefined) c[k] = clampInt(f[k], lo, hi, c[k]);
    if (f.paused !== undefined) c.paused = !!f.paused;
    if (f.mcpTransport !== undefined && ['http', 'stdio'].includes(f.mcpTransport)) c.mcpTransport = f.mcpTransport;
    if (Array.isArray(f.sections)) c.sections = f.sections.map((s) => truncate(String(s), 40)).filter(Boolean).slice(0, 50);
    if (Array.isArray(f.collapsed)) c.collapsed = f.collapsed.map(String).slice(0, 50);
    if (f.escalationGuard !== undefined) c.escalationGuard = !!f.escalationGuard;
    if (f.lowPriority !== undefined) c.lowPriority = !!f.lowPriority;
    const watched = ['claudePath', 'defaultPermission', 'defaultModel', 'mcpTransport', 'escalationGuard', ...Object.keys(LIMITS)];
    const diff = watched.filter((k) => f[k] !== undefined && String(prev[k]) !== String(c[k])).map((k) => k + ': ' + prev[k] + ' → ' + c[k]);
    if (diff.length) this.audit('settings.changed', { detail: diff.join('; ') });
    this.saveConfig();
    this.emit('ev', { type: 'config', config: c, cli: this.publicState().cli });
    if (!c.paused) this.runner.kick();
    return c;
  }
}

// ---------------- helpers ----------------
function guessName() {
  try { const n = os.userInfo().username; return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'You'; } catch { return 'You'; }
}

function isClosed(t) { return ['done', 'failed', 'cancelled'].includes(t.status); }

function contextSize(r) {
  const it = r && r.usage && Array.isArray(r.usage.iterations) && r.usage.iterations[r.usage.iterations.length - 1];
  const u = it || (r && r.usage) || {};
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function pickBotFields(f) {
  const out = {};
  const s = (k, n) => { if (f[k] !== undefined) out[k] = truncate(String(f[k] == null ? '' : f[k]), n); };
  s('name', 60); s('title', 80); s('description', 1000); s('avatar', 8); s('section', 40);
  s('model', 80); s('effort', 10); s('cwd', 1000); s('instructions', 20000);
  if (f.dailyBudgetUsd !== undefined) { const n = Number(f.dailyBudgetUsd); out.dailyBudgetUsd = Number.isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : 0; }
  if (f.color !== undefined && /^#[0-9a-f]{6}$/i.test(f.color)) out.color = f.color;
  if (f.permission !== undefined) out.permission = PERMISSIONS.includes(f.permission) ? f.permission : '';
  for (const k of ['hidden', 'primary', 'notify', 'paused', 'useMyClaudeSettings', 'trustFolderSettings']) if (f[k] !== undefined) out[k] = !!f[k];
  if (f.alwaysAllow !== undefined) out.alwaysAllow = (Array.isArray(f.alwaysAllow) ? f.alwaysAllow : String(f.alwaysAllow).split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
  if (f.mcpServers !== undefined) {
    let v = f.mcpServers;
    if (typeof v === 'string') { try { v = v.trim() ? JSON.parse(v) : {}; } catch { throw httpError(400, 'Extra MCP servers must be valid JSON'); } }
    if (v && v.mcpServers) v = v.mcpServers;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'Extra MCP servers must be a JSON object of servers');
    delete v.bullpen;
    out.mcpServers = v;
  }
  return out;
}

function normalizeBot(b) {
  b.name = String(b.name || '').trim() || 'New bot';
  b.title = b.title || '';
  b.description = b.description || '';
  b.avatar = b.avatar || '🤖';
  b.color = b.color || COLORS[0];
  b.section = b.section || '';
  b.hidden = !!b.hidden;
  b.primary = !!b.primary;
  b.model = b.model || '';
  b.effort = b.effort || '';
  b.cwd = b.cwd || '';
  b.permission = PERMISSIONS.includes(b.permission) ? b.permission : '';
  b.alwaysAllow = Array.isArray(b.alwaysAllow) ? b.alwaysAllow : [];
  b.useMyClaudeSettings = !!b.useMyClaudeSettings;
  b.trustFolderSettings = !!b.trustFolderSettings;
  b.mcpServers = b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers : {};
  b.instructions = b.instructions || '';
  b.notify = b.notify !== false;
  b.dailyBudgetUsd = Number(b.dailyBudgetUsd) > 0 ? Number(b.dailyBudgetUsd) : 0;
  delete b.grants;
  delete b.escalationGrants;
  b.paused = !!b.paused;
  b.session = b.session && typeof b.session === 'object' ? b.session : { id: '', turns: 0, ctx: {}, startedAt: 0 };
  b.stats = b.stats || { turns: 0, costUsd: 0 };
  b.unread = b.unread || 0;
  b.createdAt = b.createdAt || Date.now();
  b.updatedAt = b.updatedAt || b.createdAt;
  return b;
}

// What an approval card shows. Everything that will be done is shown, in full, up to a hard cap;
// anything larger is refused outright (see requestApproval) rather than shown in part.
const CARD_MAX = 100000;
function cardSize(input) { return Object.values(input || {}).reduce((n, v) => n + (typeof v === 'string' ? v.length : JSON.stringify(v).length), 0); }
function previewInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

// Claude Code permission rules for "Always allow", scoped as narrowly as is still useful:
// one exact command, one web domain, or one folder (absolute paths are written //path, and
// Windows drives as //c/...).
function rulePath(p) {
  if (!p) return '';
  let d = String(p).replace(/\\/g, '/');
  if (d.startsWith('//')) return ''; // network shares and \\?\ paths: never offered as rules
  const m = /^([a-zA-Z]):\/?(.*)$/.exec(d);
  if (m) d = '/' + m[1].toLowerCase() + '/' + m[2];
  if (!d.startsWith('/')) return '';
  d = path.posix.normalize(d);
  return d.replace(/\/+$/, '') || '/';
}
// Folders too broad to grant wholesale: the filesystem root, a drive, a top-level folder such as
// /Users, and the home folder itself (it holds shell startup files and autostart folders).
function tooBroad(d) {
  const fold = process.platform === 'linux' ? (x) => x : (x) => x.toLowerCase(); // macOS and Windows ignore case
  const home = fold(rulePath(os.homedir()));
  const parts = d.split('/').filter(Boolean);
  const isDrive = /^[a-z]$/i.test(parts[0] || ''); // Windows drives are written /c/...
  return d === '/' || parts.length < (isDrive ? 3 : 2) || fold(d) === home || home.startsWith(fold(d) + '/');
}
function ruleDir(p) {
  const d = rulePath(p);
  if (!d || tooBroad(d)) return '';
  return '/' + d + '/**';
}
// One-time permission for exactly what was approved after the bot moved on.
function exactRule(tool, input) {
  input = input || {};
  if (tool === 'Bash' || tool === 'PowerShell') { const c = String(input.command || '').trim(); return c && !/[*\r\n]/.test(c) ? tool + '(' + c + ')' : ''; }
  if (tool === 'WebFetch') { try { return 'WebFetch(domain:' + new URL(input.url).hostname + ')'; } catch { return ''; } }
  const f = input.file_path || input.notebook_path;
  if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) {
    const p = rulePath(f || input.path);
    if (!p || p === '/') return '';
    if (!f && tooBroad(p)) return ''; // a search of a whole drive or home folder: ask again live instead
    return 'Read(/' + p + (f ? '' : '/**') + ')';
  }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) { const p = rulePath(f); return p && p !== '/' ? 'Edit(/' + p + ')' : ''; }
  if (tool.startsWith('mcp__')) return tool;
  return '';
}

function suggestRule(tool, input) {
  input = input || {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = String(input.command || '').trim();
    // "*" would turn the rule into a wildcard, and multi-line commands can't be matched safely.
    return c && !/[*\r\n]/.test(c) ? tool + '(' + c + ')' : '';
  }
  if (tool === 'WebFetch') { try { return 'WebFetch(domain:' + new URL(input.url).hostname + ')'; } catch { return ''; } }
  if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) {
    const target = input.file_path ? path.dirname(String(input.file_path)) : input.path;
    const dir = ruleDir(target);
    if (dir) return 'Read(' + dir + ')';
    const exact = input.file_path ? rulePath(input.file_path) : '';
    return exact && exact !== '/' ? 'Read(/' + exact + ')' : '';
  }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    const f = input.file_path || input.notebook_path;
    const dir = f ? ruleDir(path.dirname(String(f))) : '';
    if (dir) return 'Edit(' + dir + ')';
    const exact = f ? rulePath(f) : '';
    return exact && exact !== '/' ? 'Edit(/' + exact + ')' : '';
  }
  if (tool.startsWith('mcp__')) return tool;
  return '';
}

function parseSkill(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(raw || ''));
  if (!m) return { name: '', description: '', body: String(raw || '') };
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { name: meta.name || '', description: meta.description || '', updated: meta.updated || '', body: m[2].trim() };
}

function validateSchedule(s) {
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { throw httpError(400, 'Schedule must be an object'); } }
  if (!s || typeof s !== 'object') throw httpError(400, 'Missing schedule');
  const type = s.type;
  if (type === 'daily') {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.time || ''))) throw httpError(400, 'Daily routines need a time like 08:30');
    const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
    return { type, time: String(s.time).padStart(5, '0'), days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
  }
  if (type === 'interval') return { type, minutes: clampInt(s.minutes, 15, 60 * 24 * 7, 60) };
  if (type === 'once') {
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(t)) throw httpError(400, 'One-time routines need a date and time');
    return { type, at: s.at };
  }
  if (type === 'webhook') return { type };
  if (type === 'folder') {
    const p = String(s.path || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
    let st = null;
    try { st = fs.statSync(p); } catch {}
    if (!p || !st || !st.isDirectory()) throw httpError(400, 'Folder routines need an existing folder');
    return { type, path: path.resolve(p) };
  }
  throw httpError(400, 'Schedule type must be daily, interval, once, webhook or folder');
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { App, httpError, isClosed, suggestRule, exactRule, ruleDir, validateSchedule, PERMISSIONS, PERM_LABEL };
