
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { customAlphabet, nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/** ===== Helpers ===== */
const codeId = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4);
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const HOST_TURN_SEC = 3*60 + 45;   // 3:45
const AUTO_TURN_SEC = 2*60 + 15;   // 2:15

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function phaseForTurn(t){
  if(t>=1 && t<=7)  return {id:'A', start:1, end:7, host:true};
  if(t>=8 && t<=21) return {id:'B', start:8, end:21, host:false};
  if(t>=22 && t<=26) return {id:'C', start:22, end:26, host:true};
  if(t>=27 && t<=37) return {id:'D', start:27, end:37, host:false};
  if(t>=38 && t<=42) return {id:'E', start:38, end:42, host:true};
  return {id:'A', start:1, end:7, host:true};
}

function phaseWindowSec(phaseId){
  if(phaseId==='B') return (21-8+1)*AUTO_TURN_SEC; // 14 tours
  if(phaseId==='D') return (37-27+1)*AUTO_TURN_SEC; // 11 tours
  return HOST_TURN_SEC;
}

function makeBlankPlayer(name){
  return {
    id: nanoid(10),
    name: name || 'Étudiant',
    role: 'student',
    tourPerso: 1,
    patrimoine: 0,
    salaire: 0,
    costOfLiving: 0,
    rentenpunkte: 0,
    statusLight: 'red',
    lastActive: null,
    answered: false,
    profileId: null,
    profileName: null,
    profileTrait: null
  };
}

function loadDeckStandard() {
  const deckPath = path.join(__dirname, 'data', 'e-deck_standard.json');
  try {
    if (fs.existsSync(deckPath)) {
      const raw = fs.readFileSync(deckPath, 'utf-8');
      const deck = JSON.parse(raw);
      return deck;
    }
  } catch (e) {
    console.error('Error loading e-deck_standard:', e);
  }
  return [];
}

/* function cardFromJSON(turn, type){
  const deck = loadDeckStandard();
  const nodes = deck.nodes;
  const propositions = nodes.filter(n => n.pile.toLowerCase() === type.toLowerCase()); 
  if (propositions.length === 0) return null;
  const idx = Math.floor(Math.random() * propositions.length);
  const selected_proposition = propositions[idx];
  const isInvest = (type==='Proposition');
  return {
    type,
    titre: selected_proposition.title,
    texte: selected_proposition.category || '',
    requiresInvestment: isInvest,
    resume: `Résumé ${type} — année ${turn}.`,
    impacts: `Impacts financiers potentiels à l'année ${turn}.`,
    exemples: `Exemples concrets liés à ${type} (année ${turn}).`,
    conseils: `Conseils pour gérer ${type} à l'année ${turn}.`,
    choices: !isInvest ? [
      { id:'A', label:'Accepter' },
      { id:'B', label:'Refuser' }
    ] : undefined
  };
} */

function cardFromJSON(turn, type){
  const deck = loadDeckStandard();
  const nodes = Array.isArray(deck.nodes) ? deck.nodes : [];
  const propositions = nodes.filter(n => 
    typeof n.pile === 'string' && n.pile.toLowerCase() === type.toLowerCase()
  );
  if (propositions.length === 0) return null;
  const idx = Math.floor(Math.random() * propositions.length);
  const selected_proposition = propositions[idx];
  const isInvest = (type.toLowerCase() === 'proposition');
  return {
    type,
    titre: selected_proposition.title,
    texte: selected_proposition.category || '',
    requiresInvestment: isInvest,
    resume: `Résumé ${type} — année ${turn}.`,
    impacts: `Impacts financiers potentiels à l'année ${turn}.`,
    exemples: `Exemples concrets liés à ${type} (année ${turn}).`,
    conseils: `Conseils pour gérer ${type} à l'année ${turn}.`,
    choices: !isInvest ? [
      { id:'A', label:'Accepter' },
      { id:'B', label:'Refuser' }
    ] : undefined
  };
}


