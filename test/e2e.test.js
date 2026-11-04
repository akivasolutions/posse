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
const history = () => fs.readdirSync(path.join(T.tmp, 'fake')).filter((f) => f.startsWith('session-')).map((f) => JSON.parse(fs.readFileSync(path.join(T.tmp, 'fake', f), 'utf8')).history).flat();
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
  assert.strictEqual(last[last.indexOf('--setting-sources') + 1], 'project,local');
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
  const pr = await fetch(T.base + '/pages/' + page.card.pageId);
  assert.match(pr.headers.get('content-security-policy'), /sandbox/);
  const body = await pr.text();
  assert.ok(!body.includes('<script>alert(1)</script>'), 'markdown page content is not injected raw');
  const fc = all.find((m) => m.kind === 'card' && m.card.type === 'file');
  const fr = await fetch(T.base + '/files/' + fc.card.fileId + '/report.txt');
  assert.strictEqual(await fr.text(), 'hello file');
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'user' && m.reactions && m.reactions[0].emoji === '👍'), 15000, 'reaction');
});

test('group chat: mention routing and bot-to-bot @mentions', async () => {
  const st = (await T.api('GET', '/api/state')).data;
  const analyst = st.bots.find((b) => b.handle === 'analyst');
  const room = (await T.api('POST', '/api/rooms', { name: 'Close', members: [chief.id, analyst.id] })).data.room;
  const ch = 'room:' + room.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: '@analyst kick off\n@@reply On it — @chief-of-staff please review.' });
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === analyst.id), 15000, 'analyst in room');
  // The analyst's reply mentioned the chief, so the chief is called in (and sees the room transcript).
  await T.waitFor(async () => (await T.msgs(ch)).some((m) => m.role === 'bot' && m.botId === chief.id), 15000, 'chief called in');
  const msgs = await T.msgs(ch);
  assert.ok(!msgs.some((m) => m.role === 'bot' && m.botId === chief.id && msgs.indexOf(m) < msgs.findIndex((x) => x.botId === analyst.id)), 'chief answered after analyst');
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
  const noHeader = await fetch(T.base + '/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
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
