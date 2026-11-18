// Schach-Server: liefert die App aus und verbindet Spieler (Socket.IO)
const http = require('http'), fs = require('fs'), path = require('path');
const { Server } = require('socket.io');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

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
const code6 = () => { let c; do { c = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(c) || parties.has(c)); return c; };


// ---- Erweiterte Mehrspieler-Partys und Spielmodi ----
const parties = new Map();
const PARTY_MODES = ['normal', 'tournament', 'ffa', 'team'];
const PARTY_MAX = 16;
const startBoard = () => ('rnbqkbnrpppppppp' + ' '.repeat(32) + 'PPPPPPPPRNBQKBNR').split('').map(x => x === ' ' ? '' : x);
const other = side => side === 'w' ? 'b' : 'w';
const pkey = s => String(s && s.data && s.data.user && s.data.user.name || '').toLowerCase();
const ptime = v => Math.max(1, Math.min(30, Math.round(Number(v) || 5)));
const partyPath = path.join(DIR, 'parties.json');
let partySaveTimer = null;
const partySafe = p => ({
  code: p.code, host: p.host, mode: p.mode, tc: p.tc, status: p.status,
  players: (p.players || []).map(x => ({ key:x.key, name:x.name, elo:x.elo, av:x.av, connected:!!x.connected, currentGame:x.currentGame || null })),
  pairings: p.pairings || [], tournamentPlayers:p.tournamentPlayers ?? null, teams: p.teams || { w:[], b:[], names:{w:'Team Weiß',b:'Team Schwarz'}, colors:{w:'#f5f5f5',b:'#252a34'} },
  games: (p.games || []).map(g => ({
    code:g.code, kind:g.kind, party:g.party, status:g.status, round:g.round, matchNo:g.matchNo,
    whiteKeys:g.whiteKeys || [], blackKeys:g.blackKeys || [], teamIndex:g.teamIndex || {w:0,b:0},
    board:g.board || startBoard(), turn:g.turn || 'w', castling:g.castling || 'KQkq', ep:g.ep ?? -1, halfmove:g.halfmove || 0,
    history:g.history || [], positions:g.positions || {}, moves:g.moves || 0, tc:g.tc || 0, clock:g.clock ? {remaining:g.clock.remaining,turn:g.clock.turn,lastAt:g.clock.lastAt,ended:g.clock.ended} : null,
    winner:g.winner || null, result:g.result || null
  })),
  tournament:p.tournament || null, ffa:p.ffa || null, createdAt:p.createdAt || Date.now()
});
async function flushParties() {
  clearTimeout(partySaveTimer);
  const data=JSON.stringify([...parties.values()].map(partySafe));
  try {
    if(USE_UP && dbOk) await up(['SET','chess:parties',data]);
    else {fs.mkdirSync(DIR,{recursive:true});fs.writeFileSync(partyPath+'.tmp',data);fs.renameSync(partyPath+'.tmp',partyPath);}
  } catch(e){console.error('Partyspeicherung fehlgeschlagen:',e.message);}
}
function saveParties() {
  clearTimeout(partySaveTimer);
  partySaveTimer=setTimeout(flushParties,180);
}
async function loadParties() {
  let rows = [];
  try {
    if (USE_UP && dbOk) {
      const raw = await up(['GET', 'chess:parties']);
      rows = typeof raw === 'string' ? JSON.parse(raw) : [];
    } else if (fs.existsSync(partyPath)) rows = JSON.parse(fs.readFileSync(partyPath, 'utf8'));
  } catch (e) { console.error('Partys konnten nicht geladen werden:', e.message); }
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || !/^\d{6}$/.test(raw.code) || !Array.isArray(raw.players)) continue;
    const p = { ...raw, players:raw.players.map(x=>({...x, socketId:null, connected:false})), games:raw.games || [], teams:raw.teams || {w:[],b:[],names:{w:'Team Weiß',b:'Team Schwarz'}} };
    p.games = p.games.map(g => ({...g, party:p.code, w:null, b:null, positions:g.positions||{[chPositionKey(g)]:1}, clock:g.clock ? {...g.clock,timer:null} : null}));
    parties.set(p.code,p);
    for (const g of p.games) if (g.status !== 'done' && g.kind !== 'ffa') {
      rooms.set(g.code,g);
      if(g.clock && !g.clock.ended) scheduleClock(g);
    }
  }
}
function partyPlayer(p, key) { return p.players.find(x => x.key === key); }
function renamePartyMember(oldKey,newKey,newName) {
  for(const p of parties.values()) {
    const member=partyPlayer(p,oldKey);if(!member)continue;
    member.key=newKey;member.name=newName;
    if(p.host===oldKey)p.host=newKey;
    const replace=k=>k===oldKey?newKey:k;
    p.pairings=(p.pairings||[]).map(pair=>pair.map(replace));
    if(Array.isArray(p.tournamentPlayers))p.tournamentPlayers=p.tournamentPlayers.map(replace);
    if(p.teams){p.teams.w=(p.teams.w||[]).map(replace);p.teams.b=(p.teams.b||[]).map(replace);}
    for(const g of p.games||[]) {
      g.whiteKeys=(g.whiteKeys||[]).map(replace);g.blackKeys=(g.blackKeys||[]).map(replace);
      if(g.winner&&g.winner.key===oldKey)g.winner.key=newKey;
    }
    if(p.tournament) {
      if(p.tournament.champion===oldKey)p.tournament.champion=newKey;
      for(const round of p.tournament.rounds||[])for(const match of round.matches||[]) {
        match.white=replace(match.white);match.black=replace(match.black);match.winner=replace(match.winner);
      }
    }
    if(p.ffa) {
      p.ffa.players=(p.ffa.players||[]).map(x=>x.key===oldKey?{...x,key:newKey,name:newName}:x);
      p.ffa.order=(p.ffa.order||[]).map(replace);p.ffa.alive=(p.ffa.alive||[]).map(replace);
      p.ffa.offline=(p.ffa.offline||[]).map(replace);if(p.ffa.winner===oldKey)p.ffa.winner=newKey;
      p.ffa.board=(p.ffa.board||[]).map(x=>x&&x.owner===oldKey?{...x,owner:newKey}:x);
    }
    broadcastParty(p);
    if(p.ffa)io.to('party:'+p.code).emit('ffa:state',ffaPublic(p.ffa));
    for(const g of p.games||[])if(g.kind==='team'&&g.status==='running')io.to(g.code).emit('game:turn',partyTurnView(p,g));
  }
}
function partySnapshot(p) {
  return {
    code:p.code, host:p.host, isHost:false, mode:p.mode, tc:p.tc, status:p.status,
    players:p.players.map(x=>({key:x.key,name:x.name,elo:x.elo,av:x.av,connected:!!x.connected,currentGame:x.currentGame||null,isHost:x.key===p.host})),
    pairings:p.pairings || [], tournamentPlayers:p.tournamentPlayers ?? null, teams:p.teams || {w:[],b:[],names:{w:'Team Weiß',b:'Team Schwarz'},colors:{w:'#f5f5f5',b:'#252a34'}},
    games:(p.games||[]).map(g=>({code:g.code,kind:g.kind,round:g.round,matchNo:g.matchNo,status:g.status,white:(g.whiteKeys||[]).map(k=>partyPlayer(p,k)?.name||k),black:(g.blackKeys||[]).map(k=>partyPlayer(p,k)?.name||k),winner:g.winner ? (partyPlayer(p,g.winner.key)?.name||g.winner.key) : null,result:g.result})),
    tournament:p.tournament ? {rounds:p.tournament.rounds,champion:p.tournament.champion,finished:!!p.tournament.finished} : null,
    ffa:p.ffa ? ffaPublic(p.ffa) : null
  };
}
function broadcastParty(p) {
  const v=partySnapshot(p);
  io.to('party:'+p.code).emit('party:state',v);
  saveParties();
}
function addPartyMember(p,s) {
  const key=pkey(s); if(!key) return null;
  let m=partyPlayer(p,key);
  if (!m) {
    if (p.players.length >= PARTY_MAX) return null;
    m={key,name:s.data.user.name,elo:s.data.user.elo,av:s.data.user.av|0,connected:true,socketId:s.id,currentGame:null};
    p.players.push(m);
  } else {
    m.name=s.data.user.name; m.elo=s.data.user.elo; m.av=s.data.user.av|0; m.connected=true; m.socketId=s.id;
  }
  s.data.party=p.code; s.join('party:'+p.code);
  // Eine ausdrücklich gespeicherte Turnierauswahl bleibt verbindlich; neue Gäste
  // werden nicht stillschweigend nach der Auslosung in das Turnier aufgenommen.
  if(p.mode==='team') {if(!p.teams)p.teams={w:[],b:[],names:{w:'Team Weiß',b:'Team Schwarz'},colors:{w:'#f5f5f5',b:'#252a34'}};if(!(p.teams.w||[]).includes(key)&&!(p.teams.b||[]).includes(key)){const target=(p.teams.w||[]).length<=(p.teams.b||[]).length?'w':'b';p.teams[target].push(key);}}
  if(p.ffa){p.ffa.offline=(p.ffa.offline||[]).filter(k=>k!==key);}
  // Laufende Partie nach einem Reload wieder aufnehmen.
  const g=(p.games||[]).find(x=>x.status==='running' && ((x.whiteKeys||[]).includes(key)||(x.blackKeys||[]).includes(key)));
  if(g && g.kind!=='ffa') {
    s.data.room=g.code; s.join(g.code);
    const side=g.whiteKeys.includes(key)?'w':'b';
    s.emit('game:start',{code:g.code,side,kind:'party',tc:g.tc||0,clock:g.clock?clockView(g):null,opp:{n:side==='w'?(g.blackKeys||[]).map(k=>partyPlayer(p,k)?.name||k).join(', '):(g.whiteKeys||[]).map(k=>partyPlayer(p,k)?.name||k).join(', '),e:0},canMove:canPartyMove(g,key),partyGame:true,team:g.kind==='team',teamColors:p.teams&&p.teams.colors});
    s.emit('game:sync',{board:g.board,turn:g.turn,castling:g.castling,ep:g.ep,halfmove:g.halfmove,history:g.history||[],clock:g.clock?clockView(g):null});
    s.emit('game:turn',partyTurnView(p,g));
  } else s.data.room=null;
  return m;
}
function partyMemberKeys(p) { return p.players.map(x=>x.key); }
function defaultTeamAssign(p) {
  const keys=partyMemberKeys(p),cut=Math.ceil(keys.length/2);
  p.teams=p.teams||{};p.teams.w=keys.slice(0,cut);p.teams.b=keys.slice(cut);
  p.teams.names=p.teams.names||{w:'Team Weiß',b:'Team Schwarz'};p.teams.colors=p.teams.colors||{w:'#f5f5f5',b:'#252a34'};
}
function validPairings(p, pairs) {
  if(!Array.isArray(pairs)) return null;
  const valid=new Set(partyMemberKeys(p)), seen=new Set(), out=[];
  for(const pair of pairs.slice(0,8)) {
    if(!Array.isArray(pair) || pair.length!==2) continue;
    const [a,b]=pair.map(x=>String(x||'').toLowerCase());
    if(!valid.has(a)||!valid.has(b)||a===b||seen.has(a)||seen.has(b)) continue;
    seen.add(a);seen.add(b);out.push([a,b]);
  }
  return out;
}
function partyTeamIndex(p,g,side) {
  const list=g[side==='w'?'whiteKeys':'blackKeys']||[];
  if(!list.length)return 0;
  const start=(g.teamIndex&&g.teamIndex[side]||0)%list.length;
  for(let step=0;step<list.length;step++) {
    const index=(start+step)%list.length,member=partyPlayer(p,list[index]);
    if(member&&member.connected)return index;
  }
  return start; // Kein Teammitglied online: die Uhr läuft weiter, Ersatz ist über die Lobby möglich.
}
function canPartyMove(g,key) {
  const side=(g.whiteKeys||[]).includes(key)?'w':(g.blackKeys||[]).includes(key)?'b':null;
  if(!side) return false;
  const list=g[side==='w'?'whiteKeys':'blackKeys']||[];
  const p=g.kind==='team'?parties.get(g.party):null;
  if(g.kind==='team'&&p&&g.teamIndex)g.teamIndex[side]=partyTeamIndex(p,g,side);
  const index=g.kind==='team'&&p?partyTeamIndex(p,g,side):(g.teamIndex&&g.teamIndex[side]||0)%Math.max(1,list.length);
  return !!list.length && list[index]===key && (g.kind!=='team'||!p||!!partyPlayer(p,key)?.connected) && (g.turn||'w')===side;
}
function emitPartyGameStart(p,g) {
  const white=(g.whiteKeys||[]),black=(g.blackKeys||[]);
  for(const key of [...white,...black]) {
    const m=partyPlayer(p,key),x=m && sock(m.socketId);
    if(!x) continue;
    x.data.room=g.code; x.join(g.code); m.currentGame=g.code;
    const side=white.includes(key)?'w':'b';
    const oppKeys=side==='w'?black:white;
    x.emit('game:start',{code:g.code,side,kind:'party',tc:g.tc||0,clock:g.clock?clockView(g):null,
      opp:{n:oppKeys.map(k=>partyPlayer(p,k)?.name||k).join(' + '),e:0},
      canMove:canPartyMove(g,key),partyGame:true,team:g.kind==='team',teamColors:p.teams&&p.teams.colors});
  }
  io.to(g.code).emit('game:turn',partyTurnView(p,g));
  broadcastParty(p);
}
function partyTurnView(p,g) {
  const active={};
  for(const side of ['w','b']) {
    const a=g[side==='w'?'whiteKeys':'blackKeys']||[];
    if(g.kind==='team'&&a.length)g.teamIndex[side]=partyTeamIndex(p,g,side);
    active[side]=a.length ? (partyPlayer(p,a[(g.teamIndex&&g.teamIndex[side]||0)%a.length])?.name||a[0]) : '';
  }
  const party=parties.get(g.party);return {turn:g.turn,active,names:party&&party.teams&&party.teams.names||{w:'Team Weiß',b:'Team Schwarz'},colors:party&&party.teams&&party.teams.colors||{w:'#f5f5f5',b:'#252a34'},canMoveKeys:{
    w:(g.whiteKeys||[]).length?g.whiteKeys[(g.teamIndex&&g.teamIndex.w||0)%g.whiteKeys.length]:'',
    b:(g.blackKeys||[]).length?g.blackKeys[(g.teamIndex&&g.teamIndex.b||0)%g.blackKeys.length]:''
  }};
}
function createPartyGame(p,whiteKeys,blackKeys,kind='normal',round=0,matchNo=0) {
  const code=code6(),tc=ptime(p.tc);
  const g={code,kind:kind==='team'?'team':'party-game',party:p.code,whiteKeys:[...whiteKeys],blackKeys:[...blackKeys],
    w:null,b:null,teamIndex:{w:0,b:0},tc,turn:'w',board:startBoard(),castling:'KQkq',ep:-1,halfmove:0,history:[],moves:0,positions:{},
    status:'running',round,matchNo,winner:null,result:null,res:{},e:{},u:{},createdAt:Date.now()};
  g.positions[chPositionKey(g)]=1;
  if(tc>0){const ms=tc*60000,now=Date.now();g.clock={remaining:{w:ms,b:ms},turn:'w',lastAt:now,ended:false,timer:null};scheduleClock(g);}
  rooms.set(code,g);p.games.push(g);emitPartyGameStart(p,g);return g;
}
function buildTournamentBracket(keys) {
  const shuffled=[...keys];
  for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
  const bracket=2**Math.ceil(Math.log2(shuffled.length)),byeCount=bracket-shuffled.length;
  return {shuffled,byeKeys:shuffled.slice(0,byeCount),pairs:Array.from({length:(shuffled.length-byeCount)/2},(_,i)=>[shuffled[byeCount+i*2],shuffled[byeCount+i*2+1]])};
}
function makeTournament(p) {
  const members=new Set(partyMemberKeys(p));
  const keys=(Array.isArray(p.tournamentPlayers)?p.tournamentPlayers.filter(k=>members.has(k)):partyMemberKeys(p));
  if(keys.length<2) return false;
  const {byeKeys,pairs}=buildTournamentBracket(keys);
  p.tournament={rounds:[],champion:null,finished:false};
  const r={number:1,matches:[]};
  byeKeys.forEach((key,i)=>r.matches.push({id:'bye-'+Date.now()+'-'+i,white:key,black:null,winner:key,bye:true,status:'done'}));
  pairs.forEach((pair,i)=>{const g=createPartyGame(p,[pair[0]],[pair[1]],'tournament',1,i+1);r.matches.push({id:g.code,white:pair[0],black:pair[1],winner:null,bye:false,status:'running'});});
  p.tournament.rounds.push(r);p.status='running';broadcastParty(p);return true;
}
function advanceTournament(p) {
  const t=p.tournament;if(!t||t.finished)return;
  const current=t.rounds[t.rounds.length-1];
  if(!current || current.matches.some(m=>!m.winner)) return;
  const stillPresent=new Set(partyMemberKeys(p));
  const winners=current.matches.map(m=>m.winner).filter(k=>k&&stillPresent.has(k));
  if(winners.length===0){t.champion=null;t.finished=true;p.status='finished';broadcastParty(p);return;}
  if(winners.length===1){t.champion=winners[0];t.finished=true;p.status='finished';broadcastParty(p);return;}
  const next={number:current.number+1,matches:[]};
  for(let i=0;i<winners.length;i+=2) {
    if(i+1>=winners.length){next.matches.push({id:'bye-'+Date.now()+'-'+i,white:winners[i],black:null,winner:winners[i],bye:true,status:'done'});continue;}
    const g=createPartyGame(p,[winners[i]],[winners[i+1]],'tournament',next.number,next.matches.length+1);
    next.matches.push({id:g.code,white:winners[i],black:winners[i+1],winner:null,bye:false,status:'running'});
  }
  t.rounds.push(next);broadcastParty(p);
  if(next.matches.every(m=>m.winner))advanceTournament(p);
}
function finishPartyGame(g,winner,reason) {
  if(!g || g.status==='done') return;
  g.status='done';g.result=reason||'beendet';g.winner=winner?{side:winner,key:(winner==='w'?g.whiteKeys:g.blackKeys)[0]}:null;
  if(g.clock){g.clock.ended=true;clearTimeout(g.clock.timer);g.clock.timer=null;}
  const p=parties.get(g.party);
  if(!p)return;
  for(const k of [...(g.whiteKeys||[]),...(g.blackKeys||[])]) {
    const m=partyPlayer(p,k);if(m&&m.currentGame===g.code)m.currentGame=null;
    const x=m&&sock(m.socketId);if(x&&x.data.room===g.code)x.data.room=null;
  }
  if(p.mode==='tournament' && p.tournament) {
    const round=p.tournament.rounds.find(x=>x.number===g.round);
    const match=round&&round.matches.find(x=>x.id===g.code);
    if(match && !winner) {
      const rematch=createPartyGame(p,[...(g.blackKeys||[])],[...(g.whiteKeys||[])],'tournament',g.round,g.matchNo);
      match.id=rematch.code;match.white=rematch.whiteKeys[0];match.black=rematch.blackKeys[0];match.winner=null;match.status='running';match.result='Remis · Entscheidungsspiel';
    } else if(match){match.winner=(winner==='w'?g.whiteKeys:g.blackKeys)[0];match.status='done';match.result=reason||'';}
    advanceTournament(p);
  } else if(!(p.games||[]).some(x=>x.status==='running')) p.status='lobby';
  io.to(g.code).emit('game:finished',{winner,reason});
  // Spielräume nach dem Ergebnis schließen, damit Clients bei der nächsten Partie
  // keine alten Move-/Turn-Events aus einer vorherigen Partie empfangen.
  const roomIds=io.sockets.adapter&&io.sockets.adapter.rooms&&io.sockets.adapter.rooms.get(g.code);
  for(const id of [...(roomIds||[])]) {
    const x=sock(id);
    if(x&&x.data.room===g.code)x.data.room=null;
    if(x)x.leave(g.code);
  }
  rooms.delete(g.code);
  broadcastParty(p);
}
function partyStart(s,p) {
  if(p.host!==pkey(s))return s.emit('room:error',{message:'Nur der Party-Leiter darf starten oder Einstellungen ändern.'});
  if(p.players.length<2)return s.emit('room:error',{message:'Mindestens zwei Spieler werden benötigt.'});
  if((p.games||[]).some(g=>g.status==='running') || (p.mode==='ffa'&&p.ffa&&!p.ffa.winner))return s.emit('room:error',{message:'In dieser Party läuft bereits ein Spiel. Beende es zuerst.'});
  if(p.mode==='normal') {
    const pairs=validPairings(p,p.pairings||[])||[];
    const chosen=pairs.length?pairs:[];
    const used=new Set();
    for(const pair of chosen) { if(pair.some(k=>used.has(k))) continue;pair.forEach(k=>used.add(k));createPartyGame(p,[pair[0]],[pair[1]],'normal'); }
    if(!chosen.length) {
      const free=partyMemberKeys(p);
      for(let i=0;i+1<free.length;i+=2) createPartyGame(p,[free[i]],[free[i+1]],'normal');
    }
    p.status='running';broadcastParty(p);return;
  }
  if(p.mode==='tournament') {
    if(!makeTournament(p)) return s.emit('room:error',{message:'Für ein Turnier werden mindestens zwei Spieler benötigt.'});
    return;
  }
  if(p.mode==='team') {
    const w=(p.teams&&p.teams.w||[]).filter(k=>partyMemberKeys(p).includes(k));
    const b=(p.teams&&p.teams.b||[]).filter(k=>partyMemberKeys(p).includes(k));
    if(!w.length||!b.length||w.some(k=>b.includes(k)))return s.emit('room:error',{message:'Bitte mindestens einen Spieler jedem Team zuweisen.'});
    const g=createPartyGame(p,w,b,'team');p.status='running';broadcastParty(p);return;
  }
  if(p.mode==='ffa') {
    if(p.players.length<2)return s.emit('room:error',{message:'Für Alle gegen Alle werden mindestens zwei Spieler benötigt.'});
    const state=createFFAState(p);
    p.ffa=state;p.status='running';
    io.to('party:'+p.code).emit('ffa:start',ffaPublic(state));
    broadcastParty(p);return;
  }
  s.emit('room:error',{message:'Unbekannter Spielmodus.'});
}
function ffaPublic(f) {
  if(!f)return null;
  return {size:f.size,board:f.board,players:f.players.map(x=>({...x,connected:!(f.offline||[]).includes(x.key)})),order:f.order,alive:f.alive,turn:f.turn,turnKey:f.order[f.turn]||null,winner:f.winner||null,moves:f.moves||0};
}
const FFA_TYPES=['R','N','B','Q','K','B','N','R','P','P'];
function createFFAState(p) {
  const n=p.players.length,size=Math.max(14,Math.min(26,Math.ceil(Math.sqrt(n))*8+4)),center=(size-1)/2;
  const colors=['#e53935','#1e88e5','#43a047','#f9a825','#8e24aa','#00acc1','#f4511e','#6d4c41','#d81b60','#3949ab','#7cb342','#fb8c00','#00897b','#5e35b1','#c0ca33','#546e7a'];
  const board=Array(size*size).fill(null),players=p.players.map((m,i)=>{
    const a=(Math.PI*2*i/n)-Math.PI/2,rx=Math.cos(a),ry=Math.sin(a);
    let fx=Math.round(-rx),fy=Math.round(-ry);
    if(Math.abs(fx)+Math.abs(fy)!==1){if(Math.abs(rx)>Math.abs(ry)){fx=rx>0?-1:1;fy=0}else{fy=ry>0?-1:1;fx=0}}
    return {key:m.key,name:m.name,color:colors[i],forward:{x:fx,y:fy},alive:true};
  });
  players.forEach((pl,i)=>{
    const a=(Math.PI*2*i/n)-Math.PI/2,rx=Math.cos(a),ry=Math.sin(a),tx=-ry,ty=rx;
    for(let j=0;j<FFA_TYPES.length;j++){
      const offset=(j-4.5)*0.72,rad=Math.max(2,size/2-2);
      let x=Math.round(center+rx*rad+tx*offset),y=Math.round(center+ry*rad+ty*offset);
      x=Math.max(0,Math.min(size-1,x));y=Math.max(0,Math.min(size-1,y));
      let at=y*size+x;
      if(board[at]) {
        // Bei dicht stehenden Spielern wird die nächste freie Zelle auf der eigenen Startkante verwendet.
        let found=-1;for(let d=1;d<size*size;d++){const q=(at+d)%(size*size);if(!board[q]){found=q;break;}}
        if(found>=0)at=found;
      }
      board[at]={type:FFA_TYPES[j],owner:pl.key};
    }
  });
  return {size,board,players,order:players.map(x=>x.key),alive:players.map(x=>x.key),offline:[],turn:0,winner:null,moves:0};
}
function ffaPathClear(board,size,fx,fy,tx,ty) {
  const dx=Math.sign(tx-fx),dy=Math.sign(ty-fy);let x=fx+dx,y=fy+dy;
  while(x!==tx||y!==ty){if(board[y*size+x])return false;x+=dx;y+=dy;}
  return true;
}
function ffaLegal(f,key,from,to) {
  const n=f.size,board=f.board;
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>=n*n||from===to)return false;
  const piece=board[from],target=board[to];if(!piece||piece.owner!==key||target&&target.owner===key)return false;
  const fx=from%n,fy=Math.floor(from/n),tx=to%n,ty=Math.floor(to/n),dx=tx-fx,dy=ty-fy,ax=Math.abs(dx),ay=Math.abs(dy),t=piece.type;
  if(t==='N')return (ax===1&&ay===2)||(ax===2&&ay===1);
  if(t==='K')return Math.max(ax,ay)===1;
  if(t==='P') {
    const pl=f.players.find(x=>x.key===key),vx=pl.forward.x,vy=pl.forward.y;
    if(!target)return dx===vx&&dy===vy;
    const px=-vy,py=vx;
    return (dx===vx+px&&dy===vy+py)||(dx===vx-px&&dy===vy-py);
  }
  const straight=dx===0||dy===0,diag=ax===ay;
  if(t==='R'&&!straight || t==='B'&&!diag || t==='Q'&&!straight&&!diag)return false;
  return ffaPathClear(board,n,fx,fy,tx,ty);
}
function ffaNext(f) {
  if(!f.alive.length)return;
  for(let i=0;i<f.order.length;i++){f.turn=(f.turn+1)%f.order.length;const k=f.order[f.turn];if(f.alive.includes(k)&&!(f.offline||[]).includes(k))return;}
}
function ffaEliminate(p,key) {
  const f=p&&p.ffa;if(!f||!f.alive.includes(key))return;
  f.alive=f.alive.filter(k=>k!==key);f.board=f.board.map(x=>x&&x.owner===key?null:x);f.offline=(f.offline||[]).filter(k=>k!==key);
  if(f.order[f.turn]===key)ffaNext(f);
  if(f.alive.length===1){f.winner=f.alive[0];p.status='finished';const name=f.players.find(x=>x.key===f.winner)?.name;io.to('party:'+p.code).emit('ffa:finished',{winner:f.winner,name});}
  else if(f.alive.length===0){f.winner=null;p.status='finished';}
  io.to('party:'+p.code).emit('ffa:state',ffaPublic(f));saveParties();
}
function ffaMove(p,s,d) {
  const f=p.ffa,key=pkey(s);
  if(!f||f.winner||f.order[f.turn]!==key||!ffaLegal(f,key,Number(d&&d.from),Number(d&&d.to)))return false;
  const piece=f.board[d.from],target=f.board[d.to];
  f.board[d.to]=piece;f.board[d.from]=null;f.moves++;
  if(target&&target.type==='K') {
    f.alive=f.alive.filter(k=>k!==target.owner);
    f.board=f.board.map(x=>x&&x.owner===target.owner?null:x);
  }
  if(f.alive.length===1){f.winner=f.alive[0];p.status='finished';io.to('party:'+p.code).emit('ffa:finished',{winner:f.winner,name:f.players.find(x=>x.key===f.winner)?.name});}
  else ffaNext(f);
  io.to('party:'+p.code).emit('ffa:state',ffaPublic(f));
  saveParties();return true;
}

