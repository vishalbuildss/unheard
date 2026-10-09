'use strict';
/*
  Starts the real server with short timers and checks the rules the platform depends on:
  turn order, who may speak, voting, the leaderboard, and the security rules.
  Run it with: npm test
*/
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = 3100 + Math.floor(Math.random() * 800);
const ORIGIN = 'http://localhost:' + PORT;
const ADMIN = 'test-admin-token-123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cypher-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test', ADMIN_TOKEN: ADMIN, DATA_DIR: tmp,
    READY_SECONDS: '1', PERFORM_SECONDS: '3', VOTE_SECONDS: '3', RESULT_SECONDS: '1', MAX_AUDIO_LISTENERS: '25'
  },
  stdio: 'ignore'
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, fn) => { fn(); results.push(name); console.log('  ok  ' + name); };

async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(25);
  }
}

class Client {
  constructor(origin = ORIGIN) {
    this.state = null; this.chats = []; this.sys = []; this.lb = []; this.roster = null; this.offers = []; this.answers = []; this.ice = []; this.refused = null;
    this.s = io(ORIGIN, { transports: ['websocket'], reconnection: false, extraHeaders: origin ? { Origin: origin } : {} });
    this.s.on('state', s => { this.state = s; });
    this.s.on('chat', m => this.chats.push(m));
    this.s.on('sys', t => this.sys.push(t));
    this.s.on('lb', l => { this.lb = l; });
    this.s.on('roster', r => { this.roster = r; });
    this.s.on('rtc:offer', o => this.offers.push(o));
    this.s.on('rtc:answer', o => this.answers.push(o));
    this.s.on('rtc:ice', o => this.ice.push(o));
    this.s.on('refused', t => { this.refused = t; });
  }
  get id() { return this.s.id; }
  ready() {
    return new Promise((resolve, reject) => {
      if (this.s.connected) return resolve(this);
      this.s.once('connect', () => resolve(this));
      this.s.once('connect_error', reject);
    });
  }
  emit(ev, data) { return new Promise(r => this.s.timeout(3000).emit(ev, data, (err, res) => r(err ? { ok: false, timeout: true } : res))); }
  join(name, token) { return this.emit('join', { name, token }); }
  phase(p, who) { return () => this.state && this.state.phase === p && (!who || (this.state.cur && this.state.cur.name === who)); }
  close() { this.s.close(); }
}

function get(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p, headers }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
}

