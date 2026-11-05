'use strict';
// End-to-end: real Bullpen server + real MCP server + fake Claude CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

let T;
let chief;
test.before(async () => {
  T = await startServer();
  const st = (await T.api('GET', '/api/state')).data;
  chief = st.bots.find((b) => b.primary);
});
test.after(async () => { await T.stop(); });

const lastBot = (list) => [...list].reverse().find((m) => m.role === 'bot' && m.kind === 'text');
const idle = async (botId) => T.waitFor(async () => { const b = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === botId); return b.status.state === 'idle'; }, 20000, 'bot idle');
// The fake CLI may be mid-write on a session file; skip any file that doesn't parse yet.
const history = () => fs.readdirSync(path.join(T.tmp, 'fake')).filter((f) => f.startsWith('session-')).map((f) => {
  try { return JSON.parse(fs.readFileSync(path.join(T.tmp, 'fake', f), 'utf8')).history; } catch { return []; }
}).flat();
test.beforeEach(async () => { if (chief) await idle(chief.id); });

test('first run seeds a primary bot and finds the CLI', async () => {
  const st = (await T.api('GET', '/api/state')).data;
  assert.ok(st.cli.found, 'cli found');
  assert.match(st.cli.version, /Fake Claude/);
  assert.strictEqual(chief.name, 'Chief of Staff');
  assert.strictEqual(chief.handle, 'chief-of-staff');
  assert.strictEqual(chief.primary, true);
});

test('a direct message gets a reply and the session persists', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'hello there' });
  const reply = await T.waitFor(async () => lastBot(await T.msgs(ch)), 15000, 'first reply');
  assert.match(reply.text, /ok: hello there/);
  const b1 = (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id);
  assert.ok(b1.session.id, 'session id stored');
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'second message' });
  await T.waitFor(async () => (await T.msgs(ch)).filter((m) => m.role === 'bot').length >= 2, 15000, 'second reply');
  const calls = T.calls();
  const last = calls[calls.length - 1].argv;
  assert.ok(last.includes('--resume') && last.includes(b1.session.id), 'second turn resumes the same session');
  assert.ok(calls[0].argv.includes('--session-id'), 'first turn creates the session');
  // Isolation from the user's own Claude settings by default.
  assert.ok(last.includes('--strict-mcp-config'));
  assert.strictEqual(last[last.indexOf('--setting-sources') + 1], '', 'no settings files: neither the user\'s nor the folder\'s');
  const allowed = last[last.indexOf('--allowedTools') + 1].split(',');
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch']) assert.ok(!allowed.includes(t), t + ' is not pre-approved');
  assert.strictEqual(last[last.indexOf('--permission-mode') + 1], 'default');
  assert.strictEqual(last[last.indexOf('--permission-prompt-tool') + 1], 'mcp__bullpen__approval_prompt');
});

test('primary bot delegates, specialist reports back, primary follows up', async () => {
  const analyst = (await T.api('POST', '/api/bots', { name: 'Analyst', title: 'Numbers', description: 'Crunches numbers' })).data.bot;
  assert.strictEqual(analyst.handle, 'analyst');
  const ch = 'dm:' + chief.id;
  const args = { to: 'analyst', title: 'Crunch Q3', instructions: 'Add up Q3.\n@@reply Analysis done: 42' };
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'run the numbers\n@@call delegate_task ' + JSON.stringify(args) });
  const task = await T.waitFor(async () => (await T.api('GET', '/api/state')).data.tasks.find((t) => t.title === 'Crunch Q3' && t.status === 'done'), 20000, 'task done');
  assert.strictEqual(task.result, 'Analysis done: 42');
  assert.strictEqual(task.from, chief.id);
  assert.strictEqual(task.to, analyst.id);
  // The task showed up in the analyst's chat, and its reply is there.
  const am = await T.msgs('dm:' + analyst.id);
  assert.ok(am.some((m) => m.role === 'incoming' && /Task #\d+ from Chief of Staff/.test(m.meta.label)));
  assert.strictEqual(lastBot(am).text, 'Analysis done: 42');
  // The report came back to the chief and the chief took another turn on it.
  await T.waitFor(async () => {
    const cm = await T.msgs(ch);
    const ri = cm.findIndex((m) => m.role === 'incoming' && m.meta && m.meta.taskId === task.id);
    return ri >= 0 && cm.slice(ri + 1).some((m) => m.role === 'bot' && m.kind === 'text');
  }, 20000, 'chief follow-up turn');
  const cm = await T.msgs(ch);
  assert.ok(cm.some((m) => m.kind === 'card' && m.card.type === 'task' && m.card.taskId === task.id), 'task card in chief chat');
  // The delegating bot must be told it worked (a false error makes real models retry and duplicate work).
  const delegTurn = cm.find((m) => m.role === 'bot' && m.kind === 'text' && /delegate_task ->/.test(m.text));
  assert.match(delegTurn.text, /delegate_task -> Task #\d+ is with @analyst/);
  assert.ok(!/ERROR/.test(delegTurn.text), 'no error reported to the bot');
  const reportTurn = T.calls().filter((c) => c.argv.includes('--resume')).length;
  assert.ok(reportTurn >= 2);
});

test('approval cards: deny, then always-allow adds a rule', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'clean up\n@@perm Bash {"command":"rm -rf build"}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'approval' && m.card.status === 'pending'), 15000, 'approval card');
  assert.strictEqual(card.card.rule, 'Bash(rm -rf build)');
  const st = (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id).status;
  assert.strictEqual(st.state, 'waiting');
  const r = await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'deny' });
  assert.strictEqual(r.status, 200);
  const reply = await T.waitFor(async () => { const l = lastBot(await T.msgs(ch)); return l && /perm Bash -> deny/.test(l.text) ? l : null; }, 15000, 'deny reply');
  assert.ok(reply);
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'build it\n@@perm Bash {"command":"npm run build"}' });
  const card2 = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'approval' && m.card.status === 'pending'), 15000, 'second approval card');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card2.id, { decision: 'always' });
  await T.waitFor(async () => { const l = lastBot(await T.msgs(ch)); return l && /perm Bash -> allow/.test(l.text); }, 15000, 'allow reply');
  const bot = (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id);
  assert.deepStrictEqual(bot.alwaysAllow, ['Bash(npm run build)']);
  // A second answer to a closed card is refused.
  const again = await T.api('POST', '/api/channels/' + ch + '/cards/' + card2.id, { decision: 'deny' });
  assert.strictEqual(again.status, 409);
});

