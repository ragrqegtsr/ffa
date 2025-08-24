const express = require('express');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');
const path = require('path');

/**
 * Finanz‑Weg server
 * - Sessions with pre-generated 42 turns of cards
 * - Phases A..E with host/autonomous windows
 * - Non-blocking timers with deadline timestamp
 * - Resume (host:resume, student:resume)
 * - Student heartbeat/activity (student:working)
 * - Per-player tourPerso bounded by phase limits
 * - Decisions tracking per player per turn
 */

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log('HTTP listening on :' + PORT);
});

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

/** ====== Data structures ====== */
const sessions = new Map(); // code -> session

function phaseForTurn(t) {
  if (t >= 1 && t <= 7) return 'A';       // host
  if (t >= 8 && t <= 21) return 'B';      // autonomous
  if (t >= 22 && t <= 26) return 'C';     // host
  if (t >= 27 && t <= 37) return 'D';     // autonomous
  if (t >= 38 && t <= 42) return 'E';     // host (finale)
  return '—';
}
function phaseBounds(phase) {
  switch (phase) {
    case 'A': return { start: 1, end: 7, mode: 'host' };
    case 'B': return { start: 8, end: 21, mode: 'auto' };
    case 'C': return { start: 22, end: 26, mode: 'host' };
    case 'D': return { start: 27, end: 37, mode: 'auto' };
    case 'E': return { start: 38, end: 42, mode: 'host' };
    default:  return { start: 1, end: 42, mode: 'host' };
  }
}
const HOST_TURN_SEC = 3*60 + 45;   // 3m45s
const AUTO_TURN_SEC = 2*60 + 15;   // 2m15s

function newDeck42() {
  // Simple deterministic 42-turns deck with 4 card slots per turn.
  const kinds = ['evenement', 'proposition', 'contrainte', 'bonus'];
  const deck = [];
  for (let t = 1; t <= 42; t++) {
    const cards = {};
    kinds.forEach((k, i) => {
      cards[k] = {
        id: `${k}-${t}`,
        titre: `${k.toUpperCase()} — Tour ${t}`,
        texte: `Texte d'illustration pour ${k} au tour ${t}.`,
        imperative: k === 'contrainte' && t % 3 === 0,
        requiresInvestment: k === 'proposition' && t % 2 === 0,
        choices: (k === 'proposition')
          ? [{ id: 'ACCEPT', label: 'Accepter' }, { id: 'REFUSE', label: 'Refuser' }]
          : [{ id: 'A', label: 'Accepter' }, { id: 'B', label: 'Refuser' }]
      };
    });
    deck.push(cards);
  }
  return deck;
}

function createSession() {
  const code = nanoid(6).toUpperCase();
  const session = {
    code,
    age: 20,
    turn: 0,               // starts at 0 until host:start
    phase: '—',
    deadline: null,        // timestamp (ms)
    createdAt: Date.now(),
    deck: newDeck42(),
    active: null,          // active cards for host/global turn
    players: [],           // {id,name,answered,patrimoine,rentenpunkte,salaire,coutDeVie,marqueurs:[],tourPerso,lastActive,statusLight}
    decisions: {},         // decisions[playerId][turn][type] -> payload
    sockets: { host: new Set(), students: new Map() }, // playerId->ws
    log: []                // for future enrichment
  };
  sessions.set(code, session);
  return session;
}

function setDeadline(session) {
  const ph = phaseForTurn(session.turn);
  session.phase = ph;
  const { mode } = phaseBounds(ph);
  const secs = mode === 'host' ? HOST_TURN_SEC : AUTO_TURN_SEC;
  session.deadline = Date.now() + secs * 1000;
}

function clampTourPerso(session, p) {
  const { start, end, mode } = phaseBounds(phaseForTurn(session.turn));
  if (mode === 'host') {
    p.tourPerso = session.turn; // lock to global
  } else {
    if (p.tourPerso == null) p.tourPerso = start;
    p.tourPerso = Math.max(start, Math.min(end, p.tourPerso));
  }
}

function ensurePlayer(session, name) {
  const id = nanoid(8);
  const p = {
    id, name,
    patrimoine: 0, rentenpunkte: 0,
    salaire: 0, coutDeVie: 0,
    marqueurs: [],
    answered: false,
    tourPerso: null,
    lastActive: Date.now(),
    statusLight: 'red'
  };
  clampTourPerso(session, p);
  session.players.push(p);
  return p;
}

