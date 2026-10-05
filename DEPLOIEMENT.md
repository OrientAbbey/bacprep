# Guide de déploiement — Copies & Corrigés

> **Obtention des identifiants** : ce guide contient, pour chaque service
> externe, la marche à pas-à-pas pour obtenir les éléments à renseigner dans
> l'environnement — connexion Google, stockage objet S3-compatible, clés de
> l'assistant IA, secrets internes. Les variables elles-mêmes sont listées
> dans `backend/.env.example`.

## Architecture cible (voir `architecture technique.txt`)

```text
Frontend  → Render Static Site (ou servi par le backend, service unifié)
Backend   → Render Web Service (FastAPI, process persistant : WebSocket)
Database  → Supabase PostgreSQL (via DATABASE_URL, pooler IPv4)
Files     → Stockage objet S3-compatible (STORAGE_BACKEND=s3, cf. ci-dessous)
Login     → Google Identity Services (AUTH_MODE=google)
Code      → GitHub
```

Le stockage objet est désormais la **seule** source des fichiers d'épreuves
(`sujet.md`, `corrige.md`, images) : la base de données ne conserve que les
métadonnées et les `storage_key` (ex.
`epreuves/SECONDAIRE/2023/8f3a2c91/sujet.md`). En développement local, le
backend `local` stocke ces fichiers sous `backend/data/storage/` avec la
même sémantique — aucun compte cloud n'est nécessaire pour développer.

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
     `http://localhost:5173` (dev) et l'URL du service unifié en production
     (ex. `https://bacprep-web.onrender.com` ou votre domaine personnalisé).
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

## Stockage objet S3-compatible (production)

Le stockage objet est la source unique des fichiers d'épreuves ; en dev,
`STORAGE_BACKEND=local` suffit (aucun compte nécessaire). En production,
**un seul et même client boto3** sert tous les fournisseurs S3-compatible —
seules les variables `STORAGE_*` changent :

| Fournisseur | Endpoint (`STORAGE_ENDPOINT_URL`) | Région (`STORAGE_REGION`) | Offre gratuite |
| --- | --- | --- | --- |
| **Tigris Data** *(choisi par défaut)* | `https://fly.storage.tigris.dev` | `auto` | 5 Go, 10 000 requêtes écriture/mois, 100 000 GET/mois, **egress illimité à 0 $**, sans carte bancaire |
| Supabase Storage | `https://<project_ref>.supabase.co/storage/v1/s3` | région du projet (ex. `eu-central-1`) | 1 Go + egress inclus, clés S3 générées dans le dashboard, sans carte bancaire |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | région du bucket (ex. `eu-central-003`) | 10 Go, egress libre jusqu'à 3× le stockage, clés = Application Key |

Le bucket (ex. `bacprep`) doit être créé **privé** côté fournisseur AVANT le
premier démarrage (l'application n'a pas le droit de créer les buckets, elle
y écrit seulement). Les fichiers restent privés et sont servis par **URLs
signées** temporaires : en backend objet (`s3`/`r2`), `GET /api/files/{id}`
redirige (302) vers une URL signée courte — les identifiants du bucket ne
quittent jamais le serveur et la charge de servir ne repose pas sur FastAPI.

### Tigris Data (défaut)

1. Compte sur [console.storage.dev](https://console.storage.dev) (aucune
   carte bancaire requise) → créer un bucket (ex. `bacprep`, accès privé).
2. Onglet *Access Keys* → générer une paire `Access Key ID` / `Secret`.
3. Renseigner :
   `STORAGE_ENDPOINT_URL=https://fly.storage.tigris.dev`, `STORAGE_REGION=auto`.

### Supabase Storage

1. **Storage → Configuration → S3 → Generate new key**
   (accès serveur, contourne les politiques RLS — usage uniquement côté
   backend).
2. **Storage → New bucket** : nom = `STORAGE_BUCKET` (ex. `bacprep`),
   Access control = **Private**.
3. Renseigner : `STORAGE_ENDPOINT_URL=https://<project_ref>.supabase.co/storage/v1/s3`
   et `STORAGE_REGION=<région du projet>` (visible dans le dashboard).

### Backblaze B2

1. Panneau B2 → **Create a Bucket** (privé) ; l'URL d'API de la clé donne le
   `s3.<region>.backblazeb2.com` à renseigner.