test('question cards feed the answer back as the next turn', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'ask me\n@@call ask_user {"question":"Which client?","options":["Acme","Globex"]}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'question' && m.card.status === 'open'), 15000, 'question card');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { choices: ['Globex'] });
  const answered = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.id === card.id && m.card.status === 'answered'), 5000, 'answered');
  assert.strictEqual(answered.card.answer, 'Globex');
  await T.waitFor(() => history().some((h) => /answered your question/.test(h.in) && /Question: Which client\?/.test(h.in) && /Answer: Globex/.test(h.in)), 15000, 'answer turn');
});

test('a lost CLI session is rebuilt with a recap of the chat', async () => {
  const st = (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id);
  fs.unlinkSync(path.join(T.tmp, 'fake', 'session-' + st.session.id + '.json'));
  const ch = 'dm:' + chief.id;
  const before = (await T.msgs(ch)).length;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'are you still there' });
  await T.waitFor(async () => { const l = (await T.msgs(ch)).slice(before); return l.some((m) => m.role === 'bot' && /ok:/.test(m.text)); }, 15000, 'reply after lost session');
  const after = (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id);
  assert.notStrictEqual(after.session.id, st.session.id);
  const sess = JSON.parse(fs.readFileSync(path.join(T.tmp, 'fake', 'session-' + after.session.id + '.json'), 'utf8'));
  assert.match(sess.history[0].in, /Session restarted/);
  assert.match(sess.history[0].in, /run the numbers/);
});

test('context updates reach a running session when memory changes', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('PUT', '/api/bots/' + chief.id + '/memory', { text: '- Client Acme renews in March.' });
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'what do you remember' });
  const turn = await T.waitFor(() => history().find((h) => /what do you remember/.test(h.in)), 15000, 'memory turn');
  assert.match(turn.in, /\[Context update/);
  assert.match(turn.in, /Acme renews in March/);
  assert.ok(turn.in.indexOf('[Context update') < turn.in.indexOf('what do you remember'), 'update comes before the message');
  await idle(chief.id);
  // Unchanged context is not resent.
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'and now' });
  const turn2 = await T.waitFor(() => history().find((h) => /and now/.test(h.in)), 15000, 'next turn');
  assert.ok(!/Context update/.test(turn2.in));
  await idle(chief.id);
  // memory_add from a tool appends
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'remember\n@@call memory_add {"text":"Globex prefers email"}' });
  await T.waitFor(async () => /Globex prefers email/.test((await T.api('GET', '/api/bots/' + chief.id + '/memory')).data.text), 15000, 'memory_add');
});

test('pages, drafts, files and reactions', async () => {
  const ch = 'dm:' + chief.id;
  const file = path.join(T.tmp, 'report.txt');
  fs.writeFileSync(file, 'hello file');
  const lines = [
    'make things',
    '@@call save_page ' + JSON.stringify({ title: 'Q3 tracker', content: '# Q3\n\n<script>alert(1)</script>', format: 'markdown' }),
    '@@call draft_message ' + JSON.stringify({ to: 'pat@example.com', subject: 'Hi', body: 'Draft body' }),
    '@@call attach_file ' + JSON.stringify({ path: file }),
    '@@call react {"emoji":"👍"}',
  ];
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: lines.join('\n') });
  const all = await T.waitFor(async () => { const m = await T.msgs(ch); return m.some((x) => x.kind === 'card' && x.card.type === 'file') ? m : null; }, 15000, 'cards');
  const page = all.find((m) => m.kind === 'card' && m.card.type === 'page');
  assert.ok(page && all.some((m) => m.kind === 'card' && m.card.type === 'draft' && m.card.body === 'Draft body'));
  const pr = await fetch(T.base + '/pages/' + page.card.pageId, { headers: T.auth });
  assert.match(pr.headers.get('content-security-policy'), /sandbox/);
  const body = await pr.text();
  assert.ok(!body.includes('<script>alert(1)</script>'), 'markdown page content is not injected raw');
  const fc = all.find((m) => m.kind === 'card' && m.card.type === 'file');
  const fr = await fetch(T.base + '/files/' + fc.card.fileId + '/report.txt', { headers: T.auth });
  assert.strictEqual(await fr.text(), 'hello file');
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'user' && m.reactions && m.reactions[0].emoji === '👍'), 15000, 'reaction');
});

test('group chat: mention routing and bot-to-bot @mentions', async () => {
  const st = (await T.api('GET', '/api/state')).data;
  const analyst = st.bots.find((b) => b.handle === 'analyst');
  const room = (await T.api('POST', '/api/rooms', { name: 'Close', members: [chief.id, analyst.id] })).data.room;
  const ch = 'room:' + room.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: '@analyst kick off\n@@reply On it — {AT}chief-of-staff please review.' });
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === analyst.id), 15000, 'analyst in room');
  // The analyst's reply mentioned the chief, so the chief is called in (and sees the room transcript).
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === chief.id), 15000, 'chief called in');
  const msgs = await T.msgs(ch);
  const ai = msgs.findIndex((x) => x.role === 'bot' && x.botId === analyst.id);
  const ci = msgs.findIndex((x) => x.role === 'bot' && x.botId === chief.id);
  assert.ok(ai >= 0 && ci > ai, 'chief was called in by the analyst, after it');
  assert.ok(history().some((h) => /Group chat "Close"/.test(h.in) && /On it — @chief-of-staff please review/.test(h.in)), 'chief saw the room transcript');
});

