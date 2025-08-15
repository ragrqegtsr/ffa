// server.js
// Finanz‑Weg — WebSocket backend (AUTO DRAW + Random Profiles + Ready Flag + APPLY EFFECTS per Year)
//
// This version applies effects on each host:next BEFORE advancing the year
// so students' choices impact patrimoine/salaire/coutDeVie/rentenpunkte.
//
// Run locally: npm i express ws nanoid && node server.js

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

// --- Simple deck côté serveur (replace later by your DB) ---
const DECK = {
  evenement: [
    { id:'e1', type:'evenement',  titre:'Changement de job', imperative:false, texte:'Salaire +10%, coût de vie +5%.' },
    { id:'e2', type:'evenement',  titre:'Déménagement',      imperative:true,  texte:'Coût de vie +10% (impératif).' }
  ],
  proposition: [
    { id:'riester1', type:'proposition', titre:'Riester',     imperative:false, requiresInvestment:true, texte:'Choisis un versement de base et un versement mensuel.' },
    { id:'basis1',   type:'proposition', titre:'Basisrente',  imperative:false, requiresInvestment:true, texte:'Fixe un apport et une mensualité.' }
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
      marqueurs:p.marqueurs, answered:p.answered, ready:!!p.ready
    })),
    // expose decisions to help clients show "progress"
    decisions: session.decisions
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

// === EFFECTS ENGINE ===
// Applies decisions for the *current* turn to each player, then computes yearly settlement.
function applyEffects(session){
  const avgSalary = 42000;
  const turn = session.turn;

  session.players.forEach(p => {
    const dec = (session.decisions[p.id] && session.decisions[p.id][turn]) || {};
    ['evenement','proposition','contrainte','bonus'].forEach(type => {
      const card = session.active[type];
      if(!card) return;

      const entry = dec[type];
      const choiceId = (entry && (entry.choiceId || entry)) || null;
      const extra = (entry && entry.extra) || null;

      // Auto-apply imperative cards if no choice was provided
      if(!choiceId && card.imperative){
        if(card.id==='e2'){ // Déménagement: coût de vie +10%
          p.coutDeVie = Math.max(0, Math.round((p.coutDeVie||0)*1.10));
        }
        if(card.id==='c1'){ // Panne majeure: -1200€
          p.patrimoine = Math.max(0, (p.patrimoine||0) - 1200);
        }
        return;
      }

      // Investment cards accepted with amounts
      if(card.requiresInvestment && choiceId==='ACCEPT' && extra){
        p.patrimoine = Math.max(0, (p.patrimoine||0) - Math.max(0, +extra.amountInit || 0));
        p.patrimoine = Math.max(0, (p.patrimoine||0) - Math.max(0, +extra.amountMonthly || 0));
        if(!p.marqueurs.includes(card.titre)) p.marqueurs.push(card.titre);
        return;
      }

      // Minimal demo effects based on IDs (extend with your own rules/db mapping)
      if(card.type==='evenement' && card.id==='e1' && choiceId==='A'){ // job change accepted
        p.salaire = Math.max(0, Math.round((p.salaire||0)*1.10));
        p.coutDeVie = Math.max(0, Math.round((p.coutDeVie||0)*1.05));
      }
      if(card.type==='contrainte' && card.id==='c1'){ // panne
        p.patrimoine = Math.max(0, (p.patrimoine||0) - 1200);
      }
      if(card.type==='bonus' && card.id==='b1'){
        p.patrimoine = (p.patrimoine||0) + 1500;
      }
    });
  });

  // == Yearly settlement ==
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

    // HOST: create session
    if(msg.type==='host:create'){
      const code = newSessionCode();
      const session = {
        code,
        hostId: newId(),
        status:'lobby',
        settings:{ ageStart:25, ageEnd:67 },
        turn:0, age:null, phase:'running',
        players:[], active:{}, decisions:{}
      };
      SESSIONS.set(code, session);
      c.role='host'; c.sessionCode=code;
      ws.send(JSON.stringify({type:'host:created', code}));
      log('session created', code);
      return;
    }

    // HOST: start (auto draw for turn 0)
    if(msg.type==='host:start'){
      const s = ensureSession(msg.code);
      s.status='running';
      s.turn=0; s.age=s.settings.ageStart; s.phase='running';
      s.players.forEach(p=>{p.age=s.age; p.answered=false; p.ready=false});
      s.active = drawFour();
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    // HOST: next (APPLY EFFECTS for current turn, then advance & auto draw)
    if(msg.type==='host:next'){
      const s = ensureSession(msg.code);

      // 1) Apply effects for the turn that just finished
      applyEffects(s);

      // 2) End condition
      if(s.age>=s.settings.ageEnd){
        s.status='ended';
        s.phase='ended';
        broadcast(s, {type:'state', session: sanitizeForClients(s)});
        return;
      }

      // 3) Advance to next year
      s.turn++;
      s.age++;
      s.players.forEach(p=>{p.age=s.age; p.answered=false; p.ready=false});

      // 4) Draw next four cards
      s.active = drawFour();

      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    // STUDENT: join (random profile assigned)
    if(msg.type==='student:join'){
      const s = ensureSession(msg.code);
      if(s.status!=='lobby' && s.status!=='running') return;
      if(s.players.length>=24) return;
      if(s.players.find(p=>p.name===msg.name)) return ws.send(JSON.stringify({type:'error', error:'NAME_TAKEN'}));
      const profiles = ['starter','ambitieux','alter'];
      const profileId = profiles[Math.floor(Math.random()*profiles.length)];
      const p = {
        id: newId(), name: msg.name||'Étudiant', profileId,
        age: s.age, patrimoine: 2000, salaire: 24000, coutDeVie:15000,
        rentenpunkte:0, marqueurs:[], answered:false, ready:false
      };
      s.players.push(p);
      c.role='student'; c.sessionCode=s.code; c.playerId=p.id;
      ws.send(JSON.stringify({type:'student:joined', player:p, code:s.code}));
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }

    // STUDENT: ready
    if(msg.type==='student:ready'){
      const s = ensureSession(msg.code);
      const p = s.players.find(x=>x.id===msg.playerId);
      if(p){ p.ready = !!msg.ready; broadcast(s, {type:'state', session: sanitizeForClients(s)}); }
      return;
    }

    // STUDENT: decision (supports extra payload for investments)
    if(msg.type==='student:decision'){
      const s = ensureSession(msg.code);
      const { playerId, cardType } = msg;
      const entry = {};
      if(msg.choiceId){ entry.choiceId = msg.choiceId; }
      if(msg.extra){ entry.extra = msg.extra; }
      if(msg.label){ entry.label = msg.label; }
      if(!s.decisions[playerId]) s.decisions[playerId] = {};
      if(!s.decisions[playerId][s.turn]) s.decisions[playerId][s.turn] = {};
      s.decisions[playerId][s.turn][cardType] = entry.choiceId ? entry : (msg.choiceId || entry);
      const p = s.players.find(x=>x.id===playerId);
      const allTypes = ['evenement','proposition','contrainte','bonus'];
      const full = allTypes.every(t => s.active[t] ? !!s.decisions[playerId][s.turn][t] : true);
      if(p) p.answered = full;
      broadcast(s, {type:'state', session: sanitizeForClients(s)});
      return;
    }
  });

  ws.on('close', () => { CLIENTS.delete(ws) });
});

const PORT = process.env.PORT||3000;
server.listen(PORT, () => log('listening on http://localhost:'+PORT));
