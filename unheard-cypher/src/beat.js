import { BEAT } from './config.js';
import { getCtx, unlockAudio, makeAnalyser, readBands } from './audio.js';

/*
  The beat. If the server picked a file from public/beats it plays that, otherwise a built-in
  drum loop plays. Both start from the server's clock, so everyone hears it at about the same time.
*/
export function createBeat(serverNow) {
  let master = null, analyser = null, noiseBuf = null;
  let enabled = true;
  let want = null;            // { key, file, start }
  let timer = null, nextK = 0;
  let el = null, elNode = null, elFile = null, fileOk = false;
  const bandsOut = new Float32Array(64);
  const STEP = BEAT / 4;

  function ensure() {
    const ctx = unlockAudio();
    if (!ctx) return null;
    if (!master) {
      master = ctx.createGain(); master.gain.value = 0.55;
      analyser = makeAnalyser(ctx);
      master.connect(analyser); analyser.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return ctx;
  }

  /* synth drums */
  const at = (ctx, serverMs) => ctx.currentTime + (serverMs - serverNow()) / 1000;
  function kick(ctx, t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.34);
  }
  function noise(ctx, t, dur, type, freq, vol) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
  }
  function snare(ctx, t) {
    noise(ctx, t, 0.2, 'bandpass', 1800, 0.7);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.1);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.16);
  }
  function schedule() {
    const ctx = getCtx();
    if (!ctx || !want || !enabled || (elFile && fileOk)) return;
    if (nextK < 0) nextK = Math.max(0, Math.ceil((serverNow() - want.start) / (STEP * 1000)));
    for (let guard = 0; guard < 40; guard++) {
      const t = at(ctx, want.start + nextK * STEP * 1000);
      if (t > ctx.currentTime + 0.15) break;
      if (t > ctx.currentTime - 0.02) {
        const s = nextK % 16;
        if (s === 0 || s === 7 || s === 10) kick(ctx, t);
        if (s === 4 || s === 12) snare(ctx, t);
        if (s % 2 === 0) noise(ctx, t, s === 14 ? 0.18 : 0.05, 'highpass', 7000, s === 14 ? 0.25 : 0.2);
      }
      nextK++;
    }
  }

  /* file beats */
  function playFile(ctx) {
    if (!want.file) return;
    if (!el || elFile !== want.file) {
      if (el) el.pause();
      el = new Audio('beats/' + encodeURIComponent(want.file));
      elFile = want.file; fileOk = false;
      el.loop = true; el.preload = 'auto';
      elNode = ctx.createMediaElementSource(el);
      elNode.connect(master);
      el.addEventListener('error', () => { fileOk = false; });
    }
    const go = () => {
      const dur = el.duration || 0;
      if (dur) el.currentTime = (Math.max(0, serverNow() - want.start) / 1000) % dur;
      el.play().then(() => { fileOk = true; }).catch(() => { fileOk = false; });
    };
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
  }

  function begin() {
    const ctx = ensure();
    if (!ctx || !want || !enabled) return;
    nextK = -1;
    playFile(ctx);
    clearInterval(timer);
    timer = setInterval(schedule, 25);
  }
  function halt() {
    clearInterval(timer); timer = null;
    if (el) el.pause();
  }

  return {
    /* call with the same key repeatedly; it only restarts when the key changes */
    start(key, file, startMs) {
      if (want && want.key === key) return;
      halt();
      want = { key, file, start: startMs };
      begin();
    },
    stop() { want = null; halt(); },
    setEnabled(on) {
      enabled = on;
      if (!on) halt(); else begin();
    },
    phase() {
      if (!want) return -1;
      return (((serverNow() - want.start) / 1000) % BEAT + BEAT) % BEAT / BEAT;
    },
    bands(n) { return want && enabled && analyser ? readBands(analyser, n, bandsOut) : null; },
    active: () => !!want && enabled
  };
}
