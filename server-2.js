/**
 * Finanz-Weg — WebSocket server
 * - Pause stricte après le tour 21 (passage à 22 via host:continue)
 * - Journal central des décisions (ts, playerId, name, turn, type, action, extra, wealth, rp, salary, costOfLiving)
 * - Mini-éditeur (host:editDecision)
 * - Cartes avec champs supplémentaires : resume, impacts, exemples, conseils (placeholders)
 *
 * Démarrage: node server-2.js
 * Variables d'env: PORT
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// ---- State ----
/**
 * sessions: Map<code, Session>
 * Session = {
 *   code, createdAt, age, turn, phase, paused, deadline,
 *   players: Player[],
 *   active: { evenement?, proposition?, contrainte?, bonus? },
 *   decisions: { [playerId]: { [turn]: { [type]: Decision } } },
 *   logs: LogItem[]
 * }
 * Player = {
 *   id, name,
 *   patrimoine, rentenpunkte, salaire, coutDeVie,
 *   answered, statusLight, lastActive, tourPerso
 * }
 * Decision = { choiceId?, label?, extra? }
 * LogItem = { ts, playerId, name, turn, type, action, extra, wealth, rp, salary, costOfLiving }
 */
const sessions = new Map();
// sockets meta
const sockets = new WeakMap(); // ws -> { role: 'host'|'student', code, playerId? }

const START_AGE = 18;
const TURN_MIN = 1;
const TURN_MAX = 42;

// ---- HTTP + WS setup ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Finanz-Weg WS server up. Use WebSocket at ws(s)://<host>/ws');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    handleMessage(ws, m);
  });
  ws.on('close', () => { sockets.delete(ws); });
});

server.listen(PORT, () => {
  console.log('WS server listening on', PORT);
});

// ---- Helpers ----
function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function phaseFromTurn(t) {
  if (t >= 1 && t <= 7) return 'A';
  if (t >= 8 && t <= 21) return 'B';
  if (t >= 22 && t <= 26) return 'C';
  if (t >= 27 && t <= 37) return 'D';
  if (t >= 38 && t <= 42) return 'E';
  return '—';
}
function clampTourPerso(t, phase) {
  const ranges = { A: [1, 7], B: [8, 21], C: [22, 26], D: [27, 37], E: [38, 42] };
  const [lo, hi] = ranges[phase] || [TURN_MIN, TURN_MAX];
  if (typeof t !== 'number') return lo;
  return Math.max(lo, Math.min(hi, t));
}
function calcAge(turn) {
  return START_AGE + Math.max(0, (turn | 0) - 1);
}
function ensureSession(code) {
  let s = sessions.get(code);
  if (!s) {
    s = {
      code,
      createdAt: Date.now(),
      age: START_AGE,
      turn: 0,
      phase: '—',
      paused: false,
      deadline: null,
      players: [],
      active: {},
      decisions: {},
      logs: []
    };
    sessions.set(code, s);
  }
  return s;
}
function broadcast(code, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    const meta = sockets.get(client);
    if (meta && meta.code === code && client.readyState === 1) {
      client.send(msg);
    }
  });
}
function publicSession(s) {
  // rien de sensible ici, on renvoie tout ce dont les clients ont besoin
  return {
    code: s.code,
    createdAt: s.createdAt,
    age: s.age,
    turn: s.turn,
    phase: s.phase,
    paused: s.paused,
    deadline: s.deadline,
    players: s.players.map(p => ({
      id: p.id, name: p.name,
      patrimoine: p.patrimoine | 0,
      rentenpunkte: Number(p.rentenpunkte || 0),
      salaire: p.salaire | 0,
      coutDeVie: p.coutDeVie | 0,
      answered: !!p.answered,
      statusLight: p.statusLight || 'red',
      lastActive: p.lastActive || null,
      tourPerso: p.tourPerso ?? null
    })),
    active: s.active,
    decisions: s.decisions,
    logs: s.logs
  };
}
function pushState(s) {
  s.phase = s.phase || phaseFromTurn(s.turn);
  s.age = calcAge(s.turn || 1);
  // Update answered flags
  const neededTypes = ['evenement', 'proposition', 'contrainte', 'bonus'].filter(t => !!s.active[t]);
  s.players.forEach(p => {
    const d = s.decisions?.[p.id]?.[s.turn] || {};
    p.answered = neededTypes.every(t => !!d[t]);
  });
  broadcast(s.code, { type: 'state', session: publicSession(s) });
}
function setDeadline(s, seconds) {
  if (!seconds) { s.deadline = null; return; }
  s.deadline = Date.now() + seconds * 1000;
}
function makeCardsForTurn(turn) {
  // placeholders simples – à remplacer par votre deck réel
  const mk = (type, titre) => ({
    type,
    titre,
    texte: `Tour ${turn}: ${titre} — texte descriptif.`,
    imperative: type === 'contrainte' ? true : false,
    requiresInvestment: type === 'proposition' && (turn % 2 === 0),
    // nouveaux champs pour Drawer étudiant
    resume: `Résumé de ${titre}.`,
    impacts: `Impacts possibles de ${titre}.`,
    exemples: `Exemples concrets de ${titre}.`,
    conseils: `Conseils pour gérer ${titre}.`,
    // choix quand pas d'investissement
    choices: [
      { id: 'ACCEPT', label: 'Accepter' },
      { id: 'REFUSE', label: 'Refuser' }
    ]
  });
  return {
    evenement: mk('evenement', 'Évènement du tour'),
    proposition: mk('proposition', 'Proposition du tour'),
    contrainte: mk('contrainte', 'Contrainte du tour'),
    bonus: mk('bonus', 'Bonus du tour')
  };
}
function ensurePlayer(s, playerId) {
  const p = s.players.find(x => x.id === playerId);
  if (!p) return null;
  return p;
}
function logDecision(s, player, type, action, extra) {
  s.logs.push({
    ts: Date.now(),
    playerId: player.id,
    name: player.name,
    turn: s.turn,
    type,
    action,
    extra: extra || null,
    wealth: player.patrimoine || 0,
    rp: Number(player.rentenpunkte || 0),
    salary: player.salaire || 0,
    costOfLiving: player.coutDeVie || 0
  });
  // garder raisonnable (ex: dernier 500)
  if (s.logs.length > 1000) s.logs.splice(0, s.logs.length - 1000);
}