// Serverseitige klassische Schachprüfung. Die Oberfläche bleibt für Darstellung und Eingabe zuständig.
const CH_N=[[ -2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const CH_D=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
const chWhite=p=>!!p && p===p.toUpperCase();
const chInside=(r,c)=>r>=0&&r<8&&c>=0&&c<8;
function chAttacked(b,s,byWhite) {
  const r=s>>3,c=s&7,g=(y,x)=>chInside(y,x)?b[y*8+x]:'';
  const pr=byWhite?r+1:r-1,P=byWhite?'P':'p',N=byWhite?'N':'n',K=byWhite?'K':'k';
  if(g(pr,c-1)===P||g(pr,c+1)===P)return true;
  for(const [y,x] of CH_N)if(g(r+y,c+x)===N)return true;
  for(const [y,x] of CH_D)if(g(r+y,c+x)===K)return true;
  for(let i=0;i<8;i++){let y=r+CH_D[i][0],x=c+CH_D[i][1];while(chInside(y,x)){const q=b[y*8+x];if(q){if(chWhite(q)===byWhite){const t=q.toLowerCase();if(t==='q'||(i<4?t==='r':t==='b'))return true;}break;}y+=CH_D[i][0];x+=CH_D[i][1];}}
  return false;
}
function chPseudo(g) {
  const b=g.board,w=g.turn==='w',out=[];
  for(let s=0;s<64;s++){const p=b[s];if(!p||chWhite(p)!==w)continue;const t=p.toLowerCase(),r=s>>3,c=s&7,add=(to,x={})=>out.push({from:s,to,...x});
    if(t==='p'){const d=w?-1:1,last=r+d===(w?0:7),addP=(to,x={})=>{if(last)for(const pr of ['q','r','b','n'])add(to,{...x,promotion:pr});else add(to,x);};
      if(!b[s+d*8]){addP(s+d*8);if(r===(w?6:1)&&!b[s+d*16])add(s+d*16,{double:true});}
      for(const dc of [-1,1]){const x=c+dc;if(x<0||x>7)continue;const to=s+d*8+dc;if(b[to]&&chWhite(b[to])!==w)addP(to);else if(to===g.ep)add(to,{ep:true});}
    } else if(t==='n'||t==='k'){
      for(const [dy,dx] of (t==='n'?CH_N:CH_D)){const y=r+dy,x=c+dx;if(!chInside(y,x))continue;const q=b[y*8+x];if(!q||chWhite(q)!==w)add(y*8+x);}
      if(t==='k' && s===(w?60:4) && !chAttacked(b,s,!w)) {
        const row=w?7:0,rights=g.castling||'KQkq',short=w?'K':'k',long=w?'Q':'q';
        if(rights.includes(short)&&!b[row*8+5]&&!b[row*8+6]&&!chAttacked(b,row*8+5,!w)&&!chAttacked(b,row*8+6,!w))add(row*8+6,{castle:'K'});
        if(rights.includes(long)&&!b[row*8+1]&&!b[row*8+2]&&!b[row*8+3]&&!chAttacked(b,row*8+3,!w)&&!chAttacked(b,row*8+2,!w))add(row*8+2,{castle:'Q'});
      }
    } else {for(let i=t==='b'?4:0;i<(t==='r'?4:8);i++){let y=r+CH_D[i][0],x=c+CH_D[i][1];while(chInside(y,x)){const q=b[y*8+x];if(q){if(chWhite(q)!==w)add(y*8+x);break;}add(y*8+x);y+=CH_D[i][0];x+=CH_D[i][1];}}}
  }
  return out;
}
function chApply(g,m) {
  const b=g.board.slice(),p=b[m.from],w=chWhite(p),cap=b[m.to];
  b[m.to]=m.promotion?(w?m.promotion.toUpperCase():m.promotion):p;b[m.from]='';
  if(m.ep)b[m.to+(w?8:-8)]='';
  if(m.castle==='K'){const row=w?7:0;b[row*8+5]=w?'R':'r';b[row*8+7]='';}
  if(m.castle==='Q'){const row=w?7:0;b[row*8+3]=w?'R':'r';b[row*8]='';}
  let castling=g.castling||'KQkq';
  const cr={0:['q'],7:['k'],56:['Q'],63:['K'],4:['k','q'],60:['K','Q']};
  for(const sq of [m.from,m.to])if(cr[sq])for(const right of cr[sq])castling=castling.replace(right,'');
  return {...g,board:b,turn:other(g.turn),ep:m.double?(m.from+m.to)/2:-1,castling,halfmove:(p.toLowerCase()==='p'||cap||m.ep)?0:(g.halfmove||0)+1};
}
function chLegal(g) {
  const w=g.turn==='w';
  return chPseudo(g).filter(m=>{if(g.board[m.to]&&g.board[m.to].toLowerCase()==='k')return false;const n=chApply(g,m),k=n.board.indexOf(w?'K':'k');return k>=0&&!chAttacked(n.board,k,!w);});
}
function chApplyMove(g,d) {
  const m=chLegal(g).find(x=>x.from===Number(d.from)&&x.to===Number(d.to)&&(!x.promotion||(x.promotion===(d.promotion||'q'))));
  return m?{state:chApply(g,m),move:m}:null;
}
function chPositionKey(g) { return (g.board||[]).map(x=>x||'-').join('')+(g.turn||'w')+(g.castling||'KQkq')+(g.ep??-1); }
function serverGameEnd(g,repeated=false) {
  if(!g || !Array.isArray(g.board))return null;
  const legal=chLegal(g);
  if(!legal.length){const side=g.turn,k=g.board.indexOf(side==='w'?'K':'k');return k>=0&&chAttacked(g.board,k,side==='b')?{winner:other(side),reason:'Schachmatt'}:{winner:null,reason:'Patt'};}
  const nonKings=g.board.filter(x=>x&&x.toLowerCase()!=='k');
  if(!nonKings.length||(nonKings.length===1&&'bn'.includes(nonKings[0].toLowerCase())))return {winner:null,reason:'Remis · unzureichendes Material'};
  if((g.halfmove||0)>=100)return {winner:null,reason:'Remis · 50-Züge-Regel'};
  if(repeated)return {winner:null,reason:'Remis · Stellungswiederholung'};
  return null;
}

// ---- Konten (Datei oder dauerhaft über Upstash Redis) ----
const crypto = require('crypto');
const FILE = path.join(DIR, 'users.json');
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
process.on('SIGTERM', async () => { await Promise.race([Promise.all([flush(), flushParties()]), new Promise(r => setTimeout(r, 8000))]); process.exit(0); });   // Render beendet den Server: vorher noch speichern

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

// Online-Schachuhren werden ausschließlich auf dem Server berechnet.
const otherSide = side => side === 'w' ? 'b' : 'w';
function clockView(r, now = Date.now()) {
  const c = r.clock;
  if (!c) return null;
  const remaining = { ...c.remaining };
  if (!c.ended) remaining[c.turn] = Math.max(0, remaining[c.turn] - Math.max(0, now - c.lastAt));
  return { remaining, turn: c.turn, serverNow: now };
}
function timeoutWinner(r, loser) {
  const winner=otherSide(loser),pieces=(r.board||[]).filter(p=>p&&chWhite(p)===(winner==='w')).map(p=>p.toLowerCase()).filter(p=>p!=='k');
  if(!pieces.length)return null;
  if(pieces.some(p=>['p','r','q'].includes(p)))return winner;
  const bishops=pieces.filter(p=>p==='b').length,knights=pieces.filter(p=>p==='n').length;
  if(bishops>=2 || (bishops>=1&&knights>=1))return winner;
  return null; // Nur König oder nur ein Läufer/Springer: kein erzwungen möglicher Mattweg.
}
function finishTimeout(r, now = Date.now()) {
  const c = r.clock;
  if (!c || c.ended) return;
  const loser = c.turn, winner = timeoutWinner(r,loser);
  c.remaining[loser] = 0;
  c.lastAt = now;
  c.ended = true;
  clearTimeout(c.timer);
  c.timer = null;

  // Erst das Spielergebnis senden: Die Oberfläche kann Elo aktualisieren,
  // danach überschreibt profile:update es mit dem verbindlichen Serverwert.
  io.to(r.code).emit('game:timeout', { win: winner, draw:!winner, clock: clockView(r, now) });
  if (r.kind === 'party-game' || r.kind === 'team') finishPartyGame(r, winner, winner?'Zeit abgelaufen':'Zeit abgelaufen · Remis wegen unzureichenden Mattmaterials');
  if (r.kind === 'match' && (r.moves || 0) >= 8 && !r.done) {
    r.res[r.w] = !winner ? 'draw' : winner === 'w' ? 'win' : 'loss';
    r.res[r.b] = !winner ? 'draw' : winner === 'b' ? 'win' : 'loss';
    settle(r);
  }
}
function checkClock(r, now = Date.now()) {
  const c = r.clock;
  if (!c || c.ended) return true;
  const elapsed = Math.max(0, now - c.lastAt);
  c.remaining[c.turn] = Math.max(0, c.remaining[c.turn] - elapsed);
  c.lastAt = now;
  if (c.remaining[c.turn] <= 0) {
    finishTimeout(r, now);
    return true;
  }
  return false;
}
function scheduleClock(r) {
  const c = r.clock;
  if (!c || c.ended) return;
  clearTimeout(c.timer);
  const delay = Math.max(0, c.remaining[c.turn] - Math.max(0, Date.now() - c.lastAt));
  c.timer = setTimeout(() => {
    if (!checkClock(r)) scheduleClock(r);
  }, delay + 5);
}

// Spieler aus Warteschlange und Raum entfernen, Gegner informieren
function leave(s, permanent = false) {
  queue = queue.filter(q => q.id !== s.id);
  const code=s.data.room, r=code&&rooms.get(code);
  if (code) {
    s.data.room=null; s.leave(code);
    if (r && (r.kind === 'party-game' || r.kind === 'team')) {
      const key=pkey(s), side=(r.whiteKeys||[]).includes(key)?'w':(r.blackKeys||[]).includes(key)?'b':null;
      if(permanent && side) {
        if(r.kind==='team') {
          r.teamIndex=r.teamIndex||{w:0,b:0};
          for(const teamSide of ['w','b']) {
            const prop=teamSide==='w'?'whiteKeys':'blackKeys',oldList=r[prop]||[];
            const oldIndex=oldList.length?(r.teamIndex[teamSide]||0)%oldList.length:0;
            const activeKey=oldList[oldIndex];
            r[prop]=oldList.filter(k=>k!==key);
            const nextIndex=r[prop].indexOf(activeKey);
            r.teamIndex[teamSide]=activeKey===key?0:(nextIndex>=0?nextIndex:0);
          }
          // Ein freier Team-Slot darf durch den Leiter ersetzt werden; die Partie bleibt bis dahin offen.
          const p0=parties.get(r.party);if(p0){r.teamIndex.w=partyTeamIndex(p0,r,'w');r.teamIndex.b=partyTeamIndex(p0,r,'b');io.to(r.code).emit('game:turn',partyTurnView(p0,r));io.to('party:'+p0.code).emit('party:state',partySnapshot(p0));}
        } else finishPartyGame(r,other(side),'Spieler hat die Party verlassen');
      } else io.to(code).emit('game:player-offline',{name:s.data.user&&s.data.user.name||'Spieler'});
    } else if (r) {
      if (r.clock) { r.clock.ended=true; clearTimeout(r.clock.timer); r.clock.timer=null; }
      if (r.kind === 'match' && (r.moves || 0) >= 8 && !r.done) {
        const oid=s.id===r.w?r.b:r.w;
        if (!r.res[s.id]) r.res[s.id]=r.res[oid]?COMP[r.res[oid]]:'loss';
        if (!r.res[oid]) r.res[oid]=COMP[r.res[s.id]];
        settle(r);
      }
      rooms.delete(code);
      for (const id of [r.w,r.b]) {
        const o=id&&id!==s.id&&sock(id);
        if(o&&o.data.room===code){o.data.room=null;o.leave(code);o.emit('opponent:left');}
      }
    }
  }
  const pc=s.data.party;
  if(pc) {
    const p=parties.get(pc),key=pkey(s);
    if(p) {
      const m=partyPlayer(p,key);
      if(m && !( !permanent && m.socketId && m.socketId!==s.id)) {
        m.connected=false;m.socketId=null;
        if(!permanent) {
          for(const g of (p.games||[]).filter(x=>x.status==='running'&&x.kind==='team')) {
            const side=(g.whiteKeys||[]).includes(key)?'w':(g.blackKeys||[]).includes(key)?'b':null;
            if(side) {
              const arr=side==='w'?g.whiteKeys:g.blackKeys;
              const current=arr.length?arr[(g.teamIndex[side]||0)%arr.length]:null;
              if(current===key) {
                g.teamIndex[side]=partyTeamIndex(p,g,side);
                io.to(g.code).emit('game:turn',partyTurnView(p,g));
              }
            }
          }
          if(p.ffa && p.ffa.alive.includes(key)){p.ffa.offline=p.ffa.offline||[];if(!p.ffa.offline.includes(key))p.ffa.offline.push(key);if(p.ffa.order[p.ffa.turn]===key)ffaNext(p.ffa);io.to('party:'+p.code).emit('ffa:state',ffaPublic(p.ffa));}
        }
        if(permanent) {
          if(p.ffa)ffaEliminate(p,key);
          p.players=p.players.filter(x=>x.key!==key);
          p.pairings=(p.pairings||[]).filter(pair=>!pair.includes(key));
          if(Array.isArray(p.tournamentPlayers))p.tournamentPlayers=p.tournamentPlayers.filter(x=>x!==key);
          if(p.teams){p.teams.w=(p.teams.w||[]).filter(x=>x!==key);p.teams.b=(p.teams.b||[]).filter(x=>x!==key);}
          if(p.host===key){p.host=(p.players.find(x=>x.connected)||p.players[0]||{}).key||null;}
        }
      }
      if(permanent)s.leave('party:'+pc);
      broadcastParty(p);
    }
    if(permanent)s.data.party=null;
  }
}
function start(r) {
  const a = sock(r.w), b = sock(r.b);
  if (!a || !b) return;
  const now = Date.now(), ms = (r.tc || 5) * 60000;
  r.board = r.board || startBoard(); r.turn = 'w'; r.castling = r.castling || 'KQkq'; r.ep = r.ep ?? -1;
  r.halfmove = r.halfmove || 0; r.history = r.history || []; r.moves = r.moves || 0; r.positions=r.positions||{[chPositionKey(r)]:1};
  r.clock = { remaining: { w: ms, b: ms }, turn: 'w', lastAt: now, ended: false, timer: null };
  scheduleClock(r);
  const clock = clockView(r, now);
  a.emit('game:start', { code: r.code, side: 'w', kind: r.kind, tc: r.tc || 5, clock, canMove:true, opp: { e: b.data.elo, n: nm(b), a: av(b) } });
  b.emit('game:start', { code: r.code, side: 'b', kind: r.kind, tc: r.tc || 5, clock, canMove:true, opp: { e: a.data.elo, n: nm(a), a: av(a) } });
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
const friendRows = u => (u.fr || []).map(k => { const f = users[k]; if (!f) return null; const so = onSocks(k); return { n: f.name, e: f.elo, a: f.av | 0, on: so.length > 0, busy: so.length > 0 && so.every(x => x.data.room || x.data.party) }; }).filter(Boolean);
function newRoom(kind, tc, a, b) {
  const code = code6();
  rooms.set(code, { code, kind, tc, w: a.id, b: b.id, res: {}, e: { [a.id]: a.data.elo, [b.id]: b.data.elo }, u: { [a.id]: a.data.user, [b.id]: b.data.user } });
  for (const x of [a, b]) { x.data.room = code; x.join(code); }
  return rooms.get(code);
}

io.on('connection', s => {
  s.data.room = null; s.data.party = null; s.data.elo = 300;
  s.emit('server:info', { persist: persistOK() });
  const U = () => s.data.user, room = () => rooms.get(s.data.room);
  const need = () => { if (U()) return true; s.emit('room:error', { message: 'Bitte zuerst anmelden.' }); return false; };
  s.on('clock:ping', d => s.emit('clock:pong', { clientTime: Number(d && d.clientTime) || 0, serverNow: Date.now() }));

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
  s.on('auth:logout', () => { leave(s,true); offline(s); s.data.user = null; });

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
    u.name = n;
    if(k!==old)renamePartyMember(old,k,n);
    saveUsers();
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

  // ---- Private Party: Mehrspieler-Lobby mit vier Modi ----
  s.on('room:create', d => {
    if (!need()) return;
    leave(s,true); s.data.elo=U().elo;
    const code=code6(),key=pkey(s);
    const p={code,host:key,mode:'normal',tc:ptime(d&&d.tc||otc),status:'lobby',
      players:[{key,name:U().name,elo:U().elo,av:U().av|0,connected:true,socketId:s.id,currentGame:null}],
      pairings:[],tournamentPlayers:null,teams:{w:[],b:[],names:{w:'Team Weiß',b:'Team Schwarz'}},games:[],tournament:null,ffa:null,createdAt:Date.now()};
    parties.set(code,p);s.data.party=code;s.join('party:'+code);
    s.emit('room:created',{code});broadcastParty(p);
  });
  s.on('room:join', d => {
    if(!need())return;
    const code=String(d&&d.code||''),p=parties.get(code);
    if(!/^\d{6}$/.test(code)||!p)return s.emit('room:error',{message:'Diesen Party-Code gibt es nicht.'});
    if(p.status==='finished'&&!partyPlayer(p,pkey(s)))return s.emit('room:error',{message:'Diese Party ist bereits beendet.'});
    if(s.data.party!==code)leave(s,true);
    const m=addPartyMember(p,s);
    if(!m)return s.emit('room:error',{message:'Die Party ist voll (maximal 16 Spieler).'});
    s.emit('room:joined',{code});broadcastParty(p);
    if(p.ffa){s.emit('ffa:start',ffaPublic(p.ffa));if(p.ffa.winner)s.emit('ffa:finished',{winner:p.ffa.winner,name:p.ffa.players.find(x=>x.key===p.ffa.winner)?.name});}
  });
  s.on('room:leave', () => leave(s,true));
  s.on('party:mode',d=>{
    const p=parties.get(s.data.party);if(!p||p.host!==pkey(s))return s.emit('room:error',{message:'Nur der Party-Leiter darf den Modus ändern.'});
    if((p.games||[]).some(g=>g.status==='running')||p.status==='running')return s.emit('room:error',{message:'Der Modus kann während laufender Spiele nicht geändert werden.'});
    const mode=String(d&&d.mode||p.mode);if(!PARTY_MODES.includes(mode))return;
    p.tc=ptime(d&&d.tc||p.tc);
    if(mode!==p.mode) {
      p.mode=mode;p.status='lobby';p.ffa=null;p.tournament=null;p.games=p.games.filter(g=>g.status==='running');
      p.pairings=[];
      if(mode==='team'){p.teams={w:[],b:[],names:{w:'Team Weiß',b:'Team Schwarz'},colors:{w:'#f5f5f5',b:'#252a34'}};defaultTeamAssign(p);}
      if(mode==='tournament')p.tournamentPlayers=null;
    }
    broadcastParty(p);
  });
  s.on('party:pairings',d=>{
    const p=parties.get(s.data.party);if(!p||p.host!==pkey(s)||p.mode!=='normal'||p.status==='running')return;
    p.pairings=validPairings(p,d&&d.pairs)||[];broadcastParty(p);
  });
  s.on('party:tournament-players',d=>{
    const p=parties.get(s.data.party);if(!p||p.host!==pkey(s)||p.mode!=='tournament'||p.status==='running')return;
    const valid=new Set(partyMemberKeys(p));
    p.tournamentPlayers=[...new Set((Array.isArray(d&&d.players)?d.players:[]).map(x=>String(x).toLowerCase()).filter(x=>valid.has(x)))];
    broadcastParty(p);
  });
  s.on('party:teams',d=>{
    const p=parties.get(s.data.party);if(!p||p.host!==pkey(s)||p.mode!=='team')return;
    const valid=new Set(partyMemberKeys(p)),cleanList=a=>[...new Set((Array.isArray(a)?a:[]).map(x=>String(x).toLowerCase()).filter(x=>valid.has(x)))];
    const w=cleanList(d&&d.w),b=cleanList(d&&d.b).filter(x=>!w.includes(x));
    const active=(p.games||[]).find(x=>x.kind==='team'&&x.status==='running');
    if(active){for(const k of [...active.whiteKeys,...active.blackKeys]){const old=active.whiteKeys.includes(k)?'w':'b',next=w.includes(k)?'w':b.includes(k)?'b':null;if(next!==old)return s.emit('room:error',{message:'Während einer Team-Partie können bestehende Spieler nicht die Seite wechseln oder entfernt werden. Weise stattdessen einen freien oder Ersatzspieler zu.'});}}
    const names=d&&d.names||{};
    const colors=d&&d.colors||{};
    const cleanColor=v=>/^#[0-9a-f]{6}$/i.test(String(v||''))?String(v):'#ffffff';
    p.teams={w,b,names:{w:String(names.w||'Team Weiß').slice(0,20),b:String(names.b||'Team Schwarz').slice(0,20)},
      colors:{w:cleanColor(colors.w),b:cleanColor(colors.b)}};
    const g=(p.games||[]).find(x=>x.kind==='team'&&x.status==='running');
    if(g) {
      const before=[...(g.whiteKeys||[]),...(g.blackKeys||[])],after=[...w,...b];
      for(const k of before.filter(k=>!after.includes(k))) {
        const m=partyPlayer(p,k),x=m&&sock(m.socketId);
        if(m&&m.currentGame===g.code)m.currentGame=null;
        if(x){x.leave(g.code);if(x.data.room===g.code)x.data.room=null;}
      }
      g.whiteKeys=w;g.blackKeys=b;g.teamIndex=g.teamIndex||{w:0,b:0};
      g.teamIndex.w=w.length?g.teamIndex.w%w.length:0;g.teamIndex.b=b.length?g.teamIndex.b%b.length:0;
      g.teamIndex.w=partyTeamIndex(p,g,'w');g.teamIndex.b=partyTeamIndex(p,g,'b');
      for(const k of after.filter(k=>!before.includes(k))) {
        const m=partyPlayer(p,k),x=m&&sock(m.socketId);if(!m||!x)continue;
        if(x.data.room&&x.data.room!==g.code)x.leave(x.data.room);
        x.data.room=g.code;x.join(g.code);m.currentGame=g.code;
        const side=w.includes(k)?'w':'b',opp=(side==='w'?b:w).map(z=>partyPlayer(p,z)?.name||z).join(' + ');
        x.emit('game:start',{code:g.code,side,kind:'party',tc:g.tc||0,clock:g.clock?clockView(g):null,opp:{n:opp,e:0},canMove:canPartyMove(g,k),partyGame:true,team:true,teamColors:p.teams&&p.teams.colors});
        x.emit('game:sync',{board:g.board,turn:g.turn,castling:g.castling,ep:g.ep,halfmove:g.halfmove,history:g.history||[],clock:g.clock?clockView(g):null});
      }
      // Bestehende Spieler behalten ihr Brett; nur Zugberechtigung und Team-Rotation werden aktualisiert.
      io.to(g.code).emit('game:turn',partyTurnView(p,g));
    }
    broadcastParty(p);
  });
  s.on('party:start',()=>{
    const p=parties.get(s.data.party);if(!p)return partyErr(s,'Du bist in keiner Party.');
    partyStart(s,p);
  });
  function partyErr(x,message){x.emit('room:error',{message});}
  s.on('party:watch',d=>{
    const p=parties.get(s.data.party),g=p&&(p.games||[]).find(x=>x.code===String(d&&d.code||''));
    if(!p||!g||g.kind==='ffa')return;
    const key=pkey(s);if(g.status!=='running'&&!g.board)return;
    const active=(p.games||[]).find(x=>x.status==='running'&&((x.whiteKeys||[]).includes(key)||(x.blackKeys||[]).includes(key)));
    if(active&&active.code!==g.code)return s.emit('room:error',{message:'Du spielst bereits eine laufende Partie. Beende sie oder kehre zu ihr zurück, bevor du eine andere Partie öffnest.'});
    if(s.data.room && s.data.room!==g.code){s.leave(s.data.room);s.data.room=null;}
    s.data.room=g.code;s.join(g.code);
    const playingWhite=(g.whiteKeys||[]).includes(key),playingBlack=(g.blackKeys||[]).includes(key),playing=playingWhite||playingBlack;
    const side=playingWhite?'w':playingBlack?'b':'w';
    const oppKeys=side==='w'?g.blackKeys:g.whiteKeys;
    s.emit('game:start',{code:g.code,side,kind:'party',tc:g.tc||0,clock:g.clock?clockView(g):null,
      opp:{n:(oppKeys||[]).map(k=>partyPlayer(p,k)?.name||k).join(' + ')||'Zuschauer',e:0},spectator:!playing,canMove:playing&&canPartyMove(g,key),partyGame:true,team:g.kind==='team',teamColors:p.teams&&p.teams.colors});
    s.emit('game:sync',{board:g.board,turn:g.turn,castling:g.castling,ep:g.ep,halfmove:g.halfmove,history:g.history||[],clock:g.clock?clockView(g):null});
    s.emit('game:turn',partyTurnView(p,g));
  });

  // ---- Gegnersuche je Bedenkzeit (1, 3, 5 oder 10 Minuten), Elo-nah ----
  s.on('match:join', d => {
    if (!need()) return;
    leave(s,true); s.data.elo = U().elo;
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

  // ---- Serverseitig geprüfte Züge ----
  s.on('game:move', d => {
    const r=room();if(!r||!d||!Number.isInteger(d.from)||!Number.isInteger(d.to))return;
    const key=pkey(s);
    const side=r.kind==='party-game'||r.kind==='team'
      ? (r.whiteKeys.includes(key)?'w':r.blackKeys.includes(key)?'b':null)
      : (s.id===r.w?'w':s.id===r.b?'b':null);
    if(!side||!r.clock||r.clock.ended||side!==r.turn|| (r.kind==='party-game'||r.kind==='team')&&!canPartyMove(r,key)) {
      s.emit('game:sync',{board:r.board,turn:r.turn,castling:r.castling,ep:r.ep,halfmove:r.halfmove,history:r.history||[],clock:r.clock?clockView(r):null});return;
    }
    const now=Date.now();if(checkClock(r,now))return;
    const result=chApplyMove(r,d);
    if(!result){s.emit('game:sync',{board:r.board,turn:r.turn,castling:r.castling,ep:r.ep,halfmove:r.halfmove,history:r.history||[],clock:r.clock?clockView(r):null});return;}
    r.board=result.state.board;r.turn=result.state.turn;r.ep=result.state.ep;r.halfmove=result.state.halfmove;
    r.moves=(r.moves||0)+1;r.history=r.history||[];
    r.history.push({from:d.from,to:d.to,promotion:result.move.promotion||''});
    r.positions=r.positions||{};const posKey=chPositionKey(r);r.positions[posKey]=(r.positions[posKey]||0)+1;
    if(r.clock){r.clock.turn=r.turn;r.clock.lastAt=now;scheduleClock(r);}
    io.to(r.code).emit('game:move',{from:d.from,to:d.to,promotion:result.move.promotion||'',by:s.id,clock:r.clock?clockView(r,now):null});
    if(r.kind==='party-game'||r.kind==='team') {
      const arr=side==='w'?r.whiteKeys:r.blackKeys;
      r.teamIndex=r.teamIndex||{w:0,b:0};r.teamIndex[side]=(r.teamIndex[side]+1)%arr.length;
      const p=parties.get(r.party);if(p){r.teamIndex[side]=partyTeamIndex(p,r,side);io.to(r.code).emit('game:turn',partyTurnView(p,r));}
    }
    if(r.kind==='party-game'||r.kind==='team')saveParties();
    const end=serverGameEnd(r,r.positions[posKey]>=3);
    if(end) {
      r.serverResult=end;
      if(r.kind==='party-game'||r.kind==='team')finishPartyGame(r,end.winner,end.reason);
      else if(r.kind==='match'&&!r.done) {
        r.res[r.w]=end.winner==='w'?'win':end.winner==='b'?'loss':'draw';
        r.res[r.b]=end.winner==='b'?'win':end.winner==='w'?'loss':'draw';
        settle(r);
        io.to(r.code).emit('game:verified-end',end);
      } else io.to(r.code).emit('game:verified-end',end);
    }
  });
  s.on('game:resign', () => {
    const r=room();if(!r||!r.clock||r.clock.ended)return;
    const key=pkey(s),side=(r.kind==='party-game'||r.kind==='team')?(r.whiteKeys.includes(key)?'w':r.blackKeys.includes(key)?'b':null):(s.id===r.w?'w':s.id===r.b?'b':null);
    if(!side)return;
    r.clock.ended=true;clearTimeout(r.clock.timer);r.clock.timer=null;
    const winner=other(side);
    if(r.kind==='party-game'||r.kind==='team')finishPartyGame(r,winner,'Aufgegeben');
    else io.to(r.code).emit('game:resign',{winner,by:s.id});
  });
  s.on('game:look', d => {
    const r=room(),u=U();if(!r||!d||!u)return;
    const x=String(d.x||'');s.to(r.code).emit('game:look',{t:Number(d.t)|0,c:String(d.c||'').slice(0,9),x:SHOP[x]&&u.owned.includes(x)?x:''});
  });
  s.on('game:over', d => {
    const r=room();if(!r)return;
    if(r.kind==='party-game'||r.kind==='team')return; // Partien werden serverseitig beendet, nicht per Client-Behauptung.
    if(r.clock&&!r.clock.ended){r.clock.ended=true;clearTimeout(r.clock.timer);r.clock.timer=null;}
    if(r.kind==='match' && r.serverResult) {
      const win=r.serverResult.winner;
      r.res[r.w]=win==='w'?'win':win==='b'?'loss':'draw';
      r.res[r.b]=win==='b'?'win':win==='w'?'loss':'draw';settle(r);
    } else if(r.kind==='match') claim(r,s,d&&d.res);
  });
  s.on('ffa:move',d=>{
    const p=parties.get(s.data.party);if(!p||p.mode!=='ffa'||!p.ffa)return;
    if(!ffaMove(p,s,d))s.emit('ffa:state',ffaPublic(p.ffa));
  });

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
    if (s.data.room || s.data.party) return res(false, 'Verlasse zuerst dein aktuelles Spiel oder deine Party.');
    const targets = onSocks(k).filter(x => !x.data.room && !x.data.party);
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
    if (!a || !a.data.user || a.data.room || a.data.party || s.data.room || s.data.party) {
      s.emit('invite:result', { ok: false, msg: 'Die Anfrage ist nicht mehr gültig.' });
      return a && a.emit('invite:result', { ok: false, msg: 'Die Anfrage ist nicht mehr gültig.' });
    }
    const [w, b] = Math.random() < 0.5 ? [a, s] : [s, a];
    start(newRoom('friend', inv.tc, w, b));      // Freundes-Spiel: kein Elo, kein Gold
  });

  s.on('disconnect', () => { leave(s,false); offline(s); });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) loadUsers().then(async () => { await loadParties(); web.listen(PORT, () => console.log('Schach läuft auf Port ' + PORT)); });

module.exports = { web, __test: { startBoard, chLegal, chApplyMove, serverGameEnd, chPositionKey, buildTournamentBracket, createFFAState, ffaLegal, canPartyMove, partyTeamIndex, partyTurnView } };
