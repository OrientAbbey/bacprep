# Revue comparée — 03 · Plan de portage vers `refonte`

**Base cible** : `refonte` (`8de0fe9`), version en production, avec le filet E2E (102 scénarios).
**Source** : `feature/bacprep-evolution-complete` (`544a3bc`), uniquement comme **fournisseur de
briques**. Aucun merge global : les deux branches ont divergé sur des contrats incompatibles.

**Règle d'or** : on **copie des fichiers puis on adapte les imports**, on ne cherry-pick pas.
Un cherry-pick ramènerait `useT`, les clés `i18n/fr.ts`, `nom_fr`, `/confirm`, etc., et casserait
`refonte`. Chaque lot ci-dessous est indépendant et livrable seul.

---

## Suivi d'avancement

**Branche de travail** : `refonte-test`, créée depuis `refonte` (`8de0fe9`). Toutes les
modifications du portage y sont faites ; **fusion dans `refonte` à la fin du chantier**.

**Boucle de validation visuelle** (active pendant tout le chantier) :

- backend de travail : `uvicorn app.main:app --reload --port 8000`, base de démo
  `bacprep-wt\refonte-db\app.db` ;
- frontend en direct : `npm run dev` → http://localhost:5173 (`frontend/.env` pointe déjà sur
  `http://localhost:8000`, CORS déjà autorisé) ;
- témoin `evolution` : http://127.0.0.1:8772 (worktree figé + `dist`, base `evolution-db`).

Cycle par lot : **coder → regarder sur 5173 et 8772 → tests → commit → cocher**.

Légende : ⬜ à faire · 🟨 en cours · ✅ terminé (tests verts) · ⏸️ différé

| Lot | État | Commit | Reste à faire |
|---|---|---|---|
| **0** · Atelier, base de référence, suivi | ✅ terminé | — | boucle live + baseline tests |
| **A** · Lecteur paginé | ✅ terminé | `e4c05d1` | 8 étapes (voir ci-dessous) |
| **C** · Catalogue et recherche groupés | ✅ terminé | `953f309` | E2E catalogue vert |
| **B** · Entraînement et gabarits | ✅ terminé | `e7d58e4` | E2E 109/109, `vitest` 238/238, `pytest` 684 + 2 ignorés |
| **D** · Pages légales + pied de page | ✅ terminé | `ff91749` + `0dffd8e` + `7111c48` | contenu juridique à valider |
| **E** · Aide admin dédiée | ✅ terminé | `7cab935` | `/aide/admin`, couverture des 11 onglets, E2E 113/113 |
| **F** · Finitions console | ✅ terminé | `1ac3e75` | E2E 105/105, `vitest` 221/221, `pytest` 363 + 1 ignoré |
| **G** · SEO et aperçus | ⬜ à faire | — | `seo.py`, `spa_catch_all`, tests |
| **J** · Extension E2E | ⬜ à faire | — | scénarios des lots A–G |
| **H** · i18n typée | ⏸️ différé | — | hors périmètre |
| **I** · Description d'images | ⏸️ différé | — | après refactor assistant (B2) |

### Lot 0 — préparation

- [x] 0.1 Créer `refonte-test` depuis `refonte` (`8de0fe9`)
- [x] 0.2 Baseline sur `refonte-test` : `pytest` 357 passés + 1 ignoré ; `npm test` 195/196 (échec
      préexistant par timeout, `src/lib/dates.test.ts`) ; `npm run build` OK
- [x] 0.3 Lancer la boucle live (8000 + 5173) et le témoin `evolution` (8772)
- [x] 0.4 Vérifier que le lecteur actuel s'affiche à l'identique sur 5173 (référence « avant »)

### Lot A — lecteur paginé

- [x] A1. Renommer le vocabulaire : `BasculeAffichage` → « Un sujet à la fois » / « Tous les sujets » ;
      « Lecture paginée » réservé à la pagination du texte
- [x] A2. Copier `lib/pagination.ts` + `pagination.test.ts` (clé `bacprep-lecteur-pagine`) — 25 tests verts
- [x] A3. Copier `PagedContent.tsx`, `BasculePages.tsx` ; pastille unique `ControlesLecture.tsx` ; CSS
      `.paged-flux` dans `index.css`
- [x] A4. Zoom : `zoom` CSS conservé en défilement continu (E2E), `--exam-scale` + `font-size` en paginé
- [x] A5. Barre flottante en bas à gauche, hors feuille : Lecture paginée · A− · % · A+ (en mobile la
      pastille passe sous la barre de pages, jamais par-dessus)
- [x] A6. Intégration dans `ViewerPage.tsx` : PDF, hors-ligne, chrono, alarme, notes, sélection, assistant,
      filigrane dans la feuille, sélection vidée au changement de page, navigation par sujet masquée en paginé
- [x] A7. Vérifié desktop 1280 px et mobile 390 px : défilement continu, pages 1/2, zoom 130 %
- [x] A8. Tests : `pagination.test.ts`, E2E du lecteur, `pytest` + `vitest` + `npm run build`, puis commit
      — E2E 103/103, `vitest` 221/221, build OK ; `pytest` 357 + 1 ignoré (baseline, aucun fichier backend modifié)
- [x] A9. Fond du conteneur `panel-epreuve` aligné sur `evolution` : `bg-ink/5` au lieu de `bg-paper`
      (feuille blanche conservée, contraste du « bureau » identique dans les deux versions)
- [x] A10. Hors immersion, le panneau de lecture a une hauteur **généreuse** avec plancher
      (`h-[max(26rem,calc(100dvh-11rem))] sm:h-[max(32rem,calc(100dvh-10rem))]`) au lieu de la seule
      place restante : sur un écran court il ne rétrécit plus (mesuré 1366×900 → 740 px contre 519 px
      dans `evolution`), la page défile au besoin. En immersion, plein écran conservé.

---

## 0. Découpage recommandé

Créer une branche de portage depuis `refonte` :

```bash
git checkout refonte
git pull
git checkout -b portage/evolution-ui
```

Un **commit par lot**, une **PR par lot**, CI verte à chaque étape. Ne jamais mélanger lecteur et
entraînement dans la même PR : le lecteur est du front pur, l'entraînement touche la base.