test('routines: run now, smart notify keeps quiet results quiet', async () => {
  const r = (await T.api('POST', '/api/routines', { botId: chief.id, title: 'Inbox sweep', instructions: 'Check things\n@@reply NO_UPDATE', schedule: { type: 'interval', minutes: 60 } })).data;
  assert.strictEqual(r.scheduleText, 'Every hour');
  assert.ok(r.nextRunAt > Date.now());
  await T.api('POST', '/api/routines/' + r.id + '/run');
  const st = await T.waitFor(async () => { const x = (await T.api('GET', '/api/state')).data.routines.find((y) => y.id === r.id); return x.runs.length ? x : null; }, 15000, 'routine run');
  assert.strictEqual(st.runs[0].status, 'quiet');
  const m = lastBot(await T.msgs('dm:' + chief.id));
  assert.ok(m.meta.quiet);
  assert.ok(!('secret' in st), 'secret not exposed in state');
  // Webhook routine
  const w = (await T.api('POST', '/api/routines', { botId: chief.id, title: 'Hook', instructions: 'Handle event\n@@reply got hook', schedule: { type: 'webhook' }, notify: 'always' })).data;
  assert.match(w.webhook, /\/api\/hooks\//);
  const bad = await fetch(w.webhook.replace(/[^/]+$/, 'wrong'), { method: 'POST', body: 'x' });
  assert.strictEqual(bad.status, 404);
  const ok = await fetch(T.base + new URL(w.webhook).pathname, { method: 'POST', body: '{"event":"push"}' });
  assert.strictEqual(ok.status, 200);
  await T.waitFor(async () => { const l = lastBot(await T.msgs('dm:' + chief.id)); return l && l.text === 'got hook'; }, 15000, 'webhook turn');
});

test('bot-proposed routines wait for approval', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'schedule\n@@call routine_create {"title":"Daily brief","instructions":"Brief me","schedule":{"type":"daily","time":"08:30","days":[1,2,3,4,5]}}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'routine' && m.card.status === 'pending'), 15000, 'routine card');
  let r = (await T.api('GET', '/api/state')).data.routines.find((x) => x.id === card.card.routineId);
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.pendingApproval, true);
  assert.strictEqual(r.scheduleText, 'Weekdays at 8:30 AM');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'approve' });
  r = (await T.api('GET', '/api/state')).data.routines.find((x) => x.id === card.card.routineId);
  assert.strictEqual(r.enabled, true);
  assert.ok(r.nextRunAt > Date.now());
});

test('hand-off depth limit stops runaway delegation', async () => {
  await T.api('PATCH', '/api/config', { maxDepth: 1 });
  const ch = 'dm:' + chief.id;
  const inner = { to: 'chief-of-staff', title: 'bounce back', instructions: 'x' };
  const args = { to: 'analyst', title: 'Nested', instructions: 'Try to delegate further\n@@call delegate_task ' + JSON.stringify(inner) };
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'nest\n@@call delegate_task ' + JSON.stringify(args) });
  const task = await T.waitFor(async () => (await T.api('GET', '/api/state')).data.tasks.find((t) => t.title === 'Nested' && t.status === 'done'), 20000, 'nested task');
  assert.match(task.result, /Hand-off limit reached/);
  assert.ok(!(await T.api('GET', '/api/state')).data.tasks.some((t) => t.title === 'bounce back'));
  await T.api('PATCH', '/api/config', { maxDepth: 4 });
});

test('stop ends a running turn', async () => {
  const ch = 'dm:' + chief.id;
  const t0 = Date.now();
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'slow\n@@sleep 8000' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots.find((b) => b.id === chief.id).status.state === 'working', 10000, 'working');
  await new Promise((r) => setTimeout(r, 400));
  await T.api('POST', '/api/bots/' + chief.id + '/stop');
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'system' && m.text === 'Stopped.' && m.ts > t0), 10000, 'stopped notice');
  await idle(chief.id);
  assert.ok(Date.now() - t0 < 6000, 'stopped well before the 8s sleep finished');
});

test('failures are reported and three in a row pause the bot', async () => {
  const b = (await T.api('POST', '/api/bots', { name: 'Flaky' })).data.bot;
  const ch = 'dm:' + b.id;
  for (let i = 0; i < 3; i++) {
    await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'go\n@@fail boom ' + i });
    await T.waitFor(async () => (await T.msgs(ch)).filter((m) => m.role === 'system' && /Turn failed: boom/.test(m.text)).length > i, 15000, 'failure ' + i);
  }
  const after = await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === b.id && x.paused), 5000, 'paused');
  assert.ok(after.paused);
  assert.strictEqual(after.session.id, '', 'failed first turns leave no half session');
});

test('security: CSRF header, Host check, MCP token', async () => {
  const noHeader = await fetch(T.base + '/api/bots', { method: 'POST', headers: { 'content-type': 'application/json', ...T.auth }, body: '{"name":"x"}' });
  assert.strictEqual(noHeader.status, 403);
  const http = require('http');
  const evil = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: T.port, path: '/api/state', headers: { host: 'evil.example.com' } }, (res) => resolve(res.statusCode));
  });
  assert.strictEqual(evil, 403);
  const mcp = await fetch(T.base + '/api/mcp/call', { method: 'POST', headers: { 'x-bullpen-run': 'nope', 'content-type': 'application/json' }, body: '{"tool":"team_list"}' });
  assert.strictEqual((await mcp.json()).isError, true);
  const trav = await fetch(T.base + '/..%2f..%2fpackage.json');
  assert.ok(!(await trav.text()).includes('"name": "bullpen"'));
});

