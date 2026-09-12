# Prompt de construction — BacPrep Cameroun ("Copies & Corrigés")

> Ce document est un prompt unique et autonome. Il peut être copié tel
> quel comme premier message d'une nouvelle conversation avec Claude
> (idéalement avec accès aux outils fichiers/bash/web pour du code réel)
> pour reconstruire le projet dans l'état où il a été laissé.
>
> **Limite à connaître :** un modèle de langage génère du code, il ne
> "rejoue" pas un enregistrement. Avec ce prompt, le résultat sera
> **fonctionnellement équivalent** (mêmes fonctionnalités, mêmes choix
> d'architecture, mêmes correctifs déjà intégrés dès le départ) mais pas
> nécessairement identique **octet pour octet** au fichier zip original
> (formulation des commentaires, ordre de certains blocs, etc. peuvent
> varier légèrement d'une génération à l'autre).

---

## 0. Consignes générales pour Claude

Construis un **prototype fonctionnel complet et testé** (pas un squelette
ni un plan) de l'application décrite ci-dessous : un backend FastAPI et un
frontend React, tous deux réellement codés, installés, démarrés et
vérifiés par toi-même (via le terminal/bash) avant de livrer. Teste
chaque flux critique avec de vraies requêtes (curl côté backend,
`npm run build` côté frontend) plutôt que de supposer que le code
fonctionne. Livre le tout comme une archive téléchargeable, avec la
documentation décrite en section 9.

N'implémente **aucune version antérieure/simplifiée** des points listés
ci-dessous : toutes les décisions ci-après sont déjà arbitrées et
définitives (elles intègrent des correctifs découverts après plusieurs
itérations) — construis directement la version finale, pas une V1 à
corriger ensuite.

---

## 1. Contexte produit

Application web d'aide à la préparation du **Baccalauréat camerounais**
pour les élèves de Terminale : catalogue d'épreuves (sujets + corrigés)
classées par filière/matière/année, avec un assistant IA contextuel, un
modèle d'abonnement payant (Orange Money / MTN Mobile Money via
agrégateur), et un back-office pour publier le contenu.

