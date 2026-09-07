# Guide de déploiement — Copies & Corrigés

> **Obtention des identifiants** : ce guide contient, pour chaque service
> externe, la marche à pas-à-pas pour obtenir les éléments à renseigner dans
> l'environnement — connexion Google, stockage Cloudflare R2, clés de
> l'assistant IA, secrets internes. Les variables elles-mêmes sont listées
> dans `backend/.env.example`.

## Architecture cible (voir `architecture technique.txt`)

```text
Frontend  → Render Static Site (ou servi par le backend, service unifié)
Backend   → Render Web Service (FastAPI, process persistant : WebSocket)
Database  → Supabase PostgreSQL (via DATABASE_URL)
Files     → Cloudflare R2 (STORAGE_BACKEND=r2)
Login     → Google Identity Services (AUTH_MODE=google)
Code      → GitHub
```

Le stockage objet est désormais la **seule** source des fichiers d'épreuves
(`sujet.md`, `corrige.md`, images) : la base de données ne conserve que les
métadonnées et les `storage_key` (ex.
`epreuves/SECONDAIRE/2023/8f3a2c91/sujet.md`). En développement local, le
backend `local` stocke ces fichiers sous `backend/data/storage/` avec la
même sémantique — aucun compte Cloudflare n'est nécessaire pour développer.

## Développement local

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000

