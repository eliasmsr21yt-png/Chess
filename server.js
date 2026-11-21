// Schach-Server: liefert die App aus und verbindet Spieler (Socket.IO)
const http = require('http'), fs = require('fs'), path = require('path');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

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
const PARTY_KEY = 'chess:parties';
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
process.on('SIGTERM', async () => {
  await Promise.race([Promise.all([flush(), persistPartiesNow()]), new Promise(r => setTimeout(r, 8000))]);
  process.exit(0);
});   // Render beendet den Server: Konten und Partys vorher speichern

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
function leave(s, explicit = false) {
  queue = queue.filter(q => q.id !== s.id);
  const code = s.data.room;
  if (!code) return;
  s.data.room = null;
  s.leave(code);
  const r = rooms.get(code);
  if (!r) return;
  if (r.kind === 'party') {
    const p = r.players.find(x => x.id === s.id);
    if (p) {
      p.id = null;
      p.connected = false;
      p.lastSeen = Date.now();
      if (explicit) {
        r.teams = r.teams || { w: [], b: [] };
        // Team-Partien bleiben offen: der Leiter kann den freien Platz mit
        // einem anderen Party-Mitglied besetzen. Einzelpartien werden gewertet.
        r.teams.w = (r.teams.w || []).filter(k => k !== p.key);
        r.teams.b = (r.teams.b || []).filter(k => k !== p.key);
        for (const g of Object.values(r.matches || {})) {
          if (g.status !== 'playing') continue;
          if (g.kind === 'team') {
            const side = g.white.includes(p.key) ? 'w' : g.black.includes(p.key) ? 'b' : null;
            if (side) {
              const roster = side === 'w' ? g.white : g.black;
              // Entferne nur dann sofort, wenn noch ein Teammitglied übrig ist.
              // Bei letzter Person bleibt der Platz reserviert, bis der Leiter ersetzt.
              if (roster.length > 1) {
                const oldIndex = roster.indexOf(p.key);
                roster.splice(oldIndex, 1);
                const next = g.turnIndex[side] || 0;
                g.turnIndex[side] = roster.length ? Math.max(0, next - (oldIndex < next ? 1 : 0)) % roster.length : 0;
              }
              notifyPartyGameUpdate(r, g);
            }
          } else if (g.white.includes(p.key)) finishPartyMatch(r, g, 'b', 'Spieler hat die Party verlassen');
          else if (g.black.includes(p.key)) finishPartyMatch(r, g, 'w', 'Spieler hat die Party verlassen');
        }
        if (r.ffa && !r.ffa.over && ffaOwnerAlive(r.ffa, p.key)) {
          const f = r.ffa, victim = f.players.find(x => x.key === p.key);
          if (victim) victim.alive = false;
          f.board = f.board.map(piece => piece && piece.owner === p.key ? null : piece);
          const oldOrder = f.order.slice(), oldTurnKey = f.order[f.turnIndex];
          f.order = f.order.filter(k => k !== p.key);
          if (f.order.length <= 1) { f.over = true; f.winner = f.order[0] || null; }
          else if (oldTurnKey === p.key) {
            const nextKey = oldOrder.slice(f.turnIndex + 1).concat(oldOrder.slice(0, f.turnIndex)).find(k => f.order.includes(k));
            f.turnIndex = Math.max(0, f.order.indexOf(nextKey));
          } else f.turnIndex = Math.max(0, f.order.indexOf(oldTurnKey));
          sendFFA(r);
        }
        r.players = r.players.filter(x => x.key !== p.key);
      }
      if (r.host === p.key && explicit) r.host = r.players.find(x => x.connected)?.key || (r.players[0] ? r.players[0].key : null);
    }
    if (!r.players.length) rooms.delete(code);
    else {
      // Laufende Spiele bleiben bestehen. Bei Verbindungsabbruch kann derselbe
      // Account mit seinem Namen wieder beitreten.
      if (explicit && !r.players.length) rooms.delete(code);
      else emitParty(r);
    }
    saveParties();
    return;
  }
  if (r.kind === 'match' && (r.moves || 0) >= 8 && !r.done) {
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
const TCS = [1, 3, 5, 10, 15, 30];             // Bedenkzeiten in Minuten
const BOT_R = [20, 60, 120, 250, 500];           // Gold beim ersten Sieg gegen Bot-Stufe 1 bis 5
const byKey = {};                                // Name (klein) -> Sockets (für Online-Status)
const invites = new Map();
const low = u => u.name.toLowerCase();
const tcOf = v => (TCS.includes(+v) ? +v : int(v, 1, 180, 5));
const int = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Math.round(+v) || def));
const onSocks = k => (byKey[k] || []).filter(x => x.connected !== false);
const offline = s => { const u = s.data.user; if (!u) return; const a = byKey[low(u)]; if (a) { const i = a.indexOf(s); if (i >= 0) a.splice(i, 1); } };
const friendRows = u => (u.fr || []).map(k => { const f = users[k]; if (!f) return null; const so = onSocks(k); return { n: f.name, e: f.elo, a: f.av | 0, on: so.length > 0, busy: so.length > 0 && so.every(x => x.data.room) }; }).filter(Boolean);
function newRoom(kind, tc, a, b) {
  const code = code6();
  rooms.set(code, { code, kind, tc, w: a.id, b: b.id, fen: new Chess().fen(), res: {}, e: { [a.id]: a.data.elo, [b.id]: b.data.elo }, u: { [a.id]: a.data.user, [b.id]: b.data.user } });
  for (const x of [a, b]) { x.data.room = code; x.join(code); }
  return rooms.get(code);
}


