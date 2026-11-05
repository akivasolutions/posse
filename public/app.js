(function () {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => window.escapeHtml(s == null ? '' : String(s));
  const md = (s) => window.renderMarkdown(s || '');

  const S = { config: {}, bots: [], rooms: [], tasks: [], routines: [], pages: [], skills: [], usage: { today: {} }, cli: {} };
  const V = { ch: null, pane: null, msgs: {}, more: {}, pending: [], dirtyMem: null, sse: null, inbox: [], searchQ: '', results: [] };

  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const PERMS = {
    ask: ['Ask me', 'Reads its own working folder freely. Edits, commands, web pages and files elsewhere show you an approval card first.'],
    edits: ['Auto-edit', 'Edits files in its folder without asking. Commands still need your approval.'],
    auto: ['Auto-review', 'Claude Code\'s safety classifier approves routine actions and blocks risky ones (needs a recent Claude Code).'],
    readonly: ['Read only', 'Can read, search and use Posse tools. Never edits files or runs commands.'],
    full: ['Full access', 'Runs anything without asking. Only for bots you trust in folders you can afford to lose.'],
  };
  // Starting points for new bots. Everything stays editable.
  const TEMPLATES = [
    { key: 'account', label: 'Account manager', avatar: '💼', name: 'Account Manager', title: 'Client account', permission: 'ask',
      description: 'Owns one client account: knows its history, contacts, systems and open requests, and keeps them moving.',
      instructions: 'You manage one client account. Keep a running record in memory of the client\'s contacts, systems, preferences, open requests and decisions.\n\nWhen asked for status, lead with what changed, what is blocked, and what needs the user. Draft client emails with draft_message; never send anything yourself. Ask before changing any file you did not create.' },
    { key: 'research', label: 'Researcher', avatar: '🔎', name: 'Researcher', title: 'Research', permission: 'ask',
      description: 'Finds and checks facts, compares options, and reports with sources.',
      instructions: 'Answer with tight bullet points and cite where each fact came from (file path or URL). Say plainly when something is unverified. Prefer primary sources.' },
    { key: 'writer', label: 'Writer', avatar: '✍️', name: 'Writer', title: 'Writing and email', permission: 'ask',
      description: 'Turns notes and findings into clear emails, summaries and documents.',
      instructions: 'Write plainly: short sentences, no filler, lead with the point. Match the requested length exactly. Emails go out as draft cards (draft_message) for the user to send.' },
    { key: 'analyst', label: 'Analyst', avatar: '📊', name: 'Analyst', title: 'Data and spreadsheets', permission: 'edits',
      description: 'Works through spreadsheets, CSVs and reports; checks numbers and builds summaries and trackers.',
      instructions: 'Show the numbers behind every conclusion. Check totals and spot-check rows before reporting. When a result is worth keeping, save it as a page (save_page) with a small table.' },
    { key: 'inbox', label: 'Inbox triage', avatar: '📥', name: 'Triage', title: 'Incoming work', permission: 'readonly',
      description: 'Reads what comes in (files, exports, webhook events), sorts it, and routes anything actionable to the right teammate.',
      instructions: 'For each new item: say what it is, who it is for, and how urgent it is in one line. Hand actionable items to the right teammate with delegate_task. Stay quiet (NO_UPDATE in routines) when nothing needs attention.' },
  ];
  const ROUTINE_TEMPLATES = [
    { key: 'digest', label: 'Daily digest', title: 'Daily digest', notify: 'always', schedule: { type: 'daily', time: '17:00', days: [1, 2, 3, 4, 5] },
      instructions: 'Check in with the team (task_list scope all, include_done) and write a short end-of-day digest: what got done today, what is still open and with whom, and anything that needs me tomorrow. Group by client or project.' },
    { key: 'brief', label: 'Morning brief', title: 'Morning brief', notify: 'smart', schedule: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] },
      instructions: 'Review your memory, open tasks and anything new in your working folder. Tell me in five bullets or fewer what needs my attention today, most urgent first.' },
    { key: 'intake', label: 'Folder intake', title: 'Folder intake', notify: 'smart', schedule: { type: 'folder', path: '' },
      instructions: 'New files arrived. For each one: say what it is and whether it needs action. Hand actionable work to the right teammate with delegate_task. If nothing needs me, reply NO_UPDATE.' },
  ];
  const COLORS = ['#4f6bed', '#0e9f6e', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#475569'];
  const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---------------- access key ----------------
  // The key lives in this origin's localStorage (other ports on 127.0.0.1 can't read it) and goes
  // out as a header. Links the browser loads on its own carry a read-only view token instead.
  const KEY_STORE = 'posse.key';
  let KEY = '';
  let VT = '';
  try { KEY = localStorage.getItem(KEY_STORE) || ''; } catch {}
  // A key from a sign-in link (#key=…) is checked before it replaces the stored one, so a wrong or
  // stale link can't sign you out.
  function linkKey() {
    const m = /(?:^#|&)key=([^&]+)/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try { return decodeURIComponent(m[1]); } catch { return ''; }
  }
  async function keyWorks(k) {
    if (!k) return false;
    const r = await fetch('/api/whoami', { headers: { Authorization: 'Bearer ' + k } }).catch(() => null);
    return !!(r && r.ok);
  }
  let pendingLinkKey = linkKey();
  // Pasting a sign-in link into a tab that's already open only changes the #fragment, which
  // doesn't reload the page; check the key and start over.
  window.addEventListener('hashchange', async () => {
    const k = linkKey();
    if (k === null) return;
    if (await keyWorks(k)) { try { localStorage.setItem(KEY_STORE, k); } catch {} location.reload(); }
    else toast('That sign-in link is not valid (the key may have been changed).', true);
  });
  // Another tab made a new key: adopt it.
  window.addEventListener('storage', (e) => { if (e.key === KEY_STORE && e.newValue && e.newValue !== KEY) location.reload(); });
  const authH = () => ({ Authorization: 'Bearer ' + KEY, 'X-Posse': '1' });
  const vt = (url) => url + (url.includes('?') ? '&' : '?') + 'vt=' + encodeURIComponent(VT);
  // Exports and backups need the key itself, so they are fetched (with the header) and saved from memory.
  // Exports and backups: ask for a one-time ticket with the key, then let the browser download
  // the file directly (nothing is held in this page's memory).
  async function downloadAuthed(url) {
    try {
      const r = await api('POST', '/api/download-ticket', { path: url });
      const a = document.createElement('a');
      a.href = r.url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } catch (e) { toast('Download failed: ' + e.message, true); }
  }

  function signIn(msg) {
    if (V.sse) { V.sse.close(); V.sse = null; }
    document.body.innerHTML = '<div class="signin"><form id="signin"><div class="brand"><span class="brand-mark">P</span>Posse</div>' +
      '<p>Enter your access key. It\'s printed in the window where Posse is running and saved in <code>secret.json</code> in its data folder.</p>' +
      (msg ? '<p class="err">' + esc(msg) + '</p>' : '') +
      '<input type="password" id="signin-key" autocomplete="current-password" placeholder="Access key" autofocus><button class="btn primary">Sign in</button></form></div>';
    document.getElementById('signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      const k = document.getElementById('signin-key').value.trim();
      const r = await fetch('/api/whoami', { headers: { Authorization: 'Bearer ' + k } }).catch(() => null);
      if (!r || !r.ok) return signIn('That key didn\'t work.');
      KEY = k;
      try { localStorage.setItem(KEY_STORE, KEY); } catch {}
      location.reload();
    });
  }

  // ---------------- API ----------------
  async function api(method, url, body) {
    const opts = { method, headers: authH() };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    if (r.status === 401) {
      let stored = '';
      try { stored = localStorage.getItem(KEY_STORE) || ''; } catch {}
      if (stored && stored !== KEY) { location.reload(); throw new Error('Signing in again'); } // another tab rotated the key
      try { if (stored === KEY) localStorage.removeItem(KEY_STORE); } catch {}
      signIn('Please sign in again.');
      throw new Error('Sign in required');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }
  const chUrl = (ch) => '/api/channels/' + encodeURIComponent(ch);

  function toast(text, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = text;
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    box.appendChild(el);
    setTimeout(() => el.remove(), err ? 6000 : 3000);
  }
  async function attempt(fn) { try { return await fn(); } catch (e) { toast(e.message, true); return null; } }

  // ---------------- lookups / formatting ----------------
  const botById = (id) => S.bots.find((b) => b.id === id);
  const roomById = (id) => S.rooms.find((r) => r.id === id);
  const taskById = (id) => S.tasks.find((t) => t.id === id);
  const primary = () => S.bots.find((b) => b.primary) || S.bots[0];
  const visibleBots = () => S.bots.filter((b) => !b.hidden);

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return t;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + t;
  }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function fmtTokens(n) { return n ? (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)) : '—'; }

  function botAv(b, size = '', dot = false) {
    if (!b) return '<div class="av ' + size + ' room-av">?</div>';
    const st = b.status && b.status.state;
    const isEmoji = !/^[\w]{1,3}$/.test(b.avatar || '');
    return '<div class="av ' + size + '" style="background:' + esc(b.color) + (isEmoji ? '22' : '') + ';' + (isEmoji ? 'color:inherit' : '') + '">' + esc(b.avatar || b.name[0]) +
      (dot && st && st !== 'idle' ? '<i class="dot ' + esc(st) + '"></i>' : '') + '</div>';
  }
  function userAv(size = '') {
    const n = (S.config.userName || 'Y').trim();
    return '<div class="av ' + size + '" style="background:var(--text-2)">' + esc(n[0].toUpperCase()) + '</div>';
  }
  function statusText(b) {
    const s = b.status || {};
    if (s.state === 'working') return s.activity || 'Working…';
    if (s.state === 'waiting') return s.activity || 'Waiting for your approval';
    if (s.state === 'queued') return s.queued + ' waiting' + (s.why ? ' (' + s.why + ')' : '') + (S.config.paused ? ' — Posse is paused' : '');
    if (s.state === 'paused') return 'Paused';
    return b.title || 'Idle';
  }

  // ---------------- theme ----------------
  function applyTheme() {
    const c = S.config;
    if (c.theme === 'light' || c.theme === 'dark') document.documentElement.dataset.theme = c.theme;
    else delete document.documentElement.dataset.theme;
    document.documentElement.style.setProperty('--accent', c.accent || '#4f6bed');
    const unread = S.bots.reduce((n, b) => n + (b.unread || 0), 0) + S.rooms.reduce((n, r) => n + (r.unread || 0), 0);
    document.title = (unread ? '(' + unread + ') ' : '') + 'Posse';
  }

  // ---------------- routing ----------------
  function go(ch, { replace } = {}) {
    if (V.linksStale) { V.msgs = {}; refreshState().then(() => { V.linksStale = false; if (V.ch === ch) { renderMain(); renderPane(); } }).catch(() => {}); }
    V.ch = ch;
    const h = '#' + ch.replace(':', '/');
    if (location.hash !== h) { if (replace) history.replaceState(null, '', h); else history.pushState(null, '', h); }
    document.body.classList.remove('side-open');
    if (V.pane && V.pane.startsWith('page:') && !ch.startsWith('view:')) { /* keep page open beside chat */ }
    renderSide();
    renderMain();
    renderPane();
    if (isChat(ch)) {
      const o = ch.startsWith('dm:') ? botById(ch.slice(3)) : roomById(ch.slice(5));
      if (o && o.unread) { o.unread = 0; renderSide(); }
      api('POST', chUrl(ch) + '/read').catch(() => {});
    }
  }
  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    const [kind, id] = h.split('/');
    if (kind === 'dm' && botById(id)) return 'dm:' + id;
    if (kind === 'room' && roomById(id)) return 'room:' + id;
    if (kind === 'view' && ['library', 'tasks', 'routines', 'skills', 'memory', 'hidden', 'inbox', 'search'].includes(id)) return 'view:' + id;
    const p = primary();
    return p ? 'dm:' + p.id : 'view:library';
  }
  const isChat = (ch) => ch && (ch.startsWith('dm:') || ch.startsWith('room:'));
  window.addEventListener('popstate', () => {
    if (!$('#side') || /key=/.test(location.hash)) return; // sign-in screen, or a sign-in link being handled
    if (V.linksStale) { go(fromHash(), { replace: true }); return; }
    V.ch = fromHash(); renderSide(); renderMain(); renderPane();
  });

  // ---------------- sidebar ----------------
  function sectionOrder() {
    const order = [...(S.config.sections || [])];
    for (const b of visibleBots()) if (b.section && !order.includes(b.section)) order.push(b.section);
    return order;
  }

  function renderSide() {
    const collapsed = new Set(S.config.collapsed || []);
    const p = primary();
    const botRow = (b) => '<div class="row' + (V.ch === 'dm:' + b.id ? ' active' : '') + '" data-ch="dm:' + b.id + '" data-bot="' + b.id + '">' +
      botAv(b, '', true) + '<span class="name">' + esc(b.name) + '</span>' + (b.primary ? '<span class="star" title="Primary bot">★</span>' : '') +
      (b.unread ? '<span class="badge">' + b.unread + '</span>' : '') + '</div>';
    const needs = S.pendingCount || 0;
    let html = '<div class="side-head"><div class="brand"><span class="brand-mark">P</span>Posse</div>' +
      '<button class="icon-btn' + (S.config.paused ? ' on' : '') + '" data-act="pause" title="' + (S.config.paused ? 'Resume all bots' : 'Pause all bots') + '">' + (S.config.paused ? '▶' : '⏸') + '</button>' +
      '<button class="icon-btn" data-act="new-bot" title="New bot">＋</button></div>' +
      '<button class="search-btn" data-act="palette">Search or jump to… <kbd>' + (navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K') + '</kbd></button>' +
      '<div class="side-scroll">' +
      '<div class="row' + (V.ch === 'view:inbox' ? ' active' : '') + '" data-ch="view:inbox"><div class="av room-av">' + (needs ? '!' : '✓') + '</div><span class="name">Needs you</span>' + (needs ? '<span class="badge" style="background:var(--warn)">' + needs + '</span>' : '') + '</div>';
    if (p && !p.hidden) html += botRow(p);
    const loose = visibleBots().filter((b) => !b.primary && !b.section);
    html += loose.map(botRow).join('');
    for (const sec of sectionOrder()) {
      const bots = visibleBots().filter((b) => !b.primary && b.section === sec);
      if (!bots.length) continue;
      const c = collapsed.has(sec);
      html += '<div class="sec-head' + (c ? ' collapsed' : '') + '"><span class="caret" data-act="toggle-sec" data-sec="' + esc(sec) + '">' + esc(sec) + '</span></div>';
      if (!c) html += bots.map(botRow).join('');
    }
    const rc = collapsed.has('__rooms');
    html += '<div class="sec-head' + (rc ? ' collapsed' : '') + '"><span class="caret" data-act="toggle-sec" data-sec="__rooms">Group chats</span><button class="icon-btn" data-act="new-room" title="New group chat">＋</button></div>';
    if (!rc) {
      html += S.rooms.map((r) => '<div class="row' + (V.ch === 'room:' + r.id ? ' active' : '') + '" data-ch="room:' + r.id + '" data-room="' + r.id + '"><div class="av room-av">#</div><span class="name">' + esc(r.name) + '</span>' +
        (r.unread ? '<span class="badge">' + r.unread + '</span>' : '') + '</div>').join('');
      if (!S.rooms.length) html += '<div class="row" data-act="new-room" style="color:var(--muted)"><div class="av room-av">＋</div><span class="name">New group chat</span></div>';
    }
    html += '</div>';
    const hiddenN = S.bots.filter((b) => b.hidden).length;
    const nav = [['library', '▤', 'Library'], ['tasks', '☑', 'Tasks'], ['routines', '◷', 'Routines'], ['skills', '✦', 'Skills'], ['memory', '◎', 'Memory']];
    html += '<div class="side-foot">' + nav.map(([id, ic, label]) => '<button class="nav-btn' + (V.ch === 'view:' + id ? ' active' : '') + '" data-ch="view:' + id + '"><span>' + ic + '</span>' + label + '</button>').join('') + '</div>';
    html += '<div class="account" data-act="settings">' + userAv() + '<div class="who"><b>' + esc(S.config.userName) + '</b><small>' +
      (S.cli.found ? (S.usage.today.turns || 0) + ' turns today' + (hiddenN ? ' · ' + hiddenN + ' hidden' : '') : 'Claude Code not found') + '</small></div><span style="color:var(--muted)">⚙</span></div>';
    $('#side').innerHTML = html;
    applyTheme();
  }

  $('#side').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'pause') attempt(() => api('PATCH', '/api/config', { paused: !S.config.paused }));
      else if (a === 'new-bot') botModal(null);
      else if (a === 'new-room') roomModal(null);
      else if (a === 'palette') openPalette();
      else if (a === 'settings') settingsModal();
      else if (a === 'toggle-sec') {
        const set = new Set(S.config.collapsed || []);
        const sec = act.dataset.sec;
        set.has(sec) ? set.delete(sec) : set.add(sec);
        S.config.collapsed = [...set];
        renderSide();
        api('PATCH', '/api/config', { collapsed: S.config.collapsed }).catch(() => {});
      }
      return;
    }
    const row = e.target.closest('[data-ch]');
    if (row) go(row.dataset.ch);
  });
  $('#side').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-bot],[data-room]');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.bot) botMenu(botById(row.dataset.bot), e.clientX, e.clientY);
    else roomMenu(roomById(row.dataset.room), e.clientX, e.clientY);
  });

  // ---------------- context menus ----------------
  function menu(items, x, y) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : '<button data-i="' + i + '" class="' + (it.danger ? 'danger' : '') + '">' + esc(it.label) + '</button>').join('');
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; closeMenu(); items[+b.dataset.i].run(); });
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }
  function closeMenu() { $$('.menu').forEach((m) => m.remove()); }

  function botMenu(b, x, y) {
    if (!b) return;
    const items = [
      { label: 'Open chat', run: () => go('dm:' + b.id) },
      { label: 'Bot settings…', run: () => botModal(b) },
      { label: 'Move to section…', run: () => sectionModal(b) },
      { label: b.hidden ? 'Show in sidebar' : 'Hide from sidebar', run: () => attempt(() => api('PATCH', '/api/bots/' + b.id, { hidden: !b.hidden })) },
    ];
    if (!b.primary) items.push({ label: 'Make primary bot', run: () => attempt(() => api('PATCH', '/api/bots/' + b.id, { primary: true })) });
    items.push({ label: b.paused ? 'Resume bot' : 'Pause bot', run: () => attempt(() => api('PATCH', '/api/bots/' + b.id, { paused: !b.paused })) });
    items.push('-', { label: 'Delete bot…', danger: true, run: () => deleteBot(b) });
    menu(items, x, y);
  }
  function roomMenu(r, x, y) {
    if (!r) return;
    menu([
      { label: 'Open', run: () => go('room:' + r.id) },
      { label: 'Edit group chat…', run: () => roomModal(r) },
      '-',
      { label: 'Delete group chat…', danger: true, run: () => deleteRoom(r) },
    ], x, y);
  }
  async function deleteBot(b) {
    if (!(await confirmBox('Delete ' + b.name + '?', 'This removes the bot, its whole chat history, memory and routines. Open tasks assigned to it are marked failed. (A copy goes to the data/trash folder.)', 'Delete bot'))) return;
    await attempt(() => api('DELETE', '/api/bots/' + b.id));
  }
  async function deleteRoom(r) {
    if (!(await confirmBox('Delete "' + r.name + '"?', 'The group chat and its history are removed. The bots and their own chats stay.', 'Delete group chat'))) return;
    await attempt(() => api('DELETE', '/api/rooms/' + r.id));
  }

  // ---------------- main area ----------------
  function banner() {
    if (!S.cli.found) return '<div class="banner err"><span class="grow"><b>Claude Code CLI not found.</b> ' + esc(S.cli.error || '') + '</span><button class="btn sm" data-act="settings">Settings</button></div>';
    if (S.config.paused) return '<div class="banner"><span class="grow"><b>All bots are paused.</b> New messages wait in each bot\'s queue.</span><button class="btn sm" data-act="resume">Resume</button></div>';
    return '';
  }

  function renderMain() {
    const ch = V.ch;
    const main = $('#main');
    if (!ch) { main.innerHTML = ''; return; }
    if (ch.startsWith('view:')) { main.innerHTML = banner() + '<div class="head"><button class="icon-btn only-narrow" data-act="side">☰</button><div class="t"><b>' + esc(viewTitle(ch)) + '</b></div></div><div class="view" id="view"></div>'; renderView(); return; }
    main.innerHTML = banner() + '<div class="head" id="head"></div><div id="msgs"></div><div class="composer" id="composer"></div>';
    renderHead();
    renderComposer();
    loadMessages(ch);
  }

  $('#main').addEventListener('click', (e) => {
    if (document.body.classList.contains('side-open') && !e.target.closest('[data-act=side]')) { document.body.classList.remove('side-open'); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'settings') settingsModal();
    else if (act === 'resume') attempt(() => api('PATCH', '/api/config', { paused: false }));
    else if (act === 'side') document.body.classList.toggle('side-open');
    else if (act === 'info') togglePane();
    else if (act === 'stop') attempt(() => api('POST', '/api/bots/' + a.dataset.id + '/stop'));
    else if (act === 'more') loadMessages(V.ch, true);
  });

  function renderHead() {
    const head = $('#head');
    if (!head) return;
    const ch = V.ch;
    let html = '<button class="icon-btn only-narrow" data-act="side">☰</button>';
    if (ch.startsWith('dm:')) {
      const b = botById(ch.slice(3));
      if (!b) return;
      const st = b.status || {};
      const live = st.state === 'working' || st.state === 'waiting';
      html += botAv(b, 'md', true) + '<div class="t" data-act="info"><b>' + esc(b.name) + (b.primary ? ' <span class="star" style="color:var(--accent);font-size:12px">★ primary</span>' : '') + '</b><small class="' + (live ? 'live' : '') + '">' + esc(statusText(b)) + '</small></div>';
      if (live) html += '<button class="btn sm danger" data-act="stop" data-id="' + b.id + '">■ Stop</button>';
    } else {
      const r = roomById(ch.slice(5));
      if (!r) return;
      const members = r.members.map(botById).filter(Boolean);
      const busy = members.filter((m) => m.status && (m.status.state === 'working' || m.status.state === 'waiting'));
      html += '<div class="av md room-av">#</div><div class="t" data-act="info"><b>' + esc(r.name) + '</b><small class="' + (busy.length ? 'live' : '') + '">' +
        esc(busy.length ? busy.map((m) => m.name + ': ' + statusText(m)).join(' · ') : members.map((m) => m.name).join(', ') || 'No bots yet') + '</small></div>';
      for (const m of busy) html += '<button class="btn sm danger" data-act="stop" data-id="' + m.id + '">■ ' + esc(m.name) + '</button>';
    }
    html += '<button class="icon-btn" data-act="info" title="Details (' + (navigator.platform.includes('Mac') ? '⌘⇧I' : 'Ctrl+Shift+I') + ')">ⓘ</button>';
    head.innerHTML = html;
  }

  // ---------------- messages ----------------
  async function loadMessages(ch, older) {
    if (!older && V.msgs[ch]) { renderMessages(); return; }
    const before = older && V.msgs[ch] && V.msgs[ch][0] ? '&before=' + V.msgs[ch][0].id : '';
    const data = await attempt(() => api('GET', chUrl(ch) + '/messages?limit=80' + before));
    if (!data) return;
    const prevH = $('#msgs') ? $('#msgs').scrollHeight : 0;
    V.msgs[ch] = older ? data.messages.concat(V.msgs[ch] || []) : data.messages;
    V.more[ch] = data.more;
    if (V.ch !== ch) return;
    renderMessages(!older);
    if (older) { const el = $('#msgs'); el.scrollTop = el.scrollHeight - prevH; }
  }

  function renderMessages(scroll = true) {
    const el = $('#msgs');
    if (!el) return;
    const list = V.msgs[V.ch] || [];
    let html = V.more[V.ch] ? '<button class="btn sm more" data-act="more">Load earlier messages</button>' : '';
    if (!list.length) html += emptyChat();
    let prev = null;
    for (const m of list) { html += msgHTML(m, prev); prev = m; }
    html += '<div id="live"></div>';
    el.innerHTML = html;
    renderLive();
    if (scroll) el.scrollTop = el.scrollHeight;
    if (V.flash) {
      const hit = el.querySelector('[data-id="' + CSS.escape(V.flash) + '"]');
      if (hit) { hit.scrollIntoView({ block: 'center' }); setTimeout(() => { V.flash = null; }, 2500); }
      else if (V.more[V.ch]) loadMessages(V.ch, true);
      else V.flash = null;
    }
  }

  function emptyChat() {
    if (V.ch.startsWith('dm:')) {
      const b = botById(V.ch.slice(3));
      if (!b) return '';
      return '<div class="empty">' + botAv(b, 'lg') + '<h3>' + esc(b.name) + '</h3><p>' + esc(b.description || 'Say hello. This conversation keeps going for as long as you use it.') + '</p>' +
        (b.primary ? '<p>This is your <b>primary bot</b>. Bring it anything; it hands work to the right specialist and reports back.</p>' : '') + '</div>';
    }
    return '<div class="empty"><div class="av lg room-av">#</div><h3>Group chat</h3><p>Everyone here sees the conversation. @mention a bot to call on it; otherwise the first member answers.</p></div>';
  }

  function sameAuthor(a, b) {
    return a && b && a.role === b.role && a.botId === b.botId && ['user', 'bot'].includes(a.role) && b.ts - a.ts < 5 * 60e3 && a.kind !== 'card' && b.kind !== 'card';
  }

  function msgHTML(m, prev) {
    const id = ' data-id="' + esc(m.id) + '"';
    const meta = m.meta || {};
    if (m.role === 'system') {
      const retry = meta.retry && !meta.retried ? ' <button class="btn sm" data-act="retry">Retry</button>' : '';
      return '<div class="msg system' + (meta.error ? ' err' : '') + (meta.quiet ? ' quiet' : '') + '"' + id + '><div class="body">' + esc(m.text) + retry + '</div></div>';
    }
    if (m.role === 'incoming') {
      const from = botById(meta.from);
      const av = from ? botAv(from) : '<div class="av room-av">' + (meta.routineId ? '⏰' : '↘') + '</div>';
      const peek = (m.text || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').slice(0, 140);
      return '<div class="msg incoming' + (meta.quiet ? ' quiet' : '') + '"' + id + '>' + av + '<div><div class="inc"><div class="inc-label" data-act="toggle-inc">' + esc(meta.label || 'Incoming') +
        ' <time style="color:var(--muted);font-weight:400">' + fmtTime(m.ts) + '</time></div><div class="peek">' + esc(peek) + '</div><div class="body md">' + md(m.text) + '</div></div></div></div>';
    }
    const cont = sameAuthor(prev, m);
    let who; let av;
    if (m.role === 'user') { who = S.config.userName; av = userAv(); }
    else { const b = botById(m.botId); who = b ? b.name : 'Deleted bot'; av = botAv(b); }
    let body = '';
    if (m.kind === 'card') body = cardHTML(m);
    else body = '<div class="body md">' + md(m.text) + '</div>';
    if (m.files && m.files.length) body += '<div class="files">' + m.files.map((f) => '<a class="chip" href="' + esc(f.url || '#') + '" target="_blank">📎 ' + esc(f.name) + ' <small>' + fmtSize(f.size || 0) + '</small></a>').join('') + '</div>';
    if (m.reactions && m.reactions.length) body += '<div class="reactions">' + m.reactions.map((r) => { const b = botById(r.botId); return '<span title="' + esc(b ? b.name : '') + '">' + esc(r.emoji) + '</span>'; }).join('') + '</div>';
    if (meta.steps && meta.steps.length) {
      body += '<details class="steps"><summary>' + meta.steps.length + ' step' + (meta.steps.length === 1 ? '' : 's') + (meta.ms ? ' · ' + Math.max(1, Math.round(meta.ms / 1000)) + 's' : '') +
        (meta.partial ? ' · partial (turn did not finish)' : '') + '</summary><ol>' + meta.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol></details>';
    }
    const tools = m.kind !== 'card' && m.text ? '<span class="msg-tools"><button data-act="copy-msg" title="Copy">⧉</button><button data-act="remember" title="Save to the bot\'s memory">📌</button></span>' : '';
    return '<div class="msg ' + m.role + (cont ? ' cont' : '') + (meta.quiet ? ' quiet' : '') + (V.flash === m.id ? ' flash' : '') + '"' + id + '>' + av + '<div><div class="meta"><b>' + esc(who) + '</b><time>' + fmtTime(m.ts) + '</time></div>' + body + '</div>' + tools + '</div>';
  }

  function cardHTML(m) {
    const c = m.card || {};
    const st = c.status;
    switch (c.type) {
      case 'question': {
        let h = '<div class="card"><h4>❓ ' + esc(c.question) + '</h4>';
        if (st === 'answered') return h + '<div class="answer">↳ ' + esc(c.answer) + '</div></div>';
        if (c.options && c.options.length) h += '<div class="opts">' + c.options.map((o) => '<button class="opt" data-act="' + (c.multi ? 'q-toggle' : 'q-pick') + '" data-val="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
        if (c.allowText || c.multi) {
          h += (c.allowText ? '<input type="text" placeholder="' + (c.options && c.options.length ? 'Or type an answer…' : 'Type your answer…') + '" data-role="q-text">' : '') +
            '<div class="row-actions"><button class="btn sm primary" data-act="q-send">Send</button></div>';
        }
        return h + '</div>';
      }
      case 'approval': {
        const raw = Object.entries(c.input || {}).map(([k, v]) => k + ': ' + v).join('\n').replace(/\r\n/g, '\n');
        // Make direction overrides and zero-width characters visible, so text can't be disguised.
        // Show every character that could hide or reorder text: invisible ones, bidi controls, lone
        // carriage returns and other control characters (the HTML parser turns \r into a line break).
        const input = raw.replace(/(?!\uFE0F)[\p{Default_Ignorable_Code_Point}\u061c\u202a-\u202e\u2066-\u2069\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu,
          (ch) => '⟦U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '⟧');
        const lines = raw.split(/\r\n?|[\n\v\f\x85\u2028\u2029]/).length;
        const sizeNote = c.fullSize ? c.fullSize.toLocaleString() + ' characters in all · <b>only the first part is shown</b>' : raw.length.toLocaleString() + ' characters';
        let h = '<div class="card approval"><h4>' + (c.escalation ? '🛡 ' + esc(c.tool) + '?' : '⚠️ Approve ' + esc(c.tool) + '?') + '</h4>' +
          '<div class="k">' + lines + ' line' + (lines === 1 ? '' : 's') + ' · ' + sizeNote + (raw.length > 600 || lines > 12 ? ' · <button class="btn sm" data-act="expand">Show all</button>' : '') + '</div>' +
          (c.escalation === 'shared' ? '<div class="k">Every bot reads this, including ones with more permissions than the bot asking. Approve only if you want it saved as shown.</div>'
            : c.escalation ? '<div class="k">That bot has more permissions than the one asking. Approve only if this is exactly what you want done; everything it will receive is shown below.</div>' : '') + '<pre class="input">' + esc(input) + '</pre>';
        if (st === 'pending' || st === 'later') {
          if (st === 'later') h += '<div class="k" style="margin-bottom:4px">The bot moved on while waiting. Answer any time: approving gives it a new turn to do this.</div>';
          h += '<div class="row-actions"><button class="btn sm primary" data-act="ap" data-d="allow">Allow once</button>' +
            (c.rule ? '<button class="btn sm" data-act="ap" data-d="always" title="Adds the rule ' + esc(c.rule) + ' to this bot">Always allow ' + esc(ruleScope(c.rule)) + '</button>' : '') +
            '<button class="btn sm danger" data-act="ap" data-d="deny">Deny</button></div>' +
            (c.rule ? '<div class="k" style="margin-top:6px">Always allow adds the rule <code>' + esc(c.rule) + '</code> to this bot.</div>' : '');
        } else {
          const label = { allowed: ['ok', 'Allowed'], always: ['ok', 'Always allowed'], denied: ['bad', 'Denied' + (c.note ? ' — ' + c.note : '')], expired: ['bad', 'Expired'] }[st] || ['', st];
          h += '<div class="row-actions"><span class="state ' + label[0] + '">' + esc(label[1]) + '</span></div>';
        }
        return h + '</div>';
      }
      case 'draft': {
        const mailto = 'mailto:' + encodeURIComponent(c.to || '').replace(/%2C/g, ',').replace(/%40/g, '@') + '?subject=' + encodeURIComponent(c.subject || '') + '&body=' + encodeURIComponent(c.body || '');
        return '<div class="card"><h4>✉️ Draft ' + esc(c.kind === 'chat' ? 'message' : c.kind || 'email') + '</h4>' +
          (c.to ? '<div><span class="k">To</span> ' + esc(c.to) + '</div>' : '') + (c.subject ? '<div><span class="k">Subject</span> ' + esc(c.subject) + '</div>' : '') +
          '<div class="draft-body">' + esc(c.body) + '</div><div class="row-actions"><button class="btn sm primary" data-act="copy-draft">Copy</button>' +
          (c.kind !== 'chat' && mailto.length < 1900 ? '<a class="btn sm" href="' + esc(mailto) + '">Open in email app</a>' : '') + '<span class="k">You send it yourself.</span></div></div>';
      }
      case 'page': {
        const p = S.pages.find((x) => x.id === c.pageId);
        return '<div class="card"><h4>▤ ' + esc(p ? p.title : c.title) + '</h4><div class="k">' + (p ? (c.updated ? 'Page updated' : 'Saved to your Library') : 'This page was deleted') + '</div>' +
          (p ? '<div class="row-actions"><button class="btn sm primary" data-act="open-page" data-id="' + esc(c.pageId) + '">Open</button><a class="btn sm" target="_blank" href="' + esc(c.url || '#') + '">New tab ↗</a></div>' : '') + '</div>';
      }
      case 'file':
        return '<div class="card"><h4>📎 ' + esc(c.name) + '</h4><div class="k">' + fmtSize(c.size || 0) + (c.caption ? ' · ' + esc(c.caption) : '') + '</div>' +
          '<div class="row-actions"><a class="btn sm primary" target="_blank" href="' + esc(c.url || '#') + '">Open</a>' +
          '<a class="btn sm" href="' + esc((c.url || '#') + '&download=1') + '">Download</a></div></div>';
      case 'task': {
        const t = taskById(c.taskId);
        if (!t) return '<div class="card task"><span>☑</span><div class="tt"><b>Task #' + esc(c.taskId) + '</b></div></div>';
        const to = botById(t.to);
        return '<div class="card task" data-task="' + t.id + '"><span>☑</span><div class="tt"><b>#' + t.id + ' ' + esc(t.title) + '</b><span class="k">→ ' + esc(to ? to.name : 'deleted bot') + '</span></div><span class="pill ' + esc(t.status) + '">' + esc(t.status) + '</span></div>';
      }
      case 'callin': {
        const t = botById(c.botId); const f = botById(c.fromBotId);
        let h = '<div class="card approval"><h4>🛡 Call in ' + esc(t ? t.name : '?') + '?</h4><div class="k">' + esc(f ? f.name : 'A bot') + ' mentioned ' + esc(t ? t.name : 'a bot') + ', which has more permissions (' + esc(c.perm) + '). Bring it into this chat?</div>';
        if (st === 'pending') h += '<div class="row-actions"><button class="btn sm primary" data-act="rt" data-d="approve">Call in</button><button class="btn sm" data-act="rt" data-d="decline">Not now</button></div>';
        else h += '<div class="row-actions"><span class="state ' + (st === 'approved' ? 'ok' : 'bad') + '">' + esc(st === 'approved' ? 'Called in' : 'Declined') + '</span></div>';
        return h + '</div>';
      }
      case 'routine': {
        const b = botById(c.botId);
        let h = '<div class="card"><h4>⏰ Routine: ' + esc(c.title) + '</h4><div><span class="k">When</span> ' + esc(c.scheduleText) + '</div><div><span class="k">Bot</span> ' + esc(b ? b.name : '?') + '</div>' +
          '<div class="draft-body">' + esc(c.instructions) + '</div>';
        if (st === 'pending') h += '<div class="row-actions"><button class="btn sm primary" data-act="rt" data-d="approve">Approve</button><button class="btn sm" data-act="rt" data-d="decline">Decline</button></div>';
        else h += '<div class="row-actions"><span class="state ' + (st === 'approved' ? 'ok' : 'bad') + '">' + esc(st === 'approved' ? 'Approved — it\'s on your Routines list' : st) + '</span></div>';
        return h + '</div>';
      }
      default: return '<div class="card">' + esc(c.type) + '</div>';
    }
  }

  // Don't redraw the inbox under someone who is typing an answer in it.
  function inboxBusy() { return $$('#inbox input, #inbox textarea').some((x) => x.value || x === document.activeElement); }

  // Short description of what an "Always allow" rule covers, for the button label.
  function ruleScope(rule) {
    let m = /^Read\(\/\/(.*)\/\*\*\)$/.exec(rule);
    if (m) return 'reads in ' + m[1].split('/').pop();
    m = /^Edit\(\/\/(.*)\/\*\*\)$/.exec(rule);
    if (m) return 'edits in ' + m[1].split('/').pop();
    m = /^WebFetch\(domain:(.*)\)$/.exec(rule);
    if (m) return m[1];
    if (/^(Bash|PowerShell)\(/.test(rule)) return 'this command';
    return '';
  }

  function renderLive() {
    const el = $('#live');
    if (!el || !isChat(V.ch)) return;
    let bots = [];
    if (V.ch.startsWith('dm:')) { const b = botById(V.ch.slice(3)); if (b) bots = [b]; }
    else { const r = roomById(V.ch.slice(5)); if (r) bots = r.members.map(botById).filter(Boolean); }
    el.innerHTML = bots.filter((b) => b.status && (b.status.state === 'working' || b.status.state === 'waiting') && (!b.status.ch || b.status.ch === V.ch))
      .map((b) => '<div class="live-row"><span class="spin"></span><span><b>' + esc(b.name) + '</b> · ' + esc(statusText(b)) + '</span></div>').join('');
  }

  function upsertMessage(ch, msg) {
    const list = V.msgs[ch];
    if (!list) return;
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) list[i] = msg; else list.push(msg);
    if (ch !== V.ch) return;
    const el = $('#msgs');
    if (!el) return;
    const existing = el.querySelector('[data-id="' + CSS.escape(msg.id) + '"]');
    const idx = list.findIndex((m) => m.id === msg.id);
    const html = msgHTML(msg, list[idx - 1]);
    if (existing) { existing.outerHTML = html; return; }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    const empty = el.querySelector('.empty');
    if (empty) empty.remove();
    $('#live').insertAdjacentHTML('beforebegin', html);
    if (nearBottom || msg.role === 'user') el.scrollTop = el.scrollHeight;
  }

  // card + message actions
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('#msgs [data-act], #inbox [data-act]');
    if (!a) return;
    const msgEl = a.closest('[data-id]');
    const id = msgEl && msgEl.dataset.id;
    const act = a.dataset.act;
    const ch = (msgEl && msgEl.dataset.ch) || V.ch;
    const m = id && ((V.msgs[ch] || []).find((x) => x.id === id) || ((V.inbox || []).find((x) => x.msg.id === id) || {}).msg);
    const answer = async (body) => { const r = await attempt(() => api('POST', chUrl(ch) + '/cards/' + encodeURIComponent(id), body)); if (r && V.ch === 'view:inbox') renderView(); return r; };
    if (act === 'toggle-inc') a.closest('.inc').classList.toggle('open');
    else if (act === 'q-pick') answer({ choices: [a.dataset.val] });
    else if (act === 'q-toggle') a.classList.toggle('sel');
    else if (act === 'q-send') {
      const choices = $$('.opt.sel', msgEl).map((x) => x.dataset.val);
      const t = $('[data-role=q-text]', msgEl);
      answer({ choices, text: t ? t.value : '' });
    } else if (act === 'ap') answer({ decision: a.dataset.d });
    else if (act === 'rt') answer({ decision: a.dataset.d });
    else if (act === 'copy-draft' && m) {
      const c = m.card;
      const text = (c.subject ? 'Subject: ' + c.subject + '\n\n' : '') + c.body;
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed — select the text instead', true); }
    } else if (act === 'open-page') openPage(a.dataset.id);
    else if (act === 'expand') { const pre = a.closest('.card').querySelector('pre.input'); pre.classList.toggle('full'); a.textContent = pre.classList.contains('full') ? 'Show less' : 'Show all'; }
    else if (act === 'copy-msg' && m) { try { await navigator.clipboard.writeText(m.text || ''); toast('Copied'); } catch { toast('Copy failed', true); } }
    else if (act === 'remember' && m) { const r = await attempt(() => api('POST', chUrl(ch) + '/messages/' + encodeURIComponent(id) + '/remember')); if (r) toast('Saved to ' + ((botById(r.botId) || {}).name || 'the bot') + '\'s memory'); }
    else if (act === 'retry') attempt(() => api('POST', chUrl(ch) + '/messages/' + encodeURIComponent(id) + '/retry'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#msgs [data-role=q-text], #inbox [data-role=q-text]')) {
      const card = e.target.closest('[data-id]');
      const btn = card && $('[data-act=q-send]', card);
      if (btn) btn.click();
    }
  });

  // ---------------- composer ----------------
  function renderComposer() {
    const el = $('#composer');
    if (!el) return;
    let ph = 'Message';
    if (V.ch.startsWith('dm:')) { const b = botById(V.ch.slice(3)); ph = 'Message ' + (b ? b.name : ''); }
    else ph = 'Message the group — @mention a bot to call on it';
    el.innerHTML = '<div class="composer-box"><div class="files" id="pending"></div><textarea id="input" rows="1" placeholder="' + esc(ph) + '"></textarea>' +
      '<div class="bar"><button class="icon-btn" data-c="attach" title="Attach files">📎</button><span class="hint">Enter to send · Shift+Enter for a new line</span>' +
      '<button class="btn primary sm" data-c="send">Send</button></div></div><input type="file" id="file-in" multiple hidden>';
    V.pending = [];
    const ta = $('#input');
    const draftKey = 'posse.draft.' + V.ch;
    try { ta.value = localStorage.getItem(draftKey) || ''; } catch {}
    autosize(ta);
    ta.addEventListener('input', () => { autosize(ta); try { localStorage.setItem(draftKey, ta.value); } catch {} mentionPop(ta); });
    ta.addEventListener('keydown', (e) => {
      const pop = $('.mention-pop');
      if (pop && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) { mentionKey(e, ta); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
    });
    ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); files.forEach(upload); } });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      if (b.dataset.c === 'attach') $('#file-in').click();
      else if (b.dataset.c === 'send') sendMessage();
      else if (b.dataset.c === 'unpend') { V.pending = V.pending.filter((f) => f.id !== b.dataset.id); renderPending(); }
    });
    $('#file-in').addEventListener('change', (e) => { [...e.target.files].forEach(upload); e.target.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); [...e.dataTransfer.files].forEach(upload); });
    if (matchMedia('(min-width: 760px)').matches) ta.focus();
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; }

  async function upload(file) {
    if (file.size > 200 * 1024 * 1024) { toast(file.name + ' is over 200 MB', true); return; }
    const r = await fetch('/api/upload', { method: 'POST', headers: { ...authH(), 'X-Filename': encodeURIComponent(file.name) }, body: file }).then((x) => x.json()).catch(() => null);
    if (!r || !r.id) { toast('Upload failed: ' + file.name, true); return; }
    V.pending.push(r);
    renderPending();
  }
  function renderPending() {
    const el = $('#pending');
    if (el) el.innerHTML = V.pending.map((f) => '<span class="chip">📎 ' + esc(f.name) + ' <button data-c="unpend" data-id="' + esc(f.id) + '">✕</button></span>').join('');
  }

  async function sendMessage() {
    const ta = $('#input');
    const text = ta.value.trim();
    if (!text && !V.pending.length) return;
    const files = V.pending.map((f) => f.id);
    const ch = V.ch;
    ta.value = '';
    autosize(ta);
    try { localStorage.removeItem('posse.draft.' + ch); } catch {}
    V.pending = [];
    renderPending();
    askNotify();
    const r = await attempt(() => api('POST', chUrl(ch) + '/messages', { text, files }));
    if (!r) { ta.value = text; autosize(ta); }
  }

  // @mention autocomplete (group chats)
  function mentionPop(ta) {
    $$('.mention-pop').forEach((p) => p.remove());
    if (!V.ch.startsWith('room:')) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([\w-]*)$/.exec(before);
    if (!m) return;
    const r = roomById(V.ch.slice(5));
    const q = m[2].toLowerCase();
    const opts = (r ? r.members : []).map(botById).filter((b) => b && (b.handle.includes(q) || b.name.toLowerCase().includes(q))).slice(0, 6);
    if (!opts.length) return;
    const pop = document.createElement('div');
    pop.className = 'mention-pop';
    pop.innerHTML = opts.map((b, i) => '<div class="row' + (i === 0 ? ' sel' : '') + '" data-h="' + esc(b.handle) + '">' + botAv(b) + '<span class="name">' + esc(b.name) + '</span><small style="color:var(--muted)">@' + esc(b.handle) + '</small></div>').join('');
    pop.addEventListener('mousedown', (e) => { const row = e.target.closest('[data-h]'); if (row) { e.preventDefault(); insertMention(ta, row.dataset.h); } });
    $('#composer').appendChild(pop);
  }
  function mentionKey(e, ta) {
    const pop = $('.mention-pop');
    const rows = $$('.row', pop);
    let i = rows.findIndex((r) => r.classList.contains('sel'));
    if (e.key === 'Escape') { pop.remove(); return; }
    e.preventDefault();
    if (e.key === 'ArrowDown') i = (i + 1) % rows.length;
    else if (e.key === 'ArrowUp') i = (i - 1 + rows.length) % rows.length;
    else { insertMention(ta, rows[i].dataset.h); return; }
    rows.forEach((r, k) => r.classList.toggle('sel', k === i));
  }
  function insertMention(ta, handle) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos).replace(/@([\w-]*)$/, '@' + handle + ' ');
    ta.value = before + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = before.length;
    $$('.mention-pop').forEach((p) => p.remove());
    ta.focus();
  }

  // ---------------- right pane ----------------
  function togglePane() {
    V.pane = V.pane === 'info' ? null : 'info';
    renderPane();
  }
  function openPage(id) { V.pane = 'page:' + id; renderPane(); }

  function renderPane() {
    const msgs = $('#msgs');
    const stick = msgs && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 160;
    renderPaneInner();
    if (stick && msgs.isConnected) msgs.scrollTop = msgs.scrollHeight;
  }

  function renderPaneInner() {
    const pane = $('#pane');
    pane.classList.toggle('wide', !!(V.pane && V.pane.startsWith('page:')));
    if (!V.pane || (V.pane === 'info' && !isChat(V.ch))) { pane.classList.add('hidden'); pane.innerHTML = ''; delete pane.dataset.page; return; }
    pane.classList.remove('hidden');
    if (V.pane.startsWith('page:')) {
      const p = S.pages.find((x) => x.id === V.pane.slice(5));
      if (!p) { V.pane = null; renderPaneInner(); return; }
      const src = (p.url || '') + '&v=' + p.updatedAt;
      if (pane.dataset.page === src) return;
      pane.dataset.page = src;
      pane.innerHTML = '<div class="pane-head"><b>▤ ' + esc(p.title) + '</b><a class="btn sm" target="_blank" href="' + esc(p.url || '#') + '">New tab ↗</a><button class="icon-btn" data-p="close">✕</button></div>' +
        '<iframe class="page-frame" sandbox="allow-scripts allow-modals allow-downloads" referrerpolicy="no-referrer" src="' + esc(src) + '"></iframe>';
      return;
    }
    delete pane.dataset.page;
    if (V.ch.startsWith('dm:')) renderBotPane(pane, botById(V.ch.slice(3)));
    else renderRoomPane(pane, roomById(V.ch.slice(5)));
  }

  function renderBotPane(pane, b) {
    if (!b) return;
    // Unsaved memory edits survive a re-render of the same bot's pane, never another bot's.
    const keepMem = V.dirtyMem === b.id && $('#mem-text') ? $('#mem-text').value : null;
    if (V.dirtyMem && V.dirtyMem !== b.id) V.dirtyMem = null;
    const st = b.status || {};
    const perm = PERMS[b.permission || S.config.defaultPermission] || PERMS.ask;
    const routines = S.routines.filter((r) => r.botId === b.id);
    const tasks = S.tasks.filter((t) => (t.to === b.id || t.from === b.id) && !['done', 'failed', 'cancelled'].includes(t.status));
    let h = '<div class="pane-head"><b>Details</b><button class="icon-btn" data-p="edit" title="Bot settings">⚙</button><button class="icon-btn" data-p="close">✕</button></div>';
    h += '<div class="profile">' + botAv(b, 'lg') + '<h2>' + esc(b.name) + '</h2><div class="sub">@' + esc(b.handle) + (b.title ? ' · ' + esc(b.title) : '') + '</div>' +
      (b.description ? '<p>' + esc(b.description) + '</p>' : '') + '<div class="pane-actions">' +
      '<button class="btn sm" data-p="pause">' + (b.paused ? '▶ Resume' : '⏸ Pause') + '</button>' +
      '<button class="btn sm" data-p="reset" title="Start a fresh Claude session; memory and chat stay">↺ New session</button>' +
      '<button class="btn sm" data-p="edit">⚙ Settings</button><button class="btn sm" data-p="export">⤓ Export chat</button></div></div>';
    h += '<div class="pane-sec"><h5>Status</h5><dl class="kv">' +
      '<dt>Now</dt><dd><span class="pill ' + esc(st.state) + '">' + esc(st.state || 'idle') + '</span> ' + esc(st.state === 'working' || st.state === 'waiting' ? st.activity || '' : '') + '</dd>' +
      '<dt>Model</dt><dd>' + esc(b.model || S.config.defaultModel + ' (default)') + (b.effort ? ' · ' + esc(b.effort) + ' effort' : '') + '</dd>' +
      '<dt>Permissions</dt><dd>' + esc(perm[0]) + '</dd>' +
      '<dt>Folder</dt><dd style="font:12px var(--mono)">' + esc(b.cwd || '(its own workspace)') + '</dd>' +
      '<dt>Session</dt><dd>' + (b.session && b.session.id ? (b.session.turns || 0) + ' turns · context ' + fmtTokens(b.session.contextTokens) + ' of ' + fmtTokens(S.config.sessionMaxTokens) +
        '<div class="meter"><i style="width:' + Math.min(100, Math.round(100 * (b.session.contextTokens || 0) / (S.config.sessionMaxTokens || 150000))) + '%"></i></div>' : 'starts on next message') + '</dd>' +
      '<dt>Today</dt><dd>$' + (b.spentToday || 0).toFixed(2) + (b.dailyBudgetUsd ? ' of $' + b.dailyBudgetUsd.toFixed(2) + ' budget' : '') + ' API-equivalent</dd>' +
      '<dt>All time</dt><dd>' + ((b.stats && b.stats.turns) || 0) + ' turns · $' + (((b.stats && b.stats.costUsd) || 0).toFixed(2)) + ' API-equivalent</dd>' +
      (st.queued ? '<dt>Waiting</dt><dd>' + st.queued + ' input(s) <button class="btn sm" data-p="clear">Clear</button></dd>' : '') +
      '</dl></div>';
    h += '<div class="pane-sec"><h5><span class="grow">Routines</span><button class="btn sm" data-p="add-routine">＋ Add</button></h5>' +
      (routines.length ? routines.map((r) => '<div class="list-item"><span>⏰</span><div class="grow"><b>' + esc(r.title) + '</b><small>' + esc(r.scheduleText) + (r.nextRunAt ? ' · next ' + esc(fmtTime(r.nextRunAt)) : '') + '</small></div>' +
        '<span class="pill ' + (r.pendingApproval ? 'waiting' : r.enabled ? 'on' : 'paused') + '">' + (r.pendingApproval ? 'pending' : r.enabled ? 'on' : 'paused') + '</span></div>').join('') : '<small style="color:var(--muted)">None yet. Ask the bot to set one up, or add it here.</small>') + '</div>';
    if (tasks.length) {
      h += '<div class="pane-sec"><h5>Open tasks</h5>' + tasks.map((t) => {
        const other = botById(t.to === b.id ? t.from : t.to);
        return '<div class="list-item"><span>☑</span><div class="grow"><b>#' + t.id + ' ' + esc(t.title) + '</b><small>' + (t.to === b.id ? 'from ' : 'to ') + esc(other ? other.name : '?') + '</small></div><span class="pill ' + esc(t.status) + '">' + esc(t.status) + '</span></div>';
      }).join('') + '</div>';
    }
    h += '<div class="pane-sec"><h5><span class="grow">Memory</span><button class="btn sm" data-p="save-mem">Save</button></h5><textarea class="mem" id="mem-text" placeholder="Facts this bot keeps across sessions. It adds to this itself.">' + '</textarea></div>';
    pane.innerHTML = h;
    const ta = $('#mem-text');
    if (keepMem != null) ta.value = keepMem;
    else api('GET', '/api/bots/' + b.id + '/memory').then((r) => { if (V.dirtyMem !== b.id && ta.isConnected) ta.value = r.text; }).catch(() => {});
    ta.addEventListener('input', () => { V.dirtyMem = b.id; });
  }

  function renderRoomPane(pane, r) {
    if (!r) return;
    const members = r.members.map(botById).filter(Boolean);
    const others = S.bots.filter((b) => !r.members.includes(b.id));
    let h = '<div class="pane-head"><b>Group chat</b><button class="icon-btn" data-p="edit-room" title="Edit">⚙</button><button class="icon-btn" data-p="close">✕</button></div>';
    h += '<div class="profile"><div class="av lg room-av">#</div><h2>' + esc(r.name) + '</h2><div class="sub">' + members.length + ' bot' + (members.length === 1 ? '' : 's') + ' + you</div></div>';
    h += '<div class="pane-sec"><h5>Members</h5>' + members.map((b) => '<div class="list-item">' + botAv(b) + '<div class="grow"><b>' + esc(b.name) + '</b><small>@' + esc(b.handle) + (b.title ? ' · ' + esc(b.title) : '') + '</small></div><button class="btn sm" data-p="rm-member" data-id="' + b.id + '">Remove</button></div>').join('') +
      (others.length ? '<div class="list-item"><select id="add-member" style="flex:1">' + others.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select><button class="btn sm" data-p="add-member">Add</button></div>' : '') + '</div>';
    h += '<div class="pane-sec"><small style="color:var(--muted)">The first member answers when nobody is @mentioned. Bots can @mention each other to hand off, up to the hand-off limit in Settings.</small><div class="pane-actions"><button class="btn sm danger" data-p="del-room">Delete group chat</button></div></div>';
    pane.innerHTML = h;
  }

  $('#pane').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-p]');
    if (!a) return;
    const p = a.dataset.p;
    const b = V.ch && V.ch.startsWith('dm:') ? botById(V.ch.slice(3)) : null;
    const r = V.ch && V.ch.startsWith('room:') ? roomById(V.ch.slice(5)) : null;
    if (p === 'close') { V.pane = null; V.dirtyMem = null; renderPane(); }
    else if (p === 'edit' && b) botModal(b);
    else if (p === 'pause' && b) attempt(() => api('PATCH', '/api/bots/' + b.id, { paused: !b.paused }));
    else if (p === 'reset' && b) {
      if (await confirmBox('Start a fresh session for ' + b.name + '?', 'The bot keeps its memory and this chat history. Its Claude context starts over, with a recap of the recent chat on the next turn. Use this when it seems confused or its context is very large.', 'New session', false)) attempt(() => api('POST', '/api/bots/' + b.id + '/reset-session'));
    } else if (p === 'clear' && b) attempt(() => api('POST', '/api/bots/' + b.id + '/clear-queue'));
    else if (p === 'export' && b) downloadAuthed(chUrl('dm:' + b.id) + '/export');
    else if (p === 'add-routine' && b) routineModal(null, b.id);
    else if (p === 'save-mem' && b) { const ok = await attempt(() => api('PUT', '/api/bots/' + b.id + '/memory', { text: $('#mem-text').value })); if (ok) { V.dirtyMem = null; toast('Memory saved'); } }
    else if (p === 'edit-room' && r) roomModal(r);
    else if (p === 'del-room' && r) deleteRoom(r);
    else if (p === 'rm-member' && r) attempt(() => api('PATCH', '/api/rooms/' + r.id, { members: r.members.filter((m) => m !== a.dataset.id) }));
    else if (p === 'add-member' && r) attempt(() => api('PATCH', '/api/rooms/' + r.id, { members: [...r.members, $('#add-member').value] }));
  });

  // ---------------- full-page views ----------------
  function viewTitle(ch) {
    return { 'view:library': 'Library', 'view:tasks': 'Tasks', 'view:routines': 'Routines', 'view:skills': 'Skills', 'view:memory': 'Shared memory', 'view:hidden': 'Hidden bots', 'view:inbox': 'Needs you', 'view:search': 'Search' }[ch] || '';
  }

  function renderView() {
    const el = $('#view');
    if (!el) return;
    const v = V.ch.slice(5);
    if (v === 'library') {
      el.innerHTML = '<p class="lead">Reports, dashboards and trackers your bots saved. Ask any bot to "make a page" for something.</p>' +
        (S.pages.length ? '<div class="grid">' + S.pages.map((p) => { const b = botById(p.botId); return '<div class="tile" data-v="page" data-id="' + esc(p.id) + '"><b>▤ ' + esc(p.title) + '</b><small>' + esc(b ? b.name : '') + ' · ' + esc(fmtTime(p.updatedAt)) + ' · ' + esc(p.format) + '</small>' +
          '<div style="display:flex;gap:6px;margin-top:4px"><a class="btn sm" target="_blank" href="' + esc(p.url || '#') + '" data-stop="1">New tab ↗</a><button class="btn sm danger" data-v="del-page" data-id="' + esc(p.id) + '">Delete</button></div></div>'; }).join('') + '</div>'
          : '<div class="empty"><h3>No pages yet</h3><p>Try: "Make me a page that tracks my open client requests."</p></div>');
    } else if (v === 'tasks') {
      const cols = [['Waiting', ['queued']], ['Working', ['working', 'held']], ['Done', ['done']], ['Failed / cancelled', ['failed', 'cancelled']]];
      el.innerHTML = '<p class="lead">Work your bots handed to each other. A finished task is reported back to whoever delegated it.</p><div class="board">' + cols.map(([label, sts]) => {
        const list = S.tasks.filter((t) => sts.includes(t.status)).slice(0, 60);
        return '<div class="col"><h4>' + label + ' · ' + list.length + '</h4>' + list.map((t) => {
          const f = botById(t.from); const to = botById(t.to);
          return '<div class="tcard"><b>#' + t.id + ' ' + esc(t.title) + '</b><div class="who">' + esc(f ? f.name : '?') + ' → ' + esc(to ? to.name : '?') + ' · ' + esc(fmtTime(t.updatedAt)) + ' <span class="pill ' + esc(t.status) + '">' + esc(t.status) + '</span></div>' +
            (t.note ? '<div class="who">Note: ' + esc(t.note) + '</div>' : '') +
            '<details><summary>Details</summary><div class="md">' + md(t.instructions) + '</div>' + (t.result ? '<hr><div class="md">' + md(t.result) + '</div>' : '') + '</details>' +
            (['queued', 'working', 'held'].includes(t.status) ? '<button class="btn sm" style="margin-top:6px" data-v="cancel-task" data-id="' + t.id + '">Cancel</button>' : '') + '</div>';
        }).join('') + '</div>';
      }).join('') + '</div>';
    } else if (v === 'routines') {
      el.innerHTML = '<div class="view-bar"><p class="lead" style="margin:0;flex:1">Saved instructions bots run on a schedule or when a webhook is called, even while you\'re away. Times are this computer\'s local time.</p><button class="btn primary" data-v="new-routine">＋ New routine</button></div>' +
        (S.routines.length ? '<table class="table"><tr><th>Routine</th><th>Bot</th><th>When</th><th>Next / last run</th><th></th></tr>' + S.routines.map((r) => {
          const b = botById(r.botId);
          const last = r.runs && r.runs[0];
          return '<tr><td><b>' + esc(r.title) + '</b><br><small style="color:var(--muted)">' + esc((r.instructions || '').slice(0, 140)) + '</small>' +
            (r.webhook ? '<br><small>Webhook: <code style="font:11px var(--mono)">POST ' + esc(r.webhook) + '</code></small>' : '') +
            (r.schedule.type === 'folder' ? '<br><small style="font:11px var(--mono)">' + esc(r.schedule.path) + '</small>' + (r.watchError ? '<br><small style="color:var(--bad)">Can\'t watch: ' + esc(r.watchError) + '</small>' : '') : '') + '</td>' +
            '<td>' + esc(b ? b.name : '?') + '</td><td>' + esc(r.scheduleText) + '<br><span class="pill ' + (r.pendingApproval ? 'waiting' : r.enabled ? 'on' : 'paused') + '">' + (r.pendingApproval ? 'awaiting approval' : r.enabled ? 'on' : 'paused') + '</span></td>' +
            '<td>' + (r.nextRunAt ? 'Next ' + esc(fmtTime(r.nextRunAt)) : '—') + (last ? '<br><small style="color:var(--muted)">Last ' + esc(fmtTime(last.ts)) + ' · ' + esc(last.status) + '</small>' : '') +
            (r.runs && r.runs.length ? '<details><summary><small>History</small></summary>' + r.runs.map((x) => '<div><small>' + esc(fmtTime(x.ts)) + ' · ' + esc(x.status) + ' — ' + esc(x.summary) + '</small></div>').join('') + '</details>' : '') + '</td>' +
            '<td style="white-space:nowrap"><button class="btn sm" data-v="run-routine" data-id="' + r.id + '">Run now</button> <button class="btn sm" data-v="toggle-routine" data-id="' + r.id + '">' + (r.enabled ? 'Pause' : 'Resume') + '</button> ' +
            '<button class="btn sm" data-v="edit-routine" data-id="' + r.id + '">Edit</button> <button class="btn sm danger" data-v="del-routine" data-id="' + r.id + '">Delete</button></td></tr>';
        }).join('') + '</table>' : '<div class="empty"><h3>No routines yet</h3><p>Try telling a bot: "Every weekday at 8:30, check my client inboxes folder and summarize anything new."</p></div>');
    } else if (v === 'skills') {
      el.innerHTML = '<div class="view-bar"><p class="lead" style="margin:0;flex:1">Reusable step-by-step procedures. Every bot can read and follow them, and bots save new ones as they work things out.</p><button class="btn primary" data-v="new-skill">＋ New skill</button></div>' +
        (S.skills.length ? '<div class="grid">' + S.skills.map((s) => '<div class="tile" data-v="edit-skill" data-id="' + esc(s.slug) + '"><b>✦ ' + esc(s.name) + '</b><small>' + esc(s.description) + '</small></div>').join('') + '</div>' : '<div class="empty"><h3>No skills yet</h3><p>Write one here, or tell a bot "save that as a skill" after it finishes a process you want repeated.</p></div>');
    } else if (v === 'memory') {
      el.innerHTML = '<p class="lead">Shared memory: facts every bot sees, like your name, time zone, clients and preferences. Each bot also keeps its own memory (in its Details pane).</p>' +
        '<textarea class="mem" id="shared-mem" style="min-height:50vh"></textarea><div style="margin-top:10px"><button class="btn primary" data-v="save-shared">Save</button></div>';
      api('GET', '/api/memory').then((r) => { $('#shared-mem').value = r.text; }).catch(() => {});
    } else if (v === 'inbox') {
      el.innerHTML = '<p class="lead">Everything waiting on you, across all bots and chats: approvals, questions, proposed routines and call-ins.</p><div id="inbox"><div class="empty">Loading…</div></div>';
      api('GET', '/api/pending').then((r) => {
        V.inbox = r.items;
        const box = $('#inbox');
        if (!box) return;
        box.innerHTML = r.items.length ? r.items.map(({ ch, msg }) => {
          const where = ch.startsWith('dm:') ? (botById(ch.slice(3)) || {}).name : '# ' + ((roomById(ch.slice(5)) || {}).name || '');
          const b = botById(msg.botId);
          return '<div class="msg" data-id="' + esc(msg.id) + '" data-ch="' + esc(ch) + '">' + botAv(b) + '<div><div class="meta"><b>' + esc(b ? b.name : 'Bot') + '</b><time>' + esc(fmtTime(msg.ts)) + '</time>' +
            '<a href="#' + esc(ch.replace(':', '/')) + '" style="font-size:12px">in ' + esc(where || 'chat') + ' →</a></div>' + cardHTML(msg) + '</div></div>';
        }).join('') : '<div class="empty"><h3>All clear</h3><p>Nothing is waiting on you.</p></div>';
      }).catch((e) => toast(e.message, true));
    } else if (v === 'search') {
      el.innerHTML = '<div class="view-bar"><input id="search-q" type="search" placeholder="Search every chat…" value="' + esc(V.searchQ) + '" style="flex:1;border:1px solid var(--line-strong);border-radius:8px;padding:8px 11px;background:var(--bg)"></div><div id="search-results"></div>';
      const q = $('#search-q');
      const runSearch = async () => {
        V.searchQ = q.value.trim();
        const box = $('#search-results');
        if (V.searchQ.length < 2) { box.innerHTML = '<p class="lead">Type at least two characters.</p>'; return; }
        const r = await attempt(() => api('GET', '/api/search?q=' + encodeURIComponent(V.searchQ)));
        if (!r || !$('#search-results')) return;
        V.results = r.results;
        box.innerHTML = r.results.length ? r.results.map((h, i) => {
          const where = h.ch.startsWith('dm:') ? (botById(h.ch.slice(3)) || {}).name : '# ' + ((roomById(h.ch.slice(5)) || {}).name || '');
          const who = h.role === 'user' ? S.config.userName : (botById(h.botId) || {}).name || h.role;
          return '<div class="list-item" style="cursor:pointer" data-v="hit" data-id="' + i + '"><div class="grow"><b>' + esc(where || 'chat') + '</b> <small style="display:inline">' + esc(who) + ' · ' + esc(fmtTime(h.ts)) + '</small><div>' + esc(h.snippet) + '</div></div></div>';
        }).join('') : '<p class="lead">No matches.</p>';
      };
      let t = null;
      q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(runSearch, 250); });
      q.focus();
      if (V.searchQ) runSearch();
    } else if (v === 'hidden') {
      const hidden = S.bots.filter((b) => b.hidden);
      el.innerHTML = '<p class="lead">Hidden bots keep working; they\'re just out of the sidebar.</p>' + (hidden.length ? hidden.map((b) => '<div class="list-item">' + botAv(b) + '<div class="grow"><b>' + esc(b.name) + '</b><small>' + esc(b.title) + '</small></div><button class="btn sm" data-v="open-bot" data-id="' + b.id + '">Open</button><button class="btn sm" data-v="unhide" data-id="' + b.id + '">Show in sidebar</button></div>').join('') : '<div class="empty">No hidden bots.</div>');
    }
  }

  $('#main').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-v]');
    if (!a || e.target.closest('[data-stop]')) return;
    const v = a.dataset.v;
    const id = a.dataset.id;
    if (v === 'page') openPage(id);
    else if (v === 'del-page') { e.stopPropagation(); if (await confirmBox('Delete this page?', 'It is removed from your Library.', 'Delete')) attempt(() => api('DELETE', '/api/pages/' + id)); }
    else if (v === 'cancel-task') attempt(() => api('POST', '/api/tasks/' + id + '/cancel'));
    else if (v === 'new-routine') routineModal(null, (primary() || {}).id);
    else if (v === 'edit-routine') routineModal(S.routines.find((r) => r.id === id));
    else if (v === 'run-routine') { const ok = await attempt(() => api('POST', '/api/routines/' + id + '/run')); if (ok) toast('Routine queued'); }
    else if (v === 'toggle-routine') { const r = S.routines.find((x) => x.id === id); attempt(() => api('PATCH', '/api/routines/' + id, { enabled: !r.enabled })); }
    else if (v === 'del-routine') { if (await confirmBox('Delete this routine?', 'It stops running. Its past messages stay in the bot\'s chat.', 'Delete')) attempt(() => api('DELETE', '/api/routines/' + id)); }
    else if (v === 'new-skill') skillModal(null);
    else if (v === 'edit-skill') skillModal(id);
    else if (v === 'save-shared') { const ok = await attempt(() => api('PUT', '/api/memory', { text: $('#shared-mem').value })); if (ok) toast('Shared memory saved'); }
    else if (v === 'open-bot') go('dm:' + id);
    else if (v === 'hit') {
      const h = V.results[+id];
      if (!h) return;
      V.flash = h.id;
      go(h.ch);
    }
    else if (v === 'unhide') attempt(() => api('PATCH', '/api/bots/' + id, { hidden: false }));
  });

  // ---------------- modals ----------------
  function modal(html, { wide } = {}) {
    closeModal();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div>';
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
    const first = ov.querySelector('input:not([type=hidden]):not([type=checkbox]),textarea,select');
    if (first) setTimeout(() => first.focus(), 30);
    return ov.firstChild;
  }
  function closeModal() { $$('.overlay').forEach((o) => o.remove()); }

  function confirmBox(title, text, okLabel = 'OK', danger = true) {
    return new Promise((resolve) => {
      const m = modal('<div class="modal-head"><h3>' + esc(title) + '</h3></div><div class="modal-body"><p style="margin:0">' + esc(text) + '</p></div>' +
        '<div class="modal-foot"><button class="btn" data-m="no">Cancel</button><button class="btn ' + (danger ? 'danger solid' : 'primary') + '" data-m="yes">' + esc(okLabel) + '</button></div>');
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (!b) return; closeModal(); resolve(b.dataset.m === 'yes'); });
      const ov = m.parentElement;
      const obs = new MutationObserver(() => { if (!ov.isConnected) { obs.disconnect(); resolve(false); } });
      obs.observe(document.body, { childList: true });
    });
  }

  function field(label, input, hint) { return '<label class="field"><span>' + esc(label) + '</span>' + input + (hint ? '<small>' + hint + '</small>' : '') + '</label>'; }
  function opts(list, val) { return list.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + esc(l) + '</option>').join(''); }

  function botModal(b) {
    const isNew = !b;
    b = b || { name: '', title: '', description: '', avatar: '🤖', color: COLORS[S.bots.length % COLORS.length], section: '', instructions: '', model: '', effort: '', cwd: '', permission: '', alwaysAllow: [], useMyClaudeSettings: false, mcpServers: {}, notify: true, hidden: false, primary: false };
    const sections = sectionOrder();
    const permList = [['', 'Default (' + (PERMS[S.config.defaultPermission] || PERMS.ask)[0] + ')']].concat(Object.entries(PERMS).map(([k, v]) => [k, v[0]]));
    const html = '<div class="modal-head"><h3>' + (isNew ? 'New bot' : 'Bot settings — ' + esc(b.name)) + '</h3><button class="icon-btn" data-m="x">✕</button></div>' +
      '<div class="tabs"><button class="tab active" data-tab="profile">Profile</button><button class="tab" data-tab="brain">Instructions & model</button><button class="tab" data-tab="access">Folder & permissions</button></div>' +
      '<div class="modal-body">' +
      '<div data-pane="profile">' +
        (isNew ? '<div class="field"><span>Start from</span><div class="opts" style="display:flex;gap:6px;flex-wrap:wrap">' + TEMPLATES.map((t) => '<button class="btn sm" data-tpl="' + t.key + '">' + esc(t.avatar + ' ' + t.label) + '</button>').join('') + '</div></div>' : '') +
        '<div class="cols3">' + field('Avatar', '<input type="text" name="avatar" maxlength="8" value="' + esc(b.avatar) + '" style="text-align:center;font-size:18px">', 'Emoji or 1–2 letters') +
        field('Name', '<input type="text" name="name" maxlength="60" value="' + esc(b.name) + '" placeholder="e.g. Client Accounts">') +
        field('Title', '<input type="text" name="title" maxlength="80" value="' + esc(b.title) + '" placeholder="e.g. Account manager">') + '</div>' +
        field('Color', '<div class="swatches">' + COLORS.map((c) => '<span class="swatch' + (c === b.color ? ' sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></span>').join('') + '</div><input type="hidden" name="color" value="' + esc(b.color) + '">') +
        field('What it does', '<textarea name="description" rows="2" maxlength="1000" placeholder="One or two sentences. Teammates read this to decide what to hand it.">' + esc(b.description) + '</textarea>') +
        field('Sidebar section', '<input type="text" name="section" list="sec-list" maxlength="40" value="' + esc(b.section) + '" placeholder="None"><datalist id="sec-list">' + sections.map((s) => '<option value="' + esc(s) + '">').join('') + '</datalist>') +
        '<label class="field inline"><input type="checkbox" name="primary"' + (b.primary ? ' checked' : '') + '><span>Primary bot — takes any request and routes it to specialists</span></label>' +
        '<label class="field inline"><input type="checkbox" name="notify"' + (b.notify ? ' checked' : '') + '><span>Desktop notifications for its replies</span></label>' +
        '<label class="field inline"><input type="checkbox" name="hidden"' + (b.hidden ? ' checked' : '') + '><span>Hide from sidebar (still reachable from search)</span></label>' +
      '</div>' +
      '<div data-pane="brain" class="hidden">' +
        field('Instructions', '<textarea name="instructions" rows="10" placeholder="Its job, how it should work, what it must never do, what good output looks like.">' + esc(b.instructions) + '</textarea>', 'Changes reach the bot on its next turn.') +
        '<div class="cols">' + field('Model', '<select name="model">' + opts(MODELS.map(([v, l]) => [v, v ? l : 'Default (' + S.config.defaultModel + ')']).concat(b.model && !MODELS.some((m) => m[0] === b.model) ? [[b.model, b.model]] : []), b.model) + '</select>', 'Or type a full model id under Folder & permissions → Advanced.') +
        field('Effort', '<select name="effort">' + opts([['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']], b.effort) + '</select>') + '</div>' +
        field('Daily budget (USD, API-equivalent)', '<input type="number" name="dailyBudgetUsd" min="0" step="0.5" value="' + esc(b.dailyBudgetUsd || '') + '" placeholder="No limit">', 'When reached, the bot\'s work waits until tomorrow. Subscription users: this tracks the API-equivalent cost Claude Code reports.') +
      '</div>' +
      '<div data-pane="access" class="hidden">' +
        field('Working folder', '<input type="text" name="cwd" value="' + esc(b.cwd) + '" placeholder="Leave empty for its own workspace folder" style="font-family:var(--mono)">', 'The folder it works in, e.g. a client\'s folder. Changing it starts a new session.') +
        field('Permissions', '<select name="permission">' + opts(permList, b.permission) + '</select>', '<span id="perm-desc"></span>') +
        field('Always allowed', '<textarea name="alwaysAllow" rows="3" style="font-family:var(--mono);font-size:12px" placeholder="One rule per line, e.g. Bash(git status) or Edit">' + esc((b.alwaysAllow || []).join('\n')) + '</textarea>', 'Claude Code permission rules. "Always allow" on an approval card adds one here.') +
        '<details><summary style="cursor:pointer;color:var(--muted)">Advanced</summary><div style="margin-top:10px">' +
        field('Custom model id', '<input type="text" name="modelCustom" value="' + esc(MODELS.some((m) => m[0] === b.model) ? '' : b.model) + '" placeholder="Overrides the model picker, e.g. claude-opus-5-5" style="font-family:var(--mono)">') +
        '<label class="field inline"><input type="checkbox" name="trustFolderSettings"' + (b.trustFolderSettings ? ' checked' : '') + '><span>Trust this folder\'s Claude Code settings</span></label>' +
        '<small style="display:block;color:var(--muted);margin:-8px 0 12px">Off (recommended): permission rules saved inside the working folder (.claude/settings*.json) are ignored, so a folder can\'t pre-approve commands. Turn on only for folders you control. Either way, bots\' file tools can never change Claude Code settings files (shell commands still need your approval, unless the bot has Full access); with this on, they may edit a project\'s .claude commands, agents and skills, with your approval.</small>' +
        '<label class="field inline"><input type="checkbox" name="useMyClaudeSettings"' + (b.useMyClaudeSettings ? ' checked' : '') + '><span>Use my Claude Code settings and connectors</span></label>' +
        '<small style="display:block;color:var(--muted);margin:-8px 0 12px">Off (recommended): the bot gets only Posse tools plus the servers below, and your personal allow-rules don\'t apply to it. On: it also loads all your settings and every MCP connector you have set up.</small>' +
        field('Extra MCP servers (JSON)', '<textarea name="mcpServers" rows="5" style="font-family:var(--mono);font-size:12px" placeholder=\'{"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}\'>' + esc(Object.keys(b.mcpServers || {}).length ? JSON.stringify(b.mcpServers, null, 2) : '') + '</textarea>', 'Connectors for this bot only, in Claude Code\'s mcpServers format.') +
        '</div></details>' +
      '</div>' +
      '</div><div class="modal-foot">' + (isNew ? '' : '<button class="btn danger" data-m="delete">Delete bot…</button>') + '<span class="grow"></span><button class="btn" data-m="x">Cancel</button><button class="btn primary" data-m="save">' + (isNew ? 'Create bot' : 'Save') + '</button></div>';
    const m = modal(html, { wide: true });
    const permDesc = () => { const v = m.querySelector('[name=permission]').value || S.config.defaultPermission; $('#perm-desc').textContent = (PERMS[v] || PERMS.ask)[1]; };
    // Connector settings aren't on the live stream, so load the current ones for this bot.
    let mcpOriginal = m.querySelector('[name=mcpServers]').value;
    if (!isNew) {
      api('GET', '/api/state').then((st) => {
        const fresh = st.bots.find((x) => x.id === b.id);
        const box = m.querySelector('[name=mcpServers]');
        if (!fresh || !box || box.value !== mcpOriginal) return; // don't overwrite the user's typing
        mcpOriginal = box.value = Object.keys(fresh.mcpServers || {}).length ? JSON.stringify(fresh.mcpServers, null, 2) : '';
      }).catch(() => {});
    }
    permDesc();
    m.querySelector('[name=permission]').addEventListener('change', permDesc);
    m.addEventListener('click', async (e) => {
      const tp = e.target.closest('[data-tpl]');
      if (tp) {
        const t = TEMPLATES.find((x) => x.key === tp.dataset.tpl);
        const set = (n, v) => { const el = m.querySelector('[name=' + n + ']'); if (el) el.value = v; };
        set('avatar', t.avatar); set('name', t.name); set('title', t.title); set('description', t.description); set('instructions', t.instructions); set('permission', t.permission);
        permDesc();
        $$('[data-tpl]', m).forEach((x) => x.classList.toggle('primary', x === tp));
        return;
      }
      const t = e.target.closest('[data-tab]');
      if (t) { $$('.tab', m).forEach((x) => x.classList.toggle('active', x === t)); $$('[data-pane]', m).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab)); return; }
      const sw = e.target.closest('[data-color]');
      if (sw) { $$('.swatch', m).forEach((x) => x.classList.toggle('sel', x === sw)); m.querySelector('[name=color]').value = sw.dataset.color; return; }
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') closeModal();
      else if (a.dataset.m === 'delete') { closeModal(); deleteBot(b); }
      else if (a.dataset.m === 'save') {
        const f = (n) => m.querySelector('[name=' + n + ']');
        const body = {
          avatar: f('avatar').value.trim() || '🤖', name: f('name').value.trim(), title: f('title').value.trim(), color: f('color').value,
          description: f('description').value.trim(), section: f('section').value.trim(), primary: f('primary').checked, notify: f('notify').checked, hidden: f('hidden').checked,
          instructions: f('instructions').value, model: f('modelCustom').value.trim() || f('model').value, effort: f('effort').value, dailyBudgetUsd: f('dailyBudgetUsd').value,
          cwd: f('cwd').value.trim(), permission: f('permission').value, alwaysAllow: f('alwaysAllow').value, useMyClaudeSettings: f('useMyClaudeSettings').checked, trustFolderSettings: f('trustFolderSettings').checked,
        };
        if (!body.name) { toast('Give the bot a name', true); return; }
        // Connector settings are sent only when the box was actually changed (it may be loaded late).
        if (f('mcpServers').value !== mcpOriginal) body.mcpServers = f('mcpServers').value;
        if (body.permission === 'full' && b.permission !== 'full' && !(await confirmBox('Give ' + body.name + ' full access?', 'It will run any command and edit any file it can reach without asking you. Only do this for a bot working in a folder you can afford to lose.', 'Give full access'))) return;
        const r = await attempt(() => (isNew ? api('POST', '/api/bots', body) : api('PATCH', '/api/bots/' + b.id, body)));
        if (r) {
          closeModal();
          if (body.section && !(S.config.sections || []).includes(body.section)) api('PATCH', '/api/config', { sections: [...(S.config.sections || []), body.section] }).catch(() => {});
          upsert(S.bots, r.bot); // the response includes connector settings; the live stream doesn't
          if (isNew) go('dm:' + r.bot.id);
        }
      }
    });
  }

  function sectionModal(b) {
    const sections = sectionOrder();
    const m = modal('<div class="modal-head"><h3>Move ' + esc(b.name) + '</h3></div><div class="modal-body">' +
      field('Section', '<input type="text" name="section" list="sec-list2" value="' + esc(b.section) + '" placeholder="None (top of the sidebar)"><datalist id="sec-list2">' + sections.map((s) => '<option value="' + esc(s) + '">').join('') + '</datalist>', 'Pick an existing section or type a new one.') +
      '</div><div class="modal-foot"><button class="btn" data-m="x">Cancel</button><button class="btn primary" data-m="ok">Move</button></div>');
    m.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') return closeModal();
      const section = m.querySelector('[name=section]').value.trim();
      if (await attempt(() => api('PATCH', '/api/bots/' + b.id, { section }))) {
        closeModal();
        if (section && !(S.config.sections || []).includes(section)) api('PATCH', '/api/config', { sections: [...(S.config.sections || []), section] }).catch(() => {});
      }
    });
  }

  function roomModal(r) {
    const isNew = !r;
    r = r || { name: '', members: [] };
    const m = modal('<div class="modal-head"><h3>' + (isNew ? 'New group chat' : 'Edit group chat') + '</h3><button class="icon-btn" data-m="x">✕</button></div><div class="modal-body">' +
      field('Name', '<input type="text" name="name" maxlength="60" value="' + esc(r.name) + '" placeholder="e.g. Month-end close">') +
      field('Bots in this chat', '<div>' + S.bots.map((b) => '<label class="field inline" style="margin:4px 0"><input type="checkbox" value="' + b.id + '"' + (r.members.includes(b.id) ? ' checked' : '') + '>' + botAv(b) + '<span style="font-weight:400">' + esc(b.name) + '</span></label>').join('') + '</div>', 'The first one checked answers when nobody is @mentioned.') +
      '</div><div class="modal-foot"><span class="grow"></span><button class="btn" data-m="x">Cancel</button><button class="btn primary" data-m="ok">' + (isNew ? 'Create' : 'Save') + '</button></div>');
    m.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') return closeModal();
      const body = { name: m.querySelector('[name=name]').value.trim() || 'Group chat', members: $$('input[type=checkbox]:checked', m).map((x) => x.value) };
      if (!body.members.length) { toast('Pick at least one bot', true); return; }
      const res = await attempt(() => (isNew ? api('POST', '/api/rooms', body) : api('PATCH', '/api/rooms/' + r.id, body)));
      if (res) { closeModal(); if (isNew) { upsert(S.rooms, res.room); go('room:' + res.room.id); } }
    });
  }

  function routineModal(r, botId) {
    const isNew = !r;
    r = r || { botId: botId || (primary() || {}).id, title: '', instructions: '', schedule: { type: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, notify: 'smart' };
    const s = r.schedule;
    const soon = new Date(Date.now() + 3600e3);
    const p2 = (n) => String(n).padStart(2, '0');
    const at = s.at || soon.getFullYear() + '-' + p2(soon.getMonth() + 1) + '-' + p2(soon.getDate()) + 'T' + p2(soon.getHours()) + ':' + p2(soon.getMinutes());
    const m = modal('<div class="modal-head"><h3>' + (isNew ? 'New routine' : 'Edit routine') + '</h3><button class="icon-btn" data-m="x">✕</button></div><div class="modal-body">' +
      (isNew ? '<div class="field"><span>Start from</span><div style="display:flex;gap:6px;flex-wrap:wrap">' + ROUTINE_TEMPLATES.map((t) => '<button class="btn sm" data-rtpl="' + t.key + '">' + esc(t.label) + '</button>').join('') + '</div></div>' : '') +
      '<div class="cols">' + field('Bot', '<select name="botId">' + opts(S.bots.map((b) => [b.id, b.name]), r.botId) + '</select>') + field('Name', '<input type="text" name="title" maxlength="80" value="' + esc(r.title) + '" placeholder="e.g. Morning client check">') + '</div>' +
      field('Instructions', '<textarea name="instructions" rows="5" placeholder="What the bot should do each time it runs.">' + esc(r.instructions) + '</textarea>') +
      '<div class="cols">' + field('When', '<select name="type">' + opts([['daily', 'Daily at a time'], ['interval', 'Every N minutes'], ['once', 'Once'], ['folder', 'When files change in a folder'], ['webhook', 'When a webhook is called']], s.type) + '</select>') +
      field('Messages', '<select name="notify">' + opts([['smart', 'Only when worth seeing'], ['always', 'Every run']], r.notify) + '</select>') + '</div>' +
      '<div data-s="daily"><div class="cols">' + field('Time', '<input type="time" name="time" value="' + esc(s.time || '08:30') + '">') +
      field('Days', '<div class="days">' + DAYN.map((d, i) => '<label><input type="checkbox" value="' + i + '"' + ((s.days || [1, 2, 3, 4, 5]).includes(i) ? ' checked' : '') + '>' + d + '</label>').join('') + '</div>') + '</div></div>' +
      '<div data-s="interval">' + field('Every (minutes)', '<input type="number" name="minutes" min="15" value="' + esc(s.minutes || 60) + '">', 'At least 15.') + '</div>' +
      '<div data-s="once">' + field('Date and time', '<input type="datetime-local" name="at" value="' + esc(at) + '">') + '</div>' +
      '<div data-s="folder">' + field('Folder', '<input type="text" name="path" value="' + esc(s.path || '') + '" placeholder="e.g. C:\\Clients\\Acme\\Inbox" style="font-family:var(--mono)">', 'Runs about 20 seconds after files stop changing, with the list of changed files. At most every 2 minutes, 40 times a day. Changes the bot makes itself during the run are ignored.') + '</div>' +
      '<div data-s="webhook"><div class="note">After saving, the Routines page shows this routine\'s webhook URL. Anything POSTed to it is handed to the bot as the event payload. It only listens on this computer unless you start Posse with --host.</div></div>' +
      '</div><div class="modal-foot"><span class="grow"></span><button class="btn" data-m="x">Cancel</button><button class="btn primary" data-m="ok">' + (isNew ? 'Create' : 'Save') + '</button></div>');
    const sync = () => { const t = m.querySelector('[name=type]').value; $$('[data-s]', m).forEach((d) => d.classList.toggle('hidden', d.dataset.s !== t)); };
    sync();
    m.querySelector('[name=type]').addEventListener('change', sync);
    m.addEventListener('click', async (e) => {
      const tp = e.target.closest('[data-rtpl]');
      if (tp) {
        const t = ROUTINE_TEMPLATES.find((x) => x.key === tp.dataset.rtpl);
        const set = (n, v) => { const el = m.querySelector('[name=' + n + ']'); if (el && v !== undefined) el.value = v; };
        set('title', t.title); set('instructions', t.instructions); set('notify', t.notify); set('type', t.schedule.type);
        if (t.schedule.time) set('time', t.schedule.time);
        if (t.schedule.days) $$('.days input', m).forEach((x) => { x.checked = t.schedule.days.includes(+x.value); });
        sync();
        $$('[data-rtpl]', m).forEach((x) => x.classList.toggle('primary', x === tp));
        return;
      }
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') return closeModal();
      const g = (n) => m.querySelector('[name=' + n + ']').value;
      const type = g('type');
      const schedule = { type };
      if (type === 'daily') { schedule.time = g('time'); schedule.days = $$('.days input:checked', m).map((x) => +x.value); }
      if (type === 'interval') schedule.minutes = +g('minutes');
      if (type === 'once') schedule.at = g('at');
      if (type === 'folder') schedule.path = g('path').trim();
      const body = { botId: g('botId'), title: g('title').trim() || 'Routine', instructions: g('instructions'), notify: g('notify'), schedule };
      const res = await attempt(() => (isNew ? api('POST', '/api/routines', body) : api('PATCH', '/api/routines/' + r.id, body)));
      if (res) closeModal();
    });
  }

  async function skillModal(slug) {
    let s = { name: '', description: '', body: '' };
    if (slug) { const r = await attempt(() => api('GET', '/api/skills/' + encodeURIComponent(slug))); if (!r) return; s = r; }
    const m = modal('<div class="modal-head"><h3>' + (slug ? 'Edit skill' : 'New skill') + '</h3><button class="icon-btn" data-m="x">✕</button></div><div class="modal-body">' +
      field('Name', '<input type="text" name="name" maxlength="80" value="' + esc(s.name) + '" placeholder="e.g. Monthly account review">') +
      field('When to use it', '<input type="text" name="description" maxlength="200" value="' + esc(s.description) + '" placeholder="One line">') +
      field('Procedure (Markdown)', '<textarea name="body" rows="14" style="font-family:var(--mono);font-size:12.5px">' + esc(s.body) + '</textarea>') +
      '</div><div class="modal-foot">' + (slug ? '<button class="btn danger" data-m="del">Delete</button>' : '') + '<span class="grow"></span><button class="btn" data-m="x">Cancel</button><button class="btn primary" data-m="ok">Save</button></div>', { wide: true });
    m.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') return closeModal();
      if (a.dataset.m === 'del') { closeModal(); if (await confirmBox('Delete skill "' + s.name + '"?', 'Bots can no longer read it.', 'Delete')) attempt(() => api('DELETE', '/api/skills/' + encodeURIComponent(slug))); return; }
      const g = (n) => m.querySelector('[name=' + n + ']').value;
      if (await attempt(() => api('POST', '/api/skills', { name: g('name'), description: g('description'), body: g('body'), prevSlug: slug || undefined }))) closeModal();
    });
  }

  function settingsModal(tab = 'general') {
    const c = S.config;
    const lim = (name, label, hint, min, max) => field(label, '<input type="number" name="' + name + '" min="' + min + '" max="' + max + '" value="' + esc(c[name]) + '">', hint);
    const m = modal('<div class="modal-head"><h3>Settings</h3><button class="icon-btn" data-m="x">✕</button></div>' +
      '<div class="tabs"><button class="tab" data-tab="general">General</button><button class="tab" data-tab="bots">Bots & Claude</button><button class="tab" data-tab="limits">Limits</button><button class="tab" data-tab="security">Security</button><button class="tab" data-tab="about">About</button></div><div class="modal-body">' +
      '<div data-pane="general">' + field('Your name', '<input type="text" name="userName" maxlength="60" value="' + esc(c.userName) + '">', 'Bots call you this.') +
        '<div class="cols">' + field('Theme', '<select name="theme">' + opts([['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], c.theme) + '</select>') +
        field('Accent color', '<div class="swatches">' + COLORS.map((x) => '<span class="swatch' + (x === c.accent ? ' sel' : '') + '" data-color="' + x + '" style="background:' + x + '"></span>').join('') + '</div><input type="hidden" name="accent" value="' + esc(c.accent) + '">') + '</div>' +
        field('Notifications', '<button class="btn sm" data-m="notify">' + (typeof Notification === 'undefined' ? 'Not supported in this browser' : Notification.permission === 'granted' ? 'Enabled ✓' : 'Enable desktop notifications') + '</button>') +
      '</div>' +
      '<div data-pane="bots" class="hidden">' +
        '<div class="note ' + (S.cli.found ? '' : 'warn') + '">' + (S.cli.found ? 'Claude Code ' + esc(S.cli.version) + '<br><span style="font:12px var(--mono)">' + esc(S.cli.path) + '</span>' : esc(S.cli.error || 'Claude Code not found')) + '</div>' +
        field('Claude Code path', '<input type="text" name="claudePath" value="' + esc(c.claudePath) + '" placeholder="Auto-detect" style="font-family:var(--mono)">', 'Leave empty to find it automatically. Bots use your Claude Code login.') +
        '<div class="cols">' + field('Default model', '<input type="text" name="defaultModel" value="' + esc(c.defaultModel) + '" list="model-list"><datalist id="model-list"><option value="opus"><option value="sonnet"><option value="haiku"><option value="fable"></datalist>', 'An alias (opus, sonnet, haiku, fable) or a full model id.') +
        field('Default permissions', '<select name="defaultPermission">' + opts(Object.entries(PERMS).map(([k, v]) => [k, v[0]]), c.defaultPermission) + '</select>') + '</div>' +
        '<label class="field inline"><input type="checkbox" name="lowPriority"' + (c.lowPriority !== false ? ' checked' : '') + '><span>Run bots at low priority (keeps the computer responsive while they work)</span></label>' +
        field('Tool connection', '<select name="mcpTransport">' + opts([['http', 'Built in (lighter, recommended)'], ['stdio', 'Separate helper process (compatibility)']], c.mcpTransport) + '</select>', 'How bots reach Posse\'s tools. Switch only if an older Claude Code can\'t connect.') +
      '</div>' +
      '<div data-pane="limits" class="hidden"><div class="note">Bots that talk to bots can loop. These limits keep usage in check. A bot that fails 3 turns in a row is paused.</div><div class="cols">' +
        lim('maxConcurrent', 'Bots working at once', 'Each bot still runs one turn at a time.', 1, 8) +
        lim('maxTurnsPerDay', 'Turns per day (all bots)', 'Work waits in the queue once reached.', 1, 5000) +
        lim('maxTurnsPerBotHour', 'Turns per bot per hour', '', 1, 500) +
        lim('maxChainTurns', 'Turns per request chain', 'Total bot-to-bot turns one request can set off.', 2, 500) +
        lim('maxDepth', 'Hand-off limit', 'How many levels deep delegation and @mentions can go.', 1, 10) +
        lim('maxToolTurns', 'Max steps per turn', 'Tool calls in one turn before it stops.', 5, 500) +
        lim('turnTimeoutMin', 'Turn time limit (minutes)', '', 2, 240) +
        lim('approvalTimeoutMin', 'Approval cards stay open (minutes)', 'A bot waits up to 4½ minutes for a live answer, then moves on; the card stays answerable this long (default a day).', 5, 10080) +
        lim('sessionMaxTokens', 'Session size before refresh (tokens)', 'When a bot\'s context passes this, it saves notes to memory and starts a fresh session.', 50000, 1000000) +
      '</div></div>' +
      '<div data-pane="security" class="hidden">' +
        '<label class="field inline"><input type="checkbox" name="escalationGuard"' + (c.escalationGuard !== false ? ' checked' : '') + '><span>Ask me before a bot hands work to a bot with more permissions</span></label>' +
        '<small style="display:block;color:var(--muted);margin:-8px 0 14px">Stops a bot that was misled by something it read from getting a more powerful teammate to act for it.</small>' +
        '<div class="field"><span>Access key</span><div style="display:flex;gap:6px;flex-wrap:wrap"><input type="password" id="sec-key" readonly style="flex:1;min-width:160px;font-family:var(--mono);border:1px solid var(--line-strong);border-radius:8px;padding:7px 10px;background:var(--bg)">' +
        '<button class="btn sm" data-m="show-key">Show</button><button class="btn sm" data-m="copy-link">Copy sign-in link</button><button class="btn sm danger" data-m="rotate">New key</button><button class="btn sm" data-m="signout">Sign out</button></div>' +
        '<small>Anyone with this key (or the sign-in link) can use your bots. A new key signs out every other browser.</small></div>' +
        '<div class="field"><span>Recent security events</span><div id="sec-audit" style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;font-size:12.5px"><div style="padding:8px;color:var(--muted)">Loading…</div></div></div>' +
      '</div>' +
      '<div data-pane="about" class="hidden"><p><b>Posse</b> — a local team of persistent AI bots, powered by the Claude Code CLI. Open source, MIT license.</p>' +
        '<dl class="kv"><dt>Version</dt><dd>' + esc(S.version || '') + (S.build ? ' · ' + esc(S.build) : '') + '</dd><dt>Data folder</dt><dd style="font:12px var(--mono)">' + esc(S.dataDir) + '</dd><dt>Today</dt><dd>' + (S.usage.today.turns || 0) + ' turns · $' + (S.usage.today.costUsd || 0).toFixed(2) + ' API-equivalent</dd></dl>' +
        '<p><button class="btn sm" data-m="backup">⤓ Download backup (.tar.gz)</button></p>' +
        '<p style="color:var(--muted);font-size:12.5px">To update: in the Posse folder, double-click <b>update.cmd</b> (Windows) or <b>update.command</b> (macOS), or run <code>node update.js</code>. Your bots, chats and settings are kept.</p>' +
        '<p style="color:var(--muted);font-size:12.5px">Everything (chats, memory, pages, routines) is plain files in the data folder. Back it up like any folder. Keyboard: ⌘/Ctrl+K search · ⌘/Ctrl+Shift+I details · ⌘/Ctrl+, settings.</p></div>' +
      '</div><div class="modal-foot"><span class="grow"></span><button class="btn" data-m="x">Close</button><button class="btn primary" data-m="save">Save</button></div>', { wide: true });
    let sec = null;
    const loadSecurity = async () => {
      sec = await attempt(() => api('GET', '/api/security'));
      if (!sec || !$('#sec-key')) return;
      $('#sec-key').value = sec.accessKey;
      const label = { approval: 'Approval', escalation: 'Escalation', 'bot.changed': 'Bot changed', 'bot.created': 'Bot created', 'bot.deleted': 'Bot deleted', 'settings.changed': 'Settings', webhook: 'Webhook', 'webhook.limited': 'Webhook limited', 'auth.failed': 'Failed sign-in', 'access-key.rotated': 'New access key' };
      $('#sec-audit').innerHTML = sec.audit.length ? sec.audit.map((r) => '<div style="padding:6px 10px;border-bottom:1px solid var(--line)"><b>' + esc(label[r.type] || r.type) + '</b> <span style="color:var(--muted)">' + esc(fmtTime(r.ts)) + '</span><br>' +
        esc([r.bot, r.tool, r.decision, r.detail, r.note].filter(Boolean).join(' · ')) + '</div>').join('') : '<div style="padding:8px;color:var(--muted)">Nothing yet.</div>';
    };
    const showTab = (t) => { $$('.tab', m).forEach((x) => x.classList.toggle('active', x.dataset.tab === t)); $$('[data-pane]', m).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t)); if (t === 'security') loadSecurity(); };
    showTab(tab);
    m.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) return showTab(t.dataset.tab);
      const sw = e.target.closest('[data-color]');
      if (sw) { $$('.swatch', m).forEach((x) => x.classList.toggle('sel', x === sw)); m.querySelector('[name=accent]').value = sw.dataset.color; document.documentElement.style.setProperty('--accent', sw.dataset.color); return; }
      const a = e.target.closest('[data-m]');
      if (!a) return;
      if (a.dataset.m === 'x') { closeModal(); applyTheme(); }
      else if (a.dataset.m === 'show-key') { const k = $('#sec-key'); k.type = k.type === 'password' ? 'text' : 'password'; a.textContent = k.type === 'password' ? 'Show' : 'Hide'; }
      else if (a.dataset.m === 'copy-link' && sec) { try { await navigator.clipboard.writeText(sec.openUrl); toast('Sign-in link copied'); } catch { toast('Copy failed', true); } }
      else if (a.dataset.m === 'rotate') {
        if (!(await confirmBox('Make a new access key?', 'Every other browser using Posse is signed out and needs the new key. This browser stays signed in.', 'New key'))) return;
        const r = await attempt(() => api('POST', '/api/security/rotate-key'));
        if (r) {
          KEY = r.accessKey; VT = r.vt;
          try { localStorage.setItem(KEY_STORE, KEY); } catch {}
          await relink();
          toast('New access key made');
          settingsModal('security');
        }
      }
      else if (a.dataset.m === 'backup') downloadAuthed('/api/backup');
      else if (a.dataset.m === 'signout') { try { localStorage.removeItem(KEY_STORE); } catch {} closeModal(); signIn(''); }
      else if (a.dataset.m === 'notify') { if (typeof Notification !== 'undefined') { await Notification.requestPermission(); a.textContent = Notification.permission === 'granted' ? 'Enabled ✓' : 'Blocked in browser settings'; } }
      else if (a.dataset.m === 'save') {
        const body = {};
        $$('[name]', m).forEach((el) => { body[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
        const r = await attempt(() => api('PATCH', '/api/config', body));
        if (r) { closeModal(); toast('Settings saved'); await refreshState(); }
      }
    });
  }

  // ---------------- command palette ----------------
  function openPalette() {
    closeModal();
    const items = [];
    for (const b of S.bots) items.push({ label: b.name, sub: (b.hidden ? 'hidden · ' : '') + '@' + b.handle, icon: botAv(b), run: () => go('dm:' + b.id), q: b.name + ' ' + b.handle + ' ' + b.title });
    for (const r of S.rooms) items.push({ label: r.name, sub: 'group chat', icon: '<div class="av room-av">#</div>', run: () => go('room:' + r.id), q: r.name });
    for (const p of S.pages) items.push({ label: p.title, sub: 'page', icon: '<div class="av room-av">▤</div>', run: () => openPage(p.id), q: p.title });
    const acts = [
      ['New bot', () => botModal(null)], ['New group chat', () => roomModal(null)], ['New routine', () => routineModal(null)], ['New skill', () => skillModal(null)],
      ['Open settings', () => settingsModal()], ['Library', () => go('view:library')], ['Tasks', () => go('view:tasks')], ['Routines', () => go('view:routines')],
      ['Skills', () => go('view:skills')], ['Shared memory', () => go('view:memory')], ['Hidden bots', () => go('view:hidden')], ['Needs you', () => go('view:inbox')], ['Search all chats', () => go('view:search')],
      [S.config.paused ? 'Resume all bots' : 'Pause all bots', () => attempt(() => api('PATCH', '/api/config', { paused: !S.config.paused }))],
    ];
    for (const [label, run] of acts) items.push({ label, sub: 'action', icon: '<div class="av room-av">›</div>', run, q: label });
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="palette"><input placeholder="Jump to a bot, chat, page or action…"><div class="results"></div></div>';
    document.body.appendChild(ov);
    const input = $('input', ov);
    const res = $('.results', ov);
    let shown = [];
    let sel = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = items.filter((it) => !q || it.q.toLowerCase().includes(q)).slice(0, 30);
      if (q.length >= 2) shown.push({ label: 'Search all chats for "' + input.value.trim() + '"', sub: 'search', icon: '<div class="av room-av">⌕</div>', run: () => { V.searchQ = input.value.trim(); go('view:search'); }, q: '' });
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      res.innerHTML = shown.map((it, i) => '<div class="row' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' + it.icon + '<span class="name">' + esc(it.label) + '</span><small>' + esc(it.sub) + '</small></div>').join('') || '<div class="row" style="color:var(--muted)">No matches</div>';
    };
    const pick = (i) => { const it = shown[i]; ov.remove(); if (it) it.run(); };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
      else if (e.key === 'Escape') ov.remove();
    });
    res.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) pick(+r.dataset.i); });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
    draw();
    input.focus();
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); togglePane(); }
    else if (mod && e.key === ',') { e.preventDefault(); settingsModal(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !$('.overlay') && !e.target.closest('input, textarea, select, [contenteditable]')) {
      // Alt+↑/↓ moves through the chats in sidebar order.
      e.preventDefault();
      const order = $$('#side .side-scroll [data-ch]').map((r) => r.dataset.ch);
      const i = order.indexOf(V.ch);
      const next = order[(i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
      if (next) go(next);
    }
    else if (e.key === 'Escape') { if ($('.menu')) closeMenu(); else if ($('.overlay')) closeModal(); }
  });

  // ---------------- notifications ----------------
  let asked = false;
  function askNotify() {
    if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    asked = true;
    Notification.requestPermission().catch(() => {});
  }
  function notify(ch, msg) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden && ch === V.ch) return;
    const b = botById(msg.botId) || (ch.startsWith('dm:') ? botById(ch.slice(3)) : null);
    if (b && !b.notify) return;
    if (msg.meta && msg.meta.quiet) return;
    const room = ch.startsWith('room:') ? roomById(ch.slice(5)) : null;
    const title = (b ? b.name : 'Posse') + (room ? ' in ' + room.name : '');
    const body = msg.kind === 'card' ? ({ question: 'Has a question for you', approval: 'Needs your approval', draft: 'Drafted a message', page: 'Saved a page', routine: 'Proposed a routine' }[msg.card.type] || 'Sent a card') : (msg.text || '').slice(0, 180);
    try { const n = new Notification(title, { body, tag: ch }); n.onclick = () => { window.focus(); go(ch); n.close(); }; } catch {}
  }

  // ---------------- live updates ----------------
  function upsert(list, item, key = 'id') {
    const i = list.findIndex((x) => x[key] === item[key]);
    if (i >= 0) list[i] = item; else list.push(item);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'bot': {
        const prev = botById(ev.bot.id);
        if (prev && !('mcpServers' in ev.bot)) ev.bot.mcpServers = prev.mcpServers;
        upsert(S.bots, ev.bot);
        renderSide();
        if (V.ch === 'dm:' + ev.bot.id || (V.ch && V.ch.startsWith('room:'))) { renderHead(); renderLive(); }
        if (V.pane === 'info' && V.ch === 'dm:' + ev.bot.id) renderPane();
        if (prev && prev.name !== ev.bot.name && isChat(V.ch)) renderMessages(false);
        break;
      }
      case 'bot:removed':
        S.bots = S.bots.filter((b) => b.id !== ev.id);
        delete V.msgs['dm:' + ev.id];
        if (V.ch === 'dm:' + ev.id) go(primary() ? 'dm:' + primary().id : 'view:library', { replace: true }); else renderSide();
        break;
      case 'room': upsert(S.rooms, ev.room); renderSide(); if (V.ch === 'room:' + ev.room.id) { renderHead(); if (V.pane === 'info') renderPane(); } break;
      case 'rooms': S.rooms = ev.rooms; renderSide(); break;
      case 'room:removed':
        S.rooms = S.rooms.filter((r) => r.id !== ev.id);
        if (V.ch === 'room:' + ev.id) go('dm:' + (primary() || {}).id, { replace: true }); else renderSide();
        break;
      case 'message':
        if (V.msgs[ev.ch]) upsertMessage(ev.ch, ev.msg);
        if (ev.ch === V.ch && !document.hidden) api('POST', chUrl(ev.ch) + '/read').catch(() => {});
        if (['bot', 'incoming'].includes(ev.msg.role)) notify(ev.ch, ev.msg);
        break;
      case 'message:update': if (V.msgs[ev.ch] && V.msgs[ev.ch].some((m) => m.id === ev.msg.id)) upsertMessage(ev.ch, ev.msg); break;
      case 'task':
        upsert(S.tasks, ev.task);
        S.tasks.sort((a, b) => b.id - a.id);
        $$('[data-task="' + ev.task.id + '"]').forEach((el) => {
          const msgEl = el.closest('[data-id]');
          const m = msgEl && (V.msgs[V.ch] || []).find((x) => x.id === msgEl.dataset.id);
          if (m) el.outerHTML = cardHTML(m);
        });
        if (V.ch === 'view:tasks') renderView();
        if (V.pane === 'info') renderPane();
        break;
      case 'routines': {
        // The live stream never carries webhook secrets; keep the URLs we already have, fetch new ones.
        const old = new Map(S.routines.map((r) => [r.id, r]));
        if (ev.routines.some((r) => r.webhook === 'set' && !(old.get(r.id) || {}).webhook)) { refreshState().then(() => { if (V.ch === 'view:routines') renderView(); }); break; }
        S.routines = ev.routines.map((r) => (r.webhook === 'set' ? { ...r, webhook: old.get(r.id).webhook } : r));
        if (V.ch === 'view:routines') renderView(); if (V.pane === 'info') renderPane();
        break;
      }
      case 'page': upsert(S.pages, ev.page); S.pages.sort((a, b) => b.updatedAt - a.updatedAt); if (V.ch === 'view:library') renderView(); if (V.pane === 'page:' + ev.page.id) renderPane(); break;
      case 'page:removed': S.pages = S.pages.filter((p) => p.id !== ev.id); if (V.ch === 'view:library') renderView(); if (V.pane === 'page:' + ev.id) { V.pane = null; renderPane(); } break;
      case 'skills': S.skills = ev.skills; if (V.ch === 'view:skills') renderView(); break;
      case 'memory': if (V.pane === 'info' && V.dirtyMem !== ev.botId && V.ch === 'dm:' + ev.botId) renderPane(); break;
      case 'config': S.config = ev.config; if (ev.cli) S.cli = ev.cli; applyTheme(); renderSide(); if (isChat(V.ch)) { renderHead(); } { const bn = $('.banner'); const nb = banner(); if (bn) bn.outerHTML = nb || ''; else if (nb) $('#main').insertAdjacentHTML('afterbegin', nb); } break;
      case 'usage': S.usage.today = ev.today; renderSide(); break;
      case 'pending': S.pendingCount = ev.count; renderSide(); if (V.ch === 'view:inbox' && !inboxBusy()) renderView(); break;
      case 'activity': {
        const b = botById(ev.botId);
        if (b && b.status) { b.status.activity = ev.text; if (isChat(V.ch)) { renderHead(); renderLive(); } }
        break;
      }
    }
  }

  function connect() {
    if (V.sse) V.sse.close();
    const es = new EventSource(vt('/api/events'));
    V.sse = es;
    let dropped = false;
    es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    es.onerror = () => { dropped = true; };
    es.onopen = async () => { if (dropped) { dropped = false; V.msgs = {}; await refreshState(); renderMain(); } };
  }

  // Page and file links are signed for a day or two; when tokens roll over (or the key changes),
  // fetch everything again so links in this tab keep working.
  async function relink() {
    V.msgs = {};
    connect();
    await refreshState();
    V.linksStale = false;
    clearTimeout(V.relinkTimer);
    if (V.pane && V.pane.startsWith('page:')) { delete $('#pane').dataset.page; }
    renderMain();
    renderPane();
  }

  async function refreshState() {
    VT = (await api('GET', '/api/whoami')).vt;
    const st = await api('GET', '/api/state');
    Object.assign(S, st);
    applyTheme();
    renderSide();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && isChat(V.ch)) api('POST', chUrl(V.ch) + '/read').catch(() => {}); });

  // ---------------- boot ----------------
  (async function boot() {
    if (pendingLinkKey !== null) {
      if (await keyWorks(pendingLinkKey)) { KEY = pendingLinkKey; try { localStorage.setItem(KEY_STORE, KEY); } catch {} }
      else if (!KEY) return signIn('That sign-in link is not valid. The key may have been changed; check the Posse window.');
      else setTimeout(() => toast('That sign-in link is not valid; you are still signed in.', true), 500);
    }
    if (!KEY) return signIn('');
    try { await refreshState(); } catch (e) { if (KEY && e.message !== 'Sign in required') document.body.innerHTML = '<div class="empty"><h3>Can\'t reach Posse</h3><p>' + esc(e.message) + '</p></div>'; return; }
    // Day rollover: yesterday's links stay valid for another day, so just reconnect the live stream
    // now and pick up fresh links the next time the user switches chats.
    setInterval(() => {
      api('GET', '/api/whoami').then((r) => {
        if (r.vt === VT) return;
        if (V.linksStale) { VT = r.vt; return relink(); }
        VT = r.vt; connect(); V.linksStale = true;
        // Links signed yesterday stop working at the next UTC midnight; refresh a few minutes before.
        const now = new Date();
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        clearTimeout(V.relinkTimer);
        V.relinkTimer = setTimeout(() => { if (V.linksStale) relink().catch(() => {}); }, Math.max(60e3, midnight - Date.now() - 5 * 60e3));
      }).catch(() => {});
    }, 3600e3);
    go(fromHash(), { replace: true });
    connect();
  })();
})();
