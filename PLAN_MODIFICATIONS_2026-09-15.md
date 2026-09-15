# Plan de modifications — 15 septembre 2026

Plan des 6 modifications demandées (le point « comportement des tiroirs
mobiles » a été abandonné à la demande : « Laissons tomber cette modification
pour le moment »). Chaque chantier est listé avec ses étapes ; chaque étape est
cochée (`[x]`) une fois réellement réalisée et vérifiée (build frontend +
tests frontend/backend).

Légende : `[x]` réalisé · `[ ]` à faire.

---

## 1. Import d'un fichier `.md` dans l'éditeur + images redimensionnables

Un collègue fournit le sujet/corrigé dans un fichier Markdown : l'admin doit
pouvoir l'importer dans la zone de texte de l'éditeur (recopie dans le
bulletin, il garde la main). En complément, la taille d'affichage de chaque
image devient réglable **dans** la balise Markdown, persistée et respectée par
l'éditeur (rendu) ET le lecteur d'épreuve.

### Convention de taille d'image (à appliquer partout)

- Syntaxe : `![Légende](/api/files/{id}#w=300)` — fragment `#w=NNN` (largeur
  en px) accolé à l'URL de l'image.
- Choix motivé : le fragment est **sans espace ni parenthèse**, donc la regex
  unique `extraits.IMAGE_MD_RE` (`![alt](url)`) continue de matcher sans
  modification, le navigateur ignore un fragment dans la requête d'image
  réelle, et CommonMark (react-markdown/micromark) le conserve dans l'attribut
  `src` — contrairement aux syntaxes kramdown ` =300x` ou `{width=…}` qui
  cassent le parseur ou laissent du texte parasite.
- Absence de `#w=` = taille pleine (comportement actuel).

### Étapes

#### Backend — transmission de la taille au lecteur

- [x] `backend/app/core/epreuve_files.py` : `file_id_from_url()` ignore le
      fragment `#` (split sur `#` avant `?`) pour continuer à retrouver
      l'`id` d'une URL `/api/files/{id}#w=300`.
