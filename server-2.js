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
// J'ai ajouté /public/data pour que les fichiers JSON soient accessibles si besoin
app.use('/data', express.static(path.join(__dirname, 'public/data')));


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
const SESSIONS = new Map();
let PROFILES = [];
let DECK_CARDS = []; // <- Notre nouveau deck sera chargé ici

try {
  const profilesPath = path.join(__dirname, 'public/data/profiles.fr.json');
  PROFILES = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
  console.log(`Loaded ${PROFILES.length} profiles.`);

  const deckPath = path.join(__dirname, 'public/data/deck_cards.fr.json');
  DECK_CARDS = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
  console.log(`Loaded ${DECK_CARDS.length} cards into the new deck.`);

} catch (e) {
  console.error('Failed to load data files!', e);
  process.exit(1);
}


// ===== Utils =====
const now = () => new Date().toISOString();
const broadcast = (sockets, msg) => {
  if (!sockets) return;
  const str = JSON.stringify(msg);
  sockets.forEach(s => s.send(str, (err) => {
    if (err) console.error(`Failed to send to a socket`, err);
  }));
};
const broadcastState = (s) => {
  if (!s || !s.sockets) return;
  const state = { ...s, sockets: undefined }; // don't leak sockets
  broadcast(s.sockets, { type:'state:update', state });
};
const logServer = (s, player, event, detail, meta) => {
  if (!s.log) s.log = [];
  s.log.push({
    ts: now(),
    turn: s.turn,
    player: player ? {id:player.id, name:player.name} : null,
    event,
    detail,
    meta: meta||null,
  });
};
const ensureDecisions = (s,pId,t) => {
  if(!s.decisions) s.decisions={}; if(!s.decisions[pId])s.decisions[pId]={}; if(!s.decisions[pId][t])s.decisions[pId][t]={}; return s.decisions[pId][t];
};
const setStatusLight = (p) => { p.statusLight = p.answered ? 'green' : 'yellow'; };
const findPlayer = (s, playerId) => (s.players||[]).find(p=>p.id===playerId);
const ensurePlayer = (s, playerId) => {
  if (!s.players) s.players = [];
  let p = s.players.find(x => x.id === playerId);
  if (!p) {
    p = { id: playerId, name: `P-${playerId.substr(0,4)}`, answered: false };
    s.players.push(p);
  }
  return p;
};

// ===== Card Drawing Logic =====
/**
 * Pioche 4 cartes (une de chaque pile) depuis le deck principal.
 * @param {object} session - La session de jeu.
 * @returns {object} Un objet contenant les 4 cartes piochées.
 */
function drawCards(session) {
  const drawn = {};
  const piles = ["Proposition", "Événement", "Contrainte", "Bonus"];

  piles.forEach(pileName => {
    const pileCards = DECK_CARDS.filter(card => card.pile === pileName);
    if (pileCards.length > 0) {
      // Pour l'instant, pioche aléatoire simple.
      // On pourra ajouter une logique pour éviter les doublons plus tard.
      const randomIndex = Math.floor(Math.random() * pileCards.length);
      const card = pileCards[randomIndex];
      // La clé est en minuscule pour correspondre au format attendu par le client
      drawn[pileName.toLowerCase()] = card;
    } else {
      console.warn(`No cards found for pile: ${pileName}`);
    }
  });

  return drawn;
}


// ===== WebSocket Logic =====
wss.on('connection', (ws) => {
  console.log('client connected');
  ws.on('close', () => console.log('client disconnected'));

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    // console.log('RECV', msg);

    switch (msg.type) {
      case 'host:create': {
        const sessionId = nanoid(8);
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const s = {
          id: sessionId,
          code,
          hostId: msg.hostId,
          sockets: [ws],
          players: [],
          state: 'lobby',
          turn: 0,
          timer: 180, // secs
          profiles: PROFILES,
          createdAt: now(),
        };
        SESSIONS.set(sessionId, s);
        ws.send(JSON.stringify({ type:'host:created', sessionId, code }));
        logServer(s, null, 'host:create', `Session ${code}`);
        break;
      }

      case 'host:start': {
        const s = SESSIONS.get(msg.sessionId);
        if (!s) return;
        s.state = 'game';
        s.players.forEach(p => {
          const profile = PROFILES.find(x => x.key === p.profileKey);
          p.patrimoine = profile.start.capitalStart;
          p.rentenpunkte = 0; // todo
        });
        logServer(s, null, 'host:start', `Game started with ${s.players.length} players`);
        broadcastState(s);
        break;
      }

      case 'host:draw': {
        const s = SESSIONS.get(msg.sessionId);
        if (!s) return;
        s.turn++;
        s.turnDeadline = Date.now() + (s.timer * 1000);
        // On utilise notre nouvelle fonction de pioche
        const drawn = drawCards(s);
        s.drawnCards = drawn;
        s.players.forEach(p => { p.answered = false; });
        s.state = 'decision';
        logServer(s, null, 'draw', `Tour ${s.turn}`, { drawn });
        broadcastState(s);
        break;
      }

      case 'student:join': {
        const { code, playerId, name, profileKey } = msg;
        const s = Array.from(SESSIONS.values()).find(x => x.code === code);
        if (!s) {
          ws.send(JSON.stringify({type:'error', message:'Session not found'}));
          return;
        }
        s.sockets.push(ws);
        const p = ensurePlayer(s, playerId);
        p.name = name;
        p.profileKey = profileKey;
        p.lastActive = now();
        setStatusLight(p);

        logServer(s, p, 'student:join', `Joined with profile ${profileKey}`);
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
        broadcastState(s); // broadcast every decision for now
        break;
      }
    }
  });
});

console.log('Server logic loaded.');

