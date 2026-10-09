import { createNet } from './net.js';
import { createHud } from './hud.js';
import { createScene } from './scene.js';
import { createVoice } from './voice.js';
import { createBeat } from './beat.js';
import { unlockAudio } from './audio.js';
import { store } from './config.js';

const net = createNet();
const socket = net.socket;
const S = {
  state: { serverTime: Date.now(), phase: 'idle', round: 0, phaseStart: Date.now(), phaseEnd: Date.now(), durations: { ready: 3, perform: 60, vote: 10, result: 6 }, cur: null, queue: [], votesIn: 0, result: null, beat: null },
  roster: { list: [], watching: 0 }, lb: [], me: null, myVote: null, round: -1, joining: false, sound: true, voice: 'idle', lastResultRound: -1, admin: false
};
const myId = () => socket.id || null;
const myName = () => S.me;

const beat = createBeat(net.serverNow);
const voice = createVoice({ net, onStatus: s => { S.voice = s; } });

/* ---------- 3D stage ---------- */
const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let scene = null;
try {
  scene = createScene(document.getElementById('world'), {
    serverNow: net.serverNow, reduced,
    quality: coarse || (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high'
  });
} catch (e) { console.error('3D stage failed:', e); scene = null; }

/* ---------- interface ---------- */
const hud = createHud({
  hasName: () => !!S.me,
  unlock: () => unlockAudio(),
  async join(name, thenLine) {
    unlockAudio();
    const r = await net.emit('join', { name, token: store.get('uc-token') || undefined });
    if (!r || !r.ok) return (r && r.error) || 'Could not join.';
    S.me = r.name; store.set('uc-name', r.name); store.set('uc-token', r.token);
    hud.setUser(r.name); scene && scene.setRoster(S.roster.list, S.roster.watching, myId());
    hud.forceDock();
    if (thenLine) joinLine();
    return null;
  },
  async joinLine() { return joinLine(); },
  async leaveLine() {
    await net.emit('queue:leave');
    if (!(S.state.cur && S.state.cur.id === myId())) voice.releaseMic();
  },
  finish: () => socket.emit('finish'),
  vote(n) {
    if (S.state.phase !== 'vote' || !S.state.cur || S.state.cur.id === myId()) return;
    S.myVote = n; hud.forceDock();
    net.emit('vote', { score: n });
  },
  chat(text) {
    if (!S.me) { hud.openGate(false); return false; }
    socket.emit('chat', { text }); return true;
  },
  react: kind => socket.emit('react', kind),
  toggleSound() {
    S.sound = !S.sound; hud.setSound(S.sound); beat.setEnabled(S.sound); voice.setMuted(!S.sound); hud.forceDock();
    if (S.sound) { unlockAudio(); voice.retryPlay(); }
  },
  toggleQuality() {
    if (!scene) return;
    const q = scene.quality() === 'high' ? 'low' : 'high';
    scene.setQuality(q); hud.setQuality(q);
  },
  async modLogin(token) {
    const r = await net.emit('admin:auth', { token });
    return r || { ok: false };
  },
  modAction: (ev, data) => socket.emit(ev, data)
});

async function joinLine() {
  if (!S.me) { hud.openGate(true); return; }
  if (S.joining) return;
  unlockAudio();
  S.joining = true; hud.forceDock();
  const m = await voice.prepareMic();
  if (!m.ok) { S.joining = false; hud.forceDock(); hud.toast(m.error); return; }
  const r = await net.emit('queue:join');
  S.joining = false; hud.forceDock();
  if (!r || !r.ok) { hud.toast((r && r.error) || 'Could not join the line.'); voice.releaseMic(); return; }
  hud.toast('You are in the line. Keep this tab open.');
}

if (scene) {
  hud.setQuality(scene.quality());
  scene.setAudio(n => voice.bands(n) || beat.bands(n), () => beat.phase());
  scene.onAutoLow(() => { hud.setQuality('low'); hud.toast('Switched to low quality so it runs smoothly.'); });
} else { hud.noWebgl(); }

/* ---------- from the server ---------- */
socket.on('hello', h => {
  if (h.adminEnabled) hud.showMod();
});
socket.on('connect', async () => {
  const name = store.get('uc-name'), token = store.get('uc-token');
  if (name && token) {
    const r = await net.emit('join', { name, token });
    if (r && r.ok) { S.me = r.name; store.set('uc-token', r.token); hud.setUser(r.name); }
    else { store.del('uc-name'); store.del('uc-token'); S.me = null; hud.setUser(null); hud.openGate(false); }
  } else if (!S.me) hud.openGate(false);
  scene && scene.setRoster(S.roster.list, S.roster.watching, myId());
});
socket.on('disconnect', () => { hud.toast('Connection lost. Reconnecting…'); voice.closeAll(); beat.stop(); });
socket.on('refused', msg => { hud.toast(msg); });

socket.on('state', st => {
  net.sync(st.serverTime);
  const prev = S.state;
  S.state = st;
  if (st.round !== S.round) { S.round = st.round; S.myVote = null; }
  voice.onState(st, myId());
  /* the beat plays for the rapper's 60 seconds only */
  if (st.phase === 'perform') beat.start(st.round, st.beat, st.phaseStart); else beat.stop();
  /* switch the microphone off as soon as it is no longer needed */
  const onMic = st.cur && st.cur.id === myId() && (st.phase === 'ready' || st.phase === 'perform');
  const mine = onMic || st.queue.some(q => q.id === myId());
  if (!mine && !S.joining) voice.releaseMic();
  if (st.phase === 'result' && S.lastResultRound !== st.round) {
    S.lastResultRound = st.round;
    scene && scene.celebrate(st.result ? st.result.avg : null);
  }
  scene && scene.setState(st);
  hud.renderQueue(st, myId());
  if (prev.queue.length !== st.queue.length) hud.forceDock();
});
socket.on('roster', r => {
  S.roster = r;
  hud.setCount(r.list.length + ' in the room · ' + r.watching + ' watching');
  scene && scene.setRoster(r.list, r.watching, myId());
});
socket.on('lb', l => { S.lb = l; hud.renderBoard(l, S.me); });
socket.on('chat', m => hud.addChat(m.name, m.text, m.name === S.me ? 'me' : 'other'));
socket.on('sys', t => hud.addChat('', t, 'sys'));
socket.on('react', kind => scene && scene.react(kind));
socket.on('admin:users', list => hud.renderModUsers(list));

/* ---------- clock ---------- */
function waitSeconds() {
  const st = S.state, pos = st.queue.findIndex(q => q.id === myId()) + 1;
  if (pos <= 0) return 0;
  const d = st.durations, turn = d.ready + d.perform + d.vote + d.result;
  const left = st.phase === 'idle' ? 0 : Math.max(0, (st.phaseEnd - net.serverNow()) / 1000) + (st.phase === 'ready' ? d.perform + d.vote + d.result : st.phase === 'perform' ? d.vote + d.result : st.phase === 'vote' ? d.result : 0);
  return left + (pos - 1) * turn;
}
setInterval(() => {
  const st = S.state;
  hud.render({
    state: st, serverNow: net.serverNow(), myId: myId(), myVote: S.myVote,
    pos: st.queue.findIndex(q => q.id === myId()) + 1, voice: S.voice, joining: S.joining,
    hasName: !!S.me, muted: !S.sound, waitSeconds: waitSeconds(), micLevel: voice.micLevel()
  });
}, 100);
hud.setSound(true);
document.addEventListener('pointerdown', () => { if (S.sound && S.voice === 'tap') voice.retryPlay(); }, { passive: true });