// ---- Mehrspieler-Partys: getrennte Matches, Turnier, Teams und FFA ----
const PARTY_MODES = new Set(['normal', 'tournament', 'ffa', 'team']);
const FFA_COLORS = ['#2979ff', '#ff1744', '#00c853', '#ff9100'];
const FFA_BACK = 'rnbqkbnr';
const idxSquare = i => 'abcdefgh'[i & 7] + String(8 - (i >> 3));
const keyOf = name => String(name || '').trim().toLowerCase();
const randomId = () => crypto.randomBytes(5).toString('hex');
const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const chessFrom = fen => { const c = new Chess(); if (fen) c.load(fen); return c; };
const playerIn = (r, key) => r.players.find(p => p.key === key);
const socketForKey = (r, key) => { const p = playerIn(r, key); return p && p.id ? sock(p.id) : null; };
const currentSide = g => (g.fen || '').split(' ')[1] === 'b' ? 'b' : 'w';
function partyClock(g, now = Date.now()) {
  const side = currentSide(g);
  if (g.status === 'playing' && g.clock && g.lastTick) {
    const dt = Math.max(0, now - g.lastTick);
    g.clock[side] = Math.max(0, g.clock[side] - dt);
    g.lastTick = now;
  }
  return { w: Math.max(0, g.clock?.w || 0), b: Math.max(0, g.clock?.b || 0) };
}
function nextTeamActor(g, side) {
  const team = side === 'w' ? g.white : g.black;
  if (!team || !team.length) return null;
  return team[(g.turnIndex[side] || 0) % team.length];
}
function publicMatch(r, g) {
  const c = partyClock(g);
  const side = currentSide(g), actor = nextTeamActor(g, side);
  return {
    id: g.id, kind: g.kind, status: g.status, time: g.tc, white: (g.white || []).map(k => playerIn(r, k)?.name || k),
    black: (g.black || []).map(k => playerIn(r, k)?.name || k), whiteKeys: g.white, blackKeys: g.black,
    fen: g.fen, moveCount: (g.moves || []).length, result: g.result || null, teamConfig: g.kind === 'team' ? (g.teamConfig || r.teamConfig) : null,
    actor: playerIn(r, actor)?.name || actor, side, clock: c, round: g.round || 0
  };
}
function publicFFA(r) {
  const f = r.ffa;
  if (!f) return null;
  return {
    size: f.size,
    board: f.board.map(piece => piece ? {
      owner: playerIn(r, piece.owner)?.name || piece.owner,
      type: piece.type,
      color: f.players.find(p => p.key === piece.owner)?.color || '#fff'
    } : null),
    players: f.players.map(p => ({ name: playerIn(r, p.key)?.name || p.key, color: p.color, alive: p.alive, direction: p.direction })),
    order: f.order.slice(f.turnIndex).concat(f.order.slice(0, f.turnIndex)).map(k => playerIn(r, k)?.name || k),
    turn: playerIn(r, f.order[f.turnIndex])?.name || f.order[f.turnIndex] || null,
    over: !!f.over, winner: f.winner ? (playerIn(r, f.winner)?.name || f.winner) : null,
    history: f.history.slice(-80)
  };
}
function publicParty(r, viewer) {
  const me = viewer && playerIn(r, viewer);
  return {
    code: r.code, host: r.host, me: viewer || null, isHost: !!(viewer && r.host === viewer), mode: r.mode,
    settings: r.settings,
    players: r.players.map(p => ({ name: p.name, key: p.key, elo: p.elo, avatar: p.avatar, connected: !!p.connected,
      team: r.teams?.w?.includes(p.key) ? 'w' : r.teams?.b?.includes(p.key) ? 'b' : '' })),
    pairings: r.pairings || [], teams: r.teams || { w: [], b: [] }, teamConfig: r.teamConfig || { wName: 'Team Weiß', bName: 'Team Schwarz', wColor: '#ffffff', bColor: '#1a1a1a' },
    matches: Object.values(r.matches || {}).map(g => publicMatch(r, g)),
    tournament: r.tournament ? { rounds: r.tournament.rounds, champion: r.tournament.champion, finished: !!r.tournament.finished, current: r.tournament.current } : null,
    ffa: publicFFA(r), started: !!r.started, canStart: !!(me && r.host === viewer)
  };
}
function emitParty(r) {
  if (!r || r.kind !== 'party') return;
  io.to(r.code).emit('room:state', { state: publicParty(r, null) });
  saveParties();
}
function emitPartyTo(s, r, key) {
  s.emit('room:state', { state: publicParty(r, key) });
}
function partySnapshot(r) {
  return {
    code: r.code, kind: 'party', host: r.host, mode: r.mode, settings: r.settings,
    players: r.players.map(p => ({ ...p, id: null, connected: false })),
    pairings: r.pairings || [], teams: r.teams || { w: [], b: [] }, teamConfig: r.teamConfig || { wName: 'Team Weiß', bName: 'Team Schwarz', wColor: '#ffffff', bColor: '#1a1a1a' }, matches: r.matches || {},
    tournament: r.tournament || null, ffa: r.ffa || null, started: !!r.started, updatedAt: Date.now()
  };
}
let partySaveTimer = null;
async function persistPartiesNow() {
  try {
    const data = [...rooms.values()].filter(r => r.kind === 'party' && r.players?.length).map(partySnapshot);
    if (USE_UP && dbOk) await up(['SET', PARTY_KEY, JSON.stringify(data)]);
    else { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, 'parties.json.tmp'), JSON.stringify(data)); fs.renameSync(path.join(DIR, 'parties.json.tmp'), path.join(DIR, 'parties.json')); }
  } catch (e) { console.error('Party-Speicherung fehlgeschlagen:', e.message); }
}
function saveParties() {
  clearTimeout(partySaveTimer);
  partySaveTimer = setTimeout(persistPartiesNow, 250);
}
async function loadParties() {
  try {
    let data = [];
    if (USE_UP && dbOk) {
      const raw = await up(['GET', PARTY_KEY]);
      if (raw) data = JSON.parse(raw);
    } else {
      const file = path.join(DIR, 'parties.json');
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    for (const old of (Array.isArray(data) ? data : [])) {
      if (!old || old.kind !== 'party' || !/^\d{6}$/.test(old.code) || !Array.isArray(old.players)) continue;
      // Sehr alte, verlassene Lobbys werden nicht unbegrenzt wiederhergestellt.
      if (Date.now() - (old.updatedAt || Date.now()) > 7 * 24 * 60 * 60 * 1000) continue;
      old.players = old.players.map(p => ({ ...p, id: null, connected: false }));
      old.matches = old.matches || {}; old.settings = old.settings || { time: 5 }; old.pairings = old.pairings || []; old.teams = old.teams || { w: [], b: [] }; old.teamConfig = old.teamConfig || { wName: 'Team Weiß', bName: 'Team Schwarz', wColor: '#ffffff', bColor: '#1a1a1a' };
      for (const g of Object.values(old.matches)) if (g.status === 'playing') g.lastTick = Date.now();
      rooms.set(old.code, old);
    }
  } catch (e) { console.error('Gespeicherte Partys konnten nicht geladen werden:', e.message); }
}
function addPartyPlayer(r, s, u) {
  const key = keyOf(u.name);
  let p = playerIn(r, key);
  if (!p) {
    if (r.players.length >= 16) return null;
    p = { key, name: u.name, id: s.id, elo: u.elo || 300, avatar: u.av | 0, connected: true, joinedAt: Date.now() };
    r.players.push(p);
  } else {
    if (p.id && p.id !== s.id) {
      const old = sock(p.id);
      if (old) { old.data.room = null; old.leave(r.code); offline(old); old.emit('room:error', { message: 'Dein Account wurde in dieser Party auf einem anderen Tab verbunden.' }); }
    }
    p.id = s.id; p.name = u.name; p.elo = u.elo || 300; p.avatar = u.av | 0; p.connected = true;
  }
  s.data.room = r.code; s.join(r.code);
  return p;
}
function resumeParty(s, u) {
  const key = keyOf(u.name);
  for (const r of rooms.values()) {
    if (r.kind !== 'party' || !playerIn(r, key)) continue;
    const p = addPartyPlayer(r, s, u);
    if (!p) return;
    emitParty(r);
    emitPartyTo(s, r, key);
    const active = Object.values(r.matches || {}).find(g => g.status === 'playing' && [...g.white, ...g.black].includes(key));
    if (active) sendPartyGameStart(s, r, active, key, false);
    if (r.mode === 'ffa' && r.ffa && !r.ffa.over) s.emit('ffa:start', { state: publicFFA(r) });
    return;
  }
}
function notifyPartyGameUpdate(r, g, extra = {}) {
  const side = currentSide(g), actor = nextTeamActor(g, side), clock = partyClock(g);
  io.to(r.code).emit('party:game-update', { gameId: g.id, actor: playerIn(r, actor)?.name || actor, side, clock, status: g.status, result: g.result || null, teamConfig: g.kind === 'team' ? (g.teamConfig || r.teamConfig) : null, ...extra });
}
function sendPartyGameStart(s, r, g, key, spectator) {
  const side = g.white.includes(key) ? 'w' : g.black.includes(key) ? 'b' : 's';
  const opp = side === 'w' ? g.black : side === 'b' ? g.white : g.white;
  const actor = nextTeamActor(g, currentSide(g));
  const myTurn = !spectator && actor === key;
  s.emit('game:start', {
    code: r.code, side, kind: 'party', partyGameId: g.id, partyMode: g.kind, spectator: !!spectator,
    tc: g.tc || r.settings.time, fen: g.fen, moves: g.moves || [], clock: partyClock(g), actor: playerIn(r, actor)?.name || actor, teamConfig: g.kind === 'team' ? (g.teamConfig || r.teamConfig) : null,
    canMove: myTurn, finished: g.status === 'done', result: g.result || null, opp: { n: opp.map(k => playerIn(r, k)?.name || k).join(' + ') || 'Zuschauer', e: 0, a: 0 }
  });
}
function makePartyMatch(r, white, black, meta = {}) {
  const id = randomId(), minutes = Math.max(1, Math.min(180, +r.settings.time || 5)), chess = new Chess();
  const g = {
    id, kind: meta.kind || r.mode, round: meta.round || 0, bracketMatchId: meta.bracketMatchId || null, tc: minutes, teamConfig: (meta.kind || r.mode) === 'team' ? { ...r.teamConfig } : null,
    white: white.slice(), black: black.slice(), fen: chess.fen(), moves: [], status: 'playing', result: null,
    turnIndex: { w: 0, b: 0 }, clock: { w: minutes * 60000, b: minutes * 60000 }, lastTick: Date.now(), createdAt: Date.now()
  };
  r.matches[id] = g;
  for (const key of [...white, ...black]) { const ps = socketForKey(r, key); if (ps) sendPartyGameStart(ps, r, g, key, false); }
  notifyPartyGameUpdate(r, g);
  return g;
}
function setTournamentWinner(r, g, winnerKey, reason) {
  const t = r.tournament; if (!t) return;
  const round = t.rounds[g.round] || [];
  const m = round.find(x => x.gameId === g.id || x.id === g.bracketMatchId);
  if (!m || m.winner) return;
  if (!winnerKey) winnerKey = Math.random() < 0.5 ? g.white[0] : g.black[0];
  m.winner = winnerKey; m.loser = m.w === winnerKey ? m.b : m.w;
  m.result = reason || (winnerKey ? 'Sieg' : 'Remis'); m.status = 'done';
  advanceTournament(r);
}
function advanceTournament(r) {
  const t = r.tournament; if (!t || t.finished) return;
  const round = t.rounds[t.current] || [];
  if (!round.length || round.some(m => !m.winner)) return;
  const winners = round.map(m => m.winner).filter(Boolean);
  if (winners.length <= 1) {
    t.champion = winners[0] || null; t.finished = true; emitParty(r); return;
  }
  const next = []; let pool = winners.slice();
  if (pool.length % 2) { const bye = pool.pop(); next.push({ id: randomId(), w: bye, b: null, winner: bye, bye: true, status: 'done', result: 'Freilos' }); }
  while (pool.length) {
    const w = pool.shift(), b = pool.shift(), id = randomId();
    const m = { id, w, b, winner: null, status: 'playing' };
    next.push(m);
    const g = makePartyMatch(r, [w], [b], { kind: 'tournament', round: t.current + 1, bracketMatchId: id });
    m.gameId = g.id;
  }
  t.rounds.push(next); t.current++;
  emitParty(r);
}
function startTournament(r, keys) {
  const ordered = shuffle(keys), target = 2 ** Math.ceil(Math.log2(ordered.length)), byes = target - ordered.length;
  const first = [];
  for (let i = 0; i < byes; i++) first.push({ id: randomId(), w: ordered[i], b: null, winner: ordered[i], bye: true, status: 'done', result: 'Freilos' });
  const rest = ordered.slice(byes);
  while (rest.length) {
    const w = rest.shift(), b = rest.shift(), id = randomId();
    first.push({ id, w, b, winner: null, status: 'playing' });
  }
  r.tournament = { rounds: [first], current: 0, champion: null, finished: false, createdAt: Date.now() };
  for (const m of first) if (m.b) { const g = makePartyMatch(r, [m.w], [m.b], { kind: 'tournament', round: 0, bracketMatchId: m.id }); m.gameId = g.id; }
  advanceTournament(r);
  emitParty(r);
}
function finishPartyMatch(r, g, winnerSide, reason) {
  if (!g || g.status !== 'playing') return;
  g.status = 'done';
  const winner = winnerSide === 'w' ? g.white[0] : winnerSide === 'b' ? g.black[0] : null;
  g.result = { winnerSide: winnerSide || null, winner, reason: reason || (winner ? 'Sieg' : 'Remis'), at: Date.now() };
  if (g.kind === 'tournament') setTournamentWinner(r, g, winner, g.result.reason);
  notifyPartyGameUpdate(r, g);
  io.to(r.code).emit('party:game-finished', { gameId: g.id, result: g.result });
  emitParty(r);
}
let lastPartyClockPersist = 0;
function tickPartyGames() {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.kind !== 'party') continue;
    let changed = false;
    for (const g of Object.values(r.matches || {})) {
      if (g.status !== 'playing') continue;
      const before = currentSide(g), clock = partyClock(g, now);
      if (clock[before] <= 0) { const c = chessFrom(g.fen), draw = c.isInsufficientMaterial(); finishPartyMatch(r, g, draw ? null : (before === 'w' ? 'b' : 'w'), draw ? 'Zeit abgelaufen · Remis (nicht mattsetzbares Material)' : 'Zeit abgelaufen'); changed = true; }
      else notifyPartyGameUpdate(r, g);
    }
    if (changed) saveParties();
  }
  // Laufende Uhren regelmäßig sichern, damit ein unerwarteter Prozessabbruch
  // nicht die seit dem letzten Zug verstrichene Zeit zurücksetzt.
  if (now - lastPartyClockPersist >= 10000) {
    lastPartyClockPersist = now;
    if ([...rooms.values()].some(r => r.kind === 'party' && Object.values(r.matches || {}).some(g => g.status === 'playing'))) saveParties();
  }
}
setInterval(tickPartyGames, 1000).unref();

