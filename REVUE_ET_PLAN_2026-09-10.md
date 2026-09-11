# Revue complète & Plan d'optimisation — BacPrep (2026-09-10)

> Politique du propriétaire : « écrire le minimum de code possible tout en gardant la lisibilité
> et la simplicité (complexité modérée), la performance et la sécurité. Ne pas réinventer la roue. »
>
> Ce document consolidée les résultats de 4 revues parallèles (backend, frontend, sécurité,
> architecture/dépendances) suivies d'une vérification manuelle des points clés.

---

## 1. Verdict global

**La politique est largement appliquée sur le plan de la qualité** : architecture propre,
garde-fous de sécurité solides et testés, requêtes SQL paramétrées, XSS maîtrisé (react-markdown
sans `rehype-raw`), 68 tests backend + 13 tests frontend, zéro vulnérabilité npm, aucun secret
committé, docs API masquées en prod.

**Les écarts se concentrent sur 3 axes** :

1. **« Minimum de code » non respecté dans plusieurs endroits** : ~350 lignes économisables,
   3 dépendances inutiles, 5 duplications de code (dont 2 règles métier dupliquées front/back
   avec risque de divergence), 1 fichier monolithique de 1 989 lignes.
2. **Configuration de production dangereuse** (le CRITIQUE unique) : `render.yaml` active
   `DEMO_MODE=true` + `AUTH_MODE=mock`, ce qui rend le paywall contournable.
3. **Quelques bugs fonctionnels réels** (3 REQUIS backend) : règle de couverture d'abonnement
   fautive, fuite d'objets en stockage, clés d'images mal nommées.

**Statistique consolidée** (84 constats) :

| Sévérité  | Backend | Frontend | Sécurité | Architecture | Total |
|-----------|---------|----------|----------|--------------|-------|
| CRITIQUE  | 0       | 0        | 1        | 0            | **1** |
| REQUIS    | 3       | 3        | 3        | 0            | **9** |
| OPTIONNEL | 11      | 10       | 4        | —            | **25** |
| NIT       | 9       | 13       | 1        | —            | **23** |
| FYI       | 7       | 3        | 5        | —            | **15** |
| Autre (deps/réinvention) | — | — | — | 10 | **10** |

---

## 2. Détail des constats par axe

### 2.1 Backend (30 constats — 0 CR / 3 REQUIS / 11 OPT / 9 NIT / 7 FYI)

**BUGS FONCTIONNELS (REQUIS) :**

- **[REQUIS] `backend/app/core/store.py:318-326`** — `scope_already_covered` répond « déjà couvert »
  pour une portée PLUS LARGE : un élève ayant un abonnement « une matière » (annee=ALL) ne peut
  plus JAMAIS acheter une portée « année » ou « filière » (409 au checkout, paiement masqué au
  frontend). Le test `if matiere and …` saute la vérification quand le champ de l'achat est plus
  large que l'abonnement. Solution : exiger le joker `"ALL"` sur l'abonnement quand la dimension
  n'est pas contrainte par la sélection (`if not matiere and sub.matiere != "ALL": continue`).
- **[REQUIS] `backend/app/core/epreuve_files.py:104-111`** — `write_document` écrase `storage_key`
  sans supprimer l'ANCIEN objet : si l'admin édite le contenu **et** change la classe/année,
  l'ancien fichier reste orphelin dans le bucket (fuite de stockage jamais nettoyée). Solution :
  après succès de la nouvelle écriture, `get_storage().delete(ancienne_clé)`.
- **[REQUIS] `backend/app/routers/admin_epreuves.py:284`** — `_relocate_files` duplique le préfixe
  `cible-` des images (`sujet-sujet-abc…`) ; la clé se dégrade à CHAQUE relocalisation. Solution :
  reconstruire `epreuves/{niveau}/{annee}/{id}/{basename}` sans re-préfixer.

