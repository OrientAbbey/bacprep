# Proposition d'architecture — normaliser et réorganiser Bacprep

> Document de **proposition**, sans modification du code. Objectif : une structure plus claire et plus sûre, **sans perte de fonctionnalité, de performance ni de sécurité**, et sans « big bang ».

## 1. Synthèse

Le projet est un **monolithe sain mais devenu plat** : ~16 500 lignes Python, ~22 000 lignes TS/TSX, 73 modules backend et 167 fichiers frontend. Les tests sont verts (992 backend, 313 frontend, 129+10 E2E) et le code est désormais documenté et sans doublons exacts. Le problème n'est pas la qualité intrinsèque, mais l'**absence de frontières explicites** entre domaines et couches.

**Recommandation : un « modular monolith » à tranches verticales, avec un noyau partagé mince.**

- Pas de microservices (le projet est mono-instance, avec SQLite en dev et PostgreSQL en prod, un worker et un stockage objet partagés : la découpe en services distribués apporterait surtout de la complexité opérationnelle).
- Pas de « Clean Architecture » complète avec repositories/interfaces partout : SQLAlchemy `Session` est déjà une unité de travail, et forcer des abstractions sans seconde implémentation ajoute de l'indirection sans bénéfice (enseignement convergent des sources consultées : *vertical slice vs clean architecture*, *modular monolith starter*).
- Oui à : **frontières de domaine**, **dépendances orientées vers l'intérieur**, **un seul point d'entrée public par module**, **des routes minces** et **des cas d'usage testables sans serveur HTTP**.

Sources consulted : docs FastAPI « Bigger Applications — Multiple Files », FastAPI Best Practices (Auth0), *Production-Ready FastAPI Project Structure (2026)*, *FastAPI modular monolith starter*, *React Architecture Best Practices 2026* (feature-based, colocation, strict boundaries), *React Folder Structure in 2026* (barrels, lazy routes, ESLint boundaries), *Vertical Slice vs Clean Architecture* (hybride feature folders + noyau partagé), *Strangler Fig Pattern* (AWS Prescriptive Guidance, Azure Architecture Center).

## 2. État des lieux mesuré

### Backend (`backend/app`)

