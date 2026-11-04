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
