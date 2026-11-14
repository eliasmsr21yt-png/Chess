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
  a.emit('game:start', { code: r.code, side: 'w', kind: r.kind, opp: { e: b.data.elo } });
  b.emit('game:start', { code: r.code, side: 'b', kind: r.kind, opp: { e: a.data.elo } });
}

io.on('connection', s => {
  s.data.room = null; s.data.elo = 1200;

  // ---- Private Party ----
  s.on('room:create', d => {
    leave(s); s.data.elo = num(d && d.elo);
    const code = code6();
    rooms.set(code, { code, kind: 'party', w: s.id, b: null });
    s.data.room = code; s.join(code);
    s.emit('room:created', { code });
  });

  s.on('room:join', d => {
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
    s.to(r.code).emit('game:move', { from: d.from, to: d.to, promotion, by: s.id });
  });
  s.on('game:resign', () => { const r = room(); if (r) s.to(r.code).emit('game:resign'); });
  s.on('game:look', d => { const r = room(); if (r && d) s.to(r.code).emit('game:look', { t: Number(d.t) | 0, c: String(d.c || '').slice(0, 9) }); });

  s.on('disconnect', () => leave(s));
});

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT));
