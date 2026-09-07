# Plan d'améliorations BacPrep « Copies & Corrigés » — refonte UI + bugs + fonctionnalités

> Copie de travail du plan validé le 2026-09-03. Cocher les cases au fil de l'exécution.
> Décisions validées : assistant nommé **Tuteur IA Prep** (réponses signées « Assistant Pédagogique ») ;
> accueil en **deck animé niveau → classes** ; **tout persisté en base** ; bonus tous retenus
> (raccourcis clavier lecteur, skeletons, graphiques admin SVG, vitest).

---

## Lot 0 — Copie du plan

- [x] Écrire ce fichier à la racine.

## Lot B — Corrections README

### B1. Isolation automatique des blocs `$$...$$` (frontend)
- [x] Réécrire `frontend/src/lib/latex.ts` `normalizeLatexDelimiters()` en machine à états ligne par ligne :
  - ignorer l'intérieur des blocs de code fencés (``` et ~~~) ;
  - détecter ouverture/fermeture `$$` même sur une seule ligne, et plusieurs blocs sur une même ligne ;
  - garantir ligne vide AVANT l'ouverture et APRÈS la fermeture ; contenu trimé ;
  - ne jamais toucher au `$...$` inline ni aux `\$$` échappés ;
  - conserver `\[...\]`→`$$`, `\(...\)`→`$`, environnements `\begin{...}` nus.
- [x] Mettre en place vitest (devDep, config minimale) + tests : formule au milieu d'un paragraphe,
      deux blocs sur une ligne, `$$` dans bloc de code (intact), bloc multi-lignes, conversions `\[ \]`.

### B2. Filtre « Ouvert »/« Payant » + pagination côté serveur
- [x] Backend `routers/epreuves.py` : dépendance `get_optional_user` sur `GET /api/epreuves` (public sinon).
- [x] `_apply_filters` : `acces_type="ouvert"` = payante ET couverte (EXISTS abonnement actif, miroir SQL
      de `store.has_access`) ; `"payant"` = payante ET non couverte (NOT EXISTS).
- [x] Frontend `CataloguePage.tsx` : envoyer `acces_type` tel quel, supprimer le filtrage client
      post-pagination (`epreuvesAffichees`) ; `computeAccessStatus` conservé pour les badges.
- [x] Retirer la ligne correspondante du tableau « Limitations connues » du README.

## Lot A — Polish UI (audit frontend-design)

- [x] A1 Arrondis : règles documentées dans `index.css` ; carte récap SubscribePage et conteneur étendu
      AssistantPanel `rounded-2xl`→`rounded-lg` ; feuille mobile `rounded-t-2xl`→`rounded-t-lg`.
- [x] A2 Couleurs hors tokens : pastilles opérateurs → `bg-highlight`/`bg-valide` ; ombre dorée du
      launcher → classe utilitaire `.halo-highlight` ; `text-white` → `text-paper` partout.
- [x] A3 Badges unifiés : `MetaBadge` prop `variant="pill"|"tag"` ; badges Gratuit/Ouvert/Payant du
      catalogue migrent vers `MetaBadge` ; suppression du style inline boxShadow.
- [x] A4 Échelle des libellés mono : standardiser `text-[10px]` (étiquettes) / `text-xs` (intertitres) ;
      corriger `text-[9px]` des InfoTile d'abonnement.
- [x] A5 Hauteurs de boutons : règle 36 px compact / 44 px standard ; corriger ProfilePage.
- [x] A6 Échelle z-index documentée dans `index.css` (20/30/40/50/59/60/100).
- [x] A7 Micro-correctifs : croix d'onglet AssistantPanel (onClick sur le bouton) ; `Watermark` id via
      `useId()` ; styles hover/focus verrouillés mutualisés en classe `.interactif-verrouille`.

## Lot C — Évolutions UI