| Lot | Contenu | Dépend de | Effort (j-h) |
|---|---|---|---|
| **A** | Lecteur paginé + contrôles flottants | — | **5** |
| **B** | Entraînement + gabarits + admin | A (contrôles) / adaptateur assistant | **10** |
| **C** | Catalogue et recherche groupés + squelettes | — | **2,5** |
| **D** | Pages légales + pied de page | — | **0,5** + validation juridique |
| **E** | Aide admin dédiée + fusion de l'aide élève | — | **1,5** |
| **F** | Finitions console (plein écran, aide, filtre journal) | — | **1,5** ✅ |
| **G** | SEO, `robots.txt`, `sitemap.xml`, aperçus de partage | — | **2** |
| **H** | i18n typée (chantier transverse) | tous | **8–12** (à différer) |
| **I** | Description d'images (accessibilité) | refactor assistant | **3** (à différer) |
| **J** | Extension E2E + passe de performance | A–G | **3** |

**Chemin critique recommandé** : **A → C → B → D → E → F → G → J**.
Total A–G + J : **≈ 26 j-h**, soit **5 à 6 semaines** pour une personne, hors revue juridique.
Avec H : **+2 à 3 semaines** et un risque de régression élevé — **ne pas l'inclure dans ce
portage**.

---

## 1. Lot A — Lecteur paginé (priorité absolue)

### Pourquoi c'est faisable sans refonte du rendu Markdown

`refonte` possède déjà `MarkdownContent` avec `trackSourcePositions` (attributs
`data-src-start`), exactement ce dont `PagedContent` a besoin pour mesurer les blocs. Le moteur
de rendu (KaTeX, images, ancres) est **le même** dans les deux branches. Il n'y a donc **pas** à
porter `Rich.tsx` ni à réécrire le pipeline Markdown.

### Fichiers à copier

| Fichier source (`evolution`) | Destination (`refonte`) | Remarque |
|---|---|---|
| `frontend/src/lib/pagination.ts` (123 l.) | idem | Remplacer `useT` par `t` |
| `frontend/src/components/PagedContent.tsx` (240 l.) | idem | Remplacer `useT` ; garder `children`, `reflow`, `filigrane` |
| `frontend/src/components/BasculePages.tsx` (20 l.) | idem | Adapter les libellés |
| `frontend/src/components/TailleTexteFlottante.tsx` (42 l.) | idem | Voir « taille du texte » ci-dessous |
| CSS `.paged-flux` (~35 l.) | `frontend/src/index.css` | **Indispensable** : colonnes, `break-inside`, `orphans/widows` |
| CSS `--exam-scale` + `.lecteur-sans-zoom` (~15 l.) | `frontend/src/index.css` | Voir « taille du texte » |

### Fichiers à **ne pas** copier

- `lib/immersif.ts` : `refonte` a déjà son immersion (`data-immersion`, `lib/sujets.ts`).
- `lib/pincement.ts` : `refonte` a déjà `usePincementZoom` (paliers 40–200 %).
- `ViewerPage.tsx` d'`evolution` : **à réécrire partiellement**, pas à copier (il perd PDF,
  hors-ligne, examen blanc, alarme, notes, sélection).
- `BasculeImmersion.tsx` : réutiliser le bouton existant de `refonte` ou l'adapter à son état
  `immersion`.

### Intégration dans `refonte/frontend/src/pages/ViewerPage.tsx`

La zone de lecture actuelle (lignes ~676–695) est un conteneur scrollable avec une seule feuille
`<div style={{ zoom: taille }}>`. À remplacer par :

```tsx
// état — refonte n'a que `affichageInitial` (mode « un sujet à la fois ») :
// ajouter un helper dédié (clé localStorage distincte, ex. `bacprep-lecteur-pagine`)
const [pagine, setPagine] = useState(lirePagine);

// rendu
{pagine ? (
  <PagedContent
    key={`${onglet}-${sujetActifData?.index ?? 0}`}
    reflow={taille}
    filigrane={<Watermark label={...} />}
    onPageChange={() => { window.getSelection()?.removeAllRanges(); setSelection(null); }}
  >
    <MarkdownContent content={contenuActif || ""} variant="epreuve" trackSourcePositions />
  </PagedContent>
) : (
  <div className="relative mx-auto max-w-[210mm] ...">
    <MarkdownContent content={contenuActif || ""} variant="epreuve" trackSourcePositions />
    <Watermark label={...} />
  </div>
)}
```

Points de vigilance :

1. **Taille du texte** : `refonte` zoome avec `style={{ zoom: taille }}`. `PagedContent` mesure
   des colonnes ; appliquer `zoom` sur le conteneur fausse les mesures. Porter la méthode
   d'`evolution` : `style={{ "--exam-scale": taille }}` sur la zone de lecture, et
   `font-size: calc(1rem * var(--exam-scale, 1))` sur `.prose-exam`. Passer `reflow={taille}`
   pour forcer la remesure et **conserver la page courante** (ancrage déjà implémenté).
2. **Plage de zoom** : `refonte` va de 40 à 200 %, `evolution` de 40 à 180 %. Garder **40–200**
   et vérifier le rendu des tableaux à 200 %.
3. **Barre flottante** : la placer **en bas à gauche** (emplacement actuel de `TailleTexte`) ou
   dans une gouttière, **jamais au-dessus de la feuille**. Empiler Immersion · Pages · A− · % ·
   A+ dans une seule pilule.
4. **Vocabulaire** : `refonte` appelle déjà « Page par page » le choix *un sujet à la fois*
   (`BasculeAffichage`). Renommer ce dernier en **« Un sujet à la fois »** et réserver
   **« Lecture paginée »** à la pagination du texte. Sinon l'élève voit deux « Pages » qui font
   des choses différentes.
5. **PDF / hors-ligne / examen blanc / chrono / notes / sélection / assistant** : ne rien
   démonter. `ExportPdf` imprime `contenuActif`, indépendamment du mode paginé. Vérifier que le
   bouton PDF reste visible **dans les deux modes**.
6. **Filigrane** : le passer en prop `filigrane` (il est rendu *dans* la feuille, au-dessus du
   texte) ; ne pas le laisser en `fixed` derrière la feuille.
