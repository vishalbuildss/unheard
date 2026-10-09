'use strict';
/*
  Unheard Cypher server.

  One room. The server owns the queue, the clock, the votes and the leaderboard.
  Voice goes browser to browser over WebRTC (encrypted). This server only passes the
  handshake, and only between the rapper on the mic and the people listening.
*/
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const sec = require('./lib/security');

/* ---------- settings ---------- */
const env = process.env;
const PROD = env.NODE_ENV === 'production';
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const PORT = Number(env.PORT) || 3000;
const T = {
  ready: num(env.READY_SECONDS, 3),
  perform: num(env.PERFORM_SECONDS, 60),
  vote: num(env.VOTE_SECONDS, 10),
  result: num(env.RESULT_SECONDS, 6)
};
const MAX_QUEUE = num(env.MAX_QUEUE, 30);
const MAX_PER_IP = num(env.MAX_CONNECTIONS_PER_IP, 8);
const MAX_CONNECTIONS = num(env.MAX_CONNECTIONS, 400);
const MAX_AUDIO = num(env.MAX_AUDIO_LISTENERS, 25);
const ONE_VOTE_PER_IP = env.ONE_VOTE_PER_IP ? env.ONE_VOTE_PER_IP === 'true' : PROD;
const TRUST_PROXY = env.TRUST_PROXY === 'true';
const HTTPS_ONLY = env.HTTPS_ONLY === 'true'; // set when the site is served over https
const ADMIN_TOKEN = env.ADMIN_TOKEN || '';
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_NO_ORIGIN = env.ALLOW_NO_ORIGIN === 'true'; // only for scripts and tests, browsers always send an Origin
const NAME_HOLD_MS = 60 * 1000;
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BEATS_DIR = path.join(PUBLIC_DIR, 'beats');
const SALT = crypto.randomBytes(16).toString('hex');
const REACTIONS = new Set(['fire', 'bars', '100', 'wow']);
const mod = sec.makeModeration(sec.loadBlocklist(path.join(__dirname, 'blocklist.txt')));

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
if (env.TURN_URL) {
  ICE_SERVERS.push({ urls: env.TURN_URL.split(',').map(s => s.trim()), username: env.TURN_USER, credential: env.TURN_PASS });
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- leaderboard (Map, so odd names can never touch object prototypes) ---------- */
const lb = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
  for (const [name, e] of Object.entries(raw)) {
    if (sec.NAME_RE.test(name) && e && Number.isFinite(e.sum) && Number.isInteger(e.n) && e.n > 0 && e.sum >= 0 && e.sum <= e.n * 10) {
      lb.set(name, { sum: e.sum, n: e.n });
    }
  }
} catch (_) { /* first run */ }
let saveTimer = null;
function saveLb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushLb, 800);
}
function flushLb() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = LB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(lb)), { mode: 0o600 });
    fs.renameSync(tmp, LB_FILE);
  } catch (e) { log('could not save leaderboard:', e.message); }
}
const topBoard = () => [...lb.entries()]
  .map(([name, e]) => ({ name, avg: e.sum / e.n, n: e.n }))
  .sort((a, b) => b.avg - a.avg || b.n - a.n)
  .slice(0, 10);

/* ---------- web server ---------- */
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      ...(HTTPS_ONLY ? { upgradeInsecureRequests: [] } : {})
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: HTTPS_ONLY ? { maxAge: 15552000, includeSubDomains: true } : false
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=()');
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(PUBLIC_DIR, {
  dotfiles: 'ignore',
  index: 'index.html',
  setHeaders(res, file) {
    res.setHeader('Cache-Control', /\.(html)$/.test(file) ? 'no-cache' : 'public, max-age=3600');
  }
}));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => { log('http error:', err.message); res.status(500).type('text/plain').send('Something went wrong'); });

