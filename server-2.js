// server-2.js — vNext
// - Lecture optionnelle des cartes par langue: data/cards.<lang>.json
// - Lecture optionnelle de la logique: data/deck_logic.v1.1.json (pour futur moteur)
// - Profils multilingues: data/profiles.<lang>.json (déjà existant)
// - Modes: long (42 tours, phases A–E) | blitz (10 tours, sans phases)
// - Rétro-compat: si fichiers absents, fallback sur deck généré par gabarit

const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const app = express();

// ===== Static =====
app.use(express.static(path.join(__dirname, 'public')));

// Basic health
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`HTTP listening on http://localhost:${PORT}`);
});

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ===== In-memory store =====
const SESSIONS = new Map(); // code -> session
const CLIENTS = new Map();  // ws -> { role, code, playerId }

// ===== Utils =====
const now = () => Date.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a,b)=>a[0]-b[0]).map(v=>v[1]);

function makeCode() {
  // 5 chars alphanum uppercase
  return nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
}

function recalcPhase(s) {
  const t = s.turn || 1;
  if (s.mode === 'blitz') { s.phase = '—'; return; }
  if (t>=1 && t<=7) return s.phase='A';
  if (t<=21) return s.phase='B';
  if (t<=26) return s.phase='C';
  if (t<=37) return s.phase='D';
  s.phase='E';
}

function timeboxSeconds(s, seconds) {
  // crée une deadline en ms
  const ms = clamp(seconds||90, 15, 600) * 1000;
  s.deadline = now() + ms;
}

// ===== Loading JSON (optionnels) =====
function loadJSONCandidates(candidates) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('JSON load error for', p, e.message);
    }
  }
  return null;
}

function loadProfiles(lang) {
  const L = (lang||'fr').toLowerCase();
  const data = loadJSONCandidates([
    path.join(__dirname, 'data', `profiles.${L}.json`),
    path.join(__dirname, 'data', 'profiles.fr.json')
  ]);
  if (Array.isArray(data)) return data;
  // fallback minimal
  return [{ id:'P00', key:'default', name:'Profil', start:{ salaryAnnualNet:30000, capitalStart:0, costOfLivingAnnual:15000, household:false }, bio:'Par défaut', trait:{ title:'—', rules:[] } }];
}

function loadCards(lang, mode) {
  const L = (lang||'fr').toLowerCase();
  const M = (mode||'long').toLowerCase();
  // Option future: chercher d'abord cards.<mode>.<lang>.json
  const data = loadJSONCandidates([
    path.join(__dirname, 'data', `cards.${M}.${L}.json`),
    path.join(__dirname, 'data', `cards.${L}.json`),
    path.join(__dirname, 'data', 'cards.fr.json')
  ]);
  if (data && Array.isArray(data.cards)) return data.cards;
  return null;
}

function loadDeckLogic() {
  return loadJSONCandidates([
    path.join(__dirname, 'data', 'deck_logic.v1.1.json'),
    path.join(__dirname, 'data', 'deck_logic.json')
  ]);
}

// ===== Deck generation =====
function generateDeckTemplate(turns) {
  // Fallback de démonstration si pas de fichier cards.*.json
  const TYPES = ['evenement','proposition','contrainte','bonus'];
  const mk = (type, t) => ({
    id: `${type}_${t}`,
    type,
    titre: `${type.toUpperCase()} — Tour ${t}`,
    texte: `Carte ${type} générée par gabarit (tour ${t}).`
  });
  const deck = [];
  for (let t=1; t<=turns; t++) {
    deck.push({
      turn: t, age: 18 + (t-1),
      evenement: mk('evenement', t),
      proposition: mk('proposition', t),
      contrainte: mk('contrainte', t),
      bonus: mk('bonus', t)
    });
  }
  return deck;
}

function pickWeighted(arr) {
  if (!arr || !arr.length) return null;
  // Si une carte a weight, utiliser une roulette; sinon uniforme
  const total = arr.reduce((s,c)=> s + (Number(c.weight)||1), 0);
  if (!total || total===arr.length) {
    return arr[Math.floor(Math.random()*arr.length)];
  }
  let r = Math.random() * total;
  for (const c of arr) {
    r -= (Number(c.weight)||1);
    if (r <= 0) return c;
  }
  return arr[arr.length-1];
}

