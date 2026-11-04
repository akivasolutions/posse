'use strict';
// Builds what each bot is told: the system prompt at the start of a session, the context
// updates that keep a long-running session current, and the labeled input for each turn.
const { stamp, hash, truncate } = require('./util');

const MEMORY_CAP = 14000;

function at(bot) { return '@' + bot.handle; }

function teamBlock(app, bot) {
  const others = app.listBots().filter((b) => b.id !== bot.id);
  if (!others.length) return 'You have no teammates yet.';
  return others.map((b) => {
    const bits = [at(b) + ' — ' + b.name + (b.title ? ', ' + b.title : '') + (b.primary ? ' (primary bot)' : '')];
    if (b.description) bits.push('  ' + truncate(b.description.replace(/\s+/g, ' '), 300));
    return bits.join('\n');
  }).join('\n');
}

function skillsBlock(app) {
  const skills = app.listSkills();
  if (!skills.length) return 'No skills saved yet.';
  return skills.map((s) => '- ' + s.name + ' — ' + s.description).join('\n');
}

function capMemory(text, label) {
  text = (text || '').trim();
  if (!text) return '(empty)';
  if (text.length <= MEMORY_CAP) return text;
  return text.slice(0, MEMORY_CAP) + '\n\n[' + label + ' is ' + text.length + ' characters and was cut off here. Consolidate it with memory_replace.]';
}

function blocks(app, bot) {
  return {
    instructions: (bot.instructions || '').trim() || '(none yet — follow the user\'s lead)',
    team: teamBlock(app, bot),
    memory: capMemory(app.readMemory(bot.id), 'Your memory'),
    shared: capMemory(app.readMemory(null), 'Shared memory'),
    skills: skillsBlock(app),
  };
}

const TITLES = {
  instructions: 'Your instructions',
  team: 'Your team',
  memory: 'Your memory',
  shared: 'Shared memory (every bot sees this)',
  skills: 'Saved skills (read with skill_read)',
};

function ctxHashes(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) out[k] = hash(v);
  return out;
}

function systemPrompt(app, bot, b) {
  const user = app.config.userName || 'the user';
  const primary = app.primaryBot();
  const lines = [];
  lines.push('# You are ' + bot.name + (bot.title ? ', ' + bot.title : '') + ' (handle ' + at(bot) + ')');
  lines.push('');
  lines.push('You are one of ' + user + '\'s bots in Bullpen, a team of AI assistants that each keep a long-running conversation with ' + user + '. ' + (bot.description || ''));
  lines.push('');
  lines.push('## How Bullpen works');
  lines.push('- Your conversation persists for weeks. Each turn starts with a labeled input that says where it came from:');
  lines.push('  - `[From ' + user + ']` — ' + user + ' wrote to you directly.');
  lines.push('  - `[Task #N from @handle]` — a teammate delegated work to you. Do the work, then reply with your report: your final message that turn is sent back to them automatically. Call hold_task if you need more than this turn.');
  lines.push('  - `[Report on task #N …]` — a teammate finished something you delegated. Use it, and tell ' + user + ' what came of it when it matters.');
  lines.push('  - `[Message from @handle]` — an FYI from a teammate. Nothing goes back unless you use send_message or delegate_task.');
  lines.push('  - `[Group chat "…"]` — you were called on in a group chat; your reply is posted there. Mention @handle to bring a teammate in.');
  lines.push('  - `[Routine "…"]` — one of your scheduled routines fired.');
  lines.push('  - `[Context update]` — your instructions, team, memory or skills changed; the new version replaces the old one.');
  lines.push('- Your final message each turn is what ' + user + ' sees in your chat. Use Markdown. Be brief and concrete: lead with the answer or the outcome.');
  lines.push('- Bullpen tools are named mcp__bullpen__*. Use them for everything below.');
  lines.push('- Team: team_list, delegate_task, send_message, task_list, complete_task, hold_task. When you delegate, say who is on it and END YOUR TURN. Never wait, sleep or poll for a teammate; their report arrives as a new turn.');
  lines.push('- ' + user + ': ask_user shows a question card with options (end your turn after asking; the answer arrives as the next turn). draft_message shows a draft email or message for ' + user + ' to send — you never send messages to people yourself. save_page saves a report, dashboard or tracker to the Library. attach_file attaches a file to your reply. react adds an emoji tapback.');
  lines.push('- Memory: memory_add saves a durable fact (client details, preferences, decisions). Your memory survives session restarts; your chat context may not. Save what you would need to pick the work back up cold. shared=true saves to the memory every bot sees.');
  lines.push('- Skills: skill_list / skill_read / skill_save — reusable procedures any bot can follow. Save one when you work out a process worth repeating.');
  lines.push('- Routines: routine_create proposes a scheduled job (' + user + ' approves it on a card); routine_list; routine_set_enabled pauses or resumes one.');
  lines.push('- Some tools need ' + user + '\'s approval. If an action is declined, do not retry it a different way; say what you needed and why.');
  if (bot.primary) {
    lines.push('');
    lines.push('## You are the primary bot');
    lines.push(user + ' brings you anything. Decide who should do it: when a teammate\'s role fits, delegate_task to them with complete instructions; when nobody fits, or it is quick, do it yourself. You can split work across several teammates at once. When reports come back, check them, combine them, and give ' + user + ' the result. You are accountable for the outcome, not just the hand-off.');
  } else if (primary) {
    lines.push('');
    lines.push('The primary bot is ' + at(primary) + ' (' + primary.name + '). It coordinates the team and may hand you tasks.');
  }
  for (const k of ['instructions', 'team', 'shared', 'memory', 'skills']) {
    lines.push('');
    lines.push('## ' + TITLES[k]);
    lines.push(b[k]);
  }
  return lines.join('\n');
}

