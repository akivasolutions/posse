'use strict';
// The turn engine. Each bot has an inbox; one turn = one `claude -p` run that resumes the bot's
// session with every waiting input for the same chat. Bots run one turn at a time each, a few
// bots in parallel, under daily / hourly / chain budgets so bots talking to bots can't run away.
const fs = require('fs');
const path = require('path');
const cli = require('./claude-cli');
const P = require('./prompt');
const { id, token, truncate, localDateKey } = require('./util');

// Pre-approved for every bot. File reads are deliberately NOT here: Claude Code already lets a bot
// read inside its working folder, and reads anywhere else (or web fetches) show an approval card,
// so a bot misled by something it read can't quietly pull in other files or send data out.
const READ_TOOLS = ['WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch'];
const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'KillShell', 'KillBash'];
// Interactive-only tools that make no sense for a bot (Posse has its own question cards).
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
    this.seq = 0;
    // Hour/day limits lift with time, not events: look again every 30 s if anything is waiting.
    this.safety = setInterval(() => { if ([...this.app.bots.values()].some((b) => (b._queue || []).length)) this.kick(); }, 30e3);
    this.safety.unref();
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
    if (bot._deleted) return;
    this.app.store.writeJSON(this.queueFile(bot.id), { queue: bot._queue || [], inflight: bot._inflight || [] });
  }

  enqueue(botId, input, { front = false } = {}) {
    const bot = this.app.bots.get(botId);
    if (!bot) return null;
    const item = { id: id('in_'), ts: Date.now(), seq: ++this.seq, depth: 0, ...input };
    if (!item.rootId) item.rootId = id('root_');
    bot._queue = bot._queue || [];
    if (front) { item.seq = 0; bot._queue.unshift(item); } else bot._queue.push(item);
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
    if (cfg.paused || this.shuttingDown) return;
    // A group chat has one speaker at a time, so each bot sees what the previous one said.
    const busy = new Set([...this.running.values()].map((r) => r.ch).filter((ch) => ch.startsWith('room:')));
    const order = (i) => (i.seq || 0) + i.ts * 1000;
    const head = (b) => (b._queue || []).find((i) => !busy.has(i.ch));
    const waiting = [...app.bots.values()]
      .filter((b) => !b.paused && !this.running.has(b.id) && head(b))
      .sort((a, b) => order(head(a)) - order(head(b)));
    for (const bot of waiting) {
      if (!head(bot)) continue;
      if (this.running.size >= cfg.maxConcurrent) break;
      if (this.turnsToday() >= cfg.maxTurnsPerDay) {
        if (!this._dailyNoticeFor || this._dailyNoticeFor !== localDateKey()) {
          this._dailyNoticeFor = localDateKey();
          app.systemNotice(null, 'Daily limit reached: ' + cfg.maxTurnsPerDay + ' bot turns today. Waiting work stays queued until tomorrow, or raise the limit in Settings → Limits.');
        }
        return;
      }
      if (this.hourCount(bot.id) >= cfg.maxTurnsPerBotHour) {
        if (bot._blocked !== 'hourly limit') { bot._blocked = 'hourly limit'; app.emitBot(bot); }
        continue;
      }
      if (bot.dailyBudgetUsd && app.spentToday(bot.id) >= bot.dailyBudgetUsd) {
        if (bot._blocked !== 'daily budget') {
          bot._blocked = 'daily budget';
          app.postMessage('dm:' + bot.id, { role: 'system', text: bot.name + ' reached its daily budget ($' + bot.dailyBudgetUsd.toFixed(2) + ' API-equivalent). Waiting work stays queued until tomorrow, or raise the budget in its settings.' });
          app.emitBot(bot);
        }
        continue;
      }
      bot._blocked = '';
      const batch = this.takeBatch(bot, head(bot).ch);
      if (batch.length) { this.runTurn(bot, batch); if (batch[0].ch.startsWith('room:')) busy.add(batch[0].ch); }
    }
  }

  takeBatch(bot, ch) {
    const cfg = this.app.config;
    const q = bot._queue;
    const batch = [];
    const rest = [];
    const first = q.find((i) => i.ch === ch);
    const alone = (i) => i.kind === 'task' || i.handoff;
    for (const item of q) {
      const fits = item.ch === ch && batch.length < 12 &&
        (alone(first) ? item === first : !alone(item));
      if (fits) batch.push(item); else rest.push(item);
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
      startedAt: Date.now(), activity: 'Starting…', waiting: false, stopped: false, sessionGen: bot.sessionGen || 0,
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
      servers.posse = cfg.mcpTransport === 'stdio'
        ? { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mcp-server.js')], env: { POSSE_URL: app.baseUrl, POSSE_TOKEN: run.token } }
        : { type: 'http', url: app.baseUrl + '/mcp', headers: { Authorization: 'Bearer ' + run.token } };
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
      run.mcpFile = mcpFile;

      const args = this.buildArgs(bot, info, { newSession, sessionId, sysFile, mcpFile, run });
      const cwd = app.botCwd(bot);
      fs.mkdirSync(cwd, { recursive: true });
      const env = { ...(bot.useMyClaudeSettings ? {} : cli.userSettingsEnv()), ...process.env, MCP_TOOL_TIMEOUT: String((cfg.approvalTimeoutMin + 5) * 60e3) };
      // With only Posse's own tools loaded, give the bot their full definitions up front instead
      // of making it search for them first (saves a step on every turn).
      if (!bot.useMyClaudeSettings) env.ENABLE_TOOL_SEARCH = 'false';
      // Posse keeps each bot's memory itself; Claude Code's own auto-memory would write under
      // ~/.claude, which bots may not touch.
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.resolve(process.env.CLAUDE_CONFIG_DIR); // same folder the deny rules name
      delete env.CLAUDECODE; // don't let a parent Claude Code session leak into the bot's
      child = cli.spawnClaude(info, args, { cwd, env });
      run.child = child;
      // On a busy machine, bots yield the CPU to whatever the user is doing. Processes the CLI
      // starts (tools, shells) inherit the lower priority.
      if (cfg.lowPriority && child.pid) { try { require('os').setPriority(child.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
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

    // Turn time limit counts working time only: time spent waiting on an approval card is excluded.
    const timeoutMs = cfg.turnTimeoutMin * 60e3;
    let active = 0;
    let last = Date.now();
    run.watchdog = setInterval(() => {
      const now = Date.now();
      if (!run.waiting) active += now - last;
      last = now;
      if (active > timeoutMs) { run.timedOut = true; clearInterval(run.watchdog); cli.killTree(child); }
    }, 5000);

    child.on('error', (e) => { stderr += '\n' + e.message; });
    child.on('close', (code) => {
      clearInterval(run.watchdog);
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
      if (!result && /(invalid|unknown|error processing|must be)[^\n]{0,80}setting[- ]sources|setting[- ]sources[^\n]{0,80}(invalid|required|must)/i.test(stderr) && !info.noEmptySources && !run.stopped) {
        info.noEmptySources = true; // this CLI wants at least one source; fall back to 'local'
        this.cleanup(bot, run);
        this.runTurn(bot, inputs, run.retry);
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
      // An expired or missing Claude Code login: say how to fix it instead of showing a raw API error.
      if (/authentication_error|OAuth (access )?token (has )?expired|invalid api key|please run \/login|not logged in/i.test(error + '\n' + stderr)) {
        error = 'Claude Code is not signed in on this computer (the login may have expired). Open a terminal, run claude, type /login and sign in, then press Retry.\n\n' + truncate(error, 300);
      }
      this.finish(bot, run, { ok: false, error, result, partial: lastText });
    });
  }

  buildArgs(bot, info, { newSession, sessionId, sysFile, mcpFile, run }) {
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
      // Load no settings files: neither the user's personal allow-rules nor rules a working folder
      // ships in .claude/settings*.json (a downloaded folder could pre-approve commands).
      if (has('setting-sources')) args.push('--setting-sources', bot.trustFolderSettings ? 'project,local' : (info.noEmptySources ? 'local' : ''));
    }
    args.push('--max-turns', String(cfg.maxToolTurns));
    args.push('--add-dir', this.app.store.p('files'));

    let perm = bot.permission || cfg.defaultPermission;
    const modes = info.permissionModes || [];
    const manual = !modes.length || modes.includes('default') ? 'default' : modes.includes('manual') ? 'manual' : '';
    if (perm === 'auto' && modes.length && !modes.includes('auto')) perm = 'ask'; // older CLI: fall back to approval cards
    const allow = ['mcp__posse', ...READ_TOOLS];
    // One-time permissions ride on the input that carries the user's approval, so only that turn gets them.
    const grants = (run.inputs || []).flatMap((i) => i.grants || []);
    const rules = [...(bot.alwaysAllow || []), ...grants].filter((r) => typeof r === 'string' && r.trim() && !/[\r\n]/.test(r));
    const deny = [...NEVER];
    let promptTool = true;
    if (perm === 'readonly') {
      deny.push(...WRITE_TOOLS);
      promptTool = false;
      if (manual) args.push('--permission-mode', manual);
    } else if (perm === 'full') {
      args.push('--dangerously-skip-permissions');
      promptTool = false;
    } else if (perm === 'edits') {
      args.push('--permission-mode', 'acceptEdits');
    } else if (perm === 'auto') {
      args.push('--permission-mode', 'auto');
    } else if (manual) {
      args.push('--permission-mode', manual);
    }
    args.push('--allowedTools', allow.join(','));
    // "Always allow" rules can contain spaces, commas and parentheses, so they go in a settings
    // file (a JSON array) rather than the comma-separated flag the CLI splits on. Deny rules there
    // stop a bot from ever writing Claude Code settings (in any .claude folder or ~/.claude.json),
    // which would let it grant itself permissions; deny beats any approval.
    // Never writable by any bot: Claude Code settings files anywhere, the user's own Claude config.
    // Bots that don't trust their folder's settings can't write anything else in a .claude folder
    // either; trusted ones can (commands, agents, skills), and Claude Code still asks first.
    // Claude Code's config folder when moved with CLAUDE_CONFIG_DIR: rule paths are //abs or //c/... on Windows.
    const cfgDir = process.env.CLAUDE_CONFIG_DIR ? require('path').resolve(process.env.CLAUDE_CONFIG_DIR).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()) : '';
    // A bot whose working folder is itself inside a .claude folder (e.g. a Claude Code worktree)
    // can't get the broad .claude rule (it couldn't edit anything); it gets per-folder rules instead.
    const cwdInClaude = /(^|[\\/])\.claude([\\/]|$)/.test(this.app.botCwd(bot));
    const denyRules = [
      'Edit(//**/.claude/settings*.json)', 'Write(//**/.claude/settings*.json)',
      'Edit(~/.claude/**)', 'Write(~/.claude/**)', 'Edit(~/.claude.json)', 'Write(~/.claude.json)',
      ...(cfgDir ? ['Edit(/' + cfgDir + '/**)', 'Write(/' + cfgDir + '/**)'] : []),
      ...(bot.useMyClaudeSettings || bot.trustFolderSettings ? []
        : cwdInClaude
          ? [...['commands', 'agents', 'skills', 'hooks', 'output-styles', 'rules'].flatMap((d) => ['Edit(//**/.claude/' + d + '/**)', 'Write(//**/.claude/' + d + '/**)']), 'Edit(//**/.claude/CLAUDE.md)', 'Write(//**/.claude/CLAUDE.md)']
          : ['Edit(//**/.claude/**)', 'Write(//**/.claude/**)']),
    ];
    if ((rules.length || denyRules.length) && has('settings')) {
      const f = path.join(this.app.store.p('run'), run.id + '.settings.json');
      fs.writeFileSync(f, JSON.stringify({ permissions: { allow: rules, deny: denyRules } }), { mode: 0o600 });
      run.settingsFile = f;
      args.push('--settings', f);
    }
    args.push('--disallowedTools', deny.join(','));
    if (promptTool) args.push('--permission-prompt-tool', 'mcp__posse__approval_prompt');
    return args;
  }

  step(bot, run, name, input) {
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) && input && (input.file_path || input.notebook_path)) {
      run.written = run.written || new Set();
      run.written.add(path.resolve(this.app.botCwd(bot), String(input.file_path || input.notebook_path)));
    }
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
    // A turn ending with an approval still live: normally the card stays answerable ("later"). When
    // Posse is shutting down the turn is re-run on restart and asks again, so this card expires.
    for (const aid of [...run.approvals]) {
      if (this.shuttingDown) this.app.expireApproval(aid);
      else this.app.deferApproval(aid);
    }
    this.running.delete(bot.id);
    this.byToken.delete(run.token);
    if (run.mcpFile) { try { fs.unlinkSync(run.mcpFile); } catch {} }
    if (run.settingsFile) { try { fs.unlinkSync(run.settingsFile); } catch {} }
  }

  finish(bot, run, outcome) {
    const app = this.app;
    this.cleanup(bot, run);
    if (bot._deleted) { app.trashBotFiles(bot.id); if (!this.shuttingDown) this.kick(); return; }
    if (this.shuttingDown) return; // keep in-flight work queued; it re-runs on next start
    bot._inflight = [];
    this.saveQueue(bot);
    try {
      app.turnFinished(bot, run, outcome);
    } catch (e) {
      console.error('[posse] turn bookkeeping failed:', e);
    }
    app.emitBot(bot);
    this.kick();
  }

  // Stop for an app shutdown: no new turns, and in-flight inputs stay in queue.json so they
  // re-run (flagged as interrupted) on the next start instead of being marked failed.
  shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.timer);
    clearInterval(this.safety);
    const waits = [];
    for (const run of this.running.values()) {
      run.stopped = true;
      if (run.child && run.child.exitCode === null) waits.push(new Promise((r) => run.child.once('close', r)));
      cli.killTree(run.child);
    }
    return Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 4000))]);
  }
}

function describeTool(name, input) {
  const short = (s, n = 80) => truncate(String(s || '').replace(/\s+/g, ' '), n);
  const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
  if (name.startsWith('mcp__posse__')) {
    const t = name.slice('mcp__posse__'.length);
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