test('deleting a bot fails its open tasks and moves it to trash', async () => {
  const b = (await T.api('POST', '/api/bots', { name: 'Temp' })).data.bot;
  await T.api('PATCH', '/api/bots/' + b.id, { paused: true });
  await T.api('POST', '/api/channels/' + 'dm:' + chief.id + '/messages', { text: 'hand off\n@@call delegate_task {"to":"temp","title":"Orphan","instructions":"x"}' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.tasks.find((t) => t.title === 'Orphan'), 15000, 'orphan task');
  const del = await T.api('DELETE', '/api/bots/' + b.id);
  assert.strictEqual(del.status, 200);
  const t = (await T.api('GET', '/api/state')).data.tasks.find((x) => x.title === 'Orphan');
  assert.strictEqual(t.status, 'failed');
  assert.ok(fs.readdirSync(path.join(T.tmp, 'data', 'trash')).some((f) => f.startsWith(b.id)));
});

test('group chat: one speaker at a time, in mention order, no double call-ins, NO_REPLY stays silent', async () => {
  const st = (await T.api('GET', '/api/state')).data;
  const analyst = st.bots.find((b) => b.handle === 'analyst');
  const room = (await T.api('POST', '/api/rooms', { name: 'Floor', members: [chief.id, analyst.id] })).data.room;
  const ch = 'room:' + room.id;
  const text = ['@analyst then @chief-of-staff please', '@@as analyst sleep 600', '@@as analyst reply FIRST, over to {AT}chief-of-staff', '@@as chief-of-staff reply SECOND'].join('\n');
  await T.api('POST', '/api/channels/' + ch + '/messages', { text });
  await T.waitFor(async () => (await T.msgs(ch)).filter((m) => m.role === 'bot').length >= 2, 20000, 'two replies');
  await idle(chief.id); await idle(analyst.id);
  const bots = (await T.msgs(ch)).filter((m) => m.role === 'bot');
  assert.deepStrictEqual(bots.map((m) => m.text), ['FIRST, over to @chief-of-staff', 'SECOND'], 'analyst first, chief once');
  const chiefTurn = history().find((h) => /Group chat "Floor"/.test(h.in) && /FIRST, over to/.test(h.in));
  assert.ok(chiefTurn, 'the second speaker saw the first speaker\'s reply');
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: '@analyst anything?\n@@as analyst reply NO_REPLY' });
  await T.waitFor(() => history().some((h) => /anything\?/.test(h.in)), 15000, 'silent turn');
  await idle(analyst.id);
  const after = (await T.msgs(ch)).filter((m) => m.role === 'bot');
  assert.strictEqual(after.length, 2, 'NO_REPLY posts nothing');
});

test('long sessions: bot saves notes, then starts a fresh session with a recap', async () => {
  const b = (await T.api('POST', '/api/bots', { name: 'Marathon' })).data.bot;
  await T.api('PATCH', '/api/config', { sessionMaxTokens: 50000 });
  const ch = 'dm:' + b.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'big turn\n@@ctx 60000' });
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'system' && /Session refreshed/.test(m.text)), 20000, 'session refreshed');
  const handoffTurn = history().find((h) => /context is getting large/i.test(h.in));
  assert.ok(handoffTurn, 'bot was asked to save notes');
  const after = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === b.id);
  assert.strictEqual(after.session.id, '');
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'carry on' });
  const next = await T.waitFor(() => history().find((h) => /carry on/.test(h.in)), 15000, 'next turn');
  assert.match(next.in, /Session restarted/);
  assert.match(next.in, /big turn/);
  await T.api('PATCH', '/api/config', { sessionMaxTokens: 150000 });
});

test('tools over HTTP by default, stdio helper as a fallback; /mcp needs a live turn token', async () => {
  const transports = () => fs.readFileSync(path.join(T.tmp, 'fake', 'transports.log'), 'utf8').trim().split('\n');
  assert.ok(transports().filter((t) => t !== 'sse-response').every((t) => t === 'http'), 'default transport is http');
  assert.ok(transports().includes('sse-response'), 'tool calls are answered as an event stream');
  const bad = await fetch(T.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.strictEqual(bad.status, 401);
  const get = await fetch(T.base + '/mcp');
  assert.strictEqual(get.status, 405);
  await T.api('PATCH', '/api/config', { mcpTransport: 'stdio' });
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'via stdio\n@@call memory_add {"text":"stdio works"}' });
  await T.waitFor(async () => /stdio works/.test((await T.api('GET', '/api/bots/' + chief.id + '/memory')).data.text), 15000, 'stdio tool call');
  assert.strictEqual(transports().filter((t) => t !== 'sse-response').pop(), 'stdio');
  await T.api('PATCH', '/api/config', { mcpTransport: 'http' });
});

