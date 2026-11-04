'use strict';
// The turn engine. Each bot has an inbox; one turn = one `claude -p` run that resumes the bot's
// session with every waiting input for the same chat. Bots run one turn at a time each, a few
// bots in parallel, under daily / hourly / chain budgets so bots talking to bots can't run away.
const fs = require('fs');
const path = require('path');
const cli = require('./claude-cli');
const P = require('./prompt');
const { id, token, truncate, localDateKey } = require('./util');

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch'];
const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'KillShell', 'KillBash'];
// Interactive-only tools that make no sense for a bot (Bullpen has its own question cards).
const NEVER = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'];

class Runner {
  constructor(app) {
    this.app = app;
    this.running = new Map(); // botId -> run
    this.byToken = new Map(); // token -> run
    this.chainTurns = new Map(); // rootId -> turns used
    this.hourly = new Map(); // botId -> [timestamps]
    this.timer = null;
    this.lastTickAt = 0;
  }

  // ---------- queue ----------
  queueFile(botId) { return path.join('bots', botId, 'queue.json'); }

  loadQueue(bot) {
    const q = this.app.store.readJSON(this.queueFile(bot.id), { queue: [], inflight: [] });
    bot._queue = Array.isArray(q.queue) ? q.queue : [];
    // Anything in flight when the app stopped goes back to the front, flagged.
    if (Array.isArray(q.inflight) && q.inflight.length) {
      bot._queue = q.inflight.map((i) => ({ ...i, restarted: true })).concat(bot._queue);
    }
    bot._inflight = [];
    this.saveQueue(bot);
  }

  saveQueue(bot) {
    this.app.store.writeJSON(this.queueFile(bot.id), { queue: bot._queue || [], inflight: bot._inflight || [] });
  }

  enqueue(botId, input) {
    const bot = this.app.bots.get(botId);
    if (!bot) return null;
    const item = { id: id('in_'), ts: Date.now(), depth: 0, ...input };
    if (!item.rootId) item.rootId = id('root_');
    bot._queue = bot._queue || [];
    bot._queue.push(item);
    this.saveQueue(bot);
    this.app.emitBot(bot);
    this.kick();
    return item;
  }

