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
let queue = [];            // Wartende Spieler: { id, elo }

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
const SHOP = { fire: 300, bolt: 400, ice: 250, gold: 350, neon: 300, rainbow: 600, lava: 200, storm: 300, night: 100,
  ghost: 200, toxic: 350, sakura: 500, thunder: 900, diamond: 1500, phoenix: 5000, ocean: 250, forest: 250, rose: 300, galaxy: 1500, aurora: 2500, celestial: 12000 };
const THI = { 5: 'lava', 6: 'storm', 7: 'night', 8: 'ocean', 9: 'forest', 10: 'rose', 11: 'galaxy' };   // Brett-Index -> Shop-Artikel
const COMP = { win: 'loss', loss: 'win', draw: 'draw' };
const KEY = 'chess:users';
// Stabiler HMAC-Schlüssel: wichtig, damit gespeicherte Bestenlisten-Einträge
// nach einem Server-Neustart weiterhin geprüft und wiederhergestellt werden können.
// Reihenfolge: eigener Schlüssel, Render-Service-ID, Upstash-Token oder lokale Schlüsseldatei.
function loadSigningSecret() {
  const configured = clean(process.env.SESSION_SECRET) || clean(process.env.RENDER_SERVICE_ID);
  if (configured) return configured;
  if (USE_UP) return crypto.createHash('sha256').update(UT).digest('hex');
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const keyFile = path.join(DIR, 'session.secret');
    if (fs.existsSync(keyFile)) {
      const existing = clean(fs.readFileSync(keyFile, 'utf8'));
      if (existing.length >= 32) return existing;
    }
    const fresh = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(keyFile, fresh, { mode: 0o600 });
    return fresh;
  } catch (e) {
    console.error('Kein dauerhafter Signaturschlüssel verfügbar. Bitte SESSION_SECRET setzen:', e.message);
    return '';
  }
}
const KSEC = loadSigningSecret();
const sig = (...a) => KSEC ? crypto.createHmac('sha256', KSEC).update(a.join('|')).digest('hex').slice(0, 32) : '';
const pSig = u => sig('p', u.name, u.coins | 0, u.elo | 0, [...(u.owned || [])].sort().join(','), [...(u.bots || [])].sort().join(','));
const lSig = (n, e, a) => sig('l', n, e | 0, a | 0);
let users = {}, saved = {}, timer = null, dbError = '', dbOk = !USE_UP, deleted = new Set(), ghosts = {};
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
function saveUsers() { clearTimeout(timer); timer = setTimeout(flush, 400); }
async function flush() {
  clearTimeout(timer);
  if (USE_UP && !dbOk) await loadUsers();             // nach einem Fehler erst neu verbinden
  const ch = {};
  for (const k in users) { const j = JSON.stringify(users[k]); if (saved[k] !== j) ch[k] = j; }
  const keys = Object.keys(ch), del = [...deleted];
  if (!keys.length && !del.length) return;
  try {
    if (USE_UP) {
      if (!dbOk) throw new Error(dbError || 'Upstash nicht erreichbar');
      if (del.length) await up(['HDEL', KEY, ...del]);
      if (keys.length) await up(['HSET', KEY, ...keys.flatMap(k => [k, ch[k]])]);
    } else { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(users)); fs.renameSync(FILE + '.tmp', FILE); }
    for (const k of keys) saved[k] = ch[k];
    for (const k of del) deleted.delete(k);
  } catch (e) {
    if (USE_UP) { dbOk = false; dbError = String((e && e.message) || e); }
    console.error('Speichern fehlgeschlagen:', (e && e.message) || e);
    timer = setTimeout(flush, 15000);
  }
}
process.on('SIGTERM', async () => { await Promise.race([flush(), new Promise(r => setTimeout(r, 8000))]); process.exit(0); });   // Render beendet den Server: vorher noch speichern

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
const pub = u => ({ name: u.name, coins: u.coins, elo: u.elo, owned: u.owned, presets: u.presets, av: u.av | 0, v: 3, bots: u.bots || [], sg: pSig(u) });
const nm = x => (x.data.user && x.data.user.name) || 'Gast';
const av = x => (x.data.user && x.data.user.av) | 0;
const pn = o => ({ w: Number(o && o.w) | 0, b: Number(o && o.b) | 0 }), ps = o => ({ w: String((o && o.w) || '').slice(0, 12), b: String((o && o.b) || '').slice(0, 12) });
const cleanPresets = a => (Array.isArray(a) ? a : []).slice(0, 8).map(p => ({ n: String((p && p.n) || 'Preset').slice(0, 14), th: pn(p && p.th), col: ps(p && p.col), ef: ps(p && p.ef) }));

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
  a.emit('game:start', { code: r.code, side: 'w', kind: r.kind, tc: r.tc || 5, opp: { e: b.data.elo, n: nm(b), a: av(b) } });
  b.emit('game:start', { code: r.code, side: 'b', kind: r.kind, tc: r.tc || 5, opp: { e: a.data.elo, n: nm(a), a: av(a) } });
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
    const gold = good && res === 'win' ? 50 : 0;   // nur Siege in Online-Spielen bringen Gold
    u.coins += gold;
    const x = sock(id);
    if (x) { x.data.elo = u.elo; x.emit('profile:update', { profile: pub(u), reward: gold ? { g: gold, t: 'Sieg' } : undefined }); }
  }
  saveUsers();
}
function claim(r, s, res) {
  const u = s.data.user;
  if (!u || (r.moves || 0) < 8 || !COMP[res]) return;
  if (r.kind !== 'match') return;   // Party, Freunde und lokale Spiele: weder Elo noch Gold
  if (!r.res[s.id]) { r.res[s.id] = res; settle(r); }
}

