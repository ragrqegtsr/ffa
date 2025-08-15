// server.js
// Finanz‑Weg — WebSocket backend with AUTO DRAW on host:start and host:next
// Run: npm i && node server.js

const express = require('express');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');
const http = require('http');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- In‑memory store (dev only) ---
const SESSIONS = new Map(); // code -> session state
const CLIENTS  = new Map(); // ws -> {role, sessionCode, playerId}

// --- Simple deck côté serveur (remplace par ta base plus tard)
const DECK = {
  evenement: [
    { id:'e1', type:'evenement',  titre:'Changement de job', imperative:false, texte:'Salaire +10%, coût de vie +5%.' },
    { id:'e2', type:'evenement',  titre:'Déménagement',      imperative:true,  texte:'Coût de vie +10% (impératif).' }
  ],
  proposition: [
    { id:'p1', type:'proposition', titre:'bAV entreprise',    imperative:false, texte:'Convertir 4% du brut en bAV.' },
    { id:'p2', type:'proposition', titre:'Assurance BU',      imperative:false, texte:'600€/an, couverture invalidité pro.' }
  ],
  contrainte: [
    { id:'c1', type:'contrainte',  titre:'Panne majeure',     imperative:true,  texte:'Dépense imprévue 1 200€.' },
    { id:'c2', type:'contrainte',  titre:'Marché en berne',   imperative:false, texte:'Patrimoine -3% cette année.' }
  ],
  bonus: [
    { id:'b1', type:'bonus',       titre:'Prime',             imperative:false, texte:'+1 500€ net.' },
    { id:'b2', type:'bonus',       titre:'Marché haussier',   imperative:false, texte:'Patrimoine +5%.' }
  ]
};
const pick = (arr)=>arr[Math.floor(Math.random()*arr.length)];
function drawFour(){
  return {
    evenement:  pick(DECK.evenement),
    proposition: pick(DECK.proposition),
    contrainte:  pick(DECK.contrainte),
    bonus:       pick(DECK.bonus),
  };
}

const now = () => new Date().toISOString().slice(11,19);
const log = (...a) => console.log(`[${now()}]`, ...a);

function newSessionCode(){ return nanoid(5).toUpperCase() }
function newId(){ return nanoid(8) }

function sanitizeForClients(session){
  return {
    code: session.code,
    status: session.status,
    settings: session.settings,
    turn: session.turn,
    age: session.age,
    phase: session.phase,
    active: session.active,
    players: session.players.map(p=>({
      id:p.id, name:p.name, profileId:p.profileId,
      age:p.age, patrimoine:p.patrimoine, salaire:p.salaire,
      coutDeVie:p.coutDeVie, rentenpunkte:p.rentenpunkte,
      marqueurs:p.marqueurs, answered:p.answered
    }))
  };
}

function broadcast(session, payload){
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    const c = CLIENTS.get(ws);
    if(ws.readyState===1 && c && c.sessionCode===session.code){ ws.send(msg) }
  });
}

function ensureSession(code){
  const s = SESSIONS.get(code);
  if(!s) throw new Error('SESSION_NOT_FOUND');
  return s;
}