// Vier-Seiten-Schach: quadratisches, mit der Spielerzahl wachsendes Brett.
// Der König darf geschlagen werden; dadurch scheidet seine ganze Armee aus.
function makeFFA(r, keys) {
  const size = Math.max(16, 12 + keys.length * 2), board = Array(size * size).fill(null), offset = Math.floor((size - 8) / 2);
  const dirs = ['top', 'right', 'bottom', 'left'];
  const fplayers = keys.map((key, i) => ({ key, color: FFA_COLORS[i], alive: true, direction: dirs[i] }));
  const put = (x, y, owner, type) => { if (x >= 0 && y >= 0 && x < size && y < size) board[y * size + x] = { owner, type }; };
  for (const pl of fplayers) {
    const back = FFA_BACK.split('');
    if (pl.direction === 'top') {
      back.forEach((t, i) => put(offset + i, 0, pl.key, t)); put(offset + 3, 1, pl.key, 'p'); put(offset + 4, 1, pl.key, 'p');
    } else if (pl.direction === 'bottom') {
      back.forEach((t, i) => put(offset + i, size - 1, pl.key, t)); put(offset + 3, size - 2, pl.key, 'p'); put(offset + 4, size - 2, pl.key, 'p');
    } else if (pl.direction === 'left') {
      back.forEach((t, i) => put(0, offset + i, pl.key, t)); put(1, offset + 3, pl.key, 'p'); put(1, offset + 4, pl.key, 'p');
    } else {
      back.forEach((t, i) => put(size - 1, offset + i, pl.key, t)); put(size - 2, offset + 3, pl.key, 'p'); put(size - 2, offset + 4, pl.key, 'p');
    }
  }
  r.ffa = { size, board, players: fplayers, order: keys.slice(), turnIndex: 0, over: false, winner: null, history: [], startedAt: Date.now() };
  r.started = true;
}
function ffaOwnerAlive(f, key) { const p = f.players.find(x => x.key === key); return !!(p && p.alive); }
function ffaPathClear(f, x1, y1, x2, y2) {
  const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1); let x = x1 + dx, y = y1 + dy;
  while (x !== x2 || y !== y2) { if (f.board[y * f.size + x]) return false; x += dx; y += dy; }
  return true;
}
function ffaLegal(f, owner, from, to) {
  const n = f.size, b = f.board;
  if (![from, to].every(v => Number.isInteger(v) && v >= 0 && v < n * n) || from === to) return false;
  const a = b[from], z = b[to]; if (!a || a.owner !== owner || (z && z.owner === owner)) return false;
  const x1 = from % n, y1 = Math.floor(from / n), x2 = to % n, y2 = Math.floor(to / n), dx = x2 - x1, dy = y2 - y1;
  const pl = f.players.find(p => p.key === owner), dir = pl?.direction;
  const forward = dir === 'top' ? [0, 1] : dir === 'bottom' ? [0, -1] : dir === 'left' ? [1, 0] : [-1, 0];
  const ax = Math.abs(dx), ay = Math.abs(dy), type = a.type;
  if (type === 'n') return (ax === 1 && ay === 2) || (ax === 2 && ay === 1);
  if (type === 'k') return Math.max(ax, ay) === 1;
  if (type === 'p') {
    const dot = dx * forward[0] + dy * forward[1];
    const cross = Math.abs(dx * forward[1] - dy * forward[0]);
    if (!z) return dot === 1 && cross === 0;
    return dot === 1 && cross === 1;
  }
  const diagonal = ax === ay && ax > 0, straight = (dx === 0) !== (dy === 0);
  if (type === 'b' && !diagonal) return false;
  if (type === 'r' && !straight) return false;
  if (type === 'q' && !diagonal && !straight) return false;
  if (!diagonal && !straight) return false;
  return ffaPathClear(f, x1, y1, x2, y2);
}
function ffaNextTurn(f) {
  if (f.over) return;
  for (let i = 0; i < f.order.length; i++) {
    f.turnIndex = (f.turnIndex + 1) % f.order.length;
    if (ffaOwnerAlive(f, f.order[f.turnIndex])) return;
  }
}
function sendFFA(r) { io.to(r.code).emit('ffa:state', { state: publicFFA(r) }); saveParties(); }

