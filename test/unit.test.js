'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../public/md.js');
const { nextRun, describeSchedule } = require('../lib/scheduler');
const { mentions, slugify } = require('../lib/util');
const { describeTool } = require('../lib/runner');

test('markdown escapes HTML and blocks unsafe links', () => {
  const h = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.com/?q=1&b=2)');
  assert.ok(!h.includes('<img'));
  assert.ok(!/href="javascript/i.test(h));
  assert.ok(h.includes('href="https://a.com/?q=1&amp;b=2"'));
});

test('markdown block features', () => {
  const h = renderMarkdown('# T\n\n- a\n  - b\n- [x] done\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n```js\nconst x = "<y>";\n```\n> quote\n\n**bold** _it_ `code`');
  assert.match(h, /<h1>T<\/h1>/);
  assert.match(h, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li class="task"><input type="checkbox" disabled checked> done<\/li><\/ul>/);
  assert.match(h, /<th>A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(h, /<pre><code data-lang="js">const x = &quot;&lt;y&gt;&quot;;<\/code><\/pre>/);
  assert.match(h, /<blockquote>/);
  assert.match(h, /<strong>bold<\/strong> <em>it<\/em> <code>code<\/code>/);
});

test('markdown keeps snake_case and URLs intact', () => {
  const h = renderMarkdown('call my_var_name at https://x.com/a_b_c.');
  assert.ok(h.includes('my_var_name'));
  assert.ok(h.includes('href="https://x.com/a_b_c"'));
});

test('daily schedule skips to the next allowed weekday', () => {
  const fri = new Date(2026, 10, 6, 9, 0).getTime(); // Fri Nov 6, 2026 09:00
  const n = new Date(nextRun({ type: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, fri));
  assert.strictEqual(n.getDay(), 1);
  assert.strictEqual(n.getHours(), 8);
  assert.strictEqual(n.getMinutes(), 30);
  const sameDay = new Date(nextRun({ type: 'daily', time: '17:00', days: [5] }, fri));
  assert.strictEqual(sameDay.getDate(), 6);
});

test('interval and once schedules', () => {
  const now = Date.now();
  assert.strictEqual(nextRun({ type: 'interval', minutes: 60 }, now, 0), now + 3600e3);
  assert.strictEqual(nextRun({ type: 'interval', minutes: 60 }, now, now - 7200e3), now, 'missed runs catch up once');
  assert.strictEqual(nextRun({ type: 'once', at: '2020-01-01T00:00' }, now, 0), now);
  assert.strictEqual(nextRun({ type: 'once', at: '2020-01-01T00:00' }, now, now - 1), 0);
  assert.strictEqual(describeSchedule({ type: 'daily', time: '08:28', days: [1, 2, 3, 4, 5] }), 'Weekdays at 8:28 AM');
  assert.strictEqual(describeSchedule({ type: 'interval', minutes: 90 }), 'Every 90 minutes');
});

test('mentions and handles', () => {
  assert.deepStrictEqual(mentions('hey @analyst and @Chief-of-Staff, email a@b.com'), ['analyst', 'chief-of-staff']);
  assert.strictEqual(slugify('Client Accounts — ACME'), 'client-accounts-acme');
});

test('tool steps read as plain English', () => {
  assert.strictEqual(describeTool('Read', { file_path: '/a/b/report.xlsx' }), 'Read report.xlsx');
  assert.strictEqual(describeTool('mcp__bullpen__delegate_task', { to: 'analyst', title: 'Q3' }), 'Delegated to @analyst: Q3');
});
