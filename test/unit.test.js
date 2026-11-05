'use strict';
// Short folder-routine timers for tests (set before lib/scheduler is loaded; works on every OS).
process.env.BULLPEN_FOLDER_QUIET_MS = process.env.BULLPEN_FOLDER_QUIET_MS || '300';
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

test('markdown never loads remote images', () => {
  const h = renderMarkdown('![chart](https://evil.example/p.png?secret=1) ![local](/files/f_1/a.png)');
  assert.ok(!h.includes('<img alt="chart"'));
  assert.ok(h.includes('href="https://evil.example/p.png?secret=1"'));
  assert.ok(h.includes('<img alt="local" src="/files/f_1/a.png">'));
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

test('permission mode names are read from the CLI help', () => {
  const { parseHelp } = require('../lib/claude-cli');
  const oldHelp = '  --permission-mode <mode>   Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")\n  --append-system-prompt <p>\n  ... --append-system-prompt[-file] ...';
  const newHelp = '  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: "acceptEdits", "auto",\n                                        "bypassPermissions", "manual",\n                                        "dontAsk", "plan")';
  const a = parseHelp(oldHelp);
  assert.ok(a.permissionModes.includes('default'));
  assert.ok(a.flags.has('append-system-prompt-file'));
  const b = parseHelp(newHelp);
  assert.deepStrictEqual(b.permissionModes, ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
});

test('always-allow rules are scoped to one command, domain or folder', () => {
  const { suggestRule, ruleDir } = require('../lib/app');
  assert.strictEqual(suggestRule('Bash', { command: 'npm test' }), 'Bash(npm test)');
  assert.strictEqual(suggestRule('WebFetch', { url: 'https://docs.example.com/a?b' }), 'WebFetch(domain:docs.example.com)');
  assert.strictEqual(suggestRule('Read', { file_path: '/Users/pat/Clients/Acme/notes.txt' }), 'Read(//Users/pat/Clients/Acme/**)');
  assert.strictEqual(suggestRule('Write', { file_path: '/srv/out/report.md' }), 'Edit(//srv/out/**)');
  assert.strictEqual(suggestRule('Grep', { path: '/var/log' }), 'Read(//var/log/**)');
  assert.strictEqual(ruleDir('C:\\Users\\pat\\Clients'), '//c/Users/pat/Clients/**');
  assert.strictEqual(suggestRule('Read', { file_path: 'relative.txt' }), '', 'no rule rather than a broad one');
  assert.strictEqual(suggestRule('Mystery', {}), '');
});

test('always-allow never covers the whole disk, a drive, or the home folder', () => {
  const { suggestRule } = require('../lib/app');
  const os = require('os');
  const home = os.homedir().replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase());
  assert.strictEqual(suggestRule('Read', { file_path: '/etc_file' }), 'Read(//etc_file)', 'file directly under / gets an exact-file rule');
  assert.strictEqual(suggestRule('Grep', { path: '/' }), '');
  assert.strictEqual(suggestRule('Edit', { file_path: require('path').join(os.homedir(), 'notes.md') }), 'Edit(/' + home + '/notes.md)', 'home folder: exact file only');
  assert.strictEqual(suggestRule('Read', { file_path: 'C:\\secret.txt' }), 'Read(//c/secret.txt)');
  assert.strictEqual(suggestRule('Read', { file_path: '/Users/pat/Clients/Acme/a.txt' }), 'Read(//Users/pat/Clients/Acme/**)');
});

test('folder routines catch up on files added while the folder was unwatched', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Scheduler } = require('../lib/scheduler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-watch-'));
  const fired = [];
  const r = { id: 'rt_1', botId: 'b', enabled: true, pendingApproval: false, schedule: { type: 'folder', path: dir } };
  const app = { routines: new Map([[r.id, r]]), runner: { running: new Map() }, bots: new Map(), fireRoutine: (rr, payload) => fired.push(payload), expireDeferred() {} };
  const s = new Scheduler(app);
  const until = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((res) => setTimeout(res, 20)); };
  fs.rmSync(dir, { recursive: true });
  s.syncWatchers(); // folder missing (checked without blocking): not watched, remembered as missing
  await until(() => r.watchError);
  assert.strictEqual(s.watchers.size, 0);
  assert.strictEqual(r.watchError, 'The folder is missing');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'arrived-while-missing.csv'), '1');
  s.syncWatchers(); // folder back: watched again, and the new file is queued
  await until(() => s.watchers.size === 1);
  assert.strictEqual(s.watchers.size, 1);
  await new Promise((res) => setTimeout(res, Number(process.env.BULLPEN_FOLDER_QUIET_MS || 20000) + 300));
  s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(fired.some((p) => /arrived-while-missing\.csv/.test(p)));
});

test('folder routines still fire when checking the folder is slow (network drives)', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Scheduler } = require('../lib/scheduler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-slow-'));
  const fired = [];
  const r = { id: 'rt_s', botId: 'b', enabled: true, pendingApproval: false, schedule: { type: 'folder', path: dir } };
  const app = { routines: new Map([[r.id, r]]), runner: { running: new Map() }, bots: new Map(), fireRoutine: (rr, p) => fired.push(p), expireDeferred() {} };
  const s = new Scheduler(app);
  const w = { path: dir, changed: new Set(['a.csv']), during: new Set(), carry: new Set(), timer: null, fires: [], watcher: { close() {} } };
  s.watchers.set(r.id, w);
  const realAccess = fs.promises.access;
  let checks = 0;
  fs.promises.access = (p) => { checks++; return new Promise((res) => setTimeout(res, 1500)); };
  try {
    s.folderFire(r.id);
    s.folderFire(r.id); // a second trigger while the first check is running starts no second check
    await new Promise((res) => setTimeout(res, 2000));
  } finally { fs.promises.access = realAccess; s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  assert.strictEqual(checks, 1, 'one check');
  assert.strictEqual(fired.length, 1, 'fired once after the slow check');
});

test('a slow folder check never fires for an edited routine or a file still changing', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Scheduler } = require('../lib/scheduler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-slow2-'));
  const fired = [];
  const r = { id: 'rt_e', botId: 'b', enabled: true, pendingApproval: false, schedule: { type: 'folder', path: dir } };
  const app = { routines: new Map([[r.id, r]]), runner: { running: new Map() }, bots: new Map(), fireRoutine: (rr, p) => fired.push(p), expireDeferred() {} };
  const s = new Scheduler(app);
  const mk = (files) => ({ path: dir, changed: new Set(files), during: new Set(), carry: new Set(), timer: null, fires: [], watcher: { close() {} } });
  const realAccess = fs.promises.access;
  fs.promises.access = () => new Promise((res) => setTimeout(res, 400));
  try {
    // edited mid-check: the old check's result is ignored
    const w1 = mk(['old.csv']);
    s.watchers.set(r.id, w1);
    s.folderFire(r.id);
    s.watchers.set(r.id, mk(['new.csv']));
    await new Promise((res) => setTimeout(res, 600));
    assert.strictEqual(fired.length, 0, 'no fire from a stale check');
    // still changing when the check ends: wait for quiet
    const w3 = mk(['copying.bin']);
    s.watchers.set(r.id, w3);
    s.folderFire(r.id);
    await new Promise((res) => setTimeout(res, 250));
    w3.lastEventAt = Date.now(); // a write arrives during the check
    await new Promise((res) => setTimeout(res, 300));
    assert.strictEqual(fired.length, 0, 'not reported while still changing');
  } finally { fs.promises.access = realAccess; s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
