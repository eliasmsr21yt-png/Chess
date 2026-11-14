// Schach-Server: liefert die App aus und verbindet Spieler (Socket.IO)
const http = require('http'), fs = require('fs'), path = require('path');
const { Server } = require('socket.io');

const FILES = {
  'index.html': 'text/html; charset=utf-8',
  'config.js': 'text/javascript; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png'
};

const web = http.createServer((req, res) => {
  let p = '';
  try { p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html'; } catch (e) {}
  if (p === 'health') { res.writeHead(200); return res.end('ok'); }
  if (!FILES[p]) { res.writeHead(404); return res.end('Nicht gefunden'); }
  fs.readFile(path.join(__dirname, p), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': FILES[p], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const io = new Server(web, { cors: { origin: '*' } });
const rooms = new Map();   // Code -> { code, kind, w, b }  (Socket-IDs)
let queue = [];            // Wartende Spieler: { id, elo }

const num = v => Math.min(3000, Math.max(100, Math.round(+v) || 1200));
const sock = id => io.sockets.sockets.get(id);
const code6 = () => { let c; do { c = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(c)); return c; };

// ---- Konten (Datei oder dauerhaft über Upstash Redis) ----
const crypto = require('crypto');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), FILE = path.join(DIR, 'users.json');
const UP = process.env.UPSTASH_REDIS_REST_URL, UT = process.env.UPSTASH_REDIS_REST_TOKEN;
const SHOP = { fire: 300, bolt: 400, ice: 250, gold: 350, neon: 300, rainbow: 600, lava: 200, storm: 300, night: 100 };
const THI = { 5: 'lava', 6: 'storm', 7: 'night' };   // Brett-Index -> Shop-Artikel
let users = {}, timer = null;
const up = body => fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(body) }).then(r => r.json());
async function loadUsers() {
  try { if (UP) { const r = await up(['GET', 'chess-users']); users = r.result ? JSON.parse(r.result) : {}; } else users = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { users = {}; }
}
function saveUsers() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const j = JSON.stringify(users);
    if (UP) up(['SET', 'chess-users', j]).catch(() => {});
    else { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', j); fs.renameSync(FILE + '.tmp', FILE); } catch (e) {} }
  }, 500);
}
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const pub = u => ({ name: u.name, coins: u.coins, elo: u.elo, owned: u.owned, presets: u.presets });
const nm = x => (x.data.user && x.data.user.name) || 'Gast';

// Spieler aus Warteschlange und Raum entfernen, Gegner informieren
function leave(s) {
  queue = queue.filter(q => q.id !== s.id);
  const code = s.data.room;
  if (!code) return;
  s.data.room = null; s.leave(code);
  const r = rooms.get(code);
  if (!r) return;
  rooms.delete(code);
  for (const id of [r.w, r.b]) {
    const o = id && id !== s.id && sock(id);
    if (o && o.data.room === code) { o.data.room = null; o.leave(code); o.emit('opponent:left'); }
  }
}

function start(r) {
  const a = sock(r.w), b = sock(r.b);
  if (!a || !b) return;
  a.emit('game:start', { code: r.code, side: 'w', kind: r.kind, opp: { e: b.data.elo, n: nm(b) } });
  b.emit('game:start', { code: r.code, side: 'b', kind: r.kind, opp: { e: a.data.elo, n: nm(a) } });
}