function cardFromTemplate(turn, type){
  // Generic demo content – replace by actual content when ready
  const titles = {
    evenement: `Évènement de l'année ${turn}`,
    proposition: `Proposition d'investissement ${turn}`,
    contrainte: `Contrainte financière ${turn}`,
    bonus: `Bonus/opportunité ${turn}`
  };
  const texts = {
    evenement: `Une situation particulière survient à l'année ${turn}.`,
    proposition: `Option d'investir avec un montant de base et/ou mensuel.`,
    contrainte: `Une dépense ou obligation surgit à l'année ${turn}.`,
    bonus: `Un avantage potentiel est proposé cette année.`
  };
  const isInvest = (type==='proposition');
  return {
    type,
    titre: titles[type] || `Carte ${type} ${turn}`,
    texte: texts[type] || '',
    requiresInvestment: isInvest,
    resume: `Résumé ${type} — année ${turn}.`,
    impacts: `Impacts financiers potentiels à l'année ${turn}.`,
    exemples: `Exemples concrets liés à ${type} (année ${turn}).`,
    conseils: `Conseils pour gérer ${type} à l'année ${turn}.`,
    choices: !isInvest ? [
      { id:'A', label:'Accepter' },
      { id:'B', label:'Refuser' }
    ] : undefined
  };
}

function generateDeck(){
  const deck = [];
  for(let t=1; t<=42; t++){
    deck.push({
      turn: t,
      age: 18 + (t-1),
      evenement: cardFromJSON(t, 'evenement'),
      proposition: cardFromJSON(t, 'proposition'),
      contrainte: cardFromJSON(t, 'contrainte'),
      bonus: cardFromJSON(t, 'bonus')
    });
  }
  return deck;
}

/** ===== Profiles loading ===== */
function loadProfiles(lang){
  const safeLang = (lang||'fr').toLowerCase();
  const candidates = [
    path.join(__dirname, 'data', `profiles.${safeLang}.json`),
    path.join(__dirname, 'data', 'profiles_fr.json')
  ];
  for(const p of candidates){
    try{
      if(fs.existsSync(p)){
        const raw = fs.readFileSync(p, 'utf-8');
        const arr = JSON.parse(raw);
        if(Array.isArray(arr) && arr.length>0) return arr;
      }
    }catch(e){}
  }
  return [];
}

function applyProfileStart(p, profile){
  // Apply starting situation (we keep numbers as "annual" for salary and costOfLiving)
  const s = profile.start||{};
  if(typeof s.salaryAnnualNet === 'number') p.salaire = Math.round(s.salaryAnnualNet);
  if(typeof s.capitalStart === 'number') p.patrimoine = Math.round(s.capitalStart);
  if(typeof s.costOfLivingAnnual === 'number') p.costOfLiving = Math.round(s.costOfLivingAnnual);
  // household flag is informational for UI/business rules; keep via trait if needed
  p.profileId = profile.id;
  p.profileName = profile.name;
  p.profileTrait = profile.trait ? { title: profile.trait.title, rules: profile.trait.rules||[] } : null;
}

function defaultSession(code){
  return {
    code,
    lang: 'fr',
    started: false,
    paused: false,
    turnGlobal: 1,
    phase: 'A',
    deadline: null,
    deck: [],
    players: new Map(),       // playerId -> player
    decisions: new Map(),     // playerId -> Map(turn -> {type -> decision})
    logs: [],
    clientSockets: new Set(), // students
    hostSockets: new Set(),   // hosts
    profiles: [],             // loaded list for this language
    profilePool: []           // shuffled pool for random assignment
  };
}

function sessionViewFor(wsCtx, session){
  const isHost = wsCtx && wsCtx.role==='host';
  const phase = phaseForTurn(session.turnGlobal);
  const view = {
    code: session.code,
    phase: session.phase || phase.id,
    paused: !!session.paused,
    deadline: session.deadline,
    lang: session.lang,
    logs: session.logs.slice(-2000)
  };

  const playersArr = Array.from(session.players.values()).map(p=>{
    return {
      id: p.id,
      name: p.name,
      tourPerso: p.tourPerso,
      patrimoine: p.patrimoine,
      salaire: p.salaire,
      costOfLiving: p.costOfLiving,
      rentenpunkte: p.rentenpunkte,
      statusLight: p.statusLight,
      lastActive: p.lastActive,
      answered: !!p.answered,
      profileId: p.profileId,
      profileName: p.profileName,
      profileTrait: p.profileTrait ? { title: p.profileTrait.title } : null
    };
  });
  view.players = playersArr;

  if(isHost || phase.host){
    view.turn = session.turnGlobal;
    const d = session.deck[session.turnGlobal-1] || null;
    if(d){
      view.age = d.age;
      view.active = {
        evenement: d.evenement,
        proposition: d.proposition,
        contrainte: d.contrainte,
        bonus: d.bonus
      };
    }
  } else {
    const me = wsCtx && session.players.get(wsCtx.playerId);
    const t = me ? me.tourPerso : session.turnGlobal;
    view.turn = t;
    const d = session.deck[t-1] || null;
    if(d){
      view.age = d.age;
      view.active = {
        evenement: d.evenement,
        proposition: d.proposition,
        contrainte: d.contrainte,
        bonus: d.bonus
      };
    }
  }

  const decisions = {};
  session.decisions.forEach((byTurn, pid)=>{
    decisions[pid] = {};
    byTurn.forEach((perType, turn)=>{
      decisions[pid][turn] = Object.assign({}, perType);
    });
  });
  view.decisions = decisions;

  return view;
}