  kick() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, 25);
  }

  status(bot) {
    const run = this.running.get(bot.id);
    if (run) return { state: run.waiting ? 'waiting' : 'working', activity: (run.waiting ? run.waitText : run.activity) || '', since: run.startedAt, runId: run.id, ch: run.ch, queued: (bot._queue || []).length };
    const queued = (bot._queue || []).length;
    if (bot.paused) return { state: 'paused', queued };
    if (queued) return { state: 'queued', queued, why: bot._blocked || '' };
    return { state: 'idle' };
  }

  // ---------- budgets ----------
  turnsToday() {
    const u = this.app.usage[localDateKey()];
    return u ? u.turns : 0;
  }

  hourCount(botId) {
    const now = Date.now();
    const arr = (this.hourly.get(botId) || []).filter((t) => now - t < 3600e3);
    this.hourly.set(botId, arr);
    return arr.length;
  }

  // ---------- scheduling ----------
  tick() {
    const app = this.app;
    const cfg = app.config;
    this.lastTickAt = Date.now();
    if (cfg.paused) return;
    const waiting = [...app.bots.values()]
      .filter((b) => !b.paused && !this.running.has(b.id) && (b._queue || []).length)
      .sort((a, b) => a._queue[0].ts - b._queue[0].ts);
    for (const bot of waiting) {
      if (this.running.size >= cfg.maxConcurrent) break;
      if (this.turnsToday() >= cfg.maxTurnsPerDay) {
        if (!this._dailyNoticeFor || this._dailyNoticeFor !== localDateKey()) {
          this._dailyNoticeFor = localDateKey();
          app.systemNotice(null, 'Daily limit reached: ' + cfg.maxTurnsPerDay + ' bot turns today. Waiting work stays queued until tomorrow, or raise the limit in Settings → Limits.');
        }
        return;
      }
      if (this.hourCount(bot.id) >= cfg.maxTurnsPerBotHour) {
        bot._blocked = 'hourly limit';
        app.emitBot(bot);
        continue;
      }
      bot._blocked = '';
      const batch = this.takeBatch(bot);
      if (batch.length) this.runTurn(bot, batch);
    }
  }

  takeBatch(bot) {
    const cfg = this.app.config;
    const q = bot._queue;
    const ch = q[0].ch;
    const batch = [];
    const rest = [];
    for (const item of q) {
      if (item.ch === ch && batch.length < 12) batch.push(item); else rest.push(item);
    }
    // Chain budget: bot-to-bot traffic that started from one request can only use so many turns.
    const kept = [];
    for (const item of batch) {
      const used = this.chainTurns.get(item.rootId) || 0;
      const botOriginated = ['task', 'report', 'message', 'room'].includes(item.kind) && item.depth > 0;
      if (botOriginated && used >= cfg.maxChainTurns) {
        this.app.chainStopped(bot, item);
      } else kept.push(item);
    }
    bot._queue = rest;
    bot._inflight = kept;
    this.saveQueue(bot);
    return kept;
  }

  // ---------- one turn ----------
  runTurn(bot, inputs, retry = false) {
    const app = this.app;
    const cfg = app.config;
    const ch = inputs[0].ch;
    const run = {
      id: id('run_'), token: token(), botId: bot.id, ch, inputs,
      depth: Math.max(0, ...inputs.map((i) => i.depth || 0)),
      rootId: inputs[0].rootId,
      taskIds: inputs.filter((i) => i.kind === 'task').map((i) => i.taskId),
      completed: new Set(), held: new Set(), steps: [], cardCount: 0,
      startedAt: Date.now(), activity: 'Starting…', waiting: false, stopped: false,
      approvals: new Set(), retry,
    };
    this.running.set(bot.id, run);
    this.byToken.set(run.token, run);
    for (const tid of run.taskIds) app.updateTask(tid, { status: 'working' });
    for (const i of inputs) this.chainTurns.set(i.rootId, (this.chainTurns.get(i.rootId) || 0) + 1);
    const hours = this.hourly.get(bot.id) || [];
    hours.push(Date.now());
    this.hourly.set(bot.id, hours);
    app.emitBot(bot);

    const info = cli.detect(cfg.claudePath);
    if (!info.found) {
      this.finish(bot, run, { ok: false, error: info.error || 'Claude Code CLI not found.' });
      return;
    }

    let child;
    try {
      const b = P.blocks(app, bot);
      const newSession = !bot.session.id;
      const sessionId = bot.session.id || require('crypto').randomUUID();
      const message = P.turnMessage(app, bot, inputs, { b, newSession });
      run.newSession = newSession;
      run.sessionId = sessionId;
      run.ctx = P.ctxHashes(b);

      const botDir = app.store.p('bots', bot.id);
      fs.mkdirSync(botDir, { recursive: true });
      const sysFile = path.join(botDir, 'system-prompt.md');
      fs.writeFileSync(sysFile, P.systemPrompt(app, bot, b));
      const mcpFile = path.join(app.store.p('run'), run.id + '.mcp.json');
      fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
      const servers = { ...(bot.mcpServers || {}) };
      servers.bullpen = {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(__dirname, 'mcp-server.js')],
        env: { BULLPEN_URL: app.baseUrl, BULLPEN_TOKEN: run.token },
      };
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2));
      run.mcpFile = mcpFile;

      const args = this.buildArgs(bot, info, { newSession, sessionId, sysFile, mcpFile });
      const cwd = app.botCwd(bot);
      fs.mkdirSync(cwd, { recursive: true });
      const env = { ...process.env, MCP_TOOL_TIMEOUT: String((cfg.approvalTimeoutMin + 5) * 60e3) };
      // With only Bullpen's own tools loaded, give the bot their full definitions up front instead
      // of making it search for them first (saves a step on every turn).
      if (!bot.useMyClaudeSettings) env.ENABLE_TOOL_SEARCH = 'false';
      delete env.CLAUDECODE; // don't let a parent Claude Code session leak into the bot's
      child = cli.spawnClaude(info, args, { cwd, env });
      run.child = child;
      child.stdin.on('error', () => {});
      child.stdin.end(message);
    } catch (e) {
      this.finish(bot, run, { ok: false, error: 'Could not start Claude Code: ' + e.message });
      return;
    }

    let buf = '';
    let stderr = '';
    let result = null;
    let lastText = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') result = ev;
        else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const c of ev.message.content) {
            if (c.type === 'tool_use') this.step(bot, run, c.name, c.input);
            else if (c.type === 'text' && c.text && c.text.trim()) { lastText = c.text; this.activity(bot, run, truncate(c.text.trim().split('\n')[0], 140)); }
          }
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });

    const timeoutMs = cfg.turnTimeoutMin * 60e3;
    run.watchdog = setTimeout(() => { run.timedOut = true; cli.killTree(child); }, timeoutMs);

    child.on('error', (e) => { stderr += '\n' + e.message; });
    child.on('close', (code) => {
      clearTimeout(run.watchdog);
      if (buf.trim()) { try { const ev = JSON.parse(buf.trim()); if (ev.type === 'result') result = ev; } catch {} }
      const missing = /No conversation found/i.test(stderr) || (result && /No conversation found/i.test(String(result.result || '')));
      if (!run.newSession && missing && !run.retry && !run.stopped) {
        // The CLI lost the session (folder moved, history purged). Start fresh with a carry-over.
        this.cleanup(bot, run);
        bot.session = { id: '', turns: 0, ctx: {}, startedAt: 0 };
        app.saveBot(bot);
        this.runTurn(bot, inputs, true);
        return;
      }
      if (run.stopped) return this.finish(bot, run, { ok: false, stopped: true });
      if (run.timedOut) return this.finish(bot, run, { ok: false, error: 'Stopped after ' + cfg.turnTimeoutMin + ' minutes (turn time limit).', result });
      if (result && !result.is_error && result.subtype === 'success') {
        return this.finish(bot, run, { ok: true, text: typeof result.result === 'string' ? result.result : lastText, result });
      }
      let error = '';
      if (result && result.subtype === 'error_max_turns') error = 'Stopped after ' + cfg.maxToolTurns + ' tool steps (max steps per turn). Say "continue" to let it keep going.';
      else if (result && result.is_error && result.result) error = String(result.result);
      else error = (stderr.trim().split('\n').slice(-6).join('\n')) || ('Claude Code exited with code ' + code + ' and no result.');
      this.finish(bot, run, { ok: false, error, result, partial: lastText });
    });
  }

  buildArgs(bot, info, { newSession, sessionId, sysFile, mcpFile }) {
    const cfg = this.app.config;
    const has = (f) => info.flags.has(f);
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const model = bot.model || cfg.defaultModel;
    if (model) args.push('--model', model);
    if (bot.effort && has('effort')) args.push('--effort', bot.effort);
    if (newSession) args.push('--session-id', sessionId); else args.push('--resume', sessionId);
    if (has('append-system-prompt-file')) args.push('--append-system-prompt-file', sysFile);
    else args.push('--append-system-prompt', fs.readFileSync(sysFile, 'utf8'));
    args.push('--mcp-config', mcpFile);
    if (!bot.useMyClaudeSettings) {
      if (has('strict-mcp-config')) args.push('--strict-mcp-config');
      // Leave the user's personal allow-rules and default mode out of the bot's permissions.
      if (has('setting-sources')) args.push('--setting-sources', 'project,local');
    }
    args.push('--max-turns', String(cfg.maxToolTurns));
    args.push('--add-dir', this.app.store.p('files'));

    const perm = bot.permission || cfg.defaultPermission;
    const allow = ['mcp__bullpen', ...READ_TOOLS, ...(bot.alwaysAllow || [])];
    const deny = [...NEVER];
    let promptTool = true;
    if (perm === 'readonly') {
      deny.push(...WRITE_TOOLS);
      promptTool = false;
      args.push('--permission-mode', 'default');
    } else if (perm === 'full') {
      args.push('--dangerously-skip-permissions');
      promptTool = false;
    } else if (perm === 'edits') {
      args.push('--permission-mode', 'acceptEdits');
    } else if (perm === 'auto') {
      args.push('--permission-mode', 'auto');
    } else {
      args.push('--permission-mode', 'default');
    }
    args.push('--allowedTools', allow.join(','));
    args.push('--disallowedTools', deny.join(','));
    if (promptTool) args.push('--permission-prompt-tool', 'mcp__bullpen__approval_prompt');
    return args;
  }

  step(bot, run, name, input) {
    const s = describeTool(name, input || {});
    run.steps.push(s);
    if (run.steps.length > 60) run.steps.splice(0, run.steps.length - 60);
    this.activity(bot, run, s);
  }

  activity(bot, run, text) {
    run.activity = text;
    const shown = run.waiting && run.waitText ? run.waitText : text;
    this.app.emit('activity', { botId: bot.id, runId: run.id, text: shown, steps: run.steps.length });
  }

  stop(botId) {
    const run = this.running.get(botId);
    if (!run) return false;
    run.stopped = true;
    for (const aid of [...run.approvals]) this.app.resolveApproval(aid, 'deny', 'The turn was stopped.');
    cli.killTree(run.child);
    return true;
  }

  cleanup(bot, run) {
    for (const aid of [...run.approvals]) this.app.resolveApproval(aid, 'deny', 'The turn ended.');
    this.running.delete(bot.id);
    this.byToken.delete(run.token);
    if (run.mcpFile) { try { fs.unlinkSync(run.mcpFile); } catch {} }
  }

  finish(bot, run, outcome) {
    const app = this.app;
    this.cleanup(bot, run);
    bot._inflight = [];
    this.saveQueue(bot);
    try {
      app.turnFinished(bot, run, outcome);
    } catch (e) {
      console.error('[bullpen] turn bookkeeping failed:', e);
    }
    app.emitBot(bot);
    this.kick();
  }

  shutdown() {
    for (const run of this.running.values()) { run.stopped = true; cli.killTree(run.child); }
  }
}

