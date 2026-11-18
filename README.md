# French Flair — Moda

Plateforme interne pour accélérer le développement de jeux 3D / VR :

1. **Générateur d'assets 3D** — décrivez un objet, Claude enrichit la demande
   (échelle, réalisme), génère le code de modélisation, Blender le modélise,
   l'IA vérifie le résultat sur des rendus et le corrige, puis **vous** validez
   l'asset dans un lecteur three.js avant son entrée en bibliothèque (`.glb`).
2. **Éditeur de maps** — chargez une map (SketchUp → GLB), glissez-déposez les
   assets de la bibliothèque, sauvegardez le layout et exportez la scène
   complète en **un seul `.glb`** importable dans Unity (via glTFast/UnityGLTF)
   ou Unreal (import glTF natif).

L'accès est réservé aux adresses **@frenchflair.pro** : connexion par code à
usage unique envoyé par email.

---

## Démarrage rapide

```bash
# 1. Dépendances
npm install

# 2. Configuration
cp .env.example .env     # puis remplissez (voir ci-dessous)

# 3. Conteneur Blender (modélisation + rendus, protocole blender-mcp port 9876)
docker compose up -d blender

# 4. Serveur web
npm start                # → http://localhost:3000
```

Sans configuration supplémentaire, tout fonctionne en **mode développement** :
- les codes de connexion s'affichent dans la console du serveur (pas d'email) ;
- le générateur produit un asset de démonstration (pas d'appel à Claude).

## Configuration (.env)

| Variable | Rôle |
|---|---|
| `SMTP_HOST/PORT/USER/PASS/FROM` | Envoi réel des codes OTP par email. Vide → code affiché en console. |
| `ANTHROPIC_API_KEY` | Clé API Claude. Vide → générateur en mode démo. |
| `CLAUDE_MODEL` | Modèle utilisé (`claude-opus-5-5` par défaut). |
| `CLAUDE_MODEL_CODE` | Modèle présélectionné pour la modélisation. Dans le générateur, chaque demande peut choisir **Opus 5.5** (équilibré) ou **Fable 5.2** (qualité max, plafond de sortie relevé à 128K), avec le prix moyen par objet affiché. |
| `MAX_FIX_ITERATIONS` | Boucles de correction automatique max (3 par défaut). |
| `BLENDER_MCP_HOST/PORT` | Adresse du pont Blender (conteneur : `127.0.0.1:9876`). |
| `SESSION_SECRET` | **Obligatoire en production.** Signe sessions et codes. |
| `NODE_ENV=production` + `TRUST_PROXY=1` | Déploiement public derrière un reverse proxy HTTPS. |

## Fonctionnement du générateur (outil 1)

```
Demande → [Claude] spécification (dimensions réelles, style, matériaux)
        → [Claude] script Python bpy
        → [Blender/Docker] modélisation + 4 rendus de contrôle (Cycles)
        → [Claude vision] liste des problèmes
        → corrections automatiques (max N itérations)
        → export .glb → lecteur three.js → VALIDATION HUMAINE
        → bibliothèque assets/ (+ métadonnées SQLite)
```

- Rejeter un asset **avec un commentaire** relance automatiquement une
  correction tenant compte de votre retour.
- La bibliothèque locale (`assets/`) joue le rôle du Google Drive : la
  synchronisation Drive pourra être branchée plus tard (compte de service
  Google Cloud) sans changer le reste du pipeline.

## Éditeur de maps (outil 2)

- Les maps vont dans `scenes/` (ou bouton « Importer une map (.glb) »).
  Export SketchUp recommandé : **mètres, axe Y vers le haut**.
- Raccourcis : glisser-déposer pour placer, clic pour sélectionner et déplacer,
  `R` rotation 90°, `+`/`−` échelle, `Suppr` retirer, `Échap` désélectionner.
- **Poser un objet sur un autre** (souris sur un bureau, livre sur un carton…) :
  un objet 🟫 sol se pose sur la surface visée — sol, meuble **de la map**
  (table, étagère, estrade, toit) ou objet déjà placé — si elle est assez
  grande : le centre et la majorité de son emprise doivent reposer dessus, et
  la hauteur libre au-dessus doit suffire. Sinon il retombe sur la surface en
  dessous (au pire le sol). Viser une face verticale (paroi, écran, mur) pose
  l'objet à son pied. Pendant le glisser, le support est encadré et le statut
  indique où l'objet va atterrir. `Alt` maintenu : forcer la pose au sol.
- Un objet posé sur un **objet placé** en devient l'enfant : déplacer, tourner
  ou agrandir le support l'entraîne (il garde sa taille) ; supprimer le
  support supprime aussi ce qui est posé dessus. Empilement illimité.
  Un objet 🧱 mur peut aussi se coller sur la face d'un objet placé.
- Magnétisme de grille au sol uniquement ; placement libre sur les supports.
- Les assets gardent leur taille réelle (pas d'agrandissement des petits
  objets) ; seuls les modèles de plus de 8 m sont ramenés à 4 m.
- « Sauvegarder la map » conserve le layout côté serveur (`data/layouts/`) :
  transformation monde de chaque objet + `id` / `parent` pour les objets posés.
- « Exporter en .glb » télécharge la scène complète : la map + chaque objet
  placé comme nœud nommé (`banc_1`, `arbre_2`…), en mètres, axe Y haut. Un
  objet posé sur un autre est son nœud enfant (`bureau_1 › souris_1`).
- Le raycasting est accéléré par [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
  (chargé depuis unpkg) ; la logique de pose est dans `public/placement.js`.

## Sécurité

- **Authentification** : OTP 6 chiffres hashé (HMAC-SHA256), 10 min de
  validité, 5 essais max, quotas d'envoi par email et par IP, réponses
  identiques quel que soit l'email (pas d'énumération). Sessions opaques
  (64 hex) stockées hashées, cookie `HttpOnly` + `SameSite=Strict`
  (+ `Secure` en production).
- **HTTP** : CSP stricte (scripts limités à `self` + unpkg + hash de
  l'importmap), `X-Frame-Options: DENY`, `nosniff`, rate limiting global et
  par endpoint sensible, contrôle d'origine sur toutes les mutations (CSRF),
  limites de taille de corps.
- **Fichiers** : noms de fichiers validés (anti-traversée), uploads `.glb`
  vérifiés par en-tête magique, fichiers 3D servis uniquement aux utilisateurs
  connectés.
- **Code généré par l'IA** : exécuté exclusivement dans le conteneur Docker
  Blender (sans privilèges, `cap_drop: ALL`, port lié à 127.0.0.1).
- **Secrets** : uniquement dans `.env` (non committé), jamais côté client.

## Arborescence

```
server/          backend Express (auth, API, pipeline, client Blender MCP)
blender/         Dockerfile + bridge.py (pont MCP dans Blender headless)
public/          frontend (login, hub, générateur, éditeur — DA French Flair)
assets/          bibliothèque d'assets validés (.glb) — « drive » local
scenes/          maps (SketchUp → GLB)
data/            base SQLite, layouts, sorties Blender (non committé)
index.html       charte graphique French Flair (visible sur /charte)
```

> Police display « Magica » : déposez `Magica.otf` dans `public/fonts/` pour
> l'activer (sinon repli serif automatique).