function broadcastState(session){
  session.clientSockets.forEach(ws=>{
    try{
      const ctx = CLIENTS.get(ws);
      const snap = sessionViewFor(ctx, session);
      ws.send(JSON.stringify({ type:'state', session: snap }));
    }catch(e){}
  });
  session.hostSockets.forEach(ws=>{
    try{
      const ctx = CLIENTS.get(ws);
      const snap = sessionViewFor(ctx, session);
      ws.send(JSON.stringify({ type:'state', session: snap }));
    }catch(e){}
  });
}

function setDeadline(session, phaseId){
  const ph = phaseId || session.phase || phaseForTurn(session.turnGlobal).id;
  const sec = (ph==='A' || ph==='C' || ph==='E') ? HOST_TURN_SEC : phaseWindowSec(ph);
  session.deadline = now() + sec*1000;
}

function recalcPhase(session){
  const ph = phaseForTurn(session.turnGlobal);
  session.phase = ph.id;
  session.paused = (session.turnGlobal===21);
}

function ensureDecisionsMap(session, playerId, turn){
  if(!session.decisions.has(playerId)) session.decisions.set(playerId, new Map());
  const byTurn = session.decisions.get(playerId);
  if(!byTurn.has(turn)) byTurn.set(turn, {});
  return byTurn.get(turn);
}

function computeAnsweredForPlayer(session, p){
  const turn = (phaseForTurn(session.turnGlobal).host) ? session.turnGlobal : p.tourPerso;
  const decs = (session.decisions.get(p.id) || new Map()).get(turn) || {};
  const required = ['evenement','proposition','contrainte','bonus'].filter(k=>!!(session.deck[turn-1] && session.deck[turn-1][k]));
  const answered = required.every(k => !!decs[k]);
  p.answered = answered;
}

function computeStatusLight(session, p){
  const recent = p.lastActive && (now() - p.lastActive) < 15000;
  const turn = (phaseForTurn(session.turnGlobal).host) ? session.turnGlobal : p.tourPerso;
  const decs = (session.decisions.get(p.id) || new Map()).get(turn) || {};
  const keys = ['evenement','proposition','contrainte','bonus'];
  const count = keys.reduce((n,k)=> n + (decs[k] ? 1 : 0), 0);
  if(count === 0) { p.statusLight = recent ? 'orange' : 'red'; return; }
  if(count === keys.length) { p.statusLight = 'green'; return; }
  p.statusLight = 'orange';
}

function logAction(session, p, turn, type, action, extra, edited=false){
  session.logs.push({
    ts: now(),
    playerId: p.id,
    name: p.name,
    turn,
    type: edited ? `${type} (EDIT)` : type,
    action,
    extra: extra || null,
    wealth: p.patrimoine,
    rp: p.rentenpunkte,
    salary: p.salaire,
    costOfLiving: p.costOfLiving
  });
  if(session.logs.length > 2000) session.logs.shift();
}

function applyDecisionEffects(p, type, payload){
  // Simplified evolution model; integrate traits later where needed
  if(type==='proposition'){
    const ai = Math.max(0, parseInt(payload?.extra?.amountInit||0,10));
    const am = Math.max(0, parseInt(payload?.extra?.amountMonthly||0,10));
    if(payload.choiceId==='ACCEPT'){
      p.patrimoine -= ai;
      p.costOfLiving += am;
      p.rentenpunkte += 0.05;
    }
  } else if(type==='evenement'){
    if(payload.choiceId==='A' || payload.label==='Accepter'){ p.patrimoine += 500; } else { p.patrimoine -= 200; }
  } else if(type==='contrainte'){
    if(payload.choiceId==='A' || payload.label==='Accepter'){ p.patrimoine -= 300; p.costOfLiving += 30; }
  } else if(type==='bonus'){
    if(payload.choiceId==='A' || payload.label==='Accepter'){ p.patrimoine += 300; p.salaire += 20; }
  }
  p.patrimoine = Math.round(p.patrimoine);
  p.salaire = Math.round(p.salaire);
  p.costOfLiving = Math.round(p.costOfLiving);
  p.rentenpunkte = Math.round((p.rentenpunkte + Number.EPSILON)*100)/100;
}