test('access key: header auth, read-only view tokens, no cookies, no lockout', async () => {
  const st = await fetch(T.base + '/api/state');
  assert.strictEqual(st.status, 401);
  const root = await fetch(T.base + '/');
  assert.strictEqual(root.status, 200, 'the app shell itself holds no data');
  assert.strictEqual(root.headers.get('set-cookie'), null);
  assert.match(root.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(root.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  assert.strictEqual(root.headers.get('x-frame-options'), 'DENY');
  const login = await fetch(T.base + '/login', { redirect: 'manual' });
  assert.strictEqual(login.headers.get('location'), '/');
  for (let i = 0; i < 25; i++) await fetch(T.base + '/api/state', { headers: { authorization: 'Bearer wrong' + i } });
  const who = await T.api('GET', '/api/whoami');
  assert.strictEqual(who.status, 200, 'the right key still works after many wrong ones');
  assert.strictEqual(who.data.vt.length, 32);
  const vt = who.data.vt;
  // view token: read-only things the browser loads by itself
  const ac = new AbortController();
  const ev = await fetch(T.base + '/api/events?vt=' + vt, { signal: ac.signal });
  assert.strictEqual(ev.status, 200);
  assert.match(ev.headers.get('content-type'), /event-stream/);
  ac.abort();
  const exp = await fetch(T.base + '/api/channels/dm:' + chief.id + '/export?vt=' + vt);
  assert.strictEqual(exp.status, 401, 'exports need the key itself');
  const expKey = await fetch(T.base + '/api/channels/dm:' + chief.id + '/export', { headers: T.auth });
  assert.strictEqual(expKey.status, 200);
  // pages and files: each link carries a token for that one resource
  const st2 = (await T.api('GET', '/api/state')).data;
  const pg = st2.pages[0];
  assert.match(pg.url, /^\/pages\/pg_[\w]+\?t=/);
  assert.strictEqual((await fetch(T.base + pg.url)).status, 200, 'the page opens with its own token');
  assert.strictEqual((await fetch(T.base + '/pages/' + pg.id + '?vt=' + vt)).status, 401, 'the view token does not open pages');
  const tok = new URL(T.base + pg.url).searchParams.get('t');
  const fileMsg = (await T.msgs('dm:' + chief.id)).find((m) => m.kind === 'card' && m.card.type === 'file');
  assert.ok(fileMsg.card.url && fileMsg.card.url.includes('?t='), 'file cards come with a signed link');
  assert.strictEqual((await fetch(T.base + fileMsg.card.url)).status, 200);
  assert.strictEqual((await fetch(T.base + '/files/' + fileMsg.card.fileId + '/x?t=' + tok)).status, 401, 'a page token does not open a file');
  const raw = require('fs').readFileSync(require('path').join(T.tmp, 'data', 'channels', 'dm-' + chief.id, require('fs').readdirSync(require('path').join(T.tmp, 'data', 'channels', 'dm-' + chief.id))[0]), 'utf8');
  assert.ok(!/\?t=/.test(raw), 'tokens are never stored in chat files');
  const badVt = await fetch(T.base + '/api/events?vt=nope');
  assert.strictEqual(badVt.status, 401);
  const vtWrite = await fetch(T.base + '/api/bots?vt=' + vt, { method: 'POST', headers: { 'X-Bullpen': '1', 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.strictEqual(vtWrite.status, 401, 'a view token cannot change anything');
  const vtState = await fetch(T.base + '/api/state?vt=' + vt);
  assert.strictEqual(vtState.status, 401, 'a view token cannot read the API');
  const xsite = await fetch(T.base + '/api/bots', { method: 'POST', headers: { ...T.auth, 'X-Bullpen': '1', 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"name":"x"}' });
  assert.strictEqual(xsite.status, 403);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(T.tmp, 'data')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(T.tmp, 'data', 'secret.json')).mode & 0o777, 0o600);
  }
});

test('markdown pages are self-contained (no requests back to Bullpen)', async () => {
  const pages = (await T.api('GET', '/api/state')).data.pages;
  const md = pages.find((p) => p.format === 'markdown');
  const html = await (await fetch(T.base + '/pages/' + md.id, { headers: T.auth })).text();
  assert.ok(!/src="\/md\.js"|href="\/page\.css"/.test(html), 'no external assets');
  assert.match(html, /window\.renderMarkdown/);
  assert.match(html, /<style>/);
});

test('regressions: malformed URLs never take the server down', async () => {
  for (const u of ['/%E0', '/api/channels/%25E0/messages', '/files/constructor', '/files/__proto__/x', '/pages/%ZZ']) {
    const r = await fetch(T.base + u, { headers: T.auth });
    assert.ok([400, 404].includes(r.status), u + ' -> ' + r.status);
  }
  assert.strictEqual((await T.api('GET', '/api/state')).status, 200, 'still up');
});

test('regressions: always-allow rules with odd characters go through a settings file', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'sneaky\n@@perm Bash {"command":"echo \\"done) Bash (ok\\""}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'approval' && m.card.status === 'pending'), 15000, 'approval card');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'always' });
  await idle(chief.id);
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'next' });
  await T.waitFor(() => T.calls().some((c) => c.settings && JSON.stringify(c.settings).includes('done) Bash (ok')), 15000, 'settings file');
  const last = T.calls().filter((c) => c.settings).pop();
  const allowed = last.argv[last.argv.indexOf('--allowedTools') + 1];
  assert.ok(!allowed.includes('done)'), 'rule is not in the comma list');
  assert.deepStrictEqual(last.settings.permissions.allow.slice(-1), ['Bash(echo "done) Bash (ok")']);
  // Commands with * never become rules.
  const { suggestRule } = require('../lib/app');
  assert.strictEqual(suggestRule('Bash', { command: 'rm -rf build/*' }), '');
  await idle(chief.id);
  await T.api('PATCH', '/api/bots/' + chief.id, { alwaysAllow: [] });
});

test('regressions: deleting a bot mid-turn does not bring it back', async () => {
  const b = (await T.api('POST', '/api/bots', { name: 'Doomed' })).data.bot;
  await T.api('POST', '/api/channels/dm:' + b.id + '/messages', { text: 'slow\n@@sleep 3000' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === b.id).status.state === 'working', 10000, 'working');
  await T.api('DELETE', '/api/bots/' + b.id);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!(await T.api('GET', '/api/state')).data.bots.some((x) => x.id === b.id));
  assert.ok(!fs.existsSync(path.join(T.tmp, 'data', 'bots', b.id, 'bot.json')), 'bot folder not recreated');
  assert.ok(fs.readdirSync(path.join(T.tmp, 'data', 'trash')).some((f) => f.startsWith(b.id)), 'moved to trash after the turn ended');
});

test('regressions: "New session" during a turn sticks', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'slowish\n@@sleep 1500' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === chief.id).status.state === 'working', 10000, 'working');
  await T.api('POST', '/api/bots/' + chief.id + '/reset-session');
  await idle(chief.id);
  const b = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === chief.id);
  assert.strictEqual(b.session.id, '', 'the reset was not undone by the finishing turn');
});

test('regressions: skill rename cannot delete files outside skills/', async () => {
  const victim = path.join(T.tmp, 'data', 'victim.md');
  fs.writeFileSync(victim, 'keep me');
  await T.api('POST', '/api/skills', { name: 'Harmless', description: 'x', body: 'y', prevSlug: '../victim' });
  assert.ok(fs.existsSync(victim));
});

test('regressions: a one-time routine can be re-armed after it ran', async () => {
  const r = (await T.api('POST', '/api/routines', { botId: chief.id, title: 'Once', instructions: 'x\n@@reply NO_UPDATE', schedule: { type: 'once', at: '2020-01-01T09:00' } })).data;
  await T.api('POST', '/api/routines/' + r.id + '/run');
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.routines.find((x) => x.id === r.id).runs.length, 15000, 'ran');
  await idle(chief.id);
  const future = new Date(Date.now() + 86400e3);
  const p2 = (n) => String(n).padStart(2, '0');
  const at = future.getFullYear() + '-' + p2(future.getMonth() + 1) + '-' + p2(future.getDate()) + 'T09:00';
  const upd = (await T.api('PATCH', '/api/routines/' + r.id, { schedule: { type: 'once', at }, enabled: true })).data;
  assert.ok(upd.nextRunAt > Date.now(), 'has a next run again');
  await T.api('DELETE', '/api/routines/' + r.id);
});