const server = http.createServer(app);
const originOk = req => {
  const origin = req.headers.origin;
  if (!origin) return ALLOW_NO_ORIGIN;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ALLOWED_ORIGINS.length) return false;
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
};
const io = new Server(server, {
  maxHttpBufferSize: 5e4,
  pingInterval: 20000,
  pingTimeout: 20000,
  serveClient: false,
  cors: false,
  allowRequest: (req, cb) => cb(null, originOk(req))
});

/* ---------- state ---------- */
const users = new Map();    // socket id -> { name, token, ipH, mutedUntil }
const owners = new Map();   // name skeleton -> { token, id, expires }
const ipCount = new Map();  // ip hash -> open connections
const bans = new Map();     // ip hash -> expiry time
const authFails = new Map();// ip hash -> { n, until }
const admins = new Set();
let queue = [];
const game = {
  phase: 'idle', round: 0, phaseStart: Date.now(), phaseEnd: Date.now(),
  cur: null, votes: new Map(), result: null, beat: null, rtc: new Set()
};
let timer = null, stateTimer = null, rosterTimer = null;

const sys = text => io.emit('sys', text);
const reply = (cb, obj) => { if (typeof cb === 'function') cb(obj); };
const ipHash = ip => crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 24);
function ipOf(socket) {
  const h = socket.handshake;
  if (TRUST_PROXY) {
    const parts = String(h.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h.address || 'unknown';
}
const listBeats = () => {
  try { return fs.readdirSync(BEATS_DIR).filter(f => /^[\w .-]+\.(mp3|ogg|wav|m4a)$/i.test(f)).slice(0, 200); } catch (_) { return []; }
};

function publicState() {
  return {
    serverTime: Date.now(),
    phase: game.phase,
    round: game.round,
    phaseStart: game.phaseStart,
    phaseEnd: game.phaseEnd,
    durations: T,
    cur: game.cur ? { id: game.cur.id, name: game.cur.name } : null,
    queue: queue.map(q => ({ id: q.id, name: q.name })),
    votesIn: game.votes.size,
    result: game.result,
    beat: game.beat
  };
}
function broadcast(now) {
  if (now) { clearTimeout(stateTimer); stateTimer = null; io.emit('state', publicState()); return; }
  if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; io.emit('state', publicState()); }, 150);
}
function rosterPayload() {
  return {
    list: [...users.entries()].map(([id, u]) => ({ id, name: u.name })),
    watching: Math.max(0, io.engine.clientsCount - users.size)
  };
}
function adminPayload() {
  return [...users.entries()].map(([id, u]) => ({ id, name: u.name, muted: u.mutedUntil > Date.now(), net: u.ipH.slice(0, 6) }));
}
function pushRoster() {
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = null;
    io.emit('roster', rosterPayload());
    if (admins.size) { const a = adminPayload(); for (const id of admins) io.to(id).emit('admin:users', a); }
  }, 250);
}

