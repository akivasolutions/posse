'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, Channels } = require('../lib/store');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bullpen-store-'));
  const store = new Store(dir);
  return { dir, store, ch: new Channels(store) };
}
const ts = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('messages go to one file per month and page back across months', () => {
  const { dir, store, ch } = fresh();
  for (let m = 1; m <= 3; m++) for (let i = 0; i < 5; i++) ch.add('dm:x', { id: 'm' + m + '-' + i, ts: ts(2026, m, 1 + i), text: 'msg ' + m + '.' + i });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'channels', 'dm-x')).sort(), ['2026-01.jsonl', '2026-02.jsonl', '2026-03.jsonl']);
  const c2 = new Channels(store);
  const p1 = c2.page('dm:x', { limit: 4 });
  assert.deepStrictEqual(p1.messages.map((m) => m.id), ['m3-1', 'm3-2', 'm3-3', 'm3-4']);
  assert.ok(p1.more);
  assert.strictEqual(c2.cache.get('dm:x').next, 2, 'only the newest month was read');
  const p2 = c2.page('dm:x', { before: 'm3-1', limit: 4 });
  assert.deepStrictEqual(p2.messages.map((m) => m.id), ['m2-2', 'm2-3', 'm2-4', 'm3-0']);
  const all = c2.recent('dm:x', 100);
  assert.strictEqual(all.length, 15);
  assert.strictEqual(all[0].id, 'm1-0');
  clearInterval(ch.timer); clearInterval(c2.timer);
});

test('patches land in the message\'s own month and survive reloads', () => {
  const { store, ch } = fresh();
  ch.add('dm:x', { id: 'old', ts: ts(2026, 1, 5), kind: 'card', card: { status: 'open' } });
  ch.add('dm:x', { id: 'new', ts: ts(2026, 3, 5), text: 'hi' });
  const c2 = new Channels(store);
  assert.strictEqual(c2.patch('dm:x', 'old', { card: { status: 'answered', answer: 'A' } }).card.status, 'answered');
  const c3 = new Channels(store);
  assert.strictEqual(c3.get('dm:x', 'old').card.answer, 'A');
  assert.strictEqual(c3.get('dm:x', 'nope'), null);
  [ch, c2, c3].forEach((c) => clearInterval(c.timer));
});

test('legacy single-file chats are still read', () => {
  const { dir, store } = fresh();
  fs.mkdirSync(path.join(dir, 'channels'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'channels', 'dm-y.jsonl'), JSON.stringify({ id: 'a', ts: ts(2025, 12, 1), text: 'legacy' }) + '\n' + JSON.stringify({ _patch: 'a', set: { reactions: [{ emoji: '👍' }] } }) + '\n');
  const c = new Channels(store);
  c.add('dm:y', { id: 'b', ts: ts(2026, 2, 1), text: 'new' });
  const r = c.recent('dm:y', 10);
  assert.deepStrictEqual(r.map((m) => m.id), ['a', 'b']);
  assert.strictEqual(r[0].reactions[0].emoji, '👍');
  c.trash('dm:y');
  assert.ok(!fs.existsSync(path.join(dir, 'channels', 'dm-y.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'channels', 'dm-y')));
  clearInterval(c.timer);
});

test('idle chats are dropped from memory and reload on demand', () => {
  const { ch } = fresh();
  ch.add('dm:z', { id: 'z1', ts: Date.now(), text: 'x' });
  ch.evict(Date.now() + 11 * 60e3);
  assert.ok(!ch.cache.has('dm:z'));
  assert.strictEqual(ch.recent('dm:z', 5)[0].id, 'z1');
  clearInterval(ch.timer);
});