**SIMPLICITÉ / NE PAS RÉINVENTER LA ROUE :**

- **[OPT]** `core/assistant.py:278-465` — 4 fonctions LLM (`_call_gemini`, `_stream_gemini`,
  `_call_groq`, `_stream_groq`) identiques à ±15 % (parsing SSE dupliqué l.346 et l.449) → helper
  générique, **~120 lignes gagnées**.
- **[NIT]** `routers/ws.py:19-30` — parsing CSS manuel ; utiliser `http.cookies.SimpleCookie`
  (stdlib), 1 ligne au lieu de 10.
- **[OPT]** `core/extraits.py`, `core/epreuve_files.py:170`, `core/assistant.py:77` — 3 regex
  Markdown d'images dupliquées → un module unique `core/markdown.py`.
- **[OPT]** `core/catalogue.py:18` — parseur de frontmatter YAML maison → PyYAML ou
  python-frontmatter.
- **[OPT]** `requirements.txt` — `pydantic-settings` jamais importé → à supprimer.

**CONTRÔLES / BORNES :**

- **[OPT]** `models.py:227-228, 244-252` — payloads assistant (`contexte`, `historique`) et
  notes non bornés (surface d'abus LLM / croissance de données) → `max_length`.
- **[OPT]** `routers/epreuves.py:366,444,475` + `routers/assistant.py:114` — conversations/notes/
  signalements/assistant créables sur épreuves en brouillon **ou** payantes sans contrôle de
  `statut`/`has_access` → vérifier dans `get_epreuve_or_404` / `_load_conversation_and_epreuve`.
- **[OPT]** `routers/subscriptions.py:171-233` — checkout sans plafond : lignes illimitées en base →
  réutiliser une souscription « annulée »-pending existante ou plafonner.
- **[OPT]** `db_models.py:25-27` — `_short_uid` 8 hex = 32 bits → collisions probables à ~65-77 k
  objets ; passer à 12-16 hex avant croissance.
- **[NIT]** `routers/epreuves.py:229` — `limit=0` ramené à 1 ; corriger le clamp.

**PERFORMANCE :**

- **[OPT]** `routers/subscriptions.py:284-291` + `core/subscriptions.py:37` — `sub_to_out` fait un
  COUNT SQL par abonnement (N+1) → requête groupée unique.
- **[OPT]** `routers/import_service.py:246-247` — seules les images du « sujet » sont réécrites ;
  un corrigé avec images relatives garde des liens morts → boucler sur `("sujet","corrige")`.
- **[OPT]** `routers/admin_misc.py:170` — « 6 derniers mois » = mois présents ; générer la séquence
  calendaire complète avec des 0.

### 2.2 Frontend (26 constats — 0 CR / 3 REQUIS / 10 OPT / 13 NIT / 3 FYI)

**REQUIS :**

- **[REQUIS] `src/pages/AdminPage.tsx` (1 989 lignes)** — monolithe dépassant 2× le seuil de 1 000
  lignes ; 7 panneaux + formulaires + modales dans un seul fichier. → découper en `pages/admin/`
  (StatsPanel, EpreuvesPanel, ImportPanel, JournalPanel, SignalementsPanel, UtilisateursPanel,
  composants partagés). C'est le plus gros chantier « lisibilité/maintenabilité ».
- **[REQUIS] `src/pages/LoginPage.tsx:27`** — `api.get("/api/auth/config")` sans `.catch` : si
  l'API tombe, skeleton infini, promesse rejetée non gérée → état d'erreur + bouton « Réessayer ».
- **[REQUIS] `src/components/ConsentModal.tsx:23-24`** — cases `iaOk`/`notesOk` pré-cochées à
  `true` : consentement présumé = dark pattern RGPD. → défaut `false` (opt-in explicite).

**SIMPLICITÉ / NE PAS RÉINVENTER LA ROUE :**

- **[OPT]** `src/lib/time.ts` (62 lignes) — `formatRelativeTime` réinvente
  `Intl.RelativeTimeFormat('fr', { numeric: 'auto' })` → **~40 lignes gagnées**, stdlib, sans
  dépendance.
- **[OPT]** `src/lib/access.ts:20` — `computeAccessStatus` est le miroir TS de `store.has_access`
  (règle métier en DOUBLE, commentée « miroir exact ») → publier un champ `acces`/`couvert`
  calculé par l'API et supprimer la logique TS (élimine le risque n°1 de divergence).
- **[OPT]** `AdminPage.tsx:23-27` — `EVALUATIONS`/`SERIES_CONNUES` 3ᵉ copie du référentiel (déjà
  désynchronisé d'avec referentiel.ts) → consommer `referentiel.ts` ou l'API.
- **[NIT]** `src/lib/useEscapeKey.ts` — code mort (aucun import) ; `useModalFocus` réimplémente
  Échap alors qu'elle référence elle-même `useEscapeKey` → soit l'utiliser, soit le supprimer.
- **[NIT]** `src/auth/RequireAuth.tsx` + `RequireAdmin.tsx` — bloc « Chargement… » dupliqué.
- **[NIT]** `src/App.tsx` — `<Layout>` dupliqué entre 2 groupes de routes → route imbriquée.

**ROBUSTESSE / PERFORMANCE :**

- **[OPT]** `AuthProvider.tsx:107-123` — re-login sans déconnexion → 2ᵉ WebSocket sans fermer la 1ʳᵉ
  (leak + reconnexion parasite) → `closeSocket()` avant `openSocket()`.
- **[OPT]** `GoogleSignInButton.tsx:41` — stale closure `onCredential` + `window.google: any`
  + script SDK jamais retiré.
- **[OPT]** `streaming.ts:47-58` — découpage SSE sur `\n\n` uniquement : CRLF non découpé, dernier
  événement perdu → normaliser `\r\n`→`\n` + traiter le résidu en fin de flux.
- **[OPT]** App racine — aucun ErrorBoundary : une erreur de rendu met tout l'écran blanc.
- **[OPT]** `AssistantPanel.tsx:788` lignes + payload envoyé = markdown complet re-filtré à chaque
  envoi → envoyer la sélection ciblée.
- **[NIT]** `CataloguePage.tsx:115` — `console.error` laissé. `HomePage/SubscribePage/Catalogue`
  — `.catch(() => {})` silencieux sur fetch secondaires.
- **[OPT]** ESLint absent (tsc strict seul) malgré des `eslint-disable` déjà présents dans le code.

### 2.3 Sécurité (14 constats — 1 CR / 3 REQUIS / 4 OPT / 1 NIT / 5 FYI)

**CRITIQUE :**

- **[CRITIQUE] `render.yaml:66-67`** — `DEMO_MODE=true` **en production** : checkout +
  `simulate-webhook` activent un abonnement « actif » SANS paiement. Le garde-fou code existe
  (`test_durcissement.py`), c'est la CONFIG qui le neutralise. → `DEMO_MODE=false` au go-live payé.

**REQUIS :**

- **[REQUIS] `subscriptions.py:236-255`** — le webhook de paiement est une SIMULATION : aucun
  agrégateur, aucune vérification de signature. `PAIEMENT.md` documente déjà la marche à suivre
  (Notch Pay/Monetbil + test signature invalide/replay).
- **[REQUIS] `render.yaml:62-63`** — `AUTH_MODE=mock` en prod : n'importe qui crée un compte avec
  un email arbitraire. → `AUTH_MODE=google` + vraie whitelist `ADMIN_EMAILS`.
- **[REQUIS] `routers/files.py:50-55` + `core/signing.py:49-77`** — URL signée basée sur `file_id`
  seul, TTL 1 h + 5 min, jamais révoquée à la dépublication → signer `epreuve_id+statut` et
  vérifier `statut=="publie"` à la lecture.

**OPTIONNEL :**

- **[OPT]** `MarkdownContent.tsx` — `href` non filtrés : `[x](javascript:…)` interprétable au clic ;
  whitelist `http/https/mailto` + chemins `/api/files/`.
- **[OPT]** RGPD cycle de vie incomplet : pas de purge à la révocation du consentement IA, pas
  d'export (portabilité Art. 20), pas de suppression de compte (Art. 17).
- **[OPT]** `db_models.py:62` — `SessionORM.token` en clair en base → stocker SHA-256.
- **[OPT]** `pip-audit` jamais lancé (npm audit = 0) ; activer Dependabot.

**Points solides confirmés** : cookie HttpOnly/Lax/Secure + TTL 14 j, headers de sécurité, CORS
restreint, docs API à chemin secret, validation Pillow du contenu réel (SVG exclu), zip-slip bloqué,
IDOR filtré par `user_id`, XSS markdown maîtrisé, consentement RGPD bloquant, URLs signées HMAC.

### 2.4 Architecture & dépendances (10 constats)

**Dépendances inutiles (à supprimer) :**

- `pydantic-settings` — jamais importé (config via python-dotenv + classes pydantic v2).
- `requests` — l'import réel est `google.auth.transport.requests` (module de google-auth).
- `websockets==17.1` — déjà fourni par `uvicorn[standard]`, jamais importé directement.

Frontend : 0 dépendance inutile (toutes vérifiées par grep).

**Duplications (5) :**

- Référentiel de classification en 3 copies (referentiel.py ↔ referentiel.ts ↔ constantes
  AdminPage) — déjà désynchronisées.
- `computeAccessStatus` (TS) ↔ `has_access` (SQL) : règle métier double, risque de divergence
  gratuit/payant.
- Motifs de signalement en double (motifs.ts ↔ MOTIFS_SIGNALEMENT).
- `useEscapeKey` dupliqué dans `useModalFocus`.
- 4 fonctions LLM quasi identiques (voir backend).

**Fichiers > 500 lignes à surveiller** : AdminPage.tsx (1989, à découper), AssistantPanel.tsx (788),
ProfilePage.tsx (693), SubscribePage.tsx (594), assistant.py (546), epreuves.py (498), admin_misc.py
(476), admin_epreuves.py (465), store.py (442).

---

## 3. PLAN DÉTAILLÉ DES MODIFICATIONS (ordre d'exécution proposé)

> Chaque ligne = une unité de travail indépendante, petite (~≤150 lignes modifiées), testable,
> committable séparément — conforme au principe « change size ~100 lignes ».

> **STATUT D'EXÉCUTION (févr. 2026) : phases A→H entièrement implémentées.** Chaque étape est
> marquée ✅ ci-dessous. Vérification : `npm run build` + 13 tests frontend, pytest backend (79
> tests) verts. Aucun code poussé — les modifications attendent validation.

### PHASE A — Sécurité & configuration de production (PRÉ-REQUIS au go-live payé)

| # | Fichier(s) | Modification | Sévérité | Lignes |
|---|------------|--------------|----------|--------|
| ✅ A1 | `render.yaml` | `DEMO_MODE=false` + `AUTH_MODE=google` (commentaires mis à jour) | CRITIQUE | ~4 |
| ✅ A2 | `routers/subscriptions.py` + `routers/payments.py` (nouveau) | Webhook réel Notch Pay/Monetbil : vérif signature, idempotence conservée, tests signature invalide + replay | REQUIS | ~120 |
| ✅ A3 | `core/signing.py` + `routers/files.py` | Signer `file_id + epreuve_id + statut` dans le HMAC ; vérifier `publie` au service ; ajuster test | REQUIS | ~30 |
| ✅ A4 | `core/sessions.py` + `db_models.py:62` + migration | Stocker SHA-256 du jeton de session en base (token pur gardé en cookie) | OPT | ~25 |

### PHASE B — Bugs fonctionnels backend (REQUIS, à faire rapidement)

| # | Fichier(s) | Modification | Lignes |
|---|------------|--------------|--------|
| ✅ B1 | `core/store.py:318-326` | Corriger `scope_already_covered` : exiger joker `ALL` sur la dimension non contrainte + test dédié | ~12 |
| ✅ B2 | `core/epreuve_files.py:104-111` | Supprimer l'ancien objet après succès de la réécriture (nouvelle clé) | ~8 |
| ✅ B3 | `routers/admin_epreuves.py:284` | Reconstruire la clé image sans re-préfixer `cible-` | ~6 |

### PHASE C — Réduire le code : ne pas réinventer la roue (~205 lignes gagnées)

| # | Fichier(s) | Modification | Gain |
|---|------------|--------------|------|
| ✅ C1 | `requirements.txt` | Supprimer `pydantic-settings`, `requests`, `websockets` | 3 lignes |
| ✅ C2 | `core/assistant.py` | Unifier les 4 appels LLM en un helper générique (payload/headers/parser en paramètres) — tests conservés | ~120 lignes |
| ✅ C3 | `frontend/src/lib/time.ts` | Réécrire `formatRelativeTime` via `Intl.RelativeTimeFormat('fr')` (tests format.test.ts conservés) | ~40 lignes |
| ✅ C4 | `routers/ws.py:19-30` | `http.cookies.SimpleCookie` (stdlib) au lieu des 10 lignes manuelles | ~9 lignes |
| ✅ C5 | `core/catalogue.py:18` | Remplacer le parseur frontmatter maison par PyYAML (ou python-frontmatter) | ~15 lignes |
| ✅ C6 | `core/extraits.py`, `core/epreuve_files.py`, `core/assistant.py` | Factoriser l'extraction/réécriture des images Markdown (1 regex + 2 helpers) — centralisé dans `core/extraits.py` (pas de nouveau fichier) | ~20 lignes |

### PHASE D — Monolithe AdminPage : découpage (lisibilité/maintenabilité)

| # | Fichier(s) | Modification |
|---|------------|--------------|
| ✅ D1 | `frontend/src/pages/admin/` (nouveau) | Extraire `StatsPanel`, `EpreuvesPanel`, `ImportPanel`, `JournalPanel`, `SignalementsPanel`, `UtilisateursPanel` + composants partagés (Field/Select/ContentBlock) depuis `AdminPage.tsx` (1989 l. → ~250 l. de shell) |

### PHASE E — Corrections frontend (robustesse & RGPD)

| # | Fichier(s) | Modification | Sévérité |
|---|------------|--------------|----------|
| ✅ E1 | `LoginPage.tsx:27` | `.catch` → état d'erreur + bouton « Réessayer » ; fix du callback Google (erreur → toast, pas de navigation) | REQUIS |
| ✅ E2 | `ConsentModal.tsx:23-24` | Défaut `false` (opt-in explicite) sur `iaOk`/`notesOk` | REQUIS |
| ✅ E3 | `AuthProvider.tsx:107-123` | `closeSocket()` avant `openSocket()` dans loginMock/loginGoogle | OPT |
| ✅ E4 | `GoogleSignInButton.tsx` | Callback dans un ref (anti stale closure) + nettoyage du script | OPT |
| ✅ E5 | `streaming.ts:47-58` | Normaliser CRLF + traiter le résidu de buffer en fin de flux | OPT |
| ✅ E6 | `App.tsx` + `ErrorBoundary.tsx` (nouveau) | Route imbriquée `<Layout>` + ErrorBoundary racine | OPT |

### PHASE F — Règle métier unique (front/back) & pureté du référentiel

| # | Fichier(s) | Modification |
|---|------------|--------------|
| ✅ F1 | `core/subscriptions.py` / `routers/epreuves.py` (catalogue) | Exposer `acces`/`couvert` calculé par l'API dans chaque item ; supprimer `computeAccessStatus`/`access.ts` |
| ✅ F2 | `frontend/src/lib/referentiel.ts` + `AdminPage.tsx:23-27` | AdminPage consomme `referentiel.ts` (supprime la 3ᵉ copie) ; ou publier les listes via `/api/admin/config` |

### PHASE G — Contrôles, bornes & performance backend

| # | Fichier(s) | Modification |
|---|------------|--------------|
| ✅ G1 | `models.py:227-228, 244-252` | `max_length` sur `AskIn.contexte`, `historique[*].content`, `NoteIn.contenu` |
| ✅ G2 | `routers/deps.py` `get_epreuve_or_404` | Vérifier `statut=="publie"` ; `has_access` pour conversations/notes sur payantes |
| ✅ G3 | `routers/subscriptions.py` | Plafond de checkout (réutiliser le pending ou max 2) |
| ✅ G4 | `routers/subscriptions.py` / `core/subscriptions.py` | `sub_to_out` : compter les épreuves couvertes en UNE requête groupée |
| ✅ G5 | `core/import_service.py:246` | Réécrire aussi les images du corrigé |
| ✅ G6 | `routers/admin_misc.py:170` | 6 derniers mois calendaires avec mois à 0 |
| ✅ G7 | `db_models.py:25` | `_short_uid` → 12 hex (48 bits) |

### PHASE H — RGPD & hygiène (OPTIONNEL, sécurité de long terme)

| # | Fichier(s) | Modification |
|---|------------|--------------|
| ✅ H1 | `routers/me.py` + `db_models.py` | Purge des conversations à la révocation IA ; `GET /api/me/export` ; `DELETE /api/me/compte` (notes, conversations, sessions ; paiements conservés) |
| ✅ H2 | `MarkdownContent.tsx` | Whitelist des `href` (http/https/mailto + `/api/files/`) |
| ✅ H3 | NIT backend (9) | ws.py, files.py ternaire, epreuves.py limit, admin_session docstrings, assistant.py return/`produced`, migrations docstring, import_service stat |
| ✅ H4 | NIT frontend (13) | suppression code mort, RequireAuth/Admin factorisé, Console.error, documentation des catchs muets, setTimeout/rAF nettoyés |

---

## 4. Estimation des gains

- **Code supprimé / simplifié** : ~350 lignes (2 %) sur ~16 700 LOC — modeste mais sur les bons
  endroits (logique dupliquée, helper canonique, règle métier unique).
- **Dépendances retirées** : 3 backend (surface d'installation et de supply-chain réduite).
- **Fichier monolithique éliminé** : AdminPage 1 989 l. → ~7 fichiers < 400 l.
- **Risque de divergence métier supprimé** : 2 règles dupliquées front/back → 1 seule source.
- **Sécurité** : paywall sécurisé, identité vérifiée, révocation des URLs fichiers, sessions
  hashées, cycle RGPD complet.

---

## 5. Points forts à CONSERVER (ne rien casser)

- URL signées HMAC, navigation stockage local/S3 sans fuite de credentials.
- Anti zip-slip/bomb + validation Pillow du contenu.
- Sessions hashées en cookie HttpOnly/Lax/Secure, kick-out WebSocket, verrou admin en base.
- Requêtes 100 % paramétrées (SQLAlchemy).
- Rendu markdown XSS-safe ; `MarkdownContent.tsx` exemplaire (mémoïsé, React.memo).
- Des tests solides (68 backend + 13 frontend) — chaque modification du plan doit garder la suite verte.

> Prochaine étape : **approbation de ce plan**. Les phases A, B, C, E (modif. courtes) peuvent
> être exécutées immédiatement une fois validées ; la phase D (découpage AdminPage) est le seul
> gros chantier de refactoring structurel.