'use strict';
/*
  Small security helpers used by server.js:
  rate limiting, name and chat cleaning, a word blocklist, safe comparison and
  strict shape checks for the WebRTC handshake messages.
*/
const crypto = require('crypto');
const fs = require('fs');

/* ---------- names ---------- */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{1,15}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'system', 'server', 'unheard', 'unheardcypher',
  'staff', 'everyone', 'nobody', 'null', 'undefined', 'you', 'host', 'support'
]);
const UNSAFE_KEYS = /(__proto__|prototype|constructor|hasownproperty|tostring|valueof)/i;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

/* "Gully_Flow", "gully flow" and "GullyFlow" all become the same key, so nobody can pose as someone else. */
function skeleton(name) {
  return String(name).toLowerCase().replace(/[0134578@$]/g, c => LEET[c] || c).replace(/[^a-z0-9]/g, '');
}

/* ---------- blocklist ---------- */
function loadBlocklist(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#') && l.length >= 3);
  } catch (_) { return []; }
}
function makeModeration(blocklist) {
  const words = blocklist.map(w => skeleton(w)).filter(Boolean);
  const hit = text => { const s = skeleton(text); return words.some(w => s.includes(w)); };
  return {
    size: words.length,
    nameError(name) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return 'Use 2 to 16 letters or numbers (space, dot, dash and underscore are fine in the middle).';
      if (UNSAFE_KEYS.test(name)) return 'That name is not allowed.';
      const sk = skeleton(name);
      if (sk.length < 2 || RESERVED.has(sk) || RESERVED.has(name.toLowerCase())) return 'That name is not allowed.';
      if (hit(name)) return 'That name is not allowed.';
      return null;
    },
    maskText(text) {
      if (!words.length) return text;
      return text.split(/(\s+)/).map(part => (part.trim() && hit(part) ? '***' : part)).join('');
    }
  };
}

/* ---------- text ---------- */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|in|co|me|gg|ly|xyz|app|link|tk|ru|cn|top|click)\b)/i;
function cleanText(text, max) {
  return String(text == null ? '' : text).normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const hasLink = text => LINK.test(text);

/* ---------- rate limiting (token bucket) ---------- */
function take(store, key, capacity, perSecond) {
  const now = Date.now();
  let b = store[key];
  if (!b) b = store[key] = { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ---------- comparison and hashing ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const newToken = () => crypto.randomBytes(18).toString('base64url');

/* ---------- WebRTC handshake shape checks ---------- */
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
function validDesc(d) {
  return !!d && typeof d === 'object' && (d.type === 'offer' || d.type === 'answer') && isStr(d.sdp, 20000);
}
function validCandidate(c) {
  if (c === null) return true;
  if (!c || typeof c !== 'object') return false;
  if (!isStr(c.candidate, 2000)) return false;
  if (c.sdpMid != null && !isStr(c.sdpMid, 100)) return false;
  if (c.sdpMLineIndex != null && !Number.isInteger(c.sdpMLineIndex)) return false;
  if (c.usernameFragment != null && !isStr(c.usernameFragment, 100)) return false;
  return true;
}

module.exports = {
  NAME_RE, skeleton, loadBlocklist, makeModeration,
  cleanText, hasLink, take, safeEqual, newToken, validDesc, validCandidate, isStr
};