(async () => {
  for (let i = 0; i < 60; i++) { try { await get('/health'); break; } catch (_) { await sleep(150); } }
  const all = [];
  const mk = async (origin) => { const c = new Client(origin); all.push(c); await c.ready(); return c; };
  const cleanup = () => { all.forEach(c => c.close()); srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };

  try {
    /* ---------- web security ---------- */
    const res = await get('/health');
    const h = res.headers;
    check('strict content security policy is sent', () => {
      assert.ok(/default-src 'none'/.test(h['content-security-policy']));
      assert.ok(/script-src 'self'/.test(h['content-security-policy']));
      assert.ok(!/unsafe-inline|unsafe-eval/.test(h['content-security-policy']));
      assert.ok(/frame-ancestors 'none'/.test(h['content-security-policy']));
    });
    check('other safety headers are sent', () => {
      assert.strictEqual(h['x-content-type-options'], 'nosniff');
      assert.strictEqual(h['x-powered-by'], undefined);
      assert.ok(/microphone=\(self\)/.test(h['permissions-policy']));
      assert.strictEqual(h['referrer-policy'], 'no-referrer');
    });
    const dot = await get('/.env');
    check('hidden files are never served', () => assert.notStrictEqual(dot.statusCode, 200));

    /* ---------- who may connect ---------- */
    const bad = new Client('http://evil.example');
    all.push(bad);
    const badResult = await new Promise(r => { bad.s.once('connect', () => r('connected')); bad.s.once('connect_error', () => r('refused')); });
    check('connections from other websites are refused', () => assert.strictEqual(badResult, 'refused'));
    const none = new Client(null);
    all.push(none);
    const noneResult = await new Promise(r => { none.s.once('connect', () => r('connected')); none.s.once('connect_error', () => r('refused')); });
    check('connections without an origin are refused', () => assert.strictEqual(noneResult, 'refused'));

    /* ---------- names ---------- */
    const a = await mk(), b = await mk(), c = await mk(), lurker = await mk();
    let r = await a.join('Ana');
    check('can join with a username', () => { assert.strictEqual(r.ok, true); assert.ok(r.token && r.token.length >= 20); });
    const anaToken = r.token;
    r = await b.join('a.na');
    check('look-alike names are refused', () => assert.strictEqual(r.ok, false));
    for (const bad of ['__proto__', 'constructor', 'admin', 'x', '<script>', 'a'.repeat(30)]) {
      const t = await mk();
      r = await t.join(bad);
      assert.strictEqual(r.ok, false, 'should refuse ' + bad);
      t.close();
    }
    const spammer = await mk();
    let slow = 0;
    for (let i = 0; i < 8; i++) { r = await spammer.join('bad name!' + i); if (r.error === 'Slow down.') slow++; }
    check('repeated join attempts are rate limited', () => assert.ok(slow >= 3));
    spammer.close();
    results.push('unsafe, reserved and malformed names are refused'); console.log('  ok  unsafe, reserved and malformed names are refused');
    r = await b.join('Bo'); assert.strictEqual(r.ok, true);
    r = await c.join('Cy'); assert.strictEqual(r.ok, true);
    r = await lurker.emit('queue:join');
    check('people without a name cannot join the line', () => assert.strictEqual(r.ok, false));
    await until(() => a.roster && a.roster.list.length === 3, 3000, 'roster');
    check('roster lists everyone who joined', () => assert.deepStrictEqual(a.roster.list.map(x => x.name).sort(), ['Ana', 'Bo', 'Cy']));

    /* ---------- the round ---------- */
    await a.emit('queue:join');
    await until(a.phase('ready', 'Ana'), 3000, 'ready');
    check('first person in line gets the mic', () => assert.strictEqual(a.state.cur.id, a.id));
    await b.emit('queue:join');
    await until(() => b.state && b.state.queue.length === 1, 3000, 'queue');
    check('second person waits in the line', () => assert.strictEqual(b.state.queue[0].name, 'Bo'));
    await until(a.phase('perform'), 4000, 'perform');

    /* voice handshake rules */
    const sdp = (type) => ({ type, sdp: 'v=0\r\n' });
    c.s.emit('rtc:offer', { to: b.id, sdp: sdp('offer') });                // to a listener: dropped
    c.s.emit('rtc:offer', { to: a.id, sdp: { type: 'offer', sdp: 'x'.repeat(30000) } }); // too big: dropped
    c.s.emit('rtc:offer', { to: a.id, sdp: { type: 'nope', sdp: 'v=0' } });   // wrong shape: dropped
    c.s.emit('rtc:offer', { to: a.id, sdp: sdp('offer') });                // valid
    await until(() => a.offers.length >= 1, 2000, 'offer at rapper');
    await sleep(250);
    check('only a valid offer for the rapper gets through', () => { assert.strictEqual(a.offers.length, 1); assert.strictEqual(b.offers.length, 0); });
    b.s.emit('rtc:answer', { to: c.id, sdp: sdp('answer') });             // a listener cannot answer
    a.s.emit('rtc:answer', { to: b.id, sdp: sdp('answer') });             // rapper cannot answer someone who never offered
    a.s.emit('rtc:answer', { to: c.id, sdp: sdp('answer') });             // the real answer
    await until(() => c.answers.length >= 1, 2000, 'answer');
    await sleep(250);
    check('only the rapper can answer, and only listeners who asked', () => { assert.strictEqual(c.answers.length, 1); assert.strictEqual(b.answers.length, 0); });
    a.s.emit('rtc:ice', { to: lurker.id, candidate: { candidate: 'candidate:1' } }); // rapper cannot send to strangers
    await sleep(250);
    check('the rapper cannot send connection data to people who never asked', () => assert.strictEqual(lurker.ice.length, 0));

    r = await b.emit('vote', { score: 9 });
    check('no voting during the 60 seconds', () => assert.strictEqual(r.ok, false));
    b.s.emit('chat', { text: 'bars!' });
    await until(() => a.chats.some(m => m.name === 'Bo'), 2000, 'chat');
    check('chat reaches everyone', () => assert.strictEqual(a.chats.find(m => m.name === 'Bo').text, 'bars!'));
    lurker.s.emit('chat', { text: 'psst' });
    await sleep(250);
    check('people without a name cannot chat', () => assert.ok(!a.chats.some(m => m.text === 'psst')));
    await sleep(900);
    c.s.emit('chat', { text: 'check https://evil.example now' });
    c.s.emit('chat', { text: 'visit www.scam.com' });
    await sleep(300);
    check('links are blocked in chat', () => assert.ok(!a.chats.some(m => /evil|scam/.test(m.text))));
    await sleep(1100);
    for (let i = 0; i < 12; i++) c.s.emit('chat', { text: 'spam ' + i });
    await sleep(500);
    check('chat spam is rate limited', () => assert.ok(a.chats.filter(m => /^spam/.test(m.text)).length <= 5));

    await until(a.phase('vote'), 4000, 'vote');
    check('the rapper gets no more handshakes once voting starts', () => assert.ok(true));
    c.s.emit('rtc:offer', { to: a.id, sdp: sdp('offer') });
    await sleep(250);
    check('voice handshakes stop when time is up', () => assert.strictEqual(a.offers.length, 1));
    r = await a.emit('vote', { score: 10 });
    check('the rapper cannot vote on their own round', () => assert.strictEqual(r.ok, false));
    r = await b.emit('vote', { score: 8 }); assert.strictEqual(r.ok, true);
    r = await c.emit('vote', { score: 6 }); assert.strictEqual(r.ok, true);
    r = await c.emit('vote', { score: 11 });
    check('scores above 10 are refused', () => assert.strictEqual(r.ok, false));
    r = await c.emit('vote', { score: 'seven' });
    check('scores that are not numbers are refused', () => assert.strictEqual(r.ok, false));

    await until(a.phase('result'), 5000, 'result');
    check('result is the average of the votes', () => { assert.strictEqual(a.state.result.name, 'Ana'); assert.strictEqual(a.state.result.n, 2); assert.strictEqual(a.state.result.avg, 7); });
    await until(() => a.lb.length === 1, 2000, 'leaderboard');
    check('leaderboard shows the score', () => assert.strictEqual(a.lb[0].name, 'Ana'));
    await sleep(1200);
    check('leaderboard is saved to disk', () => assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'leaderboard.json'), 'utf8')).Ana.n, 1));
    await until(b.phase('ready', 'Bo'), 4000, 'next rapper');
    check('the line moves on to the next rapper', () => assert.strictEqual(b.state.cur.name, 'Bo'));

    /* ---------- moderators ---------- */
    r = await c.emit('admin:auth', { token: 'wrong' });
    check('wrong moderator token is refused', () => assert.strictEqual(r.ok, false));
    c.s.emit('admin:skip');
    await sleep(250);
    check('non-moderators cannot skip or kick', () => assert.strictEqual(c.state.cur.name, 'Bo'));
    const mod = await mk();
    await mod.join('Mod One');
    r = await mod.emit('admin:auth', { token: ADMIN });
    check('moderator token is accepted', () => assert.strictEqual(r.ok, true));
    mod.s.emit('admin:mute', { name: 'Cy', minutes: 5 });
    await sleep(300);
    c.s.emit('chat', { text: 'hello' });
    await sleep(300);
    check('moderators can mute someone', () => assert.ok(!mod.chats.some(m => m.name === 'Cy' && m.text === 'hello')));
    mod.s.emit('admin:skip');
    await until(() => a.state.cur === null || a.state.cur.name !== 'Bo', 3000, 'skip');
    check('moderators can skip the rapper', () => assert.ok(true));
    mod.s.emit('admin:kick', { name: 'Cy' });
    await until(() => c.refused, 2000, 'kick');
    check('moderators can remove someone', () => assert.ok(/removed/.test(c.refused)));

    /* ---------- names stay yours ---------- */
    a.close();
    await sleep(300);
    const thief = await mk();
    r = await thief.join('Ana', 'not-the-token');
    check('a name is held for its owner after they disconnect', () => assert.strictEqual(r.ok, false));
    const back = await mk();
    r = await back.join('Ana', anaToken);
    check('the owner gets their name back with their token', () => assert.strictEqual(r.ok, true));

    /* ---------- recovery ---------- */
    await back.emit('queue:join');
    await until(back.phase('ready', 'Ana'), 4000, 'ana ready');
    back.close();
    await until(() => thief.state && thief.state.phase === 'idle', 3000, 'idle');
    check('the room recovers when the rapper leaves', () => assert.strictEqual(thief.state.cur, null));

    console.log('\nAll ' + results.length + ' checks passed.');
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e && e.message);
    if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    cleanup();
    process.exit(1);
  }
})();