io.on('connection', s => {
  s.data.room = null; s.data.elo = 300;
  s.emit('server:info', { persist: persistOK() });
  const U = () => s.data.user, room = () => rooms.get(s.data.room);
  const need = () => { if (U()) return true; s.emit('room:error', { message: 'Bitte zuerst anmelden.' }); return false; };

  const ok = (u, resume = true) => {
    if (u.v !== 3) { if (!(u.v >= 2)) u.elo = 300; u.v = 3; u.coins = 0; u.bots = u.bots || []; u.fr = u.fr || []; u.av = u.av | 0; saveUsers(); }   // Gold startet bei 0
    s.data.user = u; s.data.elo = u.elo;
    const k = low(u); byKey[k] = byKey[k] || []; if (!byKey[k].includes(s)) byKey[k].push(s);
    s.emit('auth:ok', { token: u.tok, profile: pub(u), shop: SHOP, cred: { salt: u.salt, hash: u.hash }, persist: persistOK(), fr: u.fr });
    if (resume) resumeParty(s, u);
  };

  // ---- Konto ----
  s.on('auth:register', d => {
    const n = String((d && d.name) || '').trim(), p = String((d && d.pass) || ''), k = n.toLowerCase();
    if (!NAME_RE.test(n)) return s.emit('auth:fail', { message: 'Name: 3 bis 16 Zeichen (Buchstaben, Zahlen, _ . -).' });
    if (p.length < 4) return s.emit('auth:fail', { message: 'Passwort: mindestens 4 Zeichen.' });
    if (users[k] || ghosts[k]) return s.emit('auth:fail', { message: 'Dieser Name ist schon vergeben. Ist es dein Name? Dann melde dich an.' });
    const salt = crypto.randomBytes(8).toString('hex');
    const u = users[k] = { name: n, salt, hash: hash(p, salt), tok: crypto.randomBytes(24).toString('hex'), coins: 0, elo: 300, owned: [], presets: [], av: 0, v: 3, bots: [], fr: [] };
    saveUsers(); ok(u, !(d && d.noPartyResume));
  });
  s.on('auth:login', d => {
    const u = users[String((d && d.name) || '').trim().toLowerCase()];
    if (!u || hash(String(d.pass || ''), u.salt) !== u.hash) return s.emit('auth:fail', { message: 'Name oder Passwort stimmt nicht.' });
    ok(u, !(d && d.noPartyResume));
  });
  s.on('auth:token', d => {
    const u = users[String((d && d.name) || '').toLowerCase()];
    if (!u || u.tok !== (d && d.token)) return s.emit('auth:fail', { silent: true });
    ok(u, !(d && d.noPartyResume));
  });
  s.on('auth:logout', () => { leave(s, true); offline(s); s.data.user = null; });

  // Konto nach Server-Neustart vom Gerät wiederherstellen (Name muss frei sein)
  s.on('auth:restore', d => {
    d = d || {};
    const n = String(d.name || '').trim(), k = n.toLowerCase(), p = d.profile || {};
    if (!NAME_RE.test(n) || !/^[0-9a-f]{16}$/.test(d.salt) || !/^[0-9a-f]{64}$/.test(d.hash) || !/^[0-9a-f]{48}$/.test(d.token))
      return s.emit('auth:fail', { message: 'Konto konnte nicht wiederhergestellt werden.' });
    if (users[k]) return users[k].tok === d.token ? ok(users[k], !(d && d.noPartyResume)) : s.emit('auth:fail', { message: 'Dein Name ist inzwischen vergeben. Melde dich an oder wähle einen neuen Namen.' });
    const owned = [...new Set((Array.isArray(p.owned) ? p.owned : []).filter(id => SHOP[id]))];
    const bots = [...new Set((Array.isArray(p.bots) ? p.bots : []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x < BOT_R.length))];
    const cand = { name: n, coins: Math.max(0, Math.round(+p.coins) || 0), elo: int(p.elo, 100, 3000, 300), owned, bots };
    const good = !!KSEC && p.sg === pSig(cand);     // vom Server unterschrieben: nichts wurde verändert, alles wird 1:1 wiederhergestellt
    const u = users[k] = { name: n, salt: d.salt, hash: d.hash, tok: d.token,
      coins: p.v === 3 ? (good ? cand.coins : Math.min(cand.coins, 1000)) : 0, elo: p.v >= 2 ? (good ? cand.elo : Math.min(cand.elo, 600)) : 300,
      owned, bots: p.v === 3 || good ? bots : [], presets: cleanPresets(p.presets), av: int(p.av, 0, 23, 0), v: 3,
      fr: [...new Set((Array.isArray(d.fr) ? d.fr : []).map(x => String(x).toLowerCase()).filter(x => NAME_RE.test(x) && x !== k))].slice(0, 100) };
    delete ghosts[k]; saveUsers(); ok(u, !(d && d.noPartyResume));
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

  // ---- Private Party: Multiplayer-Lobby (der Leiter verwaltet alle Einstellungen) ----
  s.on('room:create', d => {
    if (!need()) return;
    if (s.data.room) leave(s, true);
    const code = code6(), key = keyOf(U().name);
    const r = { code, kind: 'party', host: key, mode: 'normal', settings: { time: tcOf(d && d.tc) },
      players: [{ key, name: U().name, id: s.id, elo: U().elo, avatar: U().av | 0, connected: true, joinedAt: Date.now() }],
      pairings: [], teams: { w: [], b: [] }, teamConfig: { wName: 'Team Weiß', bName: 'Team Schwarz', wColor: '#ffffff', bColor: '#1a1a1a' }, matches: {}, tournament: null, ffa: null, started: false, updatedAt: Date.now() };
    rooms.set(code, r); s.data.room = code; s.join(code);
    s.emit('room:created', { code }); emitParty(r); emitPartyTo(s, r, key);
  });
  s.on('room:join', d => {
    if (!need()) return;
    const code = String((d && d.code) || ''), r = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !r || r.kind !== 'party') return s.emit('room:error', { message: 'Diesen Party-Code gibt es nicht mehr.' });
    if (s.data.room === code) { emitPartyTo(s, r, keyOf(U().name)); return; }
    const joinKey = keyOf(U().name);
    if (!playerIn(r, joinKey) && r.players.length >= 16) return s.emit('room:error', { message: 'Die Party ist voll (maximal 16 Spieler).' });
    if (s.data.room) leave(s, true);
    const p = addPartyPlayer(r, s, U());
    if (!p) return s.emit('room:error', { message: 'Die Party ist voll (maximal 16 Spieler).' });
    s.emit('room:joined', { code }); emitParty(r); emitPartyTo(s, r, p.key);
    const active = Object.values(r.matches || {}).find(g => g.status === 'playing' && [...g.white, ...g.black].includes(p.key));
    if (active) sendPartyGameStart(s, r, active, p.key, false);
    if (r.mode === 'ffa' && r.ffa && !r.ffa.over) s.emit('ffa:start', { state: publicFFA(r) });
  });
  s.on('room:state:get', () => { const r = room(); if (r && r.kind === 'party') emitPartyTo(s, r, keyOf(U().name)); });
  s.on('room:leave', () => leave(s, true));
  s.on('room:update', d => {
    const r = room(), key = U() && keyOf(U().name);
    if (!r || r.kind !== 'party' || r.host !== key) return s.emit('room:error', { message: 'Nur der Party-Leiter darf Einstellungen ändern.' });
    if (Object.values(r.matches || {}).some(g => g.status === 'playing') || (r.ffa && !r.ffa.over)) return s.emit('room:error', { message: 'Während laufender Spiele können die Modi nicht gewechselt werden.' });
    const mode = String(d && d.mode || r.mode), changed = PARTY_MODES.has(mode) && mode !== r.mode;
    if (changed) r.mode = mode;
    if (d && d.time !== undefined) r.settings.time = int(d.time, 1, 180, r.settings.time || 5);
    if (changed) { r.started = false; r.tournament = null; r.ffa = null; r.pairings = []; r.teams = { w: [], b: [] }; }
    emitParty(r);
  });
  s.on('room:pairings', d => {
    const r = room(), key = U() && keyOf(U().name);
    if (!r || r.kind !== 'party' || r.host !== key || r.mode !== 'normal') return;
    if (Object.values(r.matches || {}).some(g => g.status === 'playing')) return s.emit('room:error', { message: 'Paarungen können während laufender Partien nicht geändert werden.' });
    const pairs = Array.isArray(d && d.pairs) ? d.pairs.slice(0, 8) : [], used = new Set(), cleanPairs = [];
    for (const pair of pairs) {
      const w = keyOf(pair && pair.w), b = keyOf(pair && pair.b);
      if (!w || !b || w === b || !playerIn(r, w) || !playerIn(r, b) || used.has(w) || used.has(b)) continue;
      used.add(w); used.add(b); cleanPairs.push({ w, b });
    }
    r.pairings = cleanPairs; emitParty(r);
  });
  s.on('room:teams', d => {
    const r = room(), key = U() && keyOf(U().name);
    if (!r || r.kind !== 'party' || r.host !== key || r.mode !== 'team') return;
    const available = new Set(r.players.filter(p => p.connected).map(p => p.key));
    const w = [...new Set((Array.isArray(d && d.w) ? d.w : []).map(keyOf).filter(k => available.has(k)))];
    const b = [...new Set((Array.isArray(d && d.b) ? d.b : []).map(keyOf).filter(k => available.has(k) && !w.includes(k)))];
    const liveTeamGame = Object.values(r.matches || {}).some(g => g.kind === 'team' && g.status === 'playing');
    if (liveTeamGame && (!w.length || !b.length)) return s.emit('room:error', { message: 'Während einer laufenden Team-Partie muss jedes Team mindestens einen verbundenen Spieler haben.' });
    r.teams = { w, b };
    const tc = d && d.config || {};
    r.teamConfig = { wName: String(tc.wName || r.teamConfig.wName).replace(/[&<>\"']/g, '').trim().slice(0, 20) || 'Team Weiß', bName: String(tc.bName || r.teamConfig.bName).replace(/[&<>\"']/g, '').trim().slice(0, 20) || 'Team Schwarz',
      wColor: /^#[0-9a-f]{6}$/i.test(tc.wColor || '') ? tc.wColor : r.teamConfig.wColor, bColor: /^#[0-9a-f]{6}$/i.test(tc.bColor || '') ? tc.bColor : r.teamConfig.bColor };
    for (const g of Object.values(r.matches || {})) if (g.kind === 'team' && g.status === 'playing') {
      g.white = w.slice(); g.black = b.slice(); g.teamConfig = { ...r.teamConfig };
      g.turnIndex.w = 0; g.turnIndex.b = 0;
      notifyPartyGameUpdate(r, g);
    }
    emitParty(r);
  });
  s.on('room:start', d => {
    const r = room(), key = U() && keyOf(U().name);
    if (!r || r.kind !== 'party' || r.host !== key) return s.emit('room:error', { message: 'Nur der Party-Leiter kann starten.' });
    const active = Object.values(r.matches || {}).some(g => g.status === 'playing');
    if (active || (r.ffa && !r.ffa.over)) return s.emit('room:error', { message: 'Es läuft bereits ein Spiel.' });
    const connected = r.players.filter(p => p.connected).map(p => p.key);
    if (r.mode === 'normal') {
      const pairs = r.pairings || [];
      if (!pairs.length) return s.emit('room:error', { message: 'Lege zuerst mindestens eine Paarung fest.' });
      const previousMatches = Object.keys(r.matches || {}).length;
      for (const p of pairs) {
        if (!connected.includes(p.w) || !connected.includes(p.b)) continue;
        makePartyMatch(r, [p.w], [p.b], { kind: 'normal' });
      }
      if (Object.keys(r.matches).length === previousMatches) return s.emit('room:error', { message: 'Die ausgewählten Spieler sind nicht mehr verbunden.' });
      r.started = true; emitParty(r);
    } else if (r.mode === 'tournament') {
      const keys = (Array.isArray(d && d.players) ? d.players.map(keyOf) : connected).filter((k, i, a) => playerIn(r, k) && connected.includes(k) && a.indexOf(k) === i);
      if (keys.length < 2) return s.emit('room:error', { message: 'Für ein Turnier werden mindestens zwei verbundene Spieler benötigt.' });
      r.started = true; startTournament(r, keys);
    } else if (r.mode === 'team') {
      let w = r.teams.w.filter(k => connected.includes(k)), b = r.teams.b.filter(k => connected.includes(k));
      if (!w.length || !b.length) return s.emit('room:error', { message: 'Weise mindestens einen verbundenen Spieler jedem Team zu.' });
      if (w.some(k => b.includes(k))) return s.emit('room:error', { message: 'Ein Spieler darf nur in einem Team sein.' });
      const assigned = new Set([...w, ...b]);
      const rest = connected.filter(k => !assigned.has(k));
      rest.forEach((k, i) => (w.length <= b.length ? w : b).push(k));
      r.teams = { w, b }; r.started = true;
      makePartyMatch(r, w, b, { kind: 'team' }); emitParty(r);
    } else if (r.mode === 'ffa') {
      const keys = connected.slice(0, 4);
      if (keys.length < 2) return s.emit('room:error', { message: 'Für Alle gegen Alle werden mindestens zwei verbundene Spieler benötigt.' });
      makeFFA(r, keys); sendFFA(r); io.to(r.code).emit('ffa:start', { state: publicFFA(r) });
    }
  });
  s.on('game:watch', d => {
    const r = room(), key = U() && keyOf(U().name), g = r && r.kind === 'party' && r.matches[String(d && d.gameId || '')];
    if (!g) return s.emit('room:error', { message: 'Diese Partie wurde nicht gefunden.' });
    sendPartyGameStart(s, r, g, key, !g.white.includes(key) && !g.black.includes(key));
  });
  s.on('ffa:move', d => {
    const r = room(), key = U() && keyOf(U().name), f = r && r.kind === 'party' && r.ffa;
    if (!f || f.over || !d) return;
    const current = f.order[f.turnIndex];
    if (current !== key) return s.emit('room:error', { message: 'Du bist gerade nicht an der Reihe.' });
    const from = Number(d.from), to = Number(d.to);
    if (!ffaLegal(f, key, from, to)) return s.emit('room:error', { message: 'Dieser Zug ist nicht erlaubt.' });
    const moving = f.board[from], captured = f.board[to];
    f.board[to] = moving; f.board[from] = null;
    const n = f.size, x = to % n, y = Math.floor(to / n), pl = f.players.find(p => p.key === key);
    if (moving.type === 'p' && ((pl.direction === 'top' && y === n - 1) || (pl.direction === 'bottom' && y === 0) || (pl.direction === 'left' && x === n - 1) || (pl.direction === 'right' && x === 0))) moving.type = 'q';
    let eliminated = null;
    if (captured && captured.type === 'k') {
      const victim = f.players.find(p => p.key === captured.owner);
      if (victim) { victim.alive = false; eliminated = playerIn(r, victim.key)?.name || victim.key; }
      f.board = f.board.map(piece => piece && piece.owner === captured.owner ? null : piece);
      f.order = f.order.filter(k => k !== captured.owner);
      if (f.order.length <= 1) { f.over = true; f.winner = f.order[0] || null; }
      else f.turnIndex = Math.max(0, f.order.indexOf(key));
    }
    f.history.push({ player: playerIn(r, key)?.name || key, from, to, captured: captured ? captured.type : null, eliminated, at: Date.now() });
    if (!f.over) ffaNextTurn(f);
    sendFFA(r);
    emitParty(r);
  });
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

  // ---- Im Spiel: klassische Matches plus servergeprüfte Party-Partien ----
  s.on('game:move', d => {
    const r = room();
    if (!r || !d || !Number.isInteger(d.from) || !Number.isInteger(d.to)) return;
    if (r.kind === 'party') {
      const key = U() && keyOf(U().name), g = r.matches && r.matches[String(d.gameId || '')];
      if (!g || g.status !== 'playing' || d.from < 0 || d.from > 63 || d.to < 0 || d.to > 63) return;
      const side = currentSide(g), expected = nextTeamActor(g, side);
      if (expected !== key || !(side === 'w' ? g.white : g.black).includes(key)) return s.emit('party:game-error', { gameId: g.id, message: 'Du bist nicht der nächste Spieler in deinem Team.' });
      const clocks = partyClock(g);
      if (clocks[side] <= 0) { const c = chessFrom(g.fen), draw = c.isInsufficientMaterial(); finishPartyMatch(r, g, draw ? null : (side === 'w' ? 'b' : 'w'), draw ? 'Zeit abgelaufen · Remis (nicht mattsetzbares Material)' : 'Zeit abgelaufen'); return; }
      try {
        const chess = chessFrom(g.fen), promotion = ['q', 'r', 'b', 'n'].includes(d.promotion) ? d.promotion : 'q';
        const move = chess.move({ from: idxSquare(d.from), to: idxSquare(d.to), promotion });
        if (!move) return s.emit('party:game-error', { gameId: g.id, message: 'Ungültiger Schachzug.' });
        g.fen = chess.fen(); g.moves.push({ from: d.from, to: d.to, promotion: move.promotion || '', san: move.san });
        g.turnIndex[side] = (g.turnIndex[side] || 0) + 1; g.lastTick = Date.now();
        io.to(r.code).emit('game:move', { gameId: g.id, from: d.from, to: d.to, promotion: move.promotion || '', by: s.id });
        if (chess.isCheckmate()) finishPartyMatch(r, g, side, 'Schachmatt');
        else if (chess.isDraw() || chess.isStalemate()) finishPartyMatch(r, g, null, 'Remis');
        else { notifyPartyGameUpdate(r, g); emitParty(r); }
      } catch (e) { s.emit('party:game-error', { gameId: g.id, message: 'Der Zug konnte nicht geprüft werden.' }); }
      return;
    }
    if (d.from < 0 || d.from > 63 || d.to < 0 || d.to > 63) return;
    const side = currentSide(r), actor = side === 'w' ? r.w : r.b;
    if (s.id !== actor) return s.emit('game:error', { message: 'Du bist nicht am Zug.' });
    try {
      const chess = chessFrom(r.fen), promotion = ['q', 'r', 'b', 'n'].includes(d.promotion) ? d.promotion : 'q';
      const move = chess.move({ from: idxSquare(d.from), to: idxSquare(d.to), promotion });
      if (!move) return s.emit('game:error', { message: 'Ungültiger Schachzug.' });
      r.fen = chess.fen();
      r.moves = (r.moves || 0) + 1;
      io.to(r.code).emit('game:move', { from: d.from, to: d.to, promotion: move.promotion || '', by: s.id });
    } catch (e) { s.emit('game:error', { message: 'Ungültiger Schachzug.' }); }
  });
  s.on('game:resign', d => {
    const r = room();
    if (r && r.kind === 'party') {
      const key = U() && keyOf(U().name), g = r.matches && r.matches[String(d && d.gameId || '')];
      if (!g || g.status !== 'playing') return;
      const side = g.white.includes(key) ? 'w' : g.black.includes(key) ? 'b' : null;
      if (side) finishPartyMatch(r, g, side === 'w' ? 'b' : 'w', 'Aufgegeben');
      return;
    }
    if (r) s.to(r.code).emit('game:resign');
  });
  s.on('game:look', d => {
    const r = room(), u = U();
    if (!r || r.kind === 'party' || !d || !u) return;
    const x = String(d.x || '');
    s.to(r.code).emit('game:look', { t: Number(d.t) | 0, c: String(d.c || '').slice(0, 9), x: SHOP[x] && u.owned.includes(x) ? x : '' });
  });
  s.on('game:over', d => { const r = room(); if (r && r.kind !== 'party') claim(r, s, d && d.res); });

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

  s.on('disconnect', () => { leave(s, false); offline(s); });
});

const PORT = process.env.PORT || 3000;
loadUsers().then(loadParties).then(() => web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT)));

module.exports = { web };