| Zone | Fait marquant |
|---|---|
| `routers/` | 27 routeurs, de 32 à 644 lignes (`admin_banque.py`, `admin_epreuves.py`, `admin_misc.py`, `admin_sauvegardes.py`, `me.py`, `epreuves.py`, `subscriptions.py` sont les plus gros) |
| `core/` | 40 modules, de la validation métier pure (`banque_generation.py`, `gabarits.py`) à de l'infrastructure (`storage.py`, `job_runner.py`, `export_service.py`) |
| Dépendances | `core/admin_tools.py` importe `..routers` (couche inférieure → supérieure) ; `core/job_runner.py` ↔ `core/job_queue.py` forment un cycle d'imports différés |
| Schémas | `models.py` (Pydantic API) et `db_models.py` (SQLAlchemy) sont deux gros fichiers uniques |
| Config | `core/config.py` + variables d'environnement éparpillées (`os.getenv` dans une dizaine de modules) |
| Migrations | `create_all` + `schema_migrations.py` (pas d'Alembic) |
| Cross-coupage | `log_admin_event`, 3 journaux distincts, taux de limitation, signature de fichiers, stockage objet |

### Frontend (`frontend/src`)

| Zone | Fait marquant |
|---|---|
| `pages/` | 37 fichiers, ~13 000 lignes ; 11 fichiers > 400 lignes (jusqu'à 1 302 pour `EpreuvesPanel.tsx`) |
| `components/` | 44 fichiers, ~5 200 lignes, mélangeant composants globaux et composants de domaine |
| `lib/` | 71 fichiers, ~5 300 lignes : helpers métier, clients API, hooks, utilitaires — sans distinction claire |
| `api/` | `client.ts` + `types.ts` (872 lignes) : contrat API centralisé, bon point à conserver |
| État | React Context (auth, thème, toasts), pas de bibliothèque de server-state ; données serveur souvent dans des `useState` locaux |
| Routage | `App.tsx` unique ; pas de lazy-loading par route (le chunk `AdminPage` pèse déjà ~573 Ko) |
| Qualité | pas d'ESLint configuré ; TypeScript strict via `tsc -b`, Vitest, E2E Playwright |

## 3. Architecture cible — Backend

### 3.1 Principe de description

Une **hiérarchie de domaines** (bounding contexts) au-dessus d'un **noyau technique partagé**. Chaque domaine est une tranche verticale autonome : `api` → `use_cases` → `infrastructure` locale. Les dépendances vont toujours **de l'extérieur vers l'intérieur** ; un domaine n'importe jamais le routeur d'un autre domaine.

```
backend/app/
├── main.py                      # application factory : inclusion des routeurs, middleware, lifespan
├── core/                        # noyau technique PARTAGÉ (pas de logique métier de domaine)
│   ├── config.py                # Pydantic Settings : TOUTES les variables d'env, validées au démarrage
│   ├── db.py                    # engine, SessionLocal, get_db, migrations
│   ├── security.py              # hashing, jetons, signature (déplacé depuis signing.py)
│   ├── errors.py                # exceptions applicatives + handlers HTTP (.code -> statut)
│   ├── rate_limit.py
│   ├── logging.py
│   └── ports/                   # interfaces techniques (Storage, Occurrence, Clock)
├── shared/                      # modèles et objets TRANSVERSES (user, référentiel, audit)
│   ├── models.py                # UserORM, ReferentielOptionORM, AdminEventORM...
│   ├── schemas.py               # UserOut, AuthConfigOut, ReferentielOption...
│   └── deps.py                  # require_user, require_admin, log_admin_event
├── domains/
│   ├── catalogue/               # épreuves publiées, filtres, SEO, consultation
│   │   ├── api.py               # APIRouter (routes /api/epreuves, /api/catalogue...)
│   │   ├── schemas.py           # EpreuveListItem, EpreuveDetail, Filtres...
│   │   ├── use_cases.py         # recherche, groupement, publication
│   │   ├── queries.py           # requêtes SQLAlchemy du domaine (remplace les helpers de epreuves.py)
│   │   └── seo.py               # sitemap, robots, metadata (ex-core/seo.py)
│   ├── abonnements/             # plans, checkout, webhooks, gating, AK
│   │   ├── api.py               # /api/plans, /api/subscriptions, /api/payments
│   │   ├── schemas.py
│   │   ├── use_cases.py         # acheter, confirmer, révoquer, est_autorise
│   │   ├── ak.py                # ex-core/ak.py
│   │   └── queries.py
│   ├── comptes/                 # auth, profil, avatar, consentements, export RGPD
│   │   ├── api.py               # /api/auth, /api/me, /api/me/avatar
│   │   ├── schemas.py
│   │   ├── use_cases.py
│   │   └── avatar.py            # ex-core/avatar.py
│   ├── epreuves_admin/          # CRUD admin des épreuves, documents, images, atelier IA
│   │   ├── api.py               # /api/admin/epreuves, /api/admin/generation-exercices
│   │   ├── schemas.py
│   │   ├── use_cases.py         # enregistrer, publier, importer, upload image
│   │   ├── files.py             # ex-core/epreuve_files.py + core/images.py
│   │   └── generation.py        # ex-core/generation_exercices.py
│   ├── banque/                  # générateur d'épreuves (parties, exercices, tirage, journal)
│   │   ├── api.py               # /api/banque + /api/admin/banque
│   │   ├── schemas.py
│   │   ├── generation.py        # ex-core/banque_generation.py (pur, testable)
│   │   ├── use_cases.py         # orchestration tirage + persistance + journal
│   │   └── journal.py           # journal technique + journal admin (un seul endroit)
│   ├── entrainement/            # gabarits paramétrés (exercices types) + signalements
│   │   ├── api.py               # /api/entrainement + /api/admin/gabarits
│   │   ├── gabarits/            # les 19 JSON, déplacés depuis app/gabarits/
│   │   ├── moteur.py            # ex-core/gabarits.py
│   │   └── use_cases.py
│   ├── assistant/               # assistant élève + agent admin (function calling, plans)
│   │   ├── api.py               # /api/assistant + /api/admin/assistant
│   │   ├── llm.py               # ex-core/assistant.py + admin_assistant.py (fournisseurs)
│   │   ├── agent.py             # ex-core/admin_agent*.py (boucle, outils, approbations)
│   │   ├── prompts.py           # prompts regroupés (élève, admin, onglets)
│   │   └── schemas.py
│   ├── sauvegardes/             # export/import/restore + jobs
│   │   ├── api.py               # /api/admin/sauvegardes, /api/admin/import
│   │   ├── use_cases.py
│   │   ├── exporter.py          # ex-core/export_service.py
│   │   ├── importateur.py       # ex-core/import_service.py + import_parsing.py
│   │   └── jobs/                # job_runner + job_queue + worker (cycle supprimé)
│   │       ├── runner.py
│   │       ├── queue.py
│   │       ├── definitions.py   # constantes partagées (WORKER_ID, timeouts)
│   │       └── worker.py
│   └── communication/           # notifications, calendrier, signalements, journal d'audit, stats
│       ├── api.py
│       ├── schemas.py
│       └── use_cases.py
├── migrations/                  # (optionnel, phase 5) Alembic si le besoin de versions de schéma apparaît
├── scripts/                     # scripts CLI (importer)
└── gabarits/                    # conservé tel quel (chargé par le domaine entrainement)
```

### 3.2 Règles de dépendance (à faire respecter mécaniquement)

1. `domains/*/api.py` peut importer `core/*`, `shared/*` et **son propre** domaine — jamais un autre domaine.
2. `core/*` n'importe **jamais** `domains/*` ni `routers/*`.
   - Correction requise : `core/admin_tools.py` importe aujourd'hui `routers.admin_banque`, `admin_plans`, `calendrier`, `admin_referentiel` → déplacer les modèles d'arguments dans `domains/assistant/schemas.py` et appeler les cas d'usage via des fonctions injectées.
3. `shared/*` n'importe aucun domaine (les domaines importent `shared`).
4. `main.py` est le **seul** endroit qui connaît tous les domaines : `app.include_router(domain.api.router)` (motif recommandé par la doc FastAPI).
5. Cycle `job_runner ↔ job_queue` : extraire `WORKER_ID` et les constantes dans `jobs/definitions.py` ; `runner.py` n'importe plus `queue.py`.
6. Les dépendances transverses (`require_user`, `require_admin`, `get_db`) restent dans `shared/deps.py` et sont appliquées au niveau de l'`APIRouter` quand c'est possible (`dependencies=[Depends(require_admin)]`), plutôt que répétées dans chaque handler.

### 3.3 Séparation des couches à l'intérieur d'un domaine

| Couche | Contenu | Ne contient PAS |
|---|---|---|
| `api.py` | `APIRouter`, validation Pydantic, mapping erreurs → statut, dépendances | requêtes SQL, règles métier |
| `schemas.py` | DTO d'entrée/sortie avec `Field(...)` et validators | ORM |
| `use_cases.py` | orchestration, règles, appels aux ports | `Request`, `Response`, `HTTPException` |
| `queries.py` / `generation.py` | requêtes et calculs déterministes | HTTP |
| `infrastructure` (fichiers dédiés) | stockage objet, LLM, jobs, signature | décisions métier |

**Pragmatisme** : pas de `Repository` générique ni d'interfaces pour chaque table. SQLAlchemy `Session` + des fonctions `queries.py` suffisent ; on n'ajoute une abstraction que si elle a plusieurs implémentations ou améliore réellement les tests.

### 3.4 Configuration et erreurs

- **Pydantic Settings** dans `core/config.py` : un seul endroit pour `DATABASE_URL`, `STORAGE_*`, `ASSISTANT_*`, `BANQUE_*`, limites, secrets. Échouer au démarrage si une variable obligatoire manque (fail-fast).
- **Erreurs applicatives typées** (`core/errors.py`) avec un `code` et un statut par défaut : `UploadImageError` (déjà amorcé dans `core/images.py`), `QuotaError`, `AccessDeniedError`, `GenerationError`. Les routeurs ne font que `raise AppError(code=...)` ; un handler global produit le JSON cohérent.
- Les **garde-fous de sécurité restent là où ils sont** : validation Pydantic, `require_admin`, URL signées, `rate_limit`, MIME + magic bytes via Pillow, Bornes de taille, CSP en rapport seul, headers de sécurité.

### 3.5 Performance — ce qui ne doit pas changer

- Routes **synchrones (`def`) pour Pillow** (déjà le cas) : FastAPI les exécute dans le threadpool ; une route `async` gèlerait la boucle et le streaming SSE.
- **Flux SSE** pour l'assistant et la génération : conserver `StreamingResponse` et l'écriture par blocs.
- **Ne pas allonger la durée de vie de la session SQLAlchemy** : pas d'appel LLM ni de compression lourde dans un handler qui tient une session. Les cas d'usage longs passent par `BackgroundTasks`/worker.
- `include_router` est léger par construction (docs FastAPI) : regrouper les routeurs n'ajoute pas d'overhead par requête.

## 4. Architecture cible — Frontend

### 4.1 Principe

Passer d'une organisation **par type** (`components/`, `pages/`, `lib/`) à une organisation **par fonctionnalité** (`features/`), avec un `shared/` agressivement maigre et des `pages/` qui ne font que composer. C'est le consensus des sources 2026 consultées ; les « barrels » (`index.ts`) définissent l'interface publique de chaque feature, et des règles ESLint `no-restricted-imports` empêchent les imports entre features.

```
frontend/src/
├── app/                         # shell : main.tsx, App.tsx, providers, router, thème, i18n
│   ├── providers/               # AuthProvider, ThemeProvider, ToastProvider
│   ├── router.tsx               # routes LAZY (React.lazy) par page/feature
│   └── i18n/
├── shared/                      # UNIQUEMENT du code réellement transversal
│   ├── ui/                      # Button, Modal, Combobox, ChatParts, Logo, MetaBadge...
│   ├── lib/                     # pure functions : dates, format, latex, text, signing...
│   ├── api/                     # client.ts (http, SSE, upload), types.ts (contrat API)
│   └── hooks/                   # useToast, useConnexion, useModalFocus...
├── features/
│   ├── catalogue/               # Liste, filtres, groupes, cartes, aperçus de partage
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── api.ts               # appels /api/epreuves, /api/catalogue
│   │   ├── types.ts
│   │   └── index.ts             # interface publique de la feature
│   ├── abonnements/             # formules, checkout, simulateur, gating
│   ├── compte/                  # login, profil, avatar, consentements, RGPD
│   ├── epreuves/                # lecteur, zoom, pagination, chrono, notes, impression
│   ├── admin-epreuves/          # éditeur, markdown, images, atelier IA
│   ├── banque/                  # CRUD banque + générateur
│   ├── entrainement/            # gabarits + variantes + composition d'épreuve
│   ├── assistant/               # panneaux élève et admin (désormais unifiés)
│   ├── sauvegardes/             # export/import/jobs + bandeau global
│   └── communication/           # notifications, calendrier, signalements
├── pages/                       # composition uniquement : une page = assemblage de features
│   ├── HomePage.tsx
│   ├── CataloguePage.tsx
│   ├── ViewerPage.tsx
│   ├── AdminPage.tsx            # ne contient plus la logique des panneaux
│   └── ...
└── locales/                     # FR/EN (conservé tel quel)
```

### 4.2 Règles de dépendance frontend

1. Une feature importe `shared/*` et sa propre feature — **jamais une autre feature** ; si deux features ont besoin de la même logique, elle monte dans `shared/lib` (avec test) ou dans un petit `features/_common` explicite.
2. `shared/ui` n'importe **jamais** de code de feature (pas d'inversion).
3. `pages/*` compose des features ; elle ne contient ni requête API, ni logique métier, ni état de formulaire complexe.
4. Chaque feature expose un `index.ts` ; c'est le seul point d'entrée autorisé depuis l'extérieur.
5. ESLint avec `no-restricted-imports` + `import/no-internal-modules` (ou `eslint-plugin-boundaries`) applique ces règles **au commit**, pas en revue de code.
6. Tests co-localisés : `features/banque/useGames.test.ts` à côté du code, comme déjà fait dans `lib/`.

### 4.3 État et données serveur

- **État serveur** : aujourd'hui dispersé dans des `useState` locaux avec rechargements manuels. Introduction progressive d'un **client de server-state** (TanStack Query) pour : catalogue, options de génération, statut des jobs, journal. Bénéfices : cache, invalidation, retry, déduplication — sans toucher aux providers d'auth/thème.
- **État client global** : reste minimal (auth, thème, toasts) dans `app/providers`. Pas de Redux.
- **État de formulaire** : reste local aux features (`useState` + références), éventuellement `useReducer` pour `EpreuvesPanel` (1 302 lignes).
- **Callbacks stables** : conserver `useCallback`/`useRef` tels quels pour éviter les re-renders coûteux de l'éditeur Markdown.

### 4.4 Performance frontend

- **Lazy-loading des routes** : `React.lazy(() => import("../features/admin-epreuves"))` + `Suspense`. Le chunk `AdminPage` (573 Ko) et `katex` (292 Ko) ne seraient plus chargés pour un élève qui consulte une épreuve.
- **Code-splitting par feature** : Vite le fait naturellement avec les imports dynamiques ; viser < 200 Ko par chunk initial.
- **Mémoïsation ciblée** : `useMemo` sur les filtres de catalogue et le regroupement par année (déjà partiellement en place).
- **Ne pas toucher** au rendu Markdown/KaTeX/SMILES (déjà chargé à la demande via `prechargerMol`) ni au service worker PWA.

## 5. Stratégie de migration — « strangler fig », sans big bang

Le motif recommandé par AWS/Azure pour remplacer un système progressivement : on construit le nouveau **à côté**, on **route** une fonctionnalité à la fois, on **vérifie**, puis on **supprime** l'ancien. Ici, pas de changement d'URL : la « route » est l'organisation interne des fichiers.

| Phase | Contenu | Risque | Point de contrôle |
|---|---|---|---|
| **0. Garder-fous** | Brancher ESLint (frontend) + règle d'import backend (test AST similar to `test_contrat_routes.py`) ; aucun code déplacé | Nul | CI verte |
| **1. Fondations** | `core/config.py` (Pydantic Settings), `core/errors.py`, `shared/deps.py` ; déplacer `WORKER_ID` pour casser le cycle | Faible | 992 tests |
| **2. Premier domaine pilote** | `entrainement` (le plus autonome : gabarits + signalements, peu de dépendances) | Faible | tests + E2E entraînement |
| **3. Domaines élèves** | `catalogue`, `abonnements`, `comptes` | Moyen | E2E catalogue/paiement/profil |
| **4. Domaines admin** | `admin-epreuves`, `banque`, `sauvegardes`, `communication`, `assistant` | Élevé | E2E admin complète |
| **5. Frontend par tranches** | `shared/` d'abord, puis une feature à la fois, `pages/` allégées, lazy routes | Moyen | 313 tests + build + bundle check |
| **6. Optionnel** | Alembic si évolution de schéma fréquente ; suppression des alias de compatibilité | Faible | migration de base validée |

**Règle d'or à chaque phase** : une PR, une tranche, tests verts, aucune URL publique modifiée, aucun paramètre de requête renommé sans alias (cf. le correctif `?q=` de la phase autodoc).

## 6. Ce qui est explicitement hors périmètre

- Changer de framework (FastAPI, React, Vite, Tailwind restent).
- Passer en microservices (pas de bénéfice : base et stockage partagés, déploiement mono-instance).
- Introduire des repositories/interfaces génériques « au cas où ».
- Refondre le Design System ou les traductions.
- Versionner l'API (`/api/v2/...`) : aucun besoin fonctionnel aujourd'hui.
- Toucher aux documents `.md` non suivis de la racine.

## 7. Critères d'acceptation

1. Aucun import interdit (AST backend + ESLint frontend) : `core` → `routers`, feature → feature, `shared/ui` → feature.
2. Aucun cycle d'import (`job_runner ↔ job_queue` supprimé).
3. Toutes les URLs et tous les paramètres de requête publics inchangés (test de contrat existant).
4. Fonctionnalités conservées : 992 tests backend, 313 frontend, 129 + 10 E2E, test navigateur.
5. Performance conservée ou améliorée : routes CPU-bound toujours synchrones, SSE inchangé, bundle initial en baisse après lazy routes.
6. Sécurité conservée : auth par routeur, validation Pydantic, URL signées, rate limits, headers de sécurité, CSP rapport seul.
7. Chaque phase livrée par PR verte, fusionnée dans `refonte`.

## 8. Décision attendue

Je recommande de **commencer par la phase 0 + phase 1** (garde-fous et fondations) : c'est le plus faible risque et cela rend toutes les phases suivantes mécaniques. Si vous validez, je transforme ce document en plan de travail cochable (comme `_PLAN_AUTODOC_NETTOYAGE.md`) et j'exécute en suivant ce séquencement.