const NAME_RE = /^[\wäöüÄÖÜß.-]{3,16}$/;
const TCS = [1, 3, 5, 10];                       // Bedenkzeiten in Minuten
const BOT_R = [20, 60, 120, 250, 500];           // Gold beim ersten Sieg gegen Bot-Stufe 1 bis 5
const byKey = {};                                // Name (klein) -> Sockets (für Online-Status)
const invites = new Map();
const low = u => u.name.toLowerCase();
const tcOf = v => (TCS.includes(+v) ? +v : 5);
const int = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Math.round(+v) || def));
const onSocks = k => (byKey[k] || []).filter(x => x.connected !== false);
const offline = s => { const u = s.data.user; if (!u) return; const a = byKey[low(u)]; if (a) { const i = a.indexOf(s); if (i >= 0) a.splice(i, 1); } };
const friendRows = u => (u.fr || []).map(k => { const f = users[k]; if (!f) return null; const so = onSocks(k); return { n: f.name, e: f.elo, a: f.av | 0, on: so.length > 0, busy: so.length > 0 && so.every(x => x.data.room) }; }).filter(Boolean);
function newRoom(kind, tc, a, b) {
  const code = code6();
  rooms.set(code, { code, kind, tc, w: a.id, b: b.id, res: {}, e: { [a.id]: a.data.elo, [b.id]: b.data.elo }, u: { [a.id]: a.data.user, [b.id]: b.data.user } });
  for (const x of [a, b]) { x.data.room = code; x.join(code); }
  return rooms.get(code);
}