function setActiveForGlobal(session) {
  const idx = Math.max(1, session.turn) - 1;
  session.active = session.deck[idx] || null;
}

function hostStart(session) {
  session.turn = 1;
  session.phase = phaseForTurn(session.turn);
  setActiveForGlobal(session);
  // all players tourPerso align to rules
  session.players.forEach(p => clampTourPerso(session, p));
  setDeadline(session);
}

function hostNext(session) {
  if (session.turn >= 42) return;
  session.turn += 1;
  session.phase = phaseForTurn(session.turn);
  setActiveForGlobal(session);
  // when switching phase, re-clamp all tourPerso
  session.players.forEach(p => clampTourPerso(session, p));
  setDeadline(session);
}

function allActiveTypes(session) {
  return ['evenement', 'proposition', 'contrainte', 'bonus'].filter(t => session.active && session.active[t]);
}

function recordDecision(session, playerId, turn, cardType, payload) {
  if (!session.decisions[playerId]) session.decisions[playerId] = {};
  if (!session.decisions[playerId][turn]) session.decisions[playerId][turn] = {};
  session.decisions[playerId][turn][cardType] = payload;

  // set player answered flag for THIS turn if all types present
  const p = session.players.find(x => x.id === playerId);
  const types = allActiveTypes(session); // types in global deck (structure is same per turn)
  const decForTurn = session.decisions[playerId][turn];
  const done = types.every(t => !!decForTurn[t]);
  p.answered = done;
}

function personalizedSessionSnapshot(session, role, playerId) {
  // Clone shallow session for per-socket emission
  const base = {
    code: session.code,
    age: session.age,
    turn: session.turn,
    phase: session.phase,
    deadline: session.deadline,
    players: session.players.map(p => ({
      id: p.id, name: p.name, patrimoine: p.patrimoine, rentenpunkte: p.rentenpunkte,
      salaire: p.salaire, coutDeVie: p.coutDeVie, marqueurs: p.marqueurs,
      answered: p.answered, tourPerso: p.tourPerso, lastActive: p.lastActive, statusLight: p.statusLight
    })),
    decisions: session.decisions
  };
  if (role === 'host') {
    base.active = session.active;
    return base;
  }
  // student: override active to match player's personal turn if in autonomous phase
  const me = session.players.find(p => p.id === playerId);
  if (!me) {
    base.active = session.active;
    return base;
  }
  const ph = phaseForTurn(session.turn);
  const { mode } = phaseBounds(ph);
  const idx = (mode === 'auto') ? Math.max(1, me.tourPerso || session.turn) - 1 : Math.max(1, session.turn) - 1;
  base.active = session.deck[idx] || session.active;
  return base;
}

function emitStateToHost(session) {
  const payload = JSON.stringify({ type: 'state', session: personalizedSessionSnapshot(session, 'host', null) });
  session.sockets.host.forEach(ws => {
    try { ws.send(payload); } catch {}
  });
}

function emitStateToStudent(session, playerId) {
  const ws = session.sockets.students.get(playerId);
  if (!ws) return;
  const snap = personalizedSessionSnapshot(session, 'student', playerId);
  try { ws.send(JSON.stringify({ type: 'state', session: snap })); } catch {}
}

function emitStateAll(session) {
  emitStateToHost(session);
  session.players.forEach(p => emitStateToStudent(session, p.id));
}

