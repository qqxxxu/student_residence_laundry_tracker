// ===== Settings =====
// Order = order on screen (2 per row): dryers on top, washers below
const MACHINES = [
  { id: '3', name: 'Dryer 3', type: 'dryer' },
  { id: '4', name: 'Dryer 4', type: 'dryer' },
  { id: '1', name: 'Washer 1', type: 'washer' },
  { id: '2', name: 'Washer 2', type: 'washer' }
];
const UNDO_MINUTES = 15;        // how long a change can be undone
const HOLD_MINUTES = 15;        // a free machine is saved this long for the first person in line
const LOG_SIZE = 8;             // history entries kept per machine
const QUEUE_EXPIRE_HOURS = 4;   // waitlist entries older than this are removed
const MAX_MINUTES = 75;         // longest time a machine display can show

// ===== Web entry =====
// Optional: add ?m=1 (etc.) to the URL to highlight one machine
function doGet(e) {
  const p = (e && e.parameter) || {};
  const t = HtmlService.createTemplateFromFile('index');
  t.focus = String(p.m || '');
  return t.evaluate()
    .setTitle('Laundry Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ===== Storage =====
// Data is kept in 3 script properties (Google limits each one to 9 KB): machines, history, waitlists.
// fresh = true reads the permanent store directly (used inside the lock, so two people can never both win)
function read_(fresh) {
  const cache = CacheService.getScriptCache();
  const hit = fresh ? null : cache.get('all');
  let s;
  if (hit) {
    s = JSON.parse(hit);
  } else {
    const p = PropertiesService.getScriptProperties().getProperties();
    const st = p.state ? JSON.parse(p.state) : {};
    s = { m: st.m, hold: st.hold,
          log: p.log ? JSON.parse(p.log) : st.log,     // older versions kept everything in "state"
          q: p.q ? JSON.parse(p.q) : st.q };
  }
  if (!s.m) s.m = {};
  if (!s.log) s.log = {};
  if (!s.q || s.q.washer || s.q.dryer) s.q = {};    // waitlists are per machine (older per-type lists are dropped)
  if (!s.hold) s.hold = {};
  MACHINES.forEach(function (x) {
    if (!s.m[x.id]) s.m[x.id] = { status: 'free' };
    if (!s.log[x.id]) s.log[x.id] = [];
    if (!s.q[x.id]) s.q[x.id] = [];
  });
  if (!hit && !fresh) cache.put('all', JSON.stringify(s), 21600);
  return s;
}

function write_(s) {
  PropertiesService.getScriptProperties().setProperties({
    state: JSON.stringify({ m: s.m, hold: s.hold }),
    log: JSON.stringify(s.log),
    q: JSON.stringify(s.q)
  });
  CacheService.getScriptCache().put('all', JSON.stringify(s), 21600);
}

// ===== Waitlist holds =====
// Each machine has its own waitlist. When a machine becomes free (someone tapped "Clothes taken out",
// "End early" or "Fixed"), it is saved for the first person on its list for HOLD_MINUTES.
// If they don't start in time they're removed from that list and the next person gets HOLD_MINUTES.
// One person can be on several lists, but only one machine is saved for them at a time.
function settle_(s) {
  const now = Date.now();
  let changed = false;
  const cutoff = now - QUEUE_EXPIRE_HOURS * 3600000;
  MACHINES.forEach(function (m) {
    const before = s.q[m.id].length;
    s.q[m.id] = s.q[m.id].filter(function (e) { return e.t > cutoff; });
    if (s.q[m.id].length !== before) changed = true;
  });
  const holding = function (exceptId) {   // names that already have a machine saved
    return Object.keys(s.hold).filter(function (k) { return k !== exceptId && s.hold[k].qid; })
      .map(function (k) { return String(s.hold[k].name).trim().toLowerCase(); });
  };

  MACHINES.forEach(function (m) {
    const st = s.m[m.id];
    if (st.status !== 'free') {
      if (s.hold[m.id]) { delete s.hold[m.id]; changed = true; }
      return;
    }
    let h = s.hold[m.id] || {};
    let base = h.base || st.at || 0;
    if (h.qid) {
      const stillWaiting = s.q[m.id].some(function (e) { return e.id === h.qid; });
      if (stillWaiting && h.until > now) return;            // still their turn
      if (stillWaiting) {                                    // missed their 15 minutes
        s.q[m.id] = s.q[m.id].filter(function (e) { return e.id !== h.qid; });
        base = h.until;
      } else {                                               // left the list, or started another machine
        base = now;
      }
      changed = true;
    }
    s.hold[m.id] = { base: base };
    while (true) {
      const busy = holding(m.id);
      const next = s.q[m.id].filter(function (e) { return busy.indexOf(e.name.trim().toLowerCase()) < 0; })[0];
      if (!next) break;
      const until = Math.max(base, next.t) + HOLD_MINUTES * 60000;
      if (until <= now) {                                    // their turn already came and went
        s.q[m.id] = s.q[m.id].filter(function (e) { return e.id !== next.id; });
        base = until;
        s.hold[m.id] = { base: base };
        changed = true;
        continue;
      }
      s.hold[m.id] = { qid: next.id, name: next.name, until: until, base: base };
      changed = true;
      break;
    }
  });
  return changed;
}

function getStatus() {
  let s = read_();
  if (settle_(s)) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(3000)) {
      try { s = read_(true); settle_(s); write_(s); } finally { lock.releaseLock(); }
    }
  }
  const queue = {};
  Object.keys(s.q).forEach(function (id) {
    // entries from before private keys existed are marked old, so anyone can remove them
    queue[id] = s.q[id].map(function (e) { return { id: e.id, name: e.name, t: e.t, old: !e.key }; });
  });
  return { machines: MACHINES, state: s.m, log: s.log, queue: queue, hold: s.hold, now: Date.now(),
           undoMinutes: UNDO_MINUTES, holdMinutes: HOLD_MINUTES, maxMinutes: MAX_MINUTES };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let extra;
  try {
    const s = read_(true);
    settle_(s);
    extra = fn(s);
    settle_(s);
    write_(s);
  } finally {
    lock.releaseLock();
  }
  return Object.assign(getStatus(), extra || {});
}

