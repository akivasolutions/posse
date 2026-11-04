'use strict';
// Finds the Claude Code CLI, detects which flags this version supports, and spawns it in a way
// that works on macOS, Linux and Windows (native claude.exe, npm claude.cmd shims, or cli.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function candidates(configured) {
  const out = [];
  if (configured) out.push(configured);
  if (process.env.CLAUDE_BIN) out.push(process.env.CLAUDE_BIN);
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) for (const n of names) out.push(path.join(dir, n));
  }
  const home = os.homedir();
  if (isWin) {
    out.push(path.join(home, '.local', 'bin', 'claude.exe'));
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
    if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  } else {
    out.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude',
      path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'), path.join(home, '.bun', 'bin', 'claude'));
  }
  return out;
}

// Turns a path into something spawn() can run without a shell where possible.
// npm on Windows installs a claude.cmd shim; Node refuses to spawn .cmd files without a shell,
// so look past the shim for the real executable (or the JS entry point of older versions).
function launcher(bin) {
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    const pkg = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code');
    const exe = path.join(pkg, 'bin', 'claude.exe');
    if (isFile(exe)) return { command: exe, prefix: [], shell: false, display: exe };
    const js = path.join(pkg, 'cli.js');
    if (isFile(js)) return { command: process.execPath, prefix: [js], shell: false, display: js };
    return { command: bin, prefix: [], shell: true, display: bin };
  }
  return { command: bin, prefix: [], shell: false, display: bin };
}

let cached = null;

function detect(configured, { force = false } = {}) {
  if (cached && !force && cached.configured === (configured || '')) return cached;
  const info = { configured: configured || '', found: false, path: '', version: '', flags: new Set(), error: '' };
  const bin = candidates(configured).find(isFile);
  if (!bin) {
    info.error = 'Claude Code CLI not found. Install it (https://docs.claude.com/claude-code) or set its path in Settings.';
    cached = info;
    return info;
  }
  info.path = bin;
  info.launch = launcher(bin);
  try {
    const v = runSync(info.launch, ['--version']);
    info.version = (v.stdout || '').trim().split('\n')[0];
    const h = runSync(info.launch, ['--help']);
    const text = (h.stdout || '') + (h.stderr || '');
    for (const m of text.matchAll(/--([a-z][a-z0-9-]+)/g)) info.flags.add(m[1]);
    // Some flags only appear inside other flags' help text, e.g. "--append-system-prompt[-file]".
    if (text.includes('append-system-prompt[-file]')) info.flags.add('append-system-prompt-file');
    info.found = !!info.version;
    if (!info.found) info.error = 'Found ' + bin + ' but it did not report a version: ' + ((v.stderr || '').trim() || 'no output');
  } catch (e) {
    info.error = 'Could not run ' + bin + ': ' + e.message;
  }
  cached = info;
  return info;
}

function runSync(l, args) {
  return spawnSync(l.command, [...l.prefix, ...args], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, shell: l.shell,
  });
}

function quoteForCmd(a) {
  if (/^[\w.:\\/=@,+-]+$/.test(a)) return a;
  return '"' + String(a).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}

function spawnClaude(info, args, opts) {
  const l = info.launch;
  let finalArgs = [...l.prefix, ...args];
  if (l.shell) finalArgs = finalArgs.map(quoteForCmd);
  return spawn(l.command, finalArgs, {
    cwd: opts.cwd,
    env: opts.env,
    shell: l.shell,
    windowsHide: true,
    detached: !isWin, // own process group, so stop() can end the CLI and everything it started
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) {
      try { if (!isWin) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch {}
    }
  }, 5000).unref();
}

module.exports = { detect, spawnClaude, killTree, isWin };
