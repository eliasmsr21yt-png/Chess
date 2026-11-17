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
  if (p === 'health') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('ok · Speicher: ' + storageText() + ' · Konten: ' + Object.keys(users).length); }
  if (p === 'setup') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(setupPage()); }
  if (!FILES[p]) { res.writeHead(404); return res.end('Nicht gefunden'); }
  fs.readFile(path.join(__dirname, p), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': FILES[p], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const io = new Server(web, { cors: { origin: '*' } });
const rooms = new Map();   // Code -> { code, kind, w, b }  (Socket-IDs)
let queue = [];            // Wartende Spieler: { id, elo, minutes }

const num = v => Math.min(3000, Math.max(100, Math.round(+v) || 300));
const sock = id => io.sockets.sockets.get(id);
const code6 = () => { let c; do { c = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(c)); return c; };

// ---- Konten (Datei oder dauerhaft über Upstash Redis) ----
const crypto = require('crypto');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), FILE = path.join(DIR, 'users.json');
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
let UP = clean(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
const UT = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
if (UP && !/^https?:\/\//i.test(UP)) UP = 'https://' + UP;
const USE_UP = !!(UP && UT);
const SHOP = { fire: 300, bolt: 400, ice: 250, gold: 350, neon: 300, rainbow: 600, shadow: 850, plasma: 1100, emerald: 1400, prism: 1800, cosmic: 5000, lava: 200, storm: 300, night: 100, cyber: 450, forest: 650, galaxy: 1200, royal: 2200 };
const THI = { 5: 'lava', 6: 'storm', 7: 'night', 8: 'cyber', 9: 'forest', 10: 'galaxy', 11: 'royal' };   // Brett-Index -> Shop-Artikel
const COMP = { win: 'loss', loss: 'win', draw: 'draw' };
const KEY = 'chess:users';
let users = {}, saved = {}, timer = null, dbError = '', dbOk = !USE_UP, flushing = false, flushAgain = false, flushPromise = null;
const persistOK = () => (USE_UP ? dbOk : !!process.env.DATA_DIR);

async function up(cmd) {
  const r = await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
async function loadUsers() {
  try {
    if (USE_UP) {
      const r = await up(['HGETALL', KEY]), a = Array.isArray(r) ? r : Object.entries(r || {}).flat();
      for (let i = 0; i + 1 < a.length; i += 2) { try { const u = JSON.parse(a[i + 1]); if (!users[a[i]]) users[a[i]] = u; saved[a[i]] = a[i + 1]; } catch (e) {} }
      await up(['SET', 'chess:ping', String(Date.now())]);   // Schreibtest: der Token darf nicht „read-only“ sein
      dbOk = true; dbError = '';
    } else { users = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const k in users) saved[k] = JSON.stringify(users[k]); }
  } catch (e) { if (USE_UP) { dbOk = false; dbError = String((e && e.message) || e); console.error('Upstash-Fehler:', dbError); } }
}
function saveUsers() { clearTimeout(timer); timer = setTimeout(flush, 250); }
async function flush() {
  clearTimeout(timer);
  if (flushing) {
    flushAgain = true;
    const active = flushPromise;
    return active ? active.then(() => flush()) : undefined;
  }
  flushing = true;
  flushPromise = (async () => {
    try {
      if (USE_UP && !dbOk) await loadUsers();             // nach einem Fehler erst neu verbinden
      const ch = {}, allKeys = Object.keys(users), deleted = Object.keys(saved).filter(k => !Object.prototype.hasOwnProperty.call(users, k));
      for (const k of allKeys) { const j = JSON.stringify(users[k]); if (saved[k] !== j) ch[k] = j; }
      const keys = Object.keys(ch);
      if (!keys.length && !deleted.length) return;
      if (USE_UP) {
        if (!dbOk) throw new Error(dbError || 'Upstash nicht erreichbar');
        if (keys.length) await up(['HSET', KEY, ...keys.flatMap(k => [k, ch[k]])]);
        if (deleted.length) await up(['HDEL', KEY, ...deleted]);
      } else {
        fs.mkdirSync(DIR, { recursive: true });
        const tmp = FILE + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, FILE);
      }
      for (const k of keys) saved[k] = ch[k];
      for (const k of deleted) delete saved[k];
    } catch (e) {
      if (USE_UP) { dbOk = false; dbError = String((e && e.message) || e); }
      console.error('Speichern fehlgeschlagen:', (e && e.message) || e);
      timer = setTimeout(flush, 15000);
    }
  })();
  try { await flushPromise; }
  finally {
    flushing = false; flushPromise = null;
    if (flushAgain) { flushAgain = false; clearTimeout(timer); timer = setTimeout(flush, 50); }
  }
}
process.on('SIGTERM', async () => { clearTimeout(timer); await Promise.race([flush(), new Promise(r => setTimeout(r, 8000))]); process.exit(0); });
process.on('SIGINT', async () => { clearTimeout(timer); await Promise.race([flush(), new Promise(r => setTimeout(r, 8000))]); process.exit(0); });

const hx = s => String(s).replace(/[&<>"]/g, c => '&#' + c.charCodeAt(0) + ';');
const storageText = () => USE_UP ? (dbOk ? 'Upstash (dauerhaft)' : 'Upstash FEHLER: ' + dbError) : process.env.DATA_DIR ? 'Datenträger' : 'Datei (geht bei Neustart verloren)';
function setupPage() {
  const n = Object.keys(users).length;
  const st = USE_UP ? (dbOk ? ['ok', '✅ Dauerhaft gespeichert (Upstash). Konten: ' + n + '.']
    : ['er', '❌ Upstash ist eingetragen, aber es klappt nicht: ' + hx(dbError) + '<br>Prüfe URL und Token (ohne Leerzeichen, kein „read-only“-Token) und speichere in Render noch einmal.'])
    : process.env.DATA_DIR ? ['ok', '✅ Speicher auf Datenträger. Konten: ' + n + '.']
    : ['no', '⚠️ Der Server speichert nur vorübergehend. Nach jedem Neustart oder Einschlafen sind alle Konten, Namen und Münzen weg, und jemand anderes kann deinen Namen nehmen. Konten gerade: ' + n + '.'];
  return '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Schach – Speicher</title>'
    + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;padding:20px;max-width:560px;color:#1a1a1a}.b{padding:14px;border-radius:14px;margin:14px 0}.ok{background:#e8f5e9}.no{background:#fff3e0}.er{background:#ffebee}code{background:#eee;padding:2px 6px;border-radius:6px;word-break:break-all}li{margin:10px 0}a{color:#2979ff}</style>'
    + '<h1>Server-Speicher</h1><div class="b ' + st[0] + '">' + st[1] + '</div>'
    + '<h2>Dauerhaft speichern (kostenlos, ca. 5 Minuten)</h2><ol>'
    + '<li>Öffne <a href="https://console.upstash.com">console.upstash.com</a> und registriere dich (zum Beispiel mit Google).</li>'
    + '<li>Oben auf <b>Redis</b> tippen, dann <b>Create database</b>. Name <code>schach</code>, Region in Europa, Gratis-Tarif, dann <b>Create</b>.</li>'
    + '<li>Auf der Datenbank-Seite im Bereich <b>Connect</b> den Tab <b>REST</b> öffnen. Kopiere dort <code>UPSTASH_REDIS_REST_URL</code> und <code>UPSTASH_REDIS_REST_TOKEN</code> mit den Kopier-Knöpfen.</li>'
    + '<li>Öffne <a href="https://dashboard.render.com">dashboard.render.com</a>, dein Service, links <b>Environment</b>, dann <b>+ Add Environment Variable</b>. Lege zwei Variablen mit genau diesen Namen an und füge die kopierten Werte ein.</li>'
    + '<li>Speichere mit <b>Save, rebuild, and deploy</b> und warte, bis „Live“ steht.</li>'
    + '<li>Lade diese Seite neu. Oben muss „Dauerhaft gespeichert“ stehen.</li></ol>'
    + '<p>Danach bleiben Konten, Namen, Münzen und Käufe erhalten, und ein vergebener Name kann nicht von jemand anderem genommen werden.</p>'
    + '<p><a href="/">← Zurück zum Spiel</a></p></html>';
}

const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const pn = o => ({ w: Number(o && o.w) | 0, b: Number(o && o.b) | 0 }), ps = o => ({ w: String((o && o.w) || '').slice(0, 12), b: String((o && o.b) || '').slice(0, 12) });
const cleanPresets = a => (Array.isArray(a) ? a : []).slice(0, 8).map(p => ({ n: String((p && p.n) || 'Preset').slice(0, 14), th: pn(p && p.th), col: ps(p && p.col), ef: ps(p && p.ef) }));
const cleanLook = o => ({ th: { w: Number.isInteger(o && o.th && o.th.w) && o.th.w >= 0 && o.th.w <= 11 ? o.th.w : 4, b: Number.isInteger(o && o.th && o.th.b) && o.th.b >= 0 && o.th.b <= 11 ? o.th.b : 4 }, col: { w: /^#[0-9a-f]{6}$/i.test(String(o && o.col && o.col.w || '')) ? o.col.w : '#ffffff', b: /^#[0-9a-f]{6}$/i.test(String(o && o.col && o.col.b || '')) ? o.col.b : '#1a1a1a' }, ef: ps(o && o.ef) });
const ensureUser = u => { if (!Array.isArray(u.friends)) u.friends = []; if (!Array.isArray(u.incoming)) u.incoming = []; if (!Array.isArray(u.outgoing)) u.outgoing = []; if (!Array.isArray(u.botWins)) u.botWins = []; if (!u.look) u.look = cleanLook(null); if (!Array.isArray(u.owned)) u.owned = []; if (!Array.isArray(u.presets)) u.presets = []; if (!Number.isFinite(+u.coins)) u.coins = 0; if (!Number.isFinite(+u.elo)) u.elo = 300; return u; };
const pub = u => ({ name: u.name, coins: u.coins, elo: u.elo, owned: u.owned, presets: u.presets, av: u.av | 0, botWins: u.botWins || [], look: cleanLook(u.look), v: 3 });
const nm = x => (x.data.user && x.data.user.name) || 'Gast';
const av = x => (x.data.user && x.data.user.av) | 0;

// Spieler aus Warteschlange und Raum entfernen, Gegner informieren
function leave(s) {
  queue = queue.filter(q => q.id !== s.id);
  const code = s.data.room;
  if (!code) return;
  s.data.room = null; s.leave(code);
  const r = rooms.get(code);
  if (!r) return;
  if (r.kind === 'match' && (r.moves || 0) >= 8 && !r.done) {   // wer geht, verliert
    const oid = s.id === r.w ? r.b : r.w;
    if (!r.res[s.id]) r.res[s.id] = r.res[oid] ? COMP[r.res[oid]] : 'loss';
    if (!r.res[oid]) r.res[oid] = COMP[r.res[s.id]];
    settle(r);
  }
  rooms.delete(code);
  for (const id of [r.w, r.b]) {
    const o = id && id !== s.id && sock(id);
    if (o && o.data.room === code) { o.data.room = null; o.leave(code); o.emit('opponent:left'); }
  }
}

function start(r) {
  const a = sock(r.w), b = sock(r.b);
  if (!a || !b) return;
  const minutes = [1, 3, 5, 10].includes(+r.minutes) ? +r.minutes : 5;
  a.emit('game:start', { code: r.code, side: 'w', kind: r.kind, minutes, opp: { e: b.data.elo, n: nm(b), a: av(b) } });
  b.emit('game:start', { code: r.code, side: 'b', kind: r.kind, minutes, opp: { e: a.data.elo, n: nm(a), a: av(a) } });
}

// Wertung: Elo und Münzen nur, wenn beide Spieler dasselbe Ergebnis melden (oder einer das Spiel verlässt)
function settle(r) {
  if (r.done || r.kind !== 'match') return;
  const ra = r.res[r.w], rb = r.res[r.b];
  if (!ra || !rb) return;
  r.done = true;
  const good = COMP[ra] === rb;
  for (const [id, res] of [[r.w, ra], [r.b, rb]]) {
    const u = r.u[id]; if (!u) continue;
    const oid = id === r.w ? r.b : r.w;
    if (good) {
      const sc = res === 'win' ? 1 : res === 'draw' ? 0.5 : 0;
      u.elo = Math.max(100, u.elo + Math.round(32 * (sc - 1 / (1 + Math.pow(10, (r.e[oid] - r.e[id]) / 400)))));
    }
    if (good && res === 'win') u.coins += 50;
    const x = sock(id);
    if (x) { x.data.elo = u.elo; x.emit('profile:update', { profile: pub(u) }); }
  }
  saveUsers();
}
function claim(r, s, res) {
  const u = s.data.user;
  if (!u || !COMP[res]) return;
  if (r.kind !== 'match') return;   // Party- und Freundschaftsspiele geben weder Gold noch Elo
  if (!r.res[s.id]) { r.res[s.id] = res; settle(r); }
}

const friendInvites = new Map();
function onlineSocket(key) { for (const x of io.sockets.sockets.values()) if (x.data.userKey === key && !x.disconnected) return x; return null; }
function friendPayload(u) {
  const friends = (u.friends || []).filter(k => users[k]).map(k => ({ name: users[k].name, elo: users[k].elo, av: users[k].av | 0, online: !!onlineSocket(k) }));
  const incoming = (u.incoming || []).filter(k => users[k]).map(k => users[k].name);
  const outgoing = (u.outgoing || []).filter(k => users[k]).map(k => users[k].name);
  return { friends, incoming, outgoing };
}
function sendFriends(s) { if (s.data.user) s.emit('friends:data', friendPayload(s.data.user)); }
function refreshFriends(keys) { for (const key of new Set(keys.filter(Boolean))) { const x = onlineSocket(key); if (x) sendFriends(x); } }
function validMinutes(v) { return [1, 3, 5, 10].includes(+v) ? +v : 5; }

io.on('connection', s => {
  s.data.room = null; s.data.elo = 300; s.data.userKey = '';
  s.emit('server:info', { persist: persistOK() });

  // ---- Private Party ----
  s.on('room:create', d => {
    if (!s.data.user) return s.emit('room:error', { message: 'Bitte zuerst anmelden.' });
    leave(s); s.data.elo = s.data.user.elo;
    const code = code6();
    rooms.set(code, { code, kind: 'party', minutes: validMinutes(d && d.minutes), w: s.id, b: null, res: {} });
    s.data.room = code; s.join(code);
    s.emit('room:created', { code, minutes: rooms.get(code).minutes });
  });

  s.on('room:join', d => {
    if (!s.data.user) return s.emit('room:error', { message: 'Bitte zuerst anmelden.' });
    leave(s); s.data.elo = s.data.user.elo;
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
    leave(s); s.data.elo = s.data.user.elo;
    const minutes = [1, 3, 5, 10].includes(+(d && d.minutes)) ? +(d && d.minutes) : 5;
    let best = -1;
    queue.forEach((q, i) => { if (q.minutes === minutes && (best < 0 || Math.abs(q.elo - s.data.elo) < Math.abs(queue[best].elo - s.data.elo))) best = i; });
    const q = best >= 0 ? queue.splice(best, 1)[0] : null, o = q && sock(q.id);
    if (!o) { queue.push({ id: s.id, elo: s.data.elo, minutes }); return s.emit('queue:waiting', { minutes }); }
    const white = Math.random() < 0.5 ? s : o, black = white === s ? o : s;
    const code = code6();
    rooms.set(code, { code, kind: 'match', minutes, w: white.id, b: black.id, res: {}, e: { [white.id]: white.data.elo, [black.id]: black.data.elo }, u: { [white.id]: white.data.user, [black.id]: black.data.user } });
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
    ensureUser(u);
    if ((u.v | 0) < 3) { u.v = 3; u.av = u.av | 0; saveUsers(); }
    const key = Object.keys(users).find(k => users[k] === u) || '';
    s.data.user = u; s.data.userKey = key; s.data.elo = u.elo;
    s.emit('auth:ok', { token: u.tok, profile: pub(u), shop: SHOP, cred: { salt: u.salt, hash: u.hash }, persist: persistOK() });
    sendFriends(s); refreshFriends(u.friends || []);
  };
  s.on('auth:register', d => {
    const n = String((d && d.name) || '').trim(), p = String((d && d.pass) || '');
    if (!/^[\wäöüÄÖÜß.-]{3,16}$/.test(n)) return s.emit('auth:fail', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (p.length < 4) return s.emit('auth:fail', { message: 'Passwort: mindestens 4 Zeichen.' });
    if (users[n.toLowerCase()]) return s.emit('auth:fail', { message: 'Dieser Name ist schon vergeben. Ist es dein Name? Dann melde dich an.' });
    const salt = crypto.randomBytes(8).toString('hex');
    const u = users[n.toLowerCase()] = { name: n, salt, hash: hash(p, salt), tok: crypto.randomBytes(24).toString('hex'), coins: 0, elo: 300, owned: [], presets: [], av: 0, botWins: [], friends: [], incoming: [], outgoing: [], look: cleanLook(null), v: 3 };
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
  s.on('auth:logout', () => { const key = s.data.userKey; leave(s); s.data.user = null; s.data.userKey = ''; if (key && users[key]) refreshFriends(users[key].friends || []); });

  s.on('profile:save', d => {
    const u = s.data.user; if (!u || !d) return;
    const pn = o => ({ w: Number(o && o.w) | 0, b: Number(o && o.b) | 0 }), ps = o => ({ w: String((o && o.w) || '').slice(0, 12), b: String((o && o.b) || '').slice(0, 12) });
    if (Array.isArray(d.presets)) u.presets = d.presets.slice(0, 8).map(p => ({ n: String((p && p.n) || 'Preset').slice(0, 14), th: pn(p && p.th), col: ps(p && p.col), ef: ps(p && p.ef) }));
    if (Number.isInteger(d.av) && d.av >= 0 && d.av < 24) u.av = d.av;
    if (d.look && typeof d.look === 'object') u.look = cleanLook(d.look);
    saveUsers();
  });

  s.on('profile:rename', d => {
    const u = s.data.user, oldKey = s.data.userKey, name = String((d && d.name) || '').trim(), newKey = name.toLowerCase();
    if (!u || !oldKey) return;
    if (!/^[\wäöüÄÖÜß.-]{3,16}$/.test(name)) return s.emit('profile:error', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (newKey !== oldKey && users[newKey]) return s.emit('profile:error', { message: 'Dieser Name ist bereits vergeben.' });
    if (newKey !== oldKey) {
      delete users[oldKey]; users[newKey] = u; u.name = name; s.data.userKey = newKey;
      for (const other of Object.values(users)) {
        for (const field of ['friends', 'incoming', 'outgoing']) if (Array.isArray(other[field])) other[field] = other[field].map(k => k === oldKey ? newKey : k);
      }
    } else u.name = name;
    saveUsers(); s.emit('profile:update', { profile: pub(u) }); sendFriends(s); refreshFriends([...(u.friends || []), ...(u.incoming || []), ...(u.outgoing || [])]);
  });

  // ---- Freundesliste, Anfragen und private Herausforderungen ----
  s.on('friends:get', () => sendFriends(s));
  s.on('friends:add', d => {
    const u = s.data.user, key = String((d && d.name) || '').trim().toLowerCase(), other = users[key];
    if (!u) return;
    if (!key || !other) return s.emit('friends:message', { message: 'Dieser Name existiert nicht.' });
    if (key === s.data.userKey) return s.emit('friends:message', { message: 'Du kannst dich nicht selbst hinzufügen.' });
    ensureUser(u); ensureUser(other);
    if (u.friends.includes(key)) return s.emit('friends:message', { message: 'Dieser Spieler ist bereits befreundet.' });
    if (other.incoming.includes(s.data.userKey)) return s.emit('friends:message', { message: 'Dieser Spieler hat dir bereits eine Anfrage gesendet.' });
    if (!u.outgoing.includes(key)) u.outgoing.push(key);
    if (!other.incoming.includes(s.data.userKey)) other.incoming.push(s.data.userKey);
    saveUsers(); sendFriends(s); refreshFriends([key]); s.emit('friends:message', { message: 'Freundschaftsanfrage gesendet.' });
  });
  s.on('friends:accept', d => {
    const u = s.data.user, key = String((d && d.name) || '').trim().toLowerCase(), other = users[key];
    if (!u || !other || !(u.incoming || []).includes(key)) return;
    ensureUser(u); ensureUser(other);
    u.incoming = u.incoming.filter(x => x !== key); u.friends = [...new Set([...u.friends, key])];
    other.outgoing = (other.outgoing || []).filter(x => x !== s.data.userKey); other.friends = [...new Set([...(other.friends || []), s.data.userKey])];
    saveUsers(); sendFriends(s); refreshFriends([key]); s.emit('friends:message', { message: 'Freund hinzugefügt.' });
  });
  s.on('friends:decline', d => {
    const u = s.data.user, key = String((d && d.name) || '').trim().toLowerCase();
    if (!u) return; u.incoming = (u.incoming || []).filter(x => x !== key);
    if (users[key]) users[key].outgoing = (users[key].outgoing || []).filter(x => x !== s.data.userKey);
    saveUsers(); sendFriends(s); refreshFriends([key]);
  });
  s.on('friends:remove', d => {
    const u = s.data.user, key = String((d && d.name) || '').trim().toLowerCase();
    if (!u) return; u.friends = (u.friends || []).filter(x => x !== key);
    if (users[key]) users[key].friends = (users[key].friends || []).filter(x => x !== s.data.userKey);
    saveUsers(); sendFriends(s); refreshFriends([key]);
  });
  s.on('friends:challenge', d => {
    const u = s.data.user, key = String((d && d.name) || '').trim().toLowerCase(), other = users[key], target = onlineSocket(key);
    if (!u || !other || !(u.friends || []).includes(key)) return s.emit('friends:message', { message: 'Du musst zuerst mit diesem Spieler befreundet sein.' });
    if (!target) return s.emit('friends:message', { message: 'Dieser Freund ist gerade offline.' });
    if (s.data.room || target.data.room) return s.emit('friends:message', { message: 'Ein Spieler ist bereits in einem Spiel.' });
    const id = crypto.randomBytes(12).toString('hex'), minutes = validMinutes(d && d.minutes);
    friendInvites.set(id, { from: s.id, to: target.id, minutes });
    target.emit('friends:invite', { id, from: u.name, minutes });
    s.emit('friends:message', { message: 'Herausforderung gesendet (' + minutes + ' Min).' });
  });
  s.on('friends:respond', d => {
    const id = String((d && d.id) || ''), invite = friendInvites.get(id);
    if (!invite || invite.to !== s.id) return;
    friendInvites.delete(id);
    const challenger = sock(invite.from);
    if (!(d && d.accept)) { if (challenger) challenger.emit('friends:message', { message: nm(s) + ' hat abgelehnt.' }); return; }
    if (!challenger || challenger.data.room || s.data.room || !s.data.user || !challenger.data.user) {
      if (challenger) challenger.emit('friends:message', { message: 'Herausforderung nicht mehr verfügbar.' });
      return s.emit('friends:message', { message: 'Herausforderung nicht mehr verfügbar.' });
    }
    leave(challenger); leave(s);
    challenger.data.elo = challenger.data.user.elo; s.data.elo = s.data.user.elo;
    const white = Math.random() < .5 ? challenger : s, black = white === challenger ? s : challenger, code = code6();
    rooms.set(code, { code, kind: 'friend', minutes: invite.minutes, w: white.id, b: black.id, res: {}, u: { [white.id]: white.data.user, [black.id]: black.data.user } });
    for (const x of [white, black]) { x.data.room = code; x.join(code); }
    start(rooms.get(code));
  });

  s.on('bot:win', d => {
    const u = s.data.user, level = Number(d && d.level);
    if (!u || !Number.isInteger(level) || level < 0 || level > 4) return;
    ensureUser(u); const reward = [50, 100, 175, 300, 500][level];
    if (u.botWins[level]) return s.emit('bot:reward', { already: true, level, reward: 0, profile: pub(u) });
    u.botWins[level] = true; u.coins += reward; saveUsers();
    s.emit('bot:reward', { already: false, level, reward, profile: pub(u) });
    s.emit('profile:update', { profile: pub(u) });
  });

  // ---- Shop und Belohnung ----
  s.on('shop:buy', d => {
    const u = s.data.user, id = String((d && d.id) || ''), price = SHOP[id];
    if (!u || !price || u.owned.includes(id)) return;
    if (u.coins < price) return s.emit('shop:error', { message: 'Nicht genug Münzen.' });
    u.coins -= price; u.owned.push(id); saveUsers();
    s.emit('profile:update', { profile: pub(u) });
  });
  s.on('game:over', d => { const r = room(); if (r) claim(r, s, d && d.res); });

  // Konto nach Server-Neustart vom Gerät wiederherstellen (Name muss frei sein)
  s.on('auth:restore', d => {
    d = d || {};
    const n = String(d.name || '').trim(), k = n.toLowerCase(), p = d.profile || {};
    if (!/^[\wäöüÄÖÜß.-]{3,16}$/.test(n) || !/^[0-9a-f]{16}$/.test(d.salt) || !/^[0-9a-f]{64}$/.test(d.hash) || !/^[0-9a-f]{48}$/.test(d.token))
      return s.emit('auth:fail', { message: 'Konto konnte nicht wiederhergestellt werden.' });
    if (users[k]) return users[k].tok === d.token ? ok(users[k]) : s.emit('auth:fail', { message: 'Dein Name ist inzwischen vergeben. Melde dich an oder wähle einen neuen Namen.' });
    const int = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Math.round(+v) || def));
    const u = users[k] = { name: n, salt: d.salt, hash: d.hash, tok: d.token, coins: int(p.coins, 0, 1000000, 0), elo: p.v >= 2 ? int(p.elo, 100, 3000, 300) : 300,
      owned: [...new Set((Array.isArray(p.owned) ? p.owned : []).filter(id => SHOP[id]))], presets: cleanPresets(p.presets), av: int(p.av, 0, 23, 0), botWins: Array.isArray(p.botWins) ? p.botWins.slice(0, 5).map(Boolean) : [], friends: [], incoming: [], outgoing: [], look: cleanLook(p.look), v: 3 };
    saveUsers(); ok(u);
  });

  // Bestenliste: Top 100 nach Elo
  s.on('lb:get', () => {
    const all = Object.values(users).sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));
    s.emit('lb:data', { top: all.slice(0, 100).map(u => ({ n: u.name, e: u.elo, a: u.av | 0 })), rank: s.data.user ? all.indexOf(s.data.user) + 1 : 0, total: all.length });
  });

  s.on('disconnect', () => { const key = s.data.userKey; leave(s); if (key) refreshFriends([...(users[key] && users[key].friends || [])]); for (const [id, inv] of friendInvites) if (inv.from === s.id || inv.to === s.id) { friendInvites.delete(id); const other = sock(inv.from === s.id ? inv.to : inv.from); if (other) other.emit('friends:message', { message: 'Herausforderung abgebrochen.' }); } });
});

const PORT = process.env.PORT || 3000;
loadUsers().then(() => web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT)));

module.exports = { web };