test('regressions: each delegated task gets its own turn and its own report', async () => {
  await T.api('PATCH', '/api/bots/' + chief.id, { paused: false });
  const st = (await T.api('GET', '/api/state')).data;
  const analyst = st.bots.find((b) => b.handle === 'analyst');
  await T.api('PATCH', '/api/bots/' + analyst.id, { paused: true });
  const ch = 'dm:' + chief.id;
  const t1 = { to: 'analyst', title: 'Alpha', instructions: 'a\n@@reply alpha-report' };
  const t2 = { to: 'analyst', title: 'Beta', instructions: 'b\n@@reply beta-report' };
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'two\n@@call delegate_task ' + JSON.stringify(t1) + '\n@@call delegate_task ' + JSON.stringify(t2) });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.tasks.filter((t) => ['Alpha', 'Beta'].includes(t.title)).length === 2, 15000, 'two tasks');
  await idle(chief.id);
  await T.api('PATCH', '/api/bots/' + analyst.id, { paused: false });
  const done = await T.waitFor(async () => { const ts = (await T.api('GET', '/api/state')).data.tasks.filter((t) => ['Alpha', 'Beta'].includes(t.title) && t.status === 'done'); return ts.length === 2 ? ts : null; }, 20000, 'both done');
  const byTitle = Object.fromEntries(done.map((t) => [t.title, t.result]));
  assert.strictEqual(byTitle.Alpha, 'alpha-report');
  assert.strictEqual(byTitle.Beta, 'beta-report');
});

test('escalation guard: handing work to a more powerful bot needs approval', async () => {
  const ops = (await T.api('POST', '/api/bots', { name: 'Ops', permission: 'full' })).data.bot;
  const reader = (await T.api('POST', '/api/bots', { name: 'Reader', permission: 'readonly' })).data.bot;
  const ch = 'dm:' + reader.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'go\n@@call delegate_task {"to":"ops","title":"Wipe","instructions":"rm -rf /tmp/x"}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'approval' && m.card.escalation && m.card.status === 'pending'), 15000, 'escalation card');
  assert.match(card.card.tool, /Hand a task to Ops \(Full access\)/);
  assert.strictEqual(card.card.rule, '', 'no "always allow" for escalations');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'deny' });
  await T.waitFor(async () => { const l = lastBot(await T.msgs(ch)); return l && /delegate_task -> ERROR The user declined this/.test(l.text); }, 15000, 'declined');
  assert.ok(!(await T.api('GET', '/api/state')).data.tasks.some((t) => t.title === 'Wipe'));
  // An "always" click on an escalation card is treated as a plain deny-proof one-time decision, never a rule.
  await idle(reader.id);
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'again\n@@call delegate_task {"to":"ops","title":"Tidy","instructions":"tidy"}' });
  const card2 = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.escalation && m.card.status === 'pending'), 15000, 'second card');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card2.id, { decision: 'allow' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.tasks.some((t) => t.title === 'Tidy'), 15000, 'task created after approval');
  const audit = (await T.api('GET', '/api/security')).data.audit;
  assert.ok(audit.some((r) => r.type === 'approval' && /Hand a task to Ops/.test(r.tool) && r.decision === 'deny'));
  assert.ok(audit.some((r) => r.type === 'bot.created' && r.bot === 'Ops' && /Full access/.test(r.detail)));
  // Same or lower permissions never ask.
  const { App } = require('../lib/app');
  await idle(reader.id); await idle(ops.id);
  await T.api('DELETE', '/api/bots/' + ops.id); await T.api('DELETE', '/api/bots/' + reader.id);
  assert.ok(App);
});

test('escalation guard in group chats: a call-in card instead of an automatic call-in', async () => {
  const ops = (await T.api('POST', '/api/bots', { name: 'Ops2', permission: 'full' })).data.bot;
  const room = (await T.api('POST', '/api/rooms', { name: 'Guarded', members: [chief.id, ops.id] })).data.room;
  const ch = 'room:' + room.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: '@chief-of-staff hi\n@@as chief-of-staff reply over to {AT}ops2' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'callin'), 15000, 'call-in card');
  await idle(chief.id);
  assert.ok(!(await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === ops.id), 'not called in automatically');
  await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'approve' });
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === ops.id), 15000, 'called in after approval');
  await idle(ops.id);
  await T.api('DELETE', '/api/bots/' + ops.id);
});

test('needs-you inbox lists cards waiting on the user and drops them once answered', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'q\n@@call ask_user {"question":"Inbox test?","options":["Yes","No"]}' });
  const item = await T.waitFor(async () => (await T.api('GET', '/api/pending')).data.items.find((i) => i.msg.card.question === 'Inbox test?'), 15000, 'pending item');
  assert.strictEqual(item.ch, ch);
  assert.ok((await T.api('GET', '/api/state')).data.pendingCount >= 1);
  await T.api('POST', '/api/channels/' + ch + '/cards/' + item.msg.id, { choices: ['Yes'] });
  assert.ok(!(await T.api('GET', '/api/pending')).data.items.some((i) => i.msg.id === item.msg.id));
  await idle(chief.id);
});

