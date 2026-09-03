# Guide de déploiement — Copies & Corrigés

## Architecture cible (voir `architecture technique.txt`)

```text
Frontend  → Render Static Site (ou servi par le backend, service unifié)
Backend   → Render Web Service (FastAPI, process persistant : WebSocket)
Database  → Supabase PostgreSQL (via DATABASE_URL)
Files     → Cloudflare R2 (STORAGE_BACKEND=r2)
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

## Stockage Cloudflare R2 (production)

1. Créer un bucket R2 dans le dashboard Cloudflare (ex. `bacprep-files`).
2. Dans *R2 → Manage API Tokens*, créer un **token S3 API** (Object Read &
   Write limité au bucket) : cela fournit `R2_ACCESS_KEY_ID` et
   `R2_SECRET_ACCESS_KEY`, et l'identifiant de compte fournit
   `R2_ACCOUNT_ID` (l'endpoint devient
   `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).
3. Configurer les variables d'environnement du backend :

```env
STORAGE_BACKEND=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=bacprep-files
R2_SIGNED_URL_EXPIRY=900
```

Les fichiers privés sont servis par `GET /api/files/{id}` après vérification
des droits : en backend `r2`, la route redirige (302) vers une **URL signée
temporaire** — les identifiants du bucket ne quittent jamais le serveur, et
la charge de servir les fichiers ne repose pas sur FastAPI.

## Base de données PostgreSQL (Supabase)

SQLite ne doit être utilisé qu'en développement local. En production,
créer un projet [Supabase](https://supabase.com), puis récupérer la chaîne
de connexion (*Project Settings → Database → Connection string → URI*) et
la passer en `DATABASE_URL` (utiliser le pooler sur le port 6543 si le
nombre de connexions simultanées dépasse les limites). Aucune migration
manuelle : `Base.metadata.create_all` crée le schéma au démarrage.

⚠️ Les bases de dev/prod partagent le même code de seed : une base vide
est automatiquement peuplée des 3 épreuves d'exemple au démarrage.

## Variables d'environnement (backend)

Voir `backend/.env.example` pour la liste complète commentée. Au minimum :

- `DATABASE_URL` (PostgreSQL Supabase en prod)
- `STORAGE_BACKEND=r2` + les 5 variables `R2_*`
- `ADMIN_TOKEN`, `ADMIN_EMAILS`
- `GEMINI_API_KEY` et/ou `GROQ_API_KEY` (sinon l'assistant tourne en mode
  démonstration)
- `AUTH_MODE=mock` (ou `google` + `GOOGLE_CLIENT_ID`)
- `CORS_ORIGINS` (ex. `https://mon-front.onrender.com`) — laisser vide en
  service unifié (même origine)
- `FILE_URL_SECRET` (optionnel mais recommandé en prod : clé HMAC des URL
  signées `/api/files/...`, sinon dérivée d'`ADMIN_TOKEN`)

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
3. Renseigner les secrets (`sync: false`) : clés LLM, `R2_*`,
   `ADMIN_TOKEN`...
4. Déployer.

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
