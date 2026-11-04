'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Store, Channels } = require('./store');
const { Runner } = require('./runner');
const { Scheduler, describeSchedule, nextRun } = require('./scheduler');
const cli = require('./claude-cli');
const { id, token, slugify, truncate, clampInt, localDateKey, timeZone, mentions } = require('./util');

const PERMISSIONS = ['ask', 'edits', 'auto', 'full', 'readonly'];
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
  approvalTimeoutMin: 30,
  paused: false,
  sections: [],
  collapsed: [],
};

const LIMITS = {
  maxConcurrent: [1, 8], maxTurnsPerDay: [1, 5000], maxTurnsPerBotHour: [1, 500], maxDepth: [1, 10],
  maxChainTurns: [2, 500], turnTimeoutMin: [2, 240], maxToolTurns: [5, 500], approvalTimeoutMin: [1, 720],
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
  saveBot(b) { const { _queue, _inflight, _blocked, ...rest } = b; this.store.writeJSON(path.join('bots', b.id, 'bot.json'), rest); }
  saveRooms() { this.store.writeJSON('rooms.json', [...this.rooms.values()]); }
  saveTasks() {
    // Keep every open task and the most recent 1500 closed ones.
    const all = [...this.tasks.values()].sort((a, b) => a.id - b.id);
    const closed = all.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
    const drop = new Set(closed.slice(0, Math.max(0, closed.length - 1500)).map((t) => t.id));
    for (const idn of drop) this.tasks.delete(idn);
    this.store.writeJSON('tasks.json', all.filter((t) => !drop.has(t.id)));
  }
  saveRoutines() { this.store.writeJSON('routines.json', [...this.routines.values()]); }
  savePages() { this.store.writeJSON('pages.json', [...this.pages.values()]); }
  saveFiles() { this.store.writeJSON('files.json', this.files); }

  // ---------------- events ----------------
  publicBot(b) {
    const { _queue, _inflight, _blocked, ...rest } = b;
    return { ...rest, status: this.runner.status(b), routines: [...this.routines.values()].filter((r) => r.botId === b.id).length };
  }
  emitBot(b) { this.emit('ev', { type: 'bot', bot: this.publicBot(b) }); }

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
    if (!this.store.exists(path.join('bots', b.id, 'memory.md'))) this.store.writeText(path.join('bots', b.id, 'memory.md'), '');
    this.emitBot(b);
    this.teamChanged();
    return b;
  }

  updateBot(botId, fields) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    const f = pickBotFields(fields);
    const before = { name: b.name, cwd: b.cwd };
    Object.assign(b, f);
    normalizeBot(b);
    if (fields.handle !== undefined || f.name !== before.name) b.handle = this.uniqueHandle(fields.handle || b.handle || b.name, b.id);
    if (f.primary === true) for (const o of this.bots.values()) if (o.id !== b.id && o.primary) { o.primary = false; this.saveBot(o); this.emitBot(o); }
    if (!this.primaryBot()) b.primary = true;
    // Claude Code keys sessions by working folder; a new folder means a new session.
    if (f.cwd !== undefined && path.resolve(this.botCwd({ ...b, cwd: before.cwd })) !== path.resolve(this.botCwd(b))) {
      b.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
    }
    b.updatedAt = Date.now();
    this.saveBot(b);
    this.emitBot(b);
    this.teamChanged();
    if (f.paused === false) this.runner.kick();
    return b;
  }

  deleteBot(botId) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    this.runner.stop(botId);
    this.bots.delete(botId);
    this.store.trash(path.join('bots', botId));
    this.channels.cache.delete('dm:' + botId);
    this.store.trash(this.channels.file('dm:' + botId));
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

  resetSession(botId) {
    const b = this.bots.get(botId);
    if (!b) throw httpError(404, 'No such bot');
    b.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
    this.saveBot(b);
    this.postMessage('dm:' + b.id, { role: 'system', text: 'Started a fresh session. The bot keeps its memory and gets the recent chat as a recap on its next turn.' });
    this.emitBot(b);
  }

  teamChanged() { /* prompts pick up the roster on each turn via context hashes */ }

  // ---------------- messages ----------------
  postMessage(ch, m) {
    const msg = { id: id('m_'), ts: Date.now(), ch, kind: 'text', ...m };
    this.channels.add(ch, msg);
    if (['bot', 'incoming', 'system'].includes(msg.role) && !(msg.meta && msg.meta.quiet)) this.bumpUnread(ch);
    this.emit('ev', { type: 'message', ch, msg });
    return msg;
  }

  patchMessage(ch, msgId, set) {
    const m = this.channels.patch(ch, msgId, set);
    if (m) this.emit('ev', { type: 'message:update', ch, msg: m });
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
    const files = (fileIds || []).map((fid) => this.files[fid]).filter(Boolean)
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
    if (item.kind === 'task') { const t = this.tasks.get(item.taskId); if (t && !isClosed(t)) this.updateTask(t.id, { status: 'failed', result: 'Not run: the request chain hit its turn budget.' }); }
  }

  // ---------------- end of a turn ----------------
  turnFinished(bot, run, outcome) {
    const cfg = this.config;
    const day = localDateKey();
    const u = this.usage[day] || (this.usage[day] = { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byBot: {} });
    const r = outcome.result || {};
    const cost = Number(r.total_cost_usd) || 0;
    u.turns++;
    u.costUsd += cost;
    if (r.usage) { u.inputTokens += (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0); u.outputTokens += r.usage.output_tokens || 0; }
    u.byBot[bot.id] = (u.byBot[bot.id] || 0) + 1;
    const keys = Object.keys(this.usage).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete this.usage[k];
    this.store.writeJSON('usage.json', this.usage);
    this.emit('ev', { type: 'usage', today: u });

    const routineInput = run.inputs.find((i) => i.kind === 'routine');
    const routine = routineInput && this.routines.get(routineInput.routineId);

    if (outcome.ok) {
      // Keep the session going.
      bot.session = {
        id: run.sessionId,
        turns: (run.newSession ? 0 : bot.session.turns || 0) + 1,
        startedAt: run.newSession ? Date.now() : bot.session.startedAt || Date.now(),
        ctx: run.ctx,
        contextTokens: contextSize(r),
      };
      bot.stats = { turns: (bot.stats.turns || 0) + 1, costUsd: (bot.stats.costUsd || 0) + cost };
      bot.lastActiveAt = Date.now();
      bot.failures = 0;
      const text = String(outcome.text || '').trim();
      const quiet = routine && routine.notify !== 'always' && /^NO_UPDATE\b/.test(text);
      const meta = { steps: run.steps.slice(-40), costUsd: cost, ms: Date.now() - run.startedAt, model: bot.model || cfg.defaultModel };
      if (quiet) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: 'Routine "' + routine.title + '" ran — nothing to report.', meta: { ...meta, quiet: true } });
      } else if (text) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text, meta });
      } else if (!run.cardCount) {
        this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: '_(finished without a reply)_', meta });
      }
      for (const tid of run.taskIds) {
        const t = this.tasks.get(tid);
        if (!t || isClosed(t) || run.completed.has(tid)) continue;
        if (run.held.has(tid)) { this.updateTask(tid, { status: 'held' }); continue; }
        this.closeTask(t, 'done', text || '(finished without a written report)');
      }
      if (routine) this.routineRan(routine, quiet ? 'quiet' : 'ok', text);
      // Group chat: bring in teammates the bot @mentioned.
      if (run.ch.startsWith('room:') && text) {
        const room = this.rooms.get(run.ch.slice(5));
        if (room) {
          const targets = mentions(text).map((h) => this.botByHandle(h)).filter((b) => b && b.id !== bot.id && room.members.includes(b.id));
          for (const t of targets) {
            if (run.depth + 1 > cfg.maxDepth) { this.postMessage(run.ch, { role: 'system', text: 'Did not call in @' + t.handle + ': the group chat reached the hand-off limit (' + cfg.maxDepth + ').' }); continue; }
            this.runner.enqueue(t.id, { ch: run.ch, kind: 'room', roomId: room.id, depth: run.depth + 1, rootId: run.rootId });
          }
        }
      }
    } else {
      bot.failures = (bot.failures || 0) + 1;
      const why = outcome.stopped ? 'Stopped.' : 'Turn failed: ' + truncate(outcome.error || 'unknown error', 1500);
      if (outcome.partial && !outcome.stopped) this.postMessage(run.ch, { role: 'bot', botId: bot.id, text: outcome.partial, meta: { partial: true, steps: run.steps.slice(-40) } });
      this.postMessage(run.ch, { role: 'system', text: why, meta: { error: !outcome.stopped } });
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

  // ---------------- approvals ----------------
  requestApproval(run, toolName, input) {
    const bot = this.bots.get(run.botId);
    const cfg = this.config;
    return new Promise((resolve) => {
      const aid = id('ap_');
      const msg = this.postMessage(run.ch, {
        role: 'bot', botId: run.botId, kind: 'card',
        card: { type: 'approval', approvalId: aid, tool: toolName, input: previewInput(input), status: 'pending', rule: suggestRule(toolName, input) },
      });
      const timer = setTimeout(() => this.resolveApproval(aid, 'deny', 'No answer within ' + cfg.approvalTimeoutMin + ' minutes.'), cfg.approvalTimeoutMin * 60e3);
      this.approvals.set(aid, { id: aid, run, msg, toolName, input, resolve, timer });
      run.approvals.add(aid);
      run.waiting = true;
      run.cardCount++;
      if (bot) { this.runner.activity(bot, run, 'Waiting for your approval: ' + toolName); this.emitBot(bot); }
    });
  }

  resolveApproval(aid, decision, note) {
    const a = this.approvals.get(aid);
    if (!a) return false;
    this.approvals.delete(aid);
    clearTimeout(a.timer);
    a.run.approvals.delete(aid);
    a.run.waiting = a.run.approvals.size > 0;
    const bot = this.bots.get(a.run.botId);
    if (decision === 'always' && bot) {
      const rule = suggestRule(a.toolName, a.input);
      if (rule && !bot.alwaysAllow.includes(rule)) { bot.alwaysAllow.push(rule); this.saveBot(bot); }
    }
    const allowed = decision === 'allow' || decision === 'always';
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
      if (!this.resolveApproval(card.approvalId, body.decision, body.note)) {
        if (card.status === 'pending') this.patchMessage(ch, msgId, { card: { status: 'expired' } });
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
    if (prevSlug && prevSlug !== slug) this.store.remove(path.join('skills', prevSlug + '.md'));
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
    this.channels.cache.delete('room:' + rid);
    this.store.trash(this.channels.file('room:' + rid));
    for (const b of this.bots.values()) {
      const before = (b._queue || []).length;
      b._queue = (b._queue || []).filter((i) => i.ch !== 'room:' + rid);
      if (b._queue.length !== before) { this.runner.saveQueue(b); this.emitBot(b); }
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
    r.nextRunAt = r.enabled ? nextRun(r.schedule, Date.now(), r.lastRunAt) : 0;
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
    const msg = this.postMessage('dm:' + r.botId, {
      role: 'incoming', text: payload ? 'Webhook event received.' : r.instructions,
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
    if (f.userName !== undefined) c.userName = truncate(String(f.userName).trim(), 60) || c.userName;
    if (f.theme !== undefined && ['system', 'light', 'dark'].includes(f.theme)) c.theme = f.theme;
    if (f.accent !== undefined && /^#[0-9a-f]{6}$/i.test(f.accent)) c.accent = f.accent;
    if (f.claudePath !== undefined) { c.claudePath = String(f.claudePath).trim(); cli.detect(c.claudePath, { force: true }); }
    if (f.defaultModel !== undefined) c.defaultModel = String(f.defaultModel).trim().slice(0, 80) || 'opus';
    if (f.defaultPermission !== undefined && PERMISSIONS.includes(f.defaultPermission)) c.defaultPermission = f.defaultPermission;
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (f[k] !== undefined) c[k] = clampInt(f[k], lo, hi, c[k]);
    if (f.paused !== undefined) c.paused = !!f.paused;
    if (Array.isArray(f.sections)) c.sections = f.sections.map((s) => truncate(String(s), 40)).filter(Boolean).slice(0, 50);
    if (Array.isArray(f.collapsed)) c.collapsed = f.collapsed.map(String).slice(0, 50);
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
  if (f.color !== undefined && /^#[0-9a-f]{6}$/i.test(f.color)) out.color = f.color;
  if (f.permission !== undefined) out.permission = PERMISSIONS.includes(f.permission) ? f.permission : '';
  for (const k of ['hidden', 'primary', 'notify', 'paused', 'useMyClaudeSettings']) if (f[k] !== undefined) out[k] = !!f[k];
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
  b.mcpServers = b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers : {};
  b.instructions = b.instructions || '';
  b.notify = b.notify !== false;
  b.paused = !!b.paused;
  b.session = b.session && typeof b.session === 'object' ? b.session : { id: '', turns: 0, ctx: {}, startedAt: 0 };
  b.stats = b.stats || { turns: 0, costUsd: 0 };
  b.unread = b.unread || 0;
  b.createdAt = b.createdAt || Date.now();
  b.updatedAt = b.updatedAt || b.createdAt;
  return b;
}

function previewInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    out[k] = typeof v === 'string' ? truncate(v, 4000) : truncate(JSON.stringify(v), 2000);
  }
  return out;
}

function suggestRule(tool, input) {
  if (tool === 'Bash' || tool === 'PowerShell') return input && input.command ? tool + '(' + String(input.command).trim() + ')' : '';
  if (tool === 'WebFetch' && input && input.url) { try { return 'WebFetch(domain:' + new URL(input.url).hostname + ')'; } catch { return ''; } }
  return tool;
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
  throw httpError(400, 'Schedule type must be daily, interval, once or webhook');
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { App, httpError, isClosed, suggestRule, validateSchedule, PERMISSIONS };