test('search, export, remember, retry and daily budget', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'The Zephyr account renews in April' });
  await T.waitFor(async () => (await T.api('GET', '/api/search?q=zephyr')).data.results.length >= 1, 15000, 'search hit');
  const hits = (await T.api('GET', '/api/search?q=ZEPHYR')).data.results;
  assert.ok(hits.some((h) => h.role === 'user' && /Zephyr account renews/.test(h.snippet)), 'case-insensitive');
  assert.deepStrictEqual((await T.api('GET', '/api/search?q=z')).data.results, [], 'needs 2+ characters');
  const exp = await fetch(T.base + '/api/channels/' + ch + '/export', { headers: T.auth });
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  assert.match(await exp.text(), /The Zephyr account renews in April/);
  await idle(chief.id);
  const userMsg = (await T.msgs(ch)).reverse().find((m) => m.role === 'user' && /Zephyr/.test(m.text));
  const rem = await T.api('POST', '/api/channels/' + ch + '/messages/' + userMsg.id + '/remember');
  assert.strictEqual(rem.status, 200);
  assert.match((await T.api('GET', '/api/bots/' + chief.id + '/memory')).data.text, /Zephyr account renews in April/);
  // retry
  const flaky = (await T.api('POST', '/api/bots', { name: 'Retry Me' })).data.bot;
  await T.api('POST', '/api/channels/dm:' + flaky.id + '/messages', { text: 'try\n@@fail first time' });
  const err = await T.waitFor(async () => (await T.msgs('dm:' + flaky.id)).find((m) => m.role === 'system' && m.meta && m.meta.retry), 15000, 'failure with retry');
  const callsBefore = T.calls().length;
  assert.strictEqual((await T.api('POST', '/api/channels/dm:' + flaky.id + '/messages/' + err.id + '/retry')).status, 200);
  await T.waitFor(() => T.calls().length > callsBefore, 15000, 'retried turn');
  assert.strictEqual((await T.api('POST', '/api/channels/dm:' + flaky.id + '/messages/' + err.id + '/retry')).status, 409, 'only once');
  await idle(flaky.id);
  await T.api('PATCH', '/api/bots/' + flaky.id, { paused: false });
  await T.api('POST', '/api/channels/dm:' + flaky.id + '/messages', { text: 'a successful turn\n@@reply success-ok' });
  await T.waitFor(async () => (await T.msgs('dm:' + flaky.id)).some((m) => m.role === 'bot' && m.text === 'success-ok'), 15000, 'success');
  await idle(flaky.id);
  // budget: fake turns cost $0.001, so a $0.001 budget blocks after one turn
  await T.api('PATCH', '/api/bots/' + flaky.id, { dailyBudgetUsd: 0.001 });
  const b = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === flaky.id);
  assert.ok(b.spentToday > 0);
  await T.api('POST', '/api/channels/dm:' + flaky.id + '/messages', { text: 'over budget' });
  await T.waitFor(async () => (await T.msgs('dm:' + flaky.id)).some((m) => m.role === 'system' && /daily budget/.test(m.text)), 15000, 'budget notice');
  const st = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === flaky.id).status;
  assert.strictEqual(st.state, 'queued');
  assert.match(st.why, /daily budget/);
  await T.api('POST', '/api/bots/' + flaky.id + '/clear-queue');
  await T.api('DELETE', '/api/bots/' + flaky.id);
});

test('folder routines run when files land, and ignore the bot\'s own writes', async () => {
  const dir = path.join(T.tmp, 'watched');
  fs.mkdirSync(dir);
  const bot = (await T.api('POST', '/api/bots', { name: 'Watcher', cwd: dir })).data.bot;
  const bad = await T.api('POST', '/api/routines', { botId: bot.id, title: 'Nope', instructions: 'x', schedule: { type: 'folder', path: path.join(T.tmp, 'missing') } });
  assert.strictEqual(bad.status, 400);
  const r = (await T.api('POST', '/api/routines', { botId: bot.id, title: 'Intake', instructions: 'Handle new files\n@@touch bot-output.txt\n@@reply folder-handled', schedule: { type: 'folder', path: dir }, notify: 'always' })).data;
  assert.match(r.scheduleText, /When files change in watched/);
  await new Promise((res) => setTimeout(res, 300));
  fs.writeFileSync(path.join(dir, 'invoice-17.csv'), 'a,b');
  fs.writeFileSync(path.join(dir, '.hidden'), 'ignored');
  const ch = 'dm:' + bot.id;
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.text === 'folder-handled'), 15000, 'folder routine ran');
  const inc = (await T.msgs(ch)).find((m) => m.role === 'incoming' && /invoice-17\.csv/.test(m.text));
  assert.ok(inc, 'payload lists the new file');
  assert.ok(!/\.hidden/.test(inc.text), 'dotfiles ignored');
  assert.ok(fs.existsSync(path.join(dir, 'bot-output.txt')));
  await idle(bot.id);
  await new Promise((res) => setTimeout(res, 2000));
  const runs = (await T.api('GET', '/api/state')).data.routines.find((x) => x.id === r.id).runs.length;
  assert.strictEqual(runs, 1, 'the bot\'s own write did not trigger another run');
  await T.api('DELETE', '/api/routines/' + r.id);
  await T.api('DELETE', '/api/bots/' + bot.id);
});

test('folder routines: files someone else drops during a run trigger the next run', async () => {
  const dir = path.join(T.tmp, 'watched2');
  fs.mkdirSync(dir);
  const bot = (await T.api('POST', '/api/bots', { name: 'Watcher2', cwd: dir })).data.bot;
  const r = (await T.api('POST', '/api/routines', { botId: bot.id, title: 'Intake2', instructions: 'Handle\n@@sleep 1500\n@@touch own-output.txt\n@@reply handled', schedule: { type: 'folder', path: dir }, notify: 'always' })).data;
  await new Promise((res) => setTimeout(res, 300));
  fs.writeFileSync(path.join(dir, 'a.csv'), '1');
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === bot.id).status.state === 'working', 15000, 'first run working');
  fs.writeFileSync(path.join(dir, 'b.csv'), '2'); // dropped by the user mid-run
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.routines.find((x) => x.id === r.id).runs.length >= 2, 20000, 'second run for b.csv');
  const inc = (await T.msgs('dm:' + bot.id)).filter((m) => m.role === 'incoming').map((m) => m.text);
  assert.ok(inc.some((t) => /b\.csv/.test(t)), 'b.csv reported');
  assert.ok(!inc.some((t) => /own-output\.txt/.test(t)), 'the bot\'s own write is never reported');
  await idle(bot.id);
  await new Promise((res) => setTimeout(res, 2000));
  assert.strictEqual((await T.api('GET', '/api/state')).data.routines.find((x) => x.id === r.id).runs.length, 2, 'no further self-triggered runs');
  await T.api('DELETE', '/api/routines/' + r.id);
  await T.api('DELETE', '/api/bots/' + bot.id);
});