// ===== Helpers =====
function machine_(id) {
  const m = MACHINES.filter(function (x) { return x.id === String(id); })[0];
  if (!m) throw new Error('E:noMachine');
  return m;
}
function who_(actor) { return String(actor || '').trim().slice(0, 20); }
function running_(c) { return c.status === 'use' && c.end > Date.now(); }
function same_(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

function change_(s, id, actor, next, key, detail) {
  const prev = Object.assign({}, s.m[id]);
  delete prev.prev;
  next.at = Date.now();
  next.prev = prev;
  s.m[id] = next;
  addLog_(s, id, actor, key, detail);
}
function addLog_(s, id, actor, key, detail) {
  s.log[id].unshift({ t: Date.now(), who: who_(actor), k: key, x: detail == null ? '' : String(detail) });
  s.log[id] = s.log[id].slice(0, LOG_SIZE);
}

// ===== Machine actions =====
function minutes_(v, lo) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < lo || n > MAX_MINUTES) throw new Error('E:minutes');
  return n;
}

// mode: 'start' | 'proxy' (someone is using it without logging) | 'takeover' (logged, but actually empty)
function start(id, minutesLeft, actor, mode) {
  const m = machine_(id);
  const min = minutes_(minutesLeft, 1);
  return withLock_(function (s) {
    const cur = s.m[m.id];
    const end = Date.now() + min * 60000;
    if (mode === 'takeover') {
      if (!running_(cur)) throw new Error('E:notInUse');
      change_(s, m.id, actor, { status: 'use', end: end, who: who_(actor) }, 'takeover', cur.who || '');
    } else {
      if (running_(cur)) throw new Error('E:justStarted');
      if (cur.status === 'use' && mode !== 'proxy') throw new Error('E:clothesInside');
      if (cur.status === 'broken' && mode !== 'proxy') throw new Error('E:broken');
      const h = s.hold[m.id];
      if (mode !== 'proxy' && h && h.qid && !same_(h.name, actor)) throw new Error('E:saved:' + h.name);
      if (mode === 'proxy') {
        change_(s, m.id, actor, { status: 'use', end: end, who: '' }, 'proxy');
        return;
      }
      change_(s, m.id, actor, { status: 'use', end: end, who: who_(actor) }, 'start');
    }
    // Starting a machine takes you off every waitlist
    if (who_(actor)) MACHINES.forEach(function (x) {
      s.q[x.id] = s.q[x.id].filter(function (e) { return !same_(e.name, actor); });
    });
  });
}

function editTime(id, minutesLeft, actor) {
  const m = machine_(id);
  const min = minutes_(minutesLeft, 0);
  return withLock_(function (s) {
    const cur = s.m[m.id];
    if (cur.status !== 'use') throw new Error('E:notInUse');
    change_(s, m.id, actor, { status: 'use', end: Date.now() + min * 60000, who: cur.who || '' }, 'edit', min);
  });
}

function freeMachine(id, actor) {
  const m = machine_(id);
  return withLock_(function (s) {
    const cur = s.m[m.id];
    if (cur.status === 'free') return;
    const key = cur.status === 'broken' ? 'fixed' : running_(cur) ? 'ended' : 'out';
    change_(s, m.id, actor, { status: 'free' }, key);
  });
}

function setBroken(id, note, actor) {
  const m = machine_(id);
  note = String(note || '').trim().slice(0, 40);
  return withLock_(function (s) {
    change_(s, m.id, actor, { status: 'broken', note: note }, 'broken');
  });
}

function undo(id, actor) {
  const m = machine_(id);
  return withLock_(function (s) {
    const cur = s.m[m.id];
    if (!cur.prev || !cur.at || Date.now() - cur.at > UNDO_MINUTES * 60000) throw new Error('E:undoLate');
    s.m[m.id] = cur.prev;
    s.hold[m.id] = { base: Date.now() };   // if it's free again, the next turn starts now
    addLog_(s, m.id, actor, 'undo');
  });
}

// ===== Waitlist (one per machine) =====
// Joining returns a private key that stays on that phone. Only that key can remove the entry.
function joinQueue(id, name) {
  const m = machine_(id);
  name = who_(name);
  if (!name) throw new Error('E:name');
  return withLock_(function (s) {
    if (s.q[m.id].some(function (e) { return same_(e.name, name); })) throw new Error('E:dup:' + name);
    const entry = Utilities.getUuid().slice(0, 8);
    const key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    s.q[m.id].push({ id: entry, name: name, t: Date.now(), key: key });
    return { joined: entry, key: key };
  });
}

function leaveQueue(id, entryId, key) {
  const m = machine_(id);
  return withLock_(function (s) {
    const e = s.q[m.id].filter(function (x) { return x.id === entryId; })[0];
    if (!e) return;
    if (e.key && e.key !== key) throw new Error('E:notYours');
    s.q[m.id] = s.q[m.id].filter(function (x) { return x.id !== entryId; });
  });
}