/** ====== WS logic ====== */
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m = null;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || !m.type) return;

    // HOST create
    if (m.type === 'host:create') {
      const s = createSession();
      // attach this socket as host
      s.sockets.host.add(ws);
      ws.__fw = { role: 'host', code: s.code };
      try { ws.send(JSON.stringify({ type: 'host:created', code: s.code })); } catch {}
      try { ws.send(JSON.stringify({ type: 'state', session: personalizedSessionSnapshot(s, 'host', null) })); } catch {}
      return;
    }

    // HOST resume
    if (m.type === 'host:resume') {
      const s = sessions.get(m.code);
      if (!s) return;
      s.sockets.host.add(ws);
      ws.__fw = { role: 'host', code: s.code };
      try { ws.send(JSON.stringify({ type: 'state', session: personalizedSessionSnapshot(s, 'host', null) })); } catch {}
      return;
    }

    // HOST start / next
    if (m.type === 'host:start') {
      const s = sessions.get(m.code);
      if (!s) return;
      hostStart(s);
      emitStateAll(s);
      return;
    }
    if (m.type === 'host:next') {
      const s = sessions.get(m.code);
      if (!s) return;
      hostNext(s);
      // When entering autonomous phases, keep global active for host; students will see per-person
      emitStateAll(s);
      return;
    }

    // STUDENT join
    if (m.type === 'student:join') {
      const s = sessions.get(m.code);
      if (!s) return;
      const p = ensurePlayer(s, (m.name || 'Étudiant').slice(0, 24));
      s.sockets.students.set(p.id, ws);
      ws.__fw = { role: 'student', code: s.code, playerId: p.id };
      // ack to this student
      try { ws.send(JSON.stringify({ type: 'student:joined', code: s.code, player: p })); } catch {}
      // push state to everyone
      emitStateAll(s);
      return;
    }

    // STUDENT resume
    if (m.type === 'student:resume') {
      const s = sessions.get(m.code);
      if (!s) return;
      const p = s.players.find(x => x.id === m.playerId);
      if (!p) return;
      s.sockets.students.set(p.id, ws);
      ws.__fw = { role: 'student', code: s.code, playerId: p.id };
      // send personalized state
      emitStateToStudent(s, p.id);
      // also update host view for "reconnected" presence
      emitStateToHost(s);
      return;
    }

    // STUDENT ready (not blocking, marker only)
    if (m.type === 'student:ready') {
      const s = sessions.get(m.code);
      if (!s) return;
      const p = s.players.find(x => x.id === m.playerId);
      if (!p) return;
      p.lastActive = Date.now();
      p.statusLight = 'orange';
      emitStateAll(s);
      return;
    }

    // STUDENT decision
    if (m.type === 'student:decision') {
      const s = sessions.get(m.code);
      if (!s) return;
      const p = s.players.find(x => x.id === m.playerId);
      if (!p) return;
      const ph = phaseForTurn(s.turn);
      const { mode, start, end } = phaseBounds(ph);
      const turnForDecision = (mode === 'auto') ? (p.tourPerso || start) : s.turn;
      recordDecision(s, p.id, turnForDecision, m.cardType, { choiceId: m.choiceId, label: m.label, extra: m.extra || null });
      p.lastActive = Date.now();

      // If autonomous and all answers done for this personal turn -> advance player's tourPerso (bounded)
      if (mode === 'auto') {
        const types = ['evenement','proposition','contrainte','bonus'].filter(t => s.deck[turnForDecision - 1] && s.deck[turnForDecision - 1][t]);
        const dec = (s.decisions[p.id] && s.decisions[p.id][turnForDecision]) || {};
        const done = types.every(t => !!dec[t]);
        if (done && p.tourPerso < end) {
          p.tourPerso = (p.tourPerso || start);
          p.tourPerso += 1;
          p.answered = false; // reset for next turn
        }
      } else {
        // host-controlled: answered is for current global turn only
        // if everyone answered, host may still press "next"; we don't auto-advance global turn
      }

      // Emit personalized state to this student + host
      emitStateToStudent(s, p.id);
      emitStateToHost(s);
      return;
    }

    // STUDENT working (heartbeat + statusLight + optional tourPerso)
    if (m.type === 'student:working') {
      const s = sessions.get(m.code);
      if (!s) return;
      const p = s.players.find(x => x.id === m.playerId);
      if (!p) return;
      p.statusLight = m.statusLight || p.statusLight || 'red';
      p.lastActive = m.lastActive || Date.now();
      if (typeof m.tourPerso === 'number') {
        p.tourPerso = m.tourPerso;
        clampTourPerso(s, p);
      }
      emitStateToHost(s);
      return;
    }

    // HOST manual edit of a decision (minimal stub)
    if (m.type === 'host:editDecision') {
      const s = sessions.get(m.code);
      if (!s) return;
      const pid = m.playerId;
      const turn = m.turn;
      const t = m.cardType;
      const payload = m.payload || {};
      recordDecision(s, pid, turn, t, payload);
      emitStateAll(s);
      return;
    }
  });

  ws.on('close', () => {
    // Best-effort cleanup: we don't destroy session, just remove socket refs
    if (ws.__fw) {
      const { role, code, playerId } = ws.__fw;
      const s = sessions.get(code);
      if (s) {
        if (role === 'host') {
          s.sockets.host.delete(ws);
        } else if (role === 'student') {
          const cur = s.sockets.students.get(playerId);
          if (cur === ws) s.sockets.students.delete(playerId);
        }
      }
    }
  });
});

console.log('WS ready at /ws');