function generateDeckFromCards(cards, mode) {
  const TYPES = ['evenement','proposition','contrainte','bonus'];
  const turns = (mode === 'blitz') ? 10 : 42;
  const byType = new Map();
  TYPES.forEach(t => byType.set(t, cards.filter(c => c.type === t)));
  const deck = [];
  for (let t=1; t<=turns; t++) {
    deck.push({
      turn: t,
      age: 18 + (t-1),
      evenement: pickWeighted(byType.get('evenement')),
      proposition: pickWeighted(byType.get('proposition')),
      contrainte: pickWeighted(byType.get('contrainte')),
      bonus: pickWeighted(byType.get('bonus')),
    });
  }
  return deck;
}

// ===== Session model =====
function createEmptySession(code) {
  return {
    code,
    lang: 'fr',
    mode: 'long',
    createdAt: now(),
    started: false,
    paused: false,
    turn: 1,
    age: 18,
    phase: 'A',
    deadline: null,
    deck: [],            // [{ turn, age, evenement, proposition, contrainte, bonus }]
    active: null,        // cartes en cours pour le tour
    players: [],         // { id, name, patrimoine, salaire, coutDeVie, rentenpunkte, marqueurs[], lastActive, answered, tourPerso, statusLight }
    decisions: {},       // decisions[playerId][turn] = { evenement:{...}, ... }
    logs: [],            // { ts, turn, name, type, action, wealth, rp, salary, costOfLiving, extra }
    profiles: [],
    profilePool: [],
    logic: null          // deck_logic.v1.1.json (optionnel, pour effets)
  };
}

