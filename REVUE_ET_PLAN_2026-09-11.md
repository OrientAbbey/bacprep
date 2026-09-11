# Revue de code complète & Plan d'implémentation — 2026-09-11

Objectif : vérifier que le projet respecte la politique
**« minimum de code possible, lisibilité, simplicité (complexité modérée), performance, sécurité — ne pas réinventer la roue »**,
puis corriger les écarts. Revue menée par 4 sous-agents (frontend, backend, sécurité, design/a11y/perf)
+ vérifications dodées sur les bugs signalés par l'utilisateur.

Rapports sources (temp) :
- `revue_frontend.md`, `revue_backend.md`, `revue_securite.md`, `revue_design.md`

---

## 1. Verdict global de la politique

Le projet respecte **globalement très bien** la politique (base solide, pas de réinvention de roue :
ORM SQLAlchemy partout, fonctionnalités std lib au lieu de libs, gestion centralisée des erreurs,
tokens de design uniques, découpage router/core sobre). Les écarts identifiés sont ciblés :

| Axe | Verdict | Écarts comptés |
|---|---|---|
| Lisibilité / simplicité | Bon | 2 fichiers > 700 lignes, 8 fonctions backend > 60 lignes, doublons `loginMock`/`loginGoogle`, `create_note` (dict fait main) |
| Performance | Bon | re-render à chaque chunk SSE, copie tableau par chunk, double traversée couverture |
| Sécurité | **Base saine, 2 vrais problèmes** | CORS `*.onrender.com` + credentials (Haute), rate-limit clé IP de proxy, admin token en sessionStorage, zip-bomb « déclarée » |
| Correctness | Bugs réels confirmés | double bulle assistant, LaTeX `$$` sur-ligne/`\\[2pt]`, logout admin sans reset, suppression épreuve impossible, zip chiffré → 500+job bloqué |

---

## 2. Liste priorisée des findings (synthèse des 4 rapports)

### 🔴 Bugs signalés par l'utilisateur (tous confirmés par reproduction)
1. **Logout admin → formulaire non nettoyé** (`AdminPage.tsx:141-146`) : `email`/`loginToken` jamais reset.
   "Vulnérabilité" : réutilisabilité du formulaire + jeton en clair à l'écran sur poste partagé.