/* ---------- the round ---------- */
function setPhase(phase, seconds) {
  clearTimeout(timer);
  game.phase = phase;
  game.phaseStart = Date.now();
  game.phaseEnd = game.phaseStart + seconds * 1000;
  timer = setTimeout(advance, seconds * 1000);
  broadcast(true);
}
function advance() {
  if (game.phase === 'ready') {
    sys(game.cur.name + ' is on the mic. ' + T.perform + ' seconds.');
    setPhase('perform', T.perform);
  } else if (game.phase === 'perform') {
    sys('Time. Voting is open.');
    game.rtc = new Set();
    setPhase('vote', T.vote);
  } else if (game.phase === 'vote') finishVote();
  else if (game.phase === 'result') startNext();
}
function finishVote() {
  const scores = [...game.votes.values()];
  const n = scores.length;
  const avg = n ? scores.reduce((a, b) => a + b, 0) / n : null;
  game.result = { name: game.cur.name, avg, n };
  if (avg != null) {
    const e = lb.get(game.cur.name) || { sum: 0, n: 0 };
    e.sum += avg; e.n++;
    lb.set(game.cur.name, e);
    saveLb();
    io.emit('lb', topBoard());
    sys(game.cur.name + ' scored ' + avg.toFixed(1) + '/10 from ' + n + ' vote' + (n === 1 ? '' : 's') + '.');
  } else sys(game.cur.name + ' got no votes.');
  setPhase('result', T.result);
}
function startNext() {
  clearTimeout(timer); timer = null;
  game.cur = null; game.votes = new Map(); game.rtc = new Set(); game.beat = null;
  while (queue.length) {
    const n = queue.shift();
    if (users.has(n.id)) { game.cur = n; break; }
  }
  if (!game.cur) {
    game.phase = 'idle'; game.result = null;
    game.phaseStart = game.phaseEnd = Date.now();
    broadcast(true);
    return;
  }
  game.round++;
  game.result = null;
  const beats = listBeats();
  game.beat = beats.length ? beats[crypto.randomInt(beats.length)] : null;
  setPhase('ready', T.ready);
}

/* ---------- sockets ---------- */
const onMicNow = () => !!game.cur && (game.phase === 'ready' || game.phase === 'perform');