io.on('connection', s => {
  s.data.room = null; s.data.elo = 1200;

  // ---- Private Party ----
  s.on('room:create', d => {
    if (!s.data.user) return s.emit('room:error', { message: 'Bitte zuerst anmelden.' });
    leave(s); s.data.elo = num(d && d.elo);
    const code = code6();
    rooms.set(code, { code, kind: 'party', w: s.id, b: null });
    s.data.room = code; s.join(code);
    s.emit('room:created', { code });
  });

  s.on('room:join', d => {
    if (!s.data.user) return s.emit('room:error', { message: 'Bitte zuerst anmelden.' });
    leave(s); s.data.elo = num(d && d.elo);
    const code = String((d && d.code) || ''), r = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !r) return s.emit('room:error', { message: 'Diesen Code gibt es nicht.' });
    if (r.b) return s.emit('room:error', { message: 'Die Party ist schon voll.' });
    r.b = s.id; s.data.room = code; s.join(code);
    s.emit('room:joined', { code });
    const host = sock(r.w); if (host) host.emit('room:ready', { code });
    start(r);
  });

  s.on('room:leave', () => leave(s));

  // ---- Gegnersuche (Elo-nah) ----
  s.on('match:join', d => {
    if (!s.data.user) return s.emit('room:error', { message: 'Bitte zuerst anmelden.' });
    leave(s); s.data.elo = num(d && d.elo);
    let best = -1;
    queue.forEach((q, i) => { if (best < 0 || Math.abs(q.elo - s.data.elo) < Math.abs(queue[best].elo - s.data.elo)) best = i; });
    const q = best >= 0 ? queue.splice(best, 1)[0] : null, o = q && sock(q.id);
    if (!o) { queue.push({ id: s.id, elo: s.data.elo }); return s.emit('queue:waiting'); }
    const white = Math.random() < 0.5 ? s : o, black = white === s ? o : s;
    const code = code6();
    rooms.set(code, { code, kind: 'match', w: white.id, b: black.id });
    for (const x of [s, o]) { x.data.room = code; x.join(code); }
    s.emit('queue:matched', { elo: o.data.elo });
    o.emit('queue:matched', { elo: s.data.elo });
    start(rooms.get(code));
  });

  s.on('match:leave', () => { queue = queue.filter(q => q.id !== s.id); });

  // ---- Im Spiel ----
  const room = () => rooms.get(s.data.room);
  s.on('game:move', d => {
    const r = room();
    if (!r || !d || !Number.isInteger(d.from) || !Number.isInteger(d.to)) return;
    if (d.from < 0 || d.from > 63 || d.to < 0 || d.to > 63) return;
    const promotion = ['q', 'r', 'b', 'n'].includes(d.promotion) ? d.promotion : '';
    r.moves = (r.moves || 0) + 1;
    s.to(r.code).emit('game:move', { from: d.from, to: d.to, promotion, by: s.id });
  });
  s.on('game:resign', () => { const r = room(); if (r) s.to(r.code).emit('game:resign'); });
  s.on('game:look', d => {
    const r = room(), u = s.data.user;
    if (!r || !d || !u) return;
    const x = String(d.x || ''), t = Number(d.t) | 0, need = THI[t];
    s.to(r.code).emit('game:look', { t: need && !u.owned.includes(need) ? 4 : t, c: String(d.c || '').slice(0, 9), x: SHOP[x] && u.owned.includes(x) ? x : '' });
  });

  // ---- Konto ----
  const ok = u => {
    s.data.user = u; s.data.elo = u.elo;
    const day = new Date().toDateString(); let bonus = 0;
    if (u.day !== day) { u.day = day; bonus = 50; u.coins += bonus; saveUsers(); }
    s.emit('auth:ok', { token: u.tok, profile: pub(u), shop: SHOP, bonus });
  };
  s.on('auth:register', d => {
    const n = String((d && d.name) || '').trim(), p = String((d && d.pass) || '');
    if (!/^[\wäöüÄÖÜß.-]{3,16}$/.test(n)) return s.emit('auth:fail', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (p.length < 4) return s.emit('auth:fail', { message: 'Passwort: mindestens 4 Zeichen.' });
    if (users[n.toLowerCase()]) return s.emit('auth:fail', { message: 'Dieser Name ist schon vergeben.' });
    const salt = crypto.randomBytes(8).toString('hex');
    const u = users[n.toLowerCase()] = { name: n, salt, hash: hash(p, salt), tok: crypto.randomBytes(24).toString('hex'), coins: 200, elo: 1200, owned: [], presets: [], day: '' };
    saveUsers(); ok(u);
  });
  s.on('auth:login', d => {
    const u = users[String((d && d.name) || '').trim().toLowerCase()];
    if (!u || hash(String(d.pass || ''), u.salt) !== u.hash) return s.emit('auth:fail', { message: 'Name oder Passwort stimmt nicht.' });
    ok(u);
  });
  s.on('auth:token', d => {
    const u = users[String((d && d.name) || '').toLowerCase()];
    if (!u || u.tok !== (d && d.token)) return s.emit('auth:fail', { silent: true });
    ok(u);
  });
  s.on('auth:logout', () => { leave(s); s.data.user = null; });

  s.on('profile:save', d => {
    const u = s.data.user; if (!u || !d) return;
    const pn = o => ({ w: Number(o && o.w) | 0, b: Number(o && o.b) | 0 }), ps = o => ({ w: String((o && o.w) || '').slice(0, 12), b: String((o && o.b) || '').slice(0, 12) });
    if (Array.isArray(d.presets)) u.presets = d.presets.slice(0, 8).map(p => ({ n: String((p && p.n) || 'Preset').slice(0, 14), th: pn(p && p.th), col: ps(p && p.col), ef: ps(p && p.ef) }));
    if (Number.isFinite(d.elo)) u.elo = Math.min(3000, Math.max(100, Math.round(d.elo)));
    saveUsers();
  });

  // ---- Shop und Belohnung ----
  s.on('shop:buy', d => {
    const u = s.data.user, id = String((d && d.id) || ''), price = SHOP[id];
    if (!u || !price || u.owned.includes(id)) return;
    if (u.coins < price) return s.emit('shop:error', { message: 'Nicht genug Münzen.' });
    u.coins -= price; u.owned.push(id); saveUsers();
    s.emit('profile:update', { profile: pub(u) });
  });
  s.on('game:over', d => {
    const u = s.data.user, r = room();
    if (!u || !r || (r.moves || 0) < 8) return;
    r.paid = r.paid || {};
    if (r.paid[s.id]) return;
    r.paid[s.id] = 1;
    const res = d && d.res;
    u.coins += r.kind === 'party' ? 5 : res === 'win' ? 30 : res === 'draw' ? 15 : 10;
    saveUsers(); s.emit('profile:update', { profile: pub(u) });
  });

  s.on('disconnect', () => leave(s));
});

const PORT = process.env.PORT || 3000;
loadUsers().then(() => web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT)));
