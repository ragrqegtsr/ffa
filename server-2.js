// server-2.js — vNext
// - Lecture des cartes depuis: data/deck_standard_fr.json
// - Lecture de la logique depuis: data/deck_logic.json
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

// ===== Game Data Loading =====
// Chargement de la structure des cartes et de la logique de jeu.
let deckStandard;
let deckLogic;

try {
  const deckStandardPath = path.join(__dirname, 'data', 'deck_standard_fr.json');
  const deckLogicPath = path.join(__dirname, 'data', 'deck_logic.json');

  deckStandard = JSON.parse(fs.readFileSync(deckStandardPath, 'utf-8'));
  deckLogic = JSON.parse(fs.readFileSync(deckLogicPath, 'utf-8'));

  console.log('Game data loaded successfully:');
  console.log(`- ${deckStandard.nodes.length} card nodes from deck_standard_fr.json`);
  console.log(`- ${deckLogic.rules.length} rules from deck_logic.json`);

} catch (error) {
  console.error('Error loading game data files:', error);
  process.exit(1); // Stop the server if data can't be loaded
}


// ===== Static =====
// Le serveur n'héberge plus les pages HTML.
// Il expose uniquement le dossier /data pour que les fichiers JSON soient accessibles.
app.use('/data', express.static(path.join(__dirname, 'data')));


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


const SESSIONS = new Map();
const now = () => new Date().toISOString();

const findPlayer = (s, playerId) => s.players.find(p => p.id === playerId);
const ensureDecisions = (s, playerId, turn) => {
  s.decisions[playerId] = s.decisions[playerId] || {};
  s.decisions[playerId][turn] = s.decisions[playerId][turn] || {};
  return s.decisions[playerId][turn];
};
const setStatusLight = (p) => {
  const isFresh = (new Date() - new Date(p.lastActive)) < 15000;
  p.status = p.answered ? 'green' : (isFresh ? 'yellow' : 'red');
};

// Send state to all players in a session
const broadcastState = (s) => {
  const state = JSON.stringify({ type: 'host:state', session: s });
  s.players.forEach(p => p.ws.send(state));
  if (s.hostWs) s.hostWs.send(state);
};

const logServer = (s, p, event, msg) => {
  const turn = s ? `T${s.turn}` : 'T?';
  const profile = p ? `P:${p.profile.name}`: 'SYS';
  console.log(`[${s.code}] ${turn} | ${profile} | ${event} | ${msg}`);
}


wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      return; // Ignore malformed JSON
    }

    switch (msg.type) {
      case 'host:create': {
        const sessionId = nanoid(8);
        const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
        const s = {
          id: sessionId,
          code,
          hostWs: ws,
          players: [],
          turn: 0,
          decisions: {}, // { playerId: { turn: { cardType: decision } } }
          createdAt: now(),
        };
        SESSIONS.set(sessionId, s);
        ws.send(JSON.stringify({ type: 'host:created', session: s }));
        console.log(`[${code}] Host created session ${sessionId}`);
        break;
      }

      case 'student:join': {
        const { code, profileKey } = msg;
        const s = Array.from(SESSIONS.values()).find(x => x.code === code);
        if (!s) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          return;
        }

        // TEMP: charger les profils à la volée
        const profiles = require('./data/profiles.fr.json');
        const profile = profiles.find(p => p.key === profileKey);
        if (!profile) {
            ws.send(JSON.stringify({ type: 'error', message: 'Profile not found' }));
            return;
        }

        const playerId = nanoid(12);
        const p = { id: playerId, ws, profile, answered: false, lastActive: now() };
        s.players.push(p);
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

        logServer(s, p, 'student:decision', `Answered ${t} (answered all: ${p.answered})`);
        broadcastState(s);
        break;
      }
    }
  });

  ws.on('close', () => {
    // Find session and player to remove
    for (const s of SESSIONS.values()) {
      const playerIndex = s.players.findIndex(p => p.ws === ws);
      if (playerIndex !== -1) {
        const p = s.players[playerIndex];
        logServer(s, p, 'student:disconnect', 'Player disconnected');
        s.players.splice(playerIndex, 1);
        broadcastState(s);
        break;
      }
      if (s.hostWs === ws) {
        logServer(s, null, 'host:disconnect', 'Host disconnected, closing session');
        SESSIONS.delete(s.id);
        break;
      }
    }
  });
});