/** ===== Sessions / Clients registries ===== */
const SESSIONS = new Map(); // code -> session
const CLIENTS = new Map();  // ws -> { role, code, playerId? }

function findOrCreateSession(code){
  if(!SESSIONS.has(code)) SESSIONS.set(code, defaultSession(code));
  return SESSIONS.get(code);
}

function attachClient(ws, role, code, playerId){
  CLIENTS.set(ws, { role, code, playerId: playerId||null });
  const sess = SESSIONS.get(code);
  if(sess){
    if(role==='host') sess.hostSockets.add(ws); else sess.clientSockets.add(ws);
  }
}

function detachClient(ws){
  const ctx = CLIENTS.get(ws);
  if(!ctx) return;
  const sess = SESSIONS.get(ctx.code);
  if(sess){
    sess.clientSockets.delete(ws);
    sess.hostSockets.delete(ws);
  }
  CLIENTS.delete(ws);
}

/** ===== WS logic ===== */
wss.on('connection', (ws)=>{
  ws.on('message', (buf)=>{
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch(e){ return; }
    const t = msg.type;

    // Host flows
    if(t==='host:create'){
      const code = codeId();
      const s = defaultSession(code);
      SESSIONS.set(code, s);
      attachClient(ws, 'host', code);
      ws.send(JSON.stringify({ type:'host:created', code }));
      return;
    }

    if(t==='host:resume'){
      const code = (msg.code||'').trim().toUpperCase();
      if(!code || !SESSIONS.has(code)) return;
      attachClient(ws, 'host', code);
      const s = SESSIONS.get(code);
      recalcPhase(s);
      setDeadline(s, s.phase);
      const ctx = CLIENTS.get(ws);
      const snap = sessionViewFor(ctx, s);
      ws.send(JSON.stringify({ type:'state', session: snap }));
      return;
    }

    if(t==='host:start'){
      const code = (msg.code||'').trim().toUpperCase();
      const lang = (msg.lang||'fr').toLowerCase();
      const s = findOrCreateSession(code);
      attachClient(ws, 'host', code);
      s.lang = ['fr','en','de'].includes(lang) ? lang : 'fr';
      // Load profiles for this language and prepare pool
      s.profiles = loadProfiles(s.lang);
      s.profilePool = shuffle(s.profiles);
      // Deck
      s.deck = generateDeck();
      s.started = true;
      s.turnGlobal = 1;
      s.paused = false;
      recalcPhase(s);
      // align all players to start and assign profiles if not yet assigned
      s.players.forEach(p=>{
        p.tourPerso = s.turnGlobal;
        if(!p.profileId){
          // If pool empty but we still have players, reshuffle to allow more than N players
          if(s.profilePool.length===0) s.profilePool = shuffle(s.profiles);
          const pr = s.profilePool.shift();
          if(pr) applyProfileStart(p, pr);
        }
      });
      setDeadline(s, s.phase);
      s.players.forEach(p=>{ computeAnsweredForPlayer(s,p); computeStatusLight(s,p); });
      broadcastState(s);
      return;
    }

    if(t==='host:next'){
      const code = (msg.code||'').trim().toUpperCase();
      const s = SESSIONS.get(code); if(!s) return;
      const ph = phaseForTurn(s.turnGlobal);
      if(!ph.host) return;
      if(s.turnGlobal < ph.end){
        s.turnGlobal += 1;
        s.paused = false;
        s.players.forEach(p=>{ p.tourPerso = s.turnGlobal; });
        recalcPhase(s);
        setDeadline(s, s.phase);
        s.players.forEach(p=>{ computeAnsweredForPlayer(s,p); computeStatusLight(s,p); });
        broadcastState(s);
      } else {
        recalcPhase(s);
        if(s.turnGlobal===21) s.paused = true;
        setDeadline(s, s.phase);
        broadcastState(s);
      }
      return;
    }

    if(t==='host:continue'){
      const code = (msg.code||'').trim().toUpperCase();
      const s = SESSIONS.get(code); if(!s) return;
      if(s.turnGlobal===21){
        s.turnGlobal = 22;
        s.paused = false;
        s.players.forEach(p=>{ p.tourPerso = 22; });
      }
      recalcPhase(s);
      setDeadline(s, s.phase);
      s.players.forEach(p=>{ computeAnsweredForPlayer(s,p); computeStatusLight(s,p); });
      broadcastState(s);
      return;
    }

    if(t==='host:editDecision'){
      const code = (msg.code||'').trim().toUpperCase();
      const s = SESSIONS.get(code); if(!s) return;
      const { playerId, turn, cardType, choiceId, label, extra } = msg;
      const p = s.players.get(playerId); if(!p) return;
      const tnr = clamp(parseInt(turn||s.turnGlobal,10)||s.turnGlobal, 1, 42);
      const perType = ensureDecisionsMap(s, p.id, tnr);
      perType[cardType] = { choiceId, label, extra: extra||null, edited:true };
      applyDecisionEffects(p, cardType, perType[cardType]);
      computeAnsweredForPlayer(s, p);
      computeStatusLight(s, p);
      logAction(s, p, tnr, cardType, label||choiceId||'EDIT', extra||null, true);
      broadcastState(s);
      return;
    }

    // Student flows
    if(t==='student:join'){
      const code = (msg.code||'').trim().toUpperCase();
      const name = (msg.name||'Étudiant').toString().slice(0,48);
      if(!SESSIONS.has(code)) return;
      const s = SESSIONS.get(code);
      const p = makeBlankPlayer(name);
      const ph = phaseForTurn(s.turnGlobal);
      p.tourPerso = s.turnGlobal;
      // Assign a random profile on join if available
      if(s.profiles && s.profiles.length){
        if(s.profilePool.length===0) s.profilePool = shuffle(s.profiles);
        const pr = s.profilePool.shift();
        if(pr) applyProfileStart(p, pr);
      }
      s.players.set(p.id, p);
      attachClient(ws, 'student', code, p.id);
      ws.send(JSON.stringify({ type:'student:joined', code, player: { id:p.id, name:p.name, profileId: p.profileId, profileName: p.profileName } }));
      s.players.forEach(pl=>{ computeAnsweredForPlayer(s, pl); computeStatusLight(s, pl); });
      broadcastState(s);
      return;
    }

    if(t==='student:resume'){
      const code = (msg.code||'').trim().toUpperCase();
      const pid = (msg.playerId||'').trim();
      const s = SESSIONS.get(code); if(!s) return;
      const p = s.players.get(pid); if(!p) return;
      attachClient(ws, 'student', code, pid);
      p.lastActive = now();
      computeAnsweredForPlayer(s,p);
      computeStatusLight(s,p);
      const ctx = CLIENTS.get(ws);
      const snap = sessionViewFor(ctx, s);
      ws.send(JSON.stringify({ type:'state', session: snap }));
      return;
    }

    if(t==='student:ready'){
      const code = (msg.code||'').trim().toUpperCase();
      const pid = (msg.playerId||'').trim();
      const s = SESSIONS.get(code); if(!s) return;
      const p = s.players.get(pid); if(!p) return;
      p.lastActive = now();
      computeAnsweredForPlayer(s,p);
      computeStatusLight(s,p);
      broadcastState(s);
      return;
    }

    if(t==='student:working'){
      const code = (msg.code||'').trim().toUpperCase();
      const pid = (msg.playerId||'').trim();
      const s = SESSIONS.get(code); if(!s) return;
      const p = s.players.get(pid); if(!p) return;
      p.lastActive = now();
      computeStatusLight(s,p);
      return;
    }

    if(t==='student:decision'){
      const code = (msg.code||'').trim().toUpperCase();
      const pid = (msg.playerId||'').trim();
      const s = SESSIONS.get(code); if(!s) return;
      const p = s.players.get(pid); if(!p) return;
      const ph = phaseForTurn(s.turnGlobal);
      const type = msg.cardType;
      const curTurn = ph.host ? s.turnGlobal : p.tourPerso;
      const payload = {
        choiceId: msg.choiceId,
        label: msg.label,
        extra: msg.extra || null
      };
      const perType = ensureDecisionsMap(s, p.id, curTurn);
      perType[type] = payload;
      applyDecisionEffects(p, type, payload);
      computeAnsweredForPlayer(s, p);
      computeStatusLight(s, p);
      logAction(s, p, curTurn, type, payload.label||payload.choiceId||'', payload.extra||null, false);

      if(!ph.host && p.answered){
        const end = ph.end;
        if(p.tourPerso < end){
          p.tourPerso += 1;
          computeAnsweredForPlayer(s, p);
          computeStatusLight(s, p);
        }
      }

      broadcastState(s);
      return;
    }
  });

  ws.on('close', ()=>{
    detachClient(ws);
  });
});

server.listen(PORT, ()=>{
  console.log(`Finanz-Weg server running on http://localhost:${PORT}`);
});