2. **Toast « info » illisible en mode sombre** (`Toast.tsx:23`) : `text-highlight-ink` (#241A02, fixe) sur
   `bg-highlight-soft` (#3a2e12 en sombre) → **1,29:1**. Même bug dans `MetaBadge.tsx:11`.
3. **Double boîte assistant** (`AssistantPanel.tsx:346,551-569`) : bulle vide pré-créée rendue par
   `ChatBubble` **en plus** de l'indicateur « Assistant Pédagogique réfléchit… ».
4. **LaTeX cassé** (`lib/latex.ts`) :
   - `$$` posé sur sa propre ligne autour de `\begin{cases}` → **double wrap** `$$\n$$\begin{...}$$\n$$` (reproduit) ;
   - `\\[2pt]` (saut de ligne LaTeX) affiché tel quel — la regex `\\\[...\\\]` exige un `\]` de fermeture qui n'existe jamais ;
   - `\tfrac` : conversion OK ; rendu dégradé lié aux maillons aval (à vérifier par isolation au moment de la correction).
5. **Étirer la barre « Tuteur IA Prep »** : fonctionnalité absente (`w-[300px]`/`xl:w-[380px]` fixes dans `ViewerPage.tsx:432`).

### 🔴 Backend — Correctness critique
6. **Suppression d'épreuve → 500 systématique** (`admin_epreuves.py:338-364`) : purge omet les FK
   `notes`/`signalements` (NOT NULL) → IntegrityError à `db.commit()` pour presque toute épreuve consultée.
7. **Zip chiffré/corrompu** (`admin_import.py:194-201`) : seule `BadZipFile` attrapée → 500, job `pending`
   à jamais, zip laissé sur disque.
8. **Plafond décompressé non réel** (`admin_import.py:190-194`) : basé sur `info.file_size` (déclaré,
   forgeable) ; `zf.extractall` peut écrire plusieurs Go → zip-bomb.

### 🟠 Sécurité
9. **CORS prod `allow_credentials=True` + regex `*.onrender.com`** (`main.py:138-149`) : tous les
   `.onrender.com` partagent le **même site** → `SameSite=Lax` ne bloque pas → app gratuite onrender
   = requêtes credentialées (lecture profil/notes + URLs signées des corrigés couverts).
   → Service unifié : retirer le regex, garder seulement l'origine exacte de prod en `CORS_ORIGINS`.
10. **Rate-limit clé IP socket** (`rate_limit.py:59-64`) : derrière Render, une clé pour TOUS → 10 logins
    → DoS global du login. → Parser `X-Forwarded-For` (1er saut) uniquement via proxy de confiance.
11. **Jetons admin en `sessionStorage`** (`AdminPage.tsx:20,124`) : exposé à toute XSS même-origine.
    → Migration cookie HttpOnly (moyen terme) ; à défaut : filet de secours dans ce plan.
12. **CSP absente** (`main.py:114-127`) : dette documentée, à introduire `Report-Only` (moyen terme).

### 🟡 Qualité / simplicité / perf (politique)
13. `AssistantPanel.tsx` 789 l., `ProfilePage.tsx` 693 l. → découpage (moyen terme).
14. Doublon `loginMock`/`loginGoogle` (`AuthProvider.tsx:107-125`) → helper `completeLogin(me)`.
15. `streaming.ts` : dernier événement SSE sans `\n\n` final jamais traité (`:79`) ; type `conversation: any` (`:31`).
16. `AssistantPanel` : stale closure renommage onglet (`:383-396`), `setActiveId` dans un updater (`:306-325`),
    re-render à chaque chunk SSE (`:352-362`).
17. Backend : 8 fonctions > 60 lignes (dont `activite` 123 l. `me.py:327-449`) ; « 30 min » au lieu de 3 min
    dans logs/docstrings (`admin_session.py`, `deps.py:48`) ; règle de couverture dupliquée SQL/Python 3×
    (`store.py:241-399`) ; `create_note` → `NoteOut` (`epreuves.py:444-475`) ; `attempt_login` non atomique
    (`admin_session.py:55-93`) ; ClientDisconnect → traceback (`assistant.py:151`) ; Doctrine de purge compte
    dupliquée (`me.py` vs `admin_misc.py`).
18. Design/a11y : `:focus-visible { border-radius:2px }` déforme les pills (`index.css:96`) ;
    `text-highlight` 10px sur paper 2,3:1 (`JournalPanel.tsx:76`) ; KickoutBanner blanc/correction sombre
    3,38:1 (`App.tsx:26`) ; correction sur correction-soft 4,48/4,40:1 (`Toast.tsx:22`, `MetaBadge.tsx:8`).

---

## 3. PLAN D'IMPLÉMENTATION

**Convention :** une case `[x]` = étape terminée. Sévérité : 🔴 requis / 🟠 recommandé / 🟢 optionnel.

### PHASE 1 — Bugs signalés par l'utilisateur (🔴 prioritaire)

- [x] **É1. Logout admin : nettoyer le formulaire** — `frontend/src/pages/AdminPage.tsx`
  Dans `logoutAdmin`, ajouter `setEmail("")`, `setLoginToken("")`, `setError(null)`. (F5)
- [x] **É2. Contraste toasts + badges** — `frontend/src/components/Toast.tsx`, `MetaBadge.tsx`, `index.css`, `App.tsx`, `JournalPanel.tsx`
  - `Toast.tsx:23` et `MetaBadge.tsx:11` : `text-highlight-ink` → `text-ink` (+ maj commentaire MetaBadge).
  - `Toast.tsx:22` / `MetaBadge.tsx:8` (correction sur soft < 4,5:1) : retouche tokens —
    (a) clair : `--color-correction: #a73428`·(b) sombre : `--color-correction-soft: #332019` (ratios vérifiés par calcul avant validation).
  - `App.tsx:26` : `text-white` → `text-paper` (3,38 → 5,35:1 en sombre).
  - `JournalPanel.tsx:76` : `text-highlight` → `text-slate` (2,3 → ≥ 5,3:1).
  - `index.css:93-97` : retirer `border-radius: 2px` de `:focus-visible`.
- [x] **É3. Double boîte assistant** — `frontend/src/components/AssistantPanel.tsx`
  Dans le rendu de `active.messages.map(...)`, ne pas rendre la bulle assistant dont `content === ""`
  quand `sending` est vrai (l'indicateur « réfléchit… » reste seul). (F1)
- [x] **É4. Rendu LaTeX** — `frontend/src/lib/latex.ts` + tests `lib/latex.test.ts`
  Ré-architecture minimale en 2 passes :
  1. **Deux passes d'isolation** autour d'un `convertDelimiters` unique : `isolateDisplayMath(convertDelimiters(isolateDisplayMath(md)))`
     — la 1ʳᵉ met tous les blocs `$$` sur lignes dédiées (le lookbehind `(?<!\$\$\s)` devient fiable),
     la 2ⁿᵈ re-isole les environnements nus convertis.
  2. `convertDelimiters` : `\(…\)`→`$…$` ; `\[…\]`→`$$…$$` avec **lookbehind `(?<!\\)`** des deux côtés
     (ignore `\\[2pt]`) ; enveloppement `\begin{env}` nus avec lookbehind `(?<!\$\$\s)` + garde `before && after`.
  Tests de régression ajoutés : `$$\n\begin{cases}…\n$$` (ex. utilisateur), aligned + `\\[2pt]` (ex. utilisateur),
  `\\[2pt]` isolé, 13 tests verts.
- [x] **É5. Barre assistant étirable (drag-to-resize)** — `frontend/src/pages/ViewerPage.tsx`
  État `assistantWidth` (persisté `localStorage`, défaut 320), `<aside>` en `style={{width}}`, poignée
  (`role="separator"`, `cursor-col-resize`) + pointer events, clavier Flèches ±16 px, bornes 280 – min(45vw, 560).

### PHASE 2 — Backend : correctifs + sécurité (🔴 requis, avant prod)

- [ ] **É6. Suppression d'épreuve** — `backend/app/routers/admin_epreuves.py:338-364`
  Purger explicitement `NoteORM` et `SignalementORM` (FK NOT NULL) avant `db.delete(e)` ; compléter le docstring. (Critical)
- [ ] **É7. Import zip robuste** — `backend/app/routers/admin_import.py`
  - `except zipfile.BadZipFile` → `except Exception` : `_fail_job` + `upload_path.unlink` + 400.
  - Remplacer `zf.extractall` par une extraction **membre par membre avec compteur d'octets réels**
    (plafond `MAX_ZIP_BYTES` vérifié pendant l'écriture, zip-slip conservée).
  - `finally: shutil.rmtree(job_dir.parent, ignore_errors=True)` dans `_run_import_job` (purge `jobs/*`).
- [ ] **É8. Rate-limit derrière proxy** — `backend/app/core/rate_limit.py`
  `client_ip()` : parser `X-Forwarded-For` (premier saut) **uniquement si un header de proxy de confiance
  est présent**, sinon IP socket. Vérifier `is_prod()` en dev ne reste pas cassé (env local inchangé).
- [ ] **É9. CORS durci** — `backend/app/main.py:138-149`
  Retirer le regex `*.onrender.com` ; l'origine exacte de prod est déclarée via `CORS_ORIGINS`
  (service unifié → CORS inutile en prod). Garder `allow_credentials=True` pour dev.
- [ ] **É10. Exceptions streaming** — `backend/app/routers/assistant.py:141-154`
  `except ClientDisconnect: log.debug + return` AVANT le `except Exception` (fini le traceback complet
  + faux évènement `error` à chaque fermeture d'onglet pendant un streaming).
- [ ] **É11. attempt_login atomique** — `backend/app/core/admin_session.py:55-93`
  Privilégier `UPDATE … WHERE id='singleton'` puis `INSERT` seulement si rowcount = 0 (plus d'IntegrityError
  à la concurrence).
- [ ] **É12. [x] Correction « 30 min » → délai effectif** — `admin_session.py:58,64,98,104`, `deps.py:48`,
  `db_models.py:91` : remplacer par le délai configuré (logs/docstrings trompeurs).

### PHASE 3 — Sécurité / RGPD / bornes (🟠 recommandé)

- [ ] **É13. Bornes de saisie** — `models.py` (`SignalementIn.message` `max_length`, `contenu_markdown`/`corrige_markdown` `max_length=2_000_000`).
- [ ] **É14. Harmonies compte** — `me.py` vs `admin_misc.py` : unifier le comportement
  (effacement strict d'un côté, anonymisation de l'autre) — divergence comptable documentée (faible).
- [ ] **É15. Jeton admin cookie httpOnly** — migration `AdminPage` sessionStorage → cookie géré par le
  serveur (réutilise le verrou existant). *Plus invasif (touch tous les appels admin) — à planifier à part si accepté.*

### PHASE 4 — Qualité / politique (🟢 optionnel, au choix)

- [ ] **É16. `AuthProvider` : helper `completeLogin(me)`** — déduplique `loginMock`/`loginGoogle`.
- [ ] **É17. `create_note` → `NoteOut`** — `epreuves.py:444-475`.
- [ ] **É18. `streaming.ts` : dernier événement SSE + type `conversation`** — buffer final + type explicite.
- [ ] **É19. `AssistantPanel` : closures/updaters + flush chunk SSE** — ref stable des conversations
  (renommage d'onglet), `setActiveId` hors updater, buffer chunk en `requestAnimationFrame`.
- [ ] **É20. Découpage `AssistantPanel`/`ProfilePage`** (onglets → composants séparés).
- [ ] **É21. Split des 8 fonctions backend > 60 lignes** (priorité : `activite`, `admin_stats`,
  `admin_list_utilisateurs`, `_resolve_scope_fields`).
- [ ] **É22. Règle de couverture unique** — `store.py` : un seul chemin de comptage (GROUP BY) au lieu de 3.
- [ ] **É23. Nits mineurs** — code mort commenté `logging_config.py:30-31`, Combobox listeners, hook
  `useClickOutside`, AbortController ProfilePage, `hover:text-highlight` → couleur lisible.

---

## 4. Priorisation proposée

1. **Phase 1** (bugs utilisateur + design/couleurs + LaTeX + drag) — blocage UX, décision immédiate.
2. **Phase 2** (backend critical + sécurité) — avant toute mise en prod.
3. **Phase 3** (sécurité secondaire) — selon disponibilité.
4. **Phase 4** (qualité politique) — au fil de l'eau / au choix.

Risque de régression : faible pour P1/P2 (modifications ciblées, couvertes par les tests vitest existants
+ ajout de tests LaTeX ; le backend est couvert par la suite pytest — à relancer dans `backend/tests`).