io.on('connection', socket => {
  const ip = ipOf(socket);
  const ipH = ipHash(ip);
  socket.data = { ipH, buckets: Object.create(null), strikes: 0, admin: false };

  if ((bans.get(ipH) || 0) > Date.now() || io.engine.clientsCount > MAX_CONNECTIONS || (ipCount.get(ipH) || 0) >= MAX_PER_IP) {
    socket.emit('refused', 'Too many connections or you are blocked right now.');
    socket.disconnect(true);
    return;
  }
  ipCount.set(ipH, (ipCount.get(ipH) || 0) + 1);

  /* every event goes through here: rate limit, strike counting, no crashes on bad payloads */
  const on = (event, cap, perSec, fn) => socket.on(event, (...args) => {
    try {
      if (!sec.take(socket.data.buckets, event, cap, perSec)) {
        if (++socket.data.strikes > 60) { socket.disconnect(true); }
        const cb = args[args.length - 1];
        if (typeof cb === 'function') cb({ ok: false, error: 'Slow down.' });
        return;
      }
      fn(...args);
    } catch (e) { log('handler error', event, e.message); }
  });
  const user = () => users.get(socket.id);

  socket.emit('hello', { iceServers: ICE_SERVERS, durations: T, adminEnabled: !!ADMIN_TOKEN, maxAudio: MAX_AUDIO });
  socket.emit('state', publicState());
  socket.emit('lb', topBoard());
  socket.emit('roster', rosterPayload());
  pushRoster();

  on('join', 4, 0.1, (data, cb) => {
    data = data && typeof data === 'object' ? data : {};
    const name = sec.cleanText(data.name, 64); // longer than 16 is refused below, never silently cut
    const token = typeof data.token === 'string' ? data.token.slice(0, 64) : '';
    const bad = mod.nameError(name);
    if (bad) return reply(cb, { ok: false, error: bad });
    const prev = user();
    if (prev) return reply(cb, prev.name === name ? { ok: true, name, token: prev.token } : { ok: false, error: 'You already joined as ' + prev.name + '.' });

    const key = sec.skeleton(name);
    const o = owners.get(key);
    const live = !!o && !!o.id && io.sockets.sockets.has(o.id);
    if (o && o.token !== token && (live || o.expires > Date.now())) return reply(cb, { ok: false, error: 'That name is taken. Try another.' });
    if (o && live && o.id !== socket.id) { // same person, second tab: the new tab wins
      const old = io.sockets.sockets.get(o.id);
      if (old) setImmediate(() => old.disconnect(true));
    }
    const mine = o && o.token === token ? token : sec.newToken();
    owners.set(key, { token: mine, id: socket.id, expires: Infinity });
    users.set(socket.id, { name, token: mine, ipH, mutedUntil: 0, key });
    sys(name + ' entered the cypher.');
    pushRoster();
    reply(cb, { ok: true, name, token: mine });
  });

  on('queue:join', 4, 0.5, (_d, cb) => {
    const u = user();
    if (!u) return reply(cb, { ok: false, error: 'Pick a username first.' });
    if (game.cur && game.cur.id === socket.id && (game.phase === 'ready' || game.phase === 'perform')) return reply(cb, { ok: false, error: 'You are on stage right now.' });
    if (queue.some(q => q.id === socket.id)) return reply(cb, { ok: false, error: 'You are already in line.' });
    if (queue.length >= MAX_QUEUE) return reply(cb, { ok: false, error: 'The line is full. Try again soon.' });
    queue.push({ id: socket.id, name: u.name });
    sys(u.name + ' joined the line.');
    if (game.phase === 'idle') startNext(); else broadcast(true);
    reply(cb, { ok: true });
  });

  on('queue:leave', 4, 0.5, (_d, cb) => {
    const before = queue.length;
    queue = queue.filter(q => q.id !== socket.id);
    if (queue.length !== before) broadcast(true);
    reply(cb, { ok: true });
  });

  on('vote', 6, 1, (data, cb) => {
    const s = Number(data && data.score);
    const ok = game.phase === 'vote' && game.cur && socket.id !== game.cur.id && Number.isInteger(s) && s >= 0 && s <= 10;
    if (!ok) return reply(cb, { ok: false });
    game.votes.set(ONE_VOTE_PER_IP ? ipH : socket.id, s);
    broadcast();
    reply(cb, { ok: true });
  });

  on('finish', 2, 0.2, () => {
    if (!game.cur || game.cur.id !== socket.id) return;
    if (game.phase === 'ready') { sys(game.cur.name + ' skipped the turn.'); startNext(); }
    else if (game.phase === 'perform') advance();
  });

  on('chat', 4, 1, data => {
    const u = user();
    if (!u) return;
    if (u.mutedUntil > Date.now()) { socket.emit('sys', 'You are muted for now.'); return; }
    let text = sec.cleanText(data && data.text, 140);
    if (!text) return;
    if (sec.hasLink(text)) { socket.emit('sys', 'Links are not allowed in chat.'); return; }
    text = mod.maskText(text);
    io.emit('chat', { name: u.name, text });
  });

  on('react', 6, 3, kind => {
    if (typeof kind !== 'string' || !REACTIONS.has(kind)) return;
    io.emit('react', kind);
  });

  /* --- voice handshake relay ---
     Listeners send an offer to the rapper, the rapper answers. Nothing else is relayed,
     nobody can reach another listener, and it all stops when the 60 seconds end. */
  on('rtc:offer', 30, 10, d => {
    if (!d || !onMicNow() || d.to !== game.cur.id || socket.id === game.cur.id || !sec.validDesc(d.sdp) || d.sdp.type !== 'offer') return;
    if (!game.rtc.has(socket.id)) {
      if (game.rtc.size >= MAX_AUDIO) { socket.emit('rtc:full'); return; }
      game.rtc.add(socket.id);
    }
    io.to(d.to).emit('rtc:offer', { from: socket.id, sdp: d.sdp });
  });
  on('rtc:answer', 30, 10, d => {
    if (!d || !onMicNow() || socket.id !== game.cur.id || !sec.isStr(d.to, 40) || !game.rtc.has(d.to) || !sec.validDesc(d.sdp) || d.sdp.type !== 'answer') return;
    io.to(d.to).emit('rtc:answer', { from: socket.id, sdp: d.sdp });
  });
  on('rtc:ice', 120, 40, d => {
    if (!d || !onMicNow() || !sec.isStr(d.to, 40) || !sec.validCandidate(d.candidate)) return;
    const fromRapper = socket.id === game.cur.id;
    if (fromRapper ? !game.rtc.has(d.to) : d.to !== game.cur.id) return;
    io.to(d.to).emit('rtc:ice', { from: socket.id, candidate: d.candidate });
  });

  /* --- moderators --- */
  on('admin:auth', 5, 1 / 60, (data, cb) => {
    if (!ADMIN_TOKEN) return reply(cb, { ok: false, error: 'Moderation is not turned on.' });
    const f = authFails.get(ipH);
    if (f && f.until > Date.now()) return reply(cb, { ok: false, error: 'Too many tries. Wait a few minutes.' });
    if (!sec.safeEqual(String(data && data.token || ''), ADMIN_TOKEN)) {
      const n = (f ? f.n : 0) + 1;
      authFails.set(ipH, { n, until: n >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
      return reply(cb, { ok: false, error: 'Wrong token.' });
    }
    authFails.delete(ipH);
    socket.data.admin = true; admins.add(socket.id);
    reply(cb, { ok: true });
    socket.emit('admin:users', adminPayload());
  });
  const adminOnly = fn => (...a) => { if (socket.data.admin) fn(...a); };
  const findByName = name => { const k = sec.skeleton(String(name || '')); for (const [id, u] of users) if (u.key === k) return id; return null; };
  on('admin:skip', 4, 0.5, adminOnly(() => {
    if (!game.cur) return;
    sys('A moderator skipped ' + game.cur.name + '.');
    startNext();
  }));
  on('admin:mute', 6, 1, adminOnly(d => {
    const id = findByName(d && d.name); const u = id && users.get(id);
    if (!u) return;
    const mins = Math.min(1440, Math.max(1, Number(d.minutes) || 10));
    u.mutedUntil = Date.now() + mins * 60000;
    io.to(id).emit('sys', 'A moderator muted you for ' + mins + ' minutes.');
    pushRoster();
  }));
  on('admin:kick', 6, 1, adminOnly(d => {
    const id = findByName(d && d.name); const u = id && users.get(id);
    if (!u) return;
    if (d.ban) bans.set(u.ipH, Date.now() + 60 * 60000);
    io.to(id).emit('refused', d.ban ? 'You were removed and blocked for an hour.' : 'You were removed by a moderator.');
    const target = io.sockets.sockets.get(id);
    if (target) target.disconnect(true);
  }));

  socket.on('disconnect', () => {
    ipCount.set(ipH, Math.max(0, (ipCount.get(ipH) || 1) - 1));
    if (!ipCount.get(ipH)) ipCount.delete(ipH);
    admins.delete(socket.id);
    const u = users.get(socket.id);
    users.delete(socket.id);
    if (u) {
      const o = owners.get(u.key);
      if (o && o.id === socket.id) { o.id = null; o.expires = Date.now() + NAME_HOLD_MS; }
    }
    queue = queue.filter(q => q.id !== socket.id);
    game.rtc.delete(socket.id);
    if (game.cur && game.cur.id === socket.id && onMicNow()) {
      sys(game.cur.name + ' left the mic.');
      startNext();
    } else broadcast();
    pushRoster();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [k, o] of owners) if (!o.id && o.expires < now) owners.delete(k);
  for (const [k, v] of bans) if (v < now) bans.delete(k);
  for (const [k, v] of authFails) if (v.until < now && v.n < 5) authFails.delete(k);
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    log('Unheard Cypher on http://localhost:' + PORT + (PROD ? ' (production)' : ''));
    if (PROD && !ADMIN_TOKEN) log('Note: ADMIN_TOKEN is not set, so moderator tools are off.');
  });
  const quit = () => { flushLb(); process.exit(0); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.on('uncaughtException', e => { log('uncaught:', e.stack || e.message); });
  process.on('unhandledRejection', e => { log('unhandled:', e && e.message); });
}
module.exports = { server, io };
