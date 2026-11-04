'use strict';
// What each Bullpen tool does when a bot calls it. `run` is the bot's current turn.
const fs = require('fs');
const path = require('path');
const { isClosed, PERM_LABEL } = require('./app');

async function escalationOk(app, run, from, to, what, input) {
  if (!app.needsEscalationOk(from, to)) return true;
  const label = what + ' ' + to.name + ' (' + PERM_LABEL[app.permOf(to)] + ')';
  const d = await app.requestApproval(run, label, input, { noRule: true, escalation: true, label });
  return d.behavior === 'allow';
}
const { truncate } = require('./util');

function ok(text) { return { text }; }
function err(text) { return { isError: true, text }; }

async function callTool(app, run, tool, args) {
  const bot = app.bots.get(run.botId);
  if (!bot) return err('Your bot no longer exists.');
  const cfg = app.config;
  const a = args || {};

  switch (tool) {
    case 'team_list': {
      const rows = app.listBots().filter((b) => b.id !== bot.id).map((b) => {
        const st = app.runner.status(b);
        return '@' + b.handle + ' — ' + b.name + (b.title ? ', ' + b.title : '') + (b.primary ? ' [primary]' : '') +
          ' [' + st.state + (st.queued ? ', ' + st.queued + ' waiting' : '') + ']' + (b.description ? '\n    ' + truncate(b.description.replace(/\s+/g, ' '), 240) : '');
      });
      return ok(rows.length ? rows.join('\n') : 'You have no teammates. Tell the user which specialist bot would help, so they can create it.');
    }

    case 'delegate_task': {
      const to = app.botByHandle(a.to);
      if (!to) return err('No teammate called "' + a.to + '". Use team_list to see handles.');
      if (to.id === bot.id) return err('You cannot delegate to yourself.');
      if (!String(a.instructions || '').trim()) return err('Give the task instructions.');
      const depth = run.depth + 1;
      if (depth > cfg.maxDepth) return err('Hand-off limit reached (' + cfg.maxDepth + ' levels deep). Do this part yourself or report back what is left.');
      const open = [...app.tasks.values()].filter((t) => t.from === bot.id && t.to === to.id && !isClosed(t));
      if (open.length >= 5) return err('@' + to.handle + ' already has ' + open.length + ' open tasks from you. Wait for their reports.');
      if (!(await escalationOk(app, run, bot, to, 'Hand a task to', { title: a.title, instructions: a.instructions }))) {
        return err('The user declined handing this to @' + to.handle + ' (it has more permissions than you). Do it within your own permissions, or tell the user what you need.');
      }
      const t = {
        id: app.nextTaskId(), title: truncate(String(a.title || 'Task').trim(), 120), instructions: String(a.instructions).trim(),
        from: bot.id, to: to.id, status: 'queued', result: '', note: '', createdAt: Date.now(), updatedAt: Date.now(),
        replyCh: run.ch, depth, rootId: run.rootId,
      };
      app.tasks.set(t.id, t);
      app.saveTasks();
      app.emit('ev', { type: 'task', task: t });
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'task', taskId: t.id } });
      run.cardCount++;
      const msg = app.postMessage('dm:' + to.id, {
        role: 'incoming', text: '**' + t.title + '**\n\n' + t.instructions,
        meta: { label: 'Task #' + t.id + ' from ' + bot.name, from: bot.id, taskId: t.id },
      });
      app.runner.enqueue(to.id, { ch: 'dm:' + to.id, kind: 'task', taskId: t.id, depth, rootId: run.rootId, msgId: msg.id });
      return ok('Task #' + t.id + ' is with @' + to.handle + '. Their report will arrive as a new turn. Tell the user who is on it, then end your turn.');
    }

    case 'send_message': {
      const to = app.botByHandle(a.to);
      if (!to) return err('No teammate called "' + a.to + '".');
      if (to.id === bot.id) return err('That is you.');
      const text = String(a.text || '').trim();
      if (!text) return err('Empty message.');
      const depth = run.depth + 1;
      if (depth > cfg.maxDepth) return err('Hand-off limit reached (' + cfg.maxDepth + '). Message not sent.');
      if (!(await escalationOk(app, run, bot, to, 'Send a message to', { text }))) return err('The user declined sending this to @' + to.handle + '.');
      const msg = app.postMessage('dm:' + to.id, { role: 'incoming', text, meta: { label: 'Message from ' + bot.name, from: bot.id } });
      app.runner.enqueue(to.id, { ch: 'dm:' + to.id, kind: 'message', from: bot.id, text, depth, rootId: run.rootId, msgId: msg.id });
      return ok('Sent to @' + to.handle + '.');
    }

    case 'complete_task': {
      const t = app.tasks.get(Number(a.task_id));
      if (!t) return err('No task #' + a.task_id + '.');
      if (t.to !== bot.id) return err('Task #' + t.id + ' is not assigned to you.');
      if (isClosed(t)) return err('Task #' + t.id + ' is already ' + t.status + '.');
      run.completed.add(t.id);
      app.closeTask(t, a.status === 'failed' ? 'failed' : 'done', a.result);
      return ok('Task #' + t.id + ' closed and reported.');
    }

    case 'hold_task': {
      const t = app.tasks.get(Number(a.task_id));
      if (!t) return err('No task #' + a.task_id + '.');
      if (t.to !== bot.id) return err('Task #' + t.id + ' is not assigned to you.');
      if (isClosed(t)) return err('Task #' + t.id + ' is already ' + t.status + '.');
      run.held.add(t.id);
      app.updateTask(t.id, { status: 'held', note: truncate(String(a.note || ''), 300) });
      return ok('Task #' + t.id + ' stays open after this turn. Finish it with complete_task.');
    }

    case 'task_list': {
      const scope = a.scope || 'assigned';
      let list = [...app.tasks.values()];
      if (scope === 'mine') list = list.filter((t) => t.from === bot.id);
      else if (scope === 'assigned') list = list.filter((t) => t.to === bot.id);
      if (!a.include_done) list = list.filter((t) => !isClosed(t));
      list = list.sort((x, y) => y.id - x.id).slice(0, 40);
      if (!list.length) return ok('No matching tasks.');
      return ok(list.map((t) => {
        const f = app.bots.get(t.from); const to = app.bots.get(t.to);
        return '#' + t.id + ' [' + t.status + '] ' + t.title + ' — ' + (f ? '@' + f.handle : '?') + ' → ' + (to ? '@' + to.handle : '?') +
          (t.note ? ' (note: ' + t.note + ')' : '') + (isClosed(t) && t.result ? '\n    result: ' + truncate(t.result.replace(/\s+/g, ' '), 300) : '');
      }).join('\n'));
    }

    case 'ask_user': {
      const q = String(a.question || '').trim();
      if (!q) return err('Ask a question.');
      const options = (Array.isArray(a.options) ? a.options : []).map((o) => truncate(String(o), 120)).filter(Boolean).slice(0, 8);
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'question', question: q, options, multi: !!a.multi, allowText: a.allow_text !== false || !options.length, status: 'open' } });
      run.cardCount++;
      return ok('Question shown. End your turn now; the answer arrives as your next input.');
    }

    case 'draft_message': {
      const body = String(a.body || '').trim();
      if (!body) return err('The draft is empty.');
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'draft', to: truncate(String(a.to || ''), 300), subject: truncate(String(a.subject || ''), 300), body, kind: a.kind || 'email' } });
      run.cardCount++;
      return ok('Draft shown to the user. They will send it themselves.');
    }

    case 'save_page': {
      if (!String(a.content || '').trim()) return err('The page is empty.');
      if (String(a.content).length > 3e6) return err('Pages are limited to 3 MB.');
      const existing = a.page_id && app.pages.get(a.page_id);
      const p = app.savePage({ title: a.title, content: a.content, format: a.format, pageId: existing ? existing.id : undefined, botId: bot.id });
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'page', pageId: p.id, title: p.title, updated: !!existing } });
      run.cardCount++;
      return ok('Saved page "' + p.title + '" (page_id ' + p.id + '). Pass this page_id to update it later.');
    }

    case 'attach_file': {
      let p = String(a.path || '').trim();
      if (!p) return err('Give a file path.');
      if (!path.isAbsolute(p)) p = path.resolve(app.botCwd(bot), p);
      let st;
      try { st = fs.statSync(p); } catch { return err('No file at ' + p); }
      if (!st.isFile()) return err(p + ' is not a file.');
      if (st.size > 200 * 1024 * 1024) return err('Files over 200 MB cannot be attached.');
      const f = app.addFile({ name: path.basename(p), src: p, botId: bot.id, kind: 'attachment' });
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'file', fileId: f.id, name: f.name, size: f.size, caption: truncate(String(a.caption || ''), 300) } });
      run.cardCount++;
      return ok('Attached ' + f.name + '.');
    }

    case 'react': {
      const emoji = Array.from(String(a.emoji || '').trim()).slice(0, 4).join('');
      if (!emoji) return err('Give an emoji.');
      const last = app.channels.recent(run.ch, 50).reverse().find((m) => m.role === 'user');
      if (!last) return err('There is no user message to react to.');
      const reactions = Array.isArray(last.reactions) ? last.reactions.filter((r) => r.botId !== bot.id) : [];
      reactions.push({ emoji, botId: bot.id });
      app.patchMessage(run.ch, last.id, { reactions });
      return ok('Reacted ' + emoji + '.');
    }

    case 'memory_add': {
      const text = String(a.text || '').trim();
      if (!text) return err('Nothing to save.');
      const target = a.shared ? null : bot.id;
      const cur = app.readMemory(target).replace(/\s+$/, '');
      const line = '- ' + text.replace(/\n+/g, ' ');
      app.writeMemory(target, (cur ? cur + '\n' : '') + line + '\n');
      return ok('Saved to ' + (a.shared ? 'shared' : 'your') + ' memory.');
    }

    case 'memory_replace': {
      const target = a.shared ? null : bot.id;
      app.writeMemory(target, String(a.content || '').trim() + '\n');
      return ok((a.shared ? 'Shared' : 'Your') + ' memory replaced.');
    }

    case 'skill_list': {
      const s = app.listSkills();
      return ok(s.length ? s.map((x) => '- ' + x.name + ' — ' + x.description).join('\n') : 'No skills saved yet.');
    }

    case 'skill_read': {
      const s = app.readSkill(a.name);
      return s ? ok('# ' + s.name + '\n' + s.description + '\n\n' + s.body) : err('No skill named "' + a.name + '".');
    }

    case 'skill_save': {
      const slug = app.saveSkill({ name: a.name, description: a.description, body: a.body });
      return ok('Saved skill "' + a.name + '" (' + slug + ').');
    }

    case 'routine_create': {
      const target = a.bot ? app.botByHandle(a.bot) : bot;
      if (!target) return err('No bot called "' + a.bot + '".');
      let r;
      try {
        r = app.createRoutine({ botId: target.id, title: a.title, instructions: a.instructions, schedule: a.schedule, notify: a.notify, createdBy: bot.id, pending: true });
      } catch (e) { return err(e.message); }
      app.postMessage(run.ch, { role: 'bot', botId: bot.id, kind: 'card', card: { type: 'routine', routineId: r.id, title: r.title, botId: target.id, instructions: r.instructions, scheduleText: app.publicRoutine(r).scheduleText, status: 'pending' } });
      run.cardCount++;
      return ok('Routine proposed (id ' + r.id + '). It starts once the user approves it on the card.');
    }

    case 'routine_list': {
      const list = [...app.routines.values()].filter((r) => a.all || r.botId === bot.id);
      if (!list.length) return ok('No routines.');
      return ok(list.map((r) => {
        const pr = app.publicRoutine(r); const b = app.bots.get(r.botId);
        return r.id + ' — ' + r.title + ' (' + pr.scheduleText + ', ' + (r.pendingApproval ? 'awaiting approval' : r.enabled ? 'on' : 'paused') + ', bot @' + (b ? b.handle : '?') + ')' +
          (r.runs && r.runs[0] ? '\n    last run: ' + new Date(r.runs[0].ts).toLocaleString() + ' — ' + r.runs[0].status : '');
      }).join('\n'));
    }

    case 'routine_set_enabled': {
      const r = app.routines.get(a.routine_id);
      if (!r) return err('No routine ' + a.routine_id + '.');
      if (r.botId !== bot.id && !bot.primary) return err('That routine belongs to another bot.');
      if (r.pendingApproval) return err('That routine is still waiting for the user\'s approval.');
      app.updateRoutine(r.id, { enabled: !!a.enabled });
      return ok('Routine ' + (a.enabled ? 'resumed' : 'paused') + '.');
    }

    case 'approval_prompt': {
      const name = String(a.tool_name || '');
      const decision = await app.requestApproval(run, name, a.input || {});
      return ok(JSON.stringify(decision));
    }

    default:
      return err('Unknown tool ' + tool);
  }
}

module.exports = { callTool };