7. **Sélection** : à chaque changement de page, vider la sélection (sinon la barre reste sur une
   page qui n'existe plus).

### Tests

- Porter `pagination.test.ts` (bornes, ancre, dimensions, clavier).
- E2E à ajouter dans `frontend/e2e/e2e.mjs` :
  - le compteur affiche « Page 1 / N » ;
  - `→` avance, `←` recule, `Début`/`Fin` vont aux extrémités ;
  - changer A+/A− conserve la page courante ;
  - le PDF produit toujours sujet + corrigé ;
  - une épreuve téléchargée s'ouvre hors réseau **en mode paginé** ;
  - `Échap` sort de l'immersion ;
  - la barre de sélection disparaît au changement de page.

### Critères d'acceptation

- Aucun texte recouvert par les contrôles, à 1280 px **et** 390 px.
- Pagination identique après rechargement (préférence mémorisée).
- Aucune régression sur les 102 scénarios E2E existants.

---

## 2. Lot B — Entraînement et gabarits (le plus gros)

### 2.1 Ce qui est autonome

| Fichier source | Lignes | Dépendances |
|---|---|---|
| `backend/app/core/gabarits.py` | 511 | `referentiel`, `logging_config` (présents) |
| `backend/app/gabarits/*.json` | 19 fichiers | — |
| `backend/app/routers/entrainement.py` | 78 | `gabarits`, `rate_limit`, `auth.require_user` (présents) |
| `backend/app/routers/admin_gabarits.py` | 84 | `gabarits`, modèles `GabaritValidationORM`, `GabaritSignalementORM` |
| `frontend/src/pages/EntrainementPage.tsx` | 327 | `api`, `lib/entrainement`, `useT` → `t` |
| `frontend/src/lib/entrainement.ts` | 89 | — |
| `frontend/src/pages/admin/GabaritsPanel.tsx` | 248 | `GabaritsPanel`, `useT` → `t` |
| `frontend/src/components/AtelierExercicesModal.tsx` | 254 | `EpreuvesPanel` (existant) |

**Modèles à ajouter** dans `backend/app/db_models.py` (copie des classes d'`evolution`) :
`GabaritValidationORM` (`gabarit_validations`), `GabaritSignalementORM`
(`gabarit_signalements`). `create_all` les crée au démarrage : **migration additive, sans
risque** pour les bases existantes. `llm_usage` est **optionnel** (voir 2.2).

**Routes à enregistrer** dans `backend/app/main.py` :

```python
from .routers import admin_gabarits, entrainement
app.include_router(admin_gabarits.router)
app.include_router(entrainement.router)
```

**Frontend** : route `/entrainement` dans `App.tsx`, lien d'en-tête dans `Layout.tsx`, onglet
« Exercices types » dans `AdminPage.tsx` (groupe « Contenu »), entrée dans
`lib/adminMenu.ts` si l'on porte le menu groupé.

### 2.2 Le piège : `core/assistant.py` a été refactoré

`admin_generation.py` (génération d'exercices par l'IA, 64 l.) appelle des fonctions **privées**
qui **n'existent pas** dans `refonte` :

```
assistant._modeles_surcharge
assistant._csv_env
assistant._nouvelle_mesure
assistant._enregistrer_mesure
assistant.cle_ia_configuree
assistant.call_cascade
```

`refonte` n'expose que `ask_assistant()` et `ask_assistant_stream()`. Trois options :

| Option | Coût | Risque | Recommandation |
|---|---|---|---|
| **B1. Adaptateur** : ajouter dans `refonte/core/assistant.py` un `call_cascade()` qui appelle `ask_assistant` avec un méta vide, et des no-ops pour `_nouvelle_mesure`/`_enregistrer_mesure` | ~80 l. | Faible | **Recommandé pour démarrer** |
| **B2. Porter tout `assistant.py` d'`evolution`** (cascade fournisseurs, mesure, `decrire_image`, `FournisseursIndisponiblesError`) | ~1 000 l. + tests | **Élevé** (touche le cœur le plus sensible) | À faire plus tard, lot séparé |
| **B3. Ne pas porter la génération IA** ; ne garder que les 19 gabarits paramétrés et l'atelier manuel | 0 | Faible | Repli si le temps manque |

**Décision conseillée** : **B1** dans un premier temps, avec un test qui prouve que
`/api/admin/generation-exercices` streame bien une réponse. Si l'on veut ensuite la description
d'images (lot I), il faudra passer à B2.

### 2.3 Ordre interne du lot B

1. `db_models.py` + `gabarits.py` + 19 JSON + tests unitaires (`test_gabarits.py`,
   `test_gabarits_exemples.py`, `test_fiche_gabarits.py`).
2. `entrainement.py` + `admin_gabarits.py` + tests API (`test_entrainement.py`).
3. `EntrainementPage` + `lib/entrainement.ts` + route + i18n.
4. `GabaritsPanel` + onglet admin + `AtelierExercicesModal`.
5. `admin_generation.py` + adaptateur assistant + test de streaming.
6. E2E : valider un gabarit → il apparaît côté élève ; retirer la validation → il disparaît ;
   une graine partagée redonne la même variante ; un signalement remonte dans l'admin.

### 2.4 i18n du lot B

Ne **pas** copier `i18n/fr.ts`. `refonte` utilise **la phrase française comme clé** :

```ts
// evolution
t("train.titre")                       // "Entraînement"
// refonte
t("Entraînement")                      // et ajouter "Entraînement": "Training" dans en.json
```

Compter **~65 clés** (`train.` 33, `adm_gab.` 30) à réécrire dans les composants et à ajouter
dans `frontend/src/locales/en.json`. Même travail pour les autres lots (~190 clés au total).

### 2.5 Performance de démarrage

L'import d'`app.main` d'`evolution` a été mesuré à **~104 s à froid** (défense antivirus Windows
comprise). L'import seul de `core.gabarits` a varié de **~3 s** (cache disque chaud) à **~35 s**
(worktree fraîchement copiée, antivirus) ; `gabarits.tous()` prend ensuite **~1,6 s**. `gabarits.py`
charge et vérifie les 19 fichiers au premier accès. Pour ne pas ralentir `refonte` :

- garder le chargement **paresseux** (ne pas appeler `gabarits.tous()` au démarrage) ;
- mémoïser le résultat (`lru_cache`) ;
- surveiller `/api/health` : il ne doit pas dépendre des gabarits.

### 2.6 Critères d'acceptation

- Aucun exercice public tant qu'un enseignant ne l'a pas validé.
- Le rapport automatique porte sur 100 graines et bloque la validation en cas d'échec.
- Les 19 gabarits sont validables et visibles.
- La même URL `?g=…&graine=…` redonne exactement la même variante.
- Les signalements élèves sont traités dans l'onglet admin.
- Les tests `pytest` de `refonte` restent verts (340+) et les nouveaux tests passent.

### 2.7 Avancement du lot B (livré)

- [x] B1. **Gabarits** : `core/gabarits.py` (chargement paresseux, `lru_cache`, `GRAINE_MAX` =
      2³¹−1, `tous()`, `rapport_validation` sur 100 graines) + les **19 JSON** de
      `app/gabarits/`. `pytest` couvre les gabarits, leurs exemples et la fiche
      (`test_gabarits.py`, `test_gabarits_exemples.py`, `test_fiche_gabarits.py`), plus deux
      scripts de développement (`scripts_dev/fiche_gabarits.py`, `verif_gabarits.py`) dont la
      vérification indépendante utilise `sympy`, ajouté **en dépendance de développement
      seulement** (les tests concernés sont ignorés s'il est absent).
- [x] B2. **Modèles** : `GabaritValidationORM` (`gabarit_validations`, clé = hash du contenu) et
      `GabaritSignalementORM` (`gabarit_signalements`, clé = gabarit + graine). Migration additive
      par `create_all`, aucune colonne existante touchée.
- [x] B3. **API élève** `routers/entrainement.py` : liste des gabarits validés, variante par
      graine, correction, signalement. Une variante non validée répond **404** ; un signalement
      en double répond **409**. Messages traduits côté front (`detailServeur`), routeur ajouté au
      contrat `test_messages_traduits.py`.
- [x] B4. **API admin** `routers/admin_gabarits.py` : liste avec rapport de contrôle, aperçu d'une
      variante, validation, retrait de validation, file de signalements et résolution.
- [x] B5. **Atelier IA** : `core/generation_exercices.py` + route SSE
      `POST /api/admin/generation-exercices` (débit 6 demandes/600 s, 409 si l'épreuve est
      publiée, 503 sans clé IA, audit `generation_exercices`). Adaptateur **B1** dans
      `core/assistant.py` : `call_cascade()` réutilise `_call_groq` avec
      `GENERATION_GROQ_MODELS` (défaut `openai/gpt-oss-120b` puis `openai/gpt-oss-20b`) ;
      `_nouvelle_mesure`/`_enregistrer_mesure` sont des no-ops (pas de journal de jetons dans
      `refonte`). Variables documentées dans `backend/.env.example`.
- [x] B6. **Page élève** `/entrainement` (`EntrainementPage.tsx`, `lib/entrainement.ts`) : liste
      des exercices validés, variante dans l'URL (`?g=…&graine=…`, donc partageable et stable au
      rechargement), correction dépliable, formulaire de signalement. Liens dans l'en-tête, le
      menu mobile et la barre de navigation basse.
- [x] B7. **Console** : onglet « Exercices types » (groupe « Contenu », **11 sections**),
      `GabaritsPanel.tsx` (valider/retirer, aperçu avec correction, autres variantes,
      signalements d'exercices) et `AtelierExercicesModal.tsx` ouvert depuis `EpreuvesPanel` :
      insertion **à la suite** du sujet et du corrigé, annulable tant que le texte n'a pas été
      retouché, sans modifier l'épreuve avant « Enregistrer » (`lib/atelier.ts`).
- [x] B8. **RGPD** : les signalements d'exercices sont exportés (`signalements_exercices`) et
      purgés à la suppression du compte, comme les autres données personnelles.
- [x] B9. **Tests** : `test_generation_exercices.py` (43 tests) et `test_entrainement.py` verts ;
      `pytest` **684 réussis + 2 ignorés** ; `vitest` **238/238** (29 fichiers) ; quatre
      scénarios E2E (valider → visible côté élève ; retirer → disparaît et 404 ; graine partagée
      → même variante après rechargement ; signalement → file admin → résolution) ;
      **E2E 109/109**.
- [x] B10. **Comparaison visuelle 5173 / 8772** (`/entrainement`, `/entrainement?g=suite-arithmetique&graine=1234`,
      `/admin?tab=gabarits`, 1366×900) : contenus **identiques** (mêmes 19 exercices, mêmes
      énoncés, même variante n° 1234 pour la même graine, mêmes rapports « 100 variantes tirées,
      0 échec »). Écarts relevés, tous assumés :
      - en-tête `refonte` : menu horizontal + « Masquer les statistiques » ; `evolution` : bouton
        « Inviter » et pas de repli des statistiques (choix du lot F : garder le repli) ;
      - console : boutons « Voir une variante / Autre variante » et « Retirer » ici, contre
        « Aperçu avec correction » et « Retirer la validation » là-bas ; pastille « Assistant
        console » flottante en permanence dans `evolution`, alors que `refonte` garde un seul
        assistant (choix du lot F) ;
      - libellés : « Signalements d'exercices » contre « Signalements des élèves », et
        « Exercices types » contre « Exercices types (entraînement des élèves) » ;
      - navigation latérale : trois familles « Contenu / Communauté / Système » ici, groupes
        « CATALOGUE »/« UTILISATEUR » et sections dans un autre ordre là-bas ;
      - pied de page : « À propos · Aide · Intégrer des cours » ici, « Conditions d'utilisation ·
        À propos · Guide de démarrage » là-bas (les pages légales arrivent au lot D) ;
      - chiffres de démonstration différents (3 à 5 utilisateurs, 9 ou 10 épreuves publiées) :
        bases distinctes, sans rapport avec le portage.
      Captures : `%TEMP%\opencode\shots-admin\` (`refonte-5173-*`, `evolution-8772-*` pour
      l'accueil admin, les gabarits, la liste d'entraînement et la variante n° 1234).

---

## 3. Lot C — Catalogue et recherche groupés

### Backend

- [x] C1. `_catalogue_query(...)` extrait de `list_epreuves` (mêmes filtres pour la liste et les groupes)
- [x] C2. Route `GET /api/epreuves/groupes` : une entrée par matière × évaluation × classe,
      années triées de la plus récente à la plus ancienne, pagination sur les groupes
      (jamais coupés), accès calculé côté serveur (`gratuit`/`ouvert`/`payant`)
- [x] C3. `backend/tests/test_groupes.py` (6 tests : regroupement, séparation évaluation/classe,
      pagination sans doublon, brouillons exclus + filtre payant, visiteur anonyme, bornes `limit`)

### Frontend

- [x] C4. `components/CatalogueGroupes.tsx` porté, adapté à l'i18n de `refonte` (`t()` avec clés
      françaises) : cartes matière × évaluation, pastilles d'année (max 6, « + N autres années »),
      icônes accès/corrigé, « Voir plus » par groupes
- [x] C5. `CataloguePage.tsx` : bascule **« Par matière / Liste »** mémorisée (`catalogueVue`),
      vue **« Liste » par défaut** ; elle reprend le parcours historique de `refonte` (tuiles par
      matière, puis liste par année, extraits, historique et filtres). La vue « Par matière » est
      conservée comme nouveau mode, désormais optionnel.
- [x] C6. Mémorisation vérifiée après rechargement ; recherche globale (`?q=`) groupée avec la
      classe affichée ; filtre matière → une carte + retour « Toutes les matières »
- [x] C7. Clés EN ajoutées : `Affichage du catalogue`, `Afficher les {n} autres années`,
      `Afficher moins`, `Par matière`, `Liste`
- [x] C8. Comparaison live 5173 vs 8772 (1366×900, 390 et 360 px) en vue groupée : mêmes cartes,
      mêmes compteurs, mêmes pastilles (écart uniquement pour les données locales supplémentaires
      de `refonte`), aucun débordement horizontal, aucune erreur console hors 401 anonymes
- [x] C9. Validation : `vitest` 221/221, `pytest` 363 réussis + 1 ignoré, `npm run build` OK ;
      E2E : les scénarios du catalogue passent. L'échec résiduel du filtre du Journal admin
      (indépendant du lot C) venait du comptage du `<li>` « Charger plus » : corrigé au lot F9,
      suite complète à **105/105**.
- [x] C10. Retour du lecteur visible en immersion comme hors immersion ; assertion E2E ajoutée

### Effort et risque

**2,5 j**, risque faible. C'est le meilleur rapport valeur/effort après le lecteur : il rend le
catalogue immédiatement plus lisible et alimente la recherche.

---

## 4. Lot D — Pages légales et pied de page

- Copier `frontend/src/pages/LegalPage.tsx` (13 l.) et les routes `/confidentialite`,
  `/conditions` dans `App.tsx`.
- Ajouter les liens dans le pied de page de `Layout.tsx`.
- **Ne pas publier le texte d'`evolution`** : c'est un « modèle de départ » explicitement marqué
  comme non validé. Faire rédiger/valider le contenu (RGPD, données camerounaises, base légale,
  durée de conservation, sous-traitants IA) avant retrait du bandeau.
- i18n : 5 clés.
- **0,5 j de dev**, plus le délai de validation juridique.

### Avancement du lot D (livré)

- [x] D1. **Contenu rédigé pour `refonte`, pas recopié.** Le `LegalPage.tsx` d'`evolution` (13 l.,
      un paragraphe par page) a servi de repère, pas de source : son texte est marqué « modèle de
      départ » et ne décrit ni le consentement granulaire, ni l'export, ni les durées réelles. Le
      nouveau fichier (`frontend/src/pages/LegalPage.tsx`) décrit le service **tel qu'il est codé**.
      Chaque affirmation est adossée à un fichier vérifié :

      | Affirmation du texte | Source vérifiée |
      |---|---|
      | nom, e-mail, niveau, classe, établissement, photo ; pas de mot de passe en connexion Google | `db_models.py` (`UserORM`), `routers/auth.py` |
      | consultations, essais, notes, conversations, signalements, abonnements, paiements | `db_models.py` (`ConsultationORM`, `EssaiORM`, `NoteORM`, `AIConversationORM`, `SignalementORM`, `SubscriptionORM`, `PaymentORM`) |
      | aucune donnée bancaire conservée | `PaymentORM` (moyen, montant, référence, statut) |
      | consentement par finalité, refus effectif, purge au retrait | `routers/me.py` (`PUT /consentement`), `ConsentModal.tsx` |
      | export JSON et suppression libre-service | `routers/me.py` (`GET /export`, `DELETE /compte`) |
      | 7 j glissants / 14 j max, empreinte SHA-256 du jeton | `core/store.py` (`SESSION_TTL_*`) |
      | cookie httpOnly, SameSite=Lax, Secure en production | `routers/auth.py` (`_set_session_cookie`) |
      | une seule session active, l'ancienne est prévenue | `core/store.py` (`create_session`, `notify_kickout`) |
      | hors-ligne purgé à 30 j, préférences en `localStorage` | `lib/horsLigne.ts`, `sujets.ts`, `zoomLecteur.ts` |
      | Gemini (Google) et Groq, aucun outil d'analytics, pas de publicité | `core/assistant.py`, `index.html` |
      | Render + Supabase (Postgres) + stockage S3-compatible, liens signés | `DEPLOIEMENT.md`, `main.py` |
      | filigrane identifiant + horodatage | `CAHIER_DES_CHARGES.md`, lecteur |
      | loi camerounaise n° 2010/012, ANTIC | `CAHIER_DES_CHARGES.md` |
      | abonnement sans reconduction, annulation sans remboursement au prorata | `SubscribePage.tsx`, `ProfilePage.tsx`, `CAHIER_DES_CHARGES.md` |
- [x] D2. **Structure propre à `refonte`** : 10 sections par page (`<section id>` +
      `aria-labelledby`), sommaire cliquable en `<nav aria-label="Sommaire">`, date de révision
      (`DATE_REVISION` = 13/11/2026, affichée selon la langue), liens croisés
      confidentialité ↔ conditions et « Ouvrir l'aide ». Aucune reprise de la mise en page
      d'`evolution`.
- [x] D3. **Encart « Version de travail » conservé** tant que la relecture juridique n'est pas
      faite : le texte est plus complet mais n'a pas été validé par un juriste. À retirer ensuite
      (même consigne qu'`evolution`, dont le bandeau reste lui aussi en place).
- [x] D4. **Routes** `/confidentialite` et `/conditions` en `React.lazy` + `Suspense` dans
      `App.tsx`, comme `/a-propos`.
- [x] D5. **Pied de page** : « Confidentialité · Conditions · À propos · Aide · Inviter des amis ».
      Les deux nouveaux liens passent avant « À propos » et gardent la cible tactile de 44 px.
- [x] D6. **Droits en libre-service dans le profil** : bloc `MesDroits` (onglet
      « Confidentialité ») avec « Exporter mes données » (téléchargement JSON de `GET
      /api/me/export`) et « Supprimer mon compte » (`ConfirmDialog` rouge → `DELETE /api/me/compte`
      → retour à l'accueil). Remplace la phrase « écris à l'équipe depuis l'adresse {email} » : la
      route existait déjà côté serveur mais n'était branchée nulle part. La rubrique d'aide
      correspondante est corrigée dans le même sens.
- [x] D7. **i18n** : **99 clés EN** ajoutées (632 → 731) ; insertion ciblée à la position
      alphabétique (accents et casse neutralisés), sans re-trier le fichier — ses 14 inversions
      historiques restent en place. `git diff` : 99 insertions, 0 suppression.
- [x] D8. **Tests** : `npx tsc -b` OK ; `vitest` **238/238** (29 fichiers), dont
      `i18n.test.ts` (variables `{x}` identiques) et `locales/couverture.test.ts` (0 clé
      manquante) ; `npm run build` OK ; 3 scénarios E2E neufs (liens du pied de page et renvois
      croisés, sommaire + faits légaux, export JSON + confirmation de suppression) et
      `/confidentialite`, `/conditions` ajoutés aux trois balayages d'URL (anglais, aide mobile,
      débordement bureau/mobile).

      État E2E : le premier passage complet du lot D donnait **110/112**. Les deux échecs
      n'étaient **pas** causés par les pages légales mais par la base E2E, qui accumule les
      épreuves des exécutions passées (50 premières épreuves toutes gratuites, matières réelles
      hors de la première page) :
      - « anglais : aucun texte d'interface français » prenait « Français » et « Éducation
        Civique » (matières du référentiel) pour des résidus : le masque des noms de matières ne
        lisait que la première page ;
      - « profil d'un abonné » cherchait une épreuve payante dans cette même première page et
        échouait sur « aucune épreuve payante dans les données de test ».

      Corrigé en interrogeant l'API avec ses filtres (`acces_type=payant`) et en parcourant
      toutes les pages pour le masque des matières (commit `0dffd8e`). Contrôles ciblés des pages
      légales au passage : aucun débordement horizontal à 390 et 1366 px, aucun résidu accentué en
      anglais sur `/confidentialite` et `/conditions`. **Relance complète à confirmer** après
      reprise (dernier passage interrompu par l'extinction de la machine).
- [x] D9. **Écarts assumés avec `evolution`** :
      - contenu : 10 sections détaillées ici contre un paragraphe là-bas ; les deux bandeaux
        « version de travail » restent ;
      - pied de page : « Confidentialité · Conditions · À propos · Aide · Inviter des amis » ici,
        « Conditions d'utilisation · À propos · Guide de démarrage » là-bas (pas de page
        « Guide », l'aide de `refonte` la couvre) ;
      - profil : export et suppression en libre-service ici ; `evolution` a les mêmes boutons mais
        sous des clés `profile.*` de son propre système i18n ;
       - l'adresse de contact n'est pas inventée : le texte renvoie à celle affichée dans le profil,
         qui n'existe que si `VITE_CONTACT_EMAIL` est fourni (même règle qu'`AProposPage`).
       - relance complète après les correctifs de robustesse E2E : **113/113 scénarios réussis**.
- [ ] D10. **Validation juridique** : relecture externe (base légale, mentions d'identité de
      l'éditeur, sous-traitants hors Cameroun) puis retrait de l'encart « Version de travail ».
      Hors périmètre du portage technique.

---

## 5. Lot E — Aide admin dédiée

- [x] E1. Création de `frontend/src/pages/aide/AdminHelpPage.tsx` et route lazy `/aide/admin`
      sous `RequireAdmin` + `Layout` + `Suspense`. Les élèves n'obtiennent pas le guide en
      naviguant directement sur cette adresse.
- [x] E2. La console mène à `/aide/admin` ; l'aide publique `/aide` reste l'aide des élèves,
      avec un lien administrateur vers le guide dédié. Le guide propose aussi un retour au
      back-office et un lien vers l'aide des élèves.
- [x] E3. Ajout des rubriques admin « Exercices types (gabarits) » et « Ce que voient les élèves :
      Entraînement », en français pur. Les sections liées portent leur identifiant d'onglet.
- [x] E4. Extraction de `Onglet`, `GROUPES` et `ONGLETS` vers `pages/admin/onglets.ts` ; test
      `pages/aide/aide.test.ts` garantissant les 11 onglets couverts, les IDs uniques et les
      sections renseignées. Marque des deux prompts LLM corrigée en « Copies & Corrigés » ;
      les identifiants techniques `bacprep-*` sont conservés.
- [x] E5. Correctifs de robustesse E2E : navigation SPA avec nouvelle tentative après timeout,
      parcours paginé complet pour le masque anglais, attente KaTeX prolongée. Scénarios aide
      admin/élève adaptés à la route dédiée et à sa protection.
- [x] E6. Validation : `npx tsc -b` OK, `vitest` **244/244** (30 fichiers), `npm run build` OK,
      `node --check frontend/e2e/e2e.mjs` OK, **E2E complet 113/113** sur 8765.

---

## 6. Lot F — Finitions de la console

| Élément | Source | Effort |
|---|---|---|
| Boutons **Aide** et **Plein écran** (avec `Échap`) | `AdminPage.tsx` d'`evolution` | 0,5 j |
| **Filtre de période** + compteur du journal | `JournalPanel.tsx` d'`evolution` | 0,5 j |
| **Squelettes** de chargement (recherche, catalogue) | `Skeleton.tsx` | 0,25 j |
| Texte d'aide à l'upload d'avatar | `ProfilePage.tsx` d'`evolution` | 0,1 j |
| En-tête épuré sur `/connexion` | `Layout.tsx` | 0,1 j |

**Ne pas porter** : les statistiques toujours dépliées (garder le repli de `refonte`), les deux
assistants flottants simultanés, le menu admin complet d'`evolution` (le menu de `refonte` suffit
et il est déjà testé).

### Avancement du lot F

- [x] F1. **Plein écran admin** : bouton dans l'en-tête de la console, attribut `data-immersion`
      déjà utilisé par le lecteur, règle CSS `html[data-immersion] [data-chrome]` qui masque
      l'en-tête et le pied de page du site ; sortie par `Échap` (ou le bouton), état **non**
      mémorisé entre deux visites (une console ne doit pas s'ouvrir plein écran par surprise).
- [x] F2. **Bouton Aide** dans la console → `/aide` : `AidePage` y affiche déjà l'aide
      administrateur pour un admin connecté. Le lien vers `/aide/admin` est remis au lot E, qui
      créera cette page.
- [x] F3. **Filtre de période du journal** : `jours` (24 h / 7 j / 30 j / tout) sur
      `GET /api/admin/events`, sélection transmise à l'API et compteur « {n} affichés ».
- [x] F4. **Compteur de liste** : `ListeAdmin` reçoit une prop `compteur`, `data-liste-item` sur
      chaque ligne (le `<li>` du bouton « Charger plus » porte un autre attribut, il ne compte pas).
- [x] F5. **En-tête épuré sur `/connexion`** : langue et état du réseau en coin, le reste du
      chrome disparaît pour ne pas distraire du formulaire.
- [x] F6. **Texte d'aide à la photo de profil** : formats, taille maximale et rappel que les
      métadonnées sont retirées côté serveur.
- [x] F7. Clés EN ajoutées (`Période`, `24 heures`, `7 jours`, `30 jours`, `{n} affichés`, consignes
      de photo).
- [x] F8. **Squelettes de chargement** : déjà présents dans `refonte` (`Skeleton.tsx`, liste admin
      et catalogue) — rien à porter, vérifié par l'E2E.
- [x] F9. E2E : nouveau scénario « plein écran masque le site, Échap en sort, et Aide mène à l'aide
      de la console » ; le scénario Journal filtre par période et compte
      `ul[data-liste-admin] li[data-liste-item]` (le `<li>` de « Charger plus » faussait le compte).
- [x] F10. Validation : `npx tsc -b` OK, `vitest` 221/221, `npm run build` OK,
      `pytest` 363 réussis + 1 ignoré, **E2E 105/105** sur 8765.


---

## 7. Lot G — SEO et aperçus de partage

Plus intrusif qu'il n'y paraît : il touche le `spa_catch_all` du serveur.

1. Copier `backend/app/core/seo.py` (~70 l.).
2. Dans `backend/app/main.py` :
   - lire `index.html` **une fois** en mémoire (`_INDEX_TEMPLATE`),
   - changer `async def spa_catch_all(full_path: str)` en
     `async def spa_catch_all(full_path: str, request: Request)`,
   - pour `/epreuve/{id}`, résoudre l'épreuve publiée et injecter titre, description,
     `og:image` absolue,
   - servir `HTMLResponse(page, headers={"Cache-Control": "no-cache"})` au lieu de
     `FileResponse(index.html)`.
3. Ajouter `GET /robots.txt` et `GET /sitemap.xml`.
4. Vérifier que le **service worker PWA** de `refonte` précache toujours le bon `index.html`
   (le template est lu après le build, donc l'injection ne casse pas le précache).
5. Test `test_seo.py` : `curl` d'une page d'épreuve → `<title>`, description, `og:image`
   absolue ; `robots.txt` et `sitemap.xml` valides ; un chemin `/api/inconnu` renvoie toujours
   un 404 JSON (pas `index.html`).

**2 j**, risque moyen. À faire **après** les lots fonctionnels.

---

## 8. Lots à différer (et pourquoi)

### H — i18n typée

`refonte` : `t()` global + `locales/en.json` (~574 clés), rechargement au changement de langue.
`evolution` : `useT()` + `fr.ts`/`en.ts` (~1 191 clés), typage des clés.

Porter H, c'est **réécrire tous les appels de traduction de l'application**, pas seulement ceux
des composants portés. Coût 8–12 j, risque de régression élevé, bénéfice utilisateur nul à court
terme. **À ne pas inclure.** Se contenter d'ajouter les ~190 clés françaises dans `en.json`.

### I — Description d'images

`DescriptionImageModal` est découplé, mais `EpreuvesPanel` lui fournit `onProposer` qui appelle
`POST /api/admin/epreuves/{id}/images/{image}/description`, lequel dépend de
`assistant.decrire_image` — donc du **refactor assistant** (option B2). À planifier **avec** B2,
pas avant. **3 j** une fois B2 fait.

### Doublons à ne pas porter

| Doublon | Garder |
|---|---|
| Avatars (`avatars` table côté `refonte`, `core/avatars.py` côté `evolution`) | `refonte` |
| Formules (`libelle` vs `nom_fr`) | `refonte` (renommer imposerait une migration de colonnes) |
| Conversations (`/deplacer` vs `/conv/transfer`) | `refonte` |
| Assistant admin (`/execute` vs `/confirm`) | `refonte` |
| `AdminAgentDock` persistant | l'assistant unique de `refonte` |
| `vite.config.ts` / `package.json` | `refonte` (PWA + versions bornées) |
| `BottomNav` | `refonte` (à conserver, ne pas le supprimer) |
| Repli des statistiques | `refonte` |

---

## 9. Conflits de contrats et résolutions

| Sujet | `refonte` | `evolution` | Résolution dans le portage |
|---|---|---|---|
| Formules | `libelle`, `libelle_en` | `nom_fr`, `nom_en` | **Ne pas toucher** : le portage n'en a pas besoin |
| Conversations | `/conversation/{epreuve}`, `/deplacer` | `/conv/{id}`, `/conv/transfer` | **Ne pas toucher** |
| Assistant admin | `/ask` + `/execute` | `/ask` + `/confirm` | **Ne pas toucher** |
| Assistant cœur | `ask_assistant`, `ask_assistant_stream` | + `call_cascade`, mesure, `decrire_image` | **Adaptateur** (B1), refactor complet plus tard |
| i18n | `t("phrase française")` + `en.json` | `useT("cle.symbolique")` + `fr.ts` | Réécrire les appels des composants portés |
| Lecteur | `MarkdownContent` + `zoom` CSS | `PagedContent` + `--exam-scale` | Porter la pagination, **garder le rendu Markdown** |
| Catalogue | `/api/epreuves/matieres` + filtres | + `/api/epreuves/groupes` | **Ajouter** la route, ne pas remplacer l'existante |
| Avatars | router `avatar.py`, table `avatars` | `me.py` / `core/avatars.py` | **Ne pas toucher** |
| PWA | `vite-plugin-pwa`, `sw.js`, précache | absent | **Garder `refonte`** |
| Tables | `avatars`, `evenements`, `essais` | + `gabarit_validations`, `gabarit_signalements`, `llm_usage` | Ajouter les 2 tables gabarits ; `llm_usage` seulement si B2 |
| Démarrage | rapide | ~104 s à froid (mesuré) | Chargement paresseux + mémoïsation des gabarits |

---

## 10. Stratégie de branches et de commits

```text
refonte ──► portage/evolution-ui
              ├── lot-A-lecteur-pagine
              ├── lot-B-entrainement
              ├── lot-C-catalogue-groupes
              ├── lot-D-pages-legales
              ├── lot-E-aide-admin
              ├── lot-F-finitions-console
              └── lot-G-seo
```

- Une PR par lot, **rebased sur `refonte`** avant merge.
- Chaque PR doit passer : `pytest` (340+), `vitest` (26 fichiers), `npm run build`, et les
  scénarios E2E concernés (idéalement les 102).
- Ne pas merger B avant A si l'on veut garder des PR petites : B réutilise les contrôles
  flottants d'A.
- Taguer `portage-v1` après J.

---

## 11. Tests et critères de sortie

### Tests à porter

| Source `evolution` | Cible | Lot |
|---|---|---|
| `frontend/src/lib/pagination.test.ts` | `refonte` | A |
| `frontend/src/lib/immersif.test.ts` | inutile (immersion déjà là) | — |
| `frontend/src/lib/tailleTexte.test.ts` | adapter à `zoomLecteur` | A |
| `frontend/src/lib/entrainement.test.ts` | `refonte` | B |
| `backend/tests/test_gabarits.py` | `refonte` | B |
| `backend/tests/test_gabarits_exemples.py` | `refonte` | B |
| `backend/tests/test_fiche_gabarits.py` | `refonte` | B |
| `backend/tests/test_entrainement.py` | `refonte` | B |
| `backend/tests/test_generation_exercices.py` | `refonte` | B |
| `backend/tests/test_groupes.py` | `refonte` | C |
| `backend/tests/test_seo.py` | `refonte` | G |

### Scénarios E2E à ajouter (lot J)

1. Lecteur paginé : compteur, clavier, balayage, ancrage après zoom.
2. PDF + hors-ligne **en mode paginé**.
3. Entraînement : validation → publication → variante par graine → signalement → traitement.
4. Catalogue groupé : bascule de vue, compteurs, filtres.
5. Pages légales : liens de pied de page, absence de bandeau « modèle ».
6. SEO : `curl` d'une page d'épreuve, `robots.txt`, `sitemap.xml`.
7. Console : plein écran + `Échap`, filtre de période du journal.

### Définition de « terminé »

- Toutes les fonctionnalités de `refonte` sont **intactes** (aucune régression E2E).
- Le lecteur paginé **conserve** PDF, hors-ligne, chrono, alarme, notes, sélection, assistant.
- Les 19 gabarits sont validés et **aucun** exercice non validé n'est public.
- Les pages légales sont **publiables** (contenu validé, bandeau retiré).
- Le pied de page contient les liens légaux ; la marque est **« Copies & Corrigés »** partout.
- La console garde ses statistiques repliables et son assistant unique.
- Le démarrage de l'API n'est pas dégradé par les gabarits.

---

## 12. Risques et parades

| Risque | Probabilité | Impact | Parade |
|---|---|---|---|
| Le refactor `assistant.py` casse le chat existant | Moyenne | **Élevé** | Rester sur l'adaptateur B1 ; ne pas toucher `ask_assistant` |
| `zoom` CSS incompatible avec la pagination | Moyenne | Moyen | Passer à `--exam-scale` + `font-size`, tester à 200 % |
| Barre flottante qui recouvre le texte | Haute si copiée telle quelle | Moyen | La déplacer en bas / hors feuille dès le lot A |
| Démarrage ralenti par les gabarits | Moyenne | Moyen | Chargement paresseux + `lru_cache` + health indépendant |
| Deux vocabulaires « Pages » | Certaine si non traitée | Moyen | Renommer « Un sujet à la fois » / « Lecture paginée » |
| Migration de base | Faible | Faible | Tables additives seulement, `create_all` |
| SEO qui casse le SPA / le précache | Moyenne | Moyen | Faire G en dernier, tester `/api/*` et le SW |
| i18n oubliée (chaînes en français dans `en.json`) | Moyenne | Faible | Checklist des ~190 clés par lot |
| E2E non étendue | Moyenne | Élevé | Lot J obligatoire avant tag |

---

## 13. Quick wins (≤ 1 jour chacun)

1. Liens légaux dans le pied de page + page `LegalPage` (contenu à valider).
2. Boutons **Aide** et **Plein écran** dans la console.
3. Filtre de période + compteur du journal.
4. Squelettes de chargement de la recherche.
5. Texte d'aide à l'upload d'avatar.
6. En-tête épuré sur `/connexion`.
7. Bascule « Par matière / Liste » du catalogue (si le backend `/groupes` est déjà porté).

---

## 14. Résumé exécutif du portage

- **Ne pas fusionner les branches.** Copier les briques, adapter les contrats.
- **Commencer par le lecteur** : 5 j, front seul, gain visible immédiat, aucun risque de base.
- **Enchaîner par le catalogue groupé** : 2,5 j, faible risque.
- **Entraînement** : 10 j, le plus gros, avec un **adaptateur assistant** plutôt qu'un refactor.
- **Légales, aide admin, finitions, SEO** : 5,5 j au total, après les gros lots.
- **Différer l'i18n typée et la description d'images** : elles dépendent d'un refactor transverse
  qui n'apporte rien à l'élève à court terme.
- **Total réaliste** : **26 j-h** (hors validation juridique), soit **5 à 6 semaines** pour une
  personne, avec le filet E2E conservé et étendu.