2. **Application Keys** → créer une clé avec accès **lecture + écriture**
   (`Access Key ID` / `Key Name` / `applicationKey`).

```env
# Tigris (défaut) — ou l'endpoint/région d'un autre fournisseur (tableau ci-dessus)
STORAGE_BACKEND=s3
STORAGE_ENDPOINT_URL=https://fly.storage.tigris.dev
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_BUCKET=bacprep
STORAGE_SIGNED_URL_EXPIRY=900
```

Vérification : depuis le back-office, téléverser une image sur une épreuve
puis confirmer que l'objet apparaît dans le bucket côté fournisseur.

## Clés de l'assistant IA (Gemini / Groq)

L'assistant interroge Gemini et/ou Groq ; sans clé configurée, il répond en
**mode démonstration** (réponse simulée, aucune API payante appelée).

- **Gemini** ([Google AI Studio](https://aistudio.google.com)) : *Get API
  key → Create API key* (dans un projet Google Cloud) → `GEMINI_API_KEY`.
  Modèles via `GEMINI_MODELS` (CSV, fallback ordonné, défaut
  `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash`).
- **Groq** ([console.groq.com](https://console.groq.com)) : *API Keys →
  Create API Key* → `GROQ_API_KEY`. Modèles via `GROQ_MODELS` (CSV,
  fallback ordonné, défaut `openai/gpt-oss-20b,qwen/qwen3.6-27b,
openai/gpt-oss-120b,qwen/qwen3.8-27b`).

Configurer au moins une des deux clés ; `LLM_CONCURRENCY_LIMIT` borne le
coût (20 questions / 5 min / utilisateur côté API). Le **fallback est
ordonné** : chaque fournisseur essaie sa liste de modèles dans l'ordre
déclaré, un échec (quota 429, indisponibilité) fait passer au modèle
suivant, puis à l'autre fournisseur, puis au mode démonstration (aucune
clé ou tous les modèles en échec).

## Base de données PostgreSQL (Supabase)

SQLite ne doit être utilisé qu'en développement local. En production,
créer un projet [Supabase](https://supabase.com), puis récupérer la chaîne
de connexion dans *Project Settings → Database → Connection string* en
sélectionnant l'onglet **Pooler** puis **Transaction** — c'est l'URL à
mettre dans `DATABASE_URL` :

```text
postgresql://postgres.<project_ref>:<mot_de_passe>@aws-0-<région>.pooler.supabase.com:6543/postgres
```

⚠️ **Ne PAS utiliser la connexion directe** `db.<project_ref>.supabase.co:5432` :
elle résout en IPv6 uniquement, et Render ne route pas l'IPv6 → échec
`Network is unreachable` au démarrage. Le pooler Supavisor (port 6543) est
accessible en IPv4. Le `sslmode=require` est ajouté automatiquement par
`backend/app/db.py` (surcharge via `DB_SSLMODE` si besoin). Au premier
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

- `DATABASE_URL` (pooler Supabase, port 6543 — voir plus haut)
- `STORAGE_BACKEND=s3` + les 5 variables `STORAGE_*` (voir plus haut)
- `ADMIN_TOKEN`, `ADMIN_ROOT`
- `GEMINI_API_KEY` et/ou `GROQ_API_KEY` (sinon l'assistant tourne en mode
  démonstration)
- `AUTH_MODE=mock` (dev) ou `google` + `GOOGLE_CLIENT_ID` (prod, voir plus haut)
- `CORS_ORIGINS` (ex. `https://mon-front.onrender.com`) — laisser vide en
  service unifié (même origine)
- `FILE_URL_SECRET` (optionnel mais recommandé en prod : clé HMAC des URL
  signées `/api/files/...`, sinon dérivée d'`ADMIN_TOKEN`)
- `DOCS_PATH` : chemin secret où servir `/docs`/`/redoc`/`/openapi.json` en
  production (ex. `api-docs-9f2k`) ; laissé vide, la documentation API est
  **désactivée** (publique en dev, non exposée par défaut en prod)

**Génération des secrets** (`ADMIN_TOKEN`, `FILE_URL_SECRET`) — ne jamais
réutiliser la valeur d'exemple `admin123` en production (le serveur la
refuse) :

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**`ADMIN_ROOT`** : email **racine** de l'administration. Il peut ouvrir la
console `/admin` (et promouvoir d'autres comptes en **admin délégué** depuis la
table Utilisateurs — les deux doivent AUSSI se connecter comme élève : le
lien admin n'apparaît que pour ces comptes).

## Mise en service de la refonte d'octobre 2026 (à faire une fois)

Les nouvelles variables sont déjà dans `render.yaml` (valeurs par défaut) ; seuls les secrets se saisissent dans Render.

1. **Tables nouvelles** (`plans`, `evenements`, `essais`) : créées automatiquement au démarrage ; les
   formules par défaut sont insérées si la table `plans` est vide. **Aucune table existante n'est modifiée.**
2. **Recherche sans accents** : l'extension PostgreSQL `unaccent` est activée au démarrage
   (`CREATE EXTENSION IF NOT EXISTS unaccent`, extension « de confiance » : testée avec un rôle non
   superutilisateur). Si l'activation échoue, la recherche reste sensible aux accents (avertissement dans les logs).
3. **IP cliente** : après déploiement, appeler `GET /api/health/ip` avec un faux en-tête
   `True-Client-IP: 1.2.3.4`. Si la réponse renvoie `1.2.3.4`, l'en-tête est forgeable : mettre
   `TRUST_CLIENT_IP_HEADERS=0` dans Render (les limiteurs se rabattent sur `X-Forwarded-For`).
4. **Sauvegarde hebdomadaire** : définir `CRON_TOKEN` dans Render (≥ 24 caractères, p. ex.
   `python -c "import secrets;print(secrets.token_urlsafe(32))"`) et le même secret `CRON_TOKEN` dans
   GitHub (Settings › Secrets › Actions). Variable GitHub facultative `APP_URL` si l'adresse change.
   Les exports s'accumulent dans le stockage objet : les supprimer depuis l'onglet « Sauvegardes » (Tigris
   gratuit : 5 Go).
5. **Keep-alive Supabase** : le workflow `keepalive.yml` appelle `/api/health` chaque jour (SELECT 1).
   Render, lui, interroge `/api/health/live` (sans base).
6. **Déploiement après CI** : `autoDeployTrigger: checksPass` ne s'applique qu'à un service géré par le
   Blueprint ; sinon, dans le tableau de bord : Settings › Build & Deploy › Auto-Deploy = « After CI Checks Pass ».
7. **Journaux** : `LOG_FORMAT=json` (une ligne JSON par requête, sans IP ni corps ; identifiant dans `X-Request-ID`).
8. **Paiement** : en pause, voir `PAIEMENT.md`. Laisser `DEMO_MODE=false` en production.

## Déploiement Render

Le `render.yaml` décrit un **service unifié** (un seul Web Service Python /
**`bacprep-web`**) : le build compile d'abord le frontend
(`npm --prefix ../frontend ci && npm --prefix ../frontend run build`), puis
pip install ; quand `frontend/dist` existe, FastAPI le sert en SPA
(catch-all + `/assets`). Une seule origine → aucun CORS, pas de cookie
cross-origine, pas de dépendance au suffixe onrender.com (Rot change
l'URL au plan gratuit : l'ancienne architecture « 2 services » cassait
l'authentification à chaque rotation). `VITE_API_URL` reste **vide**
(même origine, `BASE_URL` = "" dans `frontend/src/api/client.ts`).

> En développement : frontend Vite (`npm run dev`, port 5173) + backend
> (`uvicorn`, port 8000) sur des origines différentes — c'est là que le CORS
> et `VITE_API_URL=http://localhost:8000` sont utiles ; en production, le
> service unifié les rend sans effet.

Étapes :

1. Pousser ce dépôt sur GitHub/GitLab.
2. Sur [render.com](https://render.com), **New → Blueprint**, pointer le
   dépôt.
3. Renseigner les secrets (`sync: false`) : le pooler Supabase
   (`DATABASE_URL`), les variables de stockage (`STORAGE_BACKEND=s3` +
   `STORAGE_ENDPOINT_URL`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
   `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`), les clés LLM
   (`GEMINI_API_KEY` / `GROQ_API_KEY`), `ADMIN_ROOT`, `FILE_URL_SECRET`,
   `AUTH_MODE=google` + `GOOGLE_CLIENT_ID` (voir sections ci-dessus pour
   les obtenir).
4. Déployer, puis vérifier : `/api/health` répond ; `/connexion` affiche le
   bouton Google ; une image d'épreuve se charge (stockage objet).

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