- [x] `backend/app/core/epreuve_files.py` : `sign_image_urls()` **préserve le
      fragment `#w=NNN`** lors de la signature : extraire le fragment de
      l'URL d'origine, le ré-accoler après l'URL signée produite par
      `signed_file_url(...)` (sinon le lecteur perd la taille à l'envoi).
- [x] Vérifié : `extraits.build_extrait()` supprime l'intégralité du match
      image (fragment inclus) — aucune extraction `/ =300` ni résidu.
- [x] Vérifié : `core/assistant.py::_extract_local_image_paths` retrouve le
      fichier d'une image `#w=…` (via `file_id_from_url` corrigée).

#### Frontend — rendu respectant la taille

- [x] Nouveau plugin rehype `rehypeImageDisplay` (dans `lib/markdownImages.ts`
      ou `lib/markdownSource.ts`) : pour chaque `<img>`, lit le fragment
      `#w=(\d+)` du `src`, le retire du `src`, et pose
      `style="width: {N}px; max-width: 100%; height: auto"` (jamais plus
      large que le conteneur, mobile compris).
- [x] `components/MarkdownContent.tsx` : ajouter `rehypeImageDisplay` aux
      plugins rehype des DEUX variantes (`epreuve` et `chat`) → l'éditeur
      (rendu) et le lecteur affichent la même taille.
- [x] Tests vitest `lib/markdownImages.test.ts` : URL avec/sans fragment,
      retrait du fragment du `src`, largeur bornée par `max-width`.

#### Frontend — import du fichier `.md`

- [x] `pages/admin/shared.tsx` (`ContentBlock`) : second champ fichier
      « Importer un fichier .md » (`accept=".md,.markdown,text/markdown"`)
      à côté du champ image, + prop `onImportMarkdown: (text: string) => void`.
- [x] `pages/admin/EpreuvesPanel.tsx` : handler d'import — lit
      `await file.text()` et remplit `contenu_markdown` (sujet) ou
      `corrige_markdown` (corrigé). Si le textarea contient déjà du texte,
      confirmation via `ConfirmDialog` avant écrasement (pattern existant).
      Le fichier n'est PAS envoyé au serveur : le texte vit dans l'épreuve
      comme aujourd'hui (l'import = pré-remplissage, l'admin garde la main).

#### Frontend — réglage de la taille à l'insertion

- [x] `pages/admin/shared.tsx` (`ContentBlock`) : sous chaque vignette, menu
      de taille d'affichage (Pleine / 240 / 320 / 480 / 640 px) ; le bouton
      « + » insère alors `![légende](/api/files/{id}#w=NNN)` (ou sans
      fragment pour « Pleine »).
- [x] `pages/admin/EpreuvesPanel.tsx` : `insertImageTag(asset, width?)` écrit
      le fragment selon la taille choisie ; `removeImageTag` reste compatible
      (supprime le match image, fragment compris — regex basée sur
      `extraits.IMAGE_MD_RE`).

---

## 2. Graphiques du back-office avec recharts

Le tableau de bord admin utilise des barres « maison » (`BarList`) : les
remplacer par des graphiques recharts (dépendance nouvelle, support attendu
de React 19).

### Étapes

- [x] `frontend/package.json` : ajouter `recharts` (`npm install recharts`,
      version ≥ 2.15 — support React 19).
- [x] `pages/admin/StatsPanel.tsx` : « REVENUS CONFIRMÉS (FCFA) » → `BarChart`
      recharts (6 derniers mois, données déjà présentes et zéro-remplies par
      `_admin_revenus_par_mois`) ; tooltip formaté `fr-FR`, étiquette clé
      `AAAA-MM`.
- [x] `pages/admin/StatsPanel.tsx` : « ÉPREUVES PUBLIÉES PAR CLASSE » →
      `BarChart` horizontal (`layout="vertical"`, `classeLabel`) — données de
      `stats.epreuves_par_classe` sans changement backend.
- [x] Donut stockage : **conservé en SVG maison** (fonctionne, cas à 2
      segments) — hors périmètre.
- [x] Style : `ResponsiveContainer`, couleurs = variables du thème
      (`--color-highlight`, `--color-valide`…), état « Aucune donnée » si
      liste vide, graphiques responsives en mobile.
- [x] `npm run build` (frontend) — vérifier que recharts s'intègre au
      bundle Vite sans erreur de dépendance.

---

## 3. Référentiels paramétrables (onglet « Paramètres »)

Les listes énumératives (`NIVEAUX`, `CLASSES_SECONDAIRE`, `EVALUATIONS`,
`SERIES_CONNUES`) et les champs libres (`matiere`, `session`) passent dans une
table `referentiel_options` administrée depuis un nouvel onglet du
back-office ; les formulaires d'épreuve consomment ces listes et **ajoutent
automatiquement** toute nouvelle saisie.

### Étapes

#### Backend — modèle + seed

- [x] `backend/app/db_models.py` : nouvelle table `referentiel_options`
      (`ReferentielOptionORM` : `id`, `scope` — `niveau|classe|evaluation|
      matiere|session|serie`, `code` (valeur), `label` (libellé affiché,
      nullable = repli sur `code`), `position`, `created_at`,
      contrainte unique `(scope, code)`).
- [x] Seed idempotent au démarrage (`main.py`, à côté de la migration
      `users.role` existante) : insérer les valeurs manquantes depuis
      `core/referentiel.py` (NIVEAUX → niveau, CLASSES_SECONDAIRE → classe
      avec `label`, EVALUATIONS → evaluation, SERIES_CONNUES → serie).
      `matiere`/`session` démarrent vides (elles s'alimentent à l'usage).
- [x] `backend/app/routers/admin_referentiel.py` (nouveau, monté dans
      `main.py`) :
  - `GET /api/admin/referentiel-options` → options groupées par `scope`,
    ordonnées par `position`;
  - `POST /api/admin/referentiel-options` → créer `{scope, code, label?}`;
  - `PATCH /api/admin/referentiel-options/{id}` → renommer/rellabeler;
  - `DELETE /api/admin/referentiel-options/{id}` → supprimer. La réponse
    signale si la valeur est en usage (`N` épreuves) pour confirmation UI
    (la suppression détache simplement la liste, les épreuves gardent leur
    valeur).
- [x] Garde : routes protégées par `require_admin` ; journal d'audit
      (`log_admin_event`) sur chaque mutation (création, renommage,
      suppression).

#### Frontend — onglet Paramètres

- [x] `pages/AdminPage.tsx` : étendre l'union `Onglet` (`"parametres"`), les
      boutons d'onglet, l'ordre clavier (`onTabsKeyDown`) et le routing du
      panneau (`tab === "parametres"`).
- [x] Nouveau `pages/admin/ParametresPanel.tsx` : pour chaque `scope` (Niveau,
      Classe, Évaluation, Matière, Session, Séries/filières) une liste
      d'options avec renommage inline, suppression (avec confirmation si en
      usage) et ajout — cohérent avec `UtilisateursPanel` (style, tokens
      design).

