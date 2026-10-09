// Shared constants and tiny helpers.
export const BPM = 64;                 // 16 bars of 4 beats at 64 BPM is exactly 60 seconds
export const BEAT = 60 / BPM;
export const BARS = 16;
export const REACTIONS = ['fire', 'bars', '100', 'wow'];

export function hueOf(name) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
export function initials(name) {
  const w = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const mmss = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch (_) { /* private mode */ } }
};