function broadcastState(s) {
  const payload = JSON.stringify({ type:'state', session: s });
  wss.clients.forEach(ws => {
    const link = CLIENTS.get(ws);
    if (link && link.code === s.code && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  });
}

function sessionFrom(ws) {
  const link = CLIENTS.get(ws);
  if (!link) return null;
  return SESSIONS.get(link.code) || null;
}

function attachClient(ws, role, code, playerId=null) {
  CLIENTS.set(ws, { role, code, playerId });
}

function findPlayer(s, playerId) {
  return (s.players||[]).find(p => p.id === playerId) || null;
}

function ensureDecisions(s, playerId, turn) {
  if (!s.decisions[playerId]) s.decisions[playerId] = {};
  if (!s.decisions[playerId][turn]) s.decisions[playerId][turn] = {};
  return s.decisions[playerId][turn];
}

function setStatusLight(p) {
  // simple feu selon réponses
  p.statusLight = p.answered ? 'green' : 'orange';
}

function computeActiveForTurn(s) {
  const d = s.deck.find(x => x.turn === s.turn);
  if (!d) return s.active = null;
  // Normaliser structure attendue par l'UI (host/student)
  const norm = (c) => !c ? null : ({
    id: c.id || null,
    type: c.type || 'evenement',
    titre: c.titre || c.title || '—',
    texte: c.texte || c.summary || c.advice || '',
    // flags possibles si présents dans ton JSON cartes
    imperative: !!c.imperative,
    requiresInvestment: !!c.requiresInvestment,
    choices: c.choices || null
  });
  s.active = {
    evenement:  norm(d.evenement),
    proposition: norm(d.proposition),
    contrainte:  norm(d.contrainte),
    bonus:       norm(d.bonus)
  };
}

function nextTurn(s) {
  s.turn = clamp((s.turn||1)+1, 1, (s.mode==='blitz'?10:42));
  s.age = 18 + (s.turn - 1);
  recalcPhase(s);
  computeActiveForTurn(s);
  // reset état tour
  (s.players||[]).forEach(p => { p.answered = false; setStatusLight(p); p.tourPerso = s.turn; });
  timeboxSeconds(s, 90);
}

function startGame(s) {
  s.started = true;
  s.turn = 1;
  s.age = 18;
  recalcPhase(s);
  computeActiveForTurn(s);
  (s.players||[]).forEach(p => { p.answered = false; setStatusLight(p); p.tourPerso = s.turn; });
  timeboxSeconds(s, 90);
}

function assignProfiles(s) {
  // distribution simple: piocher séquentiellement dans profilePool
  s.players.forEach(p => {
    if (!p.profile && s.profilePool.length) {
      p.profile = s.profilePool.shift();
      // init stats basiques depuis profil
      const st = p.profile.start || {};
      p.patrimoine   = Number(st.capitalStart||0);
      p.salaire      = Number(st.salaryAnnualNet||0);
      p.coutDeVie    = Number(st.costOfLivingAnnual||0);
      p.rentenpunkte = 0;
      p.marqueurs    = [];
    }
  });
}

function logServer(s, p, type, action, extra={}) {
  s.logs.push({
    ts: now(),
    turn: s.turn,
    name: p ? p.name : '—',
    type, action,
    wealth: p ? p.patrimoine : 0,
    rp: p ? p.rentenpunkte : 0,
    salary: p ? p.salaire : 0,
    costOfLiving: p ? p.coutDeVie : 0,
    extra
  });
  // limite mémoire
  if (s.logs.length > 5000) s.logs = s.logs.slice(-3000);
}

// ===== WS message handling =====
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch(e) { return; }

    switch (msg.type) {
      case 'host:create': {
        const code = makeCode();
        const s = createEmptySession(code);
        s.lang = ['fr','en','de'].includes((msg.lang||'fr').toLowerCase()) ? (msg.lang||'fr').toLowerCase() : 'fr';
        s.mode = (msg.mode==='blitz') ? 'blitz' : 'long';

        // Profils
        s.profiles = loadProfiles(s.lang);
        s.profilePool = shuffle(s.profiles.slice());

        // Cartes externes
        const cards = loadCards(s.lang, s.mode);
        s.logic = loadDeckLogic(); // optionnel (futur moteur d'effets)
        if (cards && cards.length) s.deck = generateDeckFromCards(cards, s.mode);
        else s.deck = generateDeckTemplate(s.mode==='blitz'?10:42);

        computeActiveForTurn(s);
        SESSIONS.set(code, s);
        attachClient(ws, 'host', code);
        ws.send(JSON.stringify({ type:'host:created', code }));
        broadcastState(s);
        break;
      }

      case 'host:resume': {
        const code = (msg.code||'').toUpperCase();
        const s = SESSIONS.get(code);
        if (!s) return;
        attachClient(ws, 'host', code);
        ws.send(JSON.stringify({ type:'host:created', code }));
        broadcastState(s);
        break;
      }

      case 'host:start': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        assignProfiles(s);
        startGame(s);
        broadcastState(s);
        break;
      }

      case 'host:next': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        nextTurn(s);
        broadcastState(s);
        break;
      }

      case 'host:continue': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        s.paused = false;
        timeboxSeconds(s, 90);
        broadcastState(s);
        break;
      }

      case 'student:join': {
        const code = (msg.code||'').toUpperCase();
        const s = SESSIONS.get(code);
        if (!s) return;
        const name = (msg.name||'Étudiant').slice(0, 24);
        const player = {
          id: nanoid(8),
          name,
          patrimoine: 0,
          salaire: 0,
          coutDeVie: 0,
          rentenpunkte: 0,
          marqueurs: [],
          lastActive: now(),
          answered: false,
          tourPerso: s.turn,
          statusLight: 'orange',
        };
        s.players.push(player);
        attachClient(ws, 'student', code, player.id);
        ws.send(JSON.stringify({ type:'student:joined', code, player }));
        broadcastState(s);
        break;
      }

      case 'student:resume': {
        const code = (msg.code||'').toUpperCase();
        const s = SESSIONS.get(code);
        if (!s) return;
        const p = findPlayer(s, msg.playerId);
        if (!p) return;
        attachClient(ws, 'student', code, p.id);
        ws.send(JSON.stringify({ type:'student:joined', code, player: p }));
        broadcastState(s);
        break;
      }

      case 'student:ready': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        const p = findPlayer(s, msg.playerId);
        if (!p) return;
        p.lastActive = now();
        // petit flag visuel côté host (compte comme activité)
        setStatusLight(p);
        broadcastState(s);
        break;
      }

      case 'student:decision': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        const p = findPlayer(s, msg.playerId);
        if (!p) return;
        p.lastActive = now();
        const turn = s.turn;
        const decs = ensureDecisions(s, p.id, turn);
        const t = (msg.cardType||'').toLowerCase();
        decs[t] = { choiceId: msg.choiceId||'CHOICE', extra: msg.extra||null };

        // Heuristique simple: si répondu aux 4 types, mark answered
        const TYPES = ['evenement','proposition','contrainte','bonus'];
        p.answered = TYPES.every(k => decs[k]);
        setStatusLight(p);

        logServer(s, p, 'decision', `${t}:${msg.choiceId||'—'}`, { extra: msg.extra||null });
        broadcastState(s);
        break;
      }

      default: {
        // heartbeat / unknown
        break;
      }
    }
  });

  ws.on('close', () => {
    CLIENTS.delete(ws);
  });
});

console.log('WebSocket listening at /ws');