// ---- Message handling ----
function handleMessage(ws, m) {
  switch (m.type) {
    // --- Host side ---
    case 'host:create': {
      const code = randCode(4);
      const s = ensureSession(code);
      sockets.set(ws, { role: 'host', code });
      ws.send(JSON.stringify({ type: 'host:created', code: s.code }));
      pushState(s);
      break;
    }
    case 'host:resume': {
      if (!m.code) return;
      const s = ensureSession(m.code);
      sockets.set(ws, { role: 'host', code: s.code });
      pushState(s);
      break;
    }
    case 'host:start': {
      if (!m.code) return;
      const s = ensureSession(m.code);
      s.turn = 1;
      s.phase = phaseFromTurn(s.turn);
      s.paused = false;
      s.active = makeCardsForTurn(s.turn);
      setDeadline(s, 90); // timer indicatif par défaut
      pushState(s);
      break;
    }
    case 'host:next': {
      if (!m.code) return;
      const s = ensureSession(m.code);
      // Pause stricte après tour 21
      if (s.turn === 21) {
        s.paused = true;
        setDeadline(s, 0); // coupe le timer
        pushState(s);
        break;
      }
      // Avance tour normal
      if (s.turn < TURN_MAX) {
        s.turn++;
        s.phase = phaseFromTurn(s.turn);
        s.active = makeCardsForTurn(s.turn);
        s.paused = false;
        setDeadline(s, 90);
        pushState(s);
      }
      break;
    }
    case 'host:continue': {
      if (!m.code) return;
      const s = ensureSession(m.code);
      // Basculer en tour 22 (Phase C)
      if (s.turn === 21 && s.paused) {
        s.turn = 22;
        s.phase = 'C';
        s.paused = false;
        s.active = makeCardsForTurn(s.turn);
        setDeadline(s, 90);
        pushState(s);
      }
      break;
    }
    case 'host:editDecision': {
      const { code, playerId, turn, cardType, choiceId, label, extra } = m;
      if (!code || !playerId || !turn || !cardType) return;
      const s = ensureSession(code);
      const p = ensurePlayer(s, playerId);
      if (!p) return;

      s.decisions[playerId] = s.decisions[playerId] || {};
      s.decisions[playerId][turn] = s.decisions[playerId][turn] || {};
      s.decisions[playerId][turn][cardType] = {
        choiceId: choiceId ?? s.decisions[playerId][turn][cardType]?.choiceId ?? null,
        label: label ?? s.decisions[playerId][turn][cardType]?.label ?? null,
        extra: (typeof extra === 'object' && extra !== null) ? extra : (safeParse(extra) ?? s.decisions[playerId][turn][cardType]?.extra ?? null)
      };
      // log d'édition
      s.logs.push({
        ts: Date.now(),
        playerId: p.id,
        name: p.name,
        turn,
        type: `${cardType} (EDIT)`,
        action: choiceId ?? label ?? '—',
        extra: (typeof extra === 'object' ? extra : safeParse(extra)) ?? null,
        wealth: p.patrimoine || 0,
        rp: Number(p.rentenpunkte || 0),
        salary: p.salaire || 0,
        costOfLiving: p.coutDeVie || 0
      });

      pushState(s);
      break;
    }

    // --- Student side ---
    case 'student:join': {
      const code = (m.code || '').toUpperCase();
      if (!code) return;
      const s = ensureSession(code);
      const id = crypto.randomUUID();
      const name = (m.name || 'Étudiant').trim().slice(0, 40);
      const player = {
        id, name,
        patrimoine: 0, rentenpunkte: 0,
        salaire: 0, coutDeVie: 0,
        answered: false,
        statusLight: 'red',
        lastActive: Date.now(),
        tourPerso: s.turn || 1
      };
      s.players.push(player);
      sockets.set(ws, { role: 'student', code, playerId: id });
      ws.send(JSON.stringify({ type: 'student:joined', code, player: { id, name } }));
      pushState(s);
      break;
    }
    case 'student:resume': {
      const code = (m.code || '').toUpperCase();
      if (!code || !m.playerId) return;
      const s = ensureSession(code);
      const p = ensurePlayer(s, m.playerId);
      if (!p) return;
      sockets.set(ws, { role: 'student', code, playerId: p.id });
      pushState(s);
      break;
    }
    case 'student:ready': {
      // peut être stocké si nécessaire
      const code = (m.code || '').toUpperCase();
      const s = ensureSession(code);
      pushState(s);
      break;
    }
    case 'student:decision': {
      const { code, playerId, cardType, choiceId, label, extra } = m;
      if (!code || !playerId || !cardType) return;
      const s = ensureSession(code);
      const p = ensurePlayer(s, playerId);
      if (!p) return;

      s.decisions[playerId] = s.decisions[playerId] || {};
      s.decisions[playerId][s.turn] = s.decisions[playerId][s.turn] || {};
      s.decisions[playerId][s.turn][cardType] = {
        choiceId: choiceId ?? null,
        label: label ?? null,
        extra: (typeof extra === 'object' && extra !== null) ? extra : safeParse(extra)
      };

      // Journal central
      const actionStr = choiceId ?? label ?? '—';
      logDecision(s, p, cardType, actionStr, s.decisions[playerId][s.turn][cardType]?.extra);

      pushState(s);
      break;
    }
    case 'student:working': {
      const { code, playerId, statusLight, tourPerso, lastActive } = m;
      if (!code || !playerId) return;
      const s = ensureSession(code);
      const p = ensurePlayer(s, playerId);
      if (!p) return;
      const ph = s.phase || phaseFromTurn(s.turn || 1);
      p.statusLight = ['red', 'orange', 'green'].includes(statusLight) ? statusLight : p.statusLight;
      p.tourPerso = clampTourPerso(Number(tourPerso ?? p.tourPerso), ph);
      p.lastActive = typeof lastActive === 'number' ? lastActive : Date.now();
      pushState(s);
      break;
    }
  }
}

function safeParse(x) {
  if (x == null) return null;
  if (typeof x === 'object') return x;
  try { return JSON.parse(String(x)); } catch (e) { return null; }
}