function describeTool(name, input) {
  const short = (s, n = 80) => truncate(String(s || '').replace(/\s+/g, ' '), n);
  const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
  if (name.startsWith('mcp__bullpen__')) {
    const t = name.slice(14);
    switch (t) {
      case 'delegate_task': return input.to ? 'Delegated to @' + input.to + ': ' + short(input.title, 60) : 'Delegating a task';
      case 'send_message': return input.to ? 'Messaged @' + input.to : 'Messaging a teammate';
      case 'ask_user': return 'Asked: ' + short(input.question, 70);
      case 'save_page': return 'Saved page: ' + short(input.title, 60);
      case 'draft_message': return 'Drafted a message' + (input.to ? ' to ' + short(input.to, 40) : '');
      case 'memory_add': return 'Saved to ' + (input.shared ? 'shared ' : '') + 'memory';
      case 'skill_read': return 'Read skill: ' + short(input.name, 50);
      case 'skill_save': return 'Saved skill: ' + short(input.name, 50);
      case 'complete_task': return 'Completed task #' + input.task_id;
      case 'routine_create': return 'Proposed routine: ' + short(input.title, 50);
      default: return t.replace(/_/g, ' ');
    }
  }
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
  switch (name) {
    case 'Read': return 'Read ' + base(input.file_path);
    case 'Write': return 'Wrote ' + base(input.file_path);
    case 'Edit': case 'MultiEdit': return 'Edited ' + base(input.file_path);
    case 'Bash': case 'PowerShell': return 'Ran: ' + short(input.description || input.command, 80);
    case 'Glob': return 'Listed ' + short(input.pattern, 60);
    case 'Grep': return 'Searched for ' + short(input.pattern, 60);
    case 'WebSearch': return 'Searched the web: ' + short(input.query, 60);
    case 'WebFetch': return 'Opened ' + short(input.url, 70);
    case 'Task': case 'Agent': return 'Started a helper: ' + short(input.description, 60);
    case 'ToolSearch': return 'Loaded tools';
    case 'TodoWrite': return 'Updated its checklist';
    default: return name;
  }
}

module.exports = { Runner, describeTool };
