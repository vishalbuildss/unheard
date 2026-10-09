import { hueOf, mmss, clamp } from './config.js';

/*
  The flat interface drawn over the 3D stage. Everything that came from another person
  (names, chat) is set with textContent, never as HTML.
*/
const $ = id => document.getElementById(id);

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}

export function createHud(h) {
  const refs = {
    status: $('status'), statusTxt: $('statusTxt'), count: $('count'), banner: $('banner'),
    bLab: $('bLab'), bName: $('bName'), bTime: $('bTime'), bSub: $('bSub'),
    dock: $('dockMain'), react: $('react'), chatList: $('chatList'), chatIn: $('chatIn'), chatCount: $('chatCount'),
    qList: $('qList'), qCount: $('qCount'), lbList: $('lbList'), userBtn: $('userBtn'), toast: $('toast'),
    gate: $('gate'), gateErr: $('gateErr'), uname: $('uname'), soundBtn: $('soundBtn'), qualBtn: $('qualBtn'), modBtn: $('modBtn')
  };
  const dockBox = $('dock');
  const fitDock = () => document.documentElement.style.setProperty('--dock-h', Math.ceil(dockBox.getBoundingClientRect().height) + 'px');
  if (window.ResizeObserver) new ResizeObserver(fitDock).observe(dockBox);
  fitDock();
  let dockKey = '', toastTimer = null, wantJoinAfterName = false, meterBars = [], tab = '';

  /* ---------- toast, gate, buttons ---------- */
  function toast(msg) {
    refs.toast.textContent = msg; refs.toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 3600);
  }
  function openGate(joinAfter) {
    wantJoinAfterName = !!joinAfter; refs.gateErr.textContent = ''; refs.gate.hidden = false; refs.uname.focus();
  }
  function closeGate() { refs.gate.hidden = true; wantJoinAfterName = false; }
  $('gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = refs.uname.value.trim();
    if (name.length < 2) { refs.gateErr.textContent = 'Use at least 2 characters.'; return; }
    const err = await h.join(name, wantJoinAfterName);
    if (err) refs.gateErr.textContent = err; else closeGate();
  });
  $('gateSkip').addEventListener('click', () => { h.unlock(); closeGate(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!refs.gate.hidden) closeGate(); if (!$('modPanel').hidden) $('modPanel').hidden = true; }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) h.vote(Number(e.key));
    if (e.key === 'M' && e.shiftKey && !refs.modBtn.hidden) $('modPanel').hidden = false;
  });
  refs.userBtn.addEventListener('click', () => { if (!h.hasName()) openGate(false); });
  refs.soundBtn.addEventListener('click', () => h.toggleSound());
  refs.qualBtn.addEventListener('click', () => h.toggleQuality());
  refs.react.addEventListener('click', e => { const b = e.target.closest('[data-react]'); if (b) h.react(b.dataset.react); });
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = refs.chatIn.value.trim();
    if (!v) return;
    if (h.chat(v)) refs.chatIn.value = '';
  });
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    tab = tab === b.dataset.tab ? '' : b.dataset.tab;
    document.body.dataset.panel = tab;
    $('tabs').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.tab === tab)));
  });

  /* ---------- moderator panel ---------- */
  const modPanel = $('modPanel');
  refs.modBtn.addEventListener('click', () => { modPanel.hidden = false; });
  $('modClose').addEventListener('click', () => { modPanel.hidden = true; });
  $('modClose2').addEventListener('click', () => { modPanel.hidden = true; });
  $('modForm').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await h.modLogin($('modToken').value);
    $('modToken').value = '';
    if (r.ok) { $('modForm').hidden = true; $('modTools').hidden = false; $('modErr').textContent = ''; }
    else $('modErr').textContent = r.error || 'Could not log in.';
  });
  $('modSkip').addEventListener('click', () => h.modAction('admin:skip', {}));
  function renderModUsers(list) {
    const ul = $('modUsers'); ul.replaceChildren();
    for (const u of list) {
      ul.append(el('li', null,
        el('span', { class: 'nm', text: u.name + (u.muted ? ' (muted)' : '') }),
        el('button', { type: 'button', text: 'Mute 10m', onclick: () => h.modAction('admin:mute', { name: u.name, minutes: 10 }) }),
        el('button', { type: 'button', text: 'Remove', onclick: () => h.modAction('admin:kick', { name: u.name }) }),
        el('button', { type: 'button', text: 'Ban 1h', onclick: () => h.modAction('admin:kick', { name: u.name, ban: true }) })));
    }
  }

  /* ---------- chat ---------- */
  function addChat(name, text, kind) {
    const box = refs.chatList;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const d = el('div', { class: 'msg' + (kind === 'sys' ? ' sys' : kind === 'me' ? ' me' : '') });
    if (kind === 'sys') d.textContent = text;
    else {
      const b = el('b', { text: name });
      if (kind !== 'me') b.style.color = 'hsl(' + hueOf(name) + ' 70% 72%)';
      d.append(b, document.createTextNode(text));
    }
    box.append(d);
    while (box.children.length > 80) box.removeChild(box.firstChild);
    if (near || kind === 'me') box.scrollTop = box.scrollHeight;
  }

  /* ---------- line and leaderboard ---------- */
  function renderQueue(state, myId) {
    const rows = [];
    if (state.cur && state.phase !== 'idle') {
      rows.push(el('li', { class: 'now' + (state.cur.id === myId ? ' mine' : '') },
        el('span', { class: 'rk', text: 'NOW' }), el('span', { class: 'nm', text: state.cur.name }),
        state.cur.id === myId ? el('span', { class: 'stamp', text: 'you' }) : null));
    }
    state.queue.forEach((q, i) => rows.push(el('li', { class: q.id === myId ? 'mine' : '' },
      el('span', { class: 'rk', text: '#' + (i + 1) }), el('span', { class: 'nm', text: q.name }),
      q.id === myId ? el('span', { class: 'stamp', text: 'you' }) : null)));
    if (!rows.length) rows.push(el('li', null, el('span', { class: 'empty', text: 'Nobody in line.' })));
    refs.qList.replaceChildren(...rows);
    refs.qCount.textContent = state.queue.length + ' waiting';
  }
  function renderBoard(list, myName) {
    const rows = list.slice(0, 8).map((r, i) => el('li', { class: r.name === myName ? 'mine' : '' },
      el('span', { class: 'rk', text: String(i + 1) }),
      el('span', { class: 'nm' }, el('span', { text: r.name }), el('small', { text: r.n + (r.n === 1 ? ' round' : ' rounds') })),
      el('span', { class: 'sc', text: r.avg.toFixed(1) })));
    if (!rows.length) rows.push(el('li', null, el('span', { class: 'empty', text: 'No scores yet. Be the first on the mic.' })));
    refs.lbList.replaceChildren(...rows);
  }

  /* ---------- the dock (what you can do right now) ---------- */
  const verdictOf = a => (a >= 8.5 ? 'Unheard no more' : a >= 7 ? 'Fire' : a >= 5 ? 'Solid round' : 'Keep grinding');
  const approx = s => (s < 60 ? '~' + Math.max(5, Math.round(s / 5) * 5) + ' sec' : '~' + Math.round(s / 60) + ' min');
  const voiceText = { idle: '', connecting: 'Voice: connecting', live: 'Voice: live', bad: 'Voice: not connected', full: 'Voice: room is full', tap: 'Voice: tap anywhere to hear' };

  function buildDock(v) {
    const { state: st, myId, pos, myVote, voice, joining, hasName, muted } = v;
    const iAmRapper = st.cur && st.cur.id === myId;
    const out = [];
    const joinBtn = () => el('button', { type: 'button', class: 'btn fit', id: 'joinBtn', text: joining ? 'Opening the mic…' : 'Join the line', disabled: joining || null, onclick: () => h.joinLine() });
    if (st.phase === 'ready' && iAmRapper) {
      out.push(el('p', { class: 'dock-msg' }, el('b', { text: 'You are up. ' }), 'Headphones on. Your mic opens when the clock hits zero.'));
    } else if (st.phase === 'perform' && iAmRapper) {
      meterBars = Array.from({ length: 14 }, () => el('i'));
      out.push(el('div', { class: 'dock-line' }, el('div', { class: 'meter', 'aria-hidden': 'true' }, ...meterBars),
        el('p', { class: 'dock-msg' }, el('b', { text: 'You are live. ' }), 'Your mic shuts by itself at 0:00.'),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Finish early', onclick: () => h.finish() })));
    } else if (st.phase === 'vote' && iAmRapper) {
      out.push(el('p', { class: 'dock-msg' }, el('b', { text: 'Votes are coming in. ' }), 'You cannot vote on your own round.'));
    } else if (st.phase === 'vote') {
      const pad = el('div', { class: 'votes', role: 'group', 'aria-label': 'Vote out of 10' });
      for (let i = 0; i <= 10; i++) pad.append(el('button', { type: 'button', 'aria-pressed': String(myVote === i), text: String(i), onclick: () => h.vote(i) }));
      out.push(el('p', { class: 'dock-msg' }, el('b', { text: 'Rate ' + st.cur.name + ' out of 10. ' }), myVote != null ? 'You gave ' + myVote + '. Tap another number to change it.' : 'Tap a number, or press 0 to 9.'), pad);
    } else if (st.phase === 'result') {
      const r = st.result;
      out.push(el('div', { class: 'dock-line' },
        r && r.avg != null ? el('div', { class: 'verdict' + (r.avg < 5 ? ' low' : '') }, verdictOf(r.avg), el('small', { text: r.avg.toFixed(1) + ' / 10 from ' + r.n + (r.n === 1 ? ' vote' : ' votes') })) : el('div', { class: 'verdict low', text: 'No votes' }),
        st.queue.length ? el('p', { class: 'dock-msg dim' }, 'Next up: ' + st.queue[0].name) : null));
    } else if (pos > 0) {
      const wait = v.waitSeconds;
      out.push(el('div', { class: 'dock-line' }, el('p', { class: 'dock-msg' }, el('b', { text: 'You are #' + pos + ' in line. ' }), pos === 1 ? 'You are next. Headphones on.' : 'Your mic opens in ' + approx(wait) + '.'),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Leave the line', onclick: () => h.leaveLine() })));
    } else {
      const msg = st.phase === 'idle' ? 'The stage is empty. Join the line to take the mic.'
        : st.phase === 'perform' ? 'Listening to ' + st.cur.name + '. Voting opens when the 60 seconds are up.'
          : 'Join the line. Everyone gets 60 seconds on the mic, then the room votes.';
      out.push(el('div', { class: 'dock-line' }, joinBtn(), el('p', { class: 'dock-msg dim', text: hasName ? msg : 'Pick a name first. ' + msg })));
    }
    if (st.phase === 'perform' && !iAmRapper && voice !== 'idle') {
      out.push(el('span', { class: 'voice', id: 'voiceTag', 'data-s': voice === 'live' ? 'live' : voice === 'bad' || voice === 'full' ? 'bad' : '', text: muted ? 'Sound is off' : voiceText[voice] }));
    }
    refs.dock.replaceChildren(...out);
  }

  /* ---------- per tick ---------- */
  function render(v) {
    const { state: st, serverNow, myId } = v;
    const ph = st.phase;
    document.body.dataset.phase = ph;
    refs.status.dataset.phase = ph;
    refs.statusTxt.textContent = { ready: 'Get ready', perform: 'On the mic', vote: 'Vote now', result: 'Result', idle: 'Stage open' }[ph];
    refs.bLab.textContent = ph === 'ready' ? 'Up now' : ph === 'perform' ? 'On the mic' : ph === 'vote' || ph === 'result' ? 'Just performed' : 'Stage open';
    refs.bName.textContent = st.cur ? st.cur.name : 'Nobody yet';
    const left = (st.phaseEnd - serverNow) / 1000;
    let time, sub;
    if (ph === 'ready') { time = String(Math.max(1, Math.ceil(left))); sub = 'Mic opens'; }
    else if (ph === 'perform') { time = mmss(left); sub = 'Bar ' + clamp(Math.floor((1 - left / st.durations.perform) * 16) + 1, 1, 16) + ' of 16'; }
    else if (ph === 'vote') { time = mmss(left); sub = st.votesIn + (st.votesIn === 1 ? ' vote in' : ' votes in'); }
    else if (ph === 'result') { const r = st.result; time = r && r.avg != null ? r.avg.toFixed(1) : '--'; sub = r && r.avg != null ? '/ 10 from ' + r.n + (r.n === 1 ? ' vote' : ' votes') : 'No votes'; }
    else { time = '1:00'; sub = '16 bars · one mic'; }
    if (refs.bTime.textContent !== time) refs.bTime.textContent = time;
    if (refs.bSub.textContent !== sub) refs.bSub.textContent = sub;

    const key = [ph, st.cur && st.cur.id, st.round, v.myVote, v.pos, v.voice, v.joining, v.hasName, v.muted, st.result && st.result.avg, st.queue[0] && st.queue[0].id, ph === 'vote' ? '' : Math.floor(v.waitSeconds / 15)].join('|');
    if (key !== dockKey) { dockKey = key; buildDock(v); }
    if (meterBars.length && ph === 'perform') {
      const lv = v.micLevel;
      meterBars.forEach((b, i) => { b.style.transform = 'scaleY(' + clamp(0.08 + lv * (0.6 + 0.4 * Math.sin(i * 1.7 + performance.now() / 120)), 0.06, 1).toFixed(2) + ')'; });
    }
  }

  return {
    toast, openGate, closeGate, addChat, render, renderQueue, renderBoard, renderModUsers,
    setUser(name) { refs.userBtn.textContent = name ? '@' + name : 'Pick a name'; },
    setCount(text) { refs.count.textContent = text; refs.chatCount.textContent = ''; },
    setSound(on) { refs.soundBtn.setAttribute('aria-pressed', String(on)); refs.soundBtn.textContent = on ? 'Sound on' : 'Sound off'; },
    setQuality(q) { refs.qualBtn.textContent = 'Quality: ' + q; refs.qualBtn.setAttribute('aria-pressed', String(q === 'high')); },
    showMod() { refs.modBtn.hidden = false; },
    forceDock() { dockKey = ''; },
    noWebgl() { $('noWebgl').hidden = false; refs.qualBtn.hidden = true; }
  };
}