io.on('connection', s => {
  s.data.room = null; s.data.elo = 300;
  s.emit('server:info', { persist: persistOK() });
  const U = () => s.data.user, room = () => rooms.get(s.data.room);
  const need = () => { if (U()) return true; s.emit('room:error', { message: 'Bitte zuerst anmelden.' }); return false; };

  const ok = u => {
    if (u.v !== 3) { if (!(u.v >= 2)) u.elo = 300; u.v = 3; u.coins = 0; u.bots = u.bots || []; u.fr = u.fr || []; u.av = u.av | 0; saveUsers(); }   // Gold startet bei 0
    s.data.user = u; s.data.elo = u.elo;
    const k = low(u); byKey[k] = byKey[k] || []; if (!byKey[k].includes(s)) byKey[k].push(s);
    s.emit('auth:ok', { token: u.tok, profile: pub(u), shop: SHOP, cred: { salt: u.salt, hash: u.hash }, persist: persistOK(), fr: u.fr });
  };

  // ---- Konto ----
  s.on('auth:register', d => {
    const n = String((d && d.name) || '').trim(), p = String((d && d.pass) || ''), k = n.toLowerCase();
    if (!NAME_RE.test(n)) return s.emit('auth:fail', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (p.length < 4) return s.emit('auth:fail', { message: 'Passwort: mindestens 4 Zeichen.' });
    if (users[k] || ghosts[k]) return s.emit('auth:fail', { message: 'Dieser Name ist schon vergeben. Ist es dein Name? Dann melde dich an.' });
    const salt = crypto.randomBytes(8).toString('hex');
    const u = users[k] = { name: n, salt, hash: hash(p, salt), tok: crypto.randomBytes(24).toString('hex'), coins: 0, elo: 300, owned: [], presets: [], av: 0, v: 3, bots: [], fr: [] };
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
  s.on('auth:logout', () => { leave(s); offline(s); s.data.user = null; });

  // Konto nach Server-Neustart vom Gerät wiederherstellen (Name muss frei sein)
  s.on('auth:restore', d => {
    d = d || {};
    const n = String(d.name || '').trim(), k = n.toLowerCase(), p = d.profile || {};
    if (!NAME_RE.test(n) || !/^[0-9a-f]{16}$/.test(d.salt) || !/^[0-9a-f]{64}$/.test(d.hash) || !/^[0-9a-f]{48}$/.test(d.token))
      return s.emit('auth:fail', { message: 'Konto konnte nicht wiederhergestellt werden.' });
    if (users[k]) return users[k].tok === d.token ? ok(users[k]) : s.emit('auth:fail', { message: 'Dein Name ist inzwischen vergeben. Melde dich an oder wähle einen neuen Namen.' });
    const owned = [...new Set((Array.isArray(p.owned) ? p.owned : []).filter(id => SHOP[id]))];
    const bots = [...new Set((Array.isArray(p.bots) ? p.bots : []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x < BOT_R.length))];
    const cand = { name: n, coins: Math.max(0, Math.round(+p.coins) || 0), elo: int(p.elo, 100, 3000, 300), owned, bots };
    const good = !!KSEC && p.sg === pSig(cand);     // vom Server unterschrieben: nichts wurde verändert, alles wird 1:1 wiederhergestellt
    const u = users[k] = { name: n, salt: d.salt, hash: d.hash, tok: d.token,
      coins: p.v === 3 ? (good ? cand.coins : Math.min(cand.coins, 1000)) : 0, elo: p.v >= 2 ? (good ? cand.elo : Math.min(cand.elo, 600)) : 300,
      owned, bots: p.v === 3 || good ? bots : [], presets: cleanPresets(p.presets), av: int(p.av, 0, 23, 0), v: 3,
      fr: [...new Set((Array.isArray(d.fr) ? d.fr : []).map(x => String(x).toLowerCase()).filter(x => NAME_RE.test(x) && x !== k))].slice(0, 100) };
    delete ghosts[k]; saveUsers(); ok(u);
  });

  s.on('profile:save', d => {
    const u = U(); if (!u || !d) return;
    if (Array.isArray(d.presets)) u.presets = cleanPresets(d.presets);
    if (Number.isInteger(d.av) && d.av >= 0 && d.av < 24) u.av = d.av;
    saveUsers();
  });
  s.on('profile:rename', d => {
    const u = U(); if (!u) return;
    const n = String((d && d.name) || '').trim(), k = n.toLowerCase(), old = low(u);
    if (!NAME_RE.test(n)) return s.emit('profile:error', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (n === u.name) return;
    if (k !== old) {
      if (users[k] || ghosts[k]) return s.emit('profile:error', { message: 'Dieser Name ist schon vergeben.' });
      delete users[old]; delete saved[old]; deleted.add(old); users[k] = u;
      for (const x of Object.values(users)) if (x.fr) x.fr = x.fr.map(f => (f === old ? k : f));
      byKey[k] = byKey[old] || []; delete byKey[old];
    }
    u.name = n; saveUsers();
    s.emit('profile:update', { profile: pub(u), reward: { t: 'Name geändert' } });
  });

  // ---- Shop und Belohnungen ----
  s.on('shop:buy', d => {
    const u = U(), id = String((d && d.id) || ''), price = SHOP[id];
    if (!u || !price || u.owned.includes(id)) return;
    if (u.coins < price) return s.emit('shop:error', { message: 'Nicht genug Gold.' });
    u.coins -= price; u.owned.push(id); saveUsers();
    s.emit('profile:update', { profile: pub(u) });
  });
  s.on('bot:win', d => {                         // erster Sieg gegen eine Bot-Stufe
    const u = U(), lv = Number(d && d.lv);
    if (!u || !Number.isInteger(lv) || lv < 0 || lv >= BOT_R.length || (u.bots || []).includes(lv)) return;
    u.bots = [...(u.bots || []), lv]; u.coins += BOT_R[lv]; saveUsers();
    s.emit('profile:update', { profile: pub(u), reward: { g: BOT_R[lv], t: 'Bot Stufe ' + (lv + 1) + ' besiegt' } });
  });

  // ---- Bestenliste (Top 100). Unterschriebene Einträge, die Spieler von früher kennen, füllen sie nach einem Neustart wieder auf ----
  s.on('lb:seed', d => {
    if (!KSEC || !d || !Array.isArray(d.rows)) return;
    for (const r of d.rows.slice(0, 110)) {
      const n = String((r && r.n) || ''), k = n.toLowerCase();
      if (!NAME_RE.test(n) || users[k] || !r.s || r.s !== lSig(n, r.e, r.a) || Object.keys(ghosts).length >= 600) continue;
      ghosts[k] = { name: n, elo: int(r.e, 100, 3000, 300), av: int(r.a, 0, 23, 0) };
    }
  });
  s.on('lb:get', () => {
    const rows = Object.values(users).map(u => ({ k: low(u), n: u.name, e: u.elo, a: u.av | 0 }))
      .concat(Object.entries(ghosts).filter(([k]) => !users[k]).map(([k, g]) => ({ k, n: g.name, e: g.elo, a: g.av })));
    rows.sort((a, b) => b.e - a.e || a.n.localeCompare(b.n));
    const me = U() ? low(U()) : '';
    s.emit('lb:data', { top: rows.slice(0, 100).map(r => ({ n: r.n, e: r.e, a: r.a, s: lSig(r.n, r.e, r.a) })), rank: me ? rows.findIndex(r => r.k === me) + 1 : 0, total: rows.length });
  });

  // ---- Private Party ----
  s.on('room:create', d => {
    if (!need()) return;
    leave(s); s.data.elo = U().elo;
    const code = code6();
    rooms.set(code, { code, kind: 'party', tc: tcOf(d && d.tc), w: s.id, b: null, res: {} });
    s.data.room = code; s.join(code);
    s.emit('room:created', { code });
  });
  s.on('room:join', d => {
    if (!need()) return;
    leave(s); s.data.elo = U().elo;
    const code = String((d && d.code) || ''), r = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !r) return s.emit('room:error', { message: 'Diesen Code gibt es nicht.' });
    if (r.b) return s.emit('room:error', { message: 'Die Party ist schon voll.' });
    r.b = s.id; s.data.room = code; s.join(code);
    s.emit('room:joined', { code });
    const host = sock(r.w); if (host) host.emit('room:ready', { code });
    start(r);
  });
  s.on('room:leave', () => leave(s));

  // ---- Gegnersuche je Bedenkzeit (1, 3, 5 oder 10 Minuten), Elo-nah ----
  s.on('match:join', d => {
    if (!need()) return;
    leave(s); s.data.elo = U().elo;
    const tc = tcOf(d && d.tc);
    let best = -1;
    queue.forEach((q, i) => { if (q.tc === tc && (best < 0 || Math.abs(q.elo - s.data.elo) < Math.abs(queue[best].elo - s.data.elo))) best = i; });
    const q = best >= 0 ? queue.splice(best, 1)[0] : null, o = q && sock(q.id);
    if (!o) { queue.push({ id: s.id, elo: s.data.elo, tc }); return s.emit('queue:waiting'); }
    const [w, b] = Math.random() < 0.5 ? [s, o] : [o, s];
    s.emit('queue:matched', { elo: o.data.elo }); o.emit('queue:matched', { elo: s.data.elo });
    start(newRoom('match', tc, w, b));
  });
  s.on('match:leave', () => { queue = queue.filter(q => q.id !== s.id); });

  // ---- Im Spiel ----
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
    const r = room(), u = U();
    if (!r || !d || !u) return;
    const x = String(d.x || '');
    s.to(r.code).emit('game:look', { t: Number(d.t) | 0, c: String(d.c || '').slice(0, 9), x: SHOP[x] && u.owned.includes(x) ? x : '' });
  });
  s.on('game:over', d => { const r = room(); if (r) claim(r, s, d && d.res); });

  // ---- Freunde und Herausforderungen ----
  const sendList = () => { const u = U(); if (u) s.emit('friend:list', { list: friendRows(u), keys: u.fr }); };
  s.on('friend:list', sendList);
  s.on('friend:add', d => {
    const u = U(); if (!u) return;
    const k = String((d && d.name) || '').trim().toLowerCase(), t = users[k], err = m => s.emit('friend:error', { message: m });
    if (!k) return err('Bitte einen Namen eingeben.');
    if (!t) return err('Diesen Spieler gibt es nicht.');
    if (t === u) return err('Das bist du selbst.');
    if (u.fr.includes(k)) return err('Der Spieler ist schon in deiner Liste.');
    if (u.fr.length >= 100) return err('Maximal 100 Freunde.');
    u.fr.push(k); saveUsers(); sendList();
    s.emit('friend:ok', { message: t.name + ' wurde hinzugefügt.' });
  });
  s.on('friend:del', d => { const u = U(); if (!u) return; const k = String((d && d.name) || '').toLowerCase(); u.fr = u.fr.filter(x => x !== k); saveUsers(); sendList(); });
  s.on('invite:send', d => {
    const u = U(); if (!u) return;
    const k = String((d && d.name) || '').toLowerCase(), t = users[k], res = (ok2, msg) => s.emit('invite:result', { ok: ok2, msg });
    if (!t || !u.fr.includes(k)) return res(false, 'Nur Freunde können herausgefordert werden.');
    if (s.data.room) return res(false, 'Du bist gerade in einem Spiel.');
    const targets = onSocks(k).filter(x => !x.data.room);
    if (!targets.length) return res(false, t.name + ' ist gerade offline oder im Spiel.');
    const id = crypto.randomBytes(6).toString('hex'), tc = tcOf(d && d.tc);
    invites.set(id, { from: s.id, tk: k, tc });
    targets.forEach(x => x.emit('invite:incoming', { id, n: u.name, a: u.av | 0, e: u.elo, tc }));
    res(true, 'Anfrage an ' + t.name + ' gesendet …');
    setTimeout(() => { if (invites.delete(id)) res(false, t.name + ' hat nicht geantwortet.'); }, 60000);
  });
  s.on('invite:reply', d => {
    const id = String((d && d.id) || ''), u = U(), inv = invites.get(id);
    if (!u || !inv || low(u) !== inv.tk) return;
    invites.delete(id);
    const a = sock(inv.from);
    if (!d.accept) return a && a.emit('invite:result', { ok: false, msg: u.name + ' hat abgelehnt.' });
    if (!a || !a.data.user || a.data.room || s.data.room) {
      s.emit('invite:result', { ok: false, msg: 'Die Anfrage ist nicht mehr gültig.' });
      return a && a.emit('invite:result', { ok: false, msg: 'Die Anfrage ist nicht mehr gültig.' });
    }
    const [w, b] = Math.random() < 0.5 ? [a, s] : [s, a];
    start(newRoom('friend', inv.tc, w, b));      // Freundes-Spiel: kein Elo, kein Gold
  });

  s.on('disconnect', () => { leave(s); offline(s); });
});

const PORT = process.env.PORT || 3000;
loadUsers().then(() => web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT)));

module.exports = { web };
