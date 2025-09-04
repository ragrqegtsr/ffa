// server-2.js — Unified Build (compat + modes + ABCDE + random profiles + tolerant file loading)
//
// Includes:
// - Robust file loading from ./data OR ./Data with FR filename variants
// - Static serving of ./public (host.html, student.html) and /health
// - WebSocket path tolerance: /ws, /socket, or even '/' (for older clients)
// - Session creation fixed: emits BOTH 'host:created' and initial 'host:state'
// - Modes: 'long' (42 turns, subphases ABCDE) and 'blitz' (10 turns, no subphases)
// - host:nextPhase to advance A→E (long mode); host:nextTurn/host:next to advance turns
// - Random non-duplicate profiles on student:join (or 'random' key)
// - Deck-based draw (4 cards per turn) from deck_standard_fr.json (ordered piles + fallback)
//
// NOTE: deck_logic.json is loaded and available; rule application is not enforced automatically here.
//       If you want automatic rule evaluation, we can add a pure engine on top of this backbone.

const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const app = express();

// ===== Helpers: tolerant file loader =====
const dataDirCandidates = ['data','Data','DATA'].map(d => path.join(__dirname, d));

function findExistingFile(basenames) {
  for (const dir of dataDirCandidates) {
    for (const base of basenames) {
      const full = path.join(dir, base);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function readJsonOrThrow(basenames, what) {
  const p = findExistingFile(basenames);
  if (!p) throw new Error(`Cannot find ${what}. Tried: ${JSON.stringify(basenames)} in ${JSON.stringify(dataDirCandidates)}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ===== Game Data Loading =====
let deckStandard = readJsonOrThrow(
  ['deck_standard_fr.json','deckstandard.fr.json','deck-standard-fr.json'],
  'deck standard (FR)'
);

let deckLogic = readJsonOrThrow(
  ['deck_logic.json','decklogic.profile.fr.json','decklogic.json'],
  'deck logic'
);

let profiles = readJsonOrThrow(
  ['profiles.fr.json','profiles.json'],
  'profiles (FR)'
);

console.log('Game data loaded successfully:');
console.log(`- ${deckStandard?.nodes?.length ?? 0} card nodes`);
console.log(`- ${deckLogic?.rules?.length ?? 0} rules`);
console.log(`- ${profiles?.length ?? 0} profiles`);

// ===== Static =====
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'host.html')));
} else {
  console.warn('Warning: ./public not found — static pages will not be served.');
}

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`HTTP listening on http://localhost:${PORT}`);
});

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  // Tolerant: accept /ws, /socket, '/'
  const url = (req.url || '/');
  if (url.startsWith('/ws') || url.startsWith('/socket') || url === '/' || url.startsWith('/?')) {
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

const snapshotOf = (s) => ({
  id: s.id,
  code: s.code,
  mode: s.mode,
  maxTurns: s.maxTurns,
  turn: s.turn,
  subphaseIndex: s.subphaseIndex,
  phaseLetter: s.phaseLetter,
  players: s.players.map(p => ({ id: p.id, profile: p.profile, status: p.status })),
  currentCards: s.currentCards || [],
  createdAt: s.createdAt
});

const broadcastState = (s) => {
  const payload = JSON.stringify({ type: 'host:state', session: snapshotOf(s) });
  s.players.forEach(p => { try { p.ws.send(payload); } catch(_){} });
  if (s.hostWs) { try { s.hostWs.send(payload); } catch(_){} }
};

const logServer = (s, p, event, msg) => {
  const phase = s ? (s.phaseLetter ? `(${s.phaseLetter})` : '') : '';
  const turn = s ? `T${s.turn}${phase}` : 'T?';
  const profile = p ? `P:${p.profile?.name ?? '??'}`: 'SYS';
  console.log(`[${s?.code ?? '----'}] ${turn} | ${profile} | ${event} | ${msg}`);
};

// ===== Deck drawing helpers =====
function buildPilesFromDeck(deck) {
  const byPile = new Map();
  for (const node of deck.nodes || []) {
    const pile = (node.pile || 'Autre').toLowerCase();
    if (!byPile.has(pile)) byPile.set(pile, []);
    byPile.get(pile).push(node);
  }
  // shuffle each pile
  for (const pile of byPile.values()) pile.sort(() => Math.random() - 0.5);
  return byPile;
}

function drawNCards(session, n = 4) {
  if (!session.piles) session.piles = buildPilesFromDeck(deckStandard);
  const order = ['proposition','contrainte','bonus','vie','autre'];
  const drawn = [];
  for (const pileName of order) {
    const pile = session.piles.get(pileName);
    while (pile && pile.length && drawn.length < n) {
      const card = pile.shift();
      const seen = session.seenCardIds || (session.seenCardIds = new Set());
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      drawn.push(card);
    }
    if (drawn.length >= n) break;
  }
  if (drawn.length < n) {
    for (const pile of session.piles.values()) {
      while (pile && pile.length && drawn.length < n) {
        const card = pile.shift();
        const seen = session.seenCardIds || (session.seenCardIds = new Set());
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        drawn.push(card);
      }
      if (drawn.length >= n) break;
    }
  }
  session.currentCards = drawn;
  return drawn;
}

function setMode(session, mode) {
  session.mode = (mode === 'blitz') ? 'blitz' : 'long';
  session.maxTurns = session.mode === 'blitz' ? 10 : 42;
  session.subphaseIndex = session.mode === 'long' ? 0 : null;
  session.phaseLetter = session.mode === 'long' ? 'A' : null;
}

function nextTurn(session) {
  if (!session.turn) session.turn = 0;
  session.turn += 1;
  if (session.mode === 'long') {
    session.subphaseIndex = 0;
    session.phaseLetter = 'A';
  }
  const cards = drawNCards(session, 4);
  logServer(session, null, 'host:draw', `Drew ${cards.length} cards`);
}

function nextPhase(session) {
  if (session.mode !== 'long') return;
  if (session.subphaseIndex == null) session.subphaseIndex = 0;
  const idx = session.subphaseIndex + 1;
  if (idx >= 5) {
    session.subphaseIndex = 4;
    session.phaseLetter = 'E';
  } else {
    session.subphaseIndex = idx;
    session.phaseLetter = ['A','B','C','D','E'][idx];
  }
}

// ===== WebSocket handling =====
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn('Ignoring non-JSON message');
      return;
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
          decisions: {},
          createdAt: now(),
          piles: null,
          currentCards: [],
          seenCardIds: new Set(),
          mode: 'long',
          maxTurns: 42,
          subphaseIndex: 0,
          phaseLetter: 'A',
        };
        SESSIONS.set(sessionId, s);
        // Emit both created + initial state
        try { ws.send(JSON.stringify({ type: 'host:created', session: { id: s.id, code: s.code } })); } catch(_){}
        broadcastState(s);
        console.log(`[${code}] Host created session ${sessionId}`);
        break;
      }

      case 'host:setMode': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        setMode(s, msg.mode);
        logServer(s, null, 'host:setMode', `Mode=${s.mode}, maxTurns=${s.maxTurns}`);
        broadcastState(s);
        break;
      }

      case 'host:start': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        if (msg.mode) setMode(s, msg.mode);
        s.piles = buildPilesFromDeck(deckStandard);
        nextTurn(s);
        broadcastState(s);
        break;
      }

      case 'host:nextPhase': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        nextPhase(s);
        broadcastState(s);
        break;
      }

      case 'host:next':
      case 'host:nextTurn': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        if (s.turn >= s.maxTurns) {
          logServer(s, null, 'host:next', `Reached maxTurns=${s.maxTurns}`);
          broadcastState(s);
          break;
        }
        nextTurn(s);
        broadcastState(s);
        break;
      }

      case 'student:join': {
        const { code, profileKey } = msg;
        const s = Array.from(SESSIONS.values()).find(x => x.code === code);
        if (!s) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'Session not found' })); } catch(_){}
          return;
        }
        let chosen;
        if (!profileKey || profileKey === 'random') {
          const already = new Set(s.players.map(pl => pl.profile?.key));
          const pool = profiles.filter(p => !already.has(p.key));
          chosen = pool.length ? pool[Math.floor(Math.random() * pool.length)] : profiles[Math.floor(Math.random() * profiles.length)];
        } else {
          chosen = profiles.find(p => p.key === profileKey);
        }
        if (!chosen) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'Profile not found' })); } catch(_){}
          return;
        }
        const playerId = nanoid(12);
        const p = { id: playerId, ws, profile: chosen, answered: false, lastActive: now() };
        s.players.push(p);
        setStatusLight(p);
        logServer(s, p, 'student:join', `Joined with profile ${chosen.key}`);
        try { ws.send(JSON.stringify({ type:'student:joined', code, player: { id: p.id, profile: p.profile } })); } catch(_){}
        broadcastState(s);
        break;
      }

      case 'student:ready': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        const p = findPlayer(s, msg.playerId);
        if (!p) return;
        p.lastActive = now();
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
        decs[t] = { choiceId: msg.choiceId||'CHOICE', extra: msg.extra||null, phase: s.phaseLetter, subphase: s.subphaseIndex };
        const answeredTypes = Object.keys(decs);
        p.answered = answeredTypes.length >= 4;
        setStatusLight(p);
        broadcastState(s);
        break;
      }

      case 'host:close': {
        const s = Array.from(SESSIONS.values()).find(x => x.code === msg.code);
        if (!s) return;
        logServer(s, null, 'host:close', 'Closing session');
        SESSIONS.delete(s.id);
        break;
      }

      default:
        // No-op
        break;
    }
  });

  ws.on('close', () => {
    for (const s of SESSIONS.values()) {
      const idx = s.players.findIndex(pl => pl.ws === ws);
      if (idx !== -1) {
        const p = s.players[idx];
        logServer(s, p, 'student:disconnect', 'Player disconnected');
        s.players.splice(idx, 1);
        broadcastState(s);
        return;
      }
      if (s.hostWs === ws) {
        logServer(s, null, 'host:disconnect', 'Host disconnected, closing session');
        SESSIONS.delete(s.id);
        return;
      }
    }
  });
});