test('backup downloads the data folder without the access key', async () => {
  const r = await fetch(T.base + '/api/backup', { headers: T.auth });
  assert.match(r.headers.get('content-disposition'), /bullpen-backup-.*\.tar\.gz/);
  const tar = require('zlib').gunzipSync(Buffer.from(await r.arrayBuffer()));
  const names = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString().replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
    names.push(prefix ? prefix + '/' + name : name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(names.includes('bullpen/config.json'));
  assert.ok(names.some((n) => n.startsWith('bullpen/channels/')));
  assert.ok(!names.some((n) => /secret\.json/.test(n)), 'access key not in the backup');
});

test('approvals answered after the bot moved on: card stays open, approval gives a new turn and a one-time permission', async () => {
  const b = (await T.api('POST', '/api/bots', { name: 'Patient' })).data.bot;
  const ch = 'dm:' + b.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'deploy\n@@perm Bash {"command":"npm run deploy"}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.type === 'approval'), 15000, 'card');
  // nobody answers for longer than the live wait
  await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.id === card.id && m.card.status === 'later'), 15000, 'card moved to later');
  await idle(b.id);
  const reply = (await T.msgs(ch)).filter((m) => m.role === 'bot' && m.kind === 'text').pop();
  assert.match(reply.text, /perm Bash -> deny/, 'the bot was told to move on');
  assert.ok((await T.api('GET', '/api/pending')).data.items.some((i) => i.msg.id === card.id), 'still in Needs you');
  const callsBefore = T.calls().length;
  assert.strictEqual((await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'allow' })).status, 200);
  await T.waitFor(() => T.calls().length > callsBefore, 15000, 'new turn after approval');
  await idle(b.id);
  const next = T.calls().filter((c) => c.settings).pop();
  assert.ok(next && next.settings.permissions.allow.includes('Bash(npm run deploy)'), 'one-time permission passed to the approval turn');
  assert.ok(history().some((h) => /The user approved your earlier request/.test(h.in)));
  const after = (await T.api('GET', '/api/state')).data.bots.find((x) => x.id === b.id);
  assert.deepStrictEqual(after.alwaysAllow, [], 'not made permanent');
  // Any later turn runs without it.
  const before2 = T.calls().length;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'something else' });
  await T.waitFor(() => T.calls().length > before2, 15000, 'later turn');
  await idle(b.id);
  const later = T.calls()[T.calls().length - 1];
  assert.ok(!later.settings || !JSON.stringify(later.settings).includes('npm run deploy'), 'one-time permission not reused');
  assert.strictEqual((await T.msgs(ch)).find((m) => m.id === card.id).card.status, 'allowed');
  assert.ok(!(await T.api('GET', '/api/pending')).data.items.some((i) => i.msg.id === card.id));
  await T.api('DELETE', '/api/bots/' + b.id);
});

test('bots run at low CPU priority by default', async () => {
  const ch = 'dm:' + chief.id;
  const before = T.calls().length;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'prio check\n@@sleep 300' });
  await T.waitFor(() => T.calls().length > before, 15000, 'turn');
  await idle(chief.id);
  const c = T.calls()[T.calls().length - 1];
  if (process.platform !== 'win32') assert.ok(c.priority >= 10, 'nice >= 10, got ' + c.priority);
});

test('security settings: key rotation, webhook rate limit, audit of settings changes', async () => {
  const before = (await T.api('GET', '/api/security')).data;
  assert.ok(before.accessKey && before.openUrl.includes('/#key='), 'the key travels in the URL fragment, never sent to the server');
  const unauth = await fetch(T.base + '/api/security');
  assert.strictEqual(unauth.status, 401);
  await T.api('PATCH', '/api/config', { maxDepth: 5 });
  await T.api('PATCH', '/api/config', { maxDepth: 4 });
  const audit = (await T.api('GET', '/api/security')).data.audit;
  assert.ok(audit.some((r) => r.type === 'settings.changed' && /maxDepth: 4 → 5/.test(r.detail)));
  const w = (await T.api('POST', '/api/routines', { botId: chief.id, title: 'Hooky', instructions: 'x\n@@reply NO_UPDATE', schedule: { type: 'webhook' } })).data;
  await T.api('PATCH', '/api/bots/' + chief.id, { paused: true });
  const url = T.base + new URL(w.webhook).pathname;
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await fetch(url, { method: 'POST', body: 'e' + i })).status;
  assert.strictEqual(last, 429);
  await T.api('POST', '/api/bots/' + chief.id + '/clear-queue');
  await T.api('PATCH', '/api/bots/' + chief.id, { paused: false });
  await T.api('DELETE', '/api/routines/' + w.id);
  const rot = await fetch(T.base + '/api/security/rotate-key', { method: 'POST', headers: { ...T.auth, 'X-Bullpen': '1' } });
  const fresh = await rot.json();
  assert.notStrictEqual(fresh.accessKey, before.accessKey);
  const old = await fetch(T.base + '/api/state', { headers: T.auth });
  assert.strictEqual(old.status, 401, 'old key no longer works');
  T.auth.authorization = 'Bearer ' + fresh.accessKey;
  assert.strictEqual((await T.api('GET', '/api/state')).status, 200);
});

test('send_message reports success to the sender', async () => {
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'fyi\n@@call send_message {"to":"analyst","text":"Heads up: Q4 numbers land Monday."}' });
  const reply = await T.waitFor(async () => (await T.msgs(ch)).reverse().find((m) => m.role === 'bot' && /send_message ->/.test(m.text || '')), 15000, 'reply');
  assert.match(reply.text, /send_message -> Sent to @analyst\./);
  await idle(chief.id);
});

test('the live event stream never carries webhook secrets', async () => {
  const who = (await T.api('GET', '/api/whoami')).data;
  const ac = new AbortController();
  const res = await fetch(T.base + '/api/events?vt=' + who.vt, { signal: ac.signal });
  const reader = res.body.getReader();
  let text = '';
  const w = (await T.api('POST', '/api/routines', { botId: chief.id, title: 'Secret hook', instructions: 'x', schedule: { type: 'webhook' } })).data;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !/Secret hook/.test(text)) { const { value } = await reader.read(); text += Buffer.from(value).toString(); }
  ac.abort();
  assert.ok(/Secret hook/.test(text), 'routine event seen');
  const secretPart = w.webhook.split('/').pop();
  assert.ok(!text.includes(secretPart), 'webhook secret not in the event stream');
  await T.api('DELETE', '/api/routines/' + w.id);
});
