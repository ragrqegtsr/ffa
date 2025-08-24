# Finanz‑Weg — Starter Render/Railway

## Structure
```
finanz-weg/
├─ server-2.js
├─ package.json
└─ public/
   ├─ host.html
   └─ student.html
```

## Local
```
npm i
node server.js
# host:  http://localhost:3000/host.html
# student: http://localhost:3000/student.html
```

## Déploiement (Render)
1. Pousse ce dossier sur GitHub.
2. Sur Render: **New Web Service** → connecte le repo.
3. Build Command: `npm install` — Start Command: `node server.js`.
4. Une fois déployé, récupère l'URL publique, ex: `https://mon-jeu.onrender.com`.
5. Dans `public/host.html` et `public/student.html`, remplace `RENDER-URL` par `mon-jeu.onrender.com` (sans `https://`), puis redeploie.

## Utilisation
- Hôte: ouvre `/host.html` → Créer session → Démarrer → Tirer 4 cartes.
- Étudiants: ouvrent `/student.html` → saisissent le code.
