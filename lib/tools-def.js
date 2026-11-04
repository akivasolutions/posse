'use strict';
// Tools every bot gets through the Bullpen MCP server (shown to Claude as mcp__bullpen__<name>).
// The MCP process only forwards calls; the server implements them (see lib/tools.js).

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });

const scheduleSchema = {
  type: 'object',
  description: 'When it runs. {"type":"daily","time":"08:30","days":[1,2,3,4,5]} (days: 0=Sun..6=Sat, omit for every day), {"type":"interval","minutes":120}, {"type":"once","at":"2026-11-20T09:00"} (local time), or {"type":"webhook"} (runs when something POSTs to its webhook URL).',
  properties: {
    type: { type: 'string', enum: ['daily', 'interval', 'once', 'webhook'] },
    time: str('HH:MM, 24-hour local time (daily)'),
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    minutes: { type: 'integer', minimum: 15 },
    at: str('Local date-time for once, e.g. 2026-11-20T09:00'),
  },
  required: ['type'],
};

const TOOLS = [
  // Team
  { name: 'team_list', description: 'List your teammates (other bots): handle, name, title, what they do, and whether they are busy.', inputSchema: { type: 'object', properties: {} } },
  { name: 'delegate_task', description: 'Hand a task to a teammate. It runs in their own conversation; when they finish, their report arrives to you as a new turn. After delegating, tell the user who is on it and END YOUR TURN — do not wait or poll.', inputSchema: { type: 'object', properties: { to: str('Teammate handle, e.g. "researcher"'), title: str('Short task title'), instructions: str('Everything they need: goal, context, files, what to send back') }, required: ['to', 'title', 'instructions'] } },
  { name: 'send_message', description: 'Send an FYI message to a teammate. They read it on their next turn. No reply comes back automatically — use delegate_task when you need an answer.', inputSchema: { type: 'object', properties: { to: str('Teammate handle'), text: str('Message') }, required: ['to', 'text'] } },
  { name: 'complete_task', description: 'Finish a task assigned to you, with your result. Optional: when a task is in your current turn, your final reply is used as the result automatically. Use this for tasks you put on hold earlier, or to mark one failed.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, result: str('The report for whoever delegated it'), status: { type: 'string', enum: ['done', 'failed'] } }, required: ['task_id', 'result'] } },
  { name: 'hold_task', description: 'Keep a task assigned to you open after this turn (for example while you wait on a teammate). Finish it later with complete_task.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, note: str('What you are waiting on') }, required: ['task_id'] } },
  { name: 'task_list', description: 'List tasks. scope "mine" = tasks you delegated, "assigned" = tasks assigned to you, "all" = every open task.', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['mine', 'assigned', 'all'] }, include_done: bool('Include finished tasks') } } },

  // Talking to the user
  { name: 'ask_user', description: 'Show the user a question card with clickable options. Their pick comes back to you as their next message. End your turn after asking.', inputSchema: { type: 'object', properties: { question: str('The question'), options: { type: 'array', items: { type: 'string' }, description: '2-6 short options' }, multi: bool('Allow picking several'), allow_text: bool('Also allow a typed answer') }, required: ['question'] } },
  { name: 'draft_message', description: 'Show a draft of an email or message to someone else on a card. The user sends it themselves — you never send messages to people directly.', inputSchema: { type: 'object', properties: { to: str('Recipient(s)'), subject: str('Subject, for email'), body: str('The message text'), kind: { type: 'string', enum: ['email', 'chat', 'other'] } }, required: ['body'] } },
  { name: 'save_page', description: 'Save a report, dashboard, tracker or small tool as a Page in the user\'s Library and show it on a card. Use format "html" for a full self-contained page (inline CSS/JS only, no external requests) or "markdown" for a document. Pass page_id to update a page you saved before.', inputSchema: { type: 'object', properties: { title: str('Page title'), content: str('Full HTML document or Markdown'), format: { type: 'string', enum: ['html', 'markdown'] }, page_id: str('Existing page id to replace') }, required: ['title', 'content'] } },
  { name: 'attach_file', description: 'Attach a file from disk to your reply so the user can open or download it.', inputSchema: { type: 'object', properties: { path: str('Absolute path, or relative to your working folder'), caption: str('Optional note') }, required: ['path'] } },
  { name: 'react', description: 'React to the user\'s latest message with one emoji (a tapback). Use sparingly.', inputSchema: { type: 'object', properties: { emoji: str('One emoji') }, required: ['emoji'] } },

  // Memory and skills
  { name: 'memory_add', description: 'Save a durable fact to long-term memory (preferences, client details, decisions). shared=true puts it in the memory every bot sees.', inputSchema: { type: 'object', properties: { text: str('The fact, one or two lines'), shared: bool('Save to shared memory') }, required: ['text'] } },
  { name: 'memory_replace', description: 'Rewrite your whole memory file (to reorganize it or remove stale facts). Read it first: it is in your system prompt or latest context update.', inputSchema: { type: 'object', properties: { content: str('Complete new memory (Markdown)'), shared: bool('Rewrite shared memory instead') }, required: ['content'] } },
  { name: 'skill_list', description: 'List saved skills (reusable step-by-step procedures any bot can follow).', inputSchema: { type: 'object', properties: {} } },
  { name: 'skill_read', description: 'Read a skill\'s full procedure.', inputSchema: { type: 'object', properties: { name: str('Skill name') }, required: ['name'] } },
  { name: 'skill_save', description: 'Create or update a skill: a reusable procedure written so any bot can follow it.', inputSchema: { type: 'object', properties: { name: str('Short name'), description: str('One line: when to use it'), body: str('The procedure, in Markdown') }, required: ['name', 'description', 'body'] } },

  // Routines
  { name: 'routine_create', description: 'Propose a routine: saved instructions that run on a schedule even while the user is away. The user approves it on a card before it starts.', inputSchema: { type: 'object', properties: { title: str('Short name'), instructions: str('What to do each run'), schedule: scheduleSchema, notify: { type: 'string', enum: ['smart', 'always'], description: 'smart = only message the user when the result is worth seeing (default)' }, bot: str('Handle of the bot that should run it (default: you)') }, required: ['title', 'instructions', 'schedule'] } },
  { name: 'routine_list', description: 'List routines (yours, or every bot\'s with all=true).', inputSchema: { type: 'object', properties: { all: bool('Include other bots\' routines') } } },
  { name: 'routine_set_enabled', description: 'Pause or resume one of your routines.', inputSchema: { type: 'object', properties: { routine_id: str('Routine id'), enabled: bool('true = resume, false = pause') }, required: ['routine_id', 'enabled'] } },

  // Permission prompts (called by Claude Code itself, not by the bot)
  { name: 'approval_prompt', description: 'Internal: asks the user to approve a tool call. Do not call directly.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] } },
];

module.exports = { TOOLS };