function contextUpdate(b, known) {
  const changed = Object.keys(b).filter((k) => known && known[k] && known[k] !== hash(b[k]));
  if (!changed.length) return '';
  const parts = ['[Context update — these replace the earlier versions]'];
  for (const k of changed) parts.push('### ' + TITLES[k] + '\n' + b[k]);
  return parts.join('\n\n');
}

function transcriptLine(app, m, maxLen, keepLines = false) {
  const user = app.config.userName || 'User';
  let who = user;
  if (m.role === 'bot') { const b = app.bots.get(m.botId); who = b ? b.name + ' (' + at(b) + ')' : 'A bot'; }
  else if (m.role === 'incoming') who = m.meta && m.meta.label ? m.meta.label : 'Incoming';
  else if (m.role === 'system') who = 'System';
  let text = m.text || '';
  if (m.kind === 'card' && m.card) text = cardSummary(m.card);
  if (!keepLines) return '- ' + who + ': ' + truncate(text.replace(/\s+/g, ' ').trim(), maxLen);
  // Keep the message's own line breaks (lists, tables), indented under the speaker.
  return '- ' + who + ': ' + truncate(text.trim(), maxLen).replace(/\n/g, '\n    ');
}

function cardSummary(card) {
  switch (card.type) {
    case 'question': return '(asked: ' + card.question + (card.answer ? ' → answered: ' + card.answer : '') + ')';
    case 'draft': return '(drafted ' + (card.kind || 'message') + ' to ' + (card.to || '?') + ')';
    case 'page': return '(saved page "' + card.title + '")';
    case 'file': return '(attached ' + card.name + ')';
    case 'task': return '(delegated task #' + card.taskId + ')';
    case 'approval': return '(approval for ' + card.tool + ': ' + (card.status || 'pending') + ')';
    case 'routine': return '(proposed routine "' + card.title + '": ' + (card.status || 'pending') + ')';
    default: return '(' + card.type + ')';
  }
}

// When a session has to start over (first turn after a reset, or the CLI lost the session),
// replay the tail of the chat so the bot picks up where it left off.
function carryOver(app, bot, excludeIds) {
  const msgs = app.channels.recent('dm:' + bot.id, 40).filter((m) => !excludeIds.has(m.id));
  if (!msgs.length) return '';
  const lines = [];
  let budget = 9000;
  for (let i = msgs.length - 1; i >= 0 && budget > 0; i--) {
    const l = transcriptLine(app, msgs[i], 600);
    budget -= l.length;
    lines.unshift(l);
  }
  return '[Session restarted. The tail of your chat with ' + (app.config.userName || 'the user') + ', for continuity — oldest first]\n' + lines.join('\n');
}

