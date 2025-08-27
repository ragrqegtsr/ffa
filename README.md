# Finanz‑Weg — Livrable (serveur phases + reprise + timers + feux)

Ce livrable fournit **server-2.js** prêt à l’emploi, conforme au cahier des charges :
- Reprise après refresh (resume host/student)
- Phases A→E avec pause après 21 et deck (42 tours) **pré‑généré**
- Timers indicatifs (host: tours ~3:45, auto: fenêtres)
- Feux tricolores consolidés côté serveur
- Journaux enrichis (salary, costOfLiving) + corrections host
- Séries (Patrimoine / Salaire / Coût / RP)

## Lancer en local
```bash
npm i
node server-2.js
# http://localhost:3000/host.html
# http://localhost:3000/student.html
```
> ⚠️ Dans `host.html` et `student.html`, mets `WS_URL` sur `ws://localhost:3000/ws` pour les tests locaux.
> En prod Render/Railway : `wss://VOTRE-DOMAINE/ws`.

## Déploiement (Render)
- Build Command : `npm install`
- Start Command : `node server-2.js`

## Événements WebSocket

### Host → Serveur
- `host:create` → crée une session `{ code }` (retour `host:created`)
- `host:resume` `{ code }` → rattache l’hôte et renvoie `state`
- `host:start` `{ code }` → génère le deck[42], démarre Phase A @ tour 1
- `host:next` `{ code }` → **phases host** : avance tout le monde d’1 tour (respecte bornes)
- `host:continue` `{ code }` → sort de la **pause** après 21 et passe en **Phase C**

### Étudiant → Serveur
- `student:join` `{ code, name }` → crée joueur `{ playerId }` (retour `student:joined`)
- `student:resume` `{ code, playerId }` → rattache et renvoie `state`
- `student:ready` `{ code, playerId, ready:true }` → marque prêt (indicatif)
- `student:decision` `{ code, playerId, cardType, choiceId|label, extra? }`

### Serveur → Clients
- `host:created` `{ code }`
- `student:joined` `{ code, player }`
- `state` `{ session }` → snapshot **adapté au destinataire** (turn/cartes du joueur en auto‑phase)

## Structure du `session` envoyé
```ts
{
  code: string,
  turn: number,          // Tour vue par le client (host = global, student = perso en auto-phase)
  phase: 'A'|'B'|'C'|'D'|'E',
  age: number,           // approx: 18 + (turn-1)
  paused: boolean,       // pause automatique après 21 (B→C)
  active: {              // cartes du tour courant
    evenement: Card, proposition: Card, contrainte: Card, bonus: Card
  },
  deadline: number|null, // timestamp pour timer indicatif
  players: Array<{
    id, name,
    tourPerso: number,
    patrimoine: number, salaire: number, costOfLiving: number, rentenpunkte: number,
    statusLight: 'red'|'orange'|'green',
    lastActive: number|null,
    answered: boolean
  }>,
  decisions: { [playerId]: { [turn]: { [cardType]: Decision } } },
  logs: Array<{ ts, playerId, name, turn, type, action, extra?, wealth, rp, salary, costOfLiving }>
}
```
