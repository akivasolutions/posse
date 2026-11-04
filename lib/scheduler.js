'use strict';
// Routines: saved instructions a bot runs on a schedule (daily at a time on chosen weekdays,
// every N minutes, once) or when its webhook URL is called. Times are the machine's local time.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function atTime(base, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function nextRun(s, now = Date.now(), lastRunAt = 0) {
  if (!s) return 0;
  if (s.type === 'daily') {
    const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    let d = atTime(now, s.time);
    for (let i = 0; i < 9; i++) {
      if (d.getTime() > now && days.includes(d.getDay())) return d.getTime();
      d = atTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime(), s.time);
    }
    return 0;
  }
  if (s.type === 'interval') {
    const ms = Math.max(15, s.minutes || 60) * 60e3;
    if (!lastRunAt) return now + ms;
    return Math.max(now, lastRunAt + ms);
  }
  if (s.type === 'once') {
    if (lastRunAt) return 0;
    const t = new Date(s.at).getTime();
    return Number.isFinite(t) ? Math.max(t, now) : 0;
  }
  return 0; // webhook
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

function describeSchedule(s) {
  if (!s) return '';
  if (s.type === 'daily') {
    const days = (s.days || []).slice().sort().join(',');
    let when = 'Every day';
    if (days === '1,2,3,4,5') when = 'Weekdays';
    else if (days === '0,6') when = 'Weekends';
    else if (days && days !== '0,1,2,3,4,5,6') when = s.days.slice().sort().map((d) => DAY[d]).join(', ');
    return when + ' at ' + fmtTime(s.time);
  }
  if (s.type === 'interval') {
    const m = s.minutes;
    if (m % 1440 === 0) return 'Every ' + (m / 1440 === 1 ? 'day' : m / 1440 + ' days');
    if (m % 60 === 0) return 'Every ' + (m / 60 === 1 ? 'hour' : m / 60 + ' hours');
    return 'Every ' + m + ' minutes';
  }
  if (s.type === 'once') {
    const d = new Date(s.at);
    return 'Once, ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (s.type === 'webhook') return 'When its webhook is called';
  return '';
}

class Scheduler {
  constructor(app) { this.app = app; this.timer = null; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 20e3);
    this.timer.unref();
    setTimeout(() => this.tick(), 3000).unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  tick(now = Date.now()) {
    const app = this.app;
    for (const r of app.routines.values()) {
      if (!r.enabled || r.pendingApproval || !r.nextRunAt || r.nextRunAt > now) continue;
      const bot = app.bots.get(r.botId);
      if (!bot) continue;
      // Don't stack runs: if the last one is still waiting, just move the schedule forward.
      const waiting = (bot._queue || []).some((i) => i.kind === 'routine' && i.routineId === r.id);
      if (waiting) {
        r.nextRunAt = r.schedule.type === 'once' ? 0 : nextRun(r.schedule, now, now);
        app.saveRoutines();
        continue;
      }
      app.fireRoutine(r);
    }
  }
}

module.exports = { Scheduler, nextRun, describeSchedule };
