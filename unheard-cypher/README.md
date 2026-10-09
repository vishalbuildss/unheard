# Unheard Cypher

Online hip-hop cypher. Ek mic, ek rapper, line me sab ka number, 60 seconds ka spit, phir 10 seconds ka vote (0 se 10), leaderboard aur live chat. Poora 3D underpass me chalta hai: sab log ring me avatar bankar khade hote hain, rapper podium pe aata hai.

Isme koi bot ya fake user nahi hai. Jo dikhta hai wo asli log hain.

## Chalane ka tarika

Node.js 18 ya naya chahiye.

```bash
npm install
npm start
```

Browser me `http://localhost:3000` kholo. Akele test karne ke liye do window kholo (ek normal, ek private). Ek me "Join the line" dabao, doosri me suno aur vote karo.

- Mic sirf `localhost` ya `https` pe chalta hai. Phone pe test karna ho to https tunnel (jaise Cloudflare Tunnel ya ngrok) use karo.
- Code badalne ke baad `npm run build` chalao. `src/` ka sab kuch `public/app.js` me bundle hota hai. `npm run dev` build karke server chalata hai.

## Kya kya hai

- **Line:** username daalo, "Join the line" dabao. Mic ki permission tabhi maangi jaati hai.
- **Mic sirf rapper ke paas:** baaki sab ka mic hota hi nahi. Rapper ka mic sirf uske 60 seconds me khulta hai.
- **60 seconds, phir 10 seconds vote.** Timer server pe chalta hai, browser pe nahi, isliye cheat nahi ho sakta.
- **Vote 0 se 10.** Rapper khud ko vote nahi de sakta. Ek banda ek hi vote de sakta hai (production me ek network address pe ek vote).
- **3D stage:** floor ki lights 60 seconds ginti hain, vote aate hi dots jalte hain, podium ke bars asli awaaz ke saath hilte hain. Drag karke ghoom sakte ho.
- **Leaderboard** `data/leaderboard.json` me save hota hai.
- **Chat, reactions (Fire, Bars, 100, Wow), beat, moderator tools.**
- Phone pe panels (Line, Board, Chat) neeche ke tabs me hain.

## Security

| Kya | Kaise |
| --- | --- |
| Script injection (XSS) | Strict Content Security Policy: sirf apni files chalti hain, koi inline script nahi. Naam aur chat hamesha plain text ki tarah dikhte hain. |
| Doosri website se connection | Live connection ka Origin check hota hai. Sirf apni site (ya `ALLOWED_ORIGINS`) connect kar sakti hai. |
| Spam aur flood | Har event pe rate limit. Zyada spam karne wala disconnect ho jata hai. Ek address se limited connections. |
| Mic ka darwaza | Server sirf rapper aur uske listeners ke beech voice handshake pass karta hai. Koi doosra kisi ko audio nahi bhej sakta. Voice WebRTC se encrypted jati hai. |
| Naam churana | Lookalike naam (`Ana`, `A.na`) block. Disconnect ke baad naam 60 seconds tak sirf asli malik ke token se wapas milta hai. |
| Gandi cheezein | Naam me `__proto__` jaise naam block. Chat me links block. Aap `blocklist.txt` me apne words daal sakte ho. |
| Invisible aur bidi characters | Naam aur chat se hata diye jaate hain. |
| Moderators | `ADMIN_TOKEN` se login (timing-safe check, galat token pe lock). Mute, remove, ban, skip. |
| Headers | CSP, `nosniff`, no-referrer, frame block, Permissions-Policy. `HTTPS_ONLY=true` pe HSTS bhi. |
| Data | IP address kahin save nahi hota. Sirf ek random-salt wala hash memory me rehta hai. Leaderboard me sirf naam aur score. |

`npm test` me 39 checks hain jo ye sab asli server pe chalate hain.

**Seemayein (seedhi baat):**
- Voice peer-to-peer hai, to rapper ki uplink pe load padta hai. Default me ek rapper ko ek saath 25 log sun sakte hain (`MAX_AUDIO_LISTENERS`). Isse upar jaana ho to LiveKit jaisa media server lagao. Wo server-side pe bhi mic block kar sakta hai.
- Naam account nahi hai. Koi bhi naam le sakta hai jo free ho. Leaderboard naam se chalta hai.
- Ek hi server (ek instance) pe chalta hai. Kai servers chalane ho to Redis aur database lagana padega.
- Network address se vote limit karne pe ek hi wifi ke sab log (hostel, office) ek vote ginenge.

## Moderator

1. `ADMIN_TOKEN` set karo (lambi random string): `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
2. Page pe upar "Mod" button dikhega (ya `Shift+M`). Token daalo.
3. Rapper skip, kisi ko 10 minute mute, remove ya 1 ghante ke liye ban kar sakte ho.

## Apni beat

`public/beats/` me mp3, ogg, wav ya m4a daalo. Har rapper ke liye server ek random beat chunta hai aur sab ke liye ek hi time pe shuru karta hai. Folder khali ho to built-in drum loop bajta hai.

Beat 64 BPM pe 60 seconds ki loop ho to sabse achha lagta hai (16 bars). Beats royalty-free ya apni banayi hui rakho, copyright claim se bachne ke liye. BPM badalna ho to `src/config.js` me `BPM` badlo.

## Deploy

Node chalane wali koi bhi jagah chalegi (Render, Railway, Fly.io, VPS, Docker). Zaroori baatein:

1. **HTTPS zaroori hai**, warna mic nahi chalega. Kai platform ye apne aap dete hain.
2. Environment variables (`.env.example` dekho): `NODE_ENV=production`, `HTTPS_ONLY=true`, `TRUST_PROXY=true` (agar proxy ke peeche ho), `ADMIN_TOKEN=...`.
3. **WebSocket** chalna chahiye. Nginx me `Upgrade` headers pass karo. Caddy me kuch nahi karna padta.
4. Kuch networks (college wifi, mobile data) peer-to-peer voice rok dete hain. Public launch se pehle ek TURN server lagao (`TURN_URL`, `TURN_USER`, `TURN_PASS`).
5. Docker: `docker build -t unheard-cypher .` aur `docker run -p 3000:3000 --env-file .env unheard-cypher`. Leaderboard ke liye `data/` ko volume me rakho.

Caddy ka chhota example:

```
cypher.example.com {
  reverse_proxy localhost:3000
}
```

## Folder

```
server.js          queue, timers, votes, chat, voice handshake, security
lib/security.js    rate limit, naam aur chat safai, blocklist, shape checks
src/               browser ka code (3D scene, interface, voice, beat)
public/            index.html, style.css, fonts, beats, aur bana hua app.js
scripts/build.js   fonts copy karta hai aur src/ ko public/app.js me bundle karta hai
test/smoke.js      server ke 39 checks
```

Sab kuch (fonts, three.js, socket.io) apne server se aata hai. Page koi bahari site ko request nahi bhejta.