function applyEffects(session){
  const avgSalary = 42000;
  const turn = session.turn;
  session.players.forEach(p => {
    const dec = (session.decisions[p.id] && session.decisions[p.id][turn]) || {};
    ['evenement','proposition','contrainte','bonus'].forEach(type => {
      const card = session.active[type];
      if(!card) return;
      const choiceId = dec[type] || (card.imperative ? (card.choices?.[0]?.id || '_AUTO') : null);
      if(!choiceId && !card.imperative) return;
      const eff = card.choices?.find(x=>x.id===choiceId)?.effets || {};
      if(eff.dsalairePct)   p.salaire     = Math.max(0, Math.round(p.salaire*(1+eff.dsalairePct)));
      if(eff.dcoutPct)      p.coutDeVie   = Math.max(0, Math.round(p.coutDeVie*(1+eff.dcoutPct)));
      if(eff.depenseUnique) p.patrimoine  = Math.max(0, p.patrimoine - eff.depenseUnique);
      if(eff.gainUnique)    p.patrimoine  = p.patrimoine + eff.gainUnique;
      if(eff.depenseFixe)   p.patrimoine  = Math.max(0, p.patrimoine - eff.depenseFixe);
      if(eff.dpatrimoinePct)p.patrimoine  = Math.max(0, Math.round(p.patrimoine*(1+eff.dpatrimoinePct)));
      if(eff.rentenBonus)   p.rentenpunkte = +(p.rentenpunkte + eff.rentenBonus).toFixed(2);
      if(eff.bav && !p.marqueurs.includes('bAV')) p.marqueurs.push('bAV');
      if(eff.bu  && !p.marqueurs.includes('BU'))  p.marqueurs.push('BU');
    });
  });
  session.players.forEach(p => {
    const net = (p.salaire||0) - (p.coutDeVie||0);
    p.patrimoine = Math.max(0, Math.round((p.patrimoine||0) + net));
    const rp = Math.max(0, Math.min(2, (p.salaire||0)/avgSalary));
    p.rentenpunkte = +((p.rentenpunkte||0) + rp).toFixed(2);
  });
}

wss.on('connection', (ws) => {
  CLIENTS.set(ws, { role:null, sessionCode:null, playerId:null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw) } catch { return; }
    const c = CLIENTS.get(ws);

    if(msg.type==='host:create'){
      const code = newSessionCode();
      const session = {
        code,
        hostId: newId(),
        status:'lobby',
        settings:{ ageStart:25, ageEnd:67, timerSec:90, timerNegSec:150 },
        turn:0, age:null, phase:'running',
        players:[], active:{}, decisions:{}
      };
      SESSIONS.set(code, session);
      c.role='host'; c.sessionCode=code;
      ws.send(JSON.stringify({type:'host:created', code}));
      log('session created', code);
      return;
    }

    if(msg.type==='host:start'){
      const s = ensureSession(msg.code);
      s.settings = msg.settings||s.settings;
      s.status='running';
      s.turn=0; s.age=s.settings.ageStart; s.phase='running';
      s.players.forEach(p=>{p.age=s.age; p.answered=false});
      s.active = drawFour();
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    if(msg.type==='host:next'){
      const s = ensureSession(msg.code);
      if(s.age>=s.settings.ageEnd){ s.status='ended'; s.phase='ended'; broadcast(s, {type:'state', session: sanitizeForClients(s)}); return; }
      s.turn++; s.age++; s.players.forEach(p=>{p.age=s.age; p.answered=false});
      s.active = drawFour();
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    if(msg.type==='student:join'){
      const s = ensureSession(msg.code);
      if(s.status!=='lobby' && s.status!=='running') return;
      if(s.players.length>=24) return;
      if(s.players.find(p=>p.name===msg.name)) return ws.send(JSON.stringify({type:'error', error:'NAME_TAKEN'}));
      const p = {
        id: newId(), name: msg.name||'Étudiant', profileId: msg.profileId||'starter',
        age: s.age, patrimoine: 2000, salaire: 24000, coutDeVie:15000,
        rentenpunkte:0, marqueurs:[], answered:false
      };
      s.players.push(p);
      c.role='student'; c.sessionCode=s.code; c.playerId=p.id;
      ws.send(JSON.stringify({type:'student:joined', player:p, code:s.code}));
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    if(msg.type==='student:decision'){
      const s = ensureSession(msg.code);
      if(!s.decisions[msg.playerId]) s.decisions[msg.playerId] = {};
      if(!s.decisions[msg.playerId][s.turn]) s.decisions[msg.playerId][s.turn] = {};
      s.decisions[msg.playerId][s.turn][msg.cardType] = msg.choiceId;
      const p = s.players.find(x=>x.id===msg.playerId);
      const all = ['evenement','proposition','contrainte','bonus'].every(t => s.active[t] ? !!s.decisions[msg.playerId][s.turn][t] : true);
      if(p) p.answered = all;
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }
  });

  ws.on('close', () => { CLIENTS.delete(ws) });
});

const PORT = process.env.PORT||3000;
server.listen(PORT, () => log('listening on http://localhost:'+PORT));