Nom de l'application : **"Copies & Corrigés"**. Identité visuelle :
thème "copie d'examen annotée" — papier, encre, surligneur jaune, stylo
rouge correcteur. Polices : **Source Serif 4** (titres), **IBM Plex
Sans** (corps), **IBM Plex Mono** (métadonnées façon tampon/en-tête
d'examen). Icônes : **Lucide React** exclusivement — aucun emoji utilisé
comme icône fonctionnelle nulle part dans l'interface.

---

## 2. Stack technique (versions récentes et stables au moment de la construction)

**Backend :** Python, FastAPI, SQLAlchemy 2.0 (ORM), SQLite par défaut
(migrable vers PostgreSQL via `DATABASE_URL`), Pydantic v2, httpx (appels
sortants), python-dotenv, google-auth (vérification OAuth), Pillow
(traitement d'image), psycopg2-binary (driver PostgreSQL optionnel).

**Frontend :** React 19, TypeScript, Vite, React Router v7, Tailwind CSS
v4 (mode sombre par variante personnalisée, PAS le mode media par
défaut), react-markdown + remark-gfm + remark-math + rehype-katex + katex
(rendu Markdown/LaTeX), lucide-react (icônes).

Utilise systématiquement les dernières versions stables disponibles au
moment de l'exécution (vérifie via `npm view <pkg> version` et
`pip index versions <pkg>` plutôt que de te fier à des versions figées
mémorisées).

---

## 3. Architecture de dossiers (structure finale, centralisée)

```
bacprep/
├── README.md
├── CAHIER_DES_CHARGES.md
├── DEPLOIEMENT.md
├── PAIEMENT.md
├── render.yaml
├── .gitignore
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py
│       ├── db.py
│       ├── db_models.py
│       ├── models.py
│       ├── core/
│       │   ├── logging_config.py
│       │   ├── catalogue.py
│       │   ├── store.py
│       │   ├── admin_session.py
│       │   └── assistant.py
│       └── routers/
│           ├── auth.py
│           ├── epreuves.py
│           ├── subscriptions.py
│           ├── admin.py
│           ├── assistant.py
│           ├── me.py
│           └── ws.py
│   └── data/                          <-- UN SEUL dossier "data", jamais dupliqué ailleurs
│       ├── epreuves/
│       │   ├── sujets/*.md             (contenu d'exemple, avec frontmatter)
│       │   └── corriges/*.md           (contenu d'exemple, SANS frontmatter, apparié par nom de fichier)
│       ├── uploads/<epreuve_id>/<sujet|corrige>/   (généré à l'exécution)
│       └── bacprep.db                  (généré à l'exécution, SQLite)
│   └── logs/                           (généré à l'exécution : app.log, errors.log)
└── frontend/
    ├── index.html                      (script anti-FOUC pour le thème)
    ├── package.json
    ├── .env                            (VITE_API_URL=http://localhost:8000 en dev)
    └── src/
        ├── main.tsx, App.tsx, index.css
        ├── api/client.ts
        ├── auth/AuthProvider.tsx, RequireAuth.tsx
        ├── theme/ThemeProvider.tsx
        ├── components/ (voir section 6)
        └── pages/ (voir section 6)
```

**Point d'attention explicite :** ne jamais créer plus d'un dossier nommé
"data" à des profondeurs différentes. Tous les chemins (base de données,
uploads, contenu de seed) sont dérivés d'un unique `BASE_DIR` calculé via
`Path(__file__).resolve()` dans `db.py`, jamais de chemin relatif au
répertoire de travail courant (`cwd`) — le backend doit démarrer
correctement quel que soit le répertoire depuis lequel `uvicorn` est
lancé.

---

## 4. Modèle de données (schéma final SQLAlchemy)

```
users            id, email (unique), nom, consent_given_at, created_at

sessions         user_id (PK, une seule session active par utilisateur),
                 token (unique), platform, issued_at

kickout_notices  user_id (PK), message

epreuves         id, examen (défaut "BAC"), matiere, annee, session,
                 duree (nullable), coefficient (nullable), gratuit (bool),
                 statut (brouillon|a_reviser|publie),
                 contenu_markdown (obligatoire, le SUJET),
                 corrige_markdown (nullable, le CORRIGÉ),
                 created_at, updated_at
                 -- PAS de champ "filiere" singulier, PAS de champ "type",
                 -- PAS de "epreuve_liee" : une épreuve = une seule ligne,
                 -- sujet et corrigé sont deux champs de cette même ligne.
                 -- Propriétés calculées : .filieres (liste, via relation),
                 -- .corrige_disponible (bool(corrige_markdown.strip()))

epreuve_filieres id, epreuve_id (FK), filiere
                 -- relation MANY-TO-MANY : une épreuve peut appartenir à
                 -- plusieurs filières (ex. Mathématiques commune aux
                 -- séries C, D, E). Contrainte unique (epreuve_id, filiere).
                 -- Relation chargée en "selectin" sur EpreuveORM pour
                 -- éviter les requêtes N+1 au listing du catalogue.

epreuve_assets   id, epreuve_id (FK), cible (sujet|corrige), filename,
                 url, uploaded_at
                 -- "cible" distingue si l'image illustre le sujet ou le
                 -- corrigé de la même épreuve.

subscriptions    id, user_id, examen, filiere (valeur unique — une
                 souscription cible une filière précise même si
                 l'épreuve en couvre plusieurs ; la vérification d'accès
                 teste l'appartenance filiere ∈ epreuve.filieres, pas
                 l'égalité), matiere (valeur|"ALL"), annee (valeur|"ALL"),
                 epreuve_id (nullable), start_date, end_date,
                 statut (active|expiree|annulee)

payments         id, user_id, subscription_id, provider, montant,
                 reference_agregateur (unique — idempotence du webhook),
                 statut (pending|confirmed|failed), created_at, confirmed_at

ai_conversations id, user_id, epreuve_id, label, contexte,
                 messages_json (texte JSON), created_at, updated_at
                 -- plafond APPLICATIF (pas une contrainte SQL) de 5
                 -- conversations actives par couple (user_id, epreuve_id)

consultations    id, user_id, epreuve_id, consulted_at
                 -- une ligne par (user, épreuve), mise à jour (pas
                 -- dupliquée) à chaque nouvelle consultation ; l'historique
                 -- affiché = LIMIT 10 trié par consulted_at décroissant

admin_events     id, epreuve_id, action (created|updated|published|
                 unpublished|deleted|image_uploaded_sujet|
                 image_uploaded_corrige|image_deleted), created_at
```

**État admin (session unique)** : PAS une table, un registre **en
mémoire** (module Python, une seule variable globale) contenant
`{email, session_token, since, last_activity}` de la session admin
active. Volontairement non persisté (un redémarrage du backend libère
l'accès — compromis assumé pour un prototype).

**Modèle de portée d'abonnement (jokers)** — 5 portées, cohérentes avec
`{filiere, matiere, annee, epreuve_id}` :

| Scope | filiere | matiere | annee | epreuve_id |
|---|---|---|---|---|
| `epreuve` | déduite de l'épreuve | — | — | fixé |
| `matiere_annee` | fixée | fixée | fixée | ALL (aucun) |
| `matiere` | fixée | fixée | ALL | ALL |
| `annee` | fixée | ALL | fixée | ALL |
| `filiere` | fixée | ALL | ALL | ALL |

Grille tarifaire (FCFA/an) : `epreuve`=400, `matiere_annee`=800,
`matiere`=2000, `annee`=3500, `filiere`=6000.

---

## 5. Backend — Spécification détaillée

### 5.1 `app/db.py`
- `BASE_DIR` = dossier `backend/` (via `Path(__file__).resolve().parent.parent`).
- `DATA_DIR`, `SUJETS_SEED_DIR`, `CORRIGES_SEED_DIR`, `UPLOADS_DIR` tous dérivés de `BASE_DIR`.
- `DATABASE_URL` par défaut `sqlite:///{DATA_DIR}/bacprep.db`, override via env.
- Pour SQLite : activer le **mode WAL** via un event listener SQLAlchemy (`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA foreign_keys=ON`) à chaque connexion — améliore la concurrence lecture/écriture.
- `pool_pre_ping=True` systématique (SQLite et PostgreSQL).
- Pour PostgreSQL : `pool_size`/`max_overflow` configurables via env (`DB_POOL_SIZE`, `DB_POOL_MAX_OVERFLOW`, défauts 5/10).
- `utc_now()` : `datetime.now(timezone.utc)` — **jamais** `datetime.utcnow()` (déprécié), partout dans le code.

### 5.2 `app/core/logging_config.py`
Logger `bacprep.*` avec 3 handlers : `RotatingFileHandler` sur
`backend/logs/app.log` (niveau INFO, 5 Mo × 5 fichiers), un second sur
`backend/logs/errors.log` (niveau WARNING, même rotation), et un
`StreamHandler` console. `setup_logging()` appelé une fois au démarrage
de `main.py`. Chaque module backend importe `get_logger(__name__court)`
et journalise les événements significatifs (connexions, actions admin,
échecs de fournisseur IA, etc.) — **aucun `except: pass` silencieux nulle
part dans le code.**

### 5.3 `app/main.py`
- `lifespan` (pas `@app.on_event`, déprécié) : crée les tables + appelle `seed_database_if_empty()`.
- `GZipMiddleware(minimum_size=1024)`.
- `CORSMiddleware` autorisant `http://localhost:5173`.
- Gestionnaire d'exception global (`Exception`) qui journalise la trace complète avant de renvoyer une 500 générique.
- Gestionnaire dédié `RequestValidationError` qui journalise **le corps brut de la requête reçue** en plus des erreurs de validation (essentiel pour diagnostiquer une désynchronisation frontend/backend sur la forme d'une requête).
- Monte `/media` sur `UPLOADS_DIR` (StaticFiles).
- Inclut tous les routers.
- `GET /api/health` → `{status, env_file_found}`.
- `GET /api/config` → `{max_conversations_par_epreuve, max_historique}`.
- **Service unifié** : si `frontend/dist` existe, monte `/assets` dessus et ajoute une route catch-all `GET /{full_path:path}` qui sert `index.html` pour toute route qui n'est pas un fichier statique existant (laisse React Router gérer la navigation côté client). Si `frontend/dist` n'existe pas (dev local), l'app tourne en API pure sans erreur.

### 5.4 `app/core/catalogue.py`
`seed_database_if_empty(db)` : si la table `epreuves` n'est pas vide,
retourne 0. Sinon, parcourt `SUJETS_SEED_DIR/*.md` : chaque fichier a un
frontmatter YAML (`examen`, `filieres: [D, C]` — accepte aussi
l'ancien `filiere: D` singulier par tolérance —, `matiere`, `annee`,
`session`, `duree`, `coefficient`). L'id de l'épreuve = nom de fichier
sans extension. Cherche un fichier de même nom dans
`CORRIGES_SEED_DIR` (pur Markdown, sans frontmatter) pour peupler
`corrige_markdown` si présent. Marque comme `gratuit=True` la première
épreuve rencontrée (ordre alphabétique d'id) pour **chaque filière**
non encore vue (contenu de découverte gratuit par filière). Statut
`publie` pour tout le contenu de seed.

### 5.5 `app/core/store.py`
Fonctions : `get_or_create_user`, `create_session`/`resolve_session`
(session unique par utilisateur, `create_session` invalide l'ancienne et
retourne un message de kick-out le cas échéant), `pop_kickout_notice`,
`is_gratuit`, `has_access(db, user_id, epreuve)` (teste le gratuit puis
les souscriptions actives, avec `sub.filiere in epreuve.filieres` — pas
une égalité), `matching_epreuves_count` (jointure sur
`epreuve_filieres` si un filtre filière est donné), historique de
consultation (`record_consultation`/`get_recent_consultations`, borne à
10), conversations IA (`list/create/update/delete_conversation`, la
création lève une erreur explicite si la limite de 5 par épreuve est
atteinte). Registre `ACTIVE_WEBSOCKETS: dict[str, WebSocket]` (en
mémoire) + `notify_kickout(user_id, message)` qui pousse un message
`{"type": "kicked_out", "message": ...}` sur la connexion active de
l'utilisateur, si elle existe.

### 5.6 `app/core/admin_session.py`
`ADMIN_SESSION_TIMEOUT = 30 minutes`. `root_emails()` lit `ADMIN_ROOT`
(CSV, minuscule). `promoted_emails(db)` lit `users.role="admin"` (comptes promus par le root
depuis le back-office). `allowed_emails(db) = root ∪ promus`.
`attempt_login(email, force=False)` :
si une session différente est active et non expirée et `force=False`,
retourne `(None, session_bloquante)` ; sinon crée une nouvelle session
(jeton UUID), retourne `(nouvelle_session, None)`. `touch(token)` valide
et rafraîchit l'activité. `logout(token)` libère si le jeton correspond.

### 5.7 `app/core/assistant.py`
- `DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"`, configurable via `GEMINI_MODEL`. Auth via **en-tête** `x-goog-api-key` (PAS le paramètre d'URL `?key=`, déprécié/moins sûr). Endpoint `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
- `DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"`, configurable via `GROQ_MODEL`. Endpoint `https://api.groq.com/openai/v1/chat/completions`, header `Authorization: Bearer {clé}`.
- Un `asyncio.Semaphore(LLM_CONCURRENCY_LIMIT)` (défaut 5, configurable) enveloppe les deux tentatives — les appels au-delà de la limite attendent (file d'attente naturelle) plutôt que de partir tous en même temps.
- Clés lues via `os.getenv()` **à l'intérieur** des fonctions (pas au niveau module), pour ne jamais dépendre de l'ordre de chargement du `.env`.
- En cas d'échec HTTP d'un fournisseur, journaliser **le corps complet de la réponse d'erreur** (`exc.response.text`), pas seulement le code de statut — un "404" seul ne dit pas pourquoi.
- Bascule Gemini → Groq → réponse simulée explicite (`[Mode démonstration — ...]`) si aucune clé ou si les deux échouent.
- Contexte reçu tronqué à 4000 caractères max côté appelant (garde-fou de coût).

### 5.8 Routers

**`auth.py`** — `POST /api/auth/mock-login` (email, nom, platform) ;
`POST /api/auth/google-login` (id_token) : vérifie via
`google.oauth2.id_token.verify_oauth2_token` contre `GOOGLE_CLIENT_ID`,
exige `email_verified=True` ; `GET /api/auth/config` → `{mode: "mock"|
"google", google_client_id}` (source de vérité unique pour le frontend,
lit `AUTH_MODE` côté serveur, retombe sur `"mock"` avec un avertissement
journalisé si `AUTH_MODE=google` sans `GOOGLE_CLIENT_ID` valide) ;
`GET /api/auth/me` ; `GET /api/auth/kickout-notice/{user_id}` (filet de
secours, plus interrogé en continu par le frontend) ; `POST
/api/auth/logout`. Toute connexion réussie (mock ou google) pousse la
notification de kick-out via `notify_kickout` avant de répondre.

**`epreuves.py`** — `GET /api/epreuves` (filtres `filiere`, `matiere`,
`annee`, `q`, `corrige=avec|sans`, `acces_type=gratuit|payant` ; jointure
sur `epreuve_filieres` si `filiere` fourni ; `corrige_disponible` = champ
calculé, pas de requête séparée) ; `GET /api/epreuves/filtres` ; `GET
/api/epreuves/count` (mêmes filtres, retourne `{count}`, utilisé par la
page Abonnement) ; `GET /api/epreuves/{id}` (retourne **sujet ET
corrigé dans la même réponse** — `contenu_markdown` + `corrige_markdown`
+ `filieres` liste ; vérifie l'accès, enregistre la consultation) ; sous-
routes `/{id}/conversations` (GET liste, POST créer avec vérif de
plafond → 409 si atteint, PUT `/conversations/{conv_id}` mettre à jour
les messages, DELETE fermer).

**`subscriptions.py`** — `GET /api/pricing` ; `POST
/api/subscriptions/checkout` (valide selon le scope, déduit la filière
depuis l'épreuve pour `scope=epreuve`, crée `SubscriptionORM` avec
`statut="annulee"` tant que non payé + `PaymentORM` avec référence
`SIMULATED-{uuid}` et `statut="pending"`) ; `POST
/api/payments/simulate-webhook` (idempotent : si déjà `confirmed`,
ignore silencieusement ; sinon active la souscription liée) ; `GET
/api/subscriptions/mine` ; `POST /api/subscriptions/{id}/cancel`
(vérifie l'appartenance à l'utilisateur, passe le statut à `annulee`).

**`admin.py`** — `POST /api/admin/login` (email, token, force) : vérifie
`token == ADMIN_TOKEN`, vérifie l'email dans `allowed_emails(db)` (root ∪
promus ; avertit et autorise tout email si la liste est vide), appelle
`admin_session.attempt_login` → 409 avec détail `{message, active_email,
since}` si bloqué ; `POST /api/admin/logout` ; toutes les autres routes
admin protégées par `Depends(require_admin)` qui valide l'en-tête
`X-Admin-Session` via `admin_session.touch()`. CRUD épreuves : `EpreuveIn`/
`EpreuveUpdate` avec `filieres: list[str]` (jamais singulier),
`contenu_markdown` (obligatoire), `corrige_markdown` (optionnel) — **pas**
de champ `type` ni `epreuve_liee`. Slug d'id = `{matiere}_{annee}`
normalisé, suffixe `_2`/`_3`... en cas de collision. `publish` exige
`contenu_markdown` non vide et au moins une filière (le corrigé n'est
**jamais** requis pour publier). Suppression en cascade ORM (filières et
images liées supprimées avec l'épreuve). Images : `POST
/{id}/images` (multipart, champs `file` + `cible` sujet|corrige),
valide le type MIME et la taille (5 Mo max), **optimise l'image**
(redimensionnement 1600px max de large + recompression via Pillow, avec
repli gracieux si Pillow échoue), stocke sous
`UPLOADS_DIR/{epreuve_id}/{cible}/{uuid}{ext}`, enregistre
`EpreuveAssetORM`. `GET /stats` (compteurs pour le tableau de bord).

**`me.py`** — `GET /api/me/profil` (email, nom, `membre_depuis`, liste
d'abonnements **enrichis** : `scope`, `scope_label`, filiere/matiere/
annee, `epreuve_label` si scope=epreuve, `epreuves_couvertes` (calculé
via `matching_epreuves_count`), `start_date`/`end_date`, plus
`total_depense_fcfa`) ; `GET /api/me/historique` (10 dernières épreuves
consultées, avec leurs `filieres`).

**`ws.py`** — `WEBSOCKET /ws/session` : lit le cookie de session, résout
l'utilisateur, accepte la connexion, l'enregistre dans
`ACTIVE_WEBSOCKETS`, boucle sur `receive_text()` (ne traite pas de
commandes entrantes, sert juste à garder la connexion ouverte pour
recevoir des push serveur→client), nettoie le registre à la déconnexion.

### 5.9 Variables d'environnement (`.env.example`)
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
ADMIN_TOKEN=admin123
ADMIN_ROOT=admin@example.com
AUTH_MODE=mock
GOOGLE_CLIENT_ID=
# DATABASE_URL=postgresql://user:password@host:5432/bacprep
# DB_POOL_SIZE=5
# DB_POOL_MAX_OVERFLOW=10
LLM_CONCURRENCY_LIMIT=5
```

---

## 6. Frontend — Spécification détaillée

### 6.1 Design system (`src/index.css`)
Tailwind v4 avec `@custom-variant dark (&:where(.dark, .dark *));` (mode
sombre piloté par une **classe**, pas seulement `prefers-color-scheme`).
Tokens `@theme` (palette claire) puis surchargés dans un bloc `.dark {}`
(palette sombre) :

```
--color-paper, --color-paper-raised     (fond de page / fond des cartes-inputs)
--color-ink, --color-ink-soft           (texte principal / secondaire)
--color-slate                            (texte tertiaire)
--color-highlight, --color-highlight-soft (accent jaune surligneur)
--color-correction, --color-correction-soft (rouge correcteur)
--color-valide, --color-valide-soft      (vert validation)
--color-margin, --color-margin-soft      (fond TOUJOURS sombre du panneau assistant, identique dans les 2 thèmes)
```

**Deux tokens FIXES, jamais redéfinis dans `.dark {}`** (piège de
contraste déjà rencontré, à éviter dès la construction) :
- `--color-highlight-ink` : texte à utiliser sur un fond `highlight`
  (jaune, identique dans les 2 thèmes) — sans ce token, `text-ink`
  devient clair en mode sombre et devient illisible sur le jaune qui,
  lui, ne change pas.
- `--color-margin-text` : texte à utiliser à l'intérieur du panneau
  assistant (fond `margin`, sombre dans les 2 thèmes) — sans ce token,
  `text-paper` devient sombre en mode sombre (puisqu'il suit le thème de
  la PAGE) et devient illisible sur un fond qui, lui, reste sombre.

**Règle générale à respecter partout ailleurs :** ne jamais utiliser
`bg-white` en dur pour un champ de formulaire ou une carte — toujours
`bg-paper-raised` (qui, lui, s'adapte au thème actif). Un fond blanc figé
combiné à du texte qui suit le thème (`text-ink`) devient illisible en
mode sombre.

Classe utilitaire `.scrollbar-hide` (masque la scrollbar tout en gardant
le défilement fonctionnel — utilisée pour les onglets de conversation et
le fil "consultées récemment"). Styles `.prose-exam` (contenu d'épreuve,
copie désactivée) et `.prose-chat` (variante compacte pour les bulles de
discussion, copiable).

`index.html` contient un script inline exécuté **avant** le premier
rendu React qui applique la classe `.dark` selon `localStorage.theme` ou,
à défaut, `prefers-color-scheme` — pour éviter un flash de la mauvaise
couleur au chargement (FOUC).

### 6.2 `src/theme/ThemeProvider.tsx`
Contexte React exposant `{theme, toggleTheme}`. Préférence système par
défaut, bascule manuelle mémorisée dans `localStorage` qui prend le pas
sur le système une fois activée ; continue de suivre les changements de
préférence système tant qu'aucun choix explicite n'a été fait.

### 6.3 `src/auth/AuthProvider.tsx`
`GET /api/auth/me` au montage. Après connexion, ouvre **une** connexion
WebSocket vers `/ws/session`. **Reconnexion automatique avec délai
croissant** (1s, 2s, 4s, 8s, plafonné à 15s, réinitialisé à chaque
connexion réussie) sur `onclose`, **sauf** si la déconnexion est
volontaire (logout) ou consécutive à un message `kicked_out` reçu (plus
de session à surveiller). Expose `loginMock`, `loginGoogle`, `logout`,
`kickoutMessage`/`clearKickoutMessage`.

### 6.4 Composants (`src/components/`)
- **`Logo.tsx`** — SVG fait main (document + coche façon tampon), couleurs volontairement fixes (identité de marque).
- **`MetaBadge.tsx`** — badge avec `tone`: `default|correction|valide|highlight`. Le tone `highlight` utilise `text-highlight-ink` (pas `text-ink`).
- **`Combobox.tsx`** — menu déroulant avec recherche tapée, accessible (`role="listbox"/"option"`, `aria-expanded`, ferme à Échap), cible tactile ≥44px, `bg-paper-raised` (pas `bg-white`).
- **`Watermark.tsx`** — filigrane dynamique via un `<pattern>` SVG (`patternUnits="userSpaceOnUse"`) qui se répète automatiquement sur toute la hauteur du conteneur, quelle que soit sa longueur (PAS une grille à nombre de tuiles fixe, qui ne couvrirait que le haut d'un contenu long).
- **`MarkdownContent.tsx`** — `React.memo` + `useMemo` sur le nettoyage des ancres `{#id}` (évite de reparser à chaque rendu parent). Prop `variant`: `"epreuve"` (copie désactivée) ou `"chat"` (copiable, compact).
- **`FloatingAskButton.tsx`** — bouton apparaissant près d'une sélection de texte. Coordonnées **viewport-relatives pures** (l'élément est `position: fixed`) avec bornage explicite pour rester toujours visible — ne jamais ajouter `window.scrollY`/`scrollX` à un élément `fixed` (bug de positionnement déjà rencontré : le bouton dérive hors écran au défilement). Icône Lucide, pas de caractère `?` brut.
- **`AssistantLauncherButton.tsx`** — bouton flottant permanent (bas droite), libellé **toujours identique** ("Assistant", jamais de libellé conditionnel).
- **`AssistantPanel.tsx`** — panneau à onglets multiples (max 5 par épreuve, configurable). Chaque onglet est **fermable individuellement** (icône Lucide `X`). Le bouton "+ Nouvelle" reste **fixe** hors de la zone de défilement horizontal des onglets (qui, elle, a la scrollbar masquée). Messages rendus via `MarkdownContent variant="chat"` (pas de texte brut). Tout le texte du panneau utilise `text-margin-text` (jamais `text-paper`).
- **`GoogleSignInButton.tsx`** — charge dynamiquement `https://accounts.google.com/gsi/client`, initialise `google.accounts.id` avec le `client_id` reçu du backend, callback transmet le `credential` (JWT) au parent.
- **`Layout.tsx`** — `<header sticky>` avec bouton retour (`navigate(-1)`), logo, nav (`Catalogue`/`Abonnement`/`Admin`), bascule thème, lien profil (icône `User`, visible si connecté). **Pas** de nom d'utilisateur ni de bouton déconnexion ici (déplacés en page Profil). `<main>` puis `<footer>` sémantique. Nav responsive : masque le nom de marque textuel et le lien "Admin" sous 640px.

### 6.5 Pages (`src/pages/`)

**`LoginPage.tsx`** — interroge `GET /api/auth/config` au montage ;
affiche soit le formulaire simulé (email + nom) soit `<GoogleSignInButton>`
selon `mode`.

**`CataloguePage.tsx`** — filtres en `Combobox` (filière, matière,
année — **année présélectionnée sur la plus récente disponible**, pas
"Toutes" par défaut) + deux filtres additionnels en puces (`Corrigé` :
tous/avec/sans, `Accès` : tous/gratuit/payant). Section "Consultées
récemment" (scroll horizontal, scrollbar masquée) si historique non vide.
Cartes épreuve affichant **toutes les filières** de l'épreuve (badges
multiples). Clic sur une épreuve verrouillée → navigue vers
`/abonnement?epreuve_id={id}` (préremplissage, pas une page vide).

**`ViewerPage.tsx`** — charge l'épreuve (sujet + corrigé dans le même
appel). Switch Sujet/Corrigé = **bascule de visibilité CSS locale**, zéro
appel réseau (les deux contenus sont déjà en mémoire). Filigrane en
pleine hauteur du conteneur. Sélection de texte → `FloatingAskButton` →
nouvelle conversation scopée au passage. Bouton assistant permanent →
reprend la conversation active ou en crée une sur l'épreuve entière si
aucune n'existe. Enregistre l'historique de consultation côté backend
(automatique via l'appel `GET /epreuves/{id}`).

**`SubscribePage.tsx`** — **le type d'abonnement (scope) se choisit en
premier**, la filière/matière/année en découlent. Pour `scope=epreuve`,
liste recherchable de toutes les épreuves (filière déduite
automatiquement, pas redemandée). Compte les épreuves couvertes en temps
réel (`GET /epreuves/count`) au fil de la sélection. Une fois la
sélection complète, affiche un **récapitulatif** (filière(s), matière/
année concernées, nombre d'épreuves couvertes, durée de validité) — **le
moyen de paiement et le bouton "Continuer vers le paiement" ne
s'affichent que si ce nombre est strictement positif** ; à 0, un message
explicite les remplace (jamais de paiement proposé pour "0 épreuve").

**`ProfilePage.tsx`** — nom, email, date d'inscription, total dépensé,
**bouton de déconnexion ici** (pas dans le header). Chaque abonnement
actif affiché avec description complète (portée, filière/matière/année,
nom de l'épreuve si applicable, nombre d'épreuves couvertes, dates de
souscription et d'expiration) + bouton "Annuler cet abonnement" (avec
confirmation, appelle `POST /subscriptions/{id}/cancel`).

**`AdminPage.tsx`** — écran de connexion avec **email + jeton** (pas
jeton seul). Si `POST /admin/login` renvoie 409, affiche qui est
actuellement connecté (email + heure) avec un bouton "Forcer la
connexion" (renvoie `force=true`). Une fois connecté, formulaire
épreuve : champ filières en texte libre séparé par virgules (ex.
"D, C, E"), **puis directement en dessous du bloc "Sujet" (Markdown +
bascule Texte/Rendu + upload d'images ciblées `sujet`), le bloc
"Corrigé (optionnel)" avec exactement la même structure** (Markdown +
bascule + upload d'images ciblées `corrige`) — **pas** de champ "sujet
auquel attacher ce corrigé" (obsolète, le corrigé est un champ de la
même épreuve). Input file avec `cursor-pointer` et style `file:` explicite
(curseur et apparence cliquable visibles). Bouton de déconnexion admin
séparé (libère la session còté serveur).

### 6.6 `src/App.tsx`
`AdminPage` chargé via `React.lazy` + `<Suspense>` (découpage de code —
n'alourdit pas le chargement initial du parcours élève). Routes :
`/` (login), `/admin`, `/catalogue`, `/epreuve/:id`, `/abonnement`,
`/profil` (les 4 dernières protégées par `<RequireAuth>`).

### 6.7 `src/api/client.ts`
Wrapper `fetch` centralisé. **Fusionner les en-têtes correctement** :
```ts
const { headers, ...rest } = options;
fetch(url, { credentials: "include", ...rest, headers: { "Content-Type": "application/json", ...(headers || {}) } });
```
(bug déjà rencontré : spreader `options` après avoir fixé `headers` par
défaut écrase silencieusement `Content-Type` dès qu'un appel fournit ses
propres en-têtes, ex. `X-Admin-Session`). `BASE_URL` = `import.meta.env.
VITE_API_URL || ""` (chaîne vide, pas `localhost:8000` en dur — nécessaire
pour que le service unifié fonctionne en production avec des chemins
relatifs). Toutes les méthodes typées (voir les endpoints en section 5.8).

---

## 7. Contenu de démonstration

Créer exactement 3 épreuves d'exemple sous `backend/data/epreuves/` :

1. **`sujets/maths_2023.md`** (+ **`corriges/maths_2023.md`**) —
   Mathématiques, filières **`[D, C, E]`** (démontre le multi-filières),
   BAC 2023, 4h, coefficient 5. Contenu avec plusieurs exercices numérotés
   et formules LaTeX (`$...$`), ancres `{#id}` sur les titres.
2. **`sujets/histoire_2023.md`** (pas de corrigé) — Histoire, filière
   `[D]`, dissertation en texte long sans découpage fin en questions.
3. **`sujets/education_civique_2023.md`** (pas de corrigé) — Éducation
   Civique, filières **`[A, TI]`** (démontre à nouveau le multi-filières),
   mélange de questions courtes et d'étude de cas.

---

## 8. Tests à exécuter toi-même avant de livrer (non négociable)

Démarre réellement le backend (`uvicorn`) et vérifie par `curl`, dans cet
ordre, en un seul appel terminal enchaîné (l'environnement peut ne pas
conserver un process en arrière-plan entre deux appels d'outils séparés) :
1. Démarrage propre + seed des 3 épreuves.
2. Connexion (mock), accès à une épreuve gratuite, refus (403) sur une
   épreuve payante.
3. Souscription (un des 5 scopes) → paiement simulé → webhook confirmé
   → accès débloqué → webhook rejoué une 2e fois (idempotence vérifiée).
4. Une épreuve multi-filières accessible via n'importe laquelle de ses
   filières souscrites.
5. Connexion admin, blocage d'un second email, prise de contrôle forcée.
6. Upload d'image (vrai fichier PNG généré en Python), vérifie le fichier
   physique sous le bon `cible`.
7. Deuxième connexion utilisateur simultanée → kick-out reçu en temps
   réel côté WebSocket (script Python avec la librairie `websockets`).
8. `npm run build` du frontend sans erreur TypeScript.
9. Le backend sert `frontend/dist` en service unifié (une route React
   arbitraire renvoie `index.html`, pas une 404).

---

## 9. Documentation à livrer

- **`README.md`** — vue d'ensemble, démarrage local, parcours de
  démonstration élève et admin, tableau des limitations connues.
- **`CAHIER_DES_CHARGES.md`** — spécification produit complète par
  module fonctionnel (authentification, catalogue, lecteur, assistant IA,
  abonnements, paiement, back-office, profil, notifications temps réel,
  thème), schéma de données, études comparatives (agrégateur de paiement,
  fournisseur LLM), grille tarifaire justifiée.
- **`DEPLOIEMENT.md`** + **`render.yaml`** — guide de déploiement gratuit
  **unifié** (un seul service pour le frontend et le backend, PAS deux
  plateformes séparées) sur **Render** (pas Vercel — expliquer
  explicitement pourquoi : Vercel est serverless/sans état, incompatible
  avec WebSocket longue durée et un fichier SQLite persistant). Mentionner
  honnêtement la limite du disque éphémère sur l'offre gratuite Render
  (recommander PostgreSQL gratuit plutôt que SQLite pour ce déploiement,
  et signaler que les images uploadées ne persisteront pas).
- **`PAIEMENT.md`** — guide d'intégration du paiement réel (Notch Pay
  primaire, Monetbil en repli), avec avertissement que les détails d'API
  doivent être revérifiés sur la documentation officielle au moment de
  l'implémentation plutôt que suivis aveuglément.

---

## 10. Ce qui reste explicitement HORS périmètre (ne pas construire)

Mode hors-ligne, chiffrement du contenu au repos, pipeline d'ingestion PDF
automatique (l'admin saisit le Markdown à la main), application Android
(Capacitor), vraie intégration Notch Pay (guide seulement, le paiement
reste simulé par un bouton), comptes admin multi-rôles (un seul niveau
"admin", restreint par liste d'emails), audit d'accessibilité outillé
(axe-core/Lighthouse). Ces points peuvent être mentionnés comme
"prochaines étapes" dans le README mais ne doivent pas être implémentés.
