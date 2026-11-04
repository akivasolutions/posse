'use strict';
const crypto = require('crypto');

function id(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function slugify(s, fallback = 'bot') {
  const out = String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || fallback;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// "Tue Nov 4, 4:32 PM" in the machine's local time zone.
function stamp(ts = Date.now()) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

// Pull @handles out of free text. Handles are slug-style (a-z, 0-9, dashes).
function mentions(text) {
  const out = new Set();
  const re = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,39})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[2].toLowerCase());
  return [...out];
}

module.exports = { id, token, slugify, truncate, hash, clampInt, stamp, localDateKey, timeZone, mentions };