#### Frontend — formulaires d'épreuve branchés sur les options

- [x] `pages/admin/EpreuvesPanel.tsx` : charge les `referentiel-options` au
      montage (et les re-valide après une sauvegarde) ; les `Select` Niveau,
      Classe, Évaluation utilisent les options DB (repli sur les constantes
      `lib/referentiel.ts` si échec du chargement).
- [x] Matière / Session : champs libres enrichis d'une `<datalist>` alimentée
      par les options DB (saisie libre conservée, suggestions disponibles).
- [x] Séries/filières : puces alimentées par les options DB + champ libre
      existant ; à l'ajout (Entrée), `POST` best-effort vers
      `/api/admin/referentiel-options` pour mémoriser la nouvelle valeur
      (helper `ensureReferentielOption(scope, code)` dans `api/client.ts`).
- [x] Auto-ajout matiere/session : à la sauvegarde d'une épreuve, toute
      matière ou session absente de la table est ajoutée (best-effort, sans
      bloquer l'enregistrement).

#### Vérifications

- [x] `pytest` (backend) : tests du CRUD referentiel + seed idempotent +
      protection admin + journal.
- [x] `npm run test` + `npm run build` (frontend).

---

## 4. Description « Format attendu » dans l'éditeur

Le paragraphe de `ContentBlock` (`shared.tsx:195-198`) est remplacé par une
description claire, structurée, détaillée et concise du Markdown accepté —
sorte de prompt décrivant ce qui est attendu d'un sujet/corrigé bien
rédigé.

### Étapes

- [x] Réécrire le texte en sous-composant partagé `FormatAttendu` (constante
      de texte + affichage) : titres `#`/`##`/`###` hiérarchisés, paragraphes
      et listes, **formules LaTeX** `$…$` et `$$…$$` (et environnements dans
      `$$`), **tableaux** Markdown, **images** `![légende](url)` avec taille
      `#w=` (voir chantier 1), **ancres** `{#id}` pour les renvois
      GPC/Théorique, code inline/blocs. Mentionner ce qui est ignoré/filtré
      (HTML brut, liens non-sûrs) en une ligne.
- [x] Rendre lisible sans encombrer : résumé + bloc `<details>` dépliable
      « À propos du format attendu » dans les deux `ContentBlock` (sujet et
      corrigé).
- [x] Vérifier le rendu à l'écran (l'un et l'autre bloc, tailles d'écran).

---

## 5. Pages Profil / Abonnement : occuper l'espace au lieu de centrer

Ces pages restent en colonne étroite (`max-w-2xl` centré) alors que le
`Layout` est désormais pleine largeur (Phase 5) : profiter de la largeur.

### Étapes

- [x] `pages/ProfilePage.tsx` : passer à une grille `lg` (ex.
      `lg:grid-cols-[300px_1fr]`) — colonne d'identité/résumé (avatar, nom,
      classe, statut abonnement, dépense) + zone principale (activité, notes,
      discussions IA) ; mobile en une colonne.
- [x] `pages/SubscribePage.tsx` : grille responsive — sélecteur de plans
      (cartes pricing côte à côte sur `md`) et récapitulatif de commande
      (statut, montant, bouton) répartis en colonnes au lieu d'une bande
      centrale.
- [x] Vérifier le rendu mobile (une colonne), tablette et bureau (2-3
      colonnes) et la cohérence avec les tokens existants (cartes
      `bg-paper-raised`, `rounded-lg`, `font-serif-brand`).

---

## 6. Hauteur du lecteur d'épreuve sur mobile

Le lecteur est calibré à `h-[calc(100dvh-7rem)]` (`ViewerPage.tsx`) ; sur
petits écrans plusieurs rangées d'en-tête (burger, titre+TS, bandeau
visiteur, barre d'actions de sélection) rongent la hauteur réellement
affichable. L'objectif : maximiser la zone de lecture sur mobile.

### Étapes

- [x] `pages/ViewerPage.tsx` : inventorier les rangées fixes (header sticky,
      bandeau méta/visiteur, filigrane, selection bar, lanceur assistant) et
      mesurer leur emprise à 375 px et 768 px.