function roomTranscript(app, room, bot) {
  const msgs = app.channels.recent('room:' + room.id, 60);
  let start = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'bot' && msgs[i].botId === bot.id) { start = i + 1; break; }
  }
  let slice = msgs.slice(start);
  if (slice.length < 4) slice = msgs.slice(-Math.min(msgs.length, 8));
  slice = slice.slice(-25);
  return slice.map((m) => transcriptLine(app, m, 3000, true)).join('\n');
}

function inputText(app, bot, input) {
  const user = app.config.userName || 'User';
  const when = stamp(input.ts);
  const files = (input.files || []).length
    ? '\n\nAttached files:\n' + input.files.map((f) => '- ' + f.path + ' (' + f.name + ')').join('\n') : '';
  switch (input.kind) {
    case 'user':
      return '[From ' + user + ' · ' + when + ']\n' + (input.text || '') + files;
    case 'answer':
      return '[' + user + ' answered your question · ' + when + ']\nQuestion: ' + (input.question || '') + '\nAnswer: ' + (input.text || '');
    case 'task': {
      const t = app.tasks.get(input.taskId);
      const from = app.bots.get(t && t.from);
      if (!t) return '[Task #' + input.taskId + ' — it no longer exists]';
      return '[Task #' + t.id + ' from ' + (from ? at(from) + ' (' + from.name + ')' : user) + ' · ' + when + '] ' + t.title + '\n' + t.instructions +
        '\n\n(Your final reply this turn is sent back as the task report. Call hold_task if you need more time.)';
    }
    case 'report': {
      const t = app.tasks.get(input.taskId);
      const to = app.bots.get(t && t.to);
      if (!t) return '[Report on task #' + input.taskId + ']';
      return '[Report on task #' + t.id + ' "' + t.title + '" from ' + (to ? at(to) : 'a teammate') + ' · ' + t.status + ' · ' + when + ']\n' + (t.result || '(no result)');
    }
    case 'message': {
      const from = app.bots.get(input.from);
      return '[Message from ' + (from ? at(from) + ' (' + from.name + ')' : 'a teammate') + ' · ' + when + ']\n' + (input.text || '');
    }
    case 'room': {
      const room = app.rooms.get(input.roomId);
      if (!room) return '[Group chat — it was deleted]';
      const members = room.members.map((id) => app.bots.get(id)).filter(Boolean).map(at).join(', ');
      return '[Group chat "' + room.name + '" · members: ' + user + ', ' + members + ' · ' + when + ']\nRecent messages, oldest first:\n' + roomTranscript(app, room, bot) +
        '\n\n(Reply to the group. Mention @handle to bring a member in; only do that when you need them.)' + files;
    }
    case 'routine': {
      const r = app.routines.get(input.routineId);
      if (!r) return '[Routine — it was deleted]';
      let s = '[Routine "' + r.title + '" (id ' + r.id + ') · ' + when + ']\n' + r.instructions;
      if (input.payload) s += '\n\nEvent payload:\n' + truncate(input.payload, 20000);
      if (r.notify !== 'always') s += '\n\nIf nothing here is worth ' + user + '\'s attention, reply with exactly NO_UPDATE and nothing else.';
      return s;
    }
    case 'system':
      return '[Bullpen · ' + when + ']\n' + (input.text || '');
    default:
      return input.text || '';
  }
}

function turnMessage(app, bot, inputs, { b, newSession }) {
  const parts = [];
  if (!newSession) {
    const upd = contextUpdate(b, bot.session && bot.session.ctx);
    if (upd) parts.push(upd);
  } else {
    const co = carryOver(app, bot, new Set(inputs.map((i) => i.msgId).filter(Boolean)));
    if (co) parts.push(co);
  }
  if (inputs.some((i) => i.restarted)) {
    parts.push('[Note: Bullpen restarted while you were working on the input below. Check what is already done before repeating any action.]');
  }
  for (const i of inputs) parts.push(inputText(app, bot, i));
  return parts.join('\n\n');
}

module.exports = { blocks, ctxHashes, systemPrompt, turnMessage, cardSummary };
