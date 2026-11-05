'use strict';
// App shutdown and restart: in-flight work survives a normal Ctrl+C.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('./helpers');

test('a normal shutdown keeps in-flight work queued and does not start new turns', async () => {
  const T = await startServer();
  const chief = (await T.api('GET', '/api/state')).data.bots.find((b) => b.primary);
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'long\n@@sleep 5000' });
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots[0].status.state === 'working', 10000, 'working');
  await T.waitFor(() => T.calls().length >= 1, 10000, 'the first turn to start'); // the CLI starts slower on Windows
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'queued behind it' });
  const callsBefore = T.calls().length;
  await T.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(T.calls().length, callsBefore, 'no turn started during shutdown');
  const q = JSON.parse(fs.readFileSync(path.join(T.tmp, 'data', 'bots', chief.id, 'queue.json'), 'utf8'));
  assert.strictEqual(q.inflight.length, 1, 'the interrupted input is still in flight');
  assert.strictEqual(q.queue.length, 1, 'the waiting input is still queued');
  const msgs = fs.readdirSync(path.join(T.tmp, 'data', 'channels')).length;
  assert.ok(msgs >= 1);
});

test('an approval the bot moved on from survives a restart and still works', async () => {
  let T = await startServer();
  const chief = (await T.api('GET', '/api/state')).data.bots.find((b) => b.primary);
  const ch = 'dm:' + chief.id;
  await T.api('POST', '/api/channels/' + ch + '/messages', { text: 'deploy\n@@perm Bash {"command":"make deploy"}' });
  const card = await T.waitFor(async () => (await T.msgs(ch)).find((m) => m.kind === 'card' && m.card.status === 'later'), 20000, 'later card');
  await T.waitFor(async () => (await T.api('GET', '/api/state')).data.bots[0].status.state === 'idle', 15000, 'idle');
  const tmp = T.tmp;
  await T.stop();
  T = await startServer({ tmp });
  const after = (await T.msgs(ch)).find((m) => m.id === card.id);
  assert.strictEqual(after.card.status, 'later', 'still answerable after restart');
  assert.ok((await T.api('GET', '/api/pending')).data.items.some((i) => i.msg.id === card.id), 'still in Needs you');
  const r = await T.api('POST', '/api/channels/' + ch + '/cards/' + card.id, { decision: 'allow' });
  assert.strictEqual(r.status, 200);
  await T.waitFor(() => T.calls().some((c) => c.settings && JSON.stringify(c.settings).includes('make deploy')), 15000, 'approved turn with one-time permission');
  await T.stop();
});