- [x] Mobile : replier le bandeau méta/visiteur dans une ligne fine ouverte
    par `<details>` (contenu consultable en un geste, zéro place permanente) ;
      ne conserver en permanence que l'essentiel (burger, titre tronqué,
      action « Demander »).
- [x] Garder la BONNE hauteur totale : le calcul `h-[calc(100dvh-H)]` doit
      refléter les seules rangées persistantes après repli (H plus petit sur
      mobile), zone de lecture en défilement interne (`overflow-y-auto`),
      tiroir assistant aligné.
- [x] Vérifier : plus de « zone morte » au-dessus/besous du texte, l'épreuve
      occupe l'écran du haut en bas, assistant (sheet plein écran mobile)
      toujours ouvrable.

---

## 7. Assistant admin : tiroir droit éphémère sur l'épreuve en cours

Un assistant IA dans le back-office, ouvert en tiroir droit dans l'onglet
Épreuves, avec pour contexte l'épreuve en cours d'édition (métadonnées +
sujet + corrigé saisis). Réponses **streamées** ; conversations
**éphémères** (rien n'est persisté côté serveur, pas de nouvelle table).
(Point 8 initial — « comportement des tiroirs mobiles » — abandonné, hors
périmètre.)

### Étapes

#### Backend

- [x] `backend/app/core/admin_assistant.py` (nouveau) : `build_admin_prompt()`
      — persona « assistant du back-office BacPrep », expert épreuves/Markdown
      /LaTeX du secondaire camerounais ; contraignants de format Markdown
      STRICTS (reprise des règles `$…$`/`$$…$$` de `core/assistant.py`) ;
      contexte = métadonnées + Markdown brut sujet/corrigé (tronqué à
      `MAX_CONTEXT_CHARS`) ; question + historique à la main de l'admin.
- [x] Réutiliser l'infra LLM existante (`core/assistant.py` : `_get_semaphore`,
      `_stream_provider`/fallback Gemini → Groq → mode démo, `_shared_client`).
- [x] `backend/app/routers/admin_assistant.py` (nouveau, monté dans
      `main.py`) : `POST /api/admin/assistant/ask` (SSE `data: {json}`,
      mêmes événements `chunk/done/error` que l'assistant élève via
      `StreamingResponse`) ; `require_admin` ; rate-limit
      `SlidingWindowLimiter` (compte admin/IP) ; `done.conversation = null`
      (aucune persistance).
- [x] Tests pytest : auth requise, forme du flux SSE, prompt avec contexte
      d'épreuve, comportement sans clé (mode démo).

#### Frontend

- [x] `lib/streaming.ts` : extraire un générique `streamEventSource(url,
      body, onEvent)` ; `streamAssistantAsk` l'utilise ; ajouter
      `streamAdminAsk(payload, onEvent)` → `/api/admin/assistant/ask`.
- [x] Nouveau `pages/admin/AdminAssistantPanel.tsx` : tiroir droit (overlay
      `fixed inset-y-0 right-0`, largeur `w-[min(420px,100vw)]`, z élevé,
      fond assombri, fermeture X/Échap/backdrop) — dans l'onglet Épreuves
      uniquement.
  - Conversation **éphémère** : liste de messages dans l'état du composant
    (perdue à la fermeture/rechargement de la page), bouton « Nouvelle
    conversation » pour tout effacer.
  - Champ de saisie + streaming (indicateur « génère… »), rendu des réponses
    en Markdown (`MarkdownContent variant="chat"`).
  - Chaque envoi embarque un **instantané du formulaire courant**
    (`EpreuvesPanel` → prop `form`) : niveau, classe, évaluation, matiere,
    annee, session, filieres, contenu_markdown, corrige_markdown. Mention
    « Contexte : épreuve en cours » + nom de l'épreuve.
- [x] `pages/admin/EpreuvesPanel.tsx` : bouton « Assistant » (icône Bot) dans
      la barre d'actions du formulaire, ouvre le tiroir ; le `form` est
      resnapshotté à chaque envoi (pas de prop figée).
- [x] Tests vitest : décodage du flux admin ; état éphémère (thread vidé à la
      fermeture).

---

## Vérifications globales

- [x] `npm run build` (frontend) — build prod ✓
- [x] `npm run test` (frontend, `vitest run`) ✓
- [ ] `pytest` (backend, `.venv`) ✓