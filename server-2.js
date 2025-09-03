// server-2.js — serveur WS + exposition /data (CORS)
// - Lit les données du jeu depuis ./data/
// - Sert /data en statique avec CORS (front hébergé ailleurs)
// - WebSocket sur /ws pour Host & Étudiants

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const app = express();

// --------- CORS & Static /data ----------
app.use(cors()); // autorise Hostinger à faire fetch() vers ce serveur
app.use('/data', express.static(path.join(__dirname, 'data')));

// Healthcheck simple
app.get('/health', (_req, res) => res.json({ ok: true }));

// --------- Chargement des données du jeu ----------
function loadJson(file) {
  const p = path.join(__dirname, 'data', file);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

let deckStandard = null;
let deckLogic = null;

try {
  deckStandard = loadJson('deck_standard_fr.json');
  deckLogic = loadJson('deck_logic.json');
  console.log(`[INIT] Chargé deck_standard_fr.json (${deckStandard?.nodes?.length ?? 0} nodes)`);
  console.log(`[INIT] Chargé deck_logic.json (${deckLogic?.rules?.length ?? 0} règles)`);
} catch (e) {
  console.error('[INIT] Erreur au chargement des fichiers du jeu dans ./data/', e);
  // On peut choisir de continuer pour permettre au Join de fonctionner,
  // mais pour un jeu complet, mieux vaut arrêter :
  // process.exit(1);
}

// --------- HTTP + WS Server ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --------- Modèle de session ----------
/**
 * Session:
 * {
 *   id: string,
 *   code: string,          // code à 4 lettres
 *   createdAt: ISOString,
 *   options: { mode: 'long'|'blitz', lang: 'fr'|'en'|... },
 *   hostWs: WebSocket|null,
 *   players: [{ id, ws, profile, answered, lastActive, status }],
 *   decisions: { [playerId]: { [turn]: {...} } },
 *   turn: number
 * }
 */
const SESSIONS = new Map();

function nowISO() { return new Date().toISOString(); }

function genCode() {
  // code court et lisible : 4 lettres en majuscules
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I/O
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function setStatusLight(player) {
  const isFresh = (Date.now() - new Date(player.lastActive).getTime()) < 15000;
  player.status = player.answered ? 'green' : (isFresh ? 'yellow' : 'red');
}

function sessionPublicView(s) {
  // Envoi d'un état "propre" sans objets WebSocket
  return {
    id: s.id,
    code: s.code,
    createdAt: s.createdAt,
    options: s.options,
    turn: s.turn,
    players: s.players.map(p => ({
      id: p.id,
      profile: p.profile,
      answered: p.answered,
      lastActive: p.lastActive,
      status: p.status
    }))
  };
}

function broadcastState(s) {
  const payload = JSON.stringify({ type: 'host:state', session: sessionPublicView(s) });
  if (s.hostWs && s.hostWs.readyState === s.hostWs.OPEN) {
    s.hostWs.send(payload);
  }
  for (const p of s.players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

function findSessionByCode(code) {
  for (const s of SESSIONS.values()) if (s.code === code) return s;
  return null;
}

// --------- WebSocket Handling ----------
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      // ---- Hôte crée une session ----
      case 'host:create': {
        const options = msg.options || {};
        const mode = options.mode || 'long';
        const lang = options.lang || 'fr';

        const id = nanoid(10);
        const code = genCode();

        const s = {
          id,
          code,
          createdAt: nowISO(),
          options: { mode, lang },
          hostWs: ws,
          players: [],
          decisions: {},
          turn: 0
        };
        SESSIONS.set(id, s);

        // Confirme à l'hôte + diffuse état
        ws.send(JSON.stringify({ type: 'host:created', session: sessionPublicView(s) }));
        broadcastState(s);
        break;
      }

      // ---- Étudiant rejoint une session ----
      case 'student:join': {
        const { code, profileKey } = msg;
        const s = findSessionByCode(String(code || '').toUpperCase());
        if (!s) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          return;
        }
        // Charge profils (lang par défaut: fr)
        let profiles = [];
        try {
          const lang = s.options?.lang || 'fr';
          const fileName = `profiles.${lang}.json`;
          profiles = loadJson(fileName);
        } catch {
          try {
            profiles = loadJson('profiles.fr.json'); // fallback
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Profiles file missing' }));
            return;
          }
        }

        const profile = profiles.find(p => p.key === profileKey);
        if (!profile) {
          ws.send(JSON.stringify({ type: 'error', message: 'Profile not found' }));
          return;
        }

        const player = {
          id: nanoid(12),
          ws,
          profile,
          answered: false,
          lastActive: nowISO(),
          status: 'yellow'
        };
        setStatusLight(player);
        s.players.push(player);

        // Accusé de réception à l'étudiant + diffusion état
        ws.send(JSON.stringify({ type: 'student:joined', code: s.code, player: { id: player.id, profile: player.profile } }));
        broadcastState(s);
        break;
      }

      // ---- Étudiant signale activité (facultatif) ----
      case 'student:ready': {
        const { code, playerId } = msg;
        const s = findSessionByCode(String(code || '').toUpperCase());
        if (!s) return;
        const p = s.players.find(x => x.id === playerId);
        if (!p) return;
        p.lastActive = nowISO();
        setStatusLight(p);
        broadcastState(s);
        break;
      }

      // (Points d’extension futurs : host:start, host:next, student:answer, etc.)
      default:
        // Pas d’erreur dure : on ignore silencieusement pour compat
        // ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
        break;
    }
  });

  ws.on('close', () => {
    // Nettoyage: si hôte ou étudiant se déconnecte, met à jour la session
    for (const s of SESSIONS.values()) {
      // étudiant
      const idx = s.players.findIndex(p => p.ws === ws);
      if (idx !== -1) {
        s.players.splice(idx, 1);
        broadcastState(s);
        break;
      }
      // hôte
      if (s.hostWs === ws) {
        SESSIONS.delete(s.id);
        break;
      }
    }
  });
});

// Heartbeat WS (nettoyage des connexions mortes)
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(interval));

// --------- Start ----------
server.listen(PORT, () => {
  console.log(`[START] HTTP ${PORT} | WS /ws | static /data (CORS enabled)`);
});
