// One shared audio context, unlocked by the first tap, plus helpers to read levels from it.
let ctx = null;
export function unlockAudio() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const getCtx = () => ctx;

export function makeAnalyser(c) {
  const a = c.createAnalyser();
  a.fftSize = 512;
  a.smoothingTimeConstant = 0.7;
  return a;
}
const freq = new Uint8Array(256);
const wave = new Uint8Array(512);
/* n bands from about 90 Hz to 7 kHz, spaced like hearing, values 0..1 */
export function readBands(analyser, n, out) {
  if (!analyser) return null;
  analyser.getByteFrequencyData(freq);
  const lo = 1, hi = 80;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(lo * Math.pow(hi / lo, i / n));
    const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / n)));
    let s = 0;
    for (let k = a; k < b; k++) s += freq[k];
    out[i] = Math.min(1, (s / (b - a) / 255) * 1.5);
  }
  return out;
}
export function readLevel(analyser) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(wave);
  let s = 0;
  for (let i = 0; i < wave.length; i++) { const v = (wave[i] - 128) / 128; s += v * v; }
  return Math.min(1, Math.sqrt(s / wave.length) * 5);
}