- [x] C1 Accueil : deck animé niveau → classes (`CardStack`, perspective légère, transition 300 ms,
      `prefers-reduced-motion` respecté, bouton retour + fil d'Ariane).
- [x] C2 Filtres sans répétition de label : libellé unique par groupe, boutons = valeur seule,
      `aria-label` sur le groupe.
- [x] C3 Extraits + métadonnées : colonne `EpreuveORM.extrait` (280 c.) générée à l'écriture/import +
      backfill migration ; `EpreuveListItem.extrait` ; cartes catalogue `line-clamp-2` + durée/
      coefficient/session ; `/api/pricing` renvoie une `description` par scope ; cartes prix enrichies.
- [x] C4 Assistant nommé : en-tête « Tuteur IA Prep » ; bulles avec avatar initiales + nom (élève) et
      « Assistant Pédagogique » ; onglets auto-renommés à la première question ; défauts distincts
      (« Discussion générale », « Passage : … ») ; bloc contexte entièrement repliable (chevron).
- [x] C5 Icônes + raccourcis : icônes FileText/ClipboardCheck sur le switch Sujet/Corrigé ;
      hook raccourcis S/C/N dans le lecteur (ignorés si focus dans un champ).
- [x] C6 Skeletons : composant `Skeleton` (reduced-motion respecté) — catalogue, lecteur, profil,
      sidebar admin ; remplace les « Chargement… ».

## Lot D — Notes liées aux épreuves

- [x] Table `notes` (id, user_id, epreuve_id, cible, contexte_extrait, contenu markdown, created_at,
      updated_at).
- [x] Endpoints : `POST /api/epreuves/{id}/notes`, `GET /api/me/notes`, `PUT /api/me/notes/{id}`,
      `DELETE /api/me/notes/{id}`.
- [x] Lecteur : bouton flottant → mini-barre 2 actions (« Demander » / « Prendre une note ») ;
      `NoteEditor` en modale (textarea + aperçu).
- [x] AssistantPanel : bouton « Sauvegarder en note » sous chaque réponse de l'assistant.
- [x] ProfilePage : section « Mes notes » (extrait, date, lien épreuve, éditer/supprimer).

## Lot E — Profil étendu, activité, signalements

- [x] E1 Colonnes `users.niveau/classe/etablissement` ; `PUT /api/me/profil` ; section « Mes informations ».
- [x] E2 `GET /api/me/activite` : timeline fusionnée paginée (connexions, consultations, abonnements,
      paiements, notes, discussions) ; onglet « Activité » avec icônes + dates relatives.
- [x] E3 Table `signalements` + `POST /api/epreuves/{id}/signalements` (anti-doublon 409) ; bouton `Flag`
      dans le lecteur → modale motifs + message.

## Lot F — Admin

- [x] F1 Miniatures : colonnes `epreuve_files.width/height` (Pillow à l'upload + backfill) ;
      `admin_get_epreuve` renvoie size/dimensions/mime ; UI `object-contain` + `formatBytes`.
- [x] F2 Sidebar par statut : `GET /api/admin/epreuves/counts` + paramètre `statut` ; puces
      « Tous (180) », « Brouillon (50) »…
- [x] F3 Logs d'import en direct : `ImportJobORM.logs_json`, callback de progression dans `run_import`,
      console `<pre>` défilante côté admin (polling existant 1,5 s).
- [x] F4 Stats enrichies + graphiques SVG maison : stockage (SUM size_bytes, répartition md/images),
      revenus par mois (6 derniers), consultations, notes, signalements ouverts.
- [x] F5 Journal & audit : `AdminEventORM` + colonnes `email`/`details` ; événements login/logout/
      import/signalement ; `GET /api/admin/events` paginé ; onglets « Journal » et « Signalements ».
- [x] F6 Migration idempotente : `backend/scripts_dev/migrate_2026_09.py` (ALTER TABLE si absent +
      create_all) compatible SQLite/PostgreSQL.

## Lot G — Tests, build, docs

- [x] vitest : `normalizeLatexDelimiters`, `computeAccessStatus`, `extractExtrait`, `formatBytes`.
- [x] Smoke tests backend batch via `TestClient` : filtre ouvert/payant, CRUD notes, signalement +
      anti-doublon, counts admin, events, logs d'import.
- [x] `npm run build` ; vérification visuelle des deux thèmes sur les pages modifiées.
- [x] README : retirer les 2 limitations corrigées, documenter les nouveautés et la migration.

## Ordre d'exécution

0 → B (avec vitest) → A → C → D → E → F → G. Chaque lot se termine par `npm run build` + tests du lot.