# Frontend (autre terminal)
cd frontend
npm install
npm run dev
```

Par défaut (`STORAGE_BACKEND=local`, `DATABASE_URL` commentée) : SQLite +
stockage disque local. Au premier démarrage, les 3 épreuves d'exemple sont
importées depuis `backend/data/epreuves/{sujets,corriges}/` et écrites dans
le stockage.

## Connexion Google (Google Identity Services)

Le bouton « Se connecter avec Google » charge le SDK officiel
(`accounts.google.com/gsi/client`), obtient un **ID token** côté navigateur
et l'envoie au backend qui le **vérifie** (signature Google + claim
`email_verified`) avant d'ouvrir la session. Il n'y a donc **ni secret
client, ni URI de redirection** à configurer : seul l'**ID client OAuth**
est nécessaire, côté backend ET côté bouton (le frontend le reçoit du
backend via `GET /api/auth/config`).

Pas-à-pas (console [Google Cloud](https://console.cloud.google.com)) :

1. **Créer un projet** (sélecteur de projet en haut → *New Project*, ex.
   `bacprep`).
2. **Écran de consentement OAuth** (*APIs & Services → OAuth consent
   screen*) :
   - *User Type* : **External** ;
   - nom de l'application (ex. « Copies & Corrigés »), e-mail de support et
     e-mail développeur ;
   - scopes : laisser les valeurs par défaut (`openid`, `email`, `profile`
     sont implicites — l'app n'appelle aucune API Google) ;
   - ⚠️ Tant que l'écran est au statut **Testing**, seuls les comptes listés
     dans *Test users* peuvent se connecter : ajouter les adresses de
     l'équipe, puis **Publish app** (statut *In production*) pour ouvrir à
     tous les élèves.
3. **Créer l'ID client** (*APIs & Services → Credentials → Create
   Credentials → OAuth client ID*) :
   - *Application type* : **Web application** ;
   - *Authorized JavaScript origins* : **les origines EXACTES qui servent la
     page de connexion** —
     `http://localhost:5173` (dev) et l'URL de production, ex.
     `https://bacprep-frontend.onrender.com` (ou l'URL du service unifié).
     Aucune URI de redirection n'est requise ;
   - valider puis copier l'ID client (finit par `.apps.googleusercontent.com`).
4. **Configurer le backend** :

```env
AUTH_MODE=google
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

Le frontend bascule automatiquement sur le bouton Google (il lit la config
via `GET /api/auth/config`). Pour revenir au formulaire simulé de dev :
`AUTH_MODE=mock` (refusé en production sans `DEMO_MODE=true`).

💡 En cas d'erreur `origin_mismatch` au clic : l'origine exacte du navigateur
(schéma + hôte + port) manque dans *Authorized JavaScript origins*.

## Stockage Cloudflare R2 (production)

Le stockage objet est la source unique des fichiers d'épreuves ; en dev,
`STORAGE_BACKEND=local` suffit (aucun compte nécessaire). Pour la
production :

1. **Compte Cloudflare** ([dash.cloudflare.com](https://dash.cloudflare.com)) —
   R2 nécessite d'avoir enregistré un moyen de paiement (plan gratuit :
   10 Go de stockage, sortie de données **gratuite**).
2. **Activer R2** (*menu gauche → R2 Object Storage* → première activation).
3. **Account ID** : visible sur la vue d'ensemble R2 (colonne de droite,
   « Account ID ») → c'est `R2_ACCOUNT_ID`.
4. **Créer le bucket** (*R2 → Create bucket*, ex. `bacprep-files`, région
   auto) → c'est `R2_BUCKET`. Pas d'accès public, pas de règle CORS à
   configurer : les fichiers restent privés et sont servis par URLs signées.
5. **Créer le jeton S3** (*R2 → Manage API Tokens → Create API Token*) :
   - permission : **Object Read & Write** ;
   - scope : **limiter au bucket** créé ci-dessus ;
   - valider : les **Access Key ID** et **Secret Access Key** affichés UNE
     seule fois sont `R2_ACCESS_KEY_ID` et `R2_SECRET_ACCESS_KEY`.

6. **Configurer le backend** :

```env
STORAGE_BACKEND=r2
R2_ACCOUNT_ID=...          # 32 caractères hexadécimaux
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=bacprep-files
R2_SIGNED_URL_EXPIRY=900   # URLs valables 15 min
```

L'application construit elle-même l'endpoint S3
`https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. Les fichiers privés sont
servis par `GET /api/files/{id}` après vérification des droits : en backend
`r2`, la route redirige (302) vers une **URL signée temporaire** — les
identifiants du bucket ne quittent jamais le serveur, et la charge de servir
les fichiers ne repose pas sur FastAPI.

Vérification : depuis le back-office, téléverser une image sur une épreuve
puis confirmer que l'objet apparaît dans le bucket côté Cloudflare.

## Clés de l'assistant IA (Gemini / Groq)

L'assistant interroge Gemini et/ou Groq ; sans clé configurée, il répond en
**mode démonstration** (réponse simulée, aucune API payante appelée).

- **Gemini** ([Google AI Studio](https://aistudio.google.com)) : *Get API
  key → Create API key* (dans un projet Google Cloud) → `GEMINI_API_KEY`.
  Modèle via `GEMINI_MODEL` (défaut `gemini-3.5-flash`).
- **Groq** ([console.groq.com](https://console.groq.com)) : *API Keys →
  Create API Key* → `GROQ_API_KEY`. Modèle via `GROQ_MODEL` (défaut
  `llama-3.3-70b-versatile` ; alternatives commentées dans `.env.example`).

Configurer au moins une des deux clés ; `LLM_CONCURRENCY_LIMIT` borne le
coût (20 questions / 5 min / utilisateur côté API).

## Base de données PostgreSQL (Supabase)

SQLite ne doit être utilisé qu'en développement local. En production,
créer un projet [Supabase](https://supabase.com), puis récupérer la chaîne
de connexion (*Project Settings → Database → Connection string → URI*) et
la passer en `DATABASE_URL` (utiliser le pooler sur le port 6543 si le
nombre de connexions simultanées dépasse les limites). Au premier
démarrage sur une base VIDE, `Base.metadata.create_all` crée tout le
schéma.

⚠️ Les bases de dev/prod partagent le même code de seed : une base vide
est automatiquement peuplée des 3 épreuves d'exemple au démarrage.

⚠️ **Évolution d'une base EXISTANTE** : `create_all` ne crée que les tables
absentes, jamais les nouvelles colonnes. Après une mise à jour du code
touchant au schéma, exécuter la migration idempotente (compatible
SQLite/PostgreSQL) :

```bash
python -m scripts_dev.migrate_2026_09
```

## Variables d'environnement (backend)

Voir `backend/.env.example` pour la liste complète commentée. Au minimum :

- `DATABASE_URL` (PostgreSQL Supabase en prod)
- `STORAGE_BACKEND=r2` + les 5 variables `R2_*` (voir plus haut)
- `ADMIN_TOKEN`, `ADMIN_EMAILS`
- `GEMINI_API_KEY` et/ou `GROQ_API_KEY` (sinon l'assistant tourne en mode
  démonstration)
- `AUTH_MODE=mock` (dev) ou `google` + `GOOGLE_CLIENT_ID` (prod, voir plus haut)
- `CORS_ORIGINS` (ex. `https://mon-front.onrender.com`) — laisser vide en
  service unifié (même origine)
- `FILE_URL_SECRET` (optionnel mais recommandé en prod : clé HMAC des URL
  signées `/api/files/...`, sinon dérivée d'`ADMIN_TOKEN`)

**Génération des secrets** (`ADMIN_TOKEN`, `FILE_URL_SECRET`) — ne jamais
réutiliser la valeur d'exemple `admin123` en production (le serveur la
refuse) :

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**`ADMIN_EMAILS`** : liste blanche CSV des adresses pouvant ouvrir la
console `/admin` (elles doivent AUSSI se connecter comme élève — le lien
admin n'apparaît que pour ces comptes).

## Déploiement Render

Le `render.yaml` décrit un Blueprint avec **deux services conformes à
l'architecture cible** :

- `bacprep-web` (Web Service Python) : FastAPI, sert l'API ;
- `bacprep-frontend` (Static Site) : `npm run build` du dossier frontend,
  `VITE_API_URL` pointant vers l'URL du backend, règle SPA renvoyant
  `index.html`.

Alternative service unifié (un seul service, comme le prototype
précédent) : construire le frontend (`npm run build`) avant de démarrer le
backend ; quand `frontend/dist` existe, le backend le sert en SPA
catch-all.

Étapes :

1. Pousser ce dépôt sur GitHub/GitLab.
2. Sur [render.com](https://render.com), **New → Blueprint**, pointer le
   dépôt.
3. Renseigner les secrets (`sync: false`) : clés LLM (`GEMINI_API_KEY` /
   `GROQ_API_KEY`), variables `R2_*`, `ADMIN_TOKEN` (valeur forte),
   `ADMIN_EMAILS`, `FILE_URL_SECRET`, `AUTH_MODE=google` +
   `GOOGLE_CLIENT_ID` (voir sections ci-dessus pour les obtenir).
4. Déployer, puis vérifier : `/api/health` répond ; `/connexion` affiche le
   bouton Google ; une image d'épreuve se charge (R2).

## Import massif des épreuves

Deux voies (même moteur) :

- **Interface admin** (`/admin` → onglet *Import massif*) : uploader une
  archive `.zip` d'un dossier organisé `{annee}/{classe}/{matiere}/*.md`
  (+ images) ; le traitement tourne en tâche de fond et le rapport
  (créées, doublons, métadonnées manquantes, erreurs) s'affiche à la fin ;
- **CLI sur le serveur** : déposer le dossier dans la zone d'import
  (`backend/data/imports/`, configurable via `IMPORTS_DIR`) puis :

```bash
python -m app.scripts.importer                          # import réel
python -m app.scripts.importer --dry-run                # simulation
python -m app.scripts.importer --dir chemin/vers/dossier
```

Les épreuves importées arrivent en **brouillon** : à relire dans le
back-office puis publier.
