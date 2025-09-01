// ... existing code ...
const app = express();

// ===== Static =====
// J'ai ajouté /public/data pour que les fichiers JSON soient accessibles si besoin
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'public/data')));


// Basic health
// ... existing code ...
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
// ... existing code ...
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
// ... existing code ...
const findPlayer = (s, playerId) => (s.players||[]).find(p=>p.id===playerId);
const ensurePlayer = (s, playerId) => {
  if (!s.players) s.players = [];
  let p = s.players.find(x => x.id === playerId);
// ... existing code ...
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
// ... existing code ...
      case 'host:draw': {
        const s = SESSIONS.get(msg.sessionId);
        if (!s) return;
        s.turn++;
        s.turnDeadline = Date.now() + (s.timer * 1000);
        // On utilise notre nouvelle fonction de pioche
        const drawn = drawCards(s);
        s.drawnCards = drawn;
        s.players.forEach(p => { p.answered = false; });
// ... existing code ...
