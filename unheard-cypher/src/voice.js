import { getCtx, unlockAudio, makeAnalyser, readBands, readLevel } from './audio.js';

/*
  Voice. Everyone who is listening opens one encrypted WebRTC connection to the rapper on the mic.
  The rapper's microphone is only switched on during their 60 seconds, and the server only
  passes the handshake between the rapper and listeners who asked for it.
*/
export function createVoice({ net, onStatus }) {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let stream = null, track = null, micAnalyser = null, micSrc = null;
  let key = null;                 // "<rapper id>:<round>" for the connection set we are in
  let listenerPc = null, rapperId = null, remoteDescSet = false;
  let pendingIce = [];
  const peers = new Map();        // rapper side: listener id -> { pc, pending, ready }
  let remoteEl = null, remoteAnalyser = null, remoteSrc = null;
  let muted = false;
  let status = 'idle';
  const bandsOut = new Float32Array(64);

  const setStatus = s => { if (s !== status) { status = s; onStatus(s); } };

  /* ---------- microphone (only for the rapper) ---------- */
  async function prepareMic() {
    if (track && track.readyState === 'live') return { ok: true };
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, error: 'The microphone only works on a secure (https) page.' };
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
        video: false
      });
    } catch (e) {
      const m = e && e.name === 'NotAllowedError' ? 'The microphone is blocked. Allow it in your browser\'s site settings, then try again.'
        : e && e.name === 'NotFoundError' ? 'No microphone found on this device.'
          : 'Could not open the microphone.';
      return { ok: false, error: m };
    }
    track = stream.getAudioTracks()[0];
    track.enabled = false; // closed until your turn
    const ctx = unlockAudio();
    if (ctx) {
      micSrc = ctx.createMediaStreamSource(stream);
      micAnalyser = makeAnalyser(ctx);
      micSrc.connect(micAnalyser); // measuring only, never played back
    }
    return { ok: true };
  }
  function releaseMic() {
    if (!stream) return;
    stream.getTracks().forEach(t => t.stop());
    try { if (micSrc) micSrc.disconnect(); } catch (_) { /* already gone */ }
    stream = track = micAnalyser = micSrc = null;
  }

  /* ---------- connections ---------- */
  const iceTo = (to) => e => { if (e.candidate) net.socket.emit('rtc:ice', { to, candidate: e.candidate.toJSON() }); };

  async function listen(id) {
    const pc = new RTCPeerConnection({ iceServers });
    listenerPc = pc; rapperId = id; remoteDescSet = false; pendingIce = [];
    setStatus('connecting');
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = iceTo(id);
    pc.ontrack = e => attachRemote(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc !== listenerPc) return;
      if (pc.connectionState === 'connected') setStatus('live');
      else if (pc.connectionState === 'failed') setStatus('bad');
      else if (pc.connectionState === 'connecting') setStatus('connecting');
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    net.socket.emit('rtc:offer', { to: id, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  }

  function attachRemote(ms) {
    detachRemote();
    remoteEl = new Audio();
    remoteEl.srcObject = ms; remoteEl.autoplay = true; remoteEl.muted = muted;
    remoteEl.play().catch(() => setStatus('tap'));
    const ctx = getCtx();
    if (ctx) {
      try {
        remoteSrc = ctx.createMediaStreamSource(ms);
        remoteAnalyser = makeAnalyser(ctx);
        remoteSrc.connect(remoteAnalyser); // for the light show; the sound itself plays from remoteEl
      } catch (_) { /* analyser is optional */ }
    }
  }
  function detachRemote() {
    if (remoteEl) { remoteEl.pause(); remoteEl.srcObject = null; remoteEl = null; }
    try { if (remoteSrc) remoteSrc.disconnect(); } catch (_) { /* already gone */ }
    remoteSrc = remoteAnalyser = null;
  }

  async function answerOffer(from, sdp) {
    if (!track || track.readyState !== 'live') return;
    closePeer(from);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, pending: [], ready: false };
    peers.set(from, peer);
    pc.onicecandidate = iceTo(from);
    pc.addTrack(track, stream);
    await pc.setRemoteDescription(sdp);
    peer.ready = true;
    for (const c of peer.pending) pc.addIceCandidate(c).catch(() => {});
    peer.pending = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    net.socket.emit('rtc:answer', { to: from, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  }
  function closePeer(id) {
    const p = peers.get(id);
    if (p) { p.pc.close(); peers.delete(id); }
  }

  function closeAll() {
    if (listenerPc) { listenerPc.close(); listenerPc = null; }
    for (const id of [...peers.keys()]) closePeer(id);
    detachRemote();
    rapperId = null; pendingIce = []; remoteDescSet = false;
    key = null;
    setStatus('idle');
  }

  net.socket.on('rtc:answer', async ({ from, sdp }) => {
    if (!listenerPc || from !== rapperId) return;
    try {
      await listenerPc.setRemoteDescription(sdp);
      remoteDescSet = true;
      for (const c of pendingIce) listenerPc.addIceCandidate(c).catch(() => {});
      pendingIce = [];
    } catch (_) { setStatus('bad'); }
  });
  net.socket.on('rtc:offer', ({ from, sdp }) => { answerOffer(from, sdp).catch(() => {}); });
  net.socket.on('rtc:ice', ({ from, candidate }) => {
    if (!candidate) return;
    if (listenerPc && from === rapperId) {
      if (remoteDescSet) listenerPc.addIceCandidate(candidate).catch(() => {}); else pendingIce.push(candidate);
      return;
    }
    const p = peers.get(from);
    if (!p) return;
    if (p.ready) p.pc.addIceCandidate(candidate).catch(() => {}); else p.pending.push(candidate);
  });
  net.socket.on('rtc:full', () => setStatus('full'));
  net.socket.on('hello', h => { if (h && Array.isArray(h.iceServers)) iceServers = h.iceServers; });

  /* ---------- follow the room ---------- */
  function onState(st, myId) {
    const active = !!st.cur && (st.phase === 'ready' || st.phase === 'perform');
    const k = active ? st.cur.id + ':' + st.round : null;
    if (k !== key) {
      closeAll();
      key = k;
      if (track) track.enabled = false;
    }
    if (!active) return;
    if (st.cur.id === myId) {
      if (track) track.enabled = st.phase === 'perform';
      if (!track) setStatus('bad');
      else setStatus(st.phase === 'perform' ? 'live' : 'connecting');
    } else if (!listenerPc && status !== 'full') {
      listen(st.cur.id).catch(() => setStatus('bad'));
    }
  }

  return {
    prepareMic, releaseMic, onState, closeAll,
    hasMic: () => !!track && track.readyState === 'live',
    setMuted(m) { muted = m; if (remoteEl) remoteEl.muted = m; },
    retryPlay() { if (remoteEl) remoteEl.play().then(() => setStatus('live')).catch(() => {}); },
    micLevel: () => readLevel(micAnalyser),
    bands(n) {
      const a = remoteAnalyser || (track && track.enabled ? micAnalyser : null);
      return a ? readBands(a, n, bandsOut) : null;
    },
    status: () => status
  };
